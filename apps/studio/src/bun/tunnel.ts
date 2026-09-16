/**
 * 内网穿透：用 Cloudflare Tunnel 把本地网关推到公网，让远程客户端用同一套
 * OpenAI / Anthropic / MCP 端点（手机、另一台电脑、云上的 Agent 服务）。
 *
 * 为什么不直接让网关监听 0.0.0.0：那要求公网可达（家宽大多没有公网 IP）、
 * 要自己处理 TLS 与证书，而且一旦绑错就是把本机记忆库和算力摊给整个网段
 * （见 shared/server-info.ts 里对媒体服务的同类判断）。隧道是**出站连接**：
 * 不开任何入站端口，域名与证书由 Cloudflare 边缘负责。
 *
 * 三条安全约束是刻意的，不要"优化"掉：
 *   1. 启动前必须有 GATEWAY_API_KEY —— 公网 URL 一旦泄漏，网关能读共享记忆、
 *      跑推理（烧用户的云端 Key 或占本机显存）、列素材库，没有 Key 就是白送；
 *   2. 隧道期间把公网域名加入网关 Host 白名单（回环绑定下的 DNS-rebinding 校验
 *      会 403 掉隧道流量），同时把 /health、/ 这类元信息端点也纳入鉴权；
 *   3. 目标端口只取网关**实际**绑定端口：配置端口被占用时网关会顺延，
 *      照配置端口连会指到一个空端口上。
 *
 * 进程托管沿用 AGENTS.md 的硬规则：detached + 进程组 kill，退出路径全部同步收尾，
 * 避免应用崩溃后留下一条没人管的公开隧道。
 */
import type { Subprocess } from "bun";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";

import { logEvent } from "./app-log";
import { resolveCloudflared, type CloudflaredBinary } from "./cloudflared";
import { getSetting } from "./db/settings";
import {
  getGatewayApiKey,
  getGatewayStatus,
  isGatewayEnabled,
  onGatewayStatusChange,
  setGatewayPublicExposure,
  startGateway,
} from "./gateway";
import { getDataDir } from "./paths";
import { killProcessTree, pumpServerOutput, spawnServerProcess, waitExit } from "./runtimes/proc";

export type TunnelStatus = "stopped" | "starting" | "running" | "error";
export type TunnelMode = "quick" | "token";
export type TunnelProtocol = "auto" | "http2" | "quic";

export type TunnelInfo = {
  status: TunnelStatus;
  /** TUNNEL_ENABLED：用户希望隧道开着（重启应用 / 网关重启后按它恢复）。 */
  enabled: boolean;
  mode: TunnelMode;
  protocol: TunnelProtocol;
  /** 公网访问地址（快速隧道由 cloudflared 分配，命名隧道来自用户填写的域名）。 */
  url: string;
  /** 与 Cloudflare 边缘的连接是否已建立（日志里的 Registered tunnel connection）。 */
  connected: boolean;
  /** 隧道指向的本地地址，永远是网关实际绑定的端口。 */
  targetUrl: string;
  /** 命名隧道模式下用户填写的公网域名（用于 Host 白名单与拼接 URL）。 */
  publicHost: string;
  gatewayRunning: boolean;
  gatewayPort: number;
  apiKeySet: boolean;
  binary: { installed: boolean; path?: string; source?: "managed" | "path"; version?: string };
  pid?: number;
  error?: string;
  notice?: string;
};

export type TunnelStartResult = {
  ok: boolean;
  error?: string;
  /** 失败归类：界面据此把用户引导到该修的那一处，而不是干看着一句报错。 */
  reason?: "api-key" | "binary" | "gateway" | "token" | "public-host" | "busy";
};

const READY_TIMEOUT_MS = 45_000;
const STOP_GRACE_MS = 4_000;
const TAIL_LINES = 40;
/** cloudflared 先打一行 "Your quick Tunnel has been created! ... https://xxx.trycloudflare.com"。 */
const QUICK_URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;

let proc: Subprocess | null = null;
let startPromise: Promise<TunnelStartResult> | null = null;
let status: TunnelStatus = "stopped";
let lastError = "";
let notice = "";
let currentUrl = "";
let connected = false;
let targetPort = 0;
let tail: string[] = [];
let fatal = "";
let scanBuffer = "";
let scanBufferMode: TunnelMode = "quick";

const listeners = new Set<(info: TunnelInfo) => void>();

