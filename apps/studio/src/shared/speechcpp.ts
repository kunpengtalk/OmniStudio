/**
 * speech.cpp 本地 TTS 引擎的共享常量（主进程与 webview 共用）。
 *
 * speech.cpp（github.com/nyosegawa/speech.cpp）是 ggml 系的语音推理引擎，
 * 一个 `speech` 二进制同时做合成、识别与 VAD。这里只用它的 TTS 侧：
 *
 *   speech tts <model.gguf> --voice <name> --language <tag> -o out.wav "<text>"
 *
 * 与 audio.cpp 的分工：两者都是「本地 TTS 引擎」，由 `TTS_LOCAL_ENGINE` 二选一，
 * 各自对应自己那份模型清单（audio.cpp 的模型都在 audio-cpp/audio.cpp-gguf 一个仓库里，
 * speech.cpp 的模型一个仓库一个）。模型权重不随引擎切换而删除：换引擎只是换推理后端。
 *
 * 与 audio.cpp 的另一个差别是配置文件格式：speech.cpp 的 GGUF 是它自己的布局
 * （llama.cpp / Ollama 读不了），所以模型清单必须逐条给出仓库与文件名，不能靠文件名猜。
 */

/**
 * 引擎发布版本。资产名用不带 v 的版本号（`speech-0.8.8-macos-arm64-metal.zip`），
 * Release 标签才是 `v0.8.8` —— 两者都要拼对，拼错的表现是 404 之后一路换镜像。
 */
export const SPEECHCPP_ENGINE_VERSION = "0.8.8";

/** GitHub Release 标签。 */
export const SPEECHCPP_RELEASE_TAG = `v${SPEECHCPP_ENGINE_VERSION}`;

/** 引擎仓库（GitHub Release 与 install.sh 都指向它）。 */
export const SPEECHCPP_REPO = "nyosegawa/speech.cpp";

/** TTS 本地引擎的选择值（`TTS_LOCAL_ENGINE` 的第二取值）。 */
export const SPEECHCPP_ENGINE_ID = "speech.cpp";

/** 托管目录名（`<dataDir>/engines/speechcpp`）。 */
export const SPEECHCPP_ENGINE_DIR = "speechcpp";

/** 克隆音色文件（`speech voice` 的产物）落在托管目录下的子目录。 */
export const SPEECHCPP_VOICES_SUBDIR = "voices";

/** 语言码 → 显示名（与 audio.cpp 同一套写法，键是 BCP-47 短码）。 */
export const SPEECHCPP_LANG_LABELS: Record<string, string> = {
  zh: "中文",
  en: "English",
  ja: "日本語",
  ko: "한국어",
  de: "Deutsch",
  fr: "Français",
  es: "Español",
  it: "Italiano",
  pt: "Português",
  ru: "Русский",
};

/**
 * Qwen3-TTS 的九个内置音色（名称即 `--voice` 的取值，不能翻译、不能改写大小写）。
 * 语言是每个音色自带的母语，请求的 `--language` 决定它读什么语言。
 */
export const SPEECHCPP_QWEN3_SPEAKERS: readonly {
  id: string;
  name: string;
  language: string;
  gender: "male" | "female";
  description: string;
}[] = [
  {
    id: "vivian",
    name: "Vivian",
    language: "zh",
    gender: "female",
    description: "明亮年轻女声（中文）",
  },
  {
    id: "serena",
    name: "Serena",
    language: "zh",
    gender: "female",
    description: "温暖柔和年轻女声（中文）",
  },
  {
    id: "uncle_fu",
    name: "Uncle Fu",
    language: "zh",
    gender: "male",
    description: "沉稳醇厚男声（中文）",
  },
  {
    id: "dylan",
    name: "Dylan",
    language: "zh",
    gender: "male",
    description: "北京青年男声（中文）",
  },
  { id: "eric", name: "Eric", language: "zh", gender: "male", description: "成都活力男声（中文）" },
  {
    id: "ryan",
    name: "Ryan",
    language: "en",
    gender: "male",
    description: "有节奏感的动态男声（英文）",
  },
  {
    id: "aiden",
    name: "Aiden",
    language: "en",
    gender: "male",
    description: "阳光美式男声（英文）",
  },
  {
    id: "ono_anna",
    name: "Ono Anna",
    language: "ja",
    gender: "female",
    description: "俏皮日文女声",
  },
  { id: "sohee", name: "Sohee", language: "ko", gender: "female", description: "温暖韩文女声" },
];

