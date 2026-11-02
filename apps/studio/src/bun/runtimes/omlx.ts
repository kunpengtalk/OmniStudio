import type { Subprocess } from "bun";
import { existsSync, mkdirSync, statSync } from "fs";
import { join } from "path";

import { buildOmlxServeArgs, omlxRequestModelId } from "../../shared/omlx";
import {
  ENGINE_EXTRA_ARGS_KEYS,
  getServerPort,
  getSetting,
} from "../db/settings";
import { omlxBaseDir } from "../engine-paths";
import { markServerStarted } from "../stats";
import { extractStartupError } from "./errors";
import { MAX_LOG_CHARS, killProcessTree, pumpServerOutput, spawnServerProcess } from "./proc";
import type {
  BinaryCheckResult,
  LogListener,
  Runtime,
  RuntimeOverrides,
  ServerStatus,
  StartResult,
  StatusListener,
} from "./types";

/**
 * oMLX：Apple Silicon 专属的独立推理服务器（https://github.com/jundot/omlx）。
 *
 * 它与另外四个引擎的形态不同，有三点必须记住：
 *
 * 1. **只认模型目录，不认单文件**：`omlx serve --model-dir <dir>`，目录本身可以是
 *    一个模型（oMLX 的 discovery 在「目录里没有子模型」时会把这个目录注册成模型，
 *    id = 目录名）。所以应用把一个模型目录指过去即可，不需要额外建软链或目录映射。
 * 2. **模型 id 就是目录名**，没有 `--alias` / `--served-model-name`：
 *    `Qwen__Qwen3.5-4B` 这个目录对外的 id 就是 `Qwen__Qwen3.5-4B`，不是 slug 化的
 *    `qwen3.5-4b`。请求里填错名字的后果与 MLX 一样 —— 服务器找不到模型，而不是报错
 *    一句就完，所以 `omlxRequestModelId()` 是这个约定的唯一实现。
 * 3. **它自己会持久化状态**（`~/.omlx/settings.json`、日志、SSD KV 缓存）。
 *    应用拉起的那份实例固定用 `--base-path <dataDir>/omlx` 隔离，避免改一次端口就
 *    重写用户自己那份 oMLX 的配置。
 *
 * 生命周期仍遵守统一约定：Bun.spawn（独立进程组）+ 管道日志 + `/v1/models` 就绪轮询
 * + SIGTERM/SIGKILL。
 */
export class OmlxRuntime implements Runtime {
  readonly id = "omlx";
  readonly label = "oMLX";

  constructor(private readonly overrides: RuntimeOverrides = {}) {}

  private serverProcess: Subprocess | null = null;
  private serverStatus: ServerStatus = "stopped";
  private serverLogs = "";
  private lastError = "";

