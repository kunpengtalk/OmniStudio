/**
 * 机器画像（芯片 / 内存 / 显存）与「这台机器能跑多大的模型」的估算。
 *
 * 探测动作在 `bun/hardware.ts`（sysctl / nvidia-smi / node:os），这里只放纯计算和
 * 纯字符串解析：内存预算口径、模型占用估算、按机器给候选模型排序推荐。逻辑可单测，
 * 界面也不必知道这些数字是从哪条命令来的；解析函数留在共享层，是为了能拿真机输出
 * 钉住格式（`nvidia-smi` / `system_profiler` 的字段名各平台并不一致）。
 *
 * 估算不是实测：权重取量化体积（仓库里的准数），KV 缓存按架构
 * （层数 × KV 头 × head_dim × 2(K/V) × 2B）× 上下文长度推算，再加一层运行期开销。
 * 界面会写明「按 8K 上下文估算」—— 用户看到的是量级，不是精确值。
 */
import type { InferenceEngine } from "./modelscope";

export type ChipVendor = "apple" | "intel" | "amd" | "qualcomm" | "unknown";

export type GpuKind = "apple" | "nvidia" | "amd" | "intel" | "unknown" | "none";

export type GpuInfo = {
  kind: GpuKind;
  name: string;
  /** 独显显存（bytes）。Apple 统一内存 / 核显为 null —— 那种机器内存就是显存。 */
  vramBytes: number | null;
};

/** 推理内存预算按哪一份内存折算（界面据此写「可用预算」的说明）。 */
export type MemoryBasis = "unified" | "vram" | "system";

export type HardwareInfo = {
  platform: string;
  arch: string;
  /** 芯片名：`Apple M3 Ultra` / `Intel(R) Core(TM) i9-9880H` / … */
  chipName: string;
  chipVendor: ChipVendor;
  /** 机型标识（macOS 的 `hw.model`，如 `Mac15,14`），其他平台没有。 */
  modelId?: string;
  cpuCores: number;
  cpuThreads: number;
  gpu: GpuInfo;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  /** 推理可用内存预算（bytes）：权重 + KV 缓存 + 运行开销都得装进这个数。 */
  budgetBytes: number;
  budgetBasis: MemoryBasis;
};

// ---------------------------------------------------------------------------
// 芯片识别
// ---------------------------------------------------------------------------

export type AppleChip = {
  /** `M1` … `M5`。 */
  generation: string;
  tier: "base" | "pro" | "max" | "ultra";
};

/** 从芯片名里认出 Apple M 系列（`Apple M3 Ultra` → M3 / ultra）。 */
export function parseAppleChip(chipName: string): AppleChip | null {
  const match = /^apple\s+(M\d+)\s*(pro|max|ultra)?/i.exec(chipName.trim());
  if (!match) return null;
  const tier = match[2]?.toLowerCase();
  return {
    generation: match[1]!.toUpperCase(),
    tier: tier === "pro" || tier === "max" || tier === "ultra" ? tier : "base",
  };
}

export function classifyChipVendor(chipName: string): ChipVendor {
  const name = chipName.toLowerCase();
  if (/(^|\W)apple(\W|$)/.test(name)) return "apple";
  if (/intel|xeon|pentium|celeron|\batom\b|core\(tm\)/.test(name)) return "intel";
  if (/\bamd\b|ryzen|epyc|threadripper/.test(name)) return "amd";
  if (/qualcomm|snapdragon|\barm\b|cortex/.test(name)) return "qualcomm";
  return "unknown";
}

// ---------------------------------------------------------------------------
// 内存预算
// ---------------------------------------------------------------------------

/** Apple 统一内存：macOS 默认的 GPU wired 上限就是物理内存的 75%（`iogpu.wired_limit_mb`）。 */
export const UNIFIED_BUDGET_RATIO = 0.75;
/** 独显：留 10% 给显示输出、上下文缓冲和显存碎片。 */
export const VRAM_BUDGET_RATIO = 0.9;
/** 纯 CPU（或在核显上跑）：给系统和其他应用留 40%。 */
export const SYSTEM_BUDGET_RATIO = 0.6;

