import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

import { getSetting, getActiveServerPort } from "../db/settings";
import { isMlxActive, resolveMlxModel } from "../runtimes/mlx";
import { getModelProfile } from "../../shared/model-profiles";

export type ModelEndpoint = {
  base?: string;
  apiKey?: string;
  model?: string;
};

/**
 * 本地推理服务器认的模型 id（OCR / 知识库这些一次性调用用）。
 * MLX 与其它引擎不同：它没有 `--served-model-name`，本地目录对外暴露的 id 是解析后的
 * 绝对路径（见 `resolveMlxModel`），填服务名会被它当成 HF repo id 去下载、请求没有响应。
 */
export function getLocalModelName(): string {
  if (isMlxActive()) {
    const mlxId = resolveMlxModel().requestModelId;
    if (mlxId) return mlxId;
  }
  const localName = getSetting("LOCAL_MODEL_NAME");
  if (localName) return localName;
  const profileId = getSetting("VLLM_MODEL_PROFILE");
  const profile = getModelProfile(profileId);
  return getSetting("CUSTOM_HF_MODEL") || profile?.hfModel || "";
}

export function getModel(opts?: ModelEndpoint): LanguageModel {
  // 显式的 OpenAI 兼容端点（OCR 远程来源：在 OCR 页单独配置，不依赖全局 SERVER_MODE）。
  if (opts?.base) {
    const provider = createOpenAICompatible({
      name: "vllm",
      baseURL: opts.base,
      apiKey: opts.apiKey && opts.apiKey !== "EMPTY" ? opts.apiKey : undefined,
    });
    return provider.languageModel(opts.model?.trim() || "model");
  }

  const isLocal = getSetting("SERVER_MODE") === "local";

  if (isLocal) {
    const port = getActiveServerPort();
    const modelName = getLocalModelName();

    const provider = createOpenAICompatible({
      name: "vllm",
      baseURL: `http://localhost:${port}/v1`,
    });
    return provider.languageModel(modelName);
  }

  const apiKey = getSetting("VLLM_API_KEY");
  const provider = createOpenAICompatible({
    name: "vllm",
    baseURL: getSetting("VLLM_API_BASE"),
    apiKey: apiKey === "EMPTY" ? undefined : apiKey,
  });
  return provider.languageModel(getSetting("VLLM_MODEL_NAME"));
}
