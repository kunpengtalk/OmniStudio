/**
 * 同步命令执行器 —— 探测硬件、装引擎这类「跑一条系统命令拿输出」的地方共用。
 *
 * 两个必须记住的细节写在这里，而不是让每个调用方各自记一遍：
 *  - **找不到可执行文件时 `Bun.spawnSync` 是抛异常，而不是返回非零退出码**
 *    （见 landlock-helper 里踩过的同一个坑）。统一折成 `code: -1` + stderr 里的
 *    错误文本，调用方照常走「命令不可用」的降级分支。
 *  - 一律带超时：`sysctl` 是毫秒级，`system_profiler` / `pip --version` 是秒级，
 *    但都不该把界面卡死。
 */
export type CommandResult = { code: number; stdout: string; stderr: string };

export type CommandRunner = {
  run: (cmd: string[], timeoutMs?: number) => CommandResult;
  /**
   * 流式执行：逐行回调 stdout / stderr（pip / uv / brew 一次能打出几百行，用户要看到
   * 实时输出而不是等它跑完），返回退出码。必须实现，否则安装类流程在测试里会去执行
   * 真实命令 —— 那正是不该发生的事。
   */
  runStreaming: (cmd: string[], onLine: (line: string) => void) => Promise<number>;
};

/** 多数命令用这个超时：够 `sysctl` / `tar` / `codesign` 跑完，也够快失败。 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 3_000;

async function streamInto(
  stream: ReadableStream<Uint8Array> | null,
  onLine: (line: string) => void,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) onLine(line.trimEnd());
    }
    if (buffer.trim()) onLine(buffer.trimEnd());
  } catch {
    // 流中断忽略：退出码才是判据
  }
}

export const defaultCommandRunner: CommandRunner = {
  run: (cmd, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) => {
    try {
      const proc = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
      return {
        code: proc.exitCode ?? -1,
        stdout: proc.stdout?.toString() ?? "",
        stderr: proc.stderr?.toString() ?? "",
      };
    } catch (err) {
      return { code: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
    }
  },
  runStreaming: async (cmd, onLine) => {
    try {
      const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
      await Promise.all([
        streamInto(proc.stdout as ReadableStream<Uint8Array>, onLine),
        streamInto(proc.stderr as ReadableStream<Uint8Array>, onLine),
        proc.exited,
      ]);
      return proc.exitCode ?? -1;
    } catch (err) {
      onLine(err instanceof Error ? err.message : String(err));
      return -1;
    }
  },
};

/**
 * 同名工具在 PATH 与常见安装目录里的解析（macOS 的 GUI 进程不继承 shell 的 PATH，
 * 只查 `Bun.which` 会漏掉 Homebrew）。
 */
export function searchPath(): string {
  const home = process.env.HOME ?? "";
  const extra = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    home ? `${home}/.local/bin` : "",
    home ? `${home}/bin` : "",
  ].filter(Boolean);
  return [...extra, process.env.PATH ?? ""].join(":");
}
