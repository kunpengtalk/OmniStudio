/**
 * 翻译功能共享常量（主进程与 webview 共用）。
 *
 * 翻译走当前对话模型（本地推理服务器 / OpenAI 兼容 API），语言目录在此维护：
 * code 用于前后端传递，label 为英文名（写入翻译提示语），nativeLabel 为本地语言名（界面展示）。
 */

export type TranslationLanguage = {
  code: string;
  /** 英文名（用于翻译提示语）。 */
  label: string;
  /** 本地语言名（用于界面展示）。 */
  nativeLabel: string;
};

/** 源语言支持「自动检测」。 */
export const TRANSLATION_SOURCE_AUTO = "auto";

export const TRANSLATION_LANGUAGES: readonly TranslationLanguage[] = [
  { code: "zh-CN", label: "Simplified Chinese", nativeLabel: "简体中文" },
  { code: "zh-TW", label: "Traditional Chinese", nativeLabel: "繁體中文" },
  { code: "en", label: "English", nativeLabel: "English" },
  { code: "ja", label: "Japanese", nativeLabel: "日本語" },
  { code: "ko", label: "Korean", nativeLabel: "한국어" },
  { code: "fr", label: "French", nativeLabel: "Français" },
  { code: "de", label: "German", nativeLabel: "Deutsch" },
  { code: "es", label: "Spanish", nativeLabel: "Español" },
  { code: "pt", label: "Portuguese", nativeLabel: "Português" },
  { code: "it", label: "Italian", nativeLabel: "Italiano" },
  { code: "ru", label: "Russian", nativeLabel: "Русский" },
  { code: "ar", label: "Arabic", nativeLabel: "العربية" },
  { code: "hi", label: "Hindi", nativeLabel: "हिन्दी" },
  { code: "vi", label: "Vietnamese", nativeLabel: "Tiếng Việt" },
  { code: "th", label: "Thai", nativeLabel: "ไทย" },
  { code: "id", label: "Indonesian", nativeLabel: "Bahasa Indonesia" },
  { code: "nl", label: "Dutch", nativeLabel: "Nederlands" },
  { code: "tr", label: "Turkish", nativeLabel: "Türkçe" },
  { code: "pl", label: "Polish", nativeLabel: "Polski" },
  { code: "uk", label: "Ukrainian", nativeLabel: "Українська" },
  { code: "cs", label: "Czech", nativeLabel: "Čeština" },
  { code: "el", label: "Greek", nativeLabel: "Ελληνικά" },
];

export function translationLangLabel(code: string): string {
  const lang = TRANSLATION_LANGUAGES.find((l) => l.code === code);
  return lang ? `${lang.label} (${lang.nativeLabel})` : code;
}

/** 语言代码缩写（用于历史记录列表的语言对徽标）：zh-CN → ZH、auto → AUTO。 */
export function translationLangShort(code: string): string {
  if (code === TRANSLATION_SOURCE_AUTO) return "AUTO";
  const base = code.split("-")[0] ?? code;
  return base.toUpperCase();
}
