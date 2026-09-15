/**
 * 代理（设置 → 偏好 → 通用）的运行期接线。
 *
 * 三件事，缺一不可：
 * 1. **进程内的所有 http(s) 请求** —— 给 `globalThis.fetch` 挂一层包装（`installProxyFetch`），
 *    按请求的目标主机决定是否带 `proxy`。云端模型（生图 / 语音 / OCR / 视频 / 对话 / 网关上游）、
 *    模型市场、引擎与权重下载、联网检索、S3/WebDAV 备份都走同一个 fetch，因此一处接线就全覆盖。
 * 2. **子进程** —— pip / python worker / git lfs / brew / 四个推理引擎的模型下载都在子进程里，
 *    它们只认环境变量，所以在这些 spawn 点注入 `proxyChildEnv()`。
 * 3. **WebSocket**（Edge TTS / DashScope 实时通话）—— Bun 的 WebSocket 也支持 `proxy` 选项，
 *    用 `proxyWebSocketOptions()` 传进去。
 *
 * 「本地不走代理」是硬要求，落地方式是**不依赖环境变量**：`syncProxyEnv()` 把进程内的
 * HTTP(S)_PROXY 统一成当前设置（不使用代理时直接删掉），再补一份 NO_PROXY 兜底
 * （回环 + 本机网卡地址 + 用户/系统的绕过清单）。否则用户 shell 里带进来的
 * `HTTP_PROXY` 会连 `127.0.0.1:8080` 的推理服务一起代理掉 —— Bun 的 NO_PROXY 不认 CIDR，
 * 只靠变量兜不住。
 */
import { networkInterfaces } from "node:os";

import { logEvent } from "./app-log";
import { getSetting } from "./db/settings";
import {
  DEFAULT_PROXY_CONFIG,
  childBypassList,
  isProxyMode,
  maskProxyUrl,
  normalizeProxyUrl,
  parseBypassList,
  parseGnomeProxy,
  parseScutilProxy,
  parseWindowsProxy,
  proxyFromEnv,
  proxyForUrl,
  proxyInitFor,
  stripGVariantQuotes,
  type ProxyConfig,
  type ProxyMode,
  type SystemProxyInfo,
} from "../shared/proxy";

export type { ProxyConfig, ProxyMode } from "../shared/proxy";

/** 探测结果缓存时长：够短（改了系统代理能自己跟上），够长（不会每个请求都起一个进程）。 */
const SYSTEM_PROXY_TTL_MS = 30_000;

/** 应用启动时的环境快照：后面我们会改写 process.env，探测必须看用户原本给的值。 */
const launchEnv: Record<string, string | undefined> = { ...process.env };
const launchNoProxy: string[] = parseBypassList(launchEnv.NO_PROXY ?? launchEnv.no_proxy);

let systemCache: { at: number; info: SystemProxyInfo } | null = null;
/** 正在进行的系统代理探测：多个请求同时遇到冷缓存时共用同一次（别起 N 组探测进程）。 */
let systemInFlight: Promise<SystemProxyInfo> | null = null;
let refreshing = false;
let loggedInvalidUrl = "";
let loggedDetectFailure = "";
let loggedSocksOnly = "";
let loggedPacOnly = false;

// ---------------------------------------------------------------------------
// 配置读取
// ---------------------------------------------------------------------------

/** 只读设置（不发探测）：custom 模式给出规范化后的地址，system 模式的地址由探测补。 */
export function readProxyConfig(): ProxyConfig {
  const mode = getSetting("PROXY_MODE");
  const allowLocalNetwork = getSetting("PROXY_ALLOW_LOCAL_NETWORK") !== "0";
  let url = "";
  if (mode === "custom") {
    const raw = getSetting("PROXY_URL");
    const normalized = normalizeProxyUrl(raw);
    if (normalized.ok) url = normalized.url;
    else if (raw.trim() && loggedInvalidUrl !== raw) {
      // 手改数据库 / 旧版本残留才会走到这里；界面保存前已校验。
      loggedInvalidUrl = raw;
      logEvent({
        level: "warn",
        source: "app",
        event: "proxy-url-invalid",
        message: `自定义代理地址无效（${normalized.error}），当前按直连处理`,
        detail: { url: maskProxyUrl(raw) },
      });
    }
  }
  return {
    mode: isProxyMode(mode) ? mode : DEFAULT_PROXY_CONFIG.mode,
    url,
    allowLocalNetwork,
  };
}