  private binary: string | null = null;

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
    const path = resolveOmlxBinary();
    if (path) {
      this.binary = path;
      return { found: true, path, mode: "cli" };
    }
    return { found: false };
  }

  /**
   * 解析要服务的模型目录。优先级：覆盖项（已启动实例）→ `OMLX_MODEL`（用户在引擎
   * 面板显式部署）→ `LOCAL_MODEL_PATH`（模型库里选中的那个）。
   */
  private resolveModel(): { modelDir: string; requestModelId: string } {
    if (this.overrides.model) {
      return {
        modelDir: this.overrides.model,
        requestModelId: omlxRequestModelId(this.overrides.model),
      };
    }
    const deployed = (getSetting("OMLX_MODEL") || "").trim();
    if (deployed) return { modelDir: deployed, requestModelId: omlxRequestModelId(deployed) };
    const localPath = (getSetting("LOCAL_MODEL_PATH") || "").trim();
    if (localPath) return { modelDir: localPath, requestModelId: omlxRequestModelId(localPath) };
    return { modelDir: "", requestModelId: "" };
  }

  private buildArgs(modelDir: string): string[] {
    return buildOmlxServeArgs({
      modelDir,
      host: getSetting("SERVER_HOST") || "127.0.0.1",
      port: this.overrides.port ?? getServerPort(this.id),
      basePath: omlxBaseDir(),
      memoryGuard: getSetting("OMLX_MEMORY_GUARD"),
      maxConcurrentRequests: getSetting("OMLX_MAX_CONCURRENT_REQUESTS"),
      extraArgs: getSetting(ENGINE_EXTRA_ARGS_KEYS[this.id]),
    });
  }

  buildCommandLine(modelOverride?: string): string {
    const modelDir = modelOverride ?? this.resolveModel().modelDir;
    const args = this.buildArgs(modelDir);
    return [this.binary ?? resolveOmlxBinary() ?? "omlx", ...args].join(" ");
  }

  async start(): Promise<StartResult> {
    if (this.serverStatus === "running" || this.serverStatus === "starting") {
      return { ok: false, error: "Server already running" };
    }

    const { modelDir, requestModelId } = this.resolveModel();
    if (!modelDir) {
      return {
        ok: false,
        error:
          "未配置 oMLX 模型。请在模型库里选择一个已下载的 MLX 模型，或填写 OMLX_MODEL（模型目录）。",
      };
    }
    if (!isModelDirectory(modelDir)) {
      return {
        ok: false,
        error: `oMLX 需要整个模型目录（含 config.json 的 MLX 权重目录），当前目标不是可加载的模型目录：${modelDir}。单文件模型请改用 llama.cpp。`,
      };
    }

    const binary = await this.checkBinary();
    if (!binary.found || !binary.path) {
      return {
        ok: false,
        error:
          "oMLX 未安装。可在「设置 → 模型引擎」点「安装」，或手动执行 brew install jundot/omlx/omlx / 安装官方 .dmg。",
      };
    }
    this.binary = binary.path;

    // oMLX 会把设置 / 日志 / SSD 缓存写进 --base-path，先确保目录存在。
    try {
      mkdirSync(omlxBaseDir(), { recursive: true });
    } catch (e) {
      return { ok: false, error: `无法创建 oMLX 数据目录 ${omlxBaseDir()}：${String(e)}` };
    }

    const args = this.buildArgs(modelDir);
    const cmd = [this.binary, ...args];
    this.lastError = "";
    this.setStatus("starting");
    this.appendLog(`$ ${cmd.join(" ")}\n`);

    try {
      this.serverProcess = spawnServerProcess(cmd, undefined, "omlx");
      pumpServerOutput(this.serverProcess, this.appendLog.bind(this));

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

      // oMLX 用 /v1/models 做就绪探测；它列的是「已发现」的模型。服务器起来后模型
      // 是懒加载的（首个请求才真正加载权重），所以这里要求「服务通了 + 目标模型在列」，
      // 两者都满足才算 running —— 只通不给模型的话，请求只会 404。
      const port = this.overrides.port ?? getServerPort(this.id);
      const modelsUrl = `http://localhost:${port}/v1/models`;
      const maxIdleAttempts = 180;
      /** 服务已应答但目标模型仍不在列的宽限轮数（discovery 此时已结束，不该等满 3 分钟）。 */
      const maxReadyPolls = 8;
      let idleCount = 0;
      let readyPolls = 0;
      let sawServer = false;

      while (true) {
        await Bun.sleep(1000);
        const status = this.getStatus();
        if (status !== "starting") break;

        try {
          const res = await fetch(modelsUrl, { signal: AbortSignal.timeout(2000) });
          if (res.ok) {
            sawServer = true;
            const ids = await readModelIds(res);
            // 目标模型已注册：可以接请求了。**空列表不算就绪** —— oMLX 在开始 serve
            // 之前就做完了 discovery，列表为空意味着一个模型都没认出来，此时放行只会
            // 让第一条消息拿到 404；多轮确认后仍看不到就报错并给出目录。
            if (ids.includes(requestModelId)) {
              this.setStatus("running");
              this.appendLog(`\n[server is ready] model: ${requestModelId}\n`);
              markServerStarted();
              return { ok: true };
            }
            // 服务已通但目标模型不在列：discovery 已结束（server 起来了），给它几轮
            // 宽限（大目录时 /v1/models 的响应可能正在拼），仍没有就失败。
            readyPolls += 1;
            if (readyPolls >= maxReadyPolls) break;
          }
        } catch {
          // not ready yet
        }

        idleCount += 1;
        if (idleCount >= maxIdleAttempts) break;
      }

      if (this.getStatus() === "starting") {
        this.lastError = sawServer
          ? `oMLX 已启动，但没有发现模型「${requestModelId}」。请确认模型目录里是完整的 MLX 权重（config.json + *.safetensors）：${modelDir}`
          : extractStartupError(this.serverLogs, "oMLX failed to become ready within timeout");
        const proc = this.serverProcess;
        if (proc) {
          killProcessTree(proc, "SIGTERM");
          await proc.exited.catch(() => {});
          this.serverProcess = null;
        }
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

    killProcessTree(proc, "SIGTERM");

    const exited = await Promise.race([
      proc.exited.then(() => true),
      Bun.sleep(5000).then(() => false),
    ]);

    if (!exited) {
      killProcessTree(proc, "SIGKILL");
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
        killProcessTree(this.serverProcess, "SIGKILL");
      } catch {
        // already dead
      }
      this.serverProcess = null;
    }
  }
}

