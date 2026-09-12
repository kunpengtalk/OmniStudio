import { existsSync } from "fs";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

import { getSetting, updateSettings, getActiveServerPort } from "./db/settings";
import { getModelProfile } from "../shared/model-profiles";
import {
  fileKind,
  engineSupports,
  resolveEngineForKind,
  type InferenceEngine,
} from "../shared/modelscope";
import * as ModelStore from "./model-store";
import { getStatus, restartServer, startServer } from "./server-manager";

/**
 * Resolve the active chat model name.
 * Local models always use the canonical served name (slug) so it matches the
 * server's --alias / --served-model-name; HF references and the remote model
 * id act as fallbacks when no local file is configured.
 */
export function getChatModelName(): string {
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

export function getChatModel(): LanguageModel {
  const isLocal = getSetting("SERVER_MODE") === "local";

  if (isLocal) {
    // 按活动引擎的实际监听端口构造本地端点（mlx / vllm / sglang 各有独立端口）。
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

/** 对话模型选项：本地已安装模型或 OpenAI 兼容 API 上的模型。 */
export type ChatModelOption = {
  type: "local" | "api";
  /** local 为本地模型文件路径（内部定位用），api 为模型 ID */
  value: string;
  /** 展示用的模型名：本地为启动后的服务名（slug），api 为模型 ID */
  label: string;
  detail?: string;
  isActive: boolean;
  /** 本地模型将用哪个推理引擎启动（api 选项无此字段） */
  engine?: InferenceEngine;
  /** 本地仓库目录条目（vLLM / SGLang / MLX 加载整个目录）：UI 上标成文件夹。 */
  isDir?: boolean;
};

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

/** 列出可在对话中使用的模型：本地已安装的对话模型 + OpenAI 兼容 API 模型。 */
export async function listChatModels(): Promise<{ models: ChatModelOption[] }> {
  const models: ChatModelOption[] = [];
  const mode = getSetting("SERVER_MODE");
  const chatModel = getSetting("CHAT_MODEL");
  const activePath = getSetting("LOCAL_MODEL_PATH");

  const engine = (getSetting("INFERENCE_ENGINE") || "llama.cpp") as InferenceEngine;
  const localSeen = new Set<string>();
  for (const m of ModelStore.listInstalledModels()) {
    // 目录条目（vLLM / SGLang / MLX 的整个仓库）按目录内容判格式，文件名没有扩展名。
    const kind = m.kind ?? fileKind(m.fileName);
    const compatible = engineSupports(engine, kind);
    const isChat =
      m.category === "chat" ||
      (compatible && m.category !== "tts" && m.category !== "asr" && m.category !== "image");
    if (!isChat) continue;
    localSeen.add(m.path);
    models.push({
      type: "local",
      value: m.path,
      label: ModelStore.slugModelFileName(m.fileName),
      detail: m.repo,
      isActive: m.isActive,
      engine: resolveEngineForKind(kind, engine),
      isDir: m.isDir,
    });
  }
  // MLX 引擎：部署模型是 HF repo id（不是本地文件），单独作为选项展示并绑定 CHAT_MODEL。
  if (engine === "mlx") {
    const mlxModel = getSetting("MLX_MODEL");
    if (mlxModel && !localSeen.has(mlxModel)) {
      localSeen.add(mlxModel);
      models.push({
        type: "local",
        value: mlxModel,
        label: mlxModel,
        detail: "MLX (mlx-lm)",
        isActive: getChatModelName() === mlxModel,
        engine: "mlx",
      });
    }
  }
  // 当前配置的本地模型不在已安装列表中时（如内置 profile 或文件被排除出分组），
  // 仍作为选项展示，避免选择器为空。
  if (mode === "local" && chatModel && !localSeen.has(activePath)) {
    models.push({
      type: "local",
      value: activePath || chatModel,
      label: chatModel,
      isActive: true,
    });
  }

  const apiBase = getSetting("VLLM_API_BASE");
  const apiIds = await fetchApiModels();
  const apiModel = getSetting("VLLM_MODEL_NAME");
  const apiSeen = new Set<string>();
  for (const id of apiIds) {
    apiSeen.add(id);
    models.push({
      type: "api",
      value: id,
      label: id,
      detail: apiBase,
      isActive: mode === "remote" && id === apiModel,
    });
  }
  // 手动配置的模型名即使服务/列表拉取失败也保留可选。
  if (apiModel && !apiSeen.has(apiModel)) {
    models.push({
      type: "api",
      value: apiModel,
      label: apiModel,
      detail: apiBase,
      isActive: mode === "remote",
    });
  }

  return { models };
}

/**
 * 选择对话模型。
 * - local：激活本地模型文件（或仅记录名称），切到本地运行模式；本地服务器未运行时自动启动，
 *   已运行时重启以加载新模型。启动/重启失败会把错误返回给调用方。
 * - api：记录模型名，切到远程（OpenAI 兼容 API）模式。
 */
export async function selectChatModel(
  type: "local" | "api",
  value: string,
): Promise<{ ok: boolean; error?: string; restarting?: boolean }> {
  if (!value) return { ok: false, error: "Model not specified" };

  if (type === "local") {
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
    updateSettings({ SERVER_MODE: "local" });

    const status = getStatus();
    const isRunning = status === "running" || status === "starting" || status === "downloading";
    const result = isRunning ? await restartServer() : await startServer();
    if (!result.ok) {
      return { ok: false, error: result.error || "Failed to start server" };
    }
    return { ok: true, restarting: true };
  }

  updateSettings({ VLLM_MODEL_NAME: value, CHAT_MODEL: value, SERVER_MODE: "remote" });
  return { ok: true };
}