import type { Subprocess } from "bun";

/**
 * 推理服务器子进程的公共设施：四个 runtime（llama.cpp / vLLM / SGLang / MLX）
 * 共用同一套"spawn + 管道日志 + 杀进程"逻辑，避免同一处修四遍。
 */

export const MAX_LOG_CHARS = 200_000;

/** 服务器启动日志里出现这些内容视为"正在下载模型"（进度条形态各引擎不同）。 */
export const DOWNLOAD_LOG_PATTERN = /downloading|fetching|pulling|(\d+(\.\d+)?)\s*%|progress/i;

/** 进度条用 \r 原地刷新，保留最后一段可读文本，避免日志刷屏。 */
export function collapseCarriageReturns(text: string): string {
  if (!text.includes("\r")) return text;
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.includes("\r")) return normalized;
  return normalized
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const parts = line.split("\r").filter(Boolean);
      return parts.length > 0 ? parts[parts.length - 1] : "";
    })
    .join("\n");
}

/** 把子进程输出流按块喂给日志回调。 */
export async function pipeStream(
  stream: ReadableStream<Uint8Array>,
  appendLog: (text: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = collapseCarriageReturns(decoder.decode(value, { stream: true }));
      if (text) appendLog(text);
    }
  } catch {
    // stream closed
  }
}

/**
 * 启动推理服务器：独立进程组（detached）+ 管道 stdio。
 *
 * 独立进程组是为了"停服务"能真的停干净：llama.cpp 在 macOS 上会用
 * `script -q /dev/null llama-server` 包一层，vLLM/SGLang/MLX 是 python 启动器，
 * 只杀直接子进程 PID 会把真正的推理进程留成孤儿（占着显存直到重启）。
 */
export function spawnServerProcess(cmd: string[], env?: Record<string, string>) {
  // stdin 不显式设置（Bun 默认 inherit，与改造前一致）：`script` 包装的
  // llama-server 会读它的 tty。
  return Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
    env: { ...(process.env as Record<string, string>), ...env },
  });
}

/** 把两个输出流接到日志回调上（不阻塞启动流程）。 */
export function pumpServerOutput(proc: Subprocess, appendLog: (text: string) => void): void {
  const { stdout, stderr } = proc;
  if (stdout && typeof stdout !== "number") void pipeStream(stdout, appendLog);
  if (stderr && typeof stderr !== "number") void pipeStream(stderr, appendLog);
}

/** 只要能拿到 pid 与 kill 就够（Bun 各形态的 Subprocess 泛型都满足）。 */
type KillableProc = {
  pid?: number;
  // 用方法简写声明：与 Bun 的 `Subprocess.kill` 保持双变（bivariant）兼容。
  kill?(signal?: number | string): void;
};

/**
 * 杀掉整个进程组（先 SIGTERM，调用方按需再 SIGKILL）。
 * 进程组不存在（已退出 / 未 detached）时退回单进程 kill。
 */
export function killProcessTree(
  proc: KillableProc | null | undefined,
  signal: "SIGTERM" | "SIGKILL" = "SIGTERM",
): void {
  if (!proc) return;
  const pid = proc.pid;
  if (typeof pid === "number" && pid > 0) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // ESRCH：进程组已不存在，走单进程兜底
    }
  }
  try {
    proc.kill?.(signal);
  } catch {
    // already dead
  }
}

/** 等待进程退出，超时返回 false（用于分级 SIGTERM → SIGKILL）。 */
export async function waitExit(proc: { exited: Promise<number> }, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    proc.exited.then(() => true),
    Bun.sleep(timeoutMs).then(() => false),
  ]);
}
