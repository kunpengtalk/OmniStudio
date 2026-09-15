/**
 * 代理（设置 → 偏好 → 通用）的**纯逻辑**：模式、地址规范化、直连判定、系统代理输出解析。
 *
 * 主进程与 webview 共用：webview 拿它做输入校验 / 回显，主进程拿它决定每个请求是否走代理，
 * 所以这里不能 import db / electrobun，也不能碰 process / Bun 之外的运行时设施。
 * 运行期接线（读设置、探测系统代理、给 fetch 挂代理、给子进程写 env）在 `bun/proxy.ts`。
 *
 * 判定规则（对齐用户直觉，也是「本地模型不走代理」的落地）：
 * - 回环地址永远直连 —— 本地推理服务、网关、媒体服务都在 127.0.0.1，绕代理必挂；
 * - 局域网地址默认直连（「允许访问本地网络地址」，家里 / 公司的另一台机器跑 Ollama）；
 * - 其余 http(s) 请求（云端模型、模型市场、引擎下载）走代理。
 *
 * Bun 的 `fetch(url, { proxy })` 是唯一入口：它既支持 http 代理（含 CONNECT），
 * **不支持 socks**（实测抛 UnsupportedProxyProtocol），也不认缺协议的地址 ——
 * 所以这里把用户输入规范化成 http://… 并明确拒绝 socsk，而不是等到请求时才炸。
 */

export type ProxyMode = "system" | "custom" | "none";

/** 下拉框顺序：系统代理 / 自定义代理 / 不使用代理（与主流客户端一致）。 */
export const PROXY_MODES: readonly ProxyMode[] = ["system", "custom", "none"];

export function isProxyMode(value: string | null | undefined): value is ProxyMode {
  return value === "system" || value === "custom" || value === "none";
}

/** 生效的代理配置（`url` 为空串表示直连）。 */
export type ProxyConfig = {
  mode: ProxyMode;
  url: string;
  /** 「允许访问本地网络地址」：开 = 局域网直连，关 = 连局域网也走代理。 */
  allowLocalNetwork: boolean;
};

export const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  mode: "system",
  url: "",
  allowLocalNetwork: true,
};

/** socks 提示语要能直接告诉用户怎么办：Bun 不支持，常见的 Clash 混合端口是 http。 */
const SOCKS_HINT =
  "不支持 socks/socks5 代理（Bun 的 fetch 只认 http 代理）。多数代理工具同时开了 http 端口" +
  "（如 Clash 的混合端口 7890），填那一个即可。";

export type ProxyUrlResult = { ok: true; url: string } | { ok: false; error: string };

/**
 * 规范化用户填的代理地址：补 `http://`、去掉尾部斜杠、校验协议与主机。
 * 用户名密码（`http://user:pass@host:port`）原样保留 —— Bun 支持带凭据的代理地址。
 */
export function normalizeProxyUrl(raw: string): ProxyUrlResult {
  let value = (raw ?? "").trim();
  if (!value) return { ok: false, error: "请填写代理地址" };
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value)?.[1]?.toLowerCase();
  if (scheme === "socks" || scheme === "socks4" || scheme === "socks5" || scheme === "socks4a") {
    return { ok: false, error: SOCKS_HINT };
  }
  // 只填了 `127.0.0.1:7890` 的情况：补默认协议，而不是报「地址无效」。
  if (!scheme) value = `http://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: "地址格式不对，示例：http://127.0.0.1:7890" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: `只支持 http / https 代理地址（收到 ${url.protocol}）。` + SOCKS_HINT };
  }
  if (!url.hostname) return { ok: false, error: "地址里缺少主机名，示例：http://127.0.0.1:7890" };
  const path = url.pathname.replace(/\/+$/, "");
  // `url.host` 不含用户名密码：带鉴权的代理必须自己拼回来，否则凭据会被悄悄丢掉。
  // 只有密码（`http://:pw@host`）也算配了凭据 —— 只看 username 会让这种地址静默失效。
  const auth =
    url.username || url.password
      ? `${url.username}${url.password ? `:${url.password}` : ""}@`
      : "";
  return { ok: true, url: `${url.protocol}//${auth}${url.host}${path}${url.search}` };
}

/** 日志 / 状态展示用：`http://user:pass@host:port` → `http://user:***@host:port`。 */
export function maskProxyUrl(url: string): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    const user = parsed.username ? `${parsed.username}:***@` : "***@";
    return `${parsed.protocol}//${user}${parsed.host}`;
  } catch {
    return url;
  }
}

