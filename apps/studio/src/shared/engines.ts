/**
 * 推理引擎注册表 —— 全应用关于"有哪些引擎"的唯一真源。
 *
 * 新增一个引擎只应改这里（+ 对应的 Runtime 实现）：端口设置键、附加参数键、
 * 平台限制、能加载的模型格式、CLI 列表、UI 引擎选择器都从本文件派生，
 * 避免此前"加引擎要改 6 个地方、漏一个就半生效"的问题
 * （例如 `omi serve --engine vllm --port X` 曾把端口写进 llama.cpp 的 SERVER_PORT）。
 */

export type InferenceEngine = "llama.cpp" | "vllm" | "sglang" | "mlx";

export type ModelFileKind = "gguf" | "safetensors" | "other";

export type EngineSpec = {
  id: InferenceEngine;
  /** 引擎名对应的 i18n key（settings.engine.*）。 */
  labelKey: string;
  /** 该引擎监听端口的设置键。 */
  portKey: string;
  /** 该引擎附加启动参数的设置键。 */
  extraArgsKey: string;
  /** 能加载的模型文件格式。 */
  supports: ModelFileKind[];
  /** 仅 macOS（Apple Silicon）提供，非 mac 平台不展示也不检测。 */
  macOnly?: boolean;
  /** 缺失时的安装提示（omi install）。 */
  installHint: string;
};

export const ENGINE_SPECS: Record<InferenceEngine, EngineSpec> = {
  "llama.cpp": {
    id: "llama.cpp",
    labelKey: "settings.engine.llamacpp",
    portKey: "SERVER_PORT",
    extraArgsKey: "SERVER_EXTRA_ARGS",
    supports: ["gguf", "other"],
    installHint: "brew install llama.cpp",
  },
  vllm: {
    id: "vllm",
    labelKey: "settings.engine.vllm",
    portKey: "VLLM_PORT",
    extraArgsKey: "VLLM_EXTRA_ARGS",
    supports: ["safetensors", "other"],
    installHint: "pip install vllm  （或 uv pip install vllm）",
  },
  sglang: {
    id: "sglang",
    labelKey: "settings.engine.sglang",
    portKey: "SGLANG_PORT",
    extraArgsKey: "SGLANG_EXTRA_ARGS",
    supports: ["safetensors", "other"],
    installHint: "pip install 'sglang[all]'",
  },
  mlx: {
    id: "mlx",
    labelKey: "settings.engine.mlx",
    portKey: "MLX_PORT",
    extraArgsKey: "MLX_EXTRA_ARGS",
    supports: ["safetensors", "other"],
    macOnly: true,
    installHint: "pip install -U mlx-lm  （Apple Silicon / macOS）",
  },
};

/** 全部引擎 id（声明顺序即 UI 展示顺序）。 */
export const ENGINE_IDS = Object.keys(ENGINE_SPECS) as InferenceEngine[];

export function engineSpec(engine: InferenceEngine): EngineSpec {
  return ENGINE_SPECS[engine];
}

/** 当前平台可用的引擎（macOnly 引擎在非 mac 上剔除）。 */
export function availableEngines(isMac = process.platform === "darwin"): InferenceEngine[] {
  return ENGINE_IDS.filter((id) => !ENGINE_SPECS[id].macOnly || isMac);
}

/** Options for the engine selector; labels reuse `settings.engine.*` i18n keys. */
export const ENGINE_OPTIONS: { value: InferenceEngine; labelKey: string }[] = ENGINE_IDS.map((id) => ({
  value: id,
  labelKey: ENGINE_SPECS[id].labelKey,
}));

/** 各引擎监听端口的设置键（UI 侧读取设置 blob 用）。 */
export const ENGINE_PORT_KEYS: Record<InferenceEngine, string> = Object.fromEntries(
  ENGINE_IDS.map((id) => [id, ENGINE_SPECS[id].portKey]),
) as Record<InferenceEngine, string>;

/** 各引擎附加启动参数的设置键。 */
export const ENGINE_EXTRA_ARGS_KEYS: Record<InferenceEngine, string> = Object.fromEntries(
  ENGINE_IDS.map((id) => [id, ENGINE_SPECS[id].extraArgsKey]),
) as Record<InferenceEngine, string>;

/** 缺失引擎的安装提示。 */
export const ENGINE_INSTALL_HINTS: Record<InferenceEngine, string> = Object.fromEntries(
  ENGINE_IDS.map((id) => [id, ENGINE_SPECS[id].installHint]),
) as Record<InferenceEngine, string>;

/** 判断某个引擎能否加载某类模型文件。 */
export function engineSupports(engine: InferenceEngine, kind: ModelFileKind): boolean {
  if (kind === "other") return true;
  return ENGINE_SPECS[engine].supports.includes(kind);
}
