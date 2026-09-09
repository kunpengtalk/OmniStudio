import type { Subprocess } from "bun";
import { getSetting } from "../db/settings";
import { markServerStarted } from "../stats";
import { extractStartupError } from "./errors";
import type {
  BinaryCheckResult,
  LogListener,
  Runtime,
  ServerStatus,
  StartResult,
  StatusListener,
} from "./types";

const MAX_LOG_CHARS = 200_000;
const DOWNLOAD_PATTERN = /downloading|fetching|(\d+(\.\d+)?)\s*%|progress/i;

function collapseCarriageReturns(text: string): string {
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

async function pipeStream(stream: ReadableStream<Uint8Array>, appendLog: (text: string) => void) {
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

export class SglangRuntime implements Runtime {
  readonly id = "sglang";
  readonly label = "SGLang";

  private serverProcess: Subprocess | null = null;
  private serverStatus: ServerStatus = "stopped";
  private serverLogs = "";
  private lastError = "";
  private lastDownloadActivityAt = 0;

  private logListeners = new Set<LogListener>();
  private statusListeners = new Set<StatusListener>();

  private setStatus(status: ServerStatus) {
    this.serverStatus = status;
    for (const cb of this.statusListeners) cb(status);
  }

  private appendLog(text: string) {
    this.serverLogs += text;
    if (this.serverLogs.length > MAX_LOG_CHARS) {
      this.serverLogs = this.serverLogs.slice(-MAX_LOG_CHARS);
    }
    if (DOWNLOAD_PATTERN.test(text)) {
      this.lastDownloadActivityAt = Date.now();
      if (this.serverStatus === "starting") this.setStatus("downloading");
    }
    for (const cb of this.logListeners) cb(text);
  }

  onLog(cb: LogListener): () => void {
    this.logListeners.add(cb);
    return () => this.logListeners.delete(cb);
  }

  onStatusChange(cb: StatusListener): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  getStatus(): ServerStatus {
    return this.serverStatus;
  }

  getPid(): number | undefined {
    return this.serverProcess?.pid;
  }

  getLogs(): string {
    return this.serverLogs;
  }

  getLastError(): string {
    return this.lastError;
  }

  clearLogs() {
    this.serverLogs = "";
  }

  async checkBinary(): Promise<BinaryCheckResult> {
    // Check for python3 with sglang installed
    const pythonPath = Bun.which("python3") ?? Bun.which("python");
    if (!pythonPath) return { found: false };

    try {
      const proc = Bun.spawn([pythonPath, "-c", "import sglang; print(sglang.__version__)"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exited = await Promise.race([
        proc.exited.then(() => true),
        Bun.sleep(5000).then(() => false),
      ]);
      if (exited) return { found: true, path: pythonPath };
    } catch {
      // not available
    }

    return { found: false };
  }

  private resolveModel(): { model: string; servedName?: string } {
    const localPath = getSetting("LOCAL_MODEL_PATH");
    if (localPath) {
      const localName = getSetting("LOCAL_MODEL_NAME");
      const servedName = localName
        ? localName.toLowerCase().replace(/[^a-z0-9_.-]/g, "-")
        : undefined;
      return { model: localPath, servedName };
    }

    const chatModel = getSetting("CHAT_MODEL");
    if (chatModel) return { model: chatModel };

    const profileId = getSetting("VLLM_MODEL_PROFILE");
    if (profileId && profileId !== "none") {
      const customHf = getSetting("CUSTOM_HF_MODEL");
      if (customHf) return { model: customHf.split(":")[0] ?? customHf };
    }

    const customHf = getSetting("CUSTOM_HF_MODEL");
    if (customHf) return { model: customHf.split(":")[0] ?? customHf };

    return { model: "" };
  }

  private buildArgs(model: string, servedName?: string): string[] {
    const port = getSetting("SERVER_PORT");
    const host = getSetting("SERVER_HOST") || "127.0.0.1";
    const contextLength = getSetting("SGLANG_CONTEXT_LENGTH") || "8192";
    const tpSize = getSetting("SGLANG_TP_SIZE") || "1";
    const memFraction = getSetting("SGLANG_MEM_FRACTION_STATIC") || "0.88";
    const chunkedPrefill = getSetting("SGLANG_CHUNKED_PREFILL_SIZE") || "";

    const args: string[] = [
      "-m",
      "sglang.launch_server",
      "--model-path",
      model,
      "--host",
      host,
      "--port",
      port,
      "--context-length",
      contextLength,
      "--tp",
      tpSize,
      "--mem-fraction-static",
      memFraction,
    ];

    if (servedName) args.push("--served-model-name", servedName);

    if (chunkedPrefill && chunkedPrefill !== "0") {
      args.push("--chunked-prefill-size", chunkedPrefill);
    }

    return args;
  }

  buildCommandLine(modelOverride?: string): string {
    let model: string;
    let servedName: string | undefined;
    if (modelOverride) {
      model = modelOverride;
    } else {
      const resolved = this.resolveModel();
      model = resolved.model;
      servedName = resolved.servedName;
    }
    const python = Bun.which("python3") ?? Bun.which("python") ?? "python3";
    return [python, ...this.buildArgs(model, servedName)].join(" ");
  }

  async start(): Promise<StartResult> {
    if (this.serverStatus === "running" || this.serverStatus === "starting" || this.serverStatus === "downloading") {
      return { ok: false, error: "Server already running" };
    }

    const { model, servedName } = this.resolveModel();
    if (!model) {
      return { ok: false, error: "No model configured" };
    }

    const binary = await this.checkBinary();
    if (!binary.found) {
      return { ok: false, error: "SGLang not found. Install with: pip install sglang" };
    }

    const args = this.buildArgs(model, servedName);
    this.lastError = "";
    this.setStatus("starting");

    const cmd = [binary.path!, ...args];
    this.appendLog(`$ ${cmd.join(" ")}\n`);

    try {
      this.serverProcess = Bun.spawn(cmd, {
        stdout: "pipe",
        stderr: "pipe",
      });

      const { stdout, stderr } = this.serverProcess;
      const appendLog = this.appendLog.bind(this);
      if (stdout && typeof stdout !== "number") pipeStream(stdout, appendLog);
      if (stderr && typeof stderr !== "number") pipeStream(stderr, appendLog);

      const self = this;
      this.serverProcess.exited
        .then((code) => {
          self.serverProcess = null;
          if (code === 0 || self.getStatus() === "stopped") {
            self.appendLog(`\n[server exited with code ${code}]\n`);
            self.setStatus("stopped");
          } else {
            self.lastError = extractStartupError(
              self.serverLogs,
              `Process exited with code ${code ?? 1}`,
            );
            self.appendLog(`\n[server exited with code ${code}]\n`);
            self.setStatus("error");
          }
        })
        .catch(() => {
          self.serverProcess = null;
          self.setStatus("error");
        });

      const port = getSetting("SERVER_PORT");
      const healthUrl = `http://localhost:${port}/health`;
      const maxIdleAttempts = 180;
      let idleCount = 0;
      this.lastDownloadActivityAt = 0;

      while (true) {
        await Bun.sleep(1000);
        const status = this.getStatus();
        if (status !== "starting" && status !== "downloading") break;
        try {
          const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
          if (res.ok) {
            this.setStatus("running");
            this.appendLog("\n[server is ready]\n");
            markServerStarted();
            return { ok: true };
          }
        } catch {
          // not ready yet
        }

        const downloadActive = Date.now() - this.lastDownloadActivityAt < 5000;
        if (downloadActive) {
          idleCount = 0;
        } else {
          idleCount += 1;
          if (idleCount >= maxIdleAttempts) break;
        }
      }

      const status = this.getStatus();
      if (status === "starting" || status === "downloading") {
        this.lastError = extractStartupError(
          this.serverLogs,
          "Server failed to become ready within timeout",
        );
        this.setStatus("error");
        return { ok: false, error: this.lastError };
      }

      return this.getStatus() === "running"
        ? { ok: true }
        : { ok: false, error: extractStartupError(this.serverLogs, this.lastError) };
    } catch (e) {
      this.lastError = String(e);
      this.setStatus("error");
      return { ok: false, error: this.lastError };
    }
  }

  async stop(): Promise<void> {
    if (!this.serverProcess) {
      this.setStatus("stopped");
      return;
    }

    const proc = this.serverProcess;
    this.setStatus("stopped");
    this.appendLog("\n[stopping server...]\n");

    proc.kill("SIGTERM");

    const exited = await Promise.race([
      proc.exited.then(() => true),
      Bun.sleep(5000).then(() => false),
    ]);

    if (!exited) {
      proc.kill("SIGKILL");
      await proc.exited.catch(() => {});
    }

    this.serverProcess = null;
  }

  async restart(): Promise<StartResult> {
    await this.stop();
    return this.start();
  }

  forceKill() {
    if (this.serverProcess) {
      try {
        this.serverProcess.kill("SIGKILL");
      } catch {
        // already dead
      }
      this.serverProcess = null;
    }
  }
}