export function onTunnelStatusChange(cb: (info: TunnelInfo) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function emitChange(): void {
  const info = getTunnelInfo();
  for (const cb of listeners) {
    try {
      cb(info);
    } catch {
      // 订阅方出错不影响隧道
    }
  }
}

// ---------------------------------------------------------------------------
// 纯函数（日志解析）：单独导出便于单测
// ---------------------------------------------------------------------------

/** 从 cloudflared 输出里取出快速隧道域名。 */
export function parseQuickTunnelUrl(text: string): string | null {
  const match = text.match(QUICK_URL_RE);
  return match ? match[0] : null;
}

/** 从公网 URL 取主机名（小写、去掉端口），用于网关 Host 白名单。 */
export function hostFromUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
  } catch {
    return (trimmed.split("/")[0] ?? "").split(":")[0]?.trim().toLowerCase() ?? "";
  }
}

/** 边缘连接建立（cloudflared 每个连接打一行 Registered tunnel connection）。 */
export function isTunnelConnectedLine(text: string): boolean {
  return /Registered tunnel connection/i.test(text);
}

/**
 * 一眼就没救的失败（重连类错误不算：cloudflared 自己会重试，等超时更准确）。
 *
 * 只收"无论怎么重试都不可能成功"的措辞。**不要**把 cloudflared 的信息级告警塞进来 ——
 * 实测它在没有 `~/.cloudflared` 的机器上会打 `Cannot determine default configuration path`，
 * 而快速隧道根本不需要配置目录：误判的后果是隧道已经起来了却被报成"启动失败"。
 */
export function detectTunnelFatal(text: string): string | null {
  const patterns: [RegExp, string][] = [
    [/failed to request quick Tunnel/i, "Cloudflare 拒绝创建快速隧道（可能触发限流或网络不可达）"],
    [/invalid tunnel token|failed to unmarshal the token|invalid credentials/i, "隧道 Token 无效，请检查是否复制完整"],
    [/tunnel credentials file.*(not found|no such file)/i, "隧道凭据文件不存在"],
    [/no such tunnel|tunnel .* not found/i, "Cloudflare 上没有这条隧道（Token 与隧道不匹配）"],
  ];
  for (const [re, message] of patterns) {
    if (re.test(text)) return message;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

function currentMode(): TunnelMode {
  return getSetting("TUNNEL_MODE") === "token" ? "token" : "quick";
}

function currentProtocol(): TunnelProtocol {
  const value = getSetting("TUNNEL_PROTOCOL");
  return value === "http2" || value === "quic" ? value : "auto";
}

export function getTunnelInfo(): TunnelInfo {
  const gateway = getGatewayStatus();
  const binary: CloudflaredBinary | null = resolveCloudflared();
  const mode = currentMode();
  const publicHost = mode === "token" ? hostFromUrl(getSetting("TUNNEL_PUBLIC_HOST")) : "";
  return {
    status,
    enabled: getSetting("TUNNEL_ENABLED") === "1",
    mode,
    protocol: currentProtocol(),
    url: currentUrl || (publicHost ? `https://${publicHost}` : ""),
    connected,
    targetUrl: `http://127.0.0.1:${targetPort || gateway.port}`,
    publicHost,
    gatewayRunning: gateway.status === "running",
    gatewayPort: gateway.port,
    apiKeySet: getGatewayApiKey().length > 0,
    binary: {
      installed: binary !== null,
      path: binary?.path,
      source: binary?.source,
      version: binary?.version,
    },
    pid: proc?.pid,
    error: lastError || undefined,
    notice: notice || undefined,
  };
}

/** 无状态变化但快照内容变了（例如 cloudflared 装好/删掉）：推一次给界面。 */
export function refreshTunnelStatus(): void {
  emitChange();
}

// ---------------------------------------------------------------------------
// 输出解析
// ---------------------------------------------------------------------------

function handleOutput(chunk: string): void {
  const text = chunk.replace(/\r/g, "");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    tail.push(trimmed);
    if (tail.length > TAIL_LINES) tail.shift();
  }

  // 域名可能被拆在两个 chunk 里，所以在一段滚动缓冲里找。
  scanBuffer = (scanBuffer + text).slice(-4000);
  if (scanBufferMode === "quick" && !currentUrl) {
    const url = parseQuickTunnelUrl(scanBuffer);
    if (url) {
      currentUrl = url;
      const host = hostFromUrl(url);
      setGatewayPublicExposure(host);
      if (status === "starting") status = "running";
      logEvent({
        level: "info",
        source: "tunnel",
        event: "tunnel.ready",
        message: `隧道已就绪：${url}`,
        detail: { mode: "quick", url, targetPort },
      });
      emitChange();
    }
  }
  if (!connected && isTunnelConnectedLine(text)) {
    connected = true;
    logEvent({
      level: "info",
      source: "tunnel",
      event: "tunnel.connected",
      message: "已连接到 Cloudflare 边缘",
      detail: { mode: scanBufferMode, url: currentUrl },
    });
    emitChange();
  }
  const fatalLine = detectTunnelFatal(text);
  if (fatalLine && !fatal) {
    fatal = fatalLine;
    emitChange();
  }
}

function tailText(): string {
  return tail.slice(-8).join("\n");
}

// ---------------------------------------------------------------------------
// 过期进程清理
// ---------------------------------------------------------------------------

function pidFilePath(): string {
  return getDataDir("tunnel", "cloudflared.pid");
}

function writePidFile(): void {
  try {
    const dir = getDataDir("tunnel");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      pidFilePath(),
      JSON.stringify({ pid: proc?.pid, url: currentUrl, targetPort, startedAt: Date.now() }),
    );
  } catch {
    // 写不了 pid 文件不影响隧道本身
  }
}

