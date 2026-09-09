import { existsSync, mkdirSync, readdirSync, statSync } from "fs";
import path from "path";
import { getSetting, updateSettings } from "./db/settings";
import { getModelsBaseDirForRuntime } from "./model-store";
import { listEdgeVoices } from "./edge-tts";

export type TTSModelSource = "edge" | "vllm";

export type TTSCatalogEntry = {
  id: string;
  name: string;
  source: TTSModelSource;
  /** HuggingFace 仓库（source=vllm 时用于自动下载）。 */
  hfRepo?: string;
  languages: string[];
  description: string;
  approxSizeGb?: number;
  /** 是否支持声音克隆。 */
  voiceClone?: boolean;
  streaming?: boolean;
};

/**
 * 支持 vLLM（vLLM-Omni，OpenAI 兼容 /v1/audio/speech）部署的 TTS 模型。
 * 来源：docs.vllm.ai/projects/vllm-omni 官方 Speech API 文档（Supported Models）。
 * 目录是一个常量数组，后续新增模型只需在这里追加。
 */
export const TTS_MODEL_CATALOG: TTSCatalogEntry[] = [
  {
    id: "edge-tts",
    name: "Edge TTS",
    source: "edge",
    languages: ["中文", "English", "日本語", "한국어", "Français", "Deutsch", "Español", "Русский", "Italiano", "Português"],
    description: "微软 Edge 在线语音合成，完全免费、无需密钥，开箱即用。",
    streaming: false,
  },
  {
    id: "qwen3-tts-1.7b-customvoice",
    name: "Qwen3-TTS 1.7B · CustomVoice",
    source: "vllm",
    hfRepo: "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
    languages: ["中文", "English", "日本語", "한국어", "Deutsch", "Français", "Русский", "Português", "Español", "Italiano"],
    description: "通义千问 Qwen3-TTS 1.7B（预设音色 + 指令控制情绪），10 种语言，支持流式。",
    approxSizeGb: 5,
    streaming: true,
  },
  {
    id: "qwen3-tts-1.7b-base",
    name: "Qwen3-TTS 1.7B · Base",
    source: "vllm",
    hfRepo: "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
    languages: ["中文", "English", "日本語", "한국어", "Deutsch", "Français", "Русский", "Português", "Español", "Italiano"],
    description: "Qwen3-TTS 1.7B 基础版，支持声音克隆（参考音频）。",
    approxSizeGb: 5,
    voiceClone: true,
    streaming: true,
  },
  {
    id: "qwen3-tts-1.7b-voicedesign",
    name: "Qwen3-TTS 1.7B · VoiceDesign",
    source: "vllm",
    hfRepo: "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
    languages: ["中文", "English", "日本語", "한국어", "Deutsch", "Français", "Русский", "Português", "Español", "Italiano"],
    description: "Qwen3-TTS 1.7B 音色设计版，用一句自然语言描述即可生成期望的音色。",
    approxSizeGb: 5,
    streaming: true,
  },
  {
    id: "qwen3-tts-0.6b-customvoice",
    name: "Qwen3-TTS 0.6B · CustomVoice",
    source: "vllm",
    hfRepo: "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
    languages: ["中文", "English", "日本語", "한국어", "Deutsch", "Français", "Русский", "Português", "Español", "Italiano"],
    description: "Qwen3-TTS 0.6B 轻量预设音色版，速度更快、显存占用更小。",
    approxSizeGb: 3,
    streaming: true,
  },
  {
    id: "qwen3-tts-0.6b-base",
    name: "Qwen3-TTS 0.6B · Base",
    source: "vllm",
    hfRepo: "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
    languages: ["中文", "English", "日本語", "한국어", "Deutsch", "Français", "Русский", "Português", "Español", "Italiano"],
    description: "Qwen3-TTS 0.6B 轻量版，支持声音克隆。",
    approxSizeGb: 3,
    voiceClone: true,
    streaming: true,
  },
  {
    id: "s2-pro",
    name: "Fish Speech S2 Pro",
    source: "vllm",
    hfRepo: "fishaudio/s2-pro",
    languages: ["中文", "English", "日本語"],
    description: "Fish Speech S2 Pro（4B·双自回归 + DAC 编解码，44.1kHz），支持文本转语音与声音克隆。",
    approxSizeGb: 9,
    voiceClone: true,
  },
  {
    id: "voxtral-4b-tts",
    name: "Voxtral TTS 4B",
    source: "vllm",
    hfRepo: "mistralai/Voxtral-4B-TTS-2603",
    languages: ["English", "Français", "Deutsch", "Español", "Italiano", "Português", "日本語", "한국어", "中文"],
    description: "Mistral Voxtral 4B（自回归 + FlowMatching），提供预设音色。",
    approxSizeGb: 8,
  },
  {
    id: "cosyvoice3-0.5b",
    name: "CosyVoice3 0.5B",
    source: "vllm",
    hfRepo: "FunAudioLLM/Fun-CosyVoice3-0.5B-2512",
    languages: ["中文", "English"],
    description: "阿里 CosyVoice3 0.5B（两阶段 talker + flow-matching codec2wav），支持声音克隆。",
    approxSizeGb: 4,
    voiceClone: true,
  },
];