/** 本机网卡地址（含 IPv6）：局域网直连时一并放进 NO_PROXY，供「连自己」的场景兜底。 */
function localInterfaceAddresses(): string[] {
  const out: string[] = [];
  try {
    for (const list of Object.values(networkInterfaces())) {
      for (const info of list ?? []) out.push(info.address);
    }
  } catch {
    // 拿不到网卡信息不影响主流程：回环地址已经写死在列表里。
  }
  return out;
}

function bypassEntries(info: SystemProxyInfo | null, allowLocalNetwork: boolean): string[] {
  return childBypassList({
    allowLocalNetwork,
    extra: [
      ...launchNoProxy,
      ...(info?.exceptions ?? []),
      ...(allowLocalNetwork ? localInterfaceAddresses() : []),
    ],
  });
}

// ---------------------------------------------------------------------------
// 系统代理探测
// ---------------------------------------------------------------------------

/**
 * 探测命令的超时。这几个命令（scutil / reg / gsettings）在本机跑通常只有几十毫秒，
 * 但它们下面连着**所有出站请求**的代理解析链：dbus / GNOME 卡住时 gsettings 会一直
 * 不返回，而 `proc.exited` 不返回就等于每个云端请求都永远挂着，且子进程变成孤儿。
 * 超时到点由 Bun 杀掉进程，探测按失败处理（直连 + 一条日志）。
 */
const DETECT_COMMAND_TIMEOUT_MS = 5_000;

async function runCommand(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    timeout: DETECT_COMMAND_TIMEOUT_MS,
  });
  // 两条管道都要同时读：只读 stdout 时子进程往 stderr 写满管道缓冲就会阻塞，
  // 于是 `proc.exited` 永远不 resolve —— 那正是上面超时要防的死法。
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    const detail = err.trim().slice(0, 200);
    throw new Error(`${cmd[0]} 退出码 ${code}${detail ? `：${detail}` : ""}`);
  }
  return out;
}

/** macOS 只配了 SOCKS 代理时给一句人话提示：Bun 不支持，用户改用工具里的 http 端口。 */
function logSocksOnly(raw: string, info: SystemProxyInfo): void {
  if (info.url || info.pacUrl) return;
  if (!/SOCKSEnable\s*:\s*1/.test(raw)) return;
  const host = /SOCKSProxy\s*:\s*(.+)/.exec(raw)?.[1]?.trim() ?? "";
  if (loggedSocksOnly === host) return; // 探测每 30s 一次，同一件事只记一条
  loggedSocksOnly = host;
  logEvent({
    level: "warn",
    source: "app",
    event: "proxy-socks-unsupported",
    message: `系统代理只有 SOCKS（${host || "未知地址"}），不支持：请改用代理工具的 http 端口`,
    detail: { host },
  });
}

