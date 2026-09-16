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

/** 模型市场检索用的格式维度，与各平台（ModelScope / Hugging Face）的库标签一一对应。 */
export type SearchFormat = "gguf" | "safetensors" | "mlx";

export const SEARCH_FORMATS: SearchFormat[] = ["gguf", "safetensors", "mlx"];

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
  /**
   * 该引擎原生消费的权重格式 —— 模型市场据此向平台注入格式过滤条件
   * （`filter=gguf` / `filter=safetensors` / `filter=mlx`），而不是靠模型名猜。
   * 与 `supports` 的区别：supports 是"能不能加载"，searchFormat 是"该去检索哪一种"。
   */
  searchFormat: SearchFormat;
  /** 仅 macOS（Apple Silicon）提供，非 mac 平台不展示也不检测。 */
  macOnly?: boolean;
  /** 引擎是否支持嵌入服务（llama.cpp 经 `--embeddings` 支持；其余引擎留待后续）。 */
  embeddings?: boolean;
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
    searchFormat: "gguf",
    embeddings: true,
    installHint: "brew install llama.cpp",
  },
  vllm: {
    id: "vllm",
    labelKey: "settings.engine.vllm",
    portKey: "VLLM_PORT",
    extraArgsKey: "VLLM_EXTRA_ARGS",
    supports: ["safetensors", "other"],
    searchFormat: "safetensors",
    installHint: "pip install vllm  （或 uv pip install vllm）",
  },
  sglang: {
    id: "sglang",
    labelKey: "settings.engine.sglang",
    portKey: "SGLANG_PORT",
    extraArgsKey: "SGLANG_EXTRA_ARGS",
    supports: ["safetensors", "other"],
    searchFormat: "safetensors",
    installHint: "pip install 'sglang[all]'",
  },
  mlx: {
    id: "mlx",
    labelKey: "settings.engine.mlx",
    portKey: "MLX_PORT",
    extraArgsKey: "MLX_EXTRA_ARGS",
    supports: ["safetensors", "other"],
    searchFormat: "mlx",
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

/**
 * 当前平台的引擎选项。UI 不要自己判断 `value !== "mlx"`，平台限制只声明在
 * `ENGINE_SPECS[id].macOnly`（否则新增 macOnly 引擎时选择器又会漏掉）。
 */
export function engineOptions(isMac = process.platform === "darwin"): { value: InferenceEngine; labelKey: string }[] {
  return ENGINE_OPTIONS.filter((o) => !ENGINE_SPECS[o.value].macOnly || isMac);
}

/** 各引擎监听端口的设置键（UI 侧读取设置 blob 用）。 */
export const ENGINE_PORT_KEYS: Record<InferenceEngine, string> = Object.fromEntries(
  ENGINE_IDS.map((id) => [id, ENGINE_SPECS[id].portKey]),
) as Record<InferenceEngine, string>;

/** 各引擎附加启动参数的设置键。 */
export const ENGINE_EXTRA_ARGS_KEYS: Record<InferenceEngine, string> = Object.fromEntries(
  ENGINE_IDS.map((id) => [id, ENGINE_SPECS[id].extraArgsKey]),
) as Record<InferenceEngine, string>;

/**
 * 嵌入服务（llama.cpp `--embeddings`）的端口段基址。
 *
 * 嵌入实例**不占**聊天默认端点（18080 段），从 18190 起 +100 顺延分配 ——
 * 两个段位完全不重叠，聊天端口扫描 / 默认端点语义不受影响。
 */
/** 嵌入端口段基址（= EMBEDDING_PORT 的默认值；段宽与聊天一致，见 allocatePort 的 +100 顺延）。 */
export const EMBEDDING_PORT_BASE = 18190;

/** 该引擎是否支持嵌入服务（当前只有 llama.cpp 经 `--embeddings` 支持）。 */
export function engineSupportsEmbeddings(engine: InferenceEngine): boolean {
  return ENGINE_SPECS[engine].embeddings === true;
}

/**
 * 各引擎「上下文窗口」的设置键（基准测试页据此提示哪些档位会被服务端拒绝）。
 *
 * llama.cpp 的 `SERVER_CTX_SIZE` 是 KV 总量、会被 `--parallel` 的槽位均分，读的人要
 * 自己换算成单请求的量（见 `shared/benchmark.ts` 的 `serverContextWindow`）；
 * null = 窗口由模型自己决定，应用侧没有可读的键（MLX）。
 */
export const ENGINE_CTX_KEYS: Record<InferenceEngine, string | null> = {
  "llama.cpp": "SERVER_CTX_SIZE",
  vllm: "VLLM_MAX_MODEL_LEN",
  sglang: "SGLANG_CONTEXT_LENGTH",
  mlx: null,
};

/**
 * 引擎短名（品牌名，不翻译）。选择器里的徽标用这个，不要用 `settings.engine.*`：
 * 那几个是设置页的完整说明（「MLX（Apple Silicon，MLX 模型）」），放进一行模型
 * 条目里会把模型名挤到只剩省略号。
 */
export const ENGINE_SHORT_NAMES: Record<InferenceEngine, string> = {
  "llama.cpp": "llama.cpp",
  vllm: "vLLM",
  sglang: "SGLang",
  mlx: "MLX",
};

/** 缺失引擎的安装提示。 */
export const ENGINE_INSTALL_HINTS: Record<InferenceEngine, string> = Object.fromEntries(
  ENGINE_IDS.map((id) => [id, ENGINE_SPECS[id].installHint]),
) as Record<InferenceEngine, string>;

// ---------------------------------------------------------------------------
// 一键安装能力
// ---------------------------------------------------------------------------

/** 应用怎么把这个引擎装上：下载官方二进制，或在数据目录里建 venv 装 pip 包。 */
export type EngineInstallKind = "binary" | "python";

export type EngineInstallSupport = {
  /** 本平台能不能一键装（不能时界面只给手动安装提示）。 */
  supported: boolean;
  kind: EngineInstallKind;
  /** 一键安装要下载的量级（界面上的「约 xx」用）。 */
  approxBytes?: number;
  /** 需要用户先具备的前提（Python / 驱动 / 体积），点安装之前就要说清楚。 */
  requirement?: string;
  /** 不支持时的原因，界面直接展示。 */
  note?: string;
};

/**
 * 平台 → 一键安装能力。判定与引擎注册表放在同一份，否则界面上的按钮与主进程
 * 真正会做的事会各说一套（「能装」的按钮点下去必然失败，是最坏的一种不一致）。
 *
 * - **llama.cpp**：官方发布预编译二进制，全平台可装；Apple 芯片的 macOS 构建自带
 *   Metal，Linux / Windows 有 NVIDIA 显卡时自动换 CUDA 构建（体积大一个数量级）。
 * - **mlx-lm**：Apple Silicon 专属的 pip 包，装进数据目录里的 venv。
 * - **vLLM / SGLang**：官方只发 Linux 的 CUDA 轮子，macOS / Windows 装不了，
 *   界面给手动提示与远程服务两条路。
 */
export function engineInstallSupport(
  engine: InferenceEngine,
  platform: string = process.platform,
  arch: string = process.arch,
): EngineInstallSupport {
  switch (engine) {
    case "llama.cpp": {
      const known =
        (platform === "darwin" && (arch === "arm64" || arch === "x64")) ||
        (platform === "linux" && (arch === "x64" || arch === "arm64")) ||
        (platform === "win32" && (arch === "x64" || arch === "arm64"));
      if (!known) {
        return {
          supported: false,
          kind: "binary",
          note: `当前平台（${platform}/${arch}）没有官方预编译构建，请手动安装`,
        };
      }
      return {
        supported: true,
        kind: "binary",
        approxBytes: 25e6,
        requirement: "NVIDIA 显卡的 Linux / Windows 机器会自动改用 CUDA 构建（约 170 MB）",
      };
    }
    case "mlx":
      if (platform !== "darwin" || arch !== "arm64") {
        return {
          supported: false,
          kind: "python",
          note: "MLX 引擎只在 Apple Silicon 的 macOS 上可用",
        };
      }
      return {
        supported: true,
        kind: "python",
        approxBytes: 350e6,
        requirement: "需要本机有 Python 3.10 及以上（应用会建独立虚拟环境安装）",
      };
    case "vllm":
    case "sglang": {
      const label = engine === "vllm" ? "vLLM" : "SGLang";
      if (platform !== "linux") {
        return {
          supported: false,
          kind: "python",
          note: `${label} 官方只发 Linux 的 CUDA 轮子，${platform === "darwin" ? "macOS" : "Windows"} 上请手动安装或改用远程服务`,
        };
      }
      if (arch !== "x64" && arch !== "arm64") {
        return {
          supported: false,
          kind: "python",
          note: `当前架构（${arch}）没有 ${label} 的预编译轮子`,
        };
      }
      return {
        supported: true,
        kind: "python",
        approxBytes: engine === "vllm" ? 3.5e9 : 4.5e9,
        requirement: "需要 Python 3.10+ 与 NVIDIA 驱动；含 PyTorch，下载量大、耗时较久",
      };
    }
  }
}

/** 判断某个引擎能否加载某类模型文件。 */
export function engineSupports(engine: InferenceEngine, kind: ModelFileKind): boolean {
  if (kind === "other") return true;
  return ENGINE_SPECS[engine].supports.includes(kind);
}

/**
 * 引擎 → 市场检索格式。用户在"在线模型市场"里选择"跟随引擎"时，
 * 检索请求就带上这里的格式，交给平台侧元数据过滤，而不是本地遍历结果去猜。
 */
export function engineSearchFormat(engine: InferenceEngine): SearchFormat {
  return ENGINE_SPECS[engine].searchFormat;
}
