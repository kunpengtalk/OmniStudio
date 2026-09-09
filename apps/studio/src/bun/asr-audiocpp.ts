import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "fs";
import path from "path";
import { getSetting, updateSettings } from "./db/settings";
import { installedModelSize, isModelInstalled, localModelPath } from "./modelscope";
import { AUDIOCPP_REPO } from "../shared/audiocpp";
import { getAudioBaseDir } from "./voice";
import { languageCode, resolveBackend, resolveBinary, toWav } from "./tts-local";

/**
 * audio.cpp ASR 本地引擎。
 *
 * 与 TTS 共用同一个 `audiocpp_cli` 二进制，用 `--task asr` 单次调用转写：
 *
 *   audiocpp_cli --task asr --family <family> --model <model.gguf>
 *     --backend metal --audio <in.wav> --text-out out.txt
 *
 * ASR 模型（单文件 GGUF，内嵌配置/tokenizer）统一托管在 HuggingFace 仓库
 * audio-cpp/audio.cpp-gguf，下载走 downloadManager 的 "huggingface" 源；
 * 推理二进制随 GitHub Release 发布，与 TTS 引擎是同一个，复用 tts-local 的
 * 下载/解析逻辑。模型清单来自官方文档 docs/asr.md（v0.7.3 已支持 --task asr）。
 */

export type AsrAudioCppModel = {
  id: string;
  name: string;
  /** 传给 audiocpp_cli 的 --family。 */
  family: string;
  /** 仓库内模型文件路径（含子目录）。 */
  repoPath: string;
  sizeBytes: number;
  languages: string[];
  description: string;
};

/**
 * audio.cpp-gguf 仓库中精选的 ASR 模型（单文件 GGUF，下载即用）。
 * 文件名/大小已对照仓库实际文件核对；family 来自 audio.cpp 官方 model_specs。
 */