// ---------------------------------------------------------------------------
// 纯函数之外的部分：二进制发现 / 版本探测 / 设置解析（都需要 bun 或数据库）
// ---------------------------------------------------------------------------

/** `~/.omlx/bin/omlx`（macOS App 装的 CLI shim）与 Homebrew opt 路径。 */
function omlxCandidatePaths(): string[] {
  const home = process.env.HOME ?? "";
  const candidates = [
    home ? join(home, ".omlx", "bin", "omlx") : "",
    "/opt/homebrew/opt/omlx/bin/omlx",
    "/usr/local/opt/omlx/bin/omlx",
  ];
  return candidates.filter(Boolean);
}

/** 解析 oMLX CLI：PATH（含 Homebrew 前缀）→ App shim → Homebrew opt。 */
export function resolveOmlxBinary(): string | null {
  // GUI 进程不继承 shell 的 PATH；把 Homebrew 前缀显式拼进去再问。
  const home = process.env.HOME ?? "";
  const path = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    home ? `${home}/.local/bin` : "",
    process.env.PATH ?? "",
  ]
    .filter(Boolean)
    .join(":");
  const which = Bun.which("omlx", { PATH: path });
  if (which) return which;
  for (const candidate of omlxCandidatePaths()) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** `omlx --version`（写进引擎页的版本列；系统装的版本我们只探测、不接管）。 */
export function readOmlxVersion(binary: string | null): string | null {
  if (!binary) return null;
  try {
    const proc = Bun.spawnSync({
      cmd: [binary, "--version"],
      stdout: "pipe",
      stderr: "pipe",
      timeout: 4_000,
    });
    if ((proc.exitCode ?? -1) !== 0) return null;
    const text = `${proc.stdout?.toString() ?? ""}\n${proc.stderr?.toString() ?? ""}`.trim();
    const firstLine = text.split("\n").find((line) => line.trim())?.trim() ?? "";
    return firstLine || null;
  } catch {
    return null;
  }
}

/** 目录里有没有 `config.json`（oMLX discovery 的模型判据），且必须是目录。 */
function isModelDirectory(target: string): boolean {
  try {
    if (!statSync(target).isDirectory()) return false;
    return existsSync(join(target, "config.json"));
  } catch {
    return false;
  }
}

/** `/v1/models` 响应里的模型 id 列表（字段缺失按「未知」处理，不抛错）。 */
async function readModelIds(res: Response): Promise<string[]> {
  try {
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    return (body.data ?? [])
      .map((item) => (typeof item?.id === "string" ? item.id : ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 当前活动引擎是不是 oMLX（请求侧判断「要不要换成 oMLX 认的模型 id」）。 */
export function isOmlxActive(): boolean {
  return getSetting("INFERENCE_ENGINE") === "omlx";
}

/** 当前 oMLX 部署目标（设置里的 OMLX_MODEL / LOCAL_MODEL_PATH），供请求侧兜底。 */
export function resolveOmlxModel(): { model: string; requestModelId: string } {
  const deployed = (getSetting("OMLX_MODEL") || "").trim();
  if (deployed) return { model: deployed, requestModelId: omlxRequestModelId(deployed) };
  const localPath = (getSetting("LOCAL_MODEL_PATH") || "").trim();
  if (localPath) return { model: localPath, requestModelId: omlxRequestModelId(localPath) };
  return { model: "", requestModelId: "" };
}
