import { getSetting } from "../db/settings";
import { LlamaRuntime } from "./llama";
import { VllmRuntime } from "./vllm";
import { SglangRuntime } from "./sglang";
import type { Runtime } from "./types";

export type { Runtime, ServerStatus, StartResult, BinaryCheckResult } from "./types";

export type InferenceEngine = "llama.cpp" | "vllm" | "sglang";

const runtimes: Record<InferenceEngine, () => Runtime> = {
  "llama.cpp": () => new LlamaRuntime(),
  vllm: () => new VllmRuntime(),
  sglang: () => new SglangRuntime(),
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
