import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, appendFileSync } from "fs";
import path from "path";
import { getSetting, updateSettings } from "./db/settings";
import { getDataDir } from "./paths";
import {
  installedModelSize,
  isModelInstalled,
  localModelPath,
} from "./modelscope";
import { AUDIOCPP_REPO, AUDIOCPP_ENGINE_VERSION } from "../shared/audiocpp";

/** 通话 TTS 调试日志（便于排查无声问题）。 */
const CALL_TTS_LOG = "/tmp/omni-voicecall.log";
function callTtsLog(line: string): void {
  try {
    appendFileSync(CALL_TTS_LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // 日志失败不影响主流程
  }
}
import {
  getAudioBaseDir,
  insertVoiceRecord,
  listVoiceClones,
  resolveAudioPath,
  voiceRecordToRow,
  type VoiceRecordRow,
} from "./voice";

/**
 * audio.cpp TTS 本地引擎。
 *
 * audio.cpp（github.com/0xShug0/audio.cpp）是 ggml 系纯 C++ 音频推理引擎，
 * 支持多种 TTS 模型。其 GGUF 模型（内嵌 sidecar + package spec）统一托管在
 * HuggingFace 仓库 audio-cpp/audio.cpp-gguf，用 `audiocpp_cli` 单次调用合成：
 *
 *   audiocpp_cli --task tts --family <family> --model <model.gguf>
 *     --backend metal --text "..." [--voice-id M1] [--language en] --out out.wav
 *
 * 因为该仓库不在 ModelScope 上，模型下载走 HuggingFace 镜像（downloadManager
 * 的 "huggingface" 源）；推理二进制随 GitHub Release 发布，可一键下载到本地。
 */


export type TtsLocalVoiceKind = "auto" | "preset" | "design" | "emotion" | "clone";

export type TtsLocalModel = {
  id: string;
  name: string;
  family: string;
  task: "tts" | "vdes" | "clon";
  /** 仓库内模型文件路径（含子目录）。 */
  repoPath: string;
  approxSizeGb: number;
  languages: string[];
  description: string;
  /** 音色获取方式，决定 TTS 页如何提供 voice 参数。 */
  voiceKind: TtsLocalVoiceKind;
  /** voiceKind === "preset" 时的内置音色。 */
  presetVoices?: { id: string; name: string }[];
  /** 默认音色（preset / emotion）。 */
  defaultVoice?: string;
  /** voiceKind === "emotion" 时的可选情绪。 */
  emotions?: string[];
  /** 是否必须提供参考音频（clone 类模型）。 */
  requiresVoiceRef?: boolean;
  /** 是否支持 --language 语言提示。 */
  languageSupported?: boolean;
  /** 模型支持的 --language 语言码列表（用于生成语言下拉）。 */
  languageCodes?: string[];
};

/**
 * audio.cpp-gguf 仓库中精选的 TTS 模型（单文件 GGUF，下载即用）。
 * 音色/语言信息来自 audio.cpp 官方文档（docs/tts.md 与 docs/models/*）。
 */
export const AUDIOCPP_TTS_CATALOG: TtsLocalModel[] = [
  {
    id: "index-tts2-5",
    name: "IndexTTS2.5",
    family: "index_tts2",
    task: "clon",
    repoPath: "IndexTTS2.5-GGUF/index-tts2_5-q8_0.gguf",
    approxSizeGb: 3.26,
    languages: ["中文", "English", "日本語", "Español", "العربية"],
    description: "IndexTTS2.5 中/英/日/西/阿 多语言零样本克隆，支持情绪控制与语速调节（duration_factor）。",
    voiceKind: "clone",
    requiresVoiceRef: true,

    languageSupported: true,
    languageCodes: ["zh", "en", "ja", "es", "ar"],
  },
  {
    id: "qwen3-tts-1.7b-customvoice",
    name: "Qwen3-TTS 1.7B · CustomVoice",
    family: "qwen3_tts",
    task: "tts",
    repoPath: "Qwen3-TTS-12Hz-1.7B-CustomVoice-GGUF/qwen3-tts-12hz-1.7b-customvoice-q8_0.gguf",
    approxSizeGb: 2.82,
    languages: ["中文", "English", "日本語", "한국어", "Deutsch", "Français", "Русский", "Português", "Español", "Italiano"],
    description: "Qwen3-TTS 1.7B 预设音色版，内置 Vivian / Ryan 等音色，中文效果好。",
    voiceKind: "preset",
    presetVoices: [
      { id: "Vivian", name: "Vivian" },
      { id: "Ryan", name: "Ryan" },
    ],
    defaultVoice: "Vivian",

    languageSupported: true,
    languageCodes: ["zh", "en", "ja", "ko", "de", "fr", "ru", "pt", "es", "it"],
  },
  {
    id: "qwen3-tts-1.7b-voicedesign",
    name: "Qwen3-TTS 1.7B · VoiceDesign",
    family: "qwen3_tts",
    task: "vdes",
    repoPath: "Qwen3-TTS-12Hz-1.7B-VoiceDesign-GGUF/qwen3-tts-12hz-1.7b-voicedesign-q8_0.gguf",
    approxSizeGb: 2.82,
    languages: ["中文", "English", "日本語", "한국어", "Deutsch", "Français", "Русский", "Português", "Español", "Italiano"],
    description: "Qwen3-TTS 1.7B 音色设计版，用一句自然语言描述即可生成期望音色。",
    voiceKind: "design",
    defaultVoice: "请用温暖的成年女声播报",

    languageSupported: true,
    languageCodes: ["zh", "en", "ja", "ko", "de", "fr", "ru", "pt", "es", "it"],
  },
  {
    id: "qwen3-tts-1.7b-base",
    name: "Qwen3-TTS 1.7B · Base",
    family: "qwen3_tts",
    task: "tts",
    repoPath: "Qwen3-TTS-12Hz-1.7B-Base-GGUF/qwen3-tts-12hz-1.7b-base-q8_0_v2.gguf",
    approxSizeGb: 2.7,
    languages: ["中文", "English", "日本語", "한국어", "Deutsch", "Français", "Русский", "Português", "Español", "Italiano"],
    description: "Qwen3-TTS 1.7B 基础版，使用参考音频进行声音克隆。",
    voiceKind: "clone",
    requiresVoiceRef: true,

    languageSupported: true,
    languageCodes: ["zh", "en", "ja", "ko", "de", "fr", "ru", "pt", "es", "it"],
  },
  {
    id: "qwen3-tts-0.6b-base",
    name: "Qwen3-TTS 0.6B · Base",
    family: "qwen3_tts",
    task: "tts",
    repoPath: "Qwen3-TTS-12Hz-0.6B-Base-GGUF/qwen3-tts-12hz-0.6b-base-q8_0.gguf",
    approxSizeGb: 1.99,
    languages: ["中文", "English", "日本語", "한국어", "Deutsch", "Français", "Русский", "Português", "Español", "Italiano"],
    description: "Qwen3-TTS 0.6B 轻量克隆版，速度更快、资源占用更小。",
    voiceKind: "clone",
    requiresVoiceRef: true,

    languageSupported: true,
    languageCodes: ["zh", "en", "ja", "ko", "de", "fr", "ru", "pt", "es", "it"],
  },
  {
    id: "omnivoice",
    name: "OmniVoice",
    family: "omnivoice",
    task: "tts",
    repoPath: "OmniVoice-GGUF/omnivoice-q8_0.gguf",
    approxSizeGb: 1.35,
    languages: ["中文", "English", "日本語", "한국어", "Français", "Deutsch", "Español", "Русский", "Português", "Italiano"],
    description: "OpenBMB OmniVoice，600+ 语言，无需参考音频即可合成，也支持音色描述。",
    voiceKind: "design",
    defaultVoice: "",

    languageSupported: true,
    languageCodes: ["zh", "en", "ja", "ko", "fr", "de", "es", "ru", "pt", "it"],
  },
  {
    id: "supertonic-3",
    name: "Supertonic 3",
    family: "supertonic",
    task: "tts",
    repoPath: "Supertonic-3-GGUF/supertonic-3-q8_0.gguf",
    approxSizeGb: 0.45,
    languages: ["English", "한국어", "日本語", "Deutsch", "Français", "Español", "Русский", "Português", "Italiano", "العربية"],
    description: "多语言预设音色小模型（M1–M5 / F1–F5），体积小、启动快。",
    voiceKind: "preset",
    presetVoices: [
      { id: "M1", name: "M1 · 男声 1" },
      { id: "M2", name: "M2 · 男声 2" },
      { id: "M3", name: "M3 · 男声 3" },
      { id: "M4", name: "M4 · 男声 4" },
      { id: "M5", name: "M5 · 男声 5" },
      { id: "F1", name: "F1 · 女声 1" },
      { id: "F2", name: "F2 · 女声 2" },
      { id: "F3", name: "F3 · 女声 3" },
      { id: "F4", name: "F4 · 女声 4" },
      { id: "F5", name: "F5 · 女声 5" },
    ],
    defaultVoice: "M1",

    languageSupported: true,
    languageCodes: ["en", "ko", "ja", "ar", "de", "fr", "es", "ru", "pt", "it", "hi", "vi", "tr", "uk", "nl", "pl", "sv", "da", "fi", "no", "cs", "el", "hu", "id", "ro", "sk", "sl", "et", "lv", "lt", "hr", "bg"],
  },
  {
    id: "neutts-2e",
    name: "NeuTTS 2E",
    family: "neutts",
    task: "tts",
    repoPath: "NeuTTS-2E-GGUF/neutts-2e-orig.gguf",
    approxSizeGb: 3.02,
    languages: ["English"],
    description: "英文人声 + 情绪控制（happy / sad / angry 等），带内置说话人音色。",
    voiceKind: "emotion",
    presetVoices: [
      { id: "emily", name: "Emily" },
      { id: "paul", name: "Paul" },
      { id: "sophie", name: "Sophie" },
      { id: "dave", name: "Dave" },
      { id: "jo", name: "Jo" },
      { id: "juliette", name: "Juliette" },
      { id: "mateo", name: "Mateo" },
      { id: "greta", name: "Greta" },
      { id: "steven", name: "Steven" },
    ],
    defaultVoice: "emily",
    emotions: ["neutral", "happy", "sad", "angry", "fearful", "surprised", "disgusted"],
    languageSupported: false,
  },
  {
    id: "magpie-tts-357m",
    name: "MagpieTTS 357M",
    family: "magpie_tts",
    task: "tts",
    repoPath: "MagpieTTS-Multilingual-357M-GGUF/magpie-tts-multilingual-357m-q8_0.gguf",
    approxSizeGb: 1.56,
    languages: ["中文", "English", "Deutsch", "Français", "Español", "Italiano", "한국어", "Português", "العربية", "Hindi", "Tiếng Việt"],
    description: "NVIDIA 多语言 TTS（12 语言），内置多组说话人音色，轻量快速。",
    voiceKind: "preset",
    presetVoices: [
      { id: "Sofia", name: "Sofia" },
      { id: "Jason", name: "Jason" },
      { id: "0", name: "默认 0" },
      { id: "1", name: "Speaker 1" },
      { id: "2", name: "Speaker 2" },
    ],
    defaultVoice: "Sofia",

    languageSupported: true,
    languageCodes: ["en", "de", "es", "fr", "hi", "it", "ko", "pt-BR", "vi", "zh", "ar-AE", "ar-MSA", "ar-SA"],
  },
  {
    id: "moss-tts-nano-100m",
    name: "MOSS-TTS-Nano 100M",
    family: "moss_tts_nano",
    task: "tts",
    repoPath: "MOSS-TTS-Nano-100M-GGUF/moss-tts-nano-100m-q8_0.gguf",
    approxSizeGb: 0.19,
    languages: ["中文", "English", "日本語", "한국어", "Français", "Deutsch", "Español"],
    description: "OpenMOSS 轻量多语言 TTS，无需参考音频即可合成，100M 参数极速。",
    voiceKind: "auto",

    languageSupported: false,
  },
  {
    id: "cosyvoice3",
    name: "CosyVoice3 0.5B",
    family: "cosyvoice3",
    task: "clon",
    repoPath: "CosyVoice3-GGUF/cosyvoice3-q8_0.gguf",
    approxSizeGb: 2.26,
    languages: ["中文", "English"],
    description: "阿里 CosyVoice3（两阶段 talker + flow-matching），需参考音频克隆。",
    voiceKind: "clone",
    requiresVoiceRef: true,
    languageSupported: true,
    languageCodes: ["zh", "en", "ja", "ko", "de", "es", "fr", "it", "ru", "yue"],
  },
  {
    id: "index-tts2",
    name: "IndexTTS2",
    family: "index_tts2",
    task: "clon",
    repoPath: "IndexTTS2-GGUF/index-tts2-q8_0.gguf",
    approxSizeGb: 3.63,
    languages: ["中文", "English"],
    description: "IndexTTS2 中英双语克隆模型，支持情绪控制。",
    voiceKind: "clone",
    requiresVoiceRef: true,

    languageSupported: true,
    languageCodes: ["zh", "en"],
  },
];

export type TtsLocalModelInfo = TtsLocalModel & {
  downloaded: boolean;
  installedSize: number | null;
  installedPath: string | null;
  active: boolean;
};

export type TtsLocalStatus = {
  engineInstalled: boolean;
  binaryPath: string | null;
  backend: "metal" | "cpu" | "vulkan" | "cuda";
  active: boolean;
  activeModelId: string | null;
  activeModelPath: string | null;
  version: string;
};


function getEnginesDir(): string {
  return getDataDir("engines", "audiocpp");
}

function getEngineBinDir(): string {
  return path.join(getEnginesDir(), AUDIOCPP_ENGINE_VERSION);
}

function getBundledBinPath(): string {
  return path.join(getEngineBinDir(), "audiocpp_cli");
}

function getSearchPath(): string {
  const home = process.env.HOME ?? "";
  const extra = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    home ? `${home}/.local/bin` : "",
    home ? `${home}/bin` : "",
  ];
  const current = process.env.PATH ?? "";
  return [...extra, current].join(":");
}

