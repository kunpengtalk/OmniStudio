import { eq } from "drizzle-orm";
import type { InferenceEngine } from "../../shared/modelscope";
import { ENGINE_IDS, ENGINE_SPECS } from "../../shared/engines";
import { db } from "./index";
import { settings as settingsTable } from "./schema";
import { DEFAULT_ASR_MODEL_FILE } from "../../shared/modelscope";
import { DEFAULT_INFERENCE_PORT } from "../../shared/server-info";

export type SettingsKey =
  | "SETUP_COMPLETE"
  | "VLLM_API_BASE"
  | "VLLM_API_KEY"
  | "VLLM_MODEL_NAME"
  | "VLLM_MODEL_PROFILE"
  | "SERVER_MODE"
  | "SERVER_HOST"
  | "SERVER_PORT"
  | "VLLM_PORT"
  | "SGLANG_PORT"
  | "SERVER_EXTRA_ARGS"
  | "VLLM_EXTRA_ARGS"
  | "SGLANG_EXTRA_ARGS"
  | "AUTO_START_SERVER"
  | "MODEL_DIRS"
  | "UPDATE_CHANNEL"
  | "AUTO_UPDATE"
  | "FAVORITE_MODELS"
  | "LAUNCHER_CLAUDE_MODE"
  | "LAUNCHER_CLAUDE_OPUS"
  | "LAUNCHER_CLAUDE_SONNET"
  | "LAUNCHER_CLAUDE_HAIKU"
  | "LAUNCHER_CODEX_MODEL"
  | "LAUNCHER_OPENCODE_MODEL"
  | "LAUNCHER_OPENCLAW_MODEL"
  | "LAUNCHER_HERMES_MODEL"
  | "LAUNCHER_PI_MODEL"
  | "LAUNCHER_COPILOT_MODEL"
  | "SERVER_CTX_SIZE"
  | "SERVER_IMAGE_MAX_TOKENS"
  | "SERVER_BATCH_SIZE"
  | "SERVER_UBATCH_SIZE"
  | "SERVER_PARALLEL"
  | "SERVER_TEMP"
  | "SERVER_TOP_P"
  | "SERVER_GPU_LAYERS"
  | "SERVER_CACHE_TYPE_K"
  | "SERVER_CACHE_TYPE_V"
  | "CUSTOM_HF_MODEL"
  | "LOCAL_MODEL_PATH"
  | "LOCAL_MODEL_NAME"
  | "CHAT_MODEL"
  | "UI_LANG"
  | "UI_THEME"
  | "MAX_VLLM_RETRIES"
  | "MAX_VLLM_FAILURE_RETRIES"
  | "PAGE_CONCURRENCY"
  | "INFERENCE_ENGINE"
  | "MLX_PORT"
  | "MLX_EXTRA_ARGS"
  | "MLX_MODEL"
  | "MLX_CACHE_SIZE_GB"
  | "MLX_HF_ENDPOINT"
  | "VLLM_MAX_MODEL_LEN"
  | "VLLM_TENSOR_PARALLEL_SIZE"
  | "VLLM_GPU_MEMORY_UTILIZATION"
  | "VLLM_ENFORCE_EAGER"
  | "VLLM_DTYPE"
  | "SGLANG_CONTEXT_LENGTH"
  | "SGLANG_TP_SIZE"
  | "SGLANG_MEM_FRACTION_STATIC"
  | "SGLANG_CHUNKED_PREFILL_SIZE"
  | "TTS_MODEL"
  | "ASR_MODEL"
  | "ASR_LANG"
  | "TTS_VOICE"
  | "VOICE_CLONES"
  | "TTS_HTTP_BASE"
  | "TTS_MODELS_DIR"
  | "TTS_ENABLED_MODELS"
  | "TTS_EDGE_VOICE"
  | "TTS_PROVIDER"
  | "TTS_PROVIDER_BASE"
  | "TTS_PROVIDER_API_KEY"
  | "TTS_PROVIDER_MODEL"
  | "TTS_LOCAL_ENGINE"
  | "TTS_LOCAL_MODEL"
  | "ASR_PORT"
  | "ASR_ENGINE"
  | "ASR_AUDIOCPP_MODEL"
  | "ASR_PROVIDER_BASE"
  | "ASR_PROVIDER_API_KEY"
  | "ASR_PROVIDER_MODEL"
  | "OCR_ENGINE"
  | "OCR_TESSERACT_MODEL"
  | "OCR_PSM"
  | "OCR_VLM_SOURCE"
  | "OCR_PROVIDER_BASE"
  | "OCR_PROVIDER_API_KEY"
  | "OCR_PROVIDER_MODEL"
  | "PPOCR_MODEL_SIZE"
  | "IMG_BACKEND"
  | "IMG_API_BASE"
  | "IMG_API_KEY"
  | "IMG_MODEL"
  | "IMG_COMFY_BASE"
  | "IMG_MLX_IDLE_MINUTES"
  // AI 视频生成（video-gen.ts）
  | "VIDEO_BACKEND"
  | "VIDEO_MINIMAX_BASE"
  | "VIDEO_MINIMAX_API_KEY"
  | "VIDEO_MINIMAX_MODEL"
  | "VIDEO_SEEDANCE_BASE"
  | "VIDEO_SEEDANCE_API_KEY"
  | "VIDEO_SEEDANCE_MODEL"
  | "VIDEO_COMFY_BASE"
  | "VIDEO_COMFY_CKPT"
  | "VIDEO_COMFY_CLIP"
  | "VIDEO_COMFY_VAE"
  | "MODEL_DOWNLOADS"
  | "GATEWAY_ENABLED"
  | "GATEWAY_HOST"
  | "GATEWAY_PORT"
  | "GATEWAY_API_KEY"
  | "WEB_SEARCH_ENABLED"
  | "WEB_SEARCH_PROVIDER"
  | "WEB_SEARCH_API_KEY"
  | "WEB_SEARCH_MAX_RESULTS"
  /** 记忆总开关：Agent 获得记忆工具，置顶记忆注入系统提示。 */
  | "MEMORY_ENABLED"
  | "TRANSLATION_ENGINE"
  | "AGENT_WORKSPACE"
  | "AGENT_WORKSPACES"
  | "AGENT_MODE"
  | "AGENT_MAX_STEPS"
  | "AGENT_ALLOW_SHELL"
  | "VOICE_CALL_PROVIDER"
  | "VOICE_CALL_REALTIME_API_KEY"
  | "VOICE_CALL_REALTIME_BASE_URL"
  | "VOICE_CALL_REALTIME_MODEL"
  | "VOICE_CALL_REALTIME_VOICE"
  // Skills 管理（参照 skills-manager 移植）
  | "SKILLS_CENTRAL_PATH"
  | "SKILLS_SYNC_MODE"
  | "SKILLS_TOOLS_DISABLED"
  | "SKILLS_TOOL_PATH_OVERRIDES"
  | "SKILLS_CUSTOM_TOOLS"
  | "SKILLS_ACTIVE_PRESET"
  | "SKILLS_AUTO_BACKUP"
  | "SKILLS_GIT_REMOTE"
  | "SKILLS_GIT_PAT"
  // 模型云服务（cloud_providers 表的兼容槽位：激活行写回，网关 / CLI 消费）
  | "CLOUD_PROVIDER"
  | "CLOUD_MODELS"
  | "CUSTOM_PROVIDERS";