/** 探测系统代理（macOS scutil / Windows 注册表 / Linux gsettings），环境变量优先。 */
async function detectSystemProxyNow(): Promise<SystemProxyInfo> {
  const envUrl = proxyFromEnv(launchEnv);
  if (envUrl) {
    return { url: envUrl, exceptions: launchNoProxy, pacUrl: null, source: "env" };
  }
  try {
    if (process.platform === "darwin") {
      const raw = await runCommand(["scutil", "--proxy"]);
      const info = parseScutilProxy(raw);
      logSocksOnly(raw, info);
      return info;
    }
    if (process.platform === "win32") {
      return parseWindowsProxy(
        await runCommand([
          "reg",
          "query",
          "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
        ]),
      );
    }
    const read = (key: string) => runCommand(["gsettings", "get", "org.gnome.system.proxy", key]);
    const [mode, httpHost, httpPort, httpsHost, httpsPort] = await Promise.all([
      read("mode"),
      read("http host"),
      read("http port"),
      read("https host"),
      read("https port"),
    ]);
    return parseGnomeProxy({
      mode: stripGVariantQuotes(mode),
      httpHost,
      httpPort,
      httpsHost,
      httpsPort,
    });
  } catch (e) {
    // 系统代理读不到不是致命错误（按直连处理），但必须留痕：用户报「挂着代理还是连不上」时
    // 这是第一个要看的地方。探测每 30s 会重来一次，同一句原因只记一条，别刷日志。
    const reason = e instanceof Error ? e.message : String(e);
    if (loggedDetectFailure !== reason) {
      loggedDetectFailure = reason;
      logEvent({
        level: "warn",
        source: "app",
        event: "proxy-detect-failed",
        message: `读取系统代理失败：${reason}`,
        detail: { platform: process.platform },
      });
    }
    return { url: null, exceptions: [], pacUrl: null, source: "none" };
  }
}

/** 系统代理（带缓存）。`force` 用于「测试代理」按钮与设置页刷新。 */
export async function systemProxyInfo(force = false): Promise<SystemProxyInfo> {
  if (!force && systemCache && Date.now() - systemCache.at < SYSTEM_PROXY_TTL_MS) {
    return systemCache.info;
  }
  // 并发去重：缓存冷的时候（应用刚起来、或每次 TTL 到点）同时来 N 个请求，不去重就会
  // 起 N 组探测进程 —— Linux 上每组是 5 个 gsettings。共用同一次探测即可。
  if (systemInFlight) return systemInFlight;
  systemInFlight = probeSystemProxy();
  try {
    return await systemInFlight;
  } finally {
    systemInFlight = null;
  }
}

async function probeSystemProxy(): Promise<SystemProxyInfo> {
  const info = await detectSystemProxyNow();
  const changed = systemCache?.info.url !== info.url || systemCache?.info.source !== info.source;
  systemCache = { at: Date.now(), info };
  if (changed) {
    if (info.pacUrl && !info.url) {
      if (!loggedPacOnly) {
        loggedPacOnly = true;
        logEvent({
          source: "app",
          event: "proxy-system-pac",
          message: "系统只配了 PAC 脚本（自动代理），暂不支持：云端请求当前直连",
          detail: { pacUrl: info.pacUrl },
        });
      }
    } else if (info.url) {
      logEvent({
        source: "app",
        event: "proxy-system-detected",
        message: `检测到系统代理 ${maskProxyUrl(info.url)}（来源：${info.source === "env" ? "环境变量" : "系统设置"}）`,
        detail: { source: info.source, url: maskProxyUrl(info.url) },
      });
    }
  }
  return info;
}

/** 异步版本：system 模式下等探测结果（fetch 包装用，保证第一个请求就能走代理）。 */
export async function resolveProxyConfig(): Promise<ProxyConfig> {
  const base = readProxyConfig();
  if (base.mode !== "system") return base;
  const info = await systemProxyInfo();
  return { ...base, url: info.url ?? "" };
}

/**
 * 同步版本（子进程 env / 环境变量同步用）：system 模式下若缓存还没热，先按直连处理，
 * 同时后台补一次探测，热了之后下一次调用就带上了。
 */
export function effectiveProxyConfigSync(): ProxyConfig {
  const base = readProxyConfig();
  if (base.mode !== "system") return base;
  if (!systemCache) {
    if (!refreshing) {
      refreshing = true;
      void systemProxyInfo()
        .then(() => syncProxyEnv())
        .catch(() => {})
        .finally(() => {
          refreshing = false;
        });
    }
    return { ...base, url: "" };
  }
  return { ...base, url: systemCache.info.url ?? "" };
}

