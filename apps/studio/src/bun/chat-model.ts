import { existsSync } from "fs";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

import { getSetting, updateSettings, getActiveServerPort } from "./db/settings";
import { getModelProfile } from "../shared/model-profiles";
import {
  classifyModelName,
  engineSupports,
  fileKind,
  filterModelIds,
  isChatModelCategory,
  MODEL_CATEGORY_SETS,
  modelNameFromRef,
  resolveEngineForKind,
  type InferenceEngine,
  type ModelCategory,
} from "../shared/modelscope";
import * as ModelStore from "./model-store";
import * as Served from "./model-servers";
import { activateCloudProvider, activeProviderId, listCloudProviders } from "./cloud-providers";
import { isMlxActive, resolveMlxModel } from "./runtimes/mlx";

/**
 * 对话模型的两个约定：
 *
 * 1. **对话框里只列已经启动的模型**（`state` 为 running / starting 的条目）。
 *    启动 / 卸载是控制台（设置 → 控制台）的事 —— 在下拉框里挑一下就触发一次冷启动、
 *    进度还塞不进那个小框里，体验很差。所以这里标出每个条目的状态，
 *    对话 / Agent / 翻译的选择器只显示已启动的，「默认模型」/ 集成选择器仍可先配后用。
 * 2. **云端只列已配置厂商的模型**。没填 API Key 的厂商连不上，列出来只会误导。
 */

/**
 * Resolve the active chat model name.
 * Local models always use the canonical served name (slug) so it matches the
 * server's --alias / --served-model-name; HF references and the remote model
 * id act as fallbacks when no local file is configured.
 */
export function getChatModelName(): string {
  // 已启动实例的服务名就是服务器认的 id（含 MLX 的绝对路径），优先用它。
  const active = Served.getRequestTargetServedModel();
  if (active) return active.servedName;

  const chatModel = getSetting("CHAT_MODEL");
  if (chatModel) return chatModel;

  const isLocal = getSetting("SERVER_MODE") === "local";
  if (isLocal) {
    const localName = getSetting("LOCAL_MODEL_NAME");
    if (localName) return localName.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");

    // MLX 引擎：部署的 HF repo id 即服务名（mlx_lm.server 的 --model 原样作为模型 id）。
    const engine = getSetting("INFERENCE_ENGINE");
    if (engine === "mlx") {
      const mlxModel = getSetting("MLX_MODEL");
      if (mlxModel) return mlxModel;
    }

    const customHf = getSetting("CUSTOM_HF_MODEL");
    if (customHf) return customHf.split(":")[0] ?? customHf;

    const profileId = getSetting("VLLM_MODEL_PROFILE");
    const profile = getModelProfile(profileId);
    return profile?.hfModel || "";
  }

  return getSetting("VLLM_MODEL_NAME") || "";
}

/**
 * 发往**本地推理服务器**的请求里该填的模型 id（调用方已经确定要走本地）。
 *
 * 大多数引擎都带 `--alias` / `--served-model-name`（llama.cpp / vLLM / SGLang），
 * 服务名 slug 就是它们认的 id；MLX 没有这个机制 —— mlx_lm.server 对本地目录暴露的
 * id 是解析后的绝对路径，填 slug 会被它当成 HF repo id 去下载，请求就永远没有响应
 * （见 `resolveMlxModel`）。展示 / 记录仍用 `getChatModelName()`，别把路径写进历史。
 */
export function getLocalRequestModelId(): string {
  // 活动实例的 servedName 由注册表按同一套约定算好（MLX 下就是绝对路径）。
  const active = Served.getRequestTargetServedModel();
  if (active) return active.servedName;

  const name = getChatModelName();
  if (!isMlxActive()) return name;
  // MLX 下即便服务名是空的（云端模式残留 / 只配了本地目录），也要给出它认的 id
  return resolveMlxModel().requestModelId || name;
}

