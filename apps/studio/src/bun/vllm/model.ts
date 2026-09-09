import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

import { getSetting } from "../db/settings";
import { getModelProfile } from "../../shared/model-profiles";

export type ModelEndpoint = {
  base?: string;
  apiKey?: string;
  model?: string;
};

export function getLocalModelName(): string {
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
    const port = getSetting("SERVER_PORT");
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