async function findOnPath(): Promise<string | null> {
  const p = Bun.which("audiocpp_cli", { PATH: getSearchPath() });
  return p ?? null;
}

/** 找到可用的 audiocpp_cli：优先随应用下载的引擎，其次 PATH（brew 等）。 */
export async function resolveBinary(): Promise<string | null> {
  try {
    const bundled = getBundledBinPath();
    if (existsSync(bundled)) return bundled;
  } catch {}
  return await findOnPath();
}

export function resolveBackend(): TtsLocalStatus["backend"] {
  if (process.platform === "darwin") return "metal";
  return "cpu";
}

/** GitHub Release 资产：当前平台 -> 下载文件名。 */
function releaseAssetName(): string | null {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return `audio-${AUDIOCPP_ENGINE_VERSION}-bin-macos-arm64-metal.tar.gz`;
  }
  if (process.platform === "darwin") {
    return `audio-${AUDIOCPP_ENGINE_VERSION}-bin-macos-x64-metal.tar.gz`;
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return `audio-${AUDIOCPP_ENGINE_VERSION}-bin-ubuntu-x64-cpu.tar.gz`;
  }
  return null;
}

export async function getTtsLocalStatus(): Promise<TtsLocalStatus> {
  const bin = await resolveBinary();
  const active = getSetting("TTS_LOCAL_ENGINE") === "audio.cpp";
  const modelId = getSetting("TTS_LOCAL_MODEL");
  return {
    engineInstalled: !!bin,
    binaryPath: bin,
    backend: resolveBackend(),
    active,
    activeModelId: active ? modelId || null : null,
    activeModelPath: active ? resolveModelPath(modelId) : null,
    version: AUDIOCPP_ENGINE_VERSION,
  };
}

function modelEntry(id: string): TtsLocalModel | undefined {
  return AUDIOCPP_TTS_CATALOG.find((m) => m.id === id);
}

function resolveModelPath(modelId: string | null | undefined): string | null {
  if (!modelId) return null;
  const entry = modelEntry(modelId);
  if (!entry) return null;
  const p = localModelPath(AUDIOCPP_REPO, entry.repoPath);
  return existsSync(p) ? p : null;
}

function isModelDownloaded(entry: TtsLocalModel): boolean {
  return isModelInstalled(AUDIOCPP_REPO, entry.repoPath);
}

export function listTtsLocalModels(): TtsLocalModelInfo[] {
  const activeModel = getSetting("TTS_LOCAL_MODEL");
  return AUDIOCPP_TTS_CATALOG.map((m) => {
    const path = localModelPath(AUDIOCPP_REPO, m.repoPath);
    const downloaded = isModelDownloaded(m);
    return {
      ...m,
      downloaded,
      installedSize: downloaded ? installedModelSize(AUDIOCPP_REPO, m.repoPath) : null,
      installedPath: downloaded ? path : null,
      active: downloaded && activeModel === m.id,
    };
  });
}

/** 下载 audio.cpp 推理引擎二进制（GitHub Release，多镜像回退）。 */
export async function downloadTtsLocalEngine(): Promise<{ ok: boolean; error?: string }> {
  const existing = await resolveBinary();
  if (existing) return { ok: true };

  const asset = releaseAssetName();
  if (!asset) {
    return {
      ok: false,
      error: "当前平台暂不支持自动下载 audio.cpp 引擎，请手动安装 audiocpp_cli 并加入 PATH",
    };
  }

  const gh = `https://github.com/0xShug0/audio.cpp/releases/download/${AUDIOCPP_ENGINE_VERSION}/${asset}`;
  // 国内镜像（GitHub 加速），依次回退。
  const mirrors = [
    gh,
    `https://gh-proxy.com/${gh}`,
    `https://ghfast.top/${gh}`,
  ];

  mkdirSync(getEnginesDir(), { recursive: true });
  const tmpTgz = path.join(getEnginesDir(), `.${asset}`);
  const targetDir = getEngineBinDir();
  mkdirSync(targetDir, { recursive: true });

  let lastError = "";
  for (const url of mirrors) {
    try {
      const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(600_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await Bun.write(tmpTgz, res);
      const tar = Bun.spawnSync(["tar", "-xzf", tmpTgz, "-C", targetDir], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (tar.exitCode !== 0) throw new Error(tar.stderr.toString().slice(-200));
      if (existsSync(path.join(targetDir, "audiocpp_cli"))) {
        chmodSync(path.join(targetDir, "audiocpp_cli"), 0o755);
        rmSync(tmpTgz, { force: true });
        return { ok: true };
      }
      throw new Error("解压后未找到 audiocpp_cli");
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      // 清掉可能的残留，换下一个镜像。
      rmSync(tmpTgz, { force: true });
      rmSync(targetDir, { recursive: true, force: true });
      mkdirSync(targetDir, { recursive: true });
    }
  }
  return { ok: false, error: `audio.cpp 引擎下载失败：${lastError}` };
}

/** 启动/切换本地 TTS 引擎到指定模型（下载完成后即可点击启动）。 */
export async function startTtsLocal(
  modelId: string,
): Promise<{ ok: boolean; error?: string }> {
  const entry = modelEntry(modelId);
  if (!entry) return { ok: false, error: "未知模型" };

  const modelPath = resolveModelPath(modelId);
  if (!modelPath) return { ok: false, error: "模型尚未下载，请先点击下载" };

  const bin = await resolveBinary();
  if (!bin) {
    return {
      ok: false,
      error: "未找到 audiocpp_cli，请先下载 audio.cpp 推理引擎",
    };
  }

  updateSettings({ TTS_LOCAL_ENGINE: "audio.cpp", TTS_LOCAL_MODEL: modelId });
  return { ok: true };
}

export async function stopTtsLocal(): Promise<void> {
  updateSettings({ TTS_LOCAL_ENGINE: "", TTS_LOCAL_MODEL: "" });
}

export function isTtsLocalActive(): boolean {
  return getSetting("TTS_LOCAL_ENGINE") === "audio.cpp";
}

export function activeTtsLocalModelId(): string | null {
  return getSetting("TTS_LOCAL_MODEL") || null;
}

// ---------------------------------------------------------------------------
// 合成
// ---------------------------------------------------------------------------

/** 传入语言码（空 = 自动），校验后返回，供 --language 使用。 */
export function languageCode(language?: string): string {
  if (!language) return "";
  return /^[a-z]{2}(-[A-Z]{2})?$/.test(language.trim()) ? language.trim() : "";
}

/**
 * 把任意音频文件转成单声道 PCM WAV（audio.cpp 的 --voice-ref / --audio 只接受 WAV）。
 * `rate` 指定采样率：TTS 参考音频用 44100，ASR 输入用 16000。
 */
export async function toWav(src: string, rate = 44100): Promise<string> {
  const tmpDir = path.join(getAudioBaseDir(), "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const out = path.join(tmpDir, `ref-${crypto.randomUUID().slice(0, 8)}.wav`);

  const ffmpeg = Bun.which("ffmpeg", { PATH: getSearchPath() });
  if (ffmpeg) {
    const p = Bun.spawnSync([ffmpeg, "-y", "-i", src, "-ar", String(rate), "-ac", "1", out], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (p.exitCode === 0 && existsSync(out)) return out;
  }
  // macOS 自带 afconvert。
  if (process.platform === "darwin") {
    const p = Bun.spawnSync(
      ["afconvert", "-f", "WAVE", "-d", `LEI16@${rate}`, "-c", "1", src, out],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (p.exitCode === 0 && existsSync(out)) return out;
  }
  throw new Error("需要 ffmpeg 才能把音频转为 WAV（macOS 上也可用自带 afconvert）");
}

function buildMergedArgs(
  entry: TtsLocalModel,
  text: string,
  outPath: string,
  opts: { voice?: string; emotion?: string; language?: string; voiceRef?: string; instruct?: string },
): string[] {
  const backend = resolveBackend();
  const args = [
    "--task", entry.task,
    "--family", entry.family,
    "--model", localModelPath(AUDIOCPP_REPO, entry.repoPath),
    "--backend", backend,
    "--text", text,
    "--out", outPath,
  ];

  switch (entry.voiceKind) {
    case "preset":
      if (opts.voice) {
        if (entry.family === "supertonic") args.push("--voice-id", opts.voice);
        else if (entry.family === "qwen3_tts") args.push("--speaker", opts.voice);
        else args.push("--request-option", `voice_id=${opts.voice}`);
      }
      break;
    case "emotion":
      if (opts.voice) args.push("--request-option", `voice_id=${opts.voice}`);
      if (opts.emotion) args.push("--request-option", `emotion=${opts.emotion}`);
      break;
    case "design":
      if (opts.instruct && opts.instruct.trim()) args.push("--instruct", opts.instruct.trim());
      break;
    case "clone":
      if (opts.voiceRef) args.push("--voice-ref", opts.voiceRef);
      break;
    case "auto":
      break;
  }

  const lang = languageCode(opts.language);
  // Qwen3-TTS 运行时自行从文本检测语言，不接受 --language（会报 unsupported language）。
  const supportsLangFlag = entry.languageSupported !== false && entry.family !== "qwen3_tts";
  if (lang && supportsLangFlag) args.push("--language", lang);

  return args;
}

export async function runTTSLocal(input: {
  text: string;
  model?: string;
  voice?: string;
  emotion?: string;
  language?: string;
  instruct?: string;
}): Promise<VoiceRecordRow> {
  const modelId = input.model?.trim() || getSetting("TTS_LOCAL_MODEL");
  const entry = modelEntry(modelId);
  if (!entry) return Promise.reject(new Error("请先在本地引擎中选择一个已启动的 TTS 模型"));
  if (!isTtsLocalActive()) {
    return Promise.reject(new Error("本地引擎未启动，请先点击「启动」"));
  }

  const modelPath = resolveModelPath(modelId);
  if (!modelPath) return Promise.reject(new Error(`模型未下载：${entry.name}`));

  const bin = await resolveBinary();
  if (!bin) return Promise.reject(new Error("未找到 audiocpp_cli，请先下载 audio.cpp 推理引擎"));

  // 克隆类模型需要参考音频（优先用声音克隆页保存的音频）。
  let voiceRef: string | undefined;
  if (entry.requiresVoiceRef) {
    if (input.voice) {
      const clone = listVoiceClones().find((c) => c.name === input.voice);
      const ref = clone?.refAudioPath
        ? resolveAudioPath(clone.refAudioPath)
        : null;
      if (!ref || !existsSync(ref)) {
        return Promise.reject(new Error("找不到所选克隆音色的参考音频"));
      }
      voiceRef = path.extname(ref).toLowerCase() === ".wav" ? ref : await toWav(ref);
    } else {
      return Promise.reject(new Error("该模型需要参考音频，请先在「声音克隆」页创建一个克隆音色"));
    }
  }

  const outName = `tts-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.wav`;
  const outPath = path.join(getAudioBaseDir(), outName);

  const args = buildMergedArgs(entry, input.text, outPath, {
    voice: input.voice,
    emotion: input.emotion,
    language: input.language,
    voiceRef,
    instruct: input.instruct ?? input.voice,
  });

  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
  const stderr =
    proc.stderr && typeof proc.stderr !== "number"
      ? await new Response(proc.stderr).text()
      : "";
  const code = await proc.exited;

  if (code !== 0 || !existsSync(outPath) || statSync(outPath).size < 1000) {
    rmSync(outPath, { force: true });
    const tail = stderr.trim().slice(-500);
    return Promise.reject(new Error(`本地合成失败（退出码 ${code}）${tail ? `：${tail}` : ""}`));
  }

  const record = insertVoiceRecord({
    kind: "tts",
    model: `${entry.name} (audio.cpp)`,
    voice: input.voice ?? null,
    text: input.text,
    audioPath: `audio/${outName}`,
  });
  return voiceRecordToRow(record);
}

/** 通话可用的本地 TTS 模型，按优先级排序（支持中文且已下载 → 逐个兜底）。 */
function callLocalCandidates(): TtsLocalModel[] {
  const downloaded = AUDIOCPP_TTS_CATALOG.filter(
    (m) => !m.requiresVoiceRef && isModelDownloaded(m),
  );
  const supportsZh = (m: TtsLocalModel) => m.languages.some((l) => l.includes("中文"));
  const activeId = getSetting("TTS_LOCAL_MODEL");
  const active = downloaded.find((m) => m.id === activeId);
  const ordered: TtsLocalModel[] = [];
  if (active && supportsZh(active)) ordered.push(active);
  for (const id of ["qwen3-tts-1.7b-customvoice", "moss-tts-nano-100m"]) {
    const m = downloaded.find((x) => x.id === id);
    if (m && !ordered.includes(m)) ordered.push(m);
  }
  for (const m of downloaded) {
    if (supportsZh(m) && !ordered.includes(m)) ordered.push(m);
  }
  for (const m of downloaded) {
    if (!ordered.includes(m)) ordered.push(m);
  }
  return ordered;
}

/** 用指定模型合成一句（失败返回 null，不抛错）。 */
async function synthesizeCallOne(
  entry: TtsLocalModel,
  text: string,
  bin: string,
): Promise<Buffer | null> {
  const outName = `call-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.wav`;
  const outPath = path.join(getAudioBaseDir(), outName);
  const args = buildMergedArgs(entry, text.trim(), outPath, {
    voice: entry.defaultVoice ?? undefined,
    language: languageCode(getSetting("ASR_LANG")) || undefined,
  });

  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
  const stderr =
    proc.stderr && typeof proc.stderr !== "number"
      ? await new Response(proc.stderr).text()
      : "";
  const code = await proc.exited;
  if (code !== 0 || !existsSync(outPath) || statSync(outPath).size < 1000) {
    const size = existsSync(outPath) ? statSync(outPath).size : 0;
    rmSync(outPath, { force: true });
    callTtsLog(`synthesize ${entry.id} FAILED code=${code} size=${size} stderr=${stderr.trim().slice(-300)}`);
    return null;
  }
  const buffer = Buffer.from(await Bun.file(outPath).arrayBuffer());
  rmSync(outPath, { force: true });
  callTtsLog(`synthesize ${entry.id} OK ${buffer.byteLength}B (${text.length} chars)`);
  return buffer;
}

/**
 * 通话逐句本地合成（不落库）：先用已下载的本地 audio.cpp TTS 模型逐个尝试，
 * 全部失败才返回 null（由调用方回退到远程 provider / Edge）。
 * 本地合成无网络往返，首字延迟远低于远程。
 */
export async function synthesizeCallLocal(text: string): Promise<Buffer | null> {
  const bin = await resolveBinary();
  if (!bin) return null;
  for (const entry of callLocalCandidates()) {
    try {
      const buf = await synthesizeCallOne(entry, text, bin);
      if (buf) return buf;
    } catch {
      // 该模型异常，尝试下一个可用模型。
    }
  }
  return null;
}

// 清理遗留的模型目录辅助（删除已下载模型文件）。
export function deleteTtsLocalModel(modelId: string): { ok: boolean } {
  const entry = modelEntry(modelId);
  if (!entry) return { ok: false };
  const p = localModelPath(AUDIOCPP_REPO, entry.repoPath);
  try {
    rmSync(p, { force: true });
    // 清理空的父目录链（可选）。
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
  if (getSetting("TTS_LOCAL_MODEL") === modelId) {
    updateSettings({ TTS_LOCAL_MODEL: "" });
  }
  return { ok: true };
}
