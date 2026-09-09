export type ServerStatus = "stopped" | "starting" | "downloading" | "running" | "error";

export type LogListener = (line: string) => void;
export type StatusListener = (status: ServerStatus) => void;

export type StartResult = { ok: boolean; error?: string };

export type BinaryCheckResult = { found: boolean; path?: string };

export interface Runtime {
  readonly id: string;
  readonly label: string;

  checkBinary(): Promise<BinaryCheckResult>;

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