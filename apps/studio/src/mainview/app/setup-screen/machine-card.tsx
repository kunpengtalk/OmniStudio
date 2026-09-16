import { CpuIcon, MemoryStickIcon, SparklesIcon } from "lucide-react";

import { formatBytes } from "@lib/format";
import {
  SYSTEM_BUDGET_RATIO,
  UNIFIED_BUDGET_RATIO,
  VRAM_BUDGET_RATIO,
  type EngineRecommendation,
  type HardwareInfo,
  type MemoryBasis,
} from "@/shared/hardware";

import { SummaryRow } from "./shared";

/**
 * 引导页首屏的「这台机器」：芯片、核数、内存、显卡，以及推理可用预算。
 *
 * 内存预算不是把物理内存原样端出去 —— 统一内存要给系统留一份、独显要给显示输出和
 * 显存碎片留一份，用户看到的那个数就是后面所有「约占多少内存」的比较基准。口径
 * 比例直接读共享层的常数，界面文案与估算逻辑不会各说一套。
 */
function budgetNote(basis: MemoryBasis): string {
  if (basis === "unified") return `统一内存的 ${Math.round(UNIFIED_BUDGET_RATIO * 100)}%`;
  if (basis === "vram") return `显存的 ${Math.round(VRAM_BUDGET_RATIO * 100)}%`;
  return `内存的 ${Math.round(SYSTEM_BUDGET_RATIO * 100)}%`;
}

/** 显卡一行：Apple 芯片不重复芯片名（上面刚写过），只说明"显存就是内存"。 */
function gpuText(hardware: HardwareInfo): string {
  if (hardware.gpu.kind === "apple") return "内置 GPU · 统一内存，Metal 加速";
  if (hardware.gpu.vramBytes) {
    return `${hardware.gpu.name} · 显存 ${formatBytes(hardware.gpu.vramBytes, { gbDecimals: 0 })}`;
  }
  return hardware.gpu.name;
}

/** 为什么推荐这个引擎 —— 文案在这里，判定在共享层（`recommendEngine` 只回代号）。 */
export function engineReasonText(rec: EngineRecommendation, hardware: HardwareInfo): string {
  switch (rec.reason.code) {
    case "mlx-installed":
      return "已装 mlx-lm：Apple 芯片上同一份权重推理更快";
    case "apple-metal":
      return `${hardware.chipName} 的 GPU 走 Metal，装一个二进制就能跑`;
    case "nvidia-vram":
      return `检测到独显（显存 ${formatBytes(rec.reason.vramBytes ?? 0, { gbDecimals: 0 })}），vLLM 吞吐更高`;
    default:
      return "兼容性最好：GGUF 量化在 CPU / GPU / 统一内存上都能跑";
  }
}

export function MachineCard({
  hardware,
  recommendation,
}: {
  hardware: HardwareInfo;
  /** 一句话推荐（引擎 + 模型 + 估算占用），由调用方组装：那里才知道装了哪些引擎。 */
  recommendation?: string;
}) {
  const cores =
    hardware.cpuCores === hardware.cpuThreads
      ? `${hardware.cpuCores} 核`
      : `${hardware.cpuCores} 核 / ${hardware.cpuThreads} 线程`;

  return (
    <div className="flex flex-col gap-2 rounded-lg border px-4 py-3">
      <div className="flex items-center gap-2">
        <CpuIcon className="size-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{hardware.chipName}</span>
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          {cores}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <SummaryRow
          label="内存"
          value={`${formatBytes(hardware.totalMemoryBytes, { gbDecimals: 0 })} · 当前空闲 ${formatBytes(hardware.freeMemoryBytes, { gbDecimals: 0 })}`}
        />
        <SummaryRow
          label="推理可用预算"
          value={`${formatBytes(hardware.budgetBytes, { gbDecimals: 0 })}（${budgetNote(hardware.budgetBasis)}）`}
        />
        <SummaryRow label="显卡" value={gpuText(hardware)} />
      </div>

      {recommendation && (
        <div className="mt-0.5 flex items-start gap-2 rounded-md bg-primary/5 px-3 py-2">
          <SparklesIcon className="mt-0.5 size-3.5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 text-xs text-muted-foreground">{recommendation}</span>
        </div>
      )}
    </div>
  );
}

/** 模型列表页顶部的机型提示（列表里的"约占多少"都以它为准）。 */
export function MachineHint({ hardware }: { hardware: HardwareInfo }) {
  return (
    <div className="flex items-start gap-2 rounded-md bg-muted/50 px-3 py-2">
      <MemoryStickIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">
        {hardware.chipName} · 推理可用预算 {formatBytes(hardware.budgetBytes, { gbDecimals: 0 })}
        ，下面每组档位按 8K 上下文的估算占用
      </span>
    </div>
  );
}
