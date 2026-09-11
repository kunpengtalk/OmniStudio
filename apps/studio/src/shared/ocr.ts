/**
 * OCR 本地引擎共享常量（主进程与 webview 共用）。
 *
 * 本地 OCR 引擎采用 Tesseract（纯 C++ 实现的 OCR 引擎），模型即语言包：
 * 每个 `<code>.traineddata` 对应一种语言的 LSTM 模型，托管在 GitHub
 * `tesseract-ocr/tessdata_fast`（体积小、速度快，适合桌面应用随用随下）。
 *
 * 同时保留「VLM 服务」路径：把图片送到当前推理服务器（llama.cpp / vLLM /
 * OpenAI 兼容）上的视觉语言模型（Chandra / GLM-OCR / LightOnOCR 等）做
 * 版面识别与内容提取，走现有的 vLLM pipeline。
 */

/** tessdata_fast 仓库（GitHub raw 下载根地址）。 */
export const OCR_TESSDATA_REPO = "tesseract-ocr/tessdata_fast";
export const OCR_TESSDATA_RAW_BASE = `https://github.com/${OCR_TESSDATA_REPO}/raw/main/`;

export type OcrEngineType = "tesseract" | "vlm" | "paddleocr";

/** PP-OCRv6 模型档位（决定加载哪套官方模型）。 */
export type PpOcrModelSize = "tiny" | "small" | "medium";

/**
 * PP-OCRv6 档位目录：tiny / small / medium。
 * medium 为官方默认档（约 140MB，34.5M 参数，精度最高），small / tiny 更轻更快。
 */
export const PPOCR_MODEL_OPTIONS: readonly {
  value: PpOcrModelSize;
  labelKey: string;
  /** 展示用模型体积（近似，识别 + 检测模型合计）。 */
  sizeLabel: string;
}[] = [
  { value: "medium", labelKey: "ocr.paddleocr.size.medium", sizeLabel: "≈ 140 MB" },
  { value: "small", labelKey: "ocr.paddleocr.size.small", sizeLabel: "≈ 30 MB" },
  { value: "tiny", labelKey: "ocr.paddleocr.size.tiny", sizeLabel: "≈ 10 MB" },
];

/** 页面分割模式（--psm）。 */
export const OCR_PSM_MODES: { value: string; labelKey: string }[] = [
  { value: "3", labelKey: "ocr.psm.auto" },
  { value: "1", labelKey: "ocr.psm.osd" },
  { value: "6", labelKey: "ocr.psm.block" },
  { value: "7", labelKey: "ocr.psm.line" },
  { value: "11", labelKey: "ocr.psm.sparse" },
  { value: "13", labelKey: "ocr.psm.rawline" },
];

export type OcrLangModel = {
  /** 语言码（= traineddata 文件名，如 eng / chi_sim）。 */
  id: string;
  /** 显示名（本地语言）。 */
  name: string;
  /** 所属文字体系/分组。 */
  script: string;
  /** 覆盖的主要语言。 */
  languages: string[];
  /** tessdata_fast 中的文件大小（字节）。 */
  sizeBytes: number;
  description: string;
};

/**
 * Tesseract 支持的 OCR 语言模型目录（tessdata_fast，尺寸为仓库实际文件大小，
 * 2026-09 核对）。覆盖中文/日文/韩文/拉丁/西里尔/阿拉伯/希伯来/印度诸语等
 * 主要文字体系，每项为单一语言包，下载后即可选择识别。
 */