export const AUDIOCPP_ASR_CATALOG: AsrAudioCppModel[] = [
  {
    id: "fun-asr-nano",
    name: "Fun-ASR-Nano 2512",
    family: "fun_asr_nano",
    repoPath: "Fun-ASR-Nano-2512-GGUF/fun-asr-nano-2512-q8_0.gguf",
    sizeBytes: 1_045_334_432,
    languages: ["中文", "English", "日本語"],
    description: "阿里 FunASR 多语言识别（中/英/日），自动语言选择，离线转写。",
  },
  {
    id: "qwen3-asr-0.6b",
    name: "Qwen3-ASR 0.6B",
    family: "qwen3_asr",
    repoPath: "Qwen3-ASR-0.6B-GGUF/qwen3-asr-0.6b-q8_0.gguf",
    sizeBytes: 1_151_272_416,
    languages: ["中文", "English", "日本語", "한국어"],
    description: "通义 Qwen3-ASR 0.6B 多语言识别（80+ 语言），轻量快速。",
  },
  {
    id: "qwen3-asr-1.7b",
    name: "Qwen3-ASR 1.7B",
    family: "qwen3_asr",
    repoPath: "Qwen3-ASR-1.7B-GGUF/qwen3-asr-1.7b-q8_0.gguf",
    sizeBytes: 2_473_010_048,
    languages: ["中文", "English", "日本語", "한국어"],
    description: "通义 Qwen3-ASR 1.7B 多语言识别（80+ 语言），准确度更高。",
  },
  {
    id: "citrinet-asr",
    name: "Citrinet ASR",
    family: "citrinet_asr",
    repoPath: "Citrinet-ASR-GGUF/citrinet-asr-q8_0.gguf",
    sizeBytes: 40_574_432,
    languages: ["English"],
    description: "NVIDIA 轻量 CTC 识别（英语），体积极小、速度最快。",
  },
  {
    id: "kroko-asr-en",
    name: "Kroko Community ASR",
    family: "kroko_asr",
    repoPath: "Kroko-ASR-GGUF/kroko-en-community-64-l-q8_0.gguf",
    sizeBytes: 167_756_928,
    languages: ["English"],
    description: "社区 Zipformer2/RNN-T 英语模型，支持流式与自然文本热词。",
  },
  {
    id: "nemotron-asr",
    name: "Nemotron 3.5 ASR 0.6B",
    family: "nemotron_asr",
    repoPath: "Nemotron-3.5-ASR-Streaming-0.6B-GGUF/nemotron-3.5-asr-streaming-0.6b-q8_0.gguf",
    sizeBytes: 930_620_256,
    languages: ["English", "中文", "日本語", "한국어", "Deutsch", "Français", "Español", "Italiano", "Português", "Русский", "Nederlands"],
    description: "NVIDIA Nemotron 3.5 RNNT 识别，支持多语言与单词时间戳。",
  },
  {
    id: "parakeet-tdt",
    name: "Parakeet-TDT 0.6B v3",
    family: "parakeet_tdt",
    repoPath: "Parakeet-TDT-0.6B-v3-GGUF/parakeet-tdt-0.6b-v3-q8_0.gguf",
    sizeBytes: 915_733_744,
    languages: ["English", "中文", "日本語", "한국어", "Español", "Français", "Deutsch", "Italiano", "Português", "Nederlands", "العربية", "Русский"],
    description: "NVIDIA FastConformer-TDT 多语言识别，支持长音频与流式。",
  },
  {
    id: "granite-speech-ctc",
    name: "Granite Speech 5.0 TurboCTC",
    family: "granite5asr",
    repoPath: "Granite-Speech-5.0-470M-TurboCTC-GGUF/granite-speech-5.0-470m-turboctc-q8_0.gguf",
    sizeBytes: 504_717_376,
    languages: ["English", "Deutsch", "Français", "Español", "Italiano", "Português", "हिन्दी", "العربية", "日本語", "한국어"],
    description: "IBM Granite Speech 5.0 470M TurboCTC 识别（10 种语言）。",
  },
  {
    id: "higgs-stt",
    name: "Higgs Audio v3 STT",
    family: "higgs_audio_stt",
    repoPath: "Higgs-Audio-v3-STT-GGUF/higgs-audio-v3-stt-q8_0.gguf",
    sizeBytes: 3_158_310_848,
    languages: ["English", "中文", "日本語"],
    description: "Higgs Audio v3 STT 转写，支持离线/流式与长音频自动分块。",
  },
  {
    id: "vibevoice-asr",
    name: "VibeVoice ASR",
    family: "vibevoice_asr",
    repoPath: "VibeVoice-ASR-GGUF/vibevoice-asr-q8_0.gguf",
    sizeBytes: 9_858_644_224,
    languages: ["English", "中文", "日本語", "한국어", "Deutsch", "Français", "Español", "Português", "Русский"],
    description: "VibeVoice 高精度离线识别，支持分段/说话人时间戳输出。",
  },
  {
    id: "hviske-asr",
    name: "Hviske v5.3 ASR",
    family: "hviske_asr",
    repoPath: "Hviske-v5.3-GGUF/hviske-v5.3-q8_0.gguf",
    sizeBytes: 2_438_636_064,
    languages: ["Dansk"],
    description: "Cohere Hviske 丹麦语离线识别。",
  },
  {
    id: "voxtral-realtime",
    name: "Voxtral Mini 4B Realtime",
    family: "voxtral_realtime",
    repoPath: "Voxtral-Mini-4B-Realtime-2602-GGUF/voxtral-mini-4b-realtime-2602-q8_0.gguf",
    sizeBytes: 5_104_567_264,
    languages: ["English", "Français", "Deutsch", "Español", "Italiano", "Português", "日本語", "한국어", "中文"],
    description: "Mistral Voxtral Mini 4B 实时识别，支持离线/流式。",
  },
];

export type AsrAudioCppModelInfo = AsrAudioCppModel & {
  downloaded: boolean;
  installedSize: number | null;
  installedPath: string | null;
  active: boolean;
};