export function inferenceMemoryBudget(input: {
  gpu: GpuInfo;
  totalMemoryBytes: number;
}): { budgetBytes: number; basis: MemoryBasis } {
  const { gpu, totalMemoryBytes } = input;
  if (gpu.kind === "apple") {
    return { budgetBytes: Math.round(totalMemoryBytes * UNIFIED_BUDGET_RATIO), basis: "unified" };
  }
  if (gpu.vramBytes && gpu.vramBytes > 0) {
    return { budgetBytes: Math.round(gpu.vramBytes * VRAM_BUDGET_RATIO), basis: "vram" };
  }
  return { budgetBytes: Math.round(totalMemoryBytes * SYSTEM_BUDGET_RATIO), basis: "system" };
}

// ---------------------------------------------------------------------------
// 模型内存估算与适配分级
// ---------------------------------------------------------------------------

/** 引导页默认按 8K 上下文估算（KV 缓存随上下文线性增长）。 */
export const DEFAULT_CONTEXT_TOKENS = 8192;

/** 运行期开销（激活值、计算缓冲、Metal/CUDA context）：按权重的 5% 估，不低于 512MB。 */
const OVERHEAD_MIN_BYTES = 512 * 1024 * 1024;
const OVERHEAD_RATIO = 0.05;

/** 占用 / 预算 的比例阈值：0.6 以内流畅，0.8 以内可用，1.0 以内偏紧，超过就装不下。 */
export const FIT_RATIOS = { comfortable: 0.6, good: 0.8, tight: 1 } as const;

export type FitLevel = "comfortable" | "good" | "tight" | "too-large";

export type ModelMemoryEstimate = {
  weightsBytes: number;
  kvCacheBytes: number;
  overheadBytes: number;
  totalBytes: number;
};

export function estimateModelMemory(input: {
  weightsBytes: number;
  /** 每 token 的 KV 缓存（bytes），按模型架构推算。 */
  kvBytesPerToken: number;
  contextTokens?: number;
}): ModelMemoryEstimate {
  const contextTokens = input.contextTokens ?? DEFAULT_CONTEXT_TOKENS;
  const weightsBytes = Math.max(0, input.weightsBytes);
  const kvCacheBytes = Math.max(0, input.kvBytesPerToken) * contextTokens;
  const overheadBytes = Math.max(OVERHEAD_MIN_BYTES, Math.round(weightsBytes * OVERHEAD_RATIO));
  return {
    weightsBytes,
    kvCacheBytes,
    overheadBytes,
    totalBytes: weightsBytes + kvCacheBytes + overheadBytes,
  };
}

export function fitLevel(requiredBytes: number, budgetBytes: number): FitLevel {
  if (budgetBytes <= 0) return "too-large";
  const ratio = requiredBytes / budgetBytes;
  if (ratio <= FIT_RATIOS.comfortable) return "comfortable";
  if (ratio <= FIT_RATIOS.good) return "good";
  if (ratio <= FIT_RATIOS.tight) return "tight";
  return "too-large";
}

/** 权重的一档（GGUF 量化名，或 safetensors 的 BF16，或 MLX 的混合精度）。 */
export type ModelVariant = { name: string; sizeBytes: number };

export type ModelCandidates = {
  id: string;
  /** 参数规模（十亿），用来「在跑得动的范围里尽量挑大的」。 */
  paramsB: number;
  kvBytesPerToken: number;
  /** 目录里的默认档（GGUF 一般是 Q4_K_M），质量与体积的甜点档；缺省时按体积挑。 */
  defaultQuant?: string;
  variants: readonly ModelVariant[];
};

export type VariantFit = {
  variant: ModelVariant;
  estimate: ModelMemoryEstimate;
  level: FitLevel;
};

export type ModelFit = {
  id: string;
  paramsB: number;
  /** 由小到大排序，界面按它列档位。 */
  variants: VariantFit[];
  /** 本机建议档位，见 `pickVariant`。 */
  recommended: VariantFit;
  /** `recommended` 在本机的适配级别。 */
  level: FitLevel;
};

