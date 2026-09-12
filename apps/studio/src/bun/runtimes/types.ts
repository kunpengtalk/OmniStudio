export type ServerStatus = "stopped" | "starting" | "downloading" | "running" | "error";

export type LogListener = (line: string) => void;
export type StatusListener = (status: ServerStatus) => void;

export type StartResult = { ok: boolean; error?: string };

export type BinaryCheckResult = { found: boolean; path?: string; mode?: string };

/**
 * 单个服务器实例的覆盖项。
 *
 * 一个 runtime 实例 = 一个服务器进程；同引擎可以并存多个模型（各自端口），
 * 所以实例不能再去设置里读「当前活动模型 / 端口」，否则第二个模型一启动
 * 就会顶掉第一个（改的是同一份设置）。不传覆盖项时保持旧行为：按设置解析。
 */
export type RuntimeOverrides = {
  /** 显式模型目标（本地路径或 HF repo id）；不传则按设置解析当前活动模型。 */
  model?: string;
  /** 监听端口；不传则用该引擎在设置里的端口。 */
  port?: string;
  /** 服务名（llama.cpp --alias / vLLM、SGLang --served-model-name）；不传则按模型名生成。 */
  servedName?: string;
};

export interface Runtime {
  readonly id: string;
  readonly label: string;

  checkBinary(): Promise<BinaryCheckResult>;

  /**
   * The exact command line that would launch the inference server, using
   * current settings. `modelOverride` (a local file path or a HF ref) takes
   * precedence over the currently active model; omit it for the active model.
   * Used to let users copy the command and run it in their own terminal.
   */
  buildCommandLine(modelOverride?: string): string;

  start(): Promise<StartResult>;
  stop(): Promise<void>;
  restart(): Promise<StartResult>;
  forceKill(): void;

  getStatus(): ServerStatus;
  getPid(): number | undefined;
  getLogs(): string;
  getLastError(): string;
  clearLogs(): void;

  onLog(cb: LogListener): () => void;
  onStatusChange(cb: StatusListener): () => void;
}