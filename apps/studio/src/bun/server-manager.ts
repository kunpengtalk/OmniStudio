import { existsSync, statSync } from "fs";
import { engineForModelKind, engineSupports, resolveEngineForModel } from "../shared/modelscope";
import { getSetting, getActiveServerPort } from "./db/settings";
import { dirModelKind, resolveRuntimeTarget } from "./model-scan";
import { createRuntime, getActiveEngine, getRuntime, type InferenceEngine } from "./runtimes";
import type { Runtime } from "./runtimes";
import type { LogListener, StatusListener } from "./runtimes/types";
import { extractStartupError } from "./runtimes/errors";
import * as Served from "./model-servers";

export type ServerStatus = "stopped" | "starting" | "downloading" | "running" | "error";

type LogCb = (text: string) => void;
type StatusCb = (status: ServerStatus) => void;

/**
 * 单实例时代的门面，现在落到「已启动模型注册表」（model-servers.ts）的**活动模型**上：
 * 启动 = 把设置里配置的模型（或已活动的那个）作为服务实例跑起来；
 * 状态 / 日志 / 停止都只看活动实例，其余并发实例由控制台按 id 管理。
 *
 * 保留这层是为了 CLI、OCR、网关、嵌入、统计等既有调用方不用关心多实例。
 */

export function onLog(cb: LogCb) {
  // 只转发活动模型的日志：旧的前端只有一个日志窗口。
  return Served.onServedModelLog((id, text) => {
    if (id === Served.getActiveServedId()) cb(text);
  });
}

export function onStatusChange(cb: StatusCb) {
  const relay = (snapshot: Served.ServedModelsSnapshot) => {
    const active = snapshot.models.find((m) => m.id === snapshot.activeId);
    cb(active?.status ?? "stopped");
  };
  return Served.onServedModelsChange(relay);
}

/** 活动模型的状态；没有活动实例时算「已停止」（与旧语义一致）。 */
export function getStatus(): ServerStatus {
  return Served.getActiveServedModel()?.status ?? "stopped";
}

export function getPid(): number | undefined {
  return Served.getActiveServedModel()?.pid;
}

export function getLogs(): string {
  const id = Served.getActiveServedId();
  return id ? Served.getServedModelLogs(id) : "";
}

export function getLastError(): string {
  const active = Served.getActiveServedModel();
  if (!active) return "";
  // 优先从实时日志里挖出具体报错（比缓存的消息新）。
  return extractStartupError(getLogs(), Served.getServedModelError(active.id));
}

export function clearLogs() {
  const id = Served.getActiveServedId();
  if (id) Served.clearServedModelLogs(id);
}

export function checkBinaryExists() {
  return getRuntime().checkBinary();
}

/**
 * Command line that would launch the inference server. For a local file,
 * uses the engine that can actually load it (may differ from the active
 * engine — built with a fresh unattached runtime so the live server is
 * untouched); otherwise the active model with the active engine.
 */
export function getLaunchCommand(modelOverride?: string): { command: string; engine: InferenceEngine } {
  const active = getActiveEngine();
  if (modelOverride && existsSync(modelOverride)) {
    // 与 setActiveModel 同一套解析：仓库目录（config.json + 分片）交给 vLLM / SGLang / MLX
    // 整目录加载，GGUF 仍然指向文件 —— 否则复制出来的命令和实际启动的不一致。
    const target = resolveRuntimeTarget(modelOverride);
    const isDir = (() => {
      try {
        return statSync(target).isDirectory();
      } catch {
        return false;
      }
    })();
    // 目录条目按目录内容选引擎；单文件按扩展名（GGUF → llama.cpp，safetensors → vLLM）。
    const engine = isDir
      ? (() => {
          const kind = dirModelKind(target);
          if (engineSupports(active, kind)) return active;
          return engineForModelKind(kind) ?? resolveEngineForModel("model.safetensors", active);
        })()
      : resolveEngineForModel(target.split(/[\\/]/).pop() ?? target, active);
    return {
      command: createRuntime(engine, { model: target }).buildCommandLine(),
      engine,
    };
  }
  const servedId = Served.getActiveServedId();
  if (servedId) {
    const command = Served.buildServedCommandLine(servedId);
    const model = Served.getServedModel(servedId);
    if (command) return { command, engine: model?.engine ?? active };
  }
  return { command: getRuntime().buildCommandLine(modelOverride), engine: active };
}

