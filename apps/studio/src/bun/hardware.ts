import { cpus, freemem, totalmem } from "node:os";

import {
  classifyChipVendor,
  inferenceMemoryBudget,
  parseDisplaysChipset,
  parseNvidiaSmiOutput,
  type ChipVendor,
  type GpuInfo,
  type HardwareInfo,
} from "../shared/hardware";
import { logEvent } from "./app-log";
import { DEFAULT_COMMAND_TIMEOUT_MS, defaultCommandRunner, type CommandRunner } from "./command-runner";

/**
 * 机器画像探测：芯片名、核数、内存、显卡（型号 + 显存）。
 *
 * 只用系统自带命令，全部同步且带超时，失败一律降级而不是抛错（引导页不能因为少一条
 * 命令就卡住）：
 *  - macOS：`sysctl -n machdep.cpu.brand_string` —— Apple 芯片直接回 `Apple M3 Ultra`，
 *    Intel 机回 CPU 型号；只有 Intel 机才去跑 `system_profiler SPDisplaysDataType`
 *    （秒级，为了拿独显型号与显存），Apple 芯片的 GPU 就是芯片本身，不必再跑。
 *  - Linux / Windows：`nvidia-smi` 查独显（显存决定 vLLM 能跑多大），其余走 node:os。
 *
 * 命令与系统信息都可注入，探测路径在测试里用假 runner 走一遍（`bun/hardware.test.ts`），
 * 不用依赖跑测试的那台机器长什么样。
 */

const CHIP_TIMEOUT_MS = DEFAULT_COMMAND_TIMEOUT_MS;
/** system_profiler 是秒级命令，给宽一点，超时也要能继续（显存缺失只影响预算口径）。 */
const PROFILER_TIMEOUT_MS = 8_000;

export type { CommandRunner } from "./command-runner";

const defaultRunner: CommandRunner = defaultCommandRunner;

export type DetectHardwareOptions = {
  platform?: string;
  arch?: string;
  /** `node:os` 的 cpus() 结果（只要 model 字段）。 */
  cpuList?: { model: string }[];
  totalMemoryBytes?: number;
  freeMemoryBytes?: number;
  runner?: CommandRunner;
};

/** macOS 的芯片名：Apple 芯片与 Intel 机都由这一条给出（`hw.model` 另取机型标识）。 */
function readMacChipName(runner: CommandRunner): string | null {
  const res = runner.run(["sysctl", "-n", "machdep.cpu.brand_string"]);
  const value = res.stdout.trim().split("\n")[0]?.trim();
  if (res.code !== 0 || !value) {
    logEvent({
      level: "warn",
      source: "app",
      event: "hardware.chip.probe_failed",
      message: "sysctl machdep.cpu.brand_string 读取失败，芯片名回落到 CPU 上报的型号",
      detail: { code: res.code, stderr: res.stderr.trim() },
    });
    return null;
  }
  return value;
}

function readMacModelId(runner: CommandRunner): string | undefined {
  const res = runner.run(["sysctl", "-n", "hw.model"]);
  const value = res.stdout.trim();
  return res.code === 0 && value ? value : undefined;
}

/** 物理核 / 逻辑核：`node:os` 只给逻辑核数（Apple 芯片上还会漏掉 P/E 的差别）。 */
function readMacCpuCounts(runner: CommandRunner): { physical: number; logical: number } | null {
  const res = runner.run(["sysctl", "-n", "hw.physicalcpu", "hw.logicalcpu"]);
  if (res.code !== 0) return null;
  const [physical, logical] = res.stdout.trim().split(/\s+/).map((v) => Number.parseInt(v, 10));
  if (!physical || !logical) return null;
  return { physical, logical };
}

/**
 * 独显：`nvidia-smi` 能答就用它（显存是这里的头等目标）。命令不存在是常态
 * （Mac / 纯 CPU 机器），只有「命令在却答不出来」才值得记一条日志。
 */