/**
 * 展示 / 记录用的模型名（会话标题、用量统计、通话详情、日志…）。
 *
 * 与 `getChatModelName()` 的区别只在 MLX：那条路径上的请求 id 是绝对路径，
 * 直接拿去显示就会出现「模型名是一串 /Users/…」。请求该填什么仍由
 * `getLocalRequestModelId()` / `getChatRequestModelId()` 决定，这里只管显示。
 */
export function getChatModelLabel(): string {
  const active = Served.getRequestTargetServedModel();
  if (active) return active.label || modelNameFromRef(active.servedName, active.modelRef);
  return modelNameFromRef(getChatModelName());
}

/** 按当前模式（本地推理服务器 / 云端 API）该填的请求模型 id。 */
export function getChatRequestModelId(): string {
  if (getSetting("SERVER_MODE") === "local") return getLocalRequestModelId();
  return getChatModelName();
}

export function getChatModel(): LanguageModel {
  const isLocal = getSetting("SERVER_MODE") === "local";

  if (isLocal) {
    // 活动实例的端口（同引擎多实例时未必是引擎的设置端口，见 getActiveServerPort）。
    const port = getActiveServerPort();
    const provider = createOpenAICompatible({
      name: "omni-studio",
      baseURL: `http://localhost:${port}/v1`,
    });
    return provider.languageModel(getChatModelName());
  }

  const apiKey = getSetting("VLLM_API_KEY");
  const provider = createOpenAICompatible({
    name: "omni-studio",
    baseURL: getSetting("VLLM_API_BASE"),
    apiKey: apiKey === "EMPTY" ? undefined : apiKey,
  });
  return provider.languageModel(getChatModelName());
}

/**
 * 对话模型选项。
 * - local：本地模型条目。**已启动**的条目 value = 实例 id 且带 `state` / `endpoint`；
 *   没启动的条目 value = 模型路径、`state: "stopped"`（选项里保留，好让「默认模型」/
 *   集成选择器仍能先配后用；对话 / Agent 的选择器只显示已启动的）。
 * - api：已配置厂商的模型（value = 模型 id）。
 */
export type ChatModelOption = {
  type: "local" | "api";
  /** local：已启动实例 id（启动过）或模型路径（未启动）；api：模型 ID */
  value: string;
  /** 展示用的模型名：本地为服务名（slug），api 为模型 ID */
  label: string;
  detail?: string;
  isActive: boolean;
  /** 本地模型用的推理引擎（api 选项无此字段） */
  engine?: InferenceEngine;
  /** 本地仓库目录条目（vLLM / SGLang / MLX 加载整个目录）：UI 上标成文件夹。 */
  isDir?: boolean;
  /** 模型分类（界面据此打标；对话列表里只会出现 chat / other）。 */
  category: ModelCategory;
  /**
   * 本地条目当前状态：已启动实例取实例状态，未启动是 stopped。
   * 对话选择器据此过滤 —— 没启动的模型不该出现在对话框里。
   */
  state: Served.ServedModelInfo["status"];
  /** 本地：实例端点（含 /v1）。 */
  endpoint?: string;
  /** api：服务商 id 与展示名（选中时若是别的厂商会一并切过去）。 */
  providerId?: string;
  providerName?: string;
};

/**
 * 对话 / Agent 能用的模型：文本对话与 VLM。TTS / ASR / 生图 / 生视频 / 嵌入 /
 * 重排都不进对话列表 —— 云端服务商的 /v1/models 往往把所有类别的模型一起返回，
 * 整份塞进选择器就会出现「对话模型」里混着 embedding、whisper 的情况。
 */
function isChatCategory(category: ModelCategory): boolean {
  return isChatModelCategory(category);
}

