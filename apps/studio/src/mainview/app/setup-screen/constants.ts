import { MODEL_PROFILES } from "@/shared/model-profiles";

export const REMOTE_PROFILES = [
  ...MODEL_PROFILES,
  { id: "none" as const, label: "None (raw output)", description: "No post-processing." },
];

export type Quant = { name: string; size: number };

export type ModelQuantInfo = {
  repo: string;
  quants: Quant[];
  defaultQuant: string;
};

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

export const MODEL_QUANTS: Record<string, ModelQuantInfo> = {
  chandra: {
    repo: "prithivMLmods/chandra-ocr-2-GGUF",
    quants: [
      { name: "Q2_K", size: 2_120_000_000 },
      { name: "Q3_K_S", size: 2_340_000_000 },
      { name: "Q3_K_M", size: 2_540_000_000 },
      { name: "Q3_K_L", size: 2_690_000_000 },
      { name: "Q4_K_S", size: 2_920_000_000 },
      { name: "Q4_K_M", size: 3_070_000_000 },
      { name: "Q5_K_M", size: 3_510_000_000 },
      { name: "Q8_0", size: 5_160_000_000 },
      { name: "BF16", size: 9_700_000_000 },
      { name: "F16", size: 9_700_000_000 },
      { name: "F32", size: 19_400_000_000 },
    ],
    defaultQuant: "Q4_K_M",
  },
  glmocr: {
    repo: "ggml-org/GLM-OCR-GGUF",
    quants: [
      { name: "Q8_0", size: 950_433_408 },
      { name: "F16", size: 1_785_771_648 },
    ],
    defaultQuant: "Q8_0",
  },
  lightonocr: {
    repo: "noctrex/LightOnOCR-2-1B-bbox-soup-GGUF",
    quants: [
      { name: "IQ4_XS", size: 367_800_352 },
      { name: "IQ4_NL", size: 381_562_912 },
      { name: "Q4_K_M", size: 396_701_728 },
      { name: "Q5_K_M", size: 444_411_936 },
      { name: "Q6_K", size: 495_104_032 },
      { name: "Q8_0", size: 639_443_776 },
      { name: "F16", size: 1_198_179_136 },
      { name: "BF16", size: 1_198_179_136 },
    ],
    defaultQuant: "Q8_0",
  },
};
