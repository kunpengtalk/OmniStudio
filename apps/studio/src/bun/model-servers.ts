import { existsSync, statSync } from "fs";
import { createServer } from "node:net";

import * as Settings from "./db/settings";
import { ENGINE_PORT_KEYS } from "../shared/engines";
import { getModelProfile } from "../shared/model-profiles";
import { dirModelKind, modelNameForPath, resolveRuntimeTarget } from "./model-scan";
import { listInstalledModels, servedNameForModelPath, slugModelFileName } from "./model-store";
import { createRuntime, type InferenceEngine, type Runtime, type ServerStatus } from "./runtimes";
import { mlxRequestModelId } from "./runtimes/mlx";
import {
  engineForModelKind,
  engineSupports,
  fileKind,
  modelNameFromRef,
  resolveEngineForModel,
  type ModelFileKind,
} from "../shared/modelscope";
import type { ServedModelInfo, ServedModelsSnapshot } from "../shared/served-models";

export type { ServedModelInfo, ServedModelsSnapshot } from "../shared/served-models";

/**
 * 已启动模型注册表 —— 「同时启动多个模型」的唯一真源。
 *
 * 每个条目持有自己的 runtime 实例（= 一个服务器进程 + 一个端口），所以
 * 开关某个模型不会牵动别的模型；设置里的 `INFERENCE_ENGINE` / `LOCAL_MODEL_PATH`
 * 只表示「谁接默认端点」（`SERVED_ACTIVE_ID`），不再是"正在跑的那个"。
 *
 * 兼容层在 `server-manager.ts`：旧的 startServer/stopServer/getStatus 都落到
 * 「活动模型」这一个条目上，CLI、OCR、网关、统计等既有调用方不用改。
 */

type Entry = {
  info: ServedModelInfo;
  runtime: Runtime;
  /** 启动时用的参数（重启时原样复用，端口除外 —— 端口由分配器决定）。 */
  params: StartParams;
  cleanups: Array<() => void>;
  /** 显式停止中：状态回调不要把它当成"自己挂了"提前摘掉。 */
  stopping: boolean;
};

export type StartParams = {
  /** 本地文件 / 仓库目录 / HF repo id。 */
  model: string;
  /** 指定引擎；不传时按模型格式挑（GGUF → llama.cpp，safetensors → 当前/vLLM）。 */
  engine?: InferenceEngine;
  /** 启动后设为当前模型（本地模式请求 + 既有设置键都指向它）。 */
  makeActive?: boolean;
  /** 展示名覆盖（默认取服务名）。 */
  label?: string;
};

export type StartServedResult = {
  ok: boolean;
  error?: string;
  model?: ServedModelInfo;
};

const entries = new Map<string, Entry>();

/**
 * 正在分配中的端口。两个模型几乎同时启动时（并发 RPC / 双击启动）各自探测到的
 * "空闲端口"可能是同一个 —— 先占坑再看进程是否真的能绑上，避免抢端口。
 */
const reservedPorts = new Set<number>();

const changeListeners = new Set<(snapshot: ServedModelsSnapshot) => void>();
const logListeners = new Set<(id: string, text: string) => void>();

/** 状态批量推送：启动过程会连着变几次（starting → downloading → running）。 */
const CHANGE_THROTTLE_MS = 100;
let changeTimer: ReturnType<typeof setTimeout> | null = null;

/** 活动实例的端口写回 db/settings 的运行期覆盖：对话 / 嵌入 / OCR / 统计等既有消费者自动跟随。 */
function syncActivePort() {
  const active = getActiveServedModel();
  setPortOverride(active ? String(active.port) : null);
}

function emitChangeNow() {
  changeTimer = null;
  syncActivePort();
  const snapshot = getServedModels();
  for (const cb of changeListeners) {
    try {
      cb(snapshot);
    } catch {
      // 监听方（RPC 推送）自己出错不能拖垮注册表
    }
  }
}

function emitChange() {
  if (changeTimer !== null) return;
  changeTimer = setTimeout(emitChangeNow, CHANGE_THROTTLE_MS);
}

export function onServedModelsChange(cb: (snapshot: ServedModelsSnapshot) => void): () => void {
  changeListeners.add(cb);
  return () => {
    changeListeners.delete(cb);
  };
}

export function onServedModelLog(cb: (id: string, text: string) => void): () => void {
  logListeners.add(cb);
  return () => {
    logListeners.delete(cb);
  };
}