/**
 * 本机建议档位，四条规则按序命中：
 *  1. 默认档（Q4_K_M 这类甜点档）舒服装得下（comfortable / good）就先认它 —— 这是目录
 *     里挑好的质量 / 体积平衡点，不该被估算的小数位推翻；
 *  2. 默认档还只是 comfortable，且同档里还有更大的 → 往上挑一档：几百 GB 内存的机器
 *     没必要白留质量（这一条只对"很宽裕"生效，good 档不往上顶，免得把小机器推向偏紧档）；
 *  3. 默认档偏紧或装不下 → 退到「装得下的最大一档」（good 及以上），小机器由此自动退档；
 *  4. 连 good 都没有 → 给「偏紧」里最大的一档，最后兜底最小的一档（界面会标「超出内存」）。
 */
function pickVariant(fits: VariantFit[], defaultQuant?: string): VariantFit {
  const ofLevel = (level: FitLevel) => fits.filter((fit) => fit.level === level);
  const preferred = defaultQuant ? fits.find((fit) => fit.variant.name === defaultQuant) : undefined;

  if (preferred && (preferred.level === "comfortable" || preferred.level === "good")) {
    if (preferred.level === "good") return preferred;
    const larger = ofLevel("comfortable").filter(
      (fit) => fit.variant.sizeBytes > preferred.variant.sizeBytes,
    );
    return larger.length > 0 ? larger[larger.length - 1]! : preferred;
  }

  const roomy = [...ofLevel("comfortable"), ...ofLevel("good")].sort(
    (a, b) => a.variant.sizeBytes - b.variant.sizeBytes,
  );
  if (roomy.length > 0) return roomy[roomy.length - 1]!;
  const tight = ofLevel("tight");
  return tight.length > 0 ? tight[tight.length - 1]! : fits[0]!;
}

export function fitModelsForMachine(
  machine: HardwareInfo,
  models: readonly ModelCandidates[],
  contextTokens = DEFAULT_CONTEXT_TOKENS,
): ModelFit[] {
  return models
    .filter((model) => model.variants.length > 0)
    .map((model) => {
      const variants: VariantFit[] = [...model.variants]
        .sort((a, b) => a.sizeBytes - b.sizeBytes)
        .map((variant) => {
          const estimate = estimateModelMemory({
            weightsBytes: variant.sizeBytes,
            kvBytesPerToken: model.kvBytesPerToken,
            contextTokens,
          });
          return { variant, estimate, level: fitLevel(estimate.totalBytes, machine.budgetBytes) };
        });
      const recommended = pickVariant(variants, model.defaultQuant);
      return { id: model.id, paramsB: model.paramsB, variants, recommended, level: recommended.level };
    });
}

/**
 * 本机最值得装的模型：先看跑得舒服（comfortable / good）的那一批，挑参数最大的；
 * 一个舒服的都没有（小机器上普遍偏紧）才在「装得下」的范围里挑最大的；
 * 全都装不下时返回 null（界面保留原选择并标出「超出内存」）。
 *
 * 参数排序按**总参数**（MoE 的 35B-A3B 记 35）—— 它在激活参数上只相当于 3B，
 * 但质量与体积都摆在大模型那一档，引导页要的是"这台机器能装多大的模型"。
 */
export function recommendModel(fits: readonly ModelFit[]): ModelFit | null {
  const usable = fits.filter((fit) => fit.level !== "too-large");
  if (usable.length === 0) return null;
  const roomy = usable.filter((fit) => fit.level === "comfortable" || fit.level === "good");
  const pool = roomy.length > 0 ? roomy : usable;
  return pool.reduce((best, fit) => (fit.paramsB > best.paramsB ? fit : best));
}

// ---------------------------------------------------------------------------
// 引擎推荐
// ---------------------------------------------------------------------------

export type EngineAvailability = {
  llama: boolean;
  vllm: boolean;
  sglang: boolean;
  mlx: boolean;
};

export type EngineRecommendation = {
  engine: InferenceEngine;
  /** 推荐理由的**代号**（共享层不放 UI 文案，界面按 code 自己写一句话）。 */
  reason: { code: "mlx-installed" | "apple-metal" | "nvidia-vram" | "generic" } & {
    vramBytes?: number;
  };
};

/**
 * 显存到了这个量级才推荐 vLLM：它的权重只有 bf16 safetensors（没有量化档），显存不够
 * 大时"上 vLLM"反而把能跑的模型砍小一档 —— 引导页优先让用户跑起最大的那个模型，
 * 24GB 卡上 llama.cpp + Q4/Q3 量化能装下 27B，vLLM 只装得下 4B。
 */
export const VLLM_VRAM_THRESHOLD_BYTES = 48e9;

export function recommendEngine(
  machine: HardwareInfo,
  available: EngineAvailability,
): EngineRecommendation {
  // Apple 芯片：装了 mlx-lm 就直推 MLX（同权重下更快），否则 llama.cpp（Metal 加速，装一个二进制即可）。
  if (machine.gpu.kind === "apple" && machine.arch === "arm64") {
    return available.mlx
      ? { engine: "mlx", reason: { code: "mlx-installed" } }
      : { engine: "llama.cpp", reason: { code: "apple-metal" } };
  }
  // NVIDIA 独显且显存够大：vLLM 在长上下文 / 并发下明显更快（要求装过、能拉起）。
  const vramBytes = machine.gpu.kind === "nvidia" ? machine.gpu.vramBytes ?? 0 : 0;
  if (vramBytes >= VLLM_VRAM_THRESHOLD_BYTES && available.vllm) {
    return { engine: "vllm", reason: { code: "nvidia-vram", vramBytes } };
  }
  return { engine: "llama.cpp", reason: { code: "generic" } };
}

// ---------------------------------------------------------------------------
// 命令输出解析（探测在 bun/hardware.ts，这里只认格式）
// ---------------------------------------------------------------------------

/**
 * `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits` 的输出：
 * 每行一张卡，`NVIDIA GeForce RTX 4090, 24564`（MiB）。多卡取显存最大的一张 ——
 * 模型只能装进单卡（或走很慢的分片），预算按最大的一张算才不会高估。
 */
export function parseNvidiaSmiOutput(stdout: string): GpuInfo | null {
  const gpus = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.lastIndexOf(",");
      if (separator < 0) return { kind: "nvidia" as const, name: line, vramBytes: null };
      const name = line.slice(0, separator).trim();
      const mib = Number.parseFloat(line.slice(separator + 1).replace(/[^\d.]/g, ""));
      return {
        kind: "nvidia" as const,
        name: name || "NVIDIA GPU",
        vramBytes: Number.isFinite(mib) && mib > 0 ? Math.round(mib * 1024 * 1024) : null,
      };
    });
  if (gpus.length === 0) return null;
  return gpus.reduce((best, gpu) => ((gpu.vramBytes ?? 0) > (best.vramBytes ?? 0) ? gpu : best));
}

/**
 * `system_profiler SPDisplaysDataType` 的输出（只有 Intel Mac 才会去跑）：
 *
 * ```
 *       Chipset Model: AMD Radeon Pro 5500M
 *       VRAM (Total): 4 GB
 * ```
 *
 * Apple 芯片同样有 `Chipset Model`，但没有 VRAM 行（统一内存）。
 */
export function parseDisplaysChipset(stdout: string): GpuInfo | null {
  const chipset = /^\s*Chipset Model:\s*(.+)$/m.exec(stdout)?.[1]?.trim();
  if (!chipset) return null;
  const vendorLine = /^\s*Vendor:\s*(.+)$/m.exec(stdout)?.[1]?.toLowerCase() ?? "";
  const name = chipset.toLowerCase();
  const kind: GpuKind = name.startsWith("apple") || vendorLine.includes("apple")
    ? "apple"
    : name.includes("nvidia")
      ? "nvidia"
      : name.includes("amd") || name.includes("radeon")
        ? "amd"
        : name.includes("intel")
          ? "intel"
          : "unknown";
  const vram = /^\s*VRAM \(Total\):\s*(.+)$/m.exec(stdout)?.[1]?.trim();
  return { kind, name: chipset, vramBytes: vram ? parseVramText(vram) : null };
}

/** `4 GB` / `1536 MB` → bytes。认不出来时给 null（预算随后落到「内存 60%」口径）。 */
export function parseVramText(text: string): number | null {
  const match = /([\d.]+)\s*(TB|GB|MB|KB)/i.exec(text);
  if (!match) return null;
  const value = Number.parseFloat(match[1]!);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = match[2]!.toUpperCase();
  const scale = unit === "TB" ? 1e12 : unit === "GB" ? 1e9 : unit === "MB" ? 1e6 : 1e3;
  return Math.round(value * scale);
}
