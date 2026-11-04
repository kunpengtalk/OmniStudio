/**
 * 本地引擎目录 —— 「这台机器上装了哪些本地运行时」的唯一真源。
 *
 * 之前每个功能各自管自己的引擎（引导页装 llama.cpp / vLLM / SGLang / MLX，语音页装
 * whisper.cpp 与 audio.cpp，OCR 页装 PaddleOCR 与 Tesseract，图片页装 mflux），
 * 「装了哪些、占了多少、怎么卸」散在四个页面里。这里把身份（id / 分类 / 文案键）
 * 收成一份，状态探测与安装卸载落在 `bun/engine-catalog.ts`，界面只剩渲染。
 *
 * 文本推理四个引擎的 id 沿用 `shared/engines.ts` 的 `InferenceEngine`：
 * 同一个东西在两处叫两个名字，迟早会在某个 switch 里对不上。
 */

import { ENGINE_IDS, type InferenceEngine } from "./engines";
import type { VerifyReason } from "../bun/install-manifest";

export type LocalEngineId =
  | InferenceEngine
  | "whisper.cpp"
  | "audio.cpp"
  | "speech.cpp"
  | "paddleocr"
  | "tesseract"
  | "mflux"
  | "laya-mlx"
  | "cloudflared";

/**
 * 界面上的分组。voice / ocr / image 对应三个功能页，inference 是文本推理，
 * network 只有一个 cloudflared —— 它不是 AI 引擎，但同样是「应用自己下载的二进制」，
 * 升级与卸载的口径一致，所以放在同一页里一起管。
 */
export type LocalEngineCategory = "inference" | "voice" | "ocr" | "image" | "systemone" | "network";

export const LOCAL_ENGINE_CATEGORIES: readonly LocalEngineCategory[] = [
  "inference",
  "voice",
  "ocr",
  "image",
  // 类型化判定（SystemOne / JEV）：laya-mlx 是"判定模型"，不是聊天模型 ——
  // 混进 inference 那一组会让人以为它能拿去对话。
  "systemone",
  "network",
];

/** 这个引擎的模型权重在哪儿管（null = 没有独立权重，或是系统引擎自己管）。 */
export type LocalEngineModelsTarget =
  | "local-models"
  | "voice"
  | "ocr"
  | "image"
  /** JEV 页（`app/jev/`）：判定模型的权重在那里下 / 起 / 停。 */
  | "jev"
  | null;

export type LocalEngineSpec = {
  id: LocalEngineId;
  category: LocalEngineCategory;
  /** 品牌名，不翻译（llama.cpp / vLLM / …），与模型列表里的引擎短名同规矩。 */
  name: string;
  /** 这个引擎是干什么的（i18n）。 */
  roleKey: string;
  /** 谁在用它（i18n）。 */
  usedByKey: string;
  /** 手动安装命令；一键安装不下来时用户还有这条路。系统引擎只有这一条路。 */
  installHint: string | null;
  /** 手动卸载命令；应用不接管的（系统包管理器装的）引擎靠它。 */
  uninstallHint: string | null;
  /**
   * 应用能不能提供"自己托管的那份"。Tesseract 是唯一的例外：它只存在于用户的
   * Homebrew 里，应用能做的只是替你跑一次 `brew install` —— 界面上因此不给
   * 「装一份托管的」这种承诺，也不给"升级"按钮（那只会再跑一次同样的 brew 命令）。
   */
  managedSupported: boolean;
  /** 权重在哪个页面管理（界面上的「管理模型」按钮）。 */
  modelsTarget: LocalEngineModelsTarget;
};

/**
 * 全部本地引擎（声明顺序即界面顺序：同分类内按这里的先后排）。
 *
 * 新增一个引擎 = 这里加一条 + `bun/engine-catalog.ts` 里加一个适配器，
 * 界面的分组、按钮、文案都从这两处派生。
 */
