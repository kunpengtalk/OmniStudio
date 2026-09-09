import { getRuntime, getActiveEngine } from "./runtimes";
import type { Runtime } from "./runtimes";
import type { LogListener, StatusListener } from "./runtimes/types";
import { extractStartupError } from "./runtimes/errors";

export type ServerStatus = "stopped" | "starting" | "downloading" | "running" | "error";

type LogCb = (text: string) => void;
type StatusCb = (status: ServerStatus) => void;

const logCallbacks = new Set<LogCb>();
const statusCallbacks = new Set<StatusCb>();

let boundEngine = "";
let boundCleanups: Array<() => void> = [];

/** Return the runtime for the current engine, re-attaching facade listeners if the engine changed. */
function getBoundRuntime(): Runtime {
  const runtime = getRuntime();
  const engine = getActiveEngine();

  if (engine !== boundEngine) {
    for (const cleanup of boundCleanups) {
      try {
        cleanup();
      } catch {
        // ignore
      }
    }
    boundCleanups = [];

    for (const cb of logCallbacks) {
      boundCleanups.push(runtime.onLog(cb));
    }
    for (const cb of statusCallbacks) {
      boundCleanups.push(runtime.onStatusChange(cb as StatusListener));
    }

    boundEngine = engine;
  }

  return runtime;
}

/** Register a log listener and keep it working across engine swaps. */
export function onLog(cb: LogCb) {
  logCallbacks.add(cb);
  boundCleanups.push(getRuntime().onLog(cb));
  return () => {
    logCallbacks.delete(cb);
  };
}

export function onStatusChange(cb: StatusCb) {
  statusCallbacks.add(cb);
  boundCleanups.push(getRuntime().onStatusChange(cb as StatusListener));
  return () => {
    statusCallbacks.delete(cb);
  };
}

export function getStatus(): ServerStatus {
  return getBoundRuntime().getStatus();
}

export function getPid(): number | undefined {
  return getBoundRuntime().getPid();
}

export function getLogs(): string {
  return getBoundRuntime().getLogs();
}

export function getLastError(): string {
  // Prefer a concrete error mined from the live server log; fall back to the
  // runtime's cached message (which may predate the full log output).
  return extractStartupError(getLogs(), getBoundRuntime().getLastError());
}

export function clearLogs() {
  getBoundRuntime().clearLogs();
}

export function checkBinaryExists() {
  return getBoundRuntime().checkBinary();
}

export async function startServer() {
  return getBoundRuntime().start();
}

export async function stopServer(): Promise<void> {
  await getBoundRuntime().stop();
}

export async function restartServer() {
  return getBoundRuntime().restart();
}

export function forceKill() {
  getBoundRuntime().forceKill();
}