function clearPidFile(): void {
  try {
    rmSync(pidFilePath(), { force: true });
  } catch {
    // ignore
  }
}

/** 只认命令里带 cloudflared 的进程，避免 pid 复用误杀用户自己的进程。 */
function describeProcess(pid: number): string | null {
  try {
    const isWindows = process.platform === "win32";
    const cmd = isWindows
      ? ["tasklist", "/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]
      : ["ps", "-p", String(pid), "-o", "command="];
    const out = Bun.spawnSync(cmd);
    const text = new TextDecoder().decode(out.stdout ?? new Uint8Array()).trim();
    return text || null;
  } catch {
    return null;
  }
}

/**
 * 清掉上一次进程遗留的隧道。
 *
 * 应用被强杀（kill -9 / 崩溃）时子进程可能还在跑 —— 那意味着一条**没人管的
 * 公开入口**还开着，比留一个占显存的推理进程更严重。pid 文件是自己写的，
 * 且必须确认进程命令行里带 cloudflared 才动手。
 */
export function cleanupStaleTunnel(): void {
  const file = pidFilePath();
  if (!existsSync(file)) return;
  let pid = 0;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { pid?: number };
    pid = Number(parsed?.pid) || 0;
  } catch {
    // 文件损坏，直接删
  }
  if (pid > 0) {
    const command = describeProcess(pid);
    if (command && /cloudflared/i.test(command)) {
      try {
        process.kill(pid, "SIGTERM");
        logEvent({
          level: "warn",
          source: "tunnel",
          event: "tunnel.stale.killed",
          message: "清理上一次进程遗留的 cloudflared",
          detail: { pid },
        });
      } catch {
        // 已经退出了
      }
    }
  }
  clearPidFile();
}

// ---------------------------------------------------------------------------
// 启停
// ---------------------------------------------------------------------------

function buildArgs(binary: CloudflaredBinary, mode: TunnelMode, target: string, token: string): string[] {
  // --no-autoupdate 是必须的：cloudflared 默认会自己检查更新并重启连接，
  // 那会让我们失去对进程生命周期的控制（重启后 URL / 连接状态都不在预期内）。
  if (mode === "quick") {
    return [binary.path, "tunnel", "--url", target, "--no-autoupdate", "--loglevel", "info"];
  }
  return [binary.path, "tunnel", "--no-autoupdate", "--loglevel", "info", "run", "--token", token];
}

function buildEnv(protocol: TunnelProtocol): Record<string, string> {
  // 协议没有命令行开关，只有环境变量：UDP 7844 被封的网络（QUIC 走不通）要能切 HTTP/2。
  return protocol === "auto" ? {} : { TUNNEL_TRANSPORT_PROTOCOL: protocol };
}

/**
 * 启动隧道。
 *
 * 加了并发互斥：设置变更触发的对账与界面上的开关会几乎同时调用到这里
 * （`updateSettings` 写 TUNNEL_ENABLED 后立刻 startTunnel），而启动过程里有
 * 多个 await —— 不互斥就会拉起两个 cloudflared，留下一条没人管的公开入口。
 */
export function startTunnel(): Promise<TunnelStartResult> {
  if (proc) return Promise.resolve({ ok: true });
  if (!startPromise) {
    startPromise = runStartTunnel().finally(() => {
      startPromise = null;
    });
  }
  return startPromise;
}