/** 稳定 id：引擎 + 加载目标。同一模型换个引擎算另一个实例，避免端口/参数打架。 */
function servedId(engine: InferenceEngine, modelRef: string): string {
  return `${engine}:${modelRef}`;
}

/**
 * 某个模型目标（未归一化的路径 / repo id）会落到哪个实例 id 上。
 * UI / 兼容层用它把「设置里选中的模型」对到一个已有实例。
 */
export function servedIdForTarget(model: string, engine?: InferenceEngine): string | null {
  const raw = (model || "").trim();
  if (!raw) return null;
  const target = isLocalTarget(raw) ? resolveRuntimeTarget(raw) : raw;
  return servedId(resolveTargetEngine(target, engine), target);
}

/** 目标是不是一个真实存在的本地路径（不是就当成 HF repo id）。 */
function isLocalTarget(target: string): boolean {
  try {
    return existsSync(target);
  } catch {
    return false;
  }
}

function targetKind(target: string): { isDir: boolean; kind: ModelFileKind } {
  if (!isLocalTarget(target)) return { isDir: false, kind: "other" };
  let isDir = false;
  try {
    isDir = statSync(target).isDirectory();
  } catch {
    // 不可读时按文件处理，交给 runtime 报错
  }
  return {
    isDir,
    kind: isDir ? dirModelKind(target) : fileKind(modelNameForPath(target)),
  };
}

/**
 * 该用哪个引擎加载这个目标：显式指定 > 当前引擎能加载就用当前引擎 >
 * 按格式挑（GGUF → llama.cpp，safetensors → vLLM）。
 */
function resolveTargetEngine(target: string, preferred?: InferenceEngine): InferenceEngine {
  const current = (Settings.getSetting("INFERENCE_ENGINE") as InferenceEngine) || "llama.cpp";
  const wanted = preferred ?? current;
  const { isDir, kind } = targetKind(target);
  if (engineSupports(wanted, kind)) return wanted;
  if (isDir) return engineForModelKind(kind) ?? resolveEngineForModel("model.safetensors", wanted);
  return resolveEngineForModel(modelNameForPath(target), wanted);
}

/** 请求侧该填的 model id：MLX 认绝对路径，其余引擎认服务名 slug。 */
function servedNameFor(target: string, engine: InferenceEngine): string {
  if (engine === "mlx") return mlxRequestModelId(target);
  if (isLocalTarget(target)) return servedNameForModelPath(target);
  const tail = target.split("/").filter(Boolean).pop() ?? target;
  return slugModelFileName(tail);
}

/** 该引擎的设置端口（`getServerPort` 的等价实现，避免依赖可能被单测裁剪的导出）。 */
function enginePort(engine: InferenceEngine): string {
  return Settings.getSetting?.(ENGINE_PORT_KEYS[engine] as never) || "8080";
}

/** 活动实例端口写回设置模块（部分测试 mock 没有这个导出，缺了就跳过）。 */
function setPortOverride(port: string | null) {
  Settings.setActiveServerPortOverride?.(port);
}

/** 端口是否被占用（试绑定一次，比探测连接可靠：没监听的端口也算空闲）。 */
function portInUse(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(true));
    probe.once("listening", () => {
      probe.close(() => resolve(false));
    });
    // 只探测本地监听：推理服务器都绑 127.0.0.1 或 0.0.0.0，绑 localhost 都能覆盖。
    probe.listen(port, host === "0.0.0.0" ? "127.0.0.1" : host);
  });
}

function takenPorts(): Set<number> {
  const taken = new Set<number>(reservedPorts);
  for (const entry of entries.values()) {
    if (entry.info.status !== "stopped") taken.add(entry.info.port);
  }
  return taken;
}

/**
 * 分配端口：优先该引擎的设置端口（第一个启动的模型占住它，`omi` / 外部集成 /
 * 网关都默认连这里），被占就顺延找空闲端口。
 */
async function allocatePort(
  engine: InferenceEngine,
  host: string,
): Promise<{ ok: true; port: number } | { ok: false; error: string }> {
  const preferred = Number(enginePort(engine)) || 8080;
  const taken = takenPorts();
  for (let port = preferred; port < preferred + 100 && port < 65536; port++) {
    if (taken.has(port)) continue;
    if (await portInUse(port, host)) continue;
    reservedPorts.add(port);
    return { ok: true, port };
  }
  return { ok: false, error: `No free port near ${preferred} (tried 100 ports)` };
}

