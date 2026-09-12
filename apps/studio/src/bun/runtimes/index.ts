import { getSetting } from "../db/settings";
import type { InferenceEngine } from "../../shared/engines";
import { LlamaRuntime } from "./llama";
import { VllmRuntime } from "./vllm";
import { SglangRuntime } from "./sglang";
import { MlxRuntime } from "./mlx";
import type { Runtime } from "./types";

export type { Runtime, ServerStatus, StartResult, BinaryCheckResult } from "./types";
// 引擎类型定义在 shared/engines.ts（唯一真源），这里转出保持既有导入路径可用。
export type { InferenceEngine } from "../../shared/engines";

const runtimes: Record<InferenceEngine, () => Runtime> = {
  "llama.cpp": () => new LlamaRuntime(),
  vllm: () => new VllmRuntime(),
  sglang: () => new SglangRuntime(),
  mlx: () => new MlxRuntime(),
};

let activeRuntime: Runtime | null = null;
let currentEngine: InferenceEngine | null = null;

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

/** Fresh, unattached runtime instance for `engine` (e.g. command previews; never spawns a process). */
export function createRuntime(engine: InferenceEngine): Runtime {
  return runtimes[engine]();
}

export function setRuntime(runtime: Runtime) {
  activeRuntime = runtime;
}