/** Qwen3-TTS 支持的语言码（`--language`，缺省 auto 由文本推断）。 */
export const SPEECHCPP_QWEN3_LANGUAGES = [
  "zh",
  "en",
  "ja",
  "ko",
  "de",
  "fr",
  "es",
  "it",
  "pt",
  "ru",
];

/**
 * 音色获取方式，决定 TTS 页给哪一组控件：
 *  - `preset`     —— 从 `presetVoices` 里挑一个（`--voice <name>`）。
 *  - `described`  —— 参考音频（先 `speech voice` 生成音色文件，再 `--add-voice`）**或**
 *                    一句话描述（`--voice none --instructions "…"`），两者都可选。
 */
export type SpeechCppVoiceKind = "preset" | "described";

export type SpeechCppTtsModel = {
  id: string;
  name: string;
  /** HuggingFace 仓库（每个模型一个仓库，与 audio.cpp 的单仓库不同）。 */
  repo: string;
  /** 仓库内文件路径。这些资产直接放在仓库根目录，所以就是文件名。 */
  repoPath: string;
  /** 文件字节数（对照仓库实际大小，用于展示与下载口径）。 */
  sizeBytes: number;
  languages: string[];
  description: string;
  voiceKind: SpeechCppVoiceKind;
  /** voiceKind === "preset" 时的内置音色。 */
  presetVoices?: { id: string; name: string }[];
  /** 默认音色（preset 用）。 */
  defaultVoice?: string;
  /** 是否接受 `--language`。 */
  languageSupported?: boolean;
  /** 支持的语言码（生成语言下拉）。 */
  languageCodes?: string[];
  /**
   * 是否接受 `--instructions`（"怎么念"的文字说明）。**必须逐模型标对**：
   * speech.cpp 会拒绝模型不认识的请求项（Qwen3-TTS 只有 1.7B 认这条，Drama 3 明确拒绝），
   * 多传一个就是一个合成失败。
   */
  supportsInstruct?: boolean;
  /** 单次请求最长语音（秒）；超过时 speech.cpp 会自动按句/逗号切分。 */
  maxSecondsPerRequest?: number;
  /** 模型权重许可页（权重许可与代码许可不同，界面上给一条链过去）。 */
  licenseUrl?: string;
};

/**
 * speech.cpp 里可用的 TTS 模型（Q8_0 / Q4_K 之外还有 F16 等，这里只收录官方推荐档位：
 * 体积与效果平衡得最好的那一档）。文件与大小已逐个对照仓库实际文件核对。
 */