export type AsrAudioCppStatus = {
  engineInstalled: boolean;
  binaryPath: string | null;
  /** ASR 引擎是否切到 audio.cpp（ASR_ENGINE === "audiocpp"）。 */
  active: boolean;
  activeModelId: string | null;
  activeModelPath: string | null;
};

function modelEntry(id: string): AsrAudioCppModel | undefined {
  return AUDIOCPP_ASR_CATALOG.find((m) => m.id === id);
}

function resolveModelPath(modelId: string | null | undefined): string | null {
  if (!modelId) return null;
  const entry = modelEntry(modelId);
  if (!entry) return null;
  const p = localModelPath(AUDIOCPP_REPO, entry.repoPath);
  return existsSync(p) ? p : null;
}

export function listAsrAudioCppModels(): AsrAudioCppModelInfo[] {
  const activeModel = getSetting("ASR_AUDIOCPP_MODEL");
  const active = getSetting("ASR_ENGINE") === "audiocpp";
  return AUDIOCPP_ASR_CATALOG.map((m) => {
    const p = localModelPath(AUDIOCPP_REPO, m.repoPath);
    const downloaded = isModelInstalled(AUDIOCPP_REPO, m.repoPath);
    return {
      ...m,
      downloaded,
      installedSize: downloaded ? installedModelSize(AUDIOCPP_REPO, m.repoPath) : null,
      installedPath: downloaded ? p : null,
      active: active && downloaded && activeModel === m.id,
    };
  });
}

export async function getAsrAudioCppStatus(): Promise<AsrAudioCppStatus> {
  const bin = await resolveBinary();
  const active = getSetting("ASR_ENGINE") === "audiocpp";
  const modelId = getSetting("ASR_AUDIOCPP_MODEL") || null;
  return {
    engineInstalled: !!bin,
    binaryPath: bin,
    active,
    activeModelId: active ? modelId : null,
    activeModelPath: active ? resolveModelPath(modelId) : null,
  };
}

/** 启用 audio.cpp ASR 引擎并选中指定模型（whisper-server 互斥，由 RPC 层先停止）。 */
export async function startAsrAudioCpp(
  modelId: string,
): Promise<{ ok: boolean; error?: string }> {
  const entry = modelEntry(modelId);
  if (!entry) return { ok: false, error: "未知模型" };

  const modelPath = resolveModelPath(modelId);
  if (!modelPath) return { ok: false, error: "模型尚未下载，请先点击下载" };

  const bin = await resolveBinary();
  if (!bin) {
    return { ok: false, error: "未找到 audiocpp_cli，请先下载 audio.cpp 推理引擎" };
  }

  updateSettings({ ASR_ENGINE: "audiocpp", ASR_AUDIOCPP_MODEL: modelId });
  return { ok: true };
}

export async function stopAsrAudioCpp(): Promise<void> {
  updateSettings({ ASR_ENGINE: "whisper", ASR_AUDIOCPP_MODEL: "" });
}

