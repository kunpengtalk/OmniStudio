import { MODEL_PROFILES } from "@/shared/model-profiles";

export const REMOTE_PROFILES = [
  ...MODEL_PROFILES,
  { id: "none" as const, label: "None (raw output)", description: "No post-processing." },
];

/**
 * 国内主流的 OpenAI 兼容大模型服务商（引导界面“URL 模式”用）。
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
  {
    id: "deepseek",
    label: "DeepSeek",
    vendor: "深度求索",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
    note: "deepseek-chat 指向最新版，官方 API 性价比高",
  },
  {
    id: "qwen-dashscope",
    label: "通义千问 (Qwen)",
    vendor: "阿里云百炼",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-max", "qwen-plus", "qwen-turbo", "qwen-long", "qwen-flash"],
    note: "阿里云百炼，qwen-plus/turbo 有免费额度",
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    vendor: "智谱 AI",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4.5", "glm-4-plus", "glm-4-flash", "glm-4-air"],
    note: "注册送 tokens，GLM-4-Flash 免费",
  },
  {
    id: "moonshot",
    label: "Kimi",
    vendor: "月之暗面",
    baseUrl: "https://api.moonshot.cn/v1",
    models: ["kimi-latest", "moonshot-v1-128k", "moonshot-v1-32k", "moonshot-v1-8k"],
  },
  {
    id: "doubao",
    label: "豆包 (Doubao)",
    vendor: "字节跳动火山引擎",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    models: ["doubao-seed-1-6-250618", "doubao-1-5-pro-32k-250115", "doubao-1-5-lite-32k-250115"],
    note: "需在火山方舟开通并创建接入点，填 Endpoint ID 后缀",
  },
  {
    id: "baidu",
    label: "文心一言",
    vendor: "百度千帆",
    baseUrl: "https://qianfan.baidubce.com/v2",
    models: ["ernie-4.5-turbo-128k", "ernie-4.5-8k", "ernie-3.5-8k", "ernie-speed-8k"],
  },
  {
    id: "hunyuan",
    label: "腾讯混元",
    vendor: "腾讯云",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    models: ["hunyuan-turbos-latest", "hunyuan-turbo-latest", "hunyuan-pro", "hunyuan-lite"],
  },
  {
    id: "minimax",
    label: "MiniMax",
    vendor: "MiniMax 稀宇科技",
    baseUrl: "https://api.minimax.chat/v1",
    models: ["MiniMax-M1", "MiniMax-Text-01"],
  },
  {
    id: "spark",
    label: "讯飞星火",
    vendor: "科大讯飞",
    baseUrl: "https://spark-api-open.xf-yun.com/v1",
    models: ["4.0Ultra", "generalv3.5", "generalv3", "lite"],
    note: "需开通开放平台并启用对应服务",
  },
  {
    id: "lingyiwanwu",
    label: "零一万物",
    vendor: "01.AI",
    baseUrl: "https://api.lingyiwanwu.com/v1",
    models: ["yi-large", "yi-lightning"],
  },
  {
    id: "stepfun",
    label: "阶跃星辰",
    vendor: "StepFun",
    baseUrl: "https://api.stepfun.com/v1",
    models: ["step-1-8k", "step-1-flash"],
  },
  {
    id: "siliconflow",
    label: "硅基流动",
    vendor: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen3-235B-A22B-Instruct", "deepseek-ai/DeepSeek-R1"],
    note: "聚合多家开源模型，很多免费/低价",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    vendor: "第三方聚合",
    baseUrl: "https://openrouter.ai/api/v1",
    models: ["openai/gpt-5", "anthropic/claude-sonnet-4", "google/gemini-2.5-pro"],
    note: "汇聚主流模型，需充值/绑卡",
  },
  {
    id: "custom",
    label: "自定义",
    vendor: "其他 OpenAI 兼容服务",
    baseUrl: "",
    models: [],
    note: "手动填写完整 Base URL（含 /v1）",
  },
];

/**
 * 「模型云服务」页展示的厂商：只列原厂官方接口，不含聚合/中介服务商。
 */
const AGGREGATOR_PROVIDER_IDS = new Set(["siliconflow", "openrouter"]);

export const CLOUD_PROVIDERS: readonly RemoteProvider[] = REMOTE_PROVIDERS.filter(
  (p) => !AGGREGATOR_PROVIDER_IDS.has(p.id),
);

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
 * 主力对话模型（引导界面用）。OCR 模型不再出现在引导里——
 * 需要 OCR 的用户可在应用内自行选择。
 */
export type SetupModelOption = {
  id: string;
  label: string;
  params: string;
  description: string;
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
    description: "轻量通用对话模型，低内存也能流畅运行",
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
    description: "均衡的通用对话模型，质量与资源占用兼顾",
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
    description: "MoE 大模型，激活参数仅 3B，本地也能高效推理",
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
    description: "新一代旗舰通用对话模型，中文与推理能力突出",
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
