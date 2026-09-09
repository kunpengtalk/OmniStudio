import { DEFAULT_PROCESSING_ARGS } from "./shared";
import type { ModelProfile } from "../model-profile";

export const profile: ModelProfile = {
  id: "glmocr",
  label: "GLM-OCR",
  rawFormat: "raw",
  rawLabel: "Markdown",
  rawOnly: false,
  processingArgs: { ...DEFAULT_PROCESSING_ARGS, maxOutputTokens: 8192 },
  buildUserPrompt: () => "Text Recognition:",
  async processRawOutput(raw) {
    return { markdown: raw.trim(), images: {} };
  },
};
