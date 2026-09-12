import {
  engineSupports,
  type InferenceEngine,
  type ModelFileKind,
  type SearchFormat,
} from "./engines";

// 引擎相关的定义统一放在 shared/engines.ts（唯一真源），这里只做转出，
// 保持既有 `@/shared/modelscope` 的导入路径不变。
export {
  availableEngines,
  ENGINE_EXTRA_ARGS_KEYS,
  ENGINE_IDS,
  ENGINE_INSTALL_HINTS,
  ENGINE_OPTIONS,
  ENGINE_PORT_KEYS,
  ENGINE_SPECS,
  SEARCH_FORMATS,
  engineSearchFormat,
  engineSpec,
  engineSupports,
} from "./engines";
export type { EngineSpec, InferenceEngine, ModelFileKind, SearchFormat } from "./engines";

/** Classify a model file by extension (frontend mirror of the bun-side fileKind). */
export function fileKind(fileName: string): ModelFileKind {
  const name = fileName.toLowerCase();
  if (name.endsWith(".gguf") || name.endsWith(".ggml")) return "gguf";
  if (name.endsWith(".safetensors")) return "safetensors";
  return "other";
}

/** Recommended engine for a weight format, when the format makes it unambiguous. */
export function engineForModelKind(kind: ModelFileKind): InferenceEngine | null {
  if (kind === "gguf") return "llama.cpp";
  if (kind === "safetensors") return "vllm";
  return null;
}

/** Recommended engine for a model file. */
export function engineForModelFile(fileName: string): InferenceEngine | null {
  return engineForModelKind(fileKind(fileName));
}

/**
 * Which engine will actually serve this model file: keep the currently
 * configured engine when it supports the format, otherwise fall back to the
 * recommended one. Used both to auto-switch the engine and to show the user
 * which engine will be used.
 */
export function resolveEngineForModel(
  fileName: string,
  currentEngine: InferenceEngine,
): InferenceEngine {
  const kind = fileKind(fileName);
  if (engineSupports(currentEngine, kind)) return currentEngine;
  return engineForModelFile(fileName) ?? currentEngine;
}

/** 模型来源平台 —— 检索走哪个站点、下载走哪条链路、UI 上打的哪个标都由它决定。 */
export type ModelSource = "modelscope" | "huggingface";

export type ModelSourceMeta = {
  /** 展示名（品牌名，不翻译）。 */
  label: string;
  /** 检索 / 下载实际使用的域名，明确告诉用户"这是从哪儿下的"。 */
  host: string;
  /** 结果行、详情页、下载任务上的来源标签样式。 */
  badgeClass: string;
};

export const MODEL_SOURCE_META: Record<ModelSource, ModelSourceMeta> = {
  modelscope: {
    label: "ModelScope",
    host: "modelscope.cn",
    badgeClass: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
  },
  huggingface: {
    label: "Hugging Face",
    host: "hf-mirror.com",
    badgeClass: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  },
};

export const MODEL_SOURCES: ModelSource[] = ["modelscope", "huggingface"];

/** 平台无关的格式维度（= 引擎检索格式），用于市场里的格式筛选与徽标。 */
export const MODEL_FORMATS: { value: SearchFormat; labelKey: string }[] = [
  { value: "gguf", labelKey: "models.format.gguf" },
  { value: "safetensors", labelKey: "models.format.safetensors" },
  { value: "mlx", labelKey: "models.format.mlx" },
];

/**
 * 从平台返回的元数据里读出一个仓库支持的格式。
 *
 * 两个平台都用标签声明权重格式，这是平台自己的过滤维度，不是从模型名猜出来的：
 * - Hugging Face: `tags` 含 `gguf` / `mlx` / `safetensors`，`library_name` 同名；
 * - ModelScope:   `tags` 含 `library:gguf` / `library:mlx` / `library:safetensors`
 *                 （MLX 仓库还会带 `custom_tag:mlx`）。
 *
 * `fileNames` 可选（HF 搜索结果带 siblings、本地已下载目录也有文件列表），
 * 有文件列表时再按实际文件后缀补一次，同样属于元数据而非猜测。
 */