async function runStartTunnel(): Promise<TunnelStartResult> {
  if (proc) return { ok: true };
  if (!isGatewayEnabled()) {
    return { ok: false, reason: "gateway", error: "网关已禁用，请先在「本地 API 网关」里启用" };
  }
  if (getGatewayStatus().status !== "running") {
    const started = await startGateway();
    if (!started.ok) {
      return { ok: false, reason: "gateway", error: started.error ?? "网关未能启动" };
    }
  }

  if (!getGatewayApiKey()) {
    return {
      ok: false,
      reason: "api-key",
      error: "公网暴露前必须设置网关 API Key：否则拿到地址的任何人都能用你的模型与记忆库",
    };
  }

  const mode = currentMode();
  const token = getSetting("TUNNEL_TOKEN").trim();
  const publicHost = hostFromUrl(getSetting("TUNNEL_PUBLIC_HOST"));
  if (mode === "token" && !token) {
    return { ok: false, reason: "token", error: "命名隧道模式需要填写 Cloudflare 隧道 Token" };
  }
  if (mode === "token" && !publicHost) {
    return {
      ok: false,
      reason: "public-host",
      error: "命名隧道模式需要填写公网域名（你在 Cloudflare 控制台给这条隧道配的 Host）",
    };
  }

  const binary = resolveCloudflared();
  if (!binary) {
    return { ok: false, reason: "binary", error: "尚未安装 cloudflared，请先点「下载 cloudflared」" };
  }

  const gateway = getGatewayStatus();
  const port = gateway.port;
  const target = `http://127.0.0.1:${port}`;
  const args = buildArgs(binary, mode, target, token);

  lastError = "";
  notice = "";
  fatal = "";
  tail = [];
  scanBuffer = "";
  scanBufferMode = mode;
  connected = false;
  currentUrl = mode === "token" ? `https://${publicHost}` : "";
  targetPort = port;
  setStatusInternal("starting");

  logEvent({
    level: "info",
    source: "tunnel",
    event: "tunnel.start",
    message: `启动隧道（${mode === "quick" ? "快速隧道" : "命名隧道"}）→ ${target}`,
    detail: { mode, protocol: currentProtocol(), targetPort: port, binary: binary.path, source: binary.source },
  });

  try {
    proc = spawnServerProcess(args, buildEnv(currentProtocol()));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    proc = null;
    setStatusInternal("error");
    lastError = `cloudflared 启动失败：${message}`;
    logEvent({
      level: "error",
      source: "tunnel",
      event: "tunnel.start.failed",
      message: lastError,
      detail: { error: e, mode },
    });
    return { ok: false, error: lastError };
  }

  const spawned = proc;
  pumpServerOutput(spawned, handleOutput);
  writePidFile();

  let exited = false;
  void spawned.exited.then((code) => {
    exited = true;
    // proc 已被 stopTunnel / restart 换成别的（或置空）时说明是我们自己停的，不报错。
    if (proc !== spawned) return;
    proc = null;
    setGatewayPublicExposure(null);
    currentUrl = "";
    connected = false;
    targetPort = 0;
    clearPidFile();
    lastError = `cloudflared 已退出（退出码 ${code}）${tailText() ? `\n${tailText()}` : ""}`;
    status = "error";
    logEvent({
      level: "error",
      source: "tunnel",
      event: "tunnel.exited",
      message: "cloudflared 意外退出，隧道已断开",
      detail: { code, mode: scanBufferMode, tail: tail.slice(-12) },
    });
    emitChange();
  });

  // 命名隧道模式没有"分配给我们的域名"可以等，等的是边缘连接建立。
  const ready = () => (mode === "quick" ? Boolean(currentUrl) : connected);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (ready() || exited || fatal) break;
    await Bun.sleep(250);
  }

  if (ready()) {
    if (status !== "running") setStatusInternal("running");
    setGatewayPublicExposure(mode === "token" ? publicHost : hostFromUrl(currentUrl));
    if (mode === "quick") {
      // 快速隧道的域名由边缘分配，写进日志方便事后排查「上次是哪个地址」。
      logEvent({
        level: "info",
        source: "tunnel",
        event: "tunnel.running",
        message: `隧道运行中：${currentUrl}`,
        detail: { mode, url: currentUrl, targetPort: port },
      });
    }
    emitChange();
    return { ok: true };
  }

  const reasonText = fatal
    ? fatal
    : exited
      ? `cloudflared 退出（退出码 ${spawned.exitCode ?? -1}）`
      : `${Math.round(READY_TIMEOUT_MS / 1000)} 秒内未拿到隧道地址`;
  const detailText = tailText();
  // 快照放在 stopTunnel 之前：它会把 tail 清掉，不然日志里只剩一句干巴巴的原因。
  const tailSnapshot = tail.slice(-12);
  lastError = detailText ? `${reasonText}\n${detailText}` : reasonText;

  await stopTunnel();
  setStatusInternal("error");
  logEvent({
    level: "error",
    source: "tunnel",
    event: "tunnel.start.failed",
    message: reasonText,
    detail: { mode, targetPort: port, tail: tailSnapshot },
  });
  emitChange();
  return { ok: false, error: lastError };
}

