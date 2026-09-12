import type { Subprocess } from "bun";
import { existsSync } from "fs";
import { getSetting, getServerPort, ENGINE_EXTRA_ARGS_KEYS } from "../db/settings";
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

function slugModelName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
}

/**
 * Apple MLX (`mlx-lm`) 本地推理引擎。
 *
 * 运行的是 Apple 官方 OpenAI 兼容服务器 `mlx_lm.server`（Python 包 `mlx-lm`，
 * 依赖 Apple `mlx` 框架），仅适用于 macOS（Apple Silicon）。模型既可以是本地
 * 目录，也可以是 HuggingFace repo id —— 传 repo id 时首次启动会自动下载到
 * HF 缓存，下载走 `HF_ENDPOINT` 镜像（默认 hf-mirror.com）。
 *
 * 与 llama.cpp / vLLM / SGLang 运行时保持同一套生命周期约定：Bun.spawn +
 * stdout/stderr 管道 + /v1/models 就绪轮询 + SIGTERM/SIGKILL 停止。
 */
export class MlxRuntime implements Runtime {
  readonly id = "mlx";
  readonly label = "MLX";

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
    // 1) `mlx_lm.server` console script（pip 安装 mlx-lm 后随包提供）。
    const serverScript = Bun.which("mlx_lm.server");
    if (serverScript) return { found: true, path: serverScript, mode: "server" };

    // 2) 裸 `mlx_lm` 命令（部分版本会把 .server 一并安装，这里兜底为 python -m）。
    const mlxLm = Bun.which("mlx_lm");
    if (mlxLm) return { found: true, path: mlxLm, mode: "mlx-lm" };

    // 3) python3/python 内可用 `import mlx_lm` → `python -m mlx_lm.server`。
    for (const py of ["python3", "python"]) {
      const pythonPath = Bun.which(py);
      if (!pythonPath) continue;
      try {
        const proc = Bun.spawn([pythonPath, "-c", "import mlx_lm"], { stdout: "pipe", stderr: "pipe" });
        const exited = await Promise.race([
          proc.exited.then(() => true),
          Bun.sleep(5000).then(() => false),
        ]);
        if (exited) return { found: true, path: pythonPath, mode: "python" };
      } catch {
        // try next interpreter
      }
    }