const WEIGHT_EXT = [".safetensors", ".bin", ".pt", ".pth", ".npz", ".gguf", ".onnx", ".ckpt"];

function getEnabledIds(): Set<string> {
  try {
    const raw = getSetting("TTS_ENABLED_MODELS") || "[]";
    const list = JSON.parse(raw) as string[];
    return new Set(Array.isArray(list) ? list : []);
  } catch {
    return new Set();
  }
}

export function getTTSModelsDir(): string {
  const override = getSetting("TTS_MODELS_DIR");
  if (override) return override;
  return path.join(getModelsBaseDirForRuntime(), "tts");
}

export function getTTSHttpBase(): string {
  return (getSetting("TTS_HTTP_BASE") || "").trim();
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.name === ".git") continue;
      if (e.isDirectory()) total += dirSizeBytes(full);
      else {
        try {
          total += statSync(full).size;
        } catch {}
      }
    }
  } catch {}
  return total;
}

export function isTTSModelDownloaded(entry: TTSCatalogEntry): boolean {
  if (entry.source === "edge") return true;
  if (!entry.hfRepo) return false;
  const dir = path.join(getTTSModelsDir(), entry.id);
  if (!existsSync(dir)) return false;
  // 至少有一个真实权重文件（>1MB）才认为下载完成，避免把 git-lfs 指针当作已下载。
  for (const ext of WEIGHT_EXT) {
    const found = findBigFile(dir, ext);
    if (found) return true;
  }
  return false;
}

function findBigFile(dir: string, ext: string): boolean {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.name === ".git") continue;
      if (e.isDirectory()) {
        if (findBigFile(full, ext)) return true;
      } else if (e.name.toLowerCase().endsWith(ext)) {
        try {
          if (statSync(full).size > 1024 * 1024) return true;
        } catch {}
      }
    }
  } catch {}
  return false;
}

export type TTSModelInfo = TTSCatalogEntry & {
  downloaded: boolean;
  enabled: boolean;
  sizeBytes: number;
};

export function listTTSModels(): TTSModelInfo[] {
  const enabled = getEnabledIds();
  return TTS_MODEL_CATALOG.map((entry) => {
    const dir = entry.source === "edge" ? "" : path.join(getTTSModelsDir(), entry.id);
    return {
      ...entry,
      downloaded: isTTSModelDownloaded(entry),
      enabled: entry.source === "edge" || enabled.has(entry.id),
      sizeBytes: entry.source === "edge" ? 0 : dirSizeBytes(dir),
    };
  });
}

export function enableTTSModel(id: string, enabled: boolean): void {
  const next = getEnabledIds();
  if (enabled) next.add(id);
  else next.delete(id);
  updateSettings({ TTS_ENABLED_MODELS: JSON.stringify([...next]) });
}

