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
  ENGINE_SHORT_NAMES,
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
  return resolveEngineForKind(fileKind(fileName), currentEngine);
}

/**
 * 同上，但格式由调用方给出 —— 已安装列表里的**目录条目**（vLLM / SGLang / MLX
 * 的整个仓库）文件名没有扩展名，格式要按目录内容判定（`InstalledModel.kind`）。
 */
export function resolveEngineForKind(
  kind: ModelFileKind,
  currentEngine: InferenceEngine,
): InferenceEngine {
  if (engineSupports(currentEngine, kind)) return currentEngine;
  return engineForModelKind(kind) ?? currentEngine;
}

/** 模型来源平台 —— 检索走哪个站点、下载走哪条链路、UI 上打的哪个标都由它决定。 */
export type ModelSource = "modelscope" | "huggingface";

export type ModelSourceMeta = {
  /** 展示名（品牌名，不翻译）。 */
  label: string;
  /** 检索 / 下载实际使用的域名，明确告诉用户"这是从哪儿下的"。 */
  host: string;
};

// 来源标签不再按平台配色（`MODEL_TAG_CLASS` 一套中性样式），平台差异靠文字 + 域名 tooltip。
export const MODEL_SOURCE_META: Record<ModelSource, ModelSourceMeta> = {
  modelscope: {
    label: "ModelScope",
    host: "modelscope.cn",
  },
  huggingface: {
    label: "Hugging Face",
    host: "hf-mirror.com",
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
 * 仓库/模型目录名 → 展示名（`safeRepoId` 的逆向取值）。
 *
 * 下载目录用 `safeRepoId` 编码过（`Qwen__Qwen3.5-4B`），用户自己的目录可能本来就是
 * `org/repo` 结构，两者都取最后一段做展示名：`Qwen__Qwen3.5-4B` → `Qwen3.5-4B`。
 * 展示名同时是服务名（`--served-model-name`）的来源，UI 与推理服务必须用同一个。
 */
export function modelDisplayName(dirName: string): string {
  const parts = dirName.split(/[/\\]+|__+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : dirName;
}

/** 路径型模型引用（绝对路径 / home 简写 / Windows 盘符）。 */
const MODEL_REF_PATH_RE = /^(?:[/~]|[A-Za-z]:[\\/])/;

/**
 * 模型引用 → 界面展示名。
 *
 * 引用可能是路径（LM Studio 目录、MLX 的绝对路径、自己下载的 GGUF 文件），
 * 也可能是 HF repo id / 服务名。**路径一律只取最后一段**——界面上（下拉、会话记录、
 * 统计、日志）不该出现 `/Users/…` 这种路径，用户下载的模型叫什么名字就显示什么名字。
 */
export function modelNameFromRef(ref: string, fallback = ""): string {
  const value = (ref ?? "").trim();
  if (!value) return fallback;
  // repo id（`org/model`）里的斜杠是名字的一部分，原样保留；路径才算路径。
  if (!MODEL_REF_PATH_RE.test(value)) return value;
  const tail = modelDisplayName(value);
  const stripped = tail.replace(/\.(gguf|safetensors|bin|pt|pth|ckpt|onnx|ggml)$/i, "");
  return stripped || tail || fallback;
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
  /**
   * 条目包含的权重文件名（整仓库条目 = 仓库里的全部权重，分批 GGUF = 它的分片）。
   * 市场页用它判断"这个文件下过没有"：目录条目只有一条记录，只比 fileName 会漏。
   */
  files?: string[];
};

/**
 * 模型分类（唯一真源）：本地已安装模型、市场检索结果、服务商 /v1/models 返回的
 * 模型 id 全部按这套分类打标。
 *
 * `other` 是"没认出来"，不是"其它模型"：按分类筛选时它跟着 `keepOther` 走 ——
 * 认不出来的宁可多给（聊天选择器保留它），不能因为分类器不认识就把可用的模型藏掉。
 */
export type ModelCategory =
  | "chat"
  | "embedding"
  | "rerank"
  | "tts"
  | "asr"
  | "image"
  | "video"
  | "other";

export const MODEL_CATEGORIES: { value: ModelCategory | "all"; labelKey: string }[] = [
  { value: "all", labelKey: "models.cat.all" },
  { value: "chat", labelKey: "models.cat.chat" },
  { value: "embedding", labelKey: "models.cat.embedding" },
  { value: "rerank", labelKey: "models.cat.rerank" },
  { value: "tts", labelKey: "models.cat.tts" },
  { value: "asr", labelKey: "models.cat.asr" },
  { value: "image", labelKey: "models.cat.image" },
  { value: "video", labelKey: "models.cat.video" },
  { value: "other", labelKey: "models.cat.other" },
];

/** 需要模型的服务场景 —— 每个场景只认自己那几类模型。 */
export type ModelCategorySet =
  | "chat"
  | "embedding"
  | "rerank"
  | "tts"
  | "asr"
  | "image"
  | "video";

export const MODEL_CATEGORY_SETS: Record<ModelCategorySet, readonly ModelCategory[]> = {
  chat: ["chat"],
  embedding: ["embedding"],
  rerank: ["rerank"],
  tts: ["tts"],
  asr: ["asr"],
  image: ["image"],
  video: ["video"],
};

/**
 * 这个分类能不能当对话 / 文本生成模型用（`other` = 没认出来，按能用处理）。
 * 排序、基准测速、外部 agent 这些"要个 LLM"的地方统一用它判。
 */
export function isChatModelCategory(category: ModelCategory): boolean {
  return MODEL_CATEGORY_SETS.chat.includes(category) || category === "other";
}

/**
 * 按名字（文件名 / 仓库名 / API 模型 id）判断模型分类。
 *
 * 只认明确的命名特征，认不出来回 `other`：非聊天类的判定必须收紧，
 * 否则会把聊天模型误判成 TTS/生图，从对话选择器里消失。
 * 判定顺序 = 从最专有到最宽泛，先命中先返回。
 */
export function classifyModelName(rawName: string): ModelCategory {
  const name = rawName.toLowerCase();
  // 去掉标点后连写（`text-embedding-3` / `text_embedding_3` → `textembedding3`），
  // 便于用「关键词紧跟数字/版本」这类形态匹配。
  const flat = name.replace(/[^a-z0-9]+/g, "");
  const tokens = new Set(name.split(/[^a-z0-9]+/).filter(Boolean));
  const has = (...keys: string[]) => keys.some((k) => tokens.has(k));
  const hasWord = (...keys: string[]) => keys.some((k) => name.includes(k));

  // 重排：必须在嵌入之前判 —— `bge-reranker-v2-m3` 也含 `bge`。
  if (
    hasWord("rerank", "reranker", "cross-encoder", "crossencoder", "reranking") ||
    has("ranker")
  ) {
    return "rerank";
  }

  // 嵌入：向量化模型（OpenAI text-embedding、BGE / GTE / M3E / E5 / Jina 等）。
  if (
    hasWord("embedding", "embed-", "-embed", "_embed", "sentence-transformers", "text2vec", "minilm") ||
    has("embed", "embeddings", "bge", "gte", "m3e", "e5", "voyage", "bce", "acge", "piccolo") ||
    /(^|\/)(intfloat|dunzhang)\//.test(name)
  ) {
    return "embedding";
  }

  // 语音合成 TTS。
  if (
    hasWord(
      "tts",
      "text-to-speech",
      "cosyvoice",
      "sovits",
      "fish-speech",
      "fishaudio",
      "indextts",
      "index-tts",
      "mega-tts",
      "vocoder",
      "voice-clone",
      "voiceclone",
      "chatterbox",
      "speecht5",
      "outetts",
      "zonos",
      "xtts",
      "kokoro",
      "sambert",
      "higgs-audio",
      "f5-tts",
      "dia-tts",
    ) ||
    has("tts") ||
    // MiniMax 的 speech-01 / speech-2.5 是 TTS，`speech-` 后面必须跟版本号才算。
    /(^|[/_-])speech[-_]?\d/.test(name)
  ) {
    return "tts";
  }

  // 语音识别 / 转录 ASR。
  if (
    hasWord(
      "whisper",
      "sensevoice",
      "paraformer",
      "funasr",
      "transcribe",
      "transcription",
      "speech-to-text",
      "speech-recognition",
      "vosk",
      "wav2vec",
      "moonshine",
      "whisperx",
      "scribe",
      "seaco",
      "dolphin",
    ) ||
    has("asr")
  ) {
    return "asr";
  }

  // 文生视频：`t2v` / `i2v` 这类任务后缀最可靠，其次是厂商型号名。
  if (
    hasWord(
      "t2v",
      "i2v",
      "v2v",
      "text-to-video",
      "image-to-video",
      "seedance",
      "hailuo",
      "kling",
      "veo",
      "sora",
      "cogvideo",
      "hunyuanvideo",
      "ltx-video",
      "mochi",
      "pika",
      "runway",
      "luma",
    ) ||
    has("video", "videos")
  ) {
    return "video";
  }

  // 文生图。
  if (
    hasWord(
      "stable-diffusion",
      "sdxl",
      "sd3",
      "sd-turbo",
      "sd15",
      "flux",
      "kolors",
      "dall-e",
      "dall·e",
      "dalle",
      "imagen",
      "gpt-image",
      "seedream",
      "seededit",
      "wanx",
      "qwen-image",
      "hunyuan-image",
      "cogview",
      "midjourney",
      "ideogram",
      "recraft",
      "playground",
      "schnell",
      "text-to-image",
      "image-generation",
      "imagegen",
    ) ||
    has("image", "images")
  ) {
    return "image";
  }

  // 文本对话 / VLM：最后判断，作为"看起来像对话模型"的兜底。
  if (
    hasWord(
      "chat",
      "instruct",
      "text-generation",
      "conversational",
      "gpt",
      "claude",
      "gemini",
      "qwen",
      "llama",
      "mistral",
      "mixtral",
      "deepseek",
      "chatglm",
      "glm",
      "moonshot",
      "kimi",
      "doubao",
      "ernie",
      "hunyuan",
      "baichuan",
      "command-r",
      "gemma",
      "phi-",
      "olmo",
      "falcon",
      "vicuna",
      "hermes",
      "sonnet",
      "opus",
      "haiku",
      "grok",
      "reasoner",
      "omni",
      "vision",
      "cogvlm",
    ) ||
    has("llm", "vl", "chat", "instruct")
  ) {
    return "chat";
  }

  return "other";
}

/**
 * 按场景挑选远端模型 id（服务商 /v1/models 返回的清单）。
 *
 * - `keepOther`：认不出分类的 id 一并保留（聊天选择器用：宁可多给，不能漏掉可用模型）；
 * - `relax`：一个都没命中时回退成全量并标记 `relaxed`，让界面提示"没能识别出该场景的模型"，
 *   避免服务商用了不常见的命名时选择器直接空掉。
 */
export function filterModelIds(
  ids: readonly string[],
  want: readonly ModelCategory[],
  opts: { keepOther?: boolean; relax?: boolean } = {},
): { ids: string[]; relaxed: boolean } {
  const matched = ids.filter((id) => {
    const category = classifyModelName(id);
    return want.includes(category) || (opts.keepOther === true && category === "other");
  });
  if (matched.length === 0 && opts.relax === true && ids.length > 0) {
    return { ids: [...ids], relaxed: true };
  }
  return { ids: matched, relaxed: false };
}

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

  // 平台声明的任务类型最准，先按标签定；标签缺失时再退回按名字判断。
  if (hasTag("reranking", "text-ranking", "cross-encoder")) return "rerank";
  if (hasTag("feature-extraction", "sentence-similarity", "text-embedding")) return "embedding";
  if (hasTag("text-to-speech", "audio-generation", "text-to-audio")) return "tts";
  if (hasTag("auto-speech-recognition", "automatic-speech-recognition", "audio-classification")) {
    return "asr";
  }
  if (hasTag("text-to-video", "image-to-video", "video-generation")) return "video";
  if (hasTag("text-to-image-synthesis", "text-to-image", "image-to-image")) return "image";
  if (hasTag("text-generation", "image-text-to-text", "chat", "conversational")) return "chat";

  const byName = classifyModelName(id);
  if (byName !== "other") return byName;

  // 名字里没有命名特征、标签也没说清 —— 再看一眼简介里的口语化描述。
  if (joined.includes("text to image") || joined.includes("文生图")) return "image";
  if (joined.includes("text to video") || joined.includes("文生视频")) return "video";
  return "other";
}

export function matchCategory(model: MarketModel, category: ModelCategory | "all"): boolean {
  if (category === "all") return true;
  return classifyModel(model) === category;
}