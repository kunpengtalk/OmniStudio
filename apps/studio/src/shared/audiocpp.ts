/**
 * audio.cpp TTS 引擎的共享常量（主进程与 webview 共用）。
 */
export const AUDIOCPP_REPO = "audio-cpp/audio.cpp-gguf";

/** 引擎发布版本（对应 GitHub Release 标签）。 */
export const AUDIOCPP_ENGINE_VERSION = "v0.7.3";

/** 语言码 → 显示名（用于本地 TTS 的语言下拉）。 */
export const AUDIOCPP_LANG_LABELS: Record<string, string> = {
  "zh": "中文",
  "yue": "粤语",
  "en": "English",
  "ja": "日本語",
  "ko": "한국어",
  "fr": "Français",
  "de": "Deutsch",
  "es": "Español",
  "ru": "Русский",
  "pt": "Português",
  "pt-BR": "Português (BR)",
  "it": "Italiano",
  "ar": "العربية",
  "ar-AE": "العربية (AE)",
  "ar-MSA": "العربية (MSA)",
  "ar-SA": "العربية (SA)",
  "hi": "हिन्दी",
  "vi": "Tiếng Việt",
  "tr": "Türkçe",
  "uk": "Українська",
  "nl": "Nederlands",
  "pl": "Polski",
  "sv": "Svenska",
  "da": "Dansk",
  "fi": "Suomi",
  "no": "Norsk",
  "cs": "Čeština",
  "el": "Ελληνικά",
  "hu": "Magyar",
  "id": "Bahasa Indonesia",
  "ro": "Română",
  "sk": "Slovenčina",
  "sl": "Slovenščina",
  "et": "Eesti",
  "lv": "Latviešu",
  "lt": "Lietuvių",
  "hr": "Hrvatski",
  "bg": "Български",
};

