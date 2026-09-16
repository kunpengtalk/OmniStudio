import { MODEL_PROFILES } from "@/shared/model-profiles";
import { CLOUD_PRESETS } from "@/shared/cloud-providers";
import type { ModelCandidates } from "@/shared/hardware";
import type { InferenceEngine } from "@/shared/modelscope";

export const REMOTE_PROFILES = [
  ...MODEL_PROFILES,
  { id: "none" as const, label: "None (raw output)", description: "No post-processing." },
];

/**
 * 引导界面「URL 模式」的服务商列表：单一数据源在 shared/cloud-providers.ts
 * （与「模型云服务」页共用），末尾追加「自定义」占位项。
 * 选择服务商后只需填入 API Key，Base URL 自动带出（仍可手动修改）；
 * 列表末尾的“自定义”才需要手动输入完整 URL。
 */
export type RemoteProvider = {
  id: string;
  /** 产品名 / 品牌名 */
  label: string;
  /** 服务商所属厂商/公司（展示用） */
  vendor: string;
  /** OpenAI 兼容接口 Base URL，已含 /v1 等路径前缀 */
  baseUrl: string;
  /** 该服务商常见对话模型 ID（用于提示/预填模型名） */
  models: string[];
  /** 简短备注（免费额度 / 需要额外操作等） */
  note?: string;
};

export const REMOTE_PROVIDERS: readonly RemoteProvider[] = [
  ...CLOUD_PRESETS.map((p) => ({
    id: p.id,
    label: p.name,
    vendor: p.vendor,
    baseUrl: p.baseUrl,
    models: [...p.models],
    note: p.note,
  })),
  {
    id: "custom",
    label: "自定义",
    vendor: "其他 OpenAI 兼容服务",
    baseUrl: "",
    models: [],
    note: "手动填写完整 Base URL（含 /v1）",
  },
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

/**
 * 每 token 的 KV 缓存（bytes）：层数 × KV 头 × head_dim × 2(K/V) × 2B（fp16）。
 * 与上下文长度相乘即为 KV 缓存总量。不是实测值，是引导页展示量级的估算口径
 * —— 架构参数变了（层数 / KV 头数）要跟着改，否则估算会静默偏小。
 */
function kvBytesPerToken(layers: number, kvHeads: number, headDim = 128): number {
  return layers * kvHeads * headDim * 2 * 2;
}

/**
 * 主力对话模型（引导界面用）。OCR 模型不再出现在引导里——
 * 需要 OCR 的用户可在应用内自行选择。
 */
export type SetupModelOption = {
  id: string;
  label: string;
  params: string;
  /** 参数规模（十亿），用于「本机跑得动的前提下挑最大的」排序。 */
  paramsB: number;
  description: string;
  /** 每 token 的 KV 缓存（bytes），见 `kvBytesPerToken`。 */
  kvBytesPerToken: number;
  /** llama.cpp 使用的 GGUF 量化仓库（unsloth），`-hf repo:quant` 直接拉取。 */
  ggufRepo: string;
  /** vLLM / SGLang 使用的 safetensors 官方仓库。 */
  hfRepo: string;
  /** safetensors 仓库约略体积（用于展示）。 */
  hfSizeBytes: number;
  quants: { name: string; size: number }[];
  defaultQuant: string;
};

export const SETUP_MODELS: readonly SetupModelOption[] = [
  {
    id: "qwen35-4b",
    label: "Qwen3.5 4B",
    params: "4B",
    paramsB: 4,
    description: "轻量通用对话模型，低内存也能流畅运行",
    kvBytesPerToken: kvBytesPerToken(36, 8),
    ggufRepo: "unsloth/Qwen3.5-4B-GGUF",
    hfRepo: "Qwen/Qwen3.5-4B",
    hfSizeBytes: 9.3 * 1e9,
    quants: [
      { name: "Q4_K_M", size: 2.7 * 1e9 },
      { name: "Q3_K_M", size: 2.3 * 1e9 },
      { name: "Q5_K_M", size: 3.1 * 1e9 },
      { name: "Q8_0", size: 4.5 * 1e9 },
    ],
    defaultQuant: "Q4_K_M",
  },
  {
    id: "qwen35-9b",
    label: "Qwen3.5 9B",
    params: "9B",
    paramsB: 9,
    description: "均衡的通用对话模型，质量与资源占用兼顾",
    kvBytesPerToken: kvBytesPerToken(48, 8),
    ggufRepo: "unsloth/Qwen3.5-9B-GGUF",
    hfRepo: "Qwen/Qwen3.5-9B",
    hfSizeBytes: 19.3 * 1e9,
    quants: [
      { name: "Q4_K_M", size: 5.7 * 1e9 },
      { name: "Q3_K_M", size: 4.7 * 1e9 },
      { name: "Q5_K_M", size: 6.6 * 1e9 },
      { name: "Q8_0", size: 9.5 * 1e9 },
    ],
    defaultQuant: "Q4_K_M",
  },
  {
    id: "qwen35-35b",
    label: "Qwen3.5 35B-A3B",
    params: "35B",
    paramsB: 35,
    description: "MoE 大模型，激活参数仅 3B，本地也能高效推理",
    // MoE：KV 头只有 4 个，KV 缓存比同尺寸稠密模型小得多。
    kvBytesPerToken: kvBytesPerToken(48, 4),
    ggufRepo: "unsloth/Qwen3.5-35B-A3B-GGUF",
    hfRepo: "Qwen/Qwen3.5-35B-A3B",
    hfSizeBytes: 71.9 * 1e9,
    quants: [
      { name: "Q4_K_M", size: 22.0 * 1e9 },
      { name: "Q3_K_M", size: 16.4 * 1e9 },
      { name: "Q5_K_M", size: 26.2 * 1e9 },
      { name: "Q8_0", size: 36.9 * 1e9 },
    ],
    defaultQuant: "Q4_K_M",
  },
  {
    id: "qwen36-27b",
    label: "Qwen3.6 27B",
    params: "27B",
    paramsB: 27,
    description: "新一代旗舰通用对话模型，中文与推理能力突出",
    kvBytesPerToken: kvBytesPerToken(64, 8),
    ggufRepo: "unsloth/Qwen3.6-27B-GGUF",
    hfRepo: "Qwen/Qwen3.6-27B",
    hfSizeBytes: 55.6 * 1e9,
    quants: [
      { name: "Q4_K_M", size: 16.8 * 1e9 },
      { name: "Q3_K_M", size: 13.6 * 1e9 },
      { name: "Q5_K_M", size: 19.5 * 1e9 },
      { name: "Q8_0", size: 28.6 * 1e9 },
    ],
    defaultQuant: "Q4_K_M",
  },
];

/**
 * 把引导页的模型表翻译成内存估算需要的形状（权重档位 + 架构常数）。
 * MLX 预设只有仓库名、没有体积信息，返回空 —— 那条路上不显示「约占多少内存」，
 * 好过编一个数字出来。
 */
export function setupModelCandidates(engine: InferenceEngine): ModelCandidates[] {
  if (engine === "mlx") return [];
  return SETUP_MODELS.map((model) => ({
    id: model.id,
    paramsB: model.paramsB,
    kvBytesPerToken: model.kvBytesPerToken,
    variants:
      engine === "llama.cpp"
        ? model.quants.map((q) => ({ name: q.name, sizeBytes: q.size }))
        : // vLLM / SGLang 直接吃 bf16 safetensors，没有量化档位可挑。
          [{ name: "BF16", sizeBytes: model.hfSizeBytes }],
    defaultQuant: engine === "llama.cpp" ? model.defaultQuant : "BF16",
  }));
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
