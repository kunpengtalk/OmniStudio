import { createRuntime } from "./runtimes";

/**
 * Facts about the user's machine used by the first-run setup guide to
 * recommend an inference engine and check that the needed runtime binary is
 * actually installed.
 */
export type SetupEnvironment = {
  platform: string;
  arch: string;
  /** macOS on Apple Silicon — llama.cpp can use the Metal backend. */
  appleSilicon: boolean;
  /** NVIDIA GPU detected via `nvidia-smi` — vLLM / SGLang need CUDA. */
  hasNvidiaGpu: boolean;
  llama: { found: boolean; path?: string };
  vllm: { found: boolean };
  sglang: { found: boolean };
};

export async function getSetupEnvironment(): Promise<SetupEnvironment> {
  const platform = process.platform;
  const arch = process.arch;

  const [llama, vllm, sglang] = await Promise.all([
    createRuntime("llama.cpp").checkBinary(),
    createRuntime("vllm").checkBinary(),
    createRuntime("sglang").checkBinary(),
  ]);

  return {
    platform,
    arch,
    appleSilicon: platform === "darwin" && arch === "arm64",
    hasNvidiaGpu: !!(await Bun.which("nvidia-smi")),
    llama: { found: llama.found, path: llama.path },
    vllm: { found: vllm.found },
    sglang: { found: sglang.found },
  };
}
