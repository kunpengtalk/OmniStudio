import { DEFAULT_PROCESSING_ARGS } from "./shared";
import type { ModelProfile } from "../model-profile";

export const profile: ModelProfile = {
  id: "none",
  label: "None",
  rawFormat: "raw",
  rawLabel: "Raw",
  rawOnly: true,
  processingArgs: { ...DEFAULT_PROCESSING_ARGS },
  buildUserPrompt: () =>
    "OCR this image. Return the text content as accurately as possible, preserving document structure.",
  async processRawOutput() {
    return { markdown: "", images: {} };
  },
};