// ---------------------------------------------------------------------------
// 进程环境变量（子进程继承 + 兜底的 NO_PROXY）
// ---------------------------------------------------------------------------

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
];

/**
 * 把进程内的代理环境变量对齐当前设置。
 *
 * - 有代理：写进去（子进程自动继承），并补 NO_PROXY 兜底（回环 / 局域网 / 用户与系统的绕过清单）；
 * - 不使用代理 / 没探测到代理：删掉这些变量，并置 `NO_PROXY=*`。
 *
 * 为什么要 `NO_PROXY=*`：**Bun 在进程启动时就把环境里的代理记进了 HTTP 客户端**，
 * 光 `delete process.env.HTTP_PROXY` 并不会让它改回直连（实测：启动时带 HTTP_PROXY、
 * 脚本里删掉再请求，仍然走代理）。用户从带代理的终端启动应用又选「不使用代理」时，
 * 只有 `*` 能真正压住它；而显式 `proxy` 参数优先级高于 NO_PROXY，所以代理模式下
 * 逐个请求指定代理不受影响。
 */
export function syncProxyEnv(): void {
  const cfg = effectiveProxyConfigSync();
  const url = cfg.mode === "none" ? "" : cfg.url;
  for (const key of PROXY_ENV_KEYS) {
    if (url) process.env[key] = url;
    else delete process.env[key];
  }
  if (!url) {
    process.env.NO_PROXY = "*";
    process.env.no_proxy = "*";
    return;
  }
  const list = bypassEntries(systemCache?.info ?? null, cfg.allowLocalNetwork).join(",");
  process.env.NO_PROXY = list;
  process.env.no_proxy = list;
}

/** 子进程要用的代理环境变量（spawn 点合并进 env；空对象 = 直连）。 */
export function proxyChildEnv(): Record<string, string> {
  const cfg = effectiveProxyConfigSync();
  if (cfg.mode === "none" || !cfg.url) return {};
  const list = bypassEntries(systemCache?.info ?? null, cfg.allowLocalNetwork).join(",");
  return {
    HTTP_PROXY: cfg.url,
    HTTPS_PROXY: cfg.url,
    ALL_PROXY: cfg.url,
    http_proxy: cfg.url,
    https_proxy: cfg.url,
    NO_PROXY: list,
    no_proxy: list,
  };
}

// ---------------------------------------------------------------------------
// fetch / WebSocket 接线
// ---------------------------------------------------------------------------

const FETCH_PATCH_FLAG = Symbol.for("omni.proxy.fetchPatched");

let unpatchFetch: (() => void) | null = null;

function requestUrlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

/**
 * 给 `globalThis.fetch` 挂代理。幂等；覆盖主进程里所有 fetch（含 AI SDK / 下载器 / 网关上游）。
 *
 * 用异步的 `resolveProxyConfig()`：系统代理缓存冷的时候会把这一次请求等一小会儿（scutil 几十毫秒），
 * 换来的是「启动后第一个请求就走代理」，而不是前 30 秒静默直连。
 */
export function installProxyFetch(): void {
  const flag = globalThis as typeof globalThis & { [FETCH_PATCH_FLAG]?: boolean };
  if (flag[FETCH_PATCH_FLAG]) return;
  const original = globalThis.fetch;
  const patched = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // 本机 IPC（控制套接字）不看代理。
    if (init && "unix" in init) return original(input, init);
    const cfg = await resolveProxyConfig();
    return original(input, proxyInitFor(requestUrlOf(input), init, cfg));
  };
  // 静态成员（Bun 的 fetch.preconnect 等）保持可用。
  for (const key of Object.getOwnPropertyNames(original)) {
    if (key === "length" || key === "name" || key === "prototype") continue;
    Object.defineProperty(patched, key, Object.getOwnPropertyDescriptor(original, key)!);
  }
  globalThis.fetch = patched as typeof fetch;
  flag[FETCH_PATCH_FLAG] = true;
  unpatchFetch = () => {
    globalThis.fetch = original;
    delete flag[FETCH_PATCH_FLAG];
    unpatchFetch = null;
  };
}

