import { describe, expect, test } from "bun:test";

import {
  classifyChipVendor,
  estimateModelMemory,
  fitLevel,
  fitModelsForMachine,
  inferenceMemoryBudget,
  parseAppleChip,
  parseDisplaysChipset,
  parseNvidiaSmiOutput,
  parseVramText,
  recommendEngine,
  recommendModel,
  VLLM_VRAM_THRESHOLD_BYTES,
  type GpuInfo,
  type HardwareInfo,
  type ModelCandidates,
} from "./hardware";

const GB = 1e9;

function machine(input: {
  gpu: GpuInfo;
  totalGB: number;
  arch?: string;
  platform?: string;
  chipName?: string;
}): HardwareInfo {
  const totalMemoryBytes = input.totalGB * GB;
  const { budgetBytes, basis } = inferenceMemoryBudget({
    gpu: input.gpu,
    totalMemoryBytes,
  });
  return {
    platform: input.platform ?? "darwin",
    arch: input.arch ?? "arm64",
    chipName: input.chipName ?? (input.gpu.kind === "apple" ? "Apple M3 Pro" : "Test CPU"),
    chipVendor: classifyChipVendor(input.chipName ?? (input.gpu.kind === "apple" ? "Apple M3 Pro" : "Test CPU")),
    cpuCores: 10,
    cpuThreads: 10,
    gpu: input.gpu,
    totalMemoryBytes,
    freeMemoryBytes: totalMemoryBytes / 2,
    budgetBytes,
    budgetBasis: basis,
  };
}

const appleGpu: GpuInfo = { kind: "apple", name: "Apple M3 Pro", vramBytes: null };
const noGpu: GpuInfo = { kind: "none", name: "未检测到独立显卡", vramBytes: null };
const nvidia = (vramGB: number): GpuInfo => ({
  kind: "nvidia",
  name: "NVIDIA GeForce RTX 4090",
  vramBytes: vramGB * GB,
});

/** 每 token 8 KiB（4B 级稠密模型 fp16 KV 的量级），便于手算期望值。 */
const KV = 8192;
const model = (id: string, paramsB: number, variants: [string, number][], defaultQuant?: string): ModelCandidates => ({
  id,
  paramsB,
  kvBytesPerToken: KV,
  defaultQuant,
  variants: variants.map(([name, sizeGB]) => ({ name, sizeBytes: sizeGB * GB })),
});

describe("芯片识别", () => {
  test("Apple M 系列：代次与档位", () => {
    expect(parseAppleChip("Apple M3 Ultra")).toEqual({ generation: "M3", tier: "ultra" });
    expect(parseAppleChip("Apple M1")).toEqual({ generation: "M1", tier: "base" });
    expect(parseAppleChip("Apple M4 Pro")).toEqual({ generation: "M4", tier: "pro" });
    expect(parseAppleChip("apple m2 max")).toEqual({ generation: "M2", tier: "max" });
    expect(parseAppleChip("Intel(R) Core(TM) i9-9880H CPU @ 2.30GHz")).toBeNull();
  });

  test("厂商归类：Intel 的 'Core(TM)' 与 AMD 的 Ryzen 都要认出来", () => {
    expect(classifyChipVendor("Apple M3 Ultra")).toBe("apple");
    expect(classifyChipVendor("Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz")).toBe("intel");
    expect(classifyChipVendor("AMD Ryzen 9 7950X 16-Core Processor")).toBe("amd");
    expect(classifyChipVendor("AMD EPYC 7763 64-Core Processor")).toBe("amd");
    expect(classifyChipVendor("Snapdragon X Elite")).toBe("qualcomm");
    expect(classifyChipVendor("virtio")).toBe("unknown");
  });
});

describe("推理内存预算", () => {
  test("Apple 统一内存按 75% 算，且口径标记为 unified", () => {
    const budget = inferenceMemoryBudget({ gpu: appleGpu, totalMemoryBytes: 512 * GB });
    expect(budget.basis).toBe("unified");
    expect(budget.budgetBytes).toBe(384 * GB);
  });

  test("独显按显存算 —— 64GB 内存 + 24GB 显存的机器不该按内存给预算", () => {
    const budget = inferenceMemoryBudget({ gpu: nvidia(24), totalMemoryBytes: 64 * GB });
    expect(budget.basis).toBe("vram");
    expect(budget.budgetBytes).toBe(Math.round(24 * GB * 0.9));
  });

  test("没有独显（核显 / 纯 CPU）退回内存的 60%", () => {
    expect(inferenceMemoryBudget({ gpu: noGpu, totalMemoryBytes: 32 * GB })).toEqual({
      budgetBytes: Math.round(32 * GB * 0.6),
      basis: "system",
    });
    // Intel 核显：显存字段为空，同样按内存算
    const iGpu: GpuInfo = { kind: "intel", name: "Intel Iris Plus", vramBytes: null };
    expect(inferenceMemoryBudget({ gpu: iGpu, totalMemoryBytes: 16 * GB }).basis).toBe("system");
  });
});

describe("模型占用估算", () => {
  test("KV 缓存随上下文线性增长，权重与开销不变", () => {
    const at8k = estimateModelMemory({ weightsBytes: 4 * GB, kvBytesPerToken: KV, contextTokens: 8192 });
    const at32k = estimateModelMemory({ weightsBytes: 4 * GB, kvBytesPerToken: KV, contextTokens: 32768 });
    expect(at8k.kvCacheBytes).toBe(KV * 8192);
    expect(at32k.kvCacheBytes).toBe(KV * 32768);
    expect(at32k.totalBytes - at8k.totalBytes).toBe(KV * (32768 - 8192));
    expect(at8k.weightsBytes).toBe(4 * GB);
    expect(at8k.overheadBytes).toBe(at32k.overheadBytes);
  });

  test("运行期开销：小模型兜底 512MB，大模型按 5% 走", () => {
    expect(estimateModelMemory({ weightsBytes: 1 * GB, kvBytesPerToken: 0 }).overheadBytes).toBe(
      512 * 1024 * 1024,
    );
    expect(estimateModelMemory({ weightsBytes: 20 * GB, kvBytesPerToken: 0 }).overheadBytes).toBe(1 * GB);
  });
});

describe("内存适配分级", () => {
  test("阈值边界：≤60% 流畅，≤80% 可用，≤100% 偏紧，超过即装不下", () => {
    expect(fitLevel(60, 100)).toBe("comfortable");
    expect(fitLevel(61, 100)).toBe("good");
    expect(fitLevel(80, 100)).toBe("good");
    expect(fitLevel(81, 100)).toBe("tight");
    expect(fitLevel(100, 100)).toBe("tight");
    expect(fitLevel(101, 100)).toBe("too-large");
    expect(fitLevel(1, 0)).toBe("too-large");
  });
});

describe("按机器挑档位与模型", () => {
  // 4B / 9B 两档，量化体积与引导页目录同量级；KV=8KiB/token → 8K 上下文约 67MB（可忽略量级）
  const catalog = [
    model(
      "small",
      4,
      [
        ["Q3_K_M", 2.3],
        ["Q4_K_M", 2.7],
        ["Q8_0", 4.5],
      ],
      "Q4_K_M",
    ),
    model(
      "medium",
      9,
      [
        ["Q3_K_M", 4.7],
        ["Q4_K_M", 5.7],
        ["Q8_0", 9.5],
      ],
      "Q4_K_M",
    ),
  ];

  test("默认档（Q4_K_M）舒服装得下就先认它", () => {
    // 6GB 预算：4B Q4_K_M 3.3GB（55%，流畅）；Q8_0 5.1GB（85%，偏紧）→ 不上 Q8_0
    const fits = fitModelsForMachine(machine({ gpu: appleGpu, totalGB: 8 }), catalog);
    const small = fits.find((f) => f.id === "small")!;
    expect(small.level).toBe("comfortable");
    expect(small.recommended.variant.name).toBe("Q4_K_M");
  });

  test("机器很宽裕时往上抬一档：同一档里还有更大的就挑大的", () => {
    // 24GB 预算：9B 的 Q3/Q4/Q8 全在流畅档 → 挑最大的 Q8_0
    const fits = fitModelsForMachine(machine({ gpu: appleGpu, totalGB: 32 }), catalog);
    const medium = fits.find((f) => f.id === "medium")!;
    expect(medium.recommended.variant.name).toBe("Q8_0");
    expect(medium.level).toBe("comfortable");
  });

  test("跨度太大就不抬：下一档已经偏紧时保持默认档", () => {
    // 12GB 预算：9B Q4_K_M 6.3GB（52%，流畅）、Q8_0 10.1GB（84%，偏紧）→ 保持 Q4_K_M
    const fits = fitModelsForMachine(machine({ gpu: appleGpu, totalGB: 16 }), catalog);
    const medium = fits.find((f) => f.id === "medium")!;
    expect(medium.recommended.variant.name).toBe("Q4_K_M");
    expect(medium.level).toBe("comfortable");
  });

  test("小机器自动退档：默认档偏紧就退到装得下的最大档", () => {
    // 3GB 预算：4B Q3_K_M 2.8GB（93% 偏紧）/ Q4_K_M 3.2GB（107% 装不下）
    const fits = fitModelsForMachine(machine({ gpu: appleGpu, totalGB: 4 }), catalog);
    const small = fits.find((f) => f.id === "small")!;
    expect(small.recommended.variant.name).toBe("Q3_K_M");
    expect(small.level).toBe("tight");
  });

  test("全档装不下：给最小的一档并标出超出内存，推荐模型为 null", () => {
    const tiny = machine({ gpu: noGpu, totalGB: 2 }); // 预算 1.2GB
    const fits = fitModelsForMachine(tiny, catalog);
    expect(fits.every((f) => f.level === "too-large")).toBe(true);
    expect(fits[0]!.recommended.variant.name).toBe("Q3_K_M");
    expect(recommendModel(fits)).toBeNull();
  });

  test("推荐模型：跑得动的里面参数最大的那个", () => {
    const fits = fitModelsForMachine(machine({ gpu: appleGpu, totalGB: 16 }), catalog);
    expect(recommendModel(fits)?.id).toBe("medium");
  });

  test("「偏紧的大模型」不压过「舒服的小模型」", () => {
    // 3.6GB 预算：medium 只剩 Q3_K_M 勉强（93% 偏紧），small 的 Q4_K_M 只要 92%…
    // 收紧一点：small 在 3.6GB 下 Q3_K_M = 2.904/3.6 = 81% 偏紧 → 两个都偏紧，仍取大的
    const tightBoth = machine({ gpu: noGpu, totalGB: 6 }); // 预算 3.6GB
    const fitsTight = fitModelsForMachine(tightBoth, catalog);
    expect(fitsTight.map((f) => f.level)).toEqual(["tight", "too-large"]);
    expect(recommendModel(fitsTight)?.id).toBe("small");

    // 宽松一档：small 舒服（good）、medium 偏紧 → 取舒服的那个，不取参数更大的
    const mixed = machine({ gpu: noGpu, totalGB: 9 }); // 预算 5.4GB
    const fitsMixed = fitModelsForMachine(mixed, catalog);
    expect(fitsMixed.find((f) => f.id === "small")!.level).toBe("good");
    expect(fitsMixed.find((f) => f.id === "medium")!.level).toBe("tight");
    expect(recommendModel(fitsMixed)?.id).toBe("small");
  });

  test("没有量化档位信息的模型（variants 为空）不进适配表", () => {
    const fits = fitModelsForMachine(machine({ gpu: appleGpu, totalGB: 64 }), [
      { id: "mlx", paramsB: 30, kvBytesPerToken: KV, variants: [] },
    ]);
    expect(fits).toEqual([]);
  });
});

describe("引擎推荐", () => {
  const none = { llama: false, vllm: false, sglang: false, mlx: false };

  test("Apple 芯片：装了 mlx-lm 推 MLX，没装推 llama.cpp（Metal）", () => {
    const m = machine({ gpu: appleGpu, totalGB: 32 });
    expect(recommendEngine(m, { ...none, mlx: true })).toEqual({
      engine: "mlx",
      reason: { code: "mlx-installed" },
    });
    expect(recommendEngine(m, none).reason.code).toBe("apple-metal");
  });

  test("大显存 NVIDIA 且装了 vLLM 才推 vLLM", () => {
    const big = machine({ gpu: nvidia(VLLM_VRAM_THRESHOLD_BYTES / GB), totalGB: 128, arch: "x64", platform: "linux" });
    expect(recommendEngine(big, { ...none, vllm: true }).engine).toBe("vllm");
    // 没装 vLLM：不推荐一套用不了的东西
    expect(recommendEngine(big, none).engine).toBe("llama.cpp");
  });

  test("小显存 NVIDIA 仍推 llama.cpp（bf16 权重在这档显存上跑不了大模型）", () => {
    const small = machine({ gpu: nvidia(24), totalGB: 64, arch: "x64", platform: "linux" });
    expect(recommendEngine(small, { ...none, vllm: true })).toEqual({
      engine: "llama.cpp",
      reason: { code: "generic" },
    });
  });
});

describe("命令输出解析", () => {
  test("nvidia-smi：单卡、多卡取显存最大的、缺显存字段也不炸", () => {
    expect(parseNvidiaSmiOutput("NVIDIA GeForce RTX 4090, 24564\n")).toEqual({
      kind: "nvidia",
      name: "NVIDIA GeForce RTX 4090",
      vramBytes: 24564 * 1024 * 1024,
    });
    expect(
      parseNvidiaSmiOutput("NVIDIA A100-SXM4-40GB, 40960\nNVIDIA GeForce RTX 3090, 24576\n"),
    ).toEqual({ kind: "nvidia", name: "NVIDIA A100-SXM4-40GB", vramBytes: 40960 * 1024 * 1024 });
    // 老驱动 / 某些 MIG 模式下 memory.total 回 [N/A]
    expect(parseNvidiaSmiOutput("NVIDIA H100 PCIe, [N/A]\n")).toEqual({
      kind: "nvidia",
      name: "NVIDIA H100 PCIe",
      vramBytes: null,
    });
    expect(parseNvidiaSmiOutput("")).toBeNull();
  });

  test("system_profiler：Intel Mac 的独显与显存", () => {
    const output = [
      "Graphics/Displays:",
      "",
      "    AMD Radeon Pro 5500M:",
      "",
      "      Chipset Model: AMD Radeon Pro 5500M",
      "      Type: GPU",
      "      VRAM (Total): 4 GB",
      "      Vendor: AMD (0x1002)",
    ].join("\n");
    expect(parseDisplaysChipset(output)).toEqual({
      kind: "amd",
      name: "AMD Radeon Pro 5500M",
      vramBytes: 4 * GB,
    });
  });

  test("system_profiler：Apple 芯片没有显存行（统一内存），按 apple 归类", () => {
    const output = [
      "Graphics/Displays:",
      "",
      "    Apple M3 Ultra:",
      "",
      "      Chipset Model: Apple M3 Ultra",
      "      Vendor: Apple (0x106b)",
      "      Metal Support: Metal 4",
    ].join("\n");
    expect(parseDisplaysChipset(output)).toEqual({
      kind: "apple",
      name: "Apple M3 Ultra",
      vramBytes: null,
    });
    expect(parseDisplaysChipset("Graphics/Displays:\n")).toBeNull();
  });

  test("显存文本：GB / MB / TB 都认", () => {
    expect(parseVramText("4 GB")).toBe(4 * GB);
    expect(parseVramText("1536 MB")).toBe(1536 * 1e6);
    expect(parseVramText("2 TB")).toBe(2e12);
    expect(parseVramText("—")).toBeNull();
  });
});
