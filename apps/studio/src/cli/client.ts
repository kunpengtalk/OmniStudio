import { existsSync } from "fs";
import { spawn } from "bun";
import { appBundlePath, controlSocketPath } from "./data-dir";

export type ControlResult = {
  connected: boolean;
  ok: boolean;
  data?: any;
  error?: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 向运行中的应用发控制命令（HTTP over unix socket）。
 * `connected=false` 表示应用没在运行（socket 不存在或探测失败）。
 */
export async function controlRequest(
  cmd: string,
  payload?: Record<string, unknown>,
  timeoutMs = 20000,
): Promise<ControlResult> {
  const socketPath = controlSocketPath();
  if (!existsSync(socketPath)) {
    return { connected: false, ok: false, error: "应用未运行（控制 socket 不存在）" };
  }
  try {
    const res = await fetch("http://control", {
      unix: socketPath,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd, payload }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { connected: true, ok: false, error: `控制服务返回 HTTP ${res.status}` };
    const body = (await res.json()) as { ok: boolean; data?: unknown; error?: string };
    return { connected: true, ok: body.ok, data: body.data, error: body.error };
  } catch (err) {
    return { connected: false, ok: false, error: String(err) };
  }
}

export async function isAppRunning(): Promise<boolean> {
  const r = await controlRequest("ping", undefined, 2000);
  return r.connected && r.ok;
}

/** 唤起已安装的 OmniStudio.app（`open` 拉起 + 轮询控制 socket 就绪）。 */
export async function launchApp(appPath?: string): Promise<boolean> {
  const target = appPath && existsSync(appPath) ? appPath : appBundlePath();
  const args = target ? ["open", target] : ["open", "-a", "OmniStudio"];
  const proc = spawn(args, { stdout: "ignore", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    console.error("无法启动 OmniStudio 应用，请确认已安装，或指定 --app-path <OmniStudio.app>");
    return false;
  }
  return true;
}

/** 确保应用在运行；没运行就拉起并等待控制 socket 就绪。 */
export async function ensureAppRunning(opts?: {
  appPath?: string;
  waitMs?: number;
}): Promise<boolean> {
  if (await isAppRunning()) return true;
  const launched = await launchApp(opts?.appPath);
  if (!launched) return false;
  const timeout = opts?.waitMs ?? 20000;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await isAppRunning()) return true;
    await sleep(400);
  }
  return false;
}