/**
 * 启动本地推理服务器 = 按设置里配置的模型起一个实例（起过就直接复用）。
 *
 * 调用方（安装向导 / 模型页 / OCR 面板）通常刚改过 LOCAL_MODEL_PATH，
 * 所以这里只认设置、不认当前活动实例；解析在 startServedModel 里做幂等。
 */
export async function startServer(): Promise<{ ok: boolean; error?: string }> {
  const configured = Served.resolveConfiguredTarget();
  if (!configured) return { ok: false, error: "No model configured" };

  const result = await Served.startServedModel({ model: configured.model, engine: configured.engine });
  if (!result.ok) return { ok: false, error: result.error };
  const model = result.model;
  // 别人已经在拉这个模型：等它出结果，保持「await startServer 就绪」的语义。
  if (model && (model.status === "starting" || model.status === "downloading")) {
    return waitForSettled(model.id);
  }
  return { ok: true };
}

/** 等待一个正在启动的实例出结果（running / error），超时按启动失败处理。 */
async function waitForSettled(id: string, timeoutMs = 180_000): Promise<{ ok: boolean; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const model = Served.getServedModel(id);
    if (!model) return { ok: false, error: "Model server stopped" };
    if (model.status === "running") return { ok: true };
    if (model.status === "error") {
      return { ok: false, error: Served.getServedModelError(id) || model.error || "Failed to start server" };
    }
    if (model.status === "stopped") return { ok: false, error: "Server stopped before becoming ready" };
    await Bun.sleep(500);
  }
  return { ok: false, error: "Timed out waiting for the server to start" };
}

/** 停止活动实例（对话 / 默认端点用的那个）；没有活动实例时退回设置里配置的那个。 */
export async function stopServer(): Promise<void> {
  const activeId = Served.getActiveServedId();
  if (activeId) {
    await Served.stopServedModel(activeId);
    return;
  }
  const configured = Served.resolveConfiguredTarget();
  const id = configured ? Served.servedIdForTarget(configured.model, configured.engine) : null;
  if (id) await Served.stopServedModel(id);
}

/** 重启（换模型后生效）：设置里的目标已经在跑就重启它，否则按设置启动。 */
export async function restartServer(): Promise<{ ok: boolean; error?: string }> {
  const configured = Served.resolveConfiguredTarget();
  if (!configured) return { ok: false, error: "No model configured" };

  const id = Served.servedIdForTarget(configured.model, configured.engine);
  if (id && Served.getServedModel(id)) {
    const result = await Served.restartServedModel(id);
    if (!result.ok) return { ok: false, error: result.error };
    const model = result.model;
    if (model && (model.status === "starting" || model.status === "downloading")) {
      return waitForSettled(model.id);
    }
    return { ok: true };
  }
  return startServer();
}

export function forceKill() {
  Served.forceKillAllServed();
}

/**
 * 本机推理端口上有没有活着的 OpenAI 兼容服务。
 *
 * 用途：区分「应用自己没启动模型」和「端口上本来就有服务（外部 `omi serve` /
 * 自建 llama-server）」—— 后者不需要提示用户去控制台启动，请求照样能发。
 */
export async function probeLocalServer(): Promise<boolean> {
  try {
    const host = getSetting("SERVER_HOST") || "127.0.0.1";
    const port = getActiveServerPort();
    const res = await fetch(`http://${host}:${port}/v1/models`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}