export const LOCAL_ENGINE_SPECS: readonly LocalEngineSpec[] = [
  {
    id: "llama.cpp",
    category: "inference",
    name: "llama.cpp",
    roleKey: "engines.llamacpp.role",
    usedByKey: "engines.llamacpp.usedBy",
    installHint: "brew install llama.cpp",
    uninstallHint: null,
    managedSupported: true,
    modelsTarget: "local-models",
  },
  {
    id: "vllm",
    category: "inference",
    name: "vLLM",
    roleKey: "engines.vllm.role",
    usedByKey: "engines.vllm.usedBy",
    installHint: "pip install vllm",
    uninstallHint: null,
    managedSupported: true,
    modelsTarget: "local-models",
  },
  {
    id: "sglang",
    category: "inference",
    name: "SGLang",
    roleKey: "engines.sglang.role",
    usedByKey: "engines.sglang.usedBy",
    installHint: "pip install 'sglang[all]'",
    uninstallHint: null,
    managedSupported: true,
    modelsTarget: "local-models",
  },
  {
    id: "mlx",
    category: "inference",
    name: "MLX (mlx-lm)",
    roleKey: "engines.mlx.role",
    usedByKey: "engines.mlx.usedBy",
    installHint: "pip install -U mlx-lm",
    uninstallHint: null,
    managedSupported: true,
    modelsTarget: "local-models",
  },
  {
    // oMLX 是 Homebrew 公式 / 官方 .dmg 安装的独立服务器，应用能把安装命令自动化，
    // 但那份软件归 Homebrew 所有，应用不接管卸载（与 tesseract 同口径）。
    id: "omlx",
    category: "inference",
    name: "oMLX",
    roleKey: "engines.omlx.role",
    usedByKey: "engines.omlx.usedBy",
    installHint: "brew tap jundot/omlx https://github.com/jundot/omlx && brew install jundot/omlx/omlx",
    uninstallHint: "brew uninstall omlx",
    managedSupported: false,
    modelsTarget: "local-models",
  },
  {
    id: "whisper.cpp",
    category: "voice",
    name: "whisper.cpp",
    roleKey: "engines.whispercpp.role",
    usedByKey: "engines.whispercpp.usedBy",
    installHint: "brew install whisper-cpp",
    uninstallHint: null,
    managedSupported: true,
    modelsTarget: "voice",
  },
  {
    id: "audio.cpp",
    category: "voice",
    name: "audio.cpp",
    roleKey: "engines.audiocpp.role",
    usedByKey: "engines.audiocpp.usedBy",
    installHint: null,
    uninstallHint: null,
    managedSupported: true,
    modelsTarget: "voice",
  },
  {
    id: "speech.cpp",
    category: "voice",
    name: "speech.cpp",
    roleKey: "engines.speechcpp.role",
    usedByKey: "engines.speechcpp.usedBy",
    installHint: null,
    uninstallHint: null,
    managedSupported: true,
    modelsTarget: "voice",
  },
  {
    id: "paddleocr",
    category: "ocr",
    name: "PaddleOCR",
    roleKey: "engines.paddleocr.role",
    usedByKey: "engines.paddleocr.usedBy",
    installHint: null,
    uninstallHint: null,
    managedSupported: true,
    modelsTarget: "ocr",
  },
  {
    id: "tesseract",
    category: "ocr",
    name: "Tesseract",
    roleKey: "engines.tesseract.role",
    usedByKey: "engines.tesseract.usedBy",
    installHint: "brew install tesseract",
    uninstallHint: "brew uninstall tesseract",
    managedSupported: false,
    modelsTarget: "ocr",
  },
  {
    id: "mflux",
    category: "image",
    name: "mflux",
    roleKey: "engines.mflux.role",
    usedByKey: "engines.mflux.usedBy",
    installHint: "pip install mflux",
    uninstallHint: null,
    managedSupported: true,
    modelsTarget: "image",
  },
  {
    id: "laya-mlx",
    category: "systemone",
    name: "laya-mlx",
    roleKey: "engines.laya.role",
    usedByKey: "engines.laya.usedBy",
    // 装在托管 venv 里（<dataDir>/engines/laya），所以"装一份托管的"这条路是通的。
    installHint: null,
    uninstallHint: null,
    managedSupported: true,
    // 权重在 JEV 页管：三个 checkpoint 各自能下 / 起 / 停，卸载引擎不删权重。
    modelsTarget: "jev",
  },
  {
    id: "cloudflared",
    category: "network",
    name: "cloudflared",
    roleKey: "engines.cloudflared.role",
    usedByKey: "engines.cloudflared.usedBy",
    installHint: "brew install cloudflared",
    uninstallHint: "brew uninstall cloudflared",
    managedSupported: true,
    modelsTarget: null,
  },
];

export function localEngineSpec(id: LocalEngineId): LocalEngineSpec {
  const spec = LOCAL_ENGINE_SPECS.find((s) => s.id === id);
  if (!spec) throw new Error(`未知的本地引擎：${id}`);
  return spec;
}

/**
 * 分类的标题与说明（i18n key）。界面按分类渲染，键集中在这里定义 ——
 * 组件里拼出来的动态键 i18n 对齐测试看不见，`local-engines.test.ts` 逐个补上校验。
 */
export const LOCAL_ENGINE_CATEGORY_KEYS: Record<
  LocalEngineCategory,
  { titleKey: string; descriptionKey: string }