/** 从配置的 OpenAI 兼容服务拉取 /v1/models 列表（失败时返回空数组）。 */
async function fetchApiModels(): Promise<string[]> {
  const base = (getSetting("VLLM_API_BASE") || "").trim().replace(/\/+$/, "");
  if (!base) return [];
  const apiKey = getSetting("VLLM_API_KEY");
  const url = /\/v1$/i.test(base) ? `${base}/models` : `${base}/v1/models`;
  try {
    const res = await fetch(url, {
      headers: apiKey && apiKey !== "EMPTY" ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const json = (await res.json().catch(() => null)) as { data?: { id?: string }[] } | null;
    return (json?.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

/** 已配置的云服务商：有地址且填了 Key（或者就是当前激活的那个，本地兼容端点常不带 Key）。 */
function enabledCloudProviders(activeProvider: string | null) {
  return listCloudProviders().providers.filter((p) => {
    if ((p.baseUrl || "").trim() === "") return false;
    if (p.id === activeProvider) return true;
    const key = (p.apiKey || "").trim();
    return key !== "" && key !== "EMPTY";
  });
}

/**
 * 列出对话可选模型。
 *
 * 本地：已安装的对话模型（整仓库按目录聚成一条）+ 已启动实例的实时状态。
 * 已启动的条目用**实例 id** 作 value 并带上端口 / 状态；没启动的用模型路径、
 * 状态为 stopped —— 对话 / Agent 的选择器只显示已启动的（启动在控制台做），
 * 而「默认模型」/ 集成选择器仍能先把模型配上、稍后再启动。
 *
 * 云端：已配置厂商的模型（含激活厂商实时 /v1/models 拉到的，保证新模型可见）。
 */
export async function listChatModels(): Promise<{ models: ChatModelOption[] }> {
  const models: ChatModelOption[] = [];
  const mode = getSetting("SERVER_MODE");
  const chatModel = getSetting("CHAT_MODEL");
  const activePath = getSetting("LOCAL_MODEL_PATH");
  const activeServedId = Served.getActiveServedId();
  const servedList = Served.listServedModels();

  // 加载目标 → 实例：把「列表里的模型」和「正在跑的实例」对起来。
  const servedByTarget = new Map<string, Served.ServedModelInfo>();
  for (const served of servedList) {
    servedByTarget.set(served.modelRef, served);
    servedByTarget.set(served.id, served);
  }
  const matchedServed = new Set<string>();

  const engine = (getSetting("INFERENCE_ENGINE") || "llama.cpp") as InferenceEngine;
  for (const m of ModelStore.listInstalledModels()) {
    // 目录条目（vLLM / SGLang / MLX 的整个仓库）按目录内容判格式，文件名没有扩展名。
    const kind = m.kind ?? fileKind(m.fileName);
    const compatible = engineSupports(engine, kind);
    const category = m.category ?? classifyModelName(m.fileName);
    // 分类判成非对话的（嵌入 / 重排 / 语音 / 生图…）即使格式兼容也不列进来；
    // 判定为 other 的仍按格式兼容性放行（老数据 / 认不出的仓库）。
    const isChat = category === "chat" || (compatible && category === "other");
    if (!isChat) continue;

    const served = servedByTarget.get(m.runtimeTarget) ?? servedByTarget.get(m.path);
    if (served) matchedServed.add(served.id);
    models.push({
      type: "local",
      value: served?.id ?? m.path,
      // 模型库里的条目一律用它的服务名（下载时就定好、也是服务器认的名字），
      // 跑没跑都显示同一个名字 —— 不能拿 MLX 的请求 id（绝对路径）当展示名。
      label: ModelStore.slugModelFileName(m.fileName),
      detail: m.repo,
      isActive: served
        ? mode === "local" && served.id === activeServedId
        : mode === "local" && !activeServedId && m.isActive,
      engine: served?.engine ?? resolveEngineForKind(kind, engine),
      isDir: m.isDir,
      category,
      state: served?.status ?? "stopped",
      endpoint: served?.endpoint,
    });
  }

  // 已启动但不在已安装列表里的实例（HF repo id、被排除出分组的目录…）：也要能选。
  for (const served of servedList) {
    if (matchedServed.has(served.id)) continue;
    const category = classifyModelName(served.label || served.modelRef);
    if (!isChatCategory(category)) continue;
    models.push({
      type: "local",
      value: served.id,
      label: served.label || modelNameFromRef(served.servedName, served.modelRef),
      detail: served.repo,
      isActive: mode === "local" && served.id === activeServedId,
      engine: served.engine,
      isDir: served.isDir,
      category,
      state: served.status,
      endpoint: served.endpoint,
    });
  }

  // 当前配置的本地模型（内置 profile / 手工填的名字）不在任何列表里时补一条，
  // 否则「默认模型」面板会显示成"没选"。
  if (mode === "local" && chatModel && !existsSync(activePath) && !servedByTarget.has(chatModel)) {
    models.push({
      type: "local",
      value: activePath || chatModel,
      label: modelNameFromRef(activePath || chatModel, chatModel),
      isActive: !activeServedId,
      category: classifyModelName(chatModel),
      state: "stopped",
    });
  }

  const activeProvider = activeProviderId();
  const apiModel = getSetting("VLLM_MODEL_NAME");
  const cloudModel = mode === "remote" ? getSetting("CHAT_MODEL") || apiModel : "";

  for (const provider of enabledCloudProviders(activeProvider)) {
    const ids = new Set(provider.models.map((m) => m.id).filter(Boolean));
    // 激活厂商额外拉一次实时列表：新上线的模型不用等用户去面板里同步。
    if (provider.id === activeProvider) {
      for (const id of await fetchApiModels()) ids.add(id);
      // 手动配置的模型名即使不在 /v1/models 里也保留可选（老行为的兜底）。
      if (apiModel) ids.add(apiModel);
    }
    // 服务商的 /v1/models 是"这个账号能用的所有模型"：嵌入 / 重排 / 语音 / 生图
    // 都在里面，这里只留对话能用的（认不出的保留）。
    const { ids: chatIds } = filterModelIds([...ids], MODEL_CATEGORY_SETS.chat, {
      keepOther: true,
    });
    for (const id of chatIds) {
      models.push({
        type: "api",
        value: id,
        label: id,
        detail: provider.name,
        isActive: mode === "remote" && provider.id === activeProvider && id === cloudModel,
        category: classifyModelName(id),
        state: "stopped",
        providerId: provider.id,
        providerName: provider.name,
        endpoint: (provider.baseUrl || "").trim(),
      });
    }
  }

  return { models };
}

/**
 * 选择对话模型。
 * - local：切到该**已启动**实例（不启停进程）。value 不是实例 id 时（旧调用方传路径 /
 *   模型名）只记录设置，启动交给控制台 / 模型页 —— 下拉框里等一次冷启动体验太差。
 * - api：切到对应云服务商（厂商变了会一并激活）并记录模型名。
 */
export async function selectChatModel(
  type: "local" | "api",
  value: string,
  providerId?: string,
): Promise<{ ok: boolean; error?: string; needsStart?: boolean }> {
  if (!value) return { ok: false, error: "Model not specified" };

  if (type === "local") {
    const served = Served.getServedModel(value);
    if (served) return Served.setActiveServedId(value);

    // 兼容旧调用方（默认模型面板 / 集成选择器）：记下"要用的本地模型"，不起进程。
    if (existsSync(value)) {
      const result = ModelStore.setActiveModel(value);
      if (!result.ok) return result;
    } else {
      // 没有对应本地文件的模型名（如内置 profile / MLX repo id），只记录名称，保持现有解析逻辑。
      // 命中 MLX 部署模型时同时切到 MLX 引擎，避免用 llama.cpp 去加载 safetensors 仓库。
      const mlxModel = getSetting("MLX_MODEL");
      updateSettings({
        CHAT_MODEL: value,
        ...(value === mlxModel ? { INFERENCE_ENGINE: "mlx" } : {}),
      });
    }
    updateSettings({ SERVER_MODE: "local", SERVED_ACTIVE_ID: "" });
    return { ok: true, needsStart: true };
  }

  if (providerId && providerId !== activeProviderId()) activateCloudProvider(providerId);
  updateSettings({ VLLM_MODEL_NAME: value, CHAT_MODEL: value, SERVER_MODE: "remote" });
  return { ok: true };
}