function modelSizeOf(target: string): number | undefined {
  const found = listInstalledModels().find(
    (m) => m.runtimeTarget === target || m.path === target,
  );
  return found?.size;
}

function buildInfo(params: {
  id: string;
  modelRef: string;
  label: string;
  engine: InferenceEngine;
  port: number;
  servedName: string;
  isDir: boolean;
  repo?: string;
  sizeBytes?: number;
  usesDefaultPort: boolean;
}): ServedModelInfo {
  const host = Settings.getSetting("SERVER_HOST") || "127.0.0.1";
  return {
    id: params.id,
    modelRef: params.modelRef,
    label: params.label,
    engine: params.engine,
    port: params.port,
    endpoint: `http://${host}:${params.port}/v1`,
    servedName: params.servedName,
    status: "stopped",
    usesDefaultPort: params.usesDefaultPort,
    isActive: Settings.getSetting("SERVED_ACTIVE_ID") === params.id,
    isDir: params.isDir,
    repo: params.repo,
    sizeBytes: params.sizeBytes,
  };
}

/** 已启动模型列表（快照，按启动顺序：先来的在前）。 */
export function getServedModels(): ServedModelsSnapshot {
  const activeId = Settings.getSetting("SERVED_ACTIVE_ID") || null;
  const models = [...entries.values()].map((e) => ({
    ...e.info,
    isActive: e.info.id === activeId,
  }));
  return { models, activeId: entries.has(activeId ?? "") ? activeId : null };
}

export function listServedModels(): ServedModelInfo[] {
  return getServedModels().models;
}

export function getServedModel(id: string): ServedModelInfo | undefined {
  return listServedModels().find((m) => m.id === id);
}

export function getActiveServedId(): string | null {
  return getServedModels().activeId;
}

export function getActiveServedModel(): ServedModelInfo | undefined {
  const id = getActiveServedId();
  return id ? getServedModel(id) : undefined;
}

/**
 * 请求侧该用哪个实例：有活动实例就用它；没有而恰好只有一个在跑时把它设为活动
 * （用户只启了一个模型，卸载别的 / 重启之后没必要再手动指一次）。
 */
export function getRequestTargetServedModel(): ServedModelInfo | undefined {
  const active = getActiveServedModel();
  if (active) return active;
  const models = listServedModels();
  const only = models.length === 1 ? models[0] : undefined;
  if (!only) return undefined;
  setActiveServedId(only.id);
  return getServedModel(only.id);
}

/**
 * 设为当前模型：本地模式的请求、统计、网关 / OCR / 嵌入等既有消费者
 * 都跟着它走（同步写回 LOCAL_MODEL_PATH / LOCAL_MODEL_NAME / CHAT_MODEL）。
 */
export function setActiveServedId(id: string): { ok: boolean; error?: string } {
  const entry = entries.get(id);
  if (!entry) return { ok: false, error: "Model server not found" };

  const { info } = entry;
  const updates: Record<string, string> = {
    SERVED_ACTIVE_ID: id,
    SERVER_MODE: "local",
    INFERENCE_ENGINE: info.engine,
  };
  if (isLocalTarget(info.modelRef)) {
    updates.LOCAL_MODEL_PATH = info.modelRef;
    // LOCAL_MODEL_NAME 是**服务名**（llama.cpp / vLLM 拿它当 --alias，界面拿它当模型名），
    // 所以写展示名而不是 MLX 那种路径型的请求 id；请求 id 单独由 CHAT_MODEL 兜底。
    updates.LOCAL_MODEL_NAME = info.label;
    // MLX 的 `MLX_MODEL`（部署预设）优先级高于 LOCAL_MODEL_PATH，用户明确选了本地
    // 目录模型时必须清掉它，否则下一次按设置启动又会加载那个预设（与 setActiveModel 同）。
    if (info.engine === "mlx") updates.MLX_MODEL = "";
  } else {
    // HF repo id（含 MLX 部署模型）：没有本地文件，LOCAL_MODEL_PATH 清掉免得指向旧模型。
    updates.LOCAL_MODEL_PATH = "";
    if (info.engine === "mlx") updates.MLX_MODEL = info.modelRef;
  }
  updates.CHAT_MODEL = info.servedName;
  // 外部工具（`omi launch` / Claude Code 集成 / 网关本地上游）读 INFERENCE_ENGINE
  // + 该引擎的端口，切换活动模型时一并同步，否则它们会连到别的引擎上去。
  Settings.updateSettings(updates);
  syncActivePort();

  emitChange();
  return { ok: true };
}