function setStatusInternal(next: TunnelStatus): void {
  if (status === next) return;
  status = next;
  emitChange();
}

export async function stopTunnel(): Promise<void> {
  const current = proc;
  proc = null;
  if (current) {
    killProcessTree(current, "SIGTERM");
    const gone = await waitExit(current, STOP_GRACE_MS);
    if (!gone) killProcessTree(current, "SIGKILL");
  }
  clearPidFile();
  setGatewayPublicExposure(null);
  currentUrl = "";
  connected = false;
  targetPort = 0;
  tail = [];
  scanBuffer = "";
  if (status !== "error") status = "stopped";
  emitChange();
}

/** 退出路径专用：不做等待（进程可能马上消失），但保证不留下公开入口。 */
export function stopTunnelSync(): void {
  const current = proc;
  proc = null;
  if (current) killProcessTree(current, "SIGTERM");
  clearPidFile();
  setGatewayPublicExposure(null);
  currentUrl = "";
  connected = false;
  status = "stopped";
}

export async function restartTunnel(): Promise<TunnelStartResult> {
  await stopTunnel();
  setStatusInternal("stopped");
  lastError = "";
  return startTunnel();
}

// ---------------------------------------------------------------------------
// 期望状态对账
// ---------------------------------------------------------------------------

let reconciling = false;

/**
 * 按"用户期望（TUNNEL_ENABLED）+ 网关实际状态"收敛隧道状态。
 *
 * 触发点：应用启动、网关状态变化、用户改设置。放一个对账函数而不是到处写
 * if，是为了避免出现"网关停了隧道还挂着（公网 502）"或"网关重启换了端口、
 * 隧道还指着旧端口"这类只在重启路径上才出现的问题。
 */
export async function reconcileTunnel(reason: string): Promise<void> {
  if (reconciling) return;
  reconciling = true;
  try {
    const wanted = getSetting("TUNNEL_ENABLED") === "1";
    if (!wanted) {
      if (proc) await stopTunnel();
      return;
    }
    // Key 被清掉立刻下线隧道：公网开着但没有 Key = 对全网开放本机模型与记忆库。
    if (!getGatewayApiKey()) {
      if (proc) {
        await stopTunnel();
        notice = "网关 API Key 已被清除，隧道已断开（重新设置 Key 后会自动重连）";
        emitChange();
        logEvent({
          level: "warn",
          source: "tunnel",
          event: "tunnel.stopped.no_api_key",
          message: "API Key 被清除，隧道已断开",
          detail: { trigger: reason },
        });
      }
      return;
    }
    const gateway = getGatewayStatus();
    if (gateway.status !== "running") {
      if (proc) {
        await stopTunnel();
        notice = "网关已停止，隧道已断开（网关恢复后会自动重连）";
        emitChange();
        logEvent({
          level: "warn",
          source: "tunnel",
          event: "tunnel.stopped.gateway_down",
          message: "网关停止，隧道随之关闭",
          detail: { trigger: reason },
        });
      }
      return;
    }
    if (!proc) {
      const result = await startTunnel();
      if (!result.ok) {
        logEvent({
          level: "warn",
          source: "tunnel",
          event: "tunnel.reconcile.start_failed",
          message: result.error ?? "隧道未能启动",
          detail: { trigger: reason, reason: result.reason },
        });
      }
      return;
    }
    if (targetPort !== gateway.port) {
      // 网关换了端口（端口冲突顺延 / 用户改了端口）：隧道重新指向新端口。
      logEvent({
        level: "info",
        source: "tunnel",
        event: "tunnel.repoint",
        message: `网关端口变化，隧道重新指向 ${gateway.port}`,
        detail: { from: targetPort, to: gateway.port, trigger: reason },
      });
      await restartTunnel();
    }
  } finally {
    reconciling = false;
  }
}

let bound = false;

/** 订阅网关状态：网关停了/换端口时隧道跟着收敛。由主进程启动时调用一次。 */
export function initTunnelGatewayBinding(): void {
  if (bound) return;
  bound = true;
  onGatewayStatusChange(() => {
    void reconcileTunnel("gateway");
  });
}