/**
 * `::ffff:127.0.0.1` → `127.0.0.1`。
 *
 * IPv4-mapped IPv6 也是"到本机"的写法，而 `new URL()` 会把它规范化成十六进制形式
 * （`[::ffff:127.0.0.1]` → `::ffff:7f00:1`），既不在 LOOPBACK_HOSTS 里，也不匹配
 * `isPrivateIPv6`。不映射的话 `http://[::ffff:127.0.0.1]:19782/` 会被送去代理，
 * 而它连的正是 127.0.0.1 —— 回环兜底不能靠"用户只用一种写法"。
 */
function ipv4FromMapped(host: string): string | null {
  if (!host.startsWith("::ffff:")) return null;
  const rest = host.slice("::ffff:".length);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) return rest;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
  if (!hex) return null;
  const value = Number.parseInt(hex[1]!, 16) * 0x10000 + Number.parseInt(hex[2]!, 16);
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(".");
}

/** `new URL().hostname` 的 IPv6 带方括号（`[::1]`），判定前统一去掉。 */
function bareHost(hostname: string): string {
  const host = (hostname ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = ipv4FromMapped(host);
  if (mapped) return mapped;
  // 结尾一个点是 FQDN 的绝对写法（`localhost.` 与 `localhost` 同一个主机），
  // 不去掉就会被当成公网域名 —— 本地服务与预览一挂代理就全不通。
  return host.endsWith(".") ? host.slice(0, -1) : host;
}

const LOOPBACK_HOSTS = new Set([
  "localhost",
  "::1",
  "0.0.0.0",
  // 容器 / 虚拟机里指向宿主机的固定名字：语义上就是「本机」。
  "host.docker.internal",
  "host.containers.internal",
  "host.lima.internal",
  "gateway.docker.internal",
]);

/** 回环 / 本机（永远直连，不受「允许访问本地网络地址」影响）。 */
export function isLoopbackHost(hostname: string): boolean {
  const host = bareHost(hostname);
  if (!host) return false;
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (host.endsWith(".localhost")) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

/** IPv4 私有 / 保留网段：10/8、172.16/12、192.168/16、169.254/16、100.64/10（CGNAT）。 */
function isPrivateIPv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums as [number, number, number, number];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** IPv6 唯一本地地址（fc00::/7）与链路本地（fe80::/10）。 */
function isPrivateIPv6(host: string): boolean {
  if (!host.includes(":")) return false;
  if (/^f[cd][0-9a-f]{0,2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]?:/.test(host)) return true;
  return false;
}

const LOCAL_SUFFIXES = [".local", ".lan", ".internal", ".home", ".home.arpa", ".localdomain"];

/** 局域网 / 内网地址：默认直连（可被「允许访问本地网络地址」关掉）。 */
export function isLocalNetworkHost(hostname: string): boolean {
  const host = bareHost(hostname);
  if (!host || isLoopbackHost(host)) return false;
  if (isPrivateIPv4(host) || isPrivateIPv6(host)) return true;
  if (LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  // 单标签主机名（`mybox`、`ollama-box`）：公网域名一定带 TLD，这种只可能是内网。
  if (!host.includes(".") && !host.includes(":")) return true;
  return false;
}

/** 值得经过代理的协议：其余（`file:` / `data:` / `unix:`）不该进代理。 */
const PROXIED_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);

export type BypassReason = "loopback" | "local-network" | "insecure" | "";

/**
 * 该主机为什么直连（空串 = 要走代理）。
 * `insecure` 覆盖非 http(s) 协议 —— hooks / MCP 里的 `file:`、`data:` 之类不该进代理。
 */
export function bypassReasonFor(hostname: string, allowLocalNetwork: boolean): BypassReason {
  if (isLoopbackHost(hostname)) return "loopback";
  if (isLocalNetworkHost(hostname)) return allowLocalNetwork ? "local-network" : "";
  return "";
}

/**
 * 请求某个地址时该用的代理（null = 直连）。这是主进程 fetch 与子进程 env 的共同判据 ——
 * 两边规则必须一致，否则「界面说直连、实际走代理」这类问题没法查。
 */
export function proxyForUrl(rawUrl: string, config: ProxyConfig): string | null {
  if (config.mode === "none" || !config.url) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  // WebSocket 也在这里判（Edge TTS / 实时通话走 `ws(s)://`）：Bun 的 WebSocket
  // 同样支持 `proxy` 参数，而回环 / 局域网的判定与协议无关。只认 http(s) 的话，
  // 这两条链路会**永远拿不到代理**，而界面上写着"走代理"。
  if (!PROXIED_SCHEMES.has(url.protocol)) return null;
  const reason = bypassReasonFor(url.hostname, config.allowLocalNetwork);
  if (reason === "loopback" || reason === "local-network" || reason === "insecure") return null;
  return config.url;
}

/** 代理请求的额外参数。用 Bun 的 fetch init 类型：`proxy` 不在 DOM 的 RequestInit 里。 */
export function proxyInitFor(
  rawUrl: string,
  init: BunFetchRequestInit | undefined,
  config: ProxyConfig,
): BunFetchRequestInit | undefined {
  // 调用方显式指定过 proxy（比如测试）：尊重它，不重复计算。
  if (init && "proxy" in init) return init;
  const proxy = proxyForUrl(rawUrl, config);
  if (!proxy) return init;
  return { ...(init ?? {}), proxy };
}

// ---------------------------------------------------------------------------
// 系统代理：各家命令输出的解析（纯字符串处理，便于单测）
// ---------------------------------------------------------------------------

export type SystemProxyInfo = {
  url: string | null;
  /** 系统代理的绕过清单（macOS ExceptionsList / Windows ProxyOverride）。 */
  exceptions: string[];
  /** 只有 PAC 脚本、没有固定代理地址时为非空：这种我们代不了（会在日志里说明）。 */
  pacUrl: string | null;
  source: "env" | "os" | "none";
};

export const NO_SYSTEM_PROXY: SystemProxyInfo = {
  url: null,
  exceptions: [],
  pacUrl: null,
  source: "none",
};

/** 环境变量代理：大小写两套都认，HTTPS 优先（与大多数工具一致）。 */
export function proxyFromEnv(env: Record<string, string | undefined>): string | null {
  const keys = [
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
    "HTTP_PROXY",
    "http_proxy",
  ];
  for (const key of keys) {
    const raw = (env[key] ?? "").trim();
    if (raw && !parseProxyScheme(raw).unsupported) return raw;
  }
  return null;
}

function parseProxyScheme(raw: string): { unsupported: boolean } {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw.trim())?.[1]?.toLowerCase();
  // env 里的 socks 地址同样代不了：当成没配（否则每个请求都在 Bun 里炸）。
  return { unsupported: scheme === "socks" || scheme === "socks4" || scheme === "socks5" || scheme === "socks4a" };
}

/** 逗号 / 空格 / 分号分隔的绕过清单。 */
export function parseBypassList(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(/[,;\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * `scutil --proxy`（macOS）输出：
 *
 *     <dictionary> {
 *       ExceptionsList : <array> {
 *         0 : *.local
 *         1 : 169.254/16
 *       }
 *       HTTPEnable : 1
 *       HTTPPort : 7890
 *       HTTPProxy : 127.0.0.1
 *       HTTPSEnable : 1
 *       HTTPSPort : 7890
 *       HTTPSProxy : 127.0.0.1
 *     }
 */
export function parseScutilProxy(output: string): SystemProxyInfo {
  const value = (key: string) => {
    const m = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, "m").exec(output);
    return m?.[1] ?? "";
  };
  const exceptions: string[] = [];
  const arrayBlock = /ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)\}/.exec(output)?.[1] ?? "";
  for (const line of arrayBlock.split("\n")) {
    const item = /^\s*\d+\s*:\s*(.+?)\s*$/.exec(line)?.[1];
    if (item) exceptions.push(item);
  }
  const pacUrl = value("ProxyAutoConfigEnable") === "1" ? value("ProxyAutoConfigURLString") : "";
  const pick = (scheme: "HTTPS" | "HTTP") => {
    const enabled = value(`${scheme}Enable`) === "1";
    const host = value(`${scheme}Proxy`);
    const port = value(`${scheme}Port`);
    return enabled && host && port ? `http://${host}:${port}` : null;
  };
  return {
    url: pick("HTTPS") ?? pick("HTTP"),
    exceptions,
    pacUrl: pacUrl || null,
    source: pick("HTTPS") ?? pick("HTTP") ? "os" : "none",
  };
}

/**
 * `reg query "HKCU\…\Internet Settings"`（Windows）输出：
 *
 *     ProxyEnable    REG_DWORD    0x1
 *     ProxyServer    REG_SZ       http=127.0.0.1:7890;https=127.0.0.1:7890
 *     ProxyOverride  REG_SZ       <local>;*.internal
 *
 * ProxyServer 可能是 `host:port`（所有协议同一个）或 `proto=host:port;proto=…`。
 */
export function parseWindowsProxy(output: string): SystemProxyInfo {
  const value = (key: string) => {
    const m = new RegExp(`^\\s*${key}\\s+REG_\\w+\\s+(.*?)\\s*$`, "im").exec(output);
    return m?.[1] ?? "";
  };
  const enabled = value("ProxyEnable").trim();
  const raw = value("ProxyServer").trim();
  const exceptions = parseBypassList(value("ProxyOverride").replace(/<local>/gi, ""));
  if (enabled !== "0x1" && enabled !== "1") {
    return { url: null, exceptions, pacUrl: null, source: "none" };
  }
  if (!raw) {
    const pac = value("AutoConfigURL").trim();
    return { url: null, exceptions, pacUrl: pac || null, source: "none" };
  }
  const byScheme: Record<string, string> = {};
  let plain = "";
  for (const part of raw.split(";")) {
    const [head, ...rest] = part.split("=");
    if (rest.length > 0 && head) byScheme[head.trim().toLowerCase()] = rest.join("=").trim();
    else if (head?.trim()) plain = head.trim();
  }
  const target = byScheme.https ?? byScheme.http ?? plain;
  const normalized = target ? normalizeProxyUrl(target) : null;
  const url = normalized?.ok ? normalized.url : null;
  return { url, exceptions, pacUrl: null, source: url ? "os" : "none" };
}

/** `gsettings get …` 的输出是带引号的 GVariant（`'manual'`、`'127.0.0.1'`）。 */
export function stripGVariantQuotes(raw: string): string {
  return raw.trim().replace(/^'(.*)'$/s, "$1").trim();
}

/** Linux：gsettings 的 manual 模式 + http/https 主机端口。 */
export function parseGnomeProxy(input: {
  mode: string;
  httpHost: string;
  httpPort: string;
  httpsHost: string;
  httpsPort: string;
}): SystemProxyInfo {
  if (stripGVariantQuotes(input.mode) !== "manual") return NO_SYSTEM_PROXY;
  const pick = (host: string, port: string) => {
    const h = stripGVariantQuotes(host);
    const p = stripGVariantQuotes(port);
    return h && p && p !== "0" ? `http://${h}:${p}` : null;
  };
  const url = pick(input.httpsHost, input.httpsPort) ?? pick(input.httpHost, input.httpPort);
  return { url, exceptions: [], pacUrl: null, source: url ? "os" : "none" };
}

/**
 * 子进程用的绕过清单（pip / git / python 的 NO_PROXY）。
 *
 * 注意：Bun 自己的 NO_PROXY **不认 CIDR**（实测 `10.0.0.0/8` 匹配不到 10.x 地址），
 * 但 curl / git 认，所以私有网段两种写法都给上：能识别的工具拿到精确规则，
 * 不能识别的至少还有本机 IP 与 `.local` 这类后缀兜底。
 */
export function childBypassList(input: {
  allowLocalNetwork: boolean;
  extra?: readonly string[];
}): string[] {
  const base = ["localhost", "127.0.0.1", "::1"];
  const seen = new Set(base);
  const out = [...base];
  const push = (item: string) => {
    const value = item.trim();
    if (!value || seen.has(value)) return;
    // `*` 是"全部直连"的通配符，绝不能进这份清单：它一旦落进 NO_PROXY，Bun 会连
    // **显式 proxy 参数**都一起忽略（实测），于是自定义代理模式下每个请求都直连，
    // 而界面与日志还写着"走代理"。用户自己的 NO_PROXY=* 不该悄悄改掉应用的行为。
    if (value === "*") return;
    seen.add(value);
    out.push(value);
  };
  for (const item of input.extra ?? []) push(item);
  if (input.allowLocalNetwork) {
    for (const cidr of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10"]) {
      push(cidr);
    }
    for (const suffix of LOCAL_SUFFIXES) push(suffix);
  }
  return out;
}