function detectNvidiaGpu(runner: CommandRunner): GpuInfo | null {
  const res = runner.run([
    "nvidia-smi",
    "--query-gpu=name,memory.total",
    "--format=csv,noheader,nounits",
  ]);
  if (res.code !== 0) {
    const missing = /not found|no such file|enoent/i.test(res.stderr);
    if (!missing && res.stderr.trim()) {
      logEvent({
        level: "warn",
        source: "app",
        event: "hardware.gpu.nvidia_probe_failed",
        message: "nvidia-smi 探测失败，按无独显处理",
        detail: { code: res.code, stderr: res.stderr.trim() },
      });
    }
    return null;
  }
  return parseNvidiaSmiOutput(res.stdout);
}

/** Intel Mac 的独显（AMD / Intel 核显）与显存，只能从 system_profiler 里读。 */
function detectMacDiscreteGpu(runner: CommandRunner): GpuInfo | null {
  const res = runner.run(["system_profiler", "SPDisplaysDataType"], PROFILER_TIMEOUT_MS);
  if (res.code !== 0) {
    logEvent({
      level: "warn",
      source: "app",
      event: "hardware.gpu.profiler_failed",
      message: "system_profiler 读取显卡失败，显存未知",
      detail: { code: res.code, stderr: res.stderr.trim() },
    });
    return null;
  }
  return parseDisplaysChipset(res.stdout);
}

function detectGpu(
  platform: string,
  arch: string,
  chipName: string,
  chipVendor: ChipVendor,
  runner: CommandRunner,
): GpuInfo {
  // Apple 芯片：GPU 就是芯片本身，统一内存即显存，不必再跑任何命令。
  if (platform === "darwin" && (arch === "arm64" || chipVendor === "apple")) {
    return { kind: "apple", name: chipName, vramBytes: null };
  }
  const nvidia = detectNvidiaGpu(runner);
  if (nvidia) return nvidia;
  if (platform === "darwin") {
    return detectMacDiscreteGpu(runner) ?? { kind: "unknown", name: "未识别显卡", vramBytes: null };
  }
  return { kind: "none", name: "未检测到独立显卡", vramBytes: null };
}

export function detectHardware(options: DetectHardwareOptions = {}): HardwareInfo {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const runner = options.runner ?? defaultRunner;
  const cpuList = options.cpuList ?? cpus();
  const totalMemoryBytes = options.totalMemoryBytes ?? totalmem();
  const freeMemoryBytes = options.freeMemoryBytes ?? freemem();

  const chipName = (platform === "darwin" ? readMacChipName(runner) : null) ?? cpuList[0]?.model?.trim() ?? arch;
  const chipVendor = classifyChipVendor(chipName);
  const gpu = detectGpu(platform, arch, chipName, chipVendor, runner);
  const { budgetBytes, basis } = inferenceMemoryBudget({ gpu, totalMemoryBytes });
  // 非 macOS 平台拿不到物理核数（`node:os` 只给逻辑核），退回逻辑核数并如实标注。
  const cores = platform === "darwin" ? readMacCpuCounts(runner) : null;
  const cpuThreads = Math.max(1, cores?.logical ?? cpuList.length);

  const info: HardwareInfo = {
    platform,
    arch,
    chipName,
    chipVendor,
    modelId: platform === "darwin" ? readMacModelId(runner) : undefined,
    cpuCores: Math.max(1, cores?.physical ?? cpuList.length),
    cpuThreads,
    gpu,
    totalMemoryBytes,
    freeMemoryBytes,
    budgetBytes,
    budgetBasis: basis,
  };

  logEvent({
    level: "debug",
    source: "app",
    event: "hardware.detect",
    message: `${info.chipName} / ${info.gpu.name}`,
    detail: {
      platform,
      arch,
      gpuKind: info.gpu.kind,
      vramBytes: info.gpu.vramBytes,
      totalMemoryBytes,
      budgetBytes,
      budgetBasis: basis,
    },
  });
  return info;
}

let cached: HardwareInfo | null = null;

/**
 * 机器画像（进程内缓存）。芯片与内存在运行期不会变，引导页的「重新检测」只关心
 * 引擎二进制，不必把 sysctl / system_profiler 再跑一遍。
 */
export function getHardwareInfo(options: { refresh?: boolean } = {}): HardwareInfo {
  if (!options.refresh && cached) return cached;
  cached = detectHardware();
  return cached;
}