const DEFAULTS: Record<SettingsKey, string> = {
  SETUP_COMPLETE: "",
  VLLM_API_BASE: `http://localhost:${DEFAULT_INFERENCE_PORT}/v1`,
  VLLM_API_KEY: "EMPTY",
  VLLM_MODEL_NAME: "",
  VLLM_MODEL_PROFILE: "chandra",
  SERVER_MODE: "local",
  SERVER_HOST: "127.0.0.1",
  SERVER_PORT: DEFAULT_INFERENCE_PORT,
  VLLM_PORT: "8081",
  SGLANG_PORT: "8082",
  SERVER_EXTRA_ARGS: "",
  VLLM_EXTRA_ARGS: "",
  SGLANG_EXTRA_ARGS: "",
  AUTO_START_SERVER: "1",
  MODEL_DIRS: "",
  UPDATE_CHANNEL: "stable",
  // 启动时自动检查并下载新 release（"0" 关闭，仅手动检查）。
  AUTO_UPDATE: "1",
  FAVORITE_MODELS: "[]",
  LAUNCHER_CLAUDE_MODE: "local",
  LAUNCHER_CLAUDE_OPUS: "",
  LAUNCHER_CLAUDE_SONNET: "",
  LAUNCHER_CLAUDE_HAIKU: "",
  LAUNCHER_CODEX_MODEL: "",
  LAUNCHER_OPENCODE_MODEL: "",
  LAUNCHER_OPENCLAW_MODEL: "",
  LAUNCHER_HERMES_MODEL: "",
  LAUNCHER_PI_MODEL: "",
  LAUNCHER_COPILOT_MODEL: "",
  SERVER_CTX_SIZE: "8192",
  SERVER_IMAGE_MAX_TOKENS: "2048",
  SERVER_BATCH_SIZE: "256",
  SERVER_UBATCH_SIZE: "64",
  SERVER_PARALLEL: "1",
  SERVER_TEMP: "0.2",
  SERVER_TOP_P: "0.9",
  SERVER_GPU_LAYERS: "-1",
  SERVER_CACHE_TYPE_K: "q8_0",
  SERVER_CACHE_TYPE_V: "q8_0",
  CUSTOM_HF_MODEL: "",
  LOCAL_MODEL_PATH: "",
  LOCAL_MODEL_NAME: "",
  CHAT_MODEL: "",
  UI_LANG: "zh",
  /** 界面主题：system / light / dark，前端据此切换 <html> 的 .dark 类。 */
  UI_THEME: "system",
  MAX_VLLM_RETRIES: "6",
  MAX_VLLM_FAILURE_RETRIES: "0",
  PAGE_CONCURRENCY: "3",
  INFERENCE_ENGINE: "llama.cpp",
  MLX_PORT: "18010",
  MLX_EXTRA_ARGS: "",
  // DeepSeek V4.1 Flash 官方社区 MLX（4/8bit 混合）——MLX 引擎的默认部署模型。
  MLX_MODEL: "pipenetwork/DeepSeek-V4.1-Flash-MLX-mixed-4_8bit",
  MLX_CACHE_SIZE_GB: "8",
  // 国内环境优先走 hf-mirror，置空则使用 HuggingFace 官方。
  MLX_HF_ENDPOINT: "https://hf-mirror.com",
  VLLM_MAX_MODEL_LEN: "8192",
  VLLM_TENSOR_PARALLEL_SIZE: "1",
  VLLM_GPU_MEMORY_UTILIZATION: "0.9",
  VLLM_ENFORCE_EAGER: "0",
  VLLM_DTYPE: "auto",
  SGLANG_CONTEXT_LENGTH: "8192",
  SGLANG_TP_SIZE: "1",
  SGLANG_MEM_FRACTION_STATIC: "0.88",
  SGLANG_CHUNKED_PREFILL_SIZE: "",
  TTS_MODEL: "",
  ASR_MODEL: DEFAULT_ASR_MODEL_FILE,
  ASR_LANG: "zh",
  TTS_VOICE: "alloy",
  VOICE_CLONES: "[]",
  TTS_HTTP_BASE: "",
  TTS_MODELS_DIR: "",
  TTS_ENABLED_MODELS: "[]",
  TTS_EDGE_VOICE: "zh-CN-XiaoxiaoNeural",
  TTS_PROVIDER: "",
  // 默认服务地址为线上 OmniLabs 多模态平台（统一接入 TTS / ASR）。
  // 与 mainview/app/voice-provider-presets.ts 的 DEFAULT_VOICE_BASE_URL 保持一致。
  TTS_PROVIDER_BASE: "https://omnilabs.vibeadmin.cn/v1",
  TTS_PROVIDER_API_KEY: "",
  TTS_PROVIDER_MODEL: "",
  TTS_LOCAL_ENGINE: "",
  TTS_LOCAL_MODEL: "",
  ASR_PORT: "18081",
  ASR_ENGINE: "whisper",
  ASR_AUDIOCPP_MODEL: "",
  ASR_PROVIDER_BASE: "https://omnilabs.vibeadmin.cn/v1",
  ASR_PROVIDER_API_KEY: "",
  ASR_PROVIDER_MODEL: "",
  OCR_ENGINE: "",
  OCR_TESSERACT_MODEL: "",
  OCR_PSM: "3",
  OCR_VLM_SOURCE: "local",
  OCR_PROVIDER_BASE: "",
  OCR_PROVIDER_API_KEY: "",
  OCR_PROVIDER_MODEL: "",
  PPOCR_MODEL_SIZE: "medium",
  IMG_BACKEND: "api",
  IMG_API_BASE: "",
  IMG_API_KEY: "",
  IMG_MODEL: "",
  IMG_COMFY_BASE: "",
  // MLX 生图常驻 worker 空闲多少分钟后自动卸载（0 = 一直常驻）：模型会占数 GB 内存。
  IMG_MLX_IDLE_MINUTES: "10",
  // MiniMax（H3）默认走官方 API；自部署的 MiniMax 兼容服务改 Base 即可（参照 OmniLabs）。
  VIDEO_BACKEND: "minimax",
  VIDEO_MINIMAX_BASE: "https://api.minimaxi.com",
  VIDEO_MINIMAX_API_KEY: "",
  VIDEO_MINIMAX_MODEL: "MiniMax-H3",
  // Seedance 走火山方舟内容生成任务 API（Bearer ARK_API_KEY）。
  VIDEO_SEEDANCE_BASE: "https://ark.cn-beijing.volces.com/api/v3",
  VIDEO_SEEDANCE_API_KEY: "",
  VIDEO_SEEDANCE_MODEL: "doubao-seedance-1-0-lite-t2v-250428",
  VIDEO_COMFY_BASE: "",
  VIDEO_COMFY_CKPT: "",
  VIDEO_COMFY_CLIP: "",
  VIDEO_COMFY_VAE: "",
  MODEL_DOWNLOADS: "[]",
  GATEWAY_ENABLED: "1",
  GATEWAY_HOST: "127.0.0.1",
  GATEWAY_PORT: "10000",
  GATEWAY_API_KEY: "",
  WEB_SEARCH_ENABLED: "1",
  WEB_SEARCH_PROVIDER: "bing",
  WEB_SEARCH_API_KEY: "",
  WEB_SEARCH_MAX_RESULTS: "5",
  MEMORY_ENABLED: "1",
  TRANSLATION_ENGINE: "model",
  AGENT_WORKSPACE: "",
  /** 最近使用的工作区列表（JSON 数组），供输入框上方的工作区选择面板展示。 */
  AGENT_WORKSPACES: "[]",
  AGENT_MODE: "agent",
  AGENT_MAX_STEPS: "40",
  AGENT_ALLOW_SHELL: "1",
  // 语音通话：local = 本地 ASR+LLM+TTS 三段管线；cloud = Qwen Realtime（DashScope）。
  // 默认空 = 首次进入时由前端引导二选一（getVoiceCallProvider 会把空值当 local）。
  VOICE_CALL_PROVIDER: "",
  VOICE_CALL_REALTIME_API_KEY: "",
  VOICE_CALL_REALTIME_BASE_URL: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
  VOICE_CALL_REALTIME_MODEL: "qwen-audio-3.0-realtime-plus",
  VOICE_CALL_REALTIME_VOICE: "longanqian",
  // Skills 管理默认值
  SKILLS_CENTRAL_PATH: "",
  SKILLS_SYNC_MODE: "symlink",
  SKILLS_TOOLS_DISABLED: "[]",
  SKILLS_TOOL_PATH_OVERRIDES: "{}",
  SKILLS_CUSTOM_TOOLS: "[]",
  SKILLS_ACTIVE_PRESET: "",
  SKILLS_AUTO_BACKUP: "1",
  SKILLS_GIT_REMOTE: "",
  SKILLS_GIT_PAT: "",
  CLOUD_PROVIDER: "",
  CLOUD_MODELS: "[]",
  CUSTOM_PROVIDERS: "[]",
};