/** 活动模型被卸载后，设置里的指向清掉（宁可空着，也不要指向不存在的实例）。 */
function clearActiveIf(id: string) {
  if (Settings.getSetting("SERVED_ACTIVE_ID") === id) Settings.updateSettings({ SERVED_ACTIVE_ID: "" });
}

function attachListeners(entry: Entry) {
  const { info, runtime } = entry;

  entry.cleanups.push(
    runtime.onLog((text) => {
      for (const cb of logListeners) {
        try {
          cb(info.id, text);
        } catch {
          // 忽略推送方异常
        }
      }
    }),
  );

  entry.cleanups.push(
    runtime.onStatusChange((status: ServerStatus) => {
      info.status = status;
      info.pid = runtime.getPid();
      if (status === "running") {
        entry.info.startedAt = Date.now();
        entry.info.error = undefined;
      }
      if (status === "error") {
        entry.info.error = runtime.getLastError() || "Server failed to start";
      }
      // 自己退出（进程挂了 / 被外部杀掉）：条目留着让 UI 显示原因；
      // 正常停止由 stopServedModel 负责摘除，这里不能抢先删。
      if (status === "stopped" && !entry.stopping) {
        entries.delete(info.id);
        clearActiveIf(info.id);
      }
      emitChange();
    }),
  );
}

function disposeEntry(entry: Entry) {
  for (const cleanup of entry.cleanups) {
    try {
      cleanup();
    } catch {
      // 忽略
    }
  }
  entry.cleanups = [];
}

/**
 * 启动一个本地模型服务实例。
 *
 * 同一模型（同引擎 + 同目标）重复启动是幂等的：正在跑就直接返回它，
 * 上次失败（error）则清掉重来。
 */
export async function startServedModel(params: StartParams): Promise<StartServedResult> {
  const raw = (params.model || "").trim();
  if (!raw) return { ok: false, error: "Model not specified" };

  // 仓库目录 / 分批 GGUF 要先归一化成运行时真正加载的目标（与 setActiveModel 一致）。
  const target = isLocalTarget(raw) ? resolveRuntimeTarget(raw) : raw;
  const engine = resolveTargetEngine(target, params.engine);
  const id = servedId(engine, target);
  const existing = entries.get(id);
  if (existing) {
    if (existing.info.status === "running") {
      if (params.makeActive) setActiveServedId(id);
      return { ok: true, model: getServedModel(id) };
    }
    if (existing.info.status === "starting" || existing.info.status === "downloading") {
      return { ok: true, model: getServedModel(id) };
    }
    // 上次启动失败：清掉重来
    disposeEntry(existing);
    entries.delete(id);
  }

  const { isDir } = targetKind(target);
  if (!isLocalTarget(target) && !target.includes("/")) {
    return { ok: false, error: `Model not found: ${target}` };
  }

  const host = Settings.getSetting("SERVER_HOST") || "127.0.0.1";
  const allocation = await allocatePort(engine, host);
  if (!allocation.ok) return { ok: false, error: allocation.error };
  const port = allocation.port;

  const servedName = servedNameFor(target, engine);
  const installed = listInstalledModels().find(
    (m) => m.runtimeTarget === target || m.path === target,
  );
  const info = buildInfo({
    id,
    modelRef: target,
    // 展示名不是请求 id：MLX 的 servedName 是绝对路径，拿到界面上就是「模型名是一串路径」。
    label: params.label ?? modelNameFromRef(servedName, servedName),
    engine,
    port,
    servedName,
    isDir,
    repo: installed?.repo,
    sizeBytes: modelSizeOf(target),
    usesDefaultPort: String(port) === enginePort(engine),
  });

  const runtime = createRuntime(engine, {
    model: target,
    port: String(port),
    servedName,
  });
  const entry: Entry = {
    info,
    runtime,
    params: { ...params, engine },
    cleanups: [],
    stopping: false,
  };
  entries.set(id, entry);
  reservedPorts.delete(port);
  attachListeners(entry);
  emitChange();

  try {
    const result = await runtime.start();
    info.pid = runtime.getPid();
    if (!result.ok) {
      info.status = "error";
      info.error = result.error || "Failed to start server";
      emitChangeNow();
      return { ok: false, error: info.error, model: getServedModel(id) };
    }
  } catch (e) {
    info.status = "error";
    info.error = e instanceof Error ? e.message : String(e);
    emitChangeNow();
    return { ok: false, error: info.error, model: getServedModel(id) };
  }

  info.status = runtime.getStatus();
  info.pid = runtime.getPid();
  if (info.status === "running") info.startedAt = info.startedAt ?? Date.now();
  if (params.makeActive !== false) setActiveServedId(id);
  emitChangeNow();
  return { ok: true, model: getServedModel(id) };
}

