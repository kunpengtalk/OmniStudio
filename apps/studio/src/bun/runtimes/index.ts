import { getSetting } from "../db/settings";
import type { InferenceEngine } from "../../shared/engines";
import { LlamaRuntime } from "./llama";
import { VllmRuntime } from "./vllm";
import { SglangRuntime } from "./sglang";
import { MlxRuntime } from "./mlx";
import type { Runtime, RuntimeOverrides } from "./types";

export type { Runtime, ServerStatus, StartResult, BinaryCheckResult, RuntimeOverrides } from "./types";
// 引擎类型定义在 shared/engines.ts（唯一真源），这里转出保持既有导入路径可用。
export type { InferenceEngine } from "../../shared/engines";

const runtimes: Record<InferenceEngine, (overrides?: RuntimeOverrides) => Runtime> = {
  "llama.cpp": (overrides) => new LlamaRuntime(overrides),
  vllm: (overrides) => new VllmRuntime(overrides),
  sglang: (overrides) => new SglangRuntime(overrides),
  mlx: (overrides) => new MlxRuntime(overrides),
};

let activeRuntime: Runtime | null = null;
let currentEngine: InferenceEngine | null = null;

/**
 * 兼容用的单实例 runtime：「当前引擎」的那个，绑定设置里的活动模型 / 端口。
 * 多模型并发（已启动模型注册表）走 `createRuntime(engine, overrides)` 各建一个实例。
 */
export function getRuntime(): Runtime {
  const engine = (getSetting("INFERENCE_ENGINE") as InferenceEngine) || "llama.cpp";

  // Recreate runtime if engine changed
  if (engine !== currentEngine || !activeRuntime) {
    if (activeRuntime) {
      // Stop the previous engine's server if it had one running.
      try {
        if (activeRuntime.getStatus() !== "stopped") activeRuntime.forceKill();
      } catch {
        // ignore
      }
    }
    activeRuntime = runtimes[engine]();
    currentEngine = engine;
  }

  return activeRuntime;
}

export function getActiveEngine(): InferenceEngine {
  return (getSetting("INFERENCE_ENGINE") as InferenceEngine) || "llama.cpp";
}

/**
 * Fresh, unattached runtime instance for `engine` (command previews, binary checks,
 * and each concurrently served model — never touches the shared instance).
 */
export function createRuntime(engine: InferenceEngine, overrides?: RuntimeOverrides): Runtime {
  return runtimes[engine](overrides);
}

export function setRuntime(runtime: Runtime) {
  activeRuntime = runtime;
}