    return { found: false };
  }

  /**
   * 解析 MLX 模型。优先级：`MLX_MODEL`（HF repo id 或本地目录）→
   * `LOCAL_MODEL_PATH`（本地目录）→ `CHAT_MODEL` → `CUSTOM_HF_MODEL`。
   * 传 repo id 时启动阶段由 mlx-lm 自动下载，无需提前准备文件。
   */
  private resolveModel(): { model: string; servedName?: string } {
    const mlxModel = (getSetting("MLX_MODEL") || "").trim();
    if (mlxModel) {
      return { model: mlxModel, servedName: slugModelName(mlxModel.split("/").pop() ?? mlxModel) };
    }

    const localPath = getSetting("LOCAL_MODEL_PATH");
    if (localPath && existsSync(localPath)) {
      const localName = getSetting("LOCAL_MODEL_NAME");
      const base = localPath.split(/[\\/]/).pop() ?? "model";
      return { model: localPath, servedName: slugModelName(localName || base) };
    }

    const chatModel = getSetting("CHAT_MODEL");
    if (chatModel) return { model: chatModel, servedName: slugModelName(chatModel) };

    const customHf = getSetting("CUSTOM_HF_MODEL");
    if (customHf) return { model: customHf.split(":")[0] ?? customHf };

    return { model: "" };
  }

  private buildArgs(model: string): string[] {
    const host = getSetting("SERVER_HOST") || "127.0.0.1";
    const port = getServerPort(this.id);

    const args: string[] = [
      "--model",
      model,
      "--host",
      host,
      "--port",
      port,
    ];

    // KV 缓存参数随 mlx-lm 版本自适应：旧版 --cache-size-gb，新版 --prompt-cache-bytes；
    // 未探测（如命令预览）或都不支持时省略，保证任何版本都能启动。
    if (this.cacheArgs) args.push(...this.cacheArgs);

    const extra = getSetting(ENGINE_EXTRA_ARGS_KEYS[this.id]);
    if (extra.trim()) args.push(...extra.trim().split(/\s+/));

    return args;
  }

  /**
   * 探测已安装 mlx-lm 的缓存参数形态（旧版 `--cache-size-gb <GB>`，
   * 新版 `--prompt-cache-bytes <bytes>`）。结果缓存，避免每次启动都跑 --help。
   */
  private cacheArgs: string[] | null = null;

  private async probeCacheArgs(): Promise<string[]> {
    const cacheGb = Number(getSetting("MLX_CACHE_SIZE_GB"));
    if (!Number.isFinite(cacheGb) || cacheGb <= 0) return [];

    try {
      const bin = this.binary;
      const mode = this.binaryMode;
      if (!bin || !mode) return [];
      const helpCmd =
        mode === "server"
          ? [bin, "--help"]
          : mode === "mlx-lm"
            ? [bin, "server", "--help"]
            : [bin, "-m", "mlx_lm.server", "--help"];
      const proc = Bun.spawn(helpCmd, { stdout: "pipe", stderr: "pipe" });
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text().catch(() => ""),
        new Response(proc.stderr).text().catch(() => ""),
      ]);
      const help = `${out}\n${err}`;
      if (help.includes("--cache-size-gb")) {
        return ["--cache-size-gb", String(Math.round(cacheGb))];
      }
      if (help.includes("--prompt-cache-bytes")) {
        return ["--prompt-cache-bytes", String(Math.round(cacheGb * 2 ** 30))];
      }
      return [];
    } catch {
      return [];
    }
  }

  buildCommandLine(modelOverride?: string): string {
    const model = modelOverride ?? this.resolveModel().model;
    const args = this.buildArgs(model);
    // 未启动过时按最常见的 console script 形式给出可复制命令。
    const mode = this.binaryMode ?? "server";
    if (mode === "server") return [this.binary ?? "mlx_lm.server", ...args].join(" ");
    if (mode === "mlx-lm") return [this.binary ?? "mlx_lm", "server", ...args].join(" ");
    return [this.binary ?? "python3", "-m", "mlx_lm.server", ...args].join(" ");
  }

  private binary: string | null = null;
  private binaryMode: "server" | "mlx-lm" | "python" | null = null;

  async start(): Promise<StartResult> {
    if (this.serverStatus === "running" || this.serverStatus === "starting" || this.serverStatus === "downloading") {
      return { ok: false, error: "Server already running" };
    }

    const { model } = this.resolveModel();
    if (!model) {
      return { ok: false, error: "未配置 MLX 模型。请在 MLX 引擎面板选择 DeepSeek V4.1 Flash 或填写 MLX_MODEL（HF repo id / 本地目录）。" };
    }

    const binary = await this.checkBinary();
    if (!binary.found || !binary.path) {
      return { ok: false, error: "MLX 未安装。安装命令：pip install -U mlx-lm" };
    }
    this.binary = binary.path;
    this.binaryMode = binary.mode === "server" || binary.mode === "mlx-lm" ? binary.mode : "python";
    // 探测 KV 缓存参数形态（旧版 --cache-size-gb / 新版 --prompt-cache-bytes）。
    this.cacheArgs = await this.probeCacheArgs();

    const args = this.buildArgs(model);
    this.lastError = "";
    this.setStatus("starting");

    // server 模式直接执行 console script；裸 mlx_lm 用 `mlx_lm server` 子命令；
    // python 走 `-m mlx_lm.server`。
    const cmd =
      this.binaryMode === "server"
        ? [this.binary, ...args]
        : this.binaryMode === "mlx-lm"
          ? [this.binary, "server", ...args]
          : [this.binary, "-m", "mlx_lm.server", ...args];

    this.appendLog(`$ ${cmd.join(" ")}\n`);

    // 国内环境优先走 hf-mirror；置空 MLX_HF_ENDPOINT 则使用 HuggingFace 官方。
    const hfEndpoint = (getSetting("MLX_HF_ENDPOINT") || "").trim();
    const env: Record<string, string> = {};
    if (hfEndpoint) env.HF_ENDPOINT = hfEndpoint;

    try {
      this.serverProcess = Bun.spawn(cmd, {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...(process.env as Record<string, string>), ...env },
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

      // mlx_lm.server 不暴露 /health，用 /v1/models 做就绪探测。
      // 大模型加载可能较久，给足时间（约 3 分钟）。
      const port = getServerPort(this.id);
      const healthUrl = `http://localhost:${port}/v1/models`;
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
