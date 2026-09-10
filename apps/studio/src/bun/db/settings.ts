import { eq } from "drizzle-orm";
import { db } from "./index";
import { settings as settingsTable } from "./schema";
import { DEFAULT_ASR_MODEL_FILE } from "../../shared/modelscope";

export type SettingsKey =
  | "SETUP_COMPLETE"
  | "VLLM_API_BASE"
  | "VLLM_API_KEY"
  | "VLLM_MODEL_NAME"
  | "VLLM_MODEL_PROFILE"
  | "SERVER_MODE"
  | "SERVER_HOST"
  | "SERVER_PORT"
  | "AUTO_START_SERVER"
  | "MODEL_DIRS"
  | "UPDATE_CHANNEL"
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
  | "MAX_VLLM_RETRIES"
  | "MAX_VLLM_FAILURE_RETRIES"
  | "PAGE_CONCURRENCY"
  | "INFERENCE_ENGINE"
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
  | "IMG_BACKEND"
  | "IMG_API_BASE"
  | "IMG_API_KEY"
  | "IMG_MODEL"
  | "IMG_COMFY_BASE"
  | "MODEL_DOWNLOADS"
  | "GATEWAY_ENABLED"
  | "GATEWAY_HOST"
  | "GATEWAY_PORT"
  | "GATEWAY_API_KEY"
  | "WEB_SEARCH_ENABLED"
  | "WEB_SEARCH_PROVIDER"
  | "WEB_SEARCH_API_KEY"
  | "WEB_SEARCH_MAX_RESULTS"
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
  | "VOICE_CALL_REALTIME_VOICE";

const DEFAULTS: Record<SettingsKey, string> = {
  SETUP_COMPLETE: "",
  VLLM_API_BASE: "http://localhost:8080/v1",
  VLLM_API_KEY: "EMPTY",
  VLLM_MODEL_NAME: "",
  VLLM_MODEL_PROFILE: "chandra",
  SERVER_MODE: "local",
  SERVER_HOST: "127.0.0.1",
  SERVER_PORT: "8080",
  AUTO_START_SERVER: "1",
  MODEL_DIRS: "",
  UPDATE_CHANNEL: "stable",
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
  MAX_VLLM_RETRIES: "6",
  MAX_VLLM_FAILURE_RETRIES: "0",
  PAGE_CONCURRENCY: "3",
  INFERENCE_ENGINE: "llama.cpp",
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
  TTS_PROVIDER_BASE: "",
  TTS_PROVIDER_API_KEY: "",
  TTS_PROVIDER_MODEL: "",
  TTS_LOCAL_ENGINE: "",
  TTS_LOCAL_MODEL: "",
  ASR_PORT: "18081",
  ASR_ENGINE: "whisper",
  ASR_AUDIOCPP_MODEL: "",
  ASR_PROVIDER_BASE: "",
  ASR_PROVIDER_API_KEY: "",
  ASR_PROVIDER_MODEL: "",
  OCR_ENGINE: "",
  OCR_TESSERACT_MODEL: "",
  OCR_PSM: "3",
  OCR_VLM_SOURCE: "local",
  OCR_PROVIDER_BASE: "",
  OCR_PROVIDER_API_KEY: "",
  OCR_PROVIDER_MODEL: "",
  IMG_BACKEND: "api",
  IMG_API_BASE: "",
  IMG_API_KEY: "",
  IMG_MODEL: "",
  IMG_COMFY_BASE: "",
  MODEL_DOWNLOADS: "[]",
  GATEWAY_ENABLED: "1",
  GATEWAY_HOST: "127.0.0.1",
  GATEWAY_PORT: "10000",
  GATEWAY_API_KEY: "",
  WEB_SEARCH_ENABLED: "1",
  WEB_SEARCH_PROVIDER: "bing",
  WEB_SEARCH_API_KEY: "",
  WEB_SEARCH_MAX_RESULTS: "5",
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
};

export function getSetting(key: SettingsKey): string {
  const row = db.select().from(settingsTable).where(eq(settingsTable.key, key)).get();
  return row?.value ?? DEFAULTS[key];
}

export function getNumericSetting(key: SettingsKey): number {
  return Number(getSetting(key));
}

export function getAllSettings(): Record<string, string> {
  const rows = db.select().from(settingsTable).all();
  const result: Record<string, string> = { ...DEFAULTS };
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

export function updateSettings(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    db.insert(settingsTable)
      .values({ key, value })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value } })
      .run();
  }
}

export function isConfigured(): boolean {
  const row = db.select().from(settingsTable).where(eq(settingsTable.key, "SETUP_COMPLETE")).get();
  return row?.value === "1";
}
