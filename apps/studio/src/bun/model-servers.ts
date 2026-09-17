import { existsSync, statSync } from "fs";
import { createServer } from "node:net";

import * as Settings from "./db/settings";
import { EMBEDDING_PORT_BASE, ENGINE_PORT_KEYS, engineSupportsEmbeddings } from "../shared/engines";
import { classifyStartupError, type StartupErrorKind } from "../shared/engine-errors";
import { downloadManager, type DownloadTask } from "./download-manager";
import { hasUnfinishedDownload } from "./downloader";
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
import type { ModelPurpose, ServedModelInfo, ServedModelsSnapshot } from "../shared/served-models";
import { logEvent } from "./app-log";

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

/**
 * 嵌入侧活动端口（内存，镜像 settings.ts 的 activePortOverride 形态）：
 * 最近启动的运行中嵌入实例是嵌入后端；不落库、不写任何聊天设置。
 */
let activeEmbeddingPort: number | null = null;

/** 活动实例的端口写回 db/settings 的运行期覆盖：对话 / OCR / 统计等既有消费者自动跟随。 */
function syncActivePort() {
  const active = getActiveServedModel();
  setPortOverride(active ? String(active.port) : null);
  // 按 purpose 分流：聊天端口覆盖只跟活动 chat 实例走（语义不变）；嵌入侧单独跟踪
  // 运行中的嵌入实例 —— 注册表按插入序迭代，最后一个 running 胜出（注意：重启不重排
  // 插入序，先启动后重启的实例不会因此排到后面，与「最近启动」在重启场景有措辞级差异，
  // 但选中的仍是合法嵌入后端，不影响正确性）。
  let latest: ServedModelInfo | undefined;
  for (const entry of entries.values()) {
    if (entry.info.purpose === "embedding" && entry.info.status === "running") latest = entry.info;
  }
  activeEmbeddingPort = latest?.port ?? null;
}

/** 嵌入后端端口：最近启动的运行中嵌入实例；没有则 null。 */
export function getActiveEmbeddingPort(): number | null {
  return activeEmbeddingPort;
}

