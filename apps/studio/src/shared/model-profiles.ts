export type ModelProfileId = "chandra" | "glmocr" | "lightonocr";

export type ServerArgs = {
  ctxSize: number;
  imageMaxTokens: number;
  batchSize: number;
  ubatchSize: number;
  parallel: number;
  temp: number;
  topP: number;
  repeatPenalty: number;
  repeatLastN: number;
  noMmprojOffload: boolean;
};

const DEFAULT_SERVER_ARGS: ServerArgs = {
  ctxSize: 8192,
  imageMaxTokens: 2048,
  batchSize: 256,
  ubatchSize: 64,
  parallel: 1,
  temp: 0.2,
  topP: 0.9,
  repeatPenalty: 1.12,
  repeatLastN: 256,
  noMmprojOffload: true,
};

export type ModelProfilePreset = {
  id: ModelProfileId;
  label: string;
  description: string;
  badge?: string;
  hfModel: string;
  serverArgs: ServerArgs;
};

export const MODEL_PROFILES: readonly ModelProfilePreset[] = [
  {
    id: "lightonocr",
    label: "LightOnOCR",
    description: "Outputs markdown with inline image bounding boxes.",
    badge: "Fastest",
    hfModel: "noctrex/LightOnOCR-2-1B-bbox-soup-GGUF:Q8_0",
    serverArgs: { ...DEFAULT_SERVER_ARGS },
  },
  {
    id: "chandra",
    label: "Chandra OCR 2",
    description: "Outputs HTML layout blocks with bounding boxes.",
    badge: "Most Accurate",
    hfModel: "prithivMLmods/chandra-ocr-2-GGUF:Q4_K_M",
    serverArgs: { ...DEFAULT_SERVER_ARGS },
  },
  {
    id: "glmocr",
    label: "GLM-OCR",
    description: "Outputs markdown/LaTeX directly. For zai-org/GLM-OCR.",
    badge: "Text-only",
    hfModel: "ggml-org/GLM-OCR-GGUF:Q8_0",
    serverArgs: { ...DEFAULT_SERVER_ARGS },
  },
] as const;

export function getModelProfile(id: string): ModelProfilePreset | undefined {
  return MODEL_PROFILES.find((p) => p.id === id);
}
