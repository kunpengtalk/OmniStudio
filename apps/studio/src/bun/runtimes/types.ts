export type ServerStatus = "stopped" | "starting" | "downloading" | "running" | "error";

export type LogListener = (line: string) => void;
export type StatusListener = (status: ServerStatus) => void;

export type StartResult = { ok: boolean; error?: string };

export type BinaryCheckResult = { found: boolean; path?: string };

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