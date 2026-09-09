import type { Subprocess } from "bun";
import { getModelProfile, type ServerArgs } from "../../shared/model-profiles";
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
const DOWNLOAD_PATTERN = /download|fetch|pulling|(\d+(\.\d+)?)\s*%/i;

const COMMON_BINARY_PATHS = [
  "/opt/homebrew/bin/llama-server",
  "/usr/local/bin/llama-server",
];

function getSearchPath(): string {
  const home = process.env.HOME ?? "";
  const extra = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    home ? `${home}/.local/bin` : "",
    home ? `${home}/bin` : "",
  ].filter(Boolean);
  const current = process.env.PATH ?? "";
  return [...extra, current].join(":");
}

const DEFAULT_CUSTOM_SERVER_ARGS: ServerArgs = {
  ctxSize: 8192,
  imageMaxTokens: 2048,
  batchSize: 256,
  ubatchSize: 64,
  parallel: 1,
  temp: 0.2,
  topP: 0.9,
  repeatPenalty: 1.12,
  repeatLastN: 256,
  noMmprojOffload: true,
};

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

export class LlamaRuntime implements Runtime {
  readonly id = "llama.cpp";
  readonly label = "llama-server";

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
    for (const p of COMMON_BINARY_PATHS) {
      try {
        const f = Bun.file(p);
        if (await f.exists()) return { found: true, path: p };
      } catch {
        // continue
      }
    }
    const p = Bun.which("llama-server", { PATH: getSearchPath() });
    return p ? { found: true, path: p } : { found: false };
  }

  /**
   * Resolve the active model for the local runtime.
   * Priority: locally installed GGUF path → HF model reference (CUSTOM_HF_MODEL → profile).
   */
  private resolveModel(): { kind: "local"; path: string; alias: string } | { kind: "hf"; ref: string } {
    const localPath = getSetting("LOCAL_MODEL_PATH");
    if (localPath) {
      const name = getSetting("LOCAL_MODEL_NAME");
      const alias = name || localPath.split(/[\\/]/).pop()?.replace(/\.gguf$/i, "") || "model";
      return { kind: "local", path: localPath, alias: alias.toLowerCase().replace(/[^a-z0-9_.-]/g, "-") };
    }

    const profileId = getSetting("VLLM_MODEL_PROFILE");
    const profile = getModelProfile(profileId);
    const hfModel = getSetting("CUSTOM_HF_MODEL") || profile?.hfModel;
    if (hfModel) return { kind: "hf", ref: hfModel };
    return { kind: "hf", ref: "" };
  }

  private buildArgs(model:
    | { kind: "local"; path: string; alias: string }
    | { kind: "hf"; ref: string },
    serverArgs: ServerArgs): string[] {
    const port = getSetting("SERVER_PORT");
    const host = getSetting("SERVER_HOST") || "127.0.0.1";
    const ctxSize = getSetting("SERVER_CTX_SIZE") || String(serverArgs.ctxSize);
    const imageMaxTokens = getSetting("SERVER_IMAGE_MAX_TOKENS") || String(serverArgs.imageMaxTokens);
    const batchSize = getSetting("SERVER_BATCH_SIZE") || String(serverArgs.batchSize);
    const ubatchSize = getSetting("SERVER_UBATCH_SIZE") || String(serverArgs.ubatchSize);
    const parallel = getSetting("SERVER_PARALLEL") || String(serverArgs.parallel);
    const temp = getSetting("SERVER_TEMP") || String(serverArgs.temp);
    const topP = getSetting("SERVER_TOP_P") || String(serverArgs.topP);
    const gpuLayers = getSetting("SERVER_GPU_LAYERS");
    const cacheTypeK = getSetting("SERVER_CACHE_TYPE_K") || "q8_0";
    const cacheTypeV = getSetting("SERVER_CACHE_TYPE_V") || "q8_0";

    const args: string[] = [];

    if (model.kind === "local") {
      args.push("-m", model.path, "--alias", model.alias);
    } else if (model.ref) {
      args.push("-hf", model.ref);
    }

    args.push(
      "--host",
      host,
      "--port",
      port,
      "--ctx-size",
      ctxSize,
      "--image-max-tokens",
      imageMaxTokens,
      "--parallel",
      parallel,
      "--batch-size",
      batchSize,
      "--ubatch-size",
      ubatchSize,
      "--cache-type-k",
      cacheTypeK,
      "--cache-type-v",
      cacheTypeV,
      "--repeat-penalty",
      String(serverArgs.repeatPenalty),
      "--repeat-last-n",
      String(serverArgs.repeatLastN),
      "--temp",
      temp,
      "--top-p",
      topP,
    );

    if (gpuLayers && gpuLayers !== "-1") {
      args.push("--n-gpu-layers", gpuLayers);
    }

    if (serverArgs.noMmprojOffload) {
      args.push("--no-mmproj-offload");
    }

    return args;
  }

  async start(): Promise<StartResult> {
    if (this.serverStatus === "running" || this.serverStatus === "starting" || this.serverStatus === "downloading") {
      return { ok: false, error: "Server already running" };
    }

    const profileId = getSetting("VLLM_MODEL_PROFILE");
    const profile = getModelProfile(profileId);
    const serverArgs = profile?.serverArgs ?? DEFAULT_CUSTOM_SERVER_ARGS;

    const model = this.resolveModel();
    if (model.kind === "hf" && !model.ref) {
      return { ok: false, error: "No model configured" };
    }

    const binary = await this.checkBinary();
    if (!binary.found) {
      return { ok: false, error: "llama-server not found on PATH" };
    }

    const args = this.buildArgs(model, serverArgs);
    this.lastError = "";
    this.setStatus("starting");
    this.appendLog(`$ llama-server ${args.join(" ")}\n`);

    try {
      const llamaPath = binary.path!;
      const usePty = process.platform === "darwin";
      const cmd = usePty
        ? ["script", "-q", "/dev/null", llamaPath, ...args]
        : [llamaPath, ...args];

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
      const maxIdleAttempts = 120;
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