export const SPEECHCPP_TTS_CATALOG: readonly SpeechCppTtsModel[] = [
  {
    id: "qwen3-tts-0.6b",
    name: "Qwen3-TTS 0.6B · speech.cpp",
    repo: "sakasegawa/Qwen3-TTS-12Hz-0.6B-CustomVoice-GGUF",
    repoPath: "Qwen3-TTS-12Hz-0.6B-CustomVoice-Q8_0.gguf",
    sizeBytes: 1_213_534_464,
    languages: [
      "中文",
      "English",
      "日本語",
      "한국어",
      "Deutsch",
      "Français",
      "Español",
      "Italiano",
      "Português",
      "Русский",
    ],
    description:
      "通义 Qwen3-TTS 0.6B 预设音色版，9 个内置音色、10 种语言，边生成边出声（首帧 0.08s）。",
    voiceKind: "preset",
    presetVoices: SPEECHCPP_QWEN3_SPEAKERS.map((s) => ({ id: s.id, name: s.name })),
    defaultVoice: "vivian",
    languageSupported: true,
    languageCodes: SPEECHCPP_QWEN3_LANGUAGES,
    // 0.6B 不认 --instructions（只有 1.7B 接受），传了会被拒绝。
    supportsInstruct: false,
    licenseUrl: "https://huggingface.co/sakasegawa/Qwen3-TTS-12Hz-0.6B-CustomVoice-GGUF",
  },
  {
    id: "qwen3-tts-1.7b",
    name: "Qwen3-TTS 1.7B · speech.cpp",
    repo: "sakasegawa/Qwen3-TTS-12Hz-1.7B-CustomVoice-GGUF",
    repoPath: "Qwen3-TTS-12Hz-1.7B-CustomVoice-Q8_0.gguf",
    sizeBytes: 2_287_780_352,
    languages: [
      "中文",
      "English",
      "日本語",
      "한국어",
      "Deutsch",
      "Français",
      "Español",
      "Italiano",
      "Português",
      "Русский",
    ],
    description:
      "同上的 1.7B 版：音色更稳、韵律更好，并支持用一句话说明「怎么念」（--instructions）。",
    voiceKind: "preset",
    presetVoices: SPEECHCPP_QWEN3_SPEAKERS.map((s) => ({ id: s.id, name: s.name })),
    defaultVoice: "vivian",
    languageSupported: true,
    languageCodes: SPEECHCPP_QWEN3_LANGUAGES,
    supportsInstruct: true,
    licenseUrl: "https://huggingface.co/sakasegawa/Qwen3-TTS-12Hz-1.7B-CustomVoice-GGUF",
  },
  {
    id: "irodori-tts-mf",
    name: "Irodori-TTS v4.1 Small MF · speech.cpp",
    repo: "sakasegawa/Irodori-TTS-v4.1-Small-MF-GGUF",
    repoPath: "Irodori-TTS-866M-MF-v4.1-Q8_0.gguf",
    sizeBytes: 1_207_133_984,
    languages: ["日本語"],
    description:
      "日文 TTS（MeanFlow 4 步采样，最快的一档）。给参考录音做音色克隆，或直接用一句话描述音色。",
    voiceKind: "described",
    languageSupported: true,
    languageCodes: ["ja"],
    maxSecondsPerRequest: 30,
    supportsInstruct: true,
    licenseUrl: "https://huggingface.co/sakasegawa/Irodori-TTS-v4.1-Small-MF-GGUF",
  },
  {
    id: "irodori-tts",
    name: "Irodori-TTS v4.1 Small · speech.cpp",
    repo: "sakasegawa/Irodori-TTS-v4.1-Small-GGUF",
    repoPath: "Irodori-TTS-859M-v4.1-Q8_0.gguf",
    sizeBytes: 1_199_474_528,
    languages: ["日本語"],
    description:
      "同上的标准采样版（40 步）：音质更好、速度慢一些，同样支持参考录音克隆与音色描述。",
    voiceKind: "described",
    languageSupported: true,
    languageCodes: ["ja"],
    maxSecondsPerRequest: 30,
    supportsInstruct: true,
    licenseUrl: "https://huggingface.co/sakasegawa/Irodori-TTS-v4.1-Small-GGUF",
  },
  {
    id: "irodori-tts-large",
    name: "Irodori-TTS v4 Large · speech.cpp",
    repo: "sakasegawa/Irodori-TTS-v4-Large-GGUF",
    repoPath: "Irodori-TTS-3.4B-v4-Q8_0.gguf",
    sizeBytes: 3_875_154_272,
    languages: ["日本語"],
    description: "日文 TTS 的 3.4B 大模型版，表现力最好、显存占用最高。",
    voiceKind: "described",
    languageSupported: true,
    languageCodes: ["ja"],
    maxSecondsPerRequest: 30,
    supportsInstruct: true,
    licenseUrl: "https://huggingface.co/sakasegawa/Irodori-TTS-v4-Large-GGUF",
  },
  {
    id: "drama-3",
    name: "Drama 3 (35B-A3B) · speech.cpp",
    repo: "sakasegawa/drama-3-GGUF",
    repoPath: "Drama-35B-A3B-v3-Q4_K.gguf",
    sizeBytes: 20_787_264_352,
    languages: [
      "中文",
      "English",
      "日本語",
      "한국어",
      "Deutsch",
      "Français",
      "Español",
      "Italiano",
      "Português",
      "Русский",
      "等 83 种",
    ],
    description:
      "Fish Audio Drama 3（35B MoE，3B 激活）：一场戏最多 16 个说话人，说话人直接写在正文里（`<|speaker:0|>`…`<|speaker:15|>`，第一个标签之前算 0 号），笑声/叹气等提示也写在正文里，83 种语言。文件 20.8 GB、加载较慢；显存不够时专家留 CPU（引擎默认）。不认「怎么念」的描述，也不按 language 参数切换语言（语言从正文推断）。",
    voiceKind: "described",
    // 它接受 --language 但只是校验、不据它切换（元数据里 steers=false），
    // 83 种语言的下拉也没有意义：不给下拉，也就不发这条参数。
    languageSupported: false,
    supportsInstruct: false,
    licenseUrl: "https://huggingface.co/sakasegawa/drama-3-GGUF",
  },
];

export function speechCppModelEntry(
  modelId: string | null | undefined,
): SpeechCppTtsModel | undefined {
  return SPEECHCPP_TTS_CATALOG.find((m) => m.id === modelId) ?? undefined;
}

/** 模型许可（权重许可与代码许可不同，界面上给一条路到仓库）。 */
export function speechCppLicenseUrl(model: SpeechCppTtsModel): string {
  return model.licenseUrl ?? `https://huggingface.co/${model.repo}`;
}