export function modelFormats(
  tags: readonly string[],
  fileNames: readonly string[] = [],
): SearchFormat[] {
  const lower = new Set(tags.map((t) => t.toLowerCase()));
  const has = (...keys: string[]) => keys.some((k) => lower.has(k));

  const found = new Set<SearchFormat>();
  if (has("gguf", "library:gguf", "custom_tag:gguf")) found.add("gguf");
  if (has("mlx", "library:mlx", "custom_tag:mlx")) found.add("mlx");
  if (has("safetensors", "library:safetensors", "custom_tag:safetensors")) found.add("safetensors");

  for (const name of fileNames) {
    const kind = fileKind(name);
    if (kind === "gguf") found.add("gguf");
    else if (kind === "safetensors") found.add("safetensors");
  }

  return MODEL_FORMATS.map((f) => f.value).filter((f) => found.has(f));
}

/** 该仓库是否声明/包含指定格式（用于按格式筛选检索结果）。 */
export function matchFormat(
  modelFormatsOfRepo: readonly SearchFormat[],
  format: SearchFormat,
): boolean {
  // 元数据缺失时不下结论：宁可多给一个结果，也不把没有格式标签的仓库误判为不匹配。
  return modelFormatsOfRepo.length === 0 || modelFormatsOfRepo.includes(format);
}

/** Directory name used for a downloaded repo under the models base dir. */
export function safeRepoId(repo: string): string {
  return repo.replace(/[/\\:\s]+/g, "__");
}

/**
 * 仓库内路径 → 落盘文件名。
 * Hugging Face 的仓库会有 `BF16/xxx.gguf` 这类子目录路径，而已安装列表登记的是
 * 文件名（basename），判断"是否已下载"时必须先取 basename 再比对。
 */
export function fileBaseName(filePath: string): string {
  const i = filePath.lastIndexOf("/");
  return i < 0 ? filePath : filePath.slice(i + 1);
}

const MODEL_WEIGHT_EXTS = [
  ".gguf",
  ".safetensors",
  ".bin",
  ".pt",
  ".pth",
  ".ckpt",
  ".onnx",
  ".ggml",
];

/** True when the file name is a model weight (usable by llama.cpp / vLLM / SGLang). */
export function isModelWeightExt(name: string): boolean {
  const n = name.toLowerCase();
  return MODEL_WEIGHT_EXTS.some((ext) => n.endsWith(ext));
}

/** Fuzzy quantization match: "Q4_K_M" matches "Qwen3-4B-Q4_K_M.gguf" / "…q4_k_m…". */
export function matchQuant(fileName: string, quant: string): boolean {
  const a = fileName.toLowerCase().replace(/[^a-z0-9]/g, "");
  const b = quant.toLowerCase().replace(/[^a-z0-9]/g, "");
  return b.length > 0 && a.includes(b);
}

/** 一条市场检索结果。`source` 记录它来自哪个平台，后续列文件/下载都按它走。 */
export type MarketModel = {
  id: string;
  name: string;
  description: string;
  downloads: number;
  likes: number;
  license: string;
  tasks: string[];
  tags: string[];
  fileSize: number;
  params: number;
  createdAt: string;
  lastModified: string;
  /** 检索它时使用的平台。 */
  source: ModelSource;
  /** 平台元数据里声明的权重格式（gguf / safetensors / mlx）。 */
  formats: SearchFormat[];
  /** 仓库文件数（HF 的 siblings / MS 的 fileCount），未知为 0。 */
  fileCount: number;
};