/**
 * 设置读取缓存：`getSetting` 是热路径（一次服务器启动会读十几次，每次对话也要读），
 * 263 处调用点每处一次 SELECT 会被放大。
 *
 * - 本进程写入（updateSettings）立即失效对应键，读到的一定是最新值；
 * - 跨进程写入（omi CLI、记忆桥接会直连同一个 SQLite）不经过本进程，
 *   用 2 秒 TTL 兜底 —— 代价是最多 2 秒的陈旧窗口，换来热路径零查询。
 */
const SETTINGS_CACHE_TTL_MS = 2000;
const settingsCache = new Map<string, { value: string; at: number }>();

/** 清空设置缓存（跨进程写入后需要立即生效时手动调用）。 */
export function invalidateSettingsCache() {
  settingsCache.clear();
}

export function getSetting(key: SettingsKey): string {
  const now = Date.now();
  const cached = settingsCache.get(key);
  if (cached && now - cached.at < SETTINGS_CACHE_TTL_MS) return cached.value;
  const row = db.select().from(settingsTable).where(eq(settingsTable.key, key)).get();
  const value = row?.value ?? DEFAULTS[key];
  settingsCache.set(key, { value, at: now });
  return value;
}

export function getNumericSetting(key: SettingsKey): number {
  return Number(getSetting(key));
}