function emitChangeNow() {
  changeTimer = null;
  syncActivePort();
  // 实例集合 / 状态变了就顺手对一次空闲定时器：它是唯一知道「该不该留着定时器」的地方，
  // 挂在别处（启动、卸载、设置变更）就总要漏掉一条路径。
  syncIdleTimer();
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

// ---------------------------------------------------------------------------
// 空闲卸载（PERF-01）
// ---------------------------------------------------------------------------

/**
 * 「一段时间没人用就把这个模型服务停掉」。
 *
 * 动机是显存：本地模型一加载就占着 VRAM/RAM 不放，用户白天试过三四个模型、
 * 晚上只剩一个在用，另外几个白占着显存。`IMG_MLX_IDLE_MINUTES` 那套在生图
 * worker 上已经跑了很久，这里把同一件事做到推理服务器层。
 *
 * 默认关闭（`SERVER_IDLE_UNLOAD_MINUTES = 0`）：默认打开会把「昨晚还跑着的模型
 * 今天不见了」变成一个用户无法解释的意外。
 *
 * 判据是「最近一次活动」而不是「最近一次启动」。活动有三个来源：
 *   1. 应用内的推理调用（`recordUsage` / `recordUsageEvent` 都会回来打点，
 *      后者是网关那一路的收口 —— 外部 agent 的请求也在这里被看见）；
 *   2. 实例自己的输出有没有变化（引擎每处理一次请求都会打印点什么）；
 *   3. llama.cpp 的 `/slots` 里有没有 `is_processing`（唯一一个精确的「正在忙」信号，
 *      因为只有它有这么个口子）。
 *
 * 这里**没有**在飞请求计数：「一个请求 = 一个可能持续很久的 SSE 流」，要正确计数就得
 * 在每一条流的每一个结束路径（正常结束 / 客户端断开 / 引擎报错）上都减回去，
 * 漏一条就是永久性的"再也不会卸载"。与其放一个读数不准的闸门，不如把局限说清楚 ——
 * 一个超过整个空闲窗口、中间又不打印任何东西的长请求会被误杀，设置页的说明写明了
 * 这一点，窗口默认关着，由用户决定值不值得冒。
 */
const IDLE_MIN_TICK_MS = 5_000;
const IDLE_MAX_TICK_MS = 30_000;

type Activity = {
  lastAt: number;
  /** 上一次看到的输出尾部；变了就说明引擎还在干活（外部客户端的请求只有这个信号）。 */
  lastOutputSig: string;
};

const activity = new Map<string, Activity>();
let idleTimer: ReturnType<typeof setInterval> | null = null;
let idleTimerTick = 0;

function activityOf(id: string): Activity {
  let entry = activity.get(id);
  if (!entry) {
    entry = { lastAt: Date.now(), lastOutputSig: "" };
    activity.set(id, entry);
  }
  return entry;
}

/** 空字符串 / 非法值都当作「关闭」。 */
function idleUnloadMinutes(): number {
  const raw = Number(Settings.getSetting("SERVER_IDLE_UNLOAD_MINUTES"));
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** 日志缓冲会被裁剪到 200k，所以只看长度在长时间运行后会失真 —— 带上尾部一起比。 */
function outputSignature(runtime: Runtime): string {
  const logs = runtime.getLogs();
  return `${logs.length}:${logs.slice(-200)}`;
}

/**
 * 把「某个模型 id 有活动」记到对应实例上。
 *
 * 传进来的通常是请求里的 model id（llama.cpp / vLLM / SGLang 是别名，
 * MLX 是解析后的绝对路径），也就是实例的 `servedName`；认不出来时记到**活动实例**上 ——
 * 宁可多留一个进程，也不要在用户正用着的时候把服务停掉。
 */
export function markServedActivity(modelOrId: string): void {
  const id = resolveActivityTarget(modelOrId);
  if (!id) return;
  const entry = activityOf(id);
  entry.lastAt = Date.now();
}

function resolveActivityTarget(modelOrId: string): string | null {
  const raw = (modelOrId || "").trim();
  if (!raw) return getActiveServedId();
  if (entries.has(raw)) return raw;
  for (const [id, entry] of entries) {
    if (entry.info.servedName === raw) return id;
  }
  for (const [id, entry] of entries) {
    if (entry.info.modelRef === raw || entry.info.label === raw) return id;
  }
  return getActiveServedId();
}

/** 在跑的实例一个都没有时不必留着定时器（CLI 场景下它会拖着进程不退）。 */
function syncIdleTimer() {
  const anyRunning = [...entries.values()].some((entry) => entry.info.status === "running");
  if (!anyRunning || idleUnloadMinutes() <= 0) {
    stopIdleTimer();
    return;
  }
  const windowMs = idleUnloadMinutes() * 60_000;
  const tick = Math.max(IDLE_MIN_TICK_MS, Math.min(IDLE_MAX_TICK_MS, Math.floor(windowMs / 4)));
  // 窗口改了（用户刚把 10 分钟调成 1 分钟）就按新节奏重开，否则要等重启才生效。
  if (idleTimer && idleTimerTick === tick) return;
  stopIdleTimer();
  idleTimer = setInterval(() => {
    void unloadIdleServers();
  }, tick);
  idleTimerTick = tick;
  // 别让这个定时器把进程钉住（CLI / 测试里尤其重要）。
  idleTimer.unref?.();
}

function stopIdleTimer() {
  if (!idleTimer) return;
  clearInterval(idleTimer);
  idleTimer = null;
  idleTimerTick = 0;
}

/** 探测引擎自己是否正在处理请求（只有 llama.cpp 有 /slots 这个口子）。 */
async function engineSaysBusy(entry: Entry): Promise<boolean> {
  if (entry.info.engine !== "llama.cpp") return false;
  try {
    const res = await fetch(`http://127.0.0.1:${entry.info.port}/slots`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false;
    const slots = (await res.json()) as Array<{ is_processing?: boolean }>;
    return Array.isArray(slots) && slots.some((slot) => slot?.is_processing === true);
  } catch {
    // 探不到就当不忙：真正的忙碌还有在飞计数与输出变化两道兜着。
    return false;
  }
}

/**
 * 跑一轮空闲检查，返回被卸载的实例 id（测试与日志用）。
 *
 * `now` 可注入，测试才能在不睡的提前下把时间推到窗口之后。
 */
export async function unloadIdleServers(now = Date.now()): Promise<string[]> {
  const minutes = idleUnloadMinutes();
  if (minutes <= 0) return [];
  const windowMs = minutes * 60_000;
  const unloaded: string[] = [];

  for (const [id, entry] of [...entries]) {
    if (entry.info.status !== "running" || entry.stopping) continue;
    const stat = activityOf(id);
    // 输出变了 = 引擎还在动。这是外部客户端唯一的可见信号，所以它算活动，
    // 和 markServedActivity 走同一条时钟；只推「安静时间」而不管空闲时钟的话，
    // 一个每 9 分钟被打一次的实例会在第 11 分钟被判空闲。
    const sig = outputSignature(entry.runtime);
    if (stat.lastOutputSig === "") {
      // 第一次看到这个实例：只记基线。不然「启动后一直没人用」也要白等一个窗口。
      stat.lastOutputSig = sig;
    } else if (sig !== stat.lastOutputSig) {
      stat.lastOutputSig = sig;
      stat.lastAt = now;
      continue;
    }
    if (now - stat.lastAt < windowMs) continue;
    if (await engineSaysBusy(entry)) continue;

    const idleMinutes = Math.round((now - stat.lastAt) / 60_000);
    logEvent({
      level: "info",
      source: "server",
      event: "served_model.idle_unloaded",
      message: `空闲 ${idleMinutes} 分钟，自动卸载 ${entry.info.label}`,
      detail: { id, engine: entry.info.engine, port: entry.info.port, model: entry.info.modelRef },
    });
    await stopServedModel(id);
    activity.delete(id);
    unloaded.push(id);
  }

  syncIdleTimer();
  return unloaded;
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
 * 网关都默认连这里），被占就顺延找空闲端口。嵌入实例传嵌入端口段基址
 * （EMBEDDING_PORT / 18190），与聊天段互不重叠。
 */
async function allocatePort(
  engine: InferenceEngine,
  host: string,
  preferredPort?: string,
): Promise<{ ok: true; port: number } | { ok: false; error: string }> {
  const preferred = Number(preferredPort || enginePort(engine)) || 8080;
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
  /** 用途（chat / embedding）：决定端口段与是否参与聊天活动状态。 */
  purpose: ModelPurpose;
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
    purpose: params.purpose,
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
  // 嵌入实例不参与聊天 auto-promotion：只跑着一个嵌入模型时，聊天请求绝不能落到它上
  // （llama-server 嵌入模式只认 /v1/embeddings，聊天端点不可用）。
  const models = listServedModels().filter((m) => m.purpose !== "embedding");
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

  // 嵌入实例永不接管聊天活动模型：它只服务 /v1/embeddings，把聊天请求指向它是错的。
  if (entry.info.purpose === "embedding") {
    return { ok: false, error: "Embedding instance cannot be the active chat model" };
  }

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

/**
 * 失败原因与类型一起写。
 *
 * 只有原文的话界面只能照抄一行 `CUDA out of memory`；类型才让界面说得出
 * 「上下文调小或换更小的量化」。写成一个入口是因为这里有四个失败分支
 * （状态回调 / start 返回失败 / start 抛异常 / 后续崩溃），漏掉一个就会出现
 * 「有错误没建议」的实例。
 */
function setServedError(info: ServedModelInfo, message: string) {
  const download = pendingDownloadFor(info);
  if (download) {
    // 这一条**只能**由上下文判定：llama.cpp 对「文件没下完」和「架构不认识」说的是
    // 同一句 `exiting due to model loading error`（实测 Q8_0 下到 3% 时就是这个报错），
    // 光看原文分不出来。而应用自己知道下载队列里还挂着这个文件 —— 那就直说，
    // 否则用户会去查架构、换量化、重下模型，全是白费。
    info.error = `权重还在下载中（${formatDownloadProgress(download)}），现在加载必然失败：${message}`;
    info.errorKind = "download-incomplete";
    return;
  }
  // 队列里没有任务，也可能根本没下完：任务被取消 / 清理之后，磁盘上的半成品还留着
  // （侧车与分片就是证据 —— 见 downloader.hasUnfinishedDownload）。这条判据同样不看作
  // 原文：llama.cpp 对「没下完」和「架构不认识」说的是同一句话，判错就会把用户引去
  // 查架构、换量化，而真正该做的是把这份下完（issue #16 的报告者正是卡在这里）。
  if (hasUnfinishedDownload(info.modelRef)) {
    info.error = `权重没有下完（磁盘上的文件不完整），现在加载必然失败：${message}`;
    info.errorKind = "download-incomplete";
    return;
  }
  info.error = message;
  info.errorKind = classifyStartupError(message);
}

/** 正在下载 / 排队 / 暂停的任务里有没有这个模型（按文件名匹配，跨进程重启也认）。 */
function pendingDownloadFor(info: ServedModelInfo): DownloadTask | null {
  const fileName = info.modelRef.split(/[\\/]/).pop() ?? "";
  if (!fileName) return null;
  try {
    return (
      downloadManager.list().find(
        (task) =>
          task.fileName === fileName &&
          (task.status === "queued" || task.status === "downloading" || task.status === "paused"),
      ) ?? null
    );
  } catch {
    // 下载队列读不出来（设置表异常）不该把启动失败的记录也弄丢：按原文分类即可。
    return null;
  }
}

function formatDownloadProgress(task: DownloadTask): string {
  if (task.percent != null && Number.isFinite(task.percent)) return `${Math.floor(task.percent)}%`;
  if (task.total) return `${Math.floor((task.received / task.total) * 100)}%`;
  return "进度未知";
}

function clearServedError(info: ServedModelInfo) {
  info.error = undefined;
  info.errorKind = undefined;
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
        clearServedError(entry.info);
      }
      if (status === "error") {
        const message = runtime.getLastError() || "Server failed to start";
        setServedError(entry.info, message);
        // 启动之后才挂掉的（OOM / 权重损坏 / 端口被抢）走这条：
        // 此时日志缓冲里最后一屏就是根因，先记下错误行本身。
        // 记的是 `info.error`（可能被上下文补过一句结论，比如"权重还在下载中"）——
        // 日志与界面说同一句话，排查的人不必再自己推一遍；原文留在 detail.raw。
        logEvent({
          level: "error",
          source: "server",
          event: "served_model.crashed",
          message: entry.info.error ?? message,
          detail: {
            raw: message,
            id: info.id,

            engine: info.engine,
            port: info.port,
            model: info.modelRef,
            kind: entry.info.errorKind,
          },
        });
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
      // 嵌入实例永不接管聊天活动状态（即使调用方显式 makeActive）。
      if (params.makeActive && existing.info.purpose !== "embedding") setActiveServedId(id);
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
  // 模型库 meta 的 category 决定用途：embedding 类别 → 嵌入模式（专属端口段 + --embeddings，
  // 且永不接管聊天活动状态）；其余按 chat 处理（行为与今日完全一致）。
  const installed = listInstalledModels().find(
    (m) => m.runtimeTarget === target || m.path === target,
  );
  const purpose: ModelPurpose = installed?.category === "embedding" ? "embedding" : "chat";
  // 引擎能力守卫：当前只有 llama.cpp 用 --embeddings 支持嵌入服务。放行其他引擎的
  // embedding 类别模型会在嵌入端口段起一个「没有 /v1/embeddings 的实例」—— KB 选择器
  // 与网关又将呈现「列得出、调不通」，正是本次要消灭的陷阱在别家引擎上的复刻。
  if (purpose === "embedding" && !engineSupportsEmbeddings(engine)) {
    return {
      ok: false,
      error: `${engine} 引擎暂不支持嵌入服务（当前仅 llama.cpp 支持）；请把模型类别改回 chat，或换用 llama.cpp 引擎`,
    };
  }

  // 嵌入实例从嵌入端口段分配（EMBEDDING_PORT 基址 18190 顺延），与聊天 18080 段互不重叠。
  const allocation = await allocatePort(engine, host, purpose === "embedding"
    ? (Settings.getSetting("EMBEDDING_PORT") || String(EMBEDDING_PORT_BASE))
    : undefined);
  if (!allocation.ok) return { ok: false, error: allocation.error };
  const port = allocation.port;

  const servedName = servedNameFor(target, engine);
  const info = buildInfo({
    id,
    modelRef: target,
    // 展示名不是请求 id：MLX 的 servedName 是绝对路径，拿到界面上就是「模型名是一串路径」。
    label: params.label ?? modelNameFromRef(servedName, servedName),
    engine,
    port,
    servedName,
    purpose,
    isDir,
    repo: installed?.repo,
    sizeBytes: modelSizeOf(target),
    usesDefaultPort: String(port) === (purpose === "embedding"
      ? (Settings.getSetting("EMBEDDING_PORT") || String(EMBEDDING_PORT_BASE))
      : enginePort(engine)),
  });

  const runtime = createRuntime(engine, {
    model: target,
    port: String(port),
    servedName,
    purpose,
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
  // 以启动时刻作为空闲计时的起点：从没被用过的实例也要能在窗口之后被卸载。
  markServedActivity(id);
  emitChange();

  try {
    const result = await runtime.start();
    info.pid = runtime.getPid();
    if (!result.ok) {
      info.status = "error";
      const message = result.error || "Failed to start server";
      setServedError(info, message);
      logEvent({
        level: "error",
        source: "server",
        event: "served_model.start.failed",
        message: info.error ?? message,
        detail: {
          raw: message,
          id,
          engine,
          port: info.port,
          model: info.modelRef,
          trigger: "startServedModel",
          kind: info.errorKind,
        },
      });
      emitChangeNow();
      return { ok: false, error: info.error, model: getServedModel(id) };
    }
  } catch (e) {
    info.status = "error";
    const message = e instanceof Error ? e.message : String(e);
    setServedError(info, message);
    logEvent({
      level: "error",
      source: "server",
      event: "served_model.start.threw",
      message,
      detail: { id, engine, port: info.port, model: info.modelRef, error: e, kind: info.errorKind },
    });
    emitChangeNow();
    return { ok: false, error: info.error, model: getServedModel(id) };
  }

  info.status = runtime.getStatus();
  info.pid = runtime.getPid();
  if (info.status === "running") info.startedAt = info.startedAt ?? Date.now();
  // makeActive 默认 true，但嵌入实例例外：永不写 SERVED_ACTIVE_ID / CHAT_MODEL 等聊天设置。
  if (params.makeActive !== false && info.purpose !== "embedding") setActiveServedId(id);
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

/**
 * 运行中的嵌入服务后端（网关 / KB / 嵌入客户端消费）。
 *
 * 返回最近启动的运行中嵌入实例的 base（不带 /v1）；没有运行中的嵌入实例则 null。
 * 网关拿到 null 时返回 503 引导，KB 拿到 null 时走各自的回退链。
 */
export function resolveEmbeddingBackend(): string | null {
  if (activeEmbeddingPort == null) return null;
  const host = Settings.getSetting("SERVER_HOST") || "127.0.0.1";
  return `http://${host}:${activeEmbeddingPort}`;
}

export function getServedModelLogs(id: string): string {
  return entries.get(id)?.runtime.getLogs() ?? "";
}

export function getServedModelError(id: string): string {
  const entry = entries.get(id);
  if (!entry) return "";
  return entry.info.error ?? entry.runtime.getLastError();
}

/**
 * 条目上记的失败类型（没有错误时为 undefined）。
 *
 * 回退链靠它决定「换一个模型有没有用」：条目上没记过（比如等启动结果超时，
 * 错误是调用方临时拼的）就现算一次，规则表是同一张。
 */
export function getServedModelErrorKind(id: string): StartupErrorKind | undefined {
  const error = getServedModelError(id);
  return error ? classifyStartupError(error) : undefined;
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