/** 仓库里的一个文件。可能来自 ModelScope，也可能来自 Hugging Face。 */
export type MarketFile = {
  name: string;
  path: string;
  size: number;
  isLfs: boolean;
  /** gguf → llama.cpp；safetensors → vLLM / SGLang / MLX；other → 其它文件（bin/pt/config 等） */
  kind: ModelFileKind;
  /** 是否为模型权重文件 */
  isWeight: boolean;
};

/** 一次市场检索的结果。`hasMore` 用于"加载更多"。 */
export type MarketSearchResult = {
  models: MarketModel[];
  /** 命中总数；`totalExact: false`（Hugging Face）时只是"已取到的条数"下界。 */
  total: number;
  totalExact: boolean;
  hasMore: boolean;
};

/** 本地模型来自哪个位置。 */
export type ModelOrigin = "managed" | "external" | "hf-cache";

export type InstalledModel = {
  repo: string;
  fileName: string;
  path: string;
  size: number;
  isActive: boolean;
  isChatModel: boolean;
  category: ModelCategory;
  favorite: boolean;
  /** 该模型从哪个平台下载而来（老数据没有记录时为 undefined）。 */
  source?: ModelSource;
  /** 来源位置：应用下载目录 / 用户添加的目录 / Hugging Face 缓存。 */
  origin: ModelOrigin;
  /** path 是目录（HF 缓存按仓库聚合）时为 true。 */
  isDir: boolean;
  /** 权重格式，目录条目按其内容判定。 */
  kind: ModelFileKind;
  /** 推理引擎实际加载的路径（目录或文件）。 */
  runtimeTarget: string;
};

export type ModelCategory = "chat" | "tts" | "asr" | "image" | "other";

export const MODEL_CATEGORIES: { value: ModelCategory | "all"; labelKey: string }[] = [
  { value: "all", labelKey: "models.cat.all" },
  { value: "chat", labelKey: "models.cat.chat" },
  { value: "tts", labelKey: "models.cat.tts" },
  { value: "asr", labelKey: "models.cat.asr" },
  { value: "image", labelKey: "models.cat.image" },
  { value: "other", labelKey: "models.cat.other" },
];

export type ChatPreset = {
  app: ModelCategory;
  repo: string;
  label: string;
  description: string;
  defaultQuant: string;
  quants: string[];
  /** Inference engine(s) the preset's weights are compatible with. "all" = not an inference-engine model (TTS/ASR/image). */
  engine?: InferenceEngine | "all";
  /** 模型库默认推荐（千问小模型优先），置顶展示。 */
  recommended?: boolean;
};

/** Local whisper.cpp (GGML) ASR models, served from ModelScope. */
export type AsrPreset = {
  id: string;
  label: string;
  description: string;
  repo: string;
  fileName: string;
  sizeBytes: number;
};

/**
 * 默认本地 ASR 模型（Whisper large-v3-turbo，q8_0 量化）：
 * 识别效果与速度的平衡最佳，作为未配置时的默认值。
 */
export const DEFAULT_ASR_MODEL_FILE = "large-v3-turbo-q8_0.bin";

export function defaultAsrModelPreset(): AsrPreset | null {
  return ASR_PRESETS.find((p) => p.fileName === DEFAULT_ASR_MODEL_FILE) ?? null;
}

export const ASR_PRESETS: readonly AsrPreset[] = [
  {
    id: "whisper-tiny",
    label: "Whisper tiny",
    description: "约 39M 参数，速度最快、占用最小，适合简单语音转写",
    repo: "lihuoo/whisper.cpp-asr-model-collection",
    fileName: "tiny.bin",
    sizeBytes: 78 * 1024 * 1024,
  },
  {
    id: "whisper-base",
    label: "Whisper base",
    description: "约 74M 参数，中英文日常转写入门推荐",
    repo: "lihuoo/whisper.cpp-asr-model-collection",
    fileName: "base.bin",
    sizeBytes: 148 * 1024 * 1024,
  },
  {
    id: "whisper-small",
    label: "Whisper small",
    description: "约 244M 参数，准确度明显提升",
    repo: "lihuoo/whisper.cpp-asr-model-collection",
    fileName: "small.bin",
    sizeBytes: 488 * 1024 * 1024,
  },
  {
    id: "whisper-medium-q8",
    label: "Whisper medium q8_0",
    description: "约 769M 参数，高质量转写",
    repo: "lihuoo/whisper.cpp-asr-model-collection",
    fileName: "medium-q8_0.bin",
    sizeBytes: 823 * 1024 * 1024,
  },
  {
    id: "whisper-large-v3-turbo-q8",
    label: "Whisper large-v3-turbo q8_0",
    description: "大模型快速版（turbo），中英转写效果最佳且速度可观",
    repo: "lihuoo/whisper.cpp-asr-model-collection",
    fileName: "large-v3-turbo-q8_0.bin",
    sizeBytes: 574 * 1024 * 1024,
  },
  {
    id: "whisper-large-v3-q5",
    label: "Whisper large-v3 q5_0",
    description: "最高精度（v3 量化），需要足够内存",
    repo: "lihuoo/whisper.cpp-asr-model-collection",
    fileName: "large-v3-q5_0.bin",
    sizeBytes: 1081 * 1024 * 1024,
  },
];

export const MODEL_PRESETS: readonly ChatPreset[] = [
  // 对话 / VLM (GGUF → llama.cpp)。recommended 的千问小模型排最前，作为模型库默认推荐。
  {
    app: "chat",
    repo: "unsloth/Qwen3.5-4B-GGUF",
    label: "Qwen3.5 4B",
    description: "Qwen3.5 4B 轻量对话模型（GGUF）",
    defaultQuant: "Q4_K_M",
    quants: ["Q2_K", "Q3_K_M", "Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0"],
    engine: "llama.cpp",
    recommended: true,
  },
  {
    app: "chat",
    repo: "Qwen/Qwen2.5-3B-Instruct-GGUF",
    label: "Qwen2.5 3B Instruct",
    description: "Qwen2.5 3B 轻量对话模型（GGUF），低资源友好",
    defaultQuant: "Q4_K_M",
    quants: ["Q2_K", "Q3_K_M", "Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0"],
    engine: "llama.cpp",
    recommended: true,
  },
  {
    app: "chat",
    repo: "Qwen/Qwen3-4B-GGUF",
    label: "Qwen3 4B",
    description: "Qwen3 4B 轻量对话模型（GGUF）",
    defaultQuant: "Q4_K_M",
    quants: ["Q2_K", "Q3_K_M", "Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0"],
    engine: "llama.cpp",
    recommended: true,
  },
  {
    app: "chat",
    repo: "unsloth/Qwen3.5-9B-GGUF",
    label: "Qwen3.5 9B",
    description: "Qwen3.5 9B 通用对话模型（GGUF）",
    defaultQuant: "Q4_K_M",
    quants: ["Q2_K", "Q3_K_M", "Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0"],
    engine: "llama.cpp",
    recommended: true,
  },
  {
    app: "chat",
    repo: "Qwen/Qwen3-8B-GGUF",
    label: "Qwen3 8B",
    description: "Qwen3 8B 对话模型（GGUF），原生支持多工具调用",
    defaultQuant: "Q4_K_M",
    quants: ["Q2_K", "Q3_K_M", "Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0"],
    engine: "llama.cpp",
    recommended: true,
  },
  {
    app: "chat",
    repo: "Qwen/Qwen2.5-7B-Instruct-GGUF",
    label: "Qwen2.5 7B Instruct",
    description: "Qwen2.5 7B 通用对话模型（GGUF）",
    defaultQuant: "Q4_K_M",
    quants: ["Q2_K", "Q3_K_M", "Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0"],
    engine: "llama.cpp",
    recommended: true,
  },
  {
    app: "chat",
    repo: "unsloth/Qwen3.5-35B-A3B-GGUF",
    label: "Qwen3.5 35B-A3B",
    description: "Qwen3.5 35B-A3B MoE 对话模型（GGUF），激活参数仅 3B",
    defaultQuant: "Q4_K_M",
    quants: ["Q2_K", "Q3_K_M", "Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0"],
    engine: "llama.cpp",
  },
  {
    app: "chat",
    repo: "unsloth/Qwen3.6-27B-GGUF",
    label: "Qwen3.6 27B",
    description: "Qwen3.6 27B 旗舰对话模型（GGUF）",
    defaultQuant: "Q4_K_M",
    quants: ["Q2_K", "Q3_K_M", "Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0"],
    engine: "llama.cpp",
  },
  {
    app: "chat",
    repo: "ZhipuAI/cogvlm2-llama3-chinese-chat-19B",
    label: "CogVLM2 19B 中文",
    description: "智谱 CogVLM2 多模态（VLM）对话模型",
    defaultQuant: "Q4_K_M",
    quants: [],
    engine: "llama.cpp",
  },
  // 对话 / VLM (safetensors → vLLM / SGLang)
  {
    app: "chat",
    repo: "Qwen/Qwen3.5-4B",
    label: "Qwen3.5 4B (HF)",
    description: "Qwen3.5 4B 对话模型（safetensors）",
    defaultQuant: "",
    quants: [],
    engine: "vllm",
    recommended: true,
  },
  {
    app: "chat",
    repo: "Qwen/Qwen3.5-9B",
    label: "Qwen3.5 9B (HF)",
    description: "Qwen3.5 9B 对话模型（safetensors）",
    defaultQuant: "",
    quants: [],
    engine: "vllm",
    recommended: true,
  },
  {
    app: "chat",
    repo: "Qwen/Qwen2.5-7B-Instruct",
    label: "Qwen2.5 7B Instruct (HF)",
    description: "Qwen2.5 7B 通用对话模型（safetensors）",
    defaultQuant: "",
    quants: [],
    engine: "vllm",
    recommended: true,
  },
  {
    app: "chat",
    repo: "Qwen/Qwen3-8B",
    label: "Qwen3 8B (HF)",
    description: "Qwen3 8B 对话模型（safetensors），原生支持多工具调用",
    defaultQuant: "",
    quants: [],
    engine: "vllm",
    recommended: true,
  },
  {
    app: "chat",
    repo: "Qwen/Qwen3.5-35B-A3B",
    label: "Qwen3.5 35B-A3B (HF)",
    description: "Qwen3.5 35B-A3B MoE 对话模型（safetensors）",
    defaultQuant: "",
    quants: [],
    engine: "vllm",
  },
  {
    app: "chat",
    repo: "Qwen/Qwen3.6-27B",
    label: "Qwen3.6 27B (HF)",
    description: "Qwen3.6 27B 旗舰对话模型（safetensors）",
    defaultQuant: "",
    quants: [],
    engine: "vllm",
  },
  {
    app: "chat",
    repo: "Qwen/Qwen2.5-VL-7B-Instruct",
    label: "Qwen2.5-VL 7B",
    description: "Qwen2.5-VL 7B 多模态视觉对话模型（safetensors）",
    defaultQuant: "",
    quants: [],
    engine: "vllm",
  },
  {
    app: "chat",
    repo: "ZhipuAI/glm-4-9b-chat",
    label: "GLM-4 9B 中文",
    description: "智谱 GLM-4 9B 中文对话模型（safetensors）",
    defaultQuant: "",
    quants: [],
    engine: "vllm",
  },
  // TTS
  {
    app: "tts",
    repo: "iic/CosyVoice2-0.5B",
    label: "CosyVoice2 0.5B",
    description: "阿里 通义 CosyVoice2 语音合成（TTS）",
    defaultQuant: "Q4_K_M",
    quants: [],
    engine: "all",
  },
  // ASR
  {
    app: "asr",
    repo: "iic/SenseVoiceSmall",
    label: "SenseVoiceSmall",
    description: "阿里 通义 SenseVoice 语音识别（ASR）",
    defaultQuant: "Q4_K_M",
    quants: [],
    engine: "all",
  },
  {
    app: "asr",
    repo: "iic/Whisper-large-v3",
    label: "Whisper large-v3",
    description: "OpenAI Whisper large-v3 语音识别（ASR）",
    defaultQuant: "Q4_K_M",
    quants: [],
    engine: "all",
  },
  // 生图
  {
    app: "image",
    repo: "AI-ModelScope/stable-diffusion-xl-base-1.0",
    label: "Stable Diffusion XL",
    description: "Stable Diffusion XL 基础版文生图",
    defaultQuant: "Q4_K_M",
    quants: [],
    engine: "all",
  },
  {
    app: "image",
    repo: "Kwai-Kolors/Kolors",
    label: "Kolors",
    description: "快手可图（Kolors）文生图模型",
    defaultQuant: "Q4_K_M",
    quants: [],
    engine: "all",
  },
  // MLX（Apple Silicon，mlx-lm 推理引擎）
  {
    app: "chat",
    repo: "pipenetwork/DeepSeek-V4.1-Flash-MLX-mixed-4_8bit",
    label: "DeepSeek V4.1 Flash (MLX 4/8bit)",
    description: "DeepSeek V4.1 Flash 官方社区 MLX 版（4/8bit 混合，质量/占用平衡）",
    defaultQuant: "",
    quants: [],
    engine: "mlx",
  },
  {
    app: "chat",
    repo: "Vontra/DeepSeek-V4.1-Flash-MLX-2bit-MTP",
    label: "DeepSeek V4.1 Flash (MLX 2bit MTP)",
    description: "DeepSeek V4.1 Flash MLX 极小版（2bit + MTP），体积小、速度快",
    defaultQuant: "",
    quants: [],
    engine: "mlx",
  },
];