export function deleteAsrAudioCppModel(modelId: string): { ok: boolean } {
  const entry = modelEntry(modelId);
  if (!entry) return { ok: false };
  const p = localModelPath(AUDIOCPP_REPO, entry.repoPath);
  try {
    rmSync(p, { force: true });
    // 清理空的父目录链。
    let dir = path.dirname(p);
    while (dir && dir !== path.dirname(dir)) {
      try {
        const rest = readdirSync(dir);
        if (rest.length > 0) break;
        rmSync(dir, { force: true });
        dir = path.dirname(dir);
      } catch {
        break;
      }
    }
  } catch {
    // ignore
  }
  if (getSetting("ASR_AUDIOCPP_MODEL") === modelId) {
    updateSettings({ ASR_AUDIOCPP_MODEL: "" });
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 转写
// ---------------------------------------------------------------------------

/** 若已是 PCM 单声道 16kHz WAV 直接返回原路径，否则转成 16k WAV。 */
async function ensure16kWav(src: string): Promise<string> {
  if (path.extname(src).toLowerCase() === ".wav") {
    try {
      const buf = await Bun.file(src).slice(0, 44).arrayBuffer();
      const dv = new DataView(buf);
      // RIFF/WAVE + fmt(1=PCM) + 单声道 + 16kHz + 16bit
      if (
        dv.getUint32(0, true) === 0x46464952 &&
        dv.getUint32(8, true) === 0x45564157 &&
        dv.getUint16(20, true) === 1 &&
        dv.getUint16(22, true) === 1 &&
        dv.getUint32(24, true) === 16000 &&
        dv.getUint16(34, true) === 16
      ) {
        return src;
      }
    } catch {
      // fall through to conversion
    }
  }
  return toWav(src, 16000);
}

/** 读回 cli 输出文本：优先 --text-out 文件，其次解析 stdout 的 text_output=/partial_text=。 */
function extractTranscript(outTxt: string, stdout: string): string {
  if (existsSync(outTxt)) {
    const s = readFileSync(outTxt, "utf8").trim();
    if (s) return s;
  }
  const m = /(?:^|\n)\s*text_output=\s*(.+)$/m.exec(stdout);
  if (m) {
    const s = m[1]!.trim();
    if (s) return s;
  }
  const parts = [...stdout.matchAll(/^partial_text=\s*(.*)$/gm)].map((x) => x[1]!.trim());
  if (parts.length > 0) return parts.join("");
  return "";
}

/**
 * 用 audio.cpp 本地引擎转写（输入音频会先转成 16kHz 单声道 WAV）。
 * 返回文本与模型显示名，失败抛出带 stderr 尾部的错误。
 */
export async function runAsrAudioCpp(input: {
  audioPath: string;
  model?: string;
  language?: string;
}): Promise<{ text: string; engine: string; modelLabel: string }> {
  const modelId = input.model?.trim() || getSetting("ASR_AUDIOCPP_MODEL");
  const entry = modelEntry(modelId);
  if (!entry) throw new Error("请先在本地引擎中选择一个 audio.cpp ASR 模型");
  if (getSetting("ASR_ENGINE") !== "audiocpp") {
    throw new Error("audio.cpp 引擎未启用，请先在 ASR 页切换到 audio.cpp 引擎");
  }

  const modelPath = resolveModelPath(modelId);
  if (!modelPath) throw new Error(`模型未下载：${entry.name}`);

  const bin = await resolveBinary();
  if (!bin) throw new Error("未找到 audiocpp_cli，请先下载 audio.cpp 推理引擎");

  const wavPath = await ensure16kWav(input.audioPath);
  const tmpDir = path.join(getAudioBaseDir(), "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const outBase = path.join(tmpDir, `asr-${crypto.randomUUID().slice(0, 8)}`);
  const outTxt = `${outBase}.txt`;

  const args = [
    "--task", "asr",
    "--family", entry.family,
    "--model", modelPath,
    "--backend", resolveBackend(),
    "--audio", wavPath,
    "--text-out", outTxt,
  ];
  const lang = languageCode(input.language);
  if (lang) args.push("--language", lang);

  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout =
    proc.stdout && typeof proc.stdout !== "number"
      ? await new Response(proc.stdout).text()
      : "";
  const stderr =
    proc.stderr && typeof proc.stderr !== "number"
      ? await new Response(proc.stderr).text()
      : "";
  const code = await proc.exited;

  const text = extractTranscript(outTxt, stdout);

  for (const p of [outTxt, `${outBase}.wav`]) rmSync(p, { force: true });
  if (wavPath !== input.audioPath) rmSync(wavPath, { force: true });

  if (!text) {
    throw new Error(stderr.trim().slice(-400) || `audio.cpp 转写失败（退出码 ${code}）`);
  }
  return { text, engine: "audio.cpp", modelLabel: entry.name };
}