/**
 * 停止并卸载一个模型服务：进程按进程组杀掉（SIGTERM → SIGKILL），
 * 条目从列表里消失（= UI 上那个「卸载」按钮）。
 */
export async function stopServedModel(id: string): Promise<{ ok: boolean; error?: string }> {
  const entry = entries.get(id);
  if (!entry) return { ok: true };

  entry.stopping = true;
  try {
    await entry.runtime.stop();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    disposeEntry(entry);
    entries.delete(id);
    clearActiveIf(id);
    syncActivePort();
    emitChangeNow();
  }
  return { ok: true };
}

/** 重启一个模型（同一个目标、重新分配端口；参数沿用启动时那份）。 */
export async function restartServedModel(id: string): Promise<StartServedResult> {
  const entry = entries.get(id);
  if (!entry) return { ok: false, error: "Model server not found" };
  const params = entry.params;
  await stopServedModel(id);
  return startServedModel(params);
}

/**
 * 关停全部实例（退出应用 / SIGTERM）：逐个 stop，失败的强制杀进程组。
 * 推理进程是 detached 的，少了这一步就会留下占显存的孤儿进程。
 */
export async function stopAllServed(): Promise<void> {
  const ids = [...entries.keys()];
  await Promise.all(
    ids.map(async (id) => {
      try {
        await stopServedModel(id);
      } catch {
        // 下面统一兜底
      }
    }),
  );
  forceKillAllServed();
}

/** 进程组级强杀，同步返回（用于退出时最后的安全网）。 */
export function forceKillAllServed(): void {
  for (const entry of entries.values()) {
    try {
      entry.runtime.forceKill();
    } catch {
      // 已经死了
    }
    disposeEntry(entry);
  }
  entries.clear();
  reservedPorts.clear();
  Settings.updateSettings({ SERVED_ACTIVE_ID: "" });
  emitChangeNow();
}

export function getServedModelLogs(id: string): string {
  return entries.get(id)?.runtime.getLogs() ?? "";
}

export function getServedModelError(id: string): string {
  const entry = entries.get(id);
  if (!entry) return "";
  return entry.info.error ?? entry.runtime.getLastError();
}

export function clearServedModelLogs(id: string): void {
  entries.get(id)?.runtime.clearLogs();
}

/** 该模型的启动命令（命令预览 / 复制用；不会起进程）。 */
export function buildServedCommandLine(id: string): string {
  const entry = entries.get(id);
  if (!entry) return "";
  return entry.runtime.buildCommandLine(entry.info.modelRef);
}

/**
 * 设置里配置的「要加载什么」——`startServer`（CLI / 安装向导 / 模型页 / OCR 面板）
 * 用它决定启动哪个模型。
 *
 * 只读设置、不看活动实例：调用方通常刚改过 `LOCAL_MODEL_PATH` / `MLX_MODEL`，
 * 若这里优先返回活动实例，就会出现「选了模型 A，启动的却是还在跑的 B」。
 */
export function resolveConfiguredTarget(): { model: string; engine?: InferenceEngine } | null {
  const engine = (Settings.getSetting("INFERENCE_ENGINE") as InferenceEngine) || "llama.cpp";
  if (engine === "mlx") {
    const mlxModel = (Settings.getSetting("MLX_MODEL") || "").trim();
    if (mlxModel) return { model: mlxModel, engine };
  }
  const localPath = Settings.getSetting("LOCAL_MODEL_PATH");
  if (localPath) return { model: localPath, engine };
  const chatModel = (Settings.getSetting("CHAT_MODEL") || "").trim();
  if (chatModel) return { model: chatModel, engine };
  const customHf = Settings.getSetting("CUSTOM_HF_MODEL");
  if (customHf) return { model: customHf.split(":")[0] ?? customHf, engine };
  // 内置 profile（llama.cpp 的 `-hf` 路径）：老逻辑里没有本地文件时回落到它。
  const profile = getModelProfile(Settings.getSetting("VLLM_MODEL_PROFILE"));
  if (profile?.hfModel) return { model: profile.hfModel, engine };
  return null;
}