export function isTTSModelEnabled(id: string): boolean {
  if (id === "edge-tts") return true;
  return getEnabledIds().has(id);
}

/**
 * 自动下载模型到本地（git clone，优先国内镜像 hf-mirror，失败再走官方）。
 * 进度通过 rpc 的 modelDownloadProgress 事件推送。
 */
export async function downloadTTSModel(
  id: string,
  onProgress?: (event: { repo: string; fileName: string; progress: { received: number; total: number | null; percent: number | null } }) => void,
): Promise<{ ok: boolean; error?: string }> {
  const entry = TTS_MODEL_CATALOG.find((e) => e.id === id);
  if (!entry) return { ok: false, error: "未知模型" };
  if (entry.source === "edge") return { ok: true, error: undefined };
  if (!entry.hfRepo) return { ok: false, error: "该模型不支持自动下载" };
  if (isTTSModelDownloaded(entry)) return { ok: true };

  const dest = path.join(getTTSModelsDir(), id);
  mkdirSync(getTTSModelsDir(), { recursive: true });

  const repo = entry.hfRepo;
  const mirrors = [
    `https://hf-mirror.com/${repo}`,
    `https://huggingface.co/${repo}`,
    `https://www.modelscope.cn/models/${repo}`,
  ];
  const label = repo.split("/").pop() || repo;

  for (const mirror of mirrors) {
    onProgress?.({
      repo,
      fileName: label,
      progress: { received: 0, total: null, percent: null },
    });
    const git = Bun.spawn(["git", "clone", "--depth", "1", mirror, dest], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    git.exited.then(() => {});
    const code = await git.exited;
    if (code === 0) break;
    // 失败时清掉残留目录再试下一个镜像。
    if (existsSync(dest)) Bun.spawnSync(["rm", "-rf", dest]);
  }

  const downloaded = isTTSModelDownloaded(entry);
  onProgress?.({
    repo,
    fileName: label,
    progress: downloaded
      ? { received: dirSizeBytes(dest), total: null, percent: 100 }
      : { received: 0, total: null, percent: null },
  });

  if (!downloaded) {
    return { ok: false, error: "下载失败：所有镜像源均返回错误，请检查网络后重试" };
  }

  // 尝试补齐 git-lfs 大文件（可选，失败不算错）。
  try {
    const lfs = Bun.spawnSync(["git", "-C", dest, "lfs", "pull"], { stdout: "pipe", stderr: "pipe" });
    if (lfs.exitCode === 0) {
      onProgress?.({
        repo,
        fileName: label,
        progress: { received: dirSizeBytes(dest), total: null, percent: 100 },
      });
    }
  } catch {}

  return { ok: true };
}

export function listTTSVoicesForHttp(): { id: string; name: string; desc?: string }[] {
  // 常见 OpenAI 兼容 TTS 服务的预设音色名，多语言覆盖。
  return [
    { id: "alloy", name: "Alloy" },
    { id: "echo", name: "Echo" },
    { id: "fable", name: "Fable" },
    { id: "onyx", name: "Onyx" },
    { id: "nova", name: "Nova" },
    { id: "shimmer", name: "Shimmer" },
    { id: "coral", name: "Coral" },
    { id: "Serena", name: "Serena · 温暖女声（中文）", desc: "Qwen3-TTS 预设" },
    { id: "Uncle_Fu", name: "Uncle Fu · 沉稳男声（中文）", desc: "Qwen3-TTS 预设" },
    { id: "Dylan", name: "Dylan · 北京青年（中文）", desc: "Qwen3-TTS 预设" },
    { id: "Ryan", name: "Ryan · 英文男声", desc: "Qwen3-TTS 预设" },
    { id: "Aiden", name: "Aiden · 英文男声", desc: "Qwen3-TTS 预设" },
    { id: "Ono_Anna", name: "Ono Anna · 日文女声", desc: "Qwen3-TTS 预设" },
    { id: "Sohee", name: "Sohee · 韩文女声", desc: "Qwen3-TTS 预设" },
  ];
}

export function listEdgeTTSVoices() {
  return listEdgeVoices();
}