export const OCR_LANG_CATALOG: readonly OcrLangModel[] = [
  // 中文 / CJK
  { id: "chi_sim", name: "简体中文", script: "CJK", languages: ["中文（简体）"], sizeBytes: 2_469_156, description: "简体中文识别（含中文标点与常用汉字）。" },
  { id: "chi_tra", name: "繁體中文", script: "CJK", languages: ["中文（繁體）"], sizeBytes: 2_366_642, description: "繁體中文識別（港台用字）。" },
  { id: "jpn", name: "日本語", script: "CJK", languages: ["日文"], sizeBytes: 2_471_260, description: "日文识别（平假名/片假名/汉字混排）。" },
  { id: "kor", name: "한국어", script: "CJK", languages: ["韩文"], sizeBytes: 1_677_415, description: "韩文识别（谚文与汉字）。" },
  // 拉丁（西欧 / 通用）
  { id: "eng", name: "English", script: "Latin", languages: ["英语"], sizeBytes: 4_113_088, description: "英文与纯拉丁字符识别，最常用模型。" },
  { id: "spa", name: "Español", script: "Latin", languages: ["西班牙语"], sizeBytes: 2_294_433, description: "西班牙语（拉美/欧洲）识别。" },
  { id: "fra", name: "Français", script: "Latin", languages: ["法语"], sizeBytes: 1_130_365, description: "法语识别。" },
  { id: "deu", name: "Deutsch", script: "Latin", languages: ["德语"], sizeBytes: 1_525_436, description: "德语识别。" },
  { id: "ita", name: "Italiano", script: "Latin", languages: ["意大利语"], sizeBytes: 2_701_314, description: "意大利语识别。" },
  { id: "por", name: "Português", script: "Latin", languages: ["葡萄牙语"], sizeBytes: 1_982_756, description: "葡萄牙语（含巴西葡语）识别。" },
  { id: "nld", name: "Nederlands", script: "Latin", languages: ["荷兰语"], sizeBytes: 6_050_296, description: "荷兰语识别。" },
  { id: "cat", name: "Català", script: "Latin", languages: ["加泰罗尼亚语"], sizeBytes: 1_146_012, description: "加泰罗尼亚语识别。" },
  { id: "ind", name: "Indonesia", script: "Latin", languages: ["印尼语"], sizeBytes: 1_122_661, description: "印尼语识别。" },
  { id: "vie", name: "Tiếng Việt", script: "Latin", languages: ["越南语"], sizeBytes: 531_275, description: "越南语识别。" },
  { id: "glg", name: "Galego", script: "Latin", languages: ["加利西亚语"], sizeBytes: 2_554_555, description: "加利西亚语识别。" },
  { id: "eus", name: "Euskara", script: "Latin", languages: ["巴斯克语"], sizeBytes: 5_175_921, description: "巴斯克语识别。" },
  { id: "slk", name: "Slovenčina", script: "Latin", languages: ["斯洛伐克语"], sizeBytes: 4_427_661, description: "斯洛伐克语识别。" },
  { id: "slv", name: "Slovenščina", script: "Latin", languages: ["斯洛文尼亚语"], sizeBytes: 3_003_829, description: "斯洛文尼亚语识别。" },
  { id: "hrv", name: "Hrvatski", script: "Latin", languages: ["克罗地亚语"], sizeBytes: 4_103_348, description: "克罗地亚语识别。" },
  { id: "sqi", name: "Shqip", script: "Latin", languages: ["阿尔巴尼亚语"], sizeBytes: 1_874_705, description: "阿尔巴尼亚语识别。" },
  // 中欧 / 东欧（拉丁）
  { id: "pol", name: "Polski", script: "Latin / Acad", languages: ["波兰语"], sizeBytes: 4_765_518, description: "波兰语识别。" },
  { id: "ces", name: "Čeština", script: "Latin / Acad", languages: ["捷克语"], sizeBytes: 3_795_684, description: "捷克语识别。" },
  { id: "hun", name: "Magyar", script: "Latin / Acad", languages: ["匈牙利语"], sizeBytes: 5_296_273, description: "匈牙利语识别。" },
  { id: "ron", name: "Română", script: "Latin / Acad", languages: ["罗马尼亚语"], sizeBytes: 2_376_323, description: "罗马尼亚语识别。" },
  { id: "tur", name: "Türkçe", script: "Latin / Acad", languages: ["土耳其语"], sizeBytes: 4_550_554, description: "土耳其语识别。" },
  // 北欧
  { id: "swe", name: "Svenska", script: "Nordic", languages: ["瑞典语"], sizeBytes: 4_167_034, description: "瑞典语识别。" },
  { id: "dan", name: "Dansk", script: "Nordic", languages: ["丹麦语"], sizeBytes: 2_580_059, description: "丹麦语识别。" },
  { id: "nor", name: "Norsk", script: "Nordic", languages: ["挪威语"], sizeBytes: 3_610_079, description: "挪威语识别。" },
  { id: "fin", name: "Suomi", script: "Nordic", languages: ["芬兰语"], sizeBytes: 7_865_732, description: "芬兰语识别。" },
  // 西里尔
  { id: "rus", name: "Русский", script: "Cyrillic", languages: ["俄语"], sizeBytes: 3_861_738, description: "俄语识别。" },
  { id: "ukr", name: "Українська", script: "Cyrillic", languages: ["乌克兰语"], sizeBytes: 3_825_102, description: "乌克兰语识别。" },
  // 阿拉伯 / 希伯来 / 波斯
  { id: "ara", name: "العربية", script: "Arabic", languages: ["阿拉伯语"], sizeBytes: 1_432_056, description: "阿拉伯语（从右向左）识别。" },
  { id: "fas", name: "فارسی", script: "Arabic", languages: ["波斯语"], sizeBytes: 431_500, description: "波斯语（法尔斯语）识别。" },
  { id: "urd", name: "اردو", script: "Arabic", languages: ["乌尔都语"], sizeBytes: 1_398_718, description: "乌尔都语识别。" },
  { id: "heb", name: "עברית", script: "Hebrew", languages: ["希伯来语"], sizeBytes: 961_404, description: "希伯来语（从右向左）识别。" },
  // 印度诸语
  { id: "hin", name: "हिन्दी", script: "Indic", languages: ["印地语"], sizeBytes: 1_122_751, description: "印地语识别。" },
  { id: "ben", name: "বাংলা", script: "Indic", languages: ["孟加拉语"], sizeBytes: 855_841, description: "孟加拉语识别。" },
  { id: "tam", name: "தமிழ்", script: "Indic", languages: ["泰米尔语"], sizeBytes: 3_237_963, description: "泰米尔语识别。" },
  { id: "tel", name: "తెలుగు", script: "Indic", languages: ["泰卢固语"], sizeBytes: 2_769_654, description: "泰卢固语识别。" },
  { id: "kan", name: "ಕನ್ನಡ", script: "Indic", languages: ["卡纳达语"], sizeBytes: 3_608_331, description: "卡纳达语识别。" },
  { id: "mal", name: "മലയാളം", script: "Indic", languages: ["马拉雅拉姆语"], sizeBytes: 5_275_996, description: "马拉雅拉姆语识别。" },
  { id: "mar", name: "मराठी", script: "Indic", languages: ["马拉地语"], sizeBytes: 2_118_233, description: "马拉地语识别。" },
  { id: "guj", name: "ગુજરાતી", script: "Indic", languages: ["古吉拉特语"], sizeBytes: 1_418_394, description: "古吉拉特语识别。" },
  { id: "pan", name: "ਪੰਜਾਬੀ", script: "Indic", languages: ["旁遮普语"], sizeBytes: 497_721, description: "旁遮普语识别。" },
  // 希腊 / 泰语
  { id: "ell", name: "Ελληνικά", script: "Greek", languages: ["希腊语"], sizeBytes: 1_419_514, description: "希腊语识别。" },
  { id: "tha", name: "ไทย", script: "Thai", languages: ["泰语"], sizeBytes: 1_072_600, description: "泰语识别。" },
  // 方向检测
  { id: "osd", name: "方向与脚本检测", script: "Utility", languages: ["OSD"], sizeBytes: 10_562_727, description: "页面方向/文字行方向检测模型（配合 --psm 0/1）。" },
];

export function ocrLangEntry(id: string): OcrLangModel | undefined {
  return OCR_LANG_CATALOG.find((m) => m.id === id);
}
