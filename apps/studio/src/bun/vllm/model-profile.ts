import type { Sharp } from "sharp";

import { getSetting } from "../db/settings";
import type { ModelProfileId } from "../../shared/model-profiles";
import type { ParseHtmlOptions, ProcessedOutput, ProcessingArgs } from "./profiles/shared";

import { profile as chandra } from "./profiles/chandra";
import { profile as glmocr } from "./profiles/glmocr";
import { profile as lightonocr } from "./profiles/lightonocr";
import { profile as none } from "./profiles/none";

export { MODEL_PROFILES } from "../../shared/model-profiles";
export type { ModelProfileId } from "../../shared/model-profiles";
export { DEFAULT_PROCESSING_ARGS } from "./profiles/shared";
export type { ProcessingArgs, RepeatDetectionArgs, ParseHtmlOptions, ProcessedOutput } from "./profiles/shared";

export type ModelRawFormat = "html_bbox" | "markdown_image_bbox" | "raw";

export type ModelProfile = {
  id: ModelProfileId | "none";
  label: string;
  rawFormat: ModelRawFormat;
  rawLabel: "HTML" | "Markdown" | "Raw";
  rawOnly: boolean;
  processingArgs: ProcessingArgs;
  systemPrompt?: string;
  preprocessImage?: (img: Sharp) => Promise<Sharp>;
  buildUserPrompt: (bboxScale: number) => string;
  processRawOutput: (
    raw: string,
    image: Sharp,
    opts: ParseHtmlOptions,
    bboxScale: number,
  ) => Promise<ProcessedOutput>;
};

const profiles: Record<string, ModelProfile> = {
  chandra,
  glmocr,
  lightonocr,
  none,
};

export function getProfileById(profileId: string): ModelProfile {
  return profiles[profileId] ?? none;
}

export function getCurrentModelProfile(): ModelProfile {
  return getProfileById(getSetting("VLLM_MODEL_PROFILE"));
}