> = {
  inference: { titleKey: "engines.cat.inference", descriptionKey: "engines.cat.inference.desc" },
  voice: { titleKey: "engines.cat.voice", descriptionKey: "engines.cat.voice.desc" },
  ocr: { titleKey: "engines.cat.ocr", descriptionKey: "engines.cat.ocr.desc" },
  image: { titleKey: "engines.cat.image", descriptionKey: "engines.cat.image.desc" },
  systemone: { titleKey: "engines.cat.systemone", descriptionKey: "engines.cat.systemone.desc" },
  network: { titleKey: "engines.cat.network", descriptionKey: "engines.cat.network.desc" },
};

/** 全部引擎 id（声明顺序）。 */
export const LOCAL_ENGINE_IDS: readonly LocalEngineId[] = LOCAL_ENGINE_SPECS.map((s) => s.id);

/** 某分类下的引擎（界面按分类渲染时用）。 */
export function enginesInCategory(category: LocalEngineCategory): LocalEngineSpec[] {
  return LOCAL_ENGINE_SPECS.filter((s) => s.category === category);
}

/** 文本推理引擎 id（与 `InferenceEngine` 一一对应）。 */
export const INFERENCE_ENGINE_IDS: readonly InferenceEngine[] = ENGINE_IDS;

/** 某个 id 是不是文本推理引擎（决定状态探测走 runtime 还是各自的子系统）。 */
export function isInferenceEngineId(id: LocalEngineId): id is InferenceEngine {
  return (ENGINE_IDS as readonly string[]).includes(id);
}

/** 引擎在磁盘上的托管目录名（`<dataDir>/engines/<dir>`）；没有托管安装的为 null。 */
export const LOCAL_ENGINE_DIRS: Record<LocalEngineId, string | null> = {
  "llama.cpp": "llama.cpp",
  vllm: "vllm",
  sglang: "sglang",
  mlx: "mlx-lm",
  omlx: "omlx",
  "whisper.cpp": "whispercpp",
  "audio.cpp": "audiocpp",
  "speech.cpp": "speechcpp",
  paddleocr: "paddleocr",
  tesseract: "tessdata",
  mflux: "mflux",
  "laya-mlx": "laya",
  cloudflared: "cloudflared",
};

// ---------------------------------------------------------------------------
// 状态 / 动作（主进程返回、界面渲染共用）
// ---------------------------------------------------------------------------

/**
 * `managed` = 应用自己装的（卸载删它）；
 * `system` = 机器上本来就有（PATH / brew / conda），应用照用但不接管；
 * `missing` = 没有可用的。
 */
export type LocalEngineState = "managed" | "system" | "missing";

/** 升级语义：latest = 安装器会去拿更新的版本；repair = 版本是钉死的，重新下载即修复。 */
export type LocalEngineUpgradeKind = "latest" | "repair";

export type LocalEngineStatus = {
  id: LocalEngineId;
  state: LocalEngineState;
  /** 托管安装的版本标记（系统那份不猜版本，与引导页口径一致）。 */
  version: string | null;
  /** 实际会用到的可执行文件 / 解释器。 */
  path: string | null;
  /** 托管目录（「打开目录」与卸载的目标）；系统安装为 null。 */
  managedDir: string | null;
  /** 托管目录占用字节（算不出来为 null）。 */
  sizeBytes: number | null;
  /** 有进程在跑，或已被选为当前引擎（界面标「使用中」）。 */
  running: boolean;
  /** 能不能一键安装 / 升级。 */
  canInstall: boolean;
  /** 不能一键安装的原因（界面原样展示）。 */
  installNote: string | null;
  /** 安装量级（约 xx，界面用）。 */
  approxBytes: number | null;
  /** 安装前提（Python / 显卡 / 体积）。 */
  requirement: string | null;
  /** 能不能卸载（只有托管安装能卸）。 */
  canUninstall: boolean;
  /** 升级按钮的语义。 */
  upgradeKind: LocalEngineUpgradeKind;
  /**
   * 「这次安装到底完成了没有」（安装完整性 manifest，见 `bun/install-manifest.ts`）。
   * 只对**托管安装**的引擎做判断；PATH / brew / conda 上那份不是我们装的，
   * 没有也不该有 manifest，恒为 true —— 绝不能因为缺 manifest 就把它们标成「装坏了」。
   * 老用户的已装引擎同样没有 manifest：这一版只把结果记进日志与返回值，
   * **不拿它阻断任何操作**（「启动」按钮不禁用），先让数据跑起来，阻断逻辑以后再说。
   */
  installComplete: boolean;
  /** `installComplete === false` 时的原因（`VerifyReason`，如 missing / corrupt / platform-changed）。 */
  installIssue?: VerifyReason;
};