export function getAllSettings(): Record<string, string> {
  const rows = db.select().from(settingsTable).all();
  const result: Record<string, string> = { ...DEFAULTS };
  for (const row of rows) {
    result[row.key] = row.value;
    settingsCache.set(row.key, { value: row.value, at: Date.now() });
  }
  return result;
}

export function updateSettings(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    db.insert(settingsTable)
      .values({ key, value })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value } })
      .run();
    settingsCache.set(key, { value, at: Date.now() });
  }
}

export function isConfigured(): boolean {
  const row = db.select().from(settingsTable).where(eq(settingsTable.key, "SETUP_COMPLETE")).get();
  return row?.value === "1";
}

/** The port key each LLM inference engine reads (derived from shared/engines.ts). */
export const ENGINE_PORT_KEYS: Record<InferenceEngine, SettingsKey> = Object.fromEntries(
  ENGINE_IDS.map((id) => [id, ENGINE_SPECS[id].portKey]),
) as Record<InferenceEngine, SettingsKey>;

/** The extra-launch-args key for each LLM engine (whitespace-separated flags appended last). */
export const ENGINE_EXTRA_ARGS_KEYS: Record<InferenceEngine, SettingsKey> = Object.fromEntries(
  ENGINE_IDS.map((id) => [id, ENGINE_SPECS[id].extraArgsKey]),
) as Record<InferenceEngine, SettingsKey>;

/** The configured listen port of the given engine. */
export function getServerPort(engine: InferenceEngine): string {
  return getSetting(ENGINE_PORT_KEYS[engine]) || "8080";
}

/** The currently active LLM engine (as configured in INFERENCE_ENGINE). */
export function getActiveInferenceEngine(): InferenceEngine {
  return (getSetting("INFERENCE_ENGINE") as InferenceEngine) || "llama.cpp";
}

/** The listen port of the currently active LLM inference engine. */
export function getActiveServerPort(): string {
  return getServerPort(getActiveInferenceEngine());
}