export function classifyModel(model: MarketModel): ModelCategory {
  const tags = [...model.tags, ...model.tasks.map((t) => `task:${t}`)];
  const id = model.id.toLowerCase();
  const joined = tags.join(" ").toLowerCase();

  // 标签形态两个平台不同：ModelScope 用 `task:text-generation` 前缀，
  // Hugging Face 直接在 tags 里放 pipeline tag（`text-generation`）。两者都要认。
  const hasTag = (...names: string[]) =>
    names.some((n) => tags.includes(n) || tags.includes(`task:${n}`) || tags.includes(`custom_tag:${n}`));

  if (
    hasTag("text-to-speech", "audio-generation", "text-to-audio") ||
    id.includes("cosyvoice") ||
    id.includes("sovits") ||
    id.includes("tts")
  ) {
    return "tts";
  }

  if (
    hasTag("auto-speech-recognition", "automatic-speech-recognition", "audio-classification") ||
    id.includes("whisper") ||
    id.includes("sensevoice") ||
    id.includes("paraformer") ||
    id.includes("funasr")
  ) {
    return "asr";
  }

  if (
    hasTag("text-to-image-synthesis", "text-to-image", "image-to-image") ||
    id.includes("stable-diffusion") ||
    id.includes("kolors") ||
    id.includes("flux") ||
    joined.includes("text to image")
  ) {
    return "image";
  }

  if (
    hasTag("text-generation", "image-text-to-text", "chat", "conversational") ||
    id.includes("llama") ||
    id.includes("qwen") ||
    id.includes("chat") ||
    id.includes("instruct") ||
    id.includes("cogvlm") ||
    id.includes("deepseek") ||
    id.includes("glm") ||
    id.includes("mistral")
  ) {
    return "chat";
  }

  return "other";
}

export function matchCategory(model: MarketModel, category: ModelCategory | "all"): boolean {
  if (category === "all") return true;
  return classifyModel(model) === category;
}