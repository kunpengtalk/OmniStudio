export type InferenceEngine = "llama.cpp" | "vllm" | "sglang";

/** Options for the engine selector; labels reuse `settings.engine.*` i18n keys. */
export const ENGINE_OPTIONS: { value: InferenceEngine; labelKey: string }[] = [
  { value: "llama.cpp", labelKey: "settings.engine.llamacpp" },
  { value: "vllm", labelKey: "settings.engine.vllm" },
  { value: "sglang", labelKey: "settings.engine.sglang" },
];

export type ModelFileKind = "gguf" | "safetensors" | "other";

/** Classify a model file by extension (frontend mirror of the bun-side fileKind). */
export function fileKind(fileName: string): ModelFileKind {
  const name = fileName.toLowerCase();
  if (name.endsWith(".gguf") || name.endsWith(".ggml")) return "gguf";
  if (name.endsWith(".safetensors")) return "safetensors";
  return "other";
}

/** Whether a file kind can be loaded by the given inference engine. */
export function engineSupports(engine: InferenceEngine, kind: ModelFileKind): boolean {
  if (kind === "other") return true;
  if (kind === "gguf") return engine === "llama.cpp";
  return engine === "vllm" || engine === "sglang";
}

/** Recommended engine for a model file, when its format makes it unambiguous. */
export function engineForModelFile(fileName: string): InferenceEngine | null {
  const kind = fileKind(fileName);
  if (kind === "gguf") return "llama.cpp";
  if (kind === "safetensors") return "vllm";
  return null;
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

/** Best-effort format hint for a repository id (search results don't list files). */
export function repoFormatHint(repoId: string): ModelFileKind | "unknown" {
  const id = repoId.toLowerCase();
  if (id.includes("gguf")) return "gguf";
  return "unknown";
}

export type ModelScopeModel = {
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
};

export type ModelScopeFile = {
  name: string;
  path: string;
  size: number;
  isLfs: boolean;
  /** gguf → llama.cpp；safetensors → vLLM / SGLang；other → 其它文件 */
  kind: ModelFileKind;
  /** 是否为模型权重文件 */
  isWeight: boolean;
};

export type InstalledModel = {
  repo: string;
  fileName: string;
  path: string;
  size: number;
  isActive: boolean;
  isChatModel: boolean;
  category?: ModelCategory;
  favorite?: boolean;
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
  // 对话 / VLM (GGUF → llama.cpp)
  {
    app: "chat",
    repo: "Qwen/Qwen2.5-7B-Instruct-GGUF",
    label: "Qwen2.5 7B Instruct",
    description: "Qwen2.5 7B 通用对话模型（GGUF）",
    defaultQuant: "Q4_K_M",
    quants: ["Q2_K", "Q3_K_M", "Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0"],
    engine: "llama.cpp",
  },
  {
    app: "chat",
    repo: "Qwen/Qwen2.5-3B-Instruct-GGUF",
    label: "Qwen2.5 3B Instruct",
    description: "Qwen2.5 3B 轻量对话模型（GGUF），低资源友好",
    defaultQuant: "Q4_K_M",
    quants: ["Q2_K", "Q3_K_M", "Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0"],
    engine: "llama.cpp",
  },
  {
    app: "chat",
    repo: "Qwen/Qwen3-8B-GGUF",
    label: "Qwen3 8B",
    description: "Qwen3 8B 对话模型（GGUF），原生支持多工具调用",
    defaultQuant: "Q4_K_M",
    quants: ["Q2_K", "Q3_K_M", "Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0"],
    engine: "llama.cpp",
  },
  {
    app: "chat",
    repo: "Qwen/Qwen3-4B-GGUF",
    label: "Qwen3 4B",
    description: "Qwen3 4B 轻量对话模型（GGUF）",
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
    repo: "Qwen/Qwen2.5-7B-Instruct",
    label: "Qwen2.5 7B Instruct (HF)",
    description: "Qwen2.5 7B 通用对话模型（safetensors）",
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
    repo: "Qwen/Qwen3-8B",
    label: "Qwen3 8B (HF)",
    description: "Qwen3 8B 对话模型（safetensors），原生支持多工具调用",
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
];

export function classifyModel(model: ModelScopeModel): ModelCategory {
  const tags = [...model.tags, ...model.tasks.map((t) => `task:${t}`)];
  const id = model.id.toLowerCase();
  const joined = tags.join(" ").toLowerCase();

  if (
    tags.some((t) => t === "task:text-to-speech") ||
    tags.some((t) => t === "task:audio-generation") ||
    id.includes("cosyvoice") ||
    id.includes("sovits") ||
    id.includes("tts")
  ) {
    return "tts";
  }

  if (
    tags.some((t) => t === "task:auto-speech-recognition") ||
    tags.some((t) => t === "task:automatic-speech-recognition") ||
    id.includes("whisper") ||
    id.includes("sensevoice") ||
    id.includes("paraformer") ||
    id.includes("funasr")
  ) {
    return "asr";
  }

  if (
    tags.some((t) => t === "task:text-to-image-synthesis") ||
    tags.some((t) => t === "task:text-to-image") ||
    tags.some((t) => t === "custom_tag:text-to-image") ||
    id.includes("stable-diffusion") ||
    id.includes("kolors") ||
    id.includes("flux") ||
    joined.includes("text to image")
  ) {
    return "image";
  }

  if (
    tags.some((t) => t === "task:text-generation") ||
    tags.some((t) => t === "custom_tag:chat") ||
    id.includes("llama") ||
    id.includes("qwen") ||
    id.includes("chat") ||
    id.includes("instruct") ||
    id.includes("cogvlm")
  ) {
    return "chat";
  }

  return "other";
}

export function matchCategory(model: ModelScopeModel, category: ModelCategory | "all"): boolean {
  if (category === "all") return true;
  return classifyModel(model) === category;
}