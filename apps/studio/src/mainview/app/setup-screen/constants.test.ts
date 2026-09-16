import { describe, expect, test } from "bun:test";

import {
  fitModelsForMachine,
  inferenceMemoryBudget,
  recommendModel,
  type FitLevel,
  type GpuInfo,
  type HardwareInfo,
} from "@/shared/hardware";

import { SETUP_MODELS, setupModelCandidates } from "./constants";

/**
 * 引导页「按机器推荐模型」的真实目录回归。
 *
 * 这里用的是引导页里那一份真实的体积表（不是测试专用的假数据）：以后谁改了量化体积、
 * 加了新模型、动了内存预算口径，这里会直接指出"某档机器上推荐的东西变了"。期望值不是
 * 抄来的，是照着各档机器的结果校过的 —— 变更是有意的就把这一行一起改，顺手确认新结果
 * 仍然说得通。
 */
const GB = 1e9;

function machine(input: { totalGB: number; gpu: GpuInfo }): HardwareInfo {
  const totalMemoryBytes = input.totalGB * GB;
  const { budgetBytes, basis } = inferenceMemoryBudget({ gpu: input.gpu, totalMemoryBytes });
  return {
    platform: input.gpu.kind === "apple" ? "darwin" : "linux",
    arch: input.gpu.kind === "apple" ? "arm64" : "x64",
    chipName: input.gpu.kind === "apple" ? "Apple M3 Pro" : "Test CPU",
    chipVendor: "unknown",
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
const nvidia = (vramGB: number): GpuInfo => ({
  kind: "nvidia",
  name: "NVIDIA GeForce RTX 4090",
  vramBytes: vramGB * GB,
});
const apple = (totalGB: number) => machine({ totalGB, gpu: appleGpu });

describe("引导页按机器推荐（真实模型目录）", () => {
  const cases: {
    label: string;
    machine: HardwareInfo;
    engine: "llama.cpp" | "vllm";
    modelId: string;
    quant: string;
    level: FitLevel;
  }[] = [
    // 统一内存（预算 = 内存的 75%）
    { label: "8GB Mac", machine: apple(8), engine: "llama.cpp", modelId: "qwen35-4b", quant: "Q4_K_M", level: "good" },
    { label: "16GB Mac", machine: apple(16), engine: "llama.cpp", modelId: "qwen35-9b", quant: "Q4_K_M", level: "good" },
    { label: "32GB Mac", machine: apple(32), engine: "llama.cpp", modelId: "qwen35-35b", quant: "Q3_K_M", level: "good" },
    { label: "64GB Mac", machine: apple(64), engine: "llama.cpp", modelId: "qwen35-35b", quant: "Q5_K_M", level: "comfortable" },
    { label: "512GB Mac", machine: apple(512), engine: "llama.cpp", modelId: "qwen35-35b", quant: "Q8_0", level: "comfortable" },
    // vLLM 只有 bf16 权重：大机器才装得下大模型
    { label: "512GB Mac（vLLM）", machine: apple(512), engine: "vllm", modelId: "qwen35-35b", quant: "BF16", level: "comfortable" },
    // 独显（预算 = 显存的 90%）
    { label: "8GB 显存（llama.cpp）", machine: machine({ totalGB: 32, gpu: nvidia(8) }), engine: "llama.cpp", modelId: "qwen35-4b", quant: "Q4_K_M", level: "good" },
    { label: "24GB 显存（llama.cpp）", machine: machine({ totalGB: 64, gpu: nvidia(24) }), engine: "llama.cpp", modelId: "qwen36-27b", quant: "Q3_K_M", level: "good" },
    { label: "80GB 显存（vLLM）", machine: machine({ totalGB: 256, gpu: nvidia(80) }), engine: "vllm", modelId: "qwen35-9b", quant: "BF16", level: "comfortable" },
  ];

  for (const testCase of cases) {
    test(`${testCase.label} → ${testCase.modelId} / ${testCase.quant}`, () => {
      const fits = fitModelsForMachine(testCase.machine, setupModelCandidates(testCase.engine));
      const best = recommendModel(fits);
      expect(best?.id).toBe(testCase.modelId);
      expect(best?.recommended.variant.name).toBe(testCase.quant);
      expect(best?.level).toBe(testCase.level);
    });
  }

  test("小机器（4GB 内存）没有能跑的模型：返回 null，界面保留原选择并标超出内存", () => {
    const fits = fitModelsForMachine(apple(4), setupModelCandidates("llama.cpp"));
    expect(recommendModel(fits)).toBeNull();
    expect(fits.every((fit) => fit.level === "too-large")).toBe(true);
    // 全装不下时仍然给一个最小档，界面据此显示"需要多少内存"
    expect(fits[0]!.recommended.variant.name).toBe("Q3_K_M");
  });

  test("大机器上推荐的档位不会小到浪费内存", () => {
    // 512GB 的机器上，9B 的默认档是 Q4_K_M，但流畅档里还有 Q8_0 → 抬一档
    const fits = fitModelsForMachine(apple(512), setupModelCandidates("llama.cpp"));
    const small = fits.find((f) => f.id === "qwen35-9b")!;
    expect(small.recommended.variant.name).toBe("Q8_0");

    // 32GB 上 27B 连 Q4_K_M 都偏紧 → 退到 Q3_K_M；到 64GB 才回到 Q5_K_M
    const mid = fitModelsForMachine(apple(32), setupModelCandidates("llama.cpp")).find(
      (f) => f.id === "qwen36-27b",
    )!;
    expect(mid.recommended.variant.name).toBe("Q3_K_M");
    const large = fitModelsForMachine(apple(64), setupModelCandidates("llama.cpp")).find(
      (f) => f.id === "qwen36-27b",
    )!;
    expect(large.recommended.variant.name).toBe("Q5_K_M");
  });
});

describe("候选表的形状", () => {
  test("每个模型都有体积与架构常数（缺了就没法做内存估算）", () => {
    for (const model of SETUP_MODELS) {
      expect(model.paramsB).toBeGreaterThan(0);
      expect(model.kvBytesPerToken).toBeGreaterThan(0);
      expect(model.quants.length).toBeGreaterThan(0);
      expect(model.quants.some((q) => q.name === model.defaultQuant)).toBe(true);
    }
  });

  test("llama.cpp 用 GGUF 量化档，vLLM 用整仓库 bf16，MLX 不参与估算", () => {
    const gguf = setupModelCandidates("llama.cpp");
    expect(gguf.map((m) => m.variants.length)).toEqual(SETUP_MODELS.map((m) => m.quants.length));
    expect(gguf[0]!.defaultQuant).toBe(SETUP_MODELS[0]!.defaultQuant);

    const vllm = setupModelCandidates("vllm");
    expect(vllm.every((m) => m.variants.length === 1 && m.variants[0]!.name === "BF16")).toBe(true);
    expect(vllm[0]!.variants[0]!.sizeBytes).toBe(SETUP_MODELS[0]!.hfSizeBytes);

    // MLX 预设只有仓库名，没有体积信息 → 不编数字
    expect(setupModelCandidates("mlx")).toEqual([]);
  });
});