/** 测试用：还原原始 fetch。 */
export function uninstallProxyFetch(): void {
  unpatchFetch?.();
}

/**
 * WebSocket（Edge TTS / DashScope 实时通话）的代理参数：Bun 的 WebSocket 支持 `proxy`。
 *
 * `url` 是必填的：实时通话的 WebSocket 地址是用户可改的设置
 * （`VOICE_CALL_REALTIME_BASE_URL`），指到本机 / 局域网时同样不能代理 ——
 * 与 fetch 那条路共用同一套判据，否则「回环永远直连」只在半边生效。
 * 参数设为必填（而不是"不传就一律走代理"）是为了让漏传在类型检查时就暴露。
 */
export function proxyWebSocketOptions(
  url: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const proxy = proxyForUrl(url, effectiveProxyConfigSync());
  return proxy ? { ...(extra ?? {}), proxy } : { ...(extra ?? {}) };
}

// ---------------------------------------------------------------------------
// 状态 / 自检（设置页）
// ---------------------------------------------------------------------------

export type ProxyStatus = {
  mode: ProxyMode;
  /** 当前生效的代理地址（已脱敏，可直接展示）。空 = 直连。 */
  url: string;
  /** 地址来源：custom / env / os / none。 */
  source: "custom" | "env" | "os" | "none";
  allowLocalNetwork: boolean;
  /** 系统探测到的代理（供「系统代理」模式展示）。 */
  systemUrl: string;
  pacUrl: string | null;
  exceptions: string[];
};

/** 设置页展示用的代理状态（会刷新一次系统代理探测）。 */
export async function proxyStatus(): Promise<ProxyStatus> {
  const base = readProxyConfig();
  const info = base.mode === "system" ? await systemProxyInfo() : (systemCache?.info ?? null);
  const effective: ProxyConfig = {
    ...base,
    url: base.mode === "system" ? (info?.url ?? "") : base.url,
  };
  return {
    mode: effective.mode,
    url: maskProxyUrl(effective.url),
    source: effective.mode === "custom" ? "custom" : effective.url ? (info?.source ?? "os") : "none",
    allowLocalNetwork: effective.allowLocalNetwork,
    systemUrl: maskProxyUrl(info?.url ?? ""),
    pacUrl: info?.pacUrl ?? null,
    exceptions: info?.exceptions ?? [],
  };
}

/**
 * 「测试代理」的目标：下载实际用的两个模型源，按顺序试。
 *
 * 单钉一个 HuggingFace 会把「网到不了 HF、代理其实没问题」报成失败（实测在国内网络下就是这样，
 * ModelScope 反而是通的），所以两个源都试：谁先答上算谁，都失败时逐条列出原因。
 */
const TEST_TARGETS = [
  "https://huggingface.co/api/models?limit=1",
  "https://www.modelscope.cn/openapi/v1/models?page=1&page_size=1",
];
/** 单个目标的预算：两个都超时也就 16s。 */
const TEST_TARGET_TIMEOUT_MS = 8_000;

export type ProxyTestResult = {
  ok: boolean;
  /** 走代理的地址（脱敏）或空串（直连）。 */
  url: string;
  source: string;
  latencyMs?: number;
  status?: number;
  /** 答上话的目标主机（成功时告诉用户「谁通了」）。 */
  target?: string;
  error?: string;
};

/** 设置页可以在保存前先试一把：带上表单里正在编辑的值。 */
export type ProxyTestOverride = {
  mode?: string;
  url?: string;
  allowLocalNetwork?: boolean;
};

async function configForTest(override?: ProxyTestOverride): Promise<ProxyConfig> {
  const saved = await resolveProxyConfig();
  if (!override) return saved;
  const mode = isProxyMode(override.mode) ? override.mode : saved.mode;
  let url = "";
  if (mode === "custom") {
    const normalized = normalizeProxyUrl(override.url ?? "");
    url = normalized.ok ? normalized.url : "";
  } else if (mode === "system") {
    url = (await systemProxyInfo()).url ?? "";
  }
  return { mode, url, allowLocalNetwork: override.allowLocalNetwork ?? saved.allowLocalNetwork };
}

/**
 * 「测试代理」按钮：经当前（或表单里正在编辑的）设置请求一次模型源，验证代理真的通。
 */
export async function testProxyConnection(override?: ProxyTestOverride): Promise<ProxyTestResult> {
  const cfg = await configForTest(override);
  const url = maskProxyUrl(cfg.url);
  if (cfg.mode === "custom" && !cfg.url) {
    return { ok: false, url: "", source: cfg.mode, error: "请先填写有效的代理地址" };
  }
  const failures: string[] = [];
  for (const target of TEST_TARGETS) {
    const host = new URL(target).host;
    const started = Date.now();
    try {
      // 显式带上 proxy，不依赖全局 fetch 包装：这个接口的意义就是「用当前设置试一次」，
      // 万一包装没装上（独立进程 / 测试环境）也必须测的是代理本身。
      const res = await fetch(
        target,
        proxyInitFor(target, { signal: AbortSignal.timeout(TEST_TARGET_TIMEOUT_MS) }, cfg),
      );
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        failures.push(`${host}：HTTP ${res.status}`);
        continue;
      }
      logEvent({
        source: "app",
        event: "proxy-test",
        message: `代理测试${cfg.url ? `（${url}）` : "（直连）"} → ${host}：HTTP ${res.status}，${latencyMs}ms`,
        detail: { mode: cfg.mode, url, target: host, status: res.status, latencyMs },
      });
      return { ok: true, url, source: cfg.mode, latencyMs, status: res.status, target: host };
    } catch (e) {
      failures.push(`${host}：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const error = failures.join("；");
  logEvent({
    level: "warn",
    source: "app",
    event: "proxy-test-failed",
    message: `代理测试失败：${error}`,
    detail: { mode: cfg.mode, url },
  });
  return { ok: false, url, source: cfg.mode, error };
}

// ---------------------------------------------------------------------------
// 启动 / 设置变更
// ---------------------------------------------------------------------------

let installed = false;

/** 主进程启动时调用一次：装 fetch 包装 + 同步环境变量 + 预热系统代理探测。 */
export function installProxy(): void {
  if (installed) return;
  installed = true;
  installProxyFetch();
  syncProxyEnv();
  const cfg = readProxyConfig();
  if (cfg.mode === "system") void systemProxyInfo().then(() => syncProxyEnv());
  logEvent({
    source: "app",
    event: "proxy-init",
    message:
      cfg.mode === "none"
        ? "代理：不使用"
        : cfg.mode === "custom"
          ? `代理：自定义 ${maskProxyUrl(cfg.url) || "（地址无效，直连）"}`
          : "代理：跟随系统",
    detail: { mode: cfg.mode, allowLocalNetwork: cfg.allowLocalNetwork },
  });
}

/** 设置页保存后调用：清缓存、重同步环境变量、重新探测。 */
export function applyProxySettings(): void {
  systemCache = null;
  syncProxyEnv();
  const cfg = readProxyConfig();
  if (cfg.mode === "system") {
    void systemProxyInfo(true).then(() => syncProxyEnv());
  }
  logEvent({
    source: "app",
    event: "proxy-settings-changed",
    message: `代理设置已更新：${
      cfg.mode === "none" ? "不使用代理" : `${cfg.mode === "custom" ? "自定义" : "系统"} ${maskProxyUrl(cfg.url)}`
    }`,
    detail: { mode: cfg.mode, url: maskProxyUrl(cfg.url), allowLocalNetwork: cfg.allowLocalNetwork },
  });
}
