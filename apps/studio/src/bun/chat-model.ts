import { existsSync } from "fs";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

import { getSetting, updateSettings, getActiveServerPort } from "./db/settings";
import { getModelProfile } from "../shared/model-profiles";
import {
  classifyModelName,
  engineSupports,
  fileKind,
  isChatModelCategory,
  modelNameFromRef,
  resolveEngineForKind,
  type InferenceEngine,
  type ModelCategory,
} from "../shared/modelscope";
import { modelTypeOf } from "../shared/cloud-providers";
import { ENGINE_SHORT_NAMES } from "../shared/engines";
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
 * 2. **云端只列「模型云服务」里配好的对话模型**：厂商已启用，且模型是用户在该厂商
 *    的模型列表里添加过的、用途分类为对话的那一类。不拉 /v1/models 全量 —— 服务商
 *    那份清单里生图 / 视频 / TTS / ASR / 嵌入全都有，列进对话选择器只会让人挑到
 *    一个发不出聊天的模型（各功能页的 CloudModelSelect 是同一套规则）。
 */

/**
 * 本地侧的模型名（**不看 SERVER_MODE**）：已启动实例的服务名 → CHAT_MODEL →
 * 本地模型名 / MLX 部署 / HF / 内置 profile。本地请求（网关、基准测试）与本地
 * 展示都用它；`getChatModelName()` 按模式决定要不要用它。
 */
function localChatModelName(): string {
  // 已启动实例的服务名就是服务器认的 id（含 MLX 的绝对路径），优先用它。
  const active = Served.getRequestTargetServedModel();
  if (active) return active.servedName;

  const chatModel = getSetting("CHAT_MODEL");
  if (chatModel) return chatModel;

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

/**
 * Resolve the active chat model name.
 * Local models always use the canonical served name (slug) so it matches the
 * server's --alias / --served-model-name; HF references and the remote model
 * id act as fallbacks when no local file is configured.
 *
 * **已启动的本地实例只在本地模式下代表「当前模型」**：切到云端不会停掉本地实例
 * （切换是瞬时的，见 `selectChatModel`），不加模式判断就会把本地服务名 —— MLX 下
 * 甚至是一个绝对路径 —— 当成云端模型名发出去，对端只会回一句
 * "Model does not exist"。请求该填什么见 `getChatRequestModelId()`。
 */
export function getChatModelName(): string {
  if (getSetting("SERVER_MODE") === "local") return localChatModelName();
  // 云端：只认云端槽位。CHAT_MODEL 里往往还留着上一个本地模型的名字 / 路径
  // （本地激活就写它），拿它当云端模型名同样是 "Model does not exist"。
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
  const name = localChatModelName();
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
 *
 * 同样按模式取：云端模式下显示云端模型，而不是还在跑的本地实例 —— 否则会话标题
 * 会写着本地模型，请求却发给了云端厂商。
 */
export function getChatModelLabel(): string {
  if (getSetting("SERVER_MODE") === "local") {
    const active = Served.getRequestTargetServedModel();
    if (active) return active.label || modelNameFromRef(active.servedName, active.modelRef);
  }
  return modelNameFromRef(getChatModelName());
}

/** 按当前模式（本地推理服务器 / 云端 API）该填的请求模型 id。 */
export function getChatRequestModelId(): string {
  if (getSetting("SERVER_MODE") === "local") return getLocalRequestModelId();
  return getChatModelName();
}

/**
 * 「这次推理由谁提供」的展示名：本地是引擎名（llama.cpp / vLLM / SGLang / MLX），
 * 云端是激活厂商的展示名。
 *
 * 用途是消息详情的用量卡片 —— 本地与云端混用时，光看模型名分不出这条回答跑在哪。
 * 云端拿不到厂商展示名（配置被删）时返回 null，让界面不显示这一行而不是瞎猜。
 */
export function getChatProviderLabel(): string | null {
  if (getSetting("SERVER_MODE") === "local") {
    const engine = (getSetting("INFERENCE_ENGINE") || "llama.cpp") as InferenceEngine;
    return ENGINE_SHORT_NAMES[engine] ?? engine;
  }
  const id = activeProviderId();
  if (!id) return null;
  return listCloudProviders().providers.find((p) => p.id === id)?.name ?? null;
}

/**
 * 模型名里能看出"它吃图片"的常见写法：qwen2.5-vl / llava / llama-3.2-vision /
 * gemma-3 / minicpm-v / internvl / pixtral / glm-4v / qwen-omni …
 * 只是启发式：判断错了用户可以在设置 → Agent 能力里强制开 / 关。
 */
const VISION_MODEL_HINTS =
  /(?:^|[^a-z0-9])(?:vl|vlm|vision|llava|omni|minicpm-?v|internvl|pixtral|moondream|smolvlm|idefics|cogvlm|glm-?4-?v|gemma-?3|janus)/i;

/**
 * 当前模型能不能接受图片输入 —— 决定 Agent 是否拿到 view_image 工具。
 *
 * 纯文本模型收到图片内容块会被服务端直接 400（llama.cpp / vLLM 都如此），
 * 所以默认按模型名猜；猜不准时用 AGENT_VISION_TOOL 强制：
 *   auto（默认）/ on / off
 * 云端厂商的主力模型基本都支持视觉，直接放行。
 */
export function chatModelSupportsImages(): boolean {
  const mode = getSetting("AGENT_VISION_TOOL");
  if (mode === "on") return true;
  if (mode === "off") return false;
  if (getSetting("SERVER_MODE") !== "local") return true;
  return VISION_MODEL_HINTS.test(`${getChatModelLabel()} ${getChatModelName()}`);
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

/**
 * 对话可选的云服务商：**已在设置页「启动」过**（启用时校验过密钥）且有地址的那些。
 * 可以同时启用多个厂商 —— 列表里每个厂商的模型各成一组，按厂商名选。
 * 当前激活的厂商即使没启用也保留（历史数据 / 本地兼容端点常不带 Key）。
 */
function enabledCloudProviders(activeProvider: string | null) {
  return listCloudProviders().providers.filter((p) => {
    if ((p.baseUrl || "").trim() === "") return false;
    if (p.enabled) return true;
    return p.id === activeProvider;
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
 * 云端：**只列用户在厂商「模型列表」里添加过的对话模型**。厂商那份清单是唯一的
 * 事实来源 —— 没添加过的（哪怕 /v1/models 里能拉到）不进对话选择器，显式标成
 * 生图 / 视频 / TTS / ASR 等用途的也一律不进。
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
    for (const entry of provider.models) {
      const id = (entry.id || "").trim();
      if (!id) continue;
      // 用途分类：用户在面板里显式标过就以标注为准，否则按 id 自动识别。
      // 认不出的（other）留着 —— 自定义 / 自建端点常是五花八门的名字，
      // 漏掉它们比多列一条更糟；生图 / 视频 / 语音这些认得出的一律不进对话列表。
      const category = modelTypeOf(entry);
      if (!isChatCategory(category)) continue;
      models.push({
        type: "api",
        value: id,
        label: id,
        detail: provider.name,
        isActive: mode === "remote" && provider.id === activeProvider && id === cloudModel,
        category,
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
