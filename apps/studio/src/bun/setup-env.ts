import { createRuntime } from "./runtimes";
import { getHardwareInfo } from "./hardware";
import { isEngineInstalling, readInstalledEngineVersion } from "./engine-install";
import { engineInstallSupport, type InferenceEngine } from "../shared/engines";
import type { HardwareInfo } from "../shared/hardware";

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
  /**
   * 机器画像（芯片名 / 核数 / 内存 / 显卡与显存 / 推理内存预算）。引导页据此推荐
   * 引擎与模型档位 —— 探测在 `bun/hardware.ts`，平台判断也从它这里取，避免两处
   * 各判一次（过去 `appleSilicon` 看 arch、`hasNvidiaGpu` 看有没有 nvidia-smi）。
   */
  hardware: HardwareInfo;
  /** 各引擎能不能一键安装（界面据此决定给按钮还是只给手动提示）。 */
  installSupport: Record<InferenceEngine, ReturnType<typeof engineInstallSupport>>;
  /** 应用自己装的那份的版本（如 llama.cpp 的 `b10976`）；没装过为 null。 */
  installedVersions: Record<InferenceEngine, string | null>;
  /** 正在安装的引擎；界面重载后据此恢复「安装中」状态。 */
  installing: InferenceEngine | null;
  llama: { found: boolean; path?: string };
  vllm: { found: boolean };
  sglang: { found: boolean };
  /** Apple MLX（mlx-lm）——仅在 macOS 上检测。 */
  mlx: { found: boolean };
};

export async function getSetupEnvironment(): Promise<SetupEnvironment> {
  const hardware = getHardwareInfo();
  const { platform, arch } = hardware;

  const [llama, vllm, sglang, mlx] = await Promise.all([
    createRuntime("llama.cpp").checkBinary(),
    createRuntime("vllm").checkBinary(),
    createRuntime("sglang").checkBinary(),
    // MLX 引擎只在 macOS 提供（mlx-lm 面向 Apple Silicon）。
    platform === "darwin" ? createRuntime("mlx").checkBinary() : Promise.resolve({ found: false }),
  ]);

  return {
    platform,
    arch,
    appleSilicon: hardware.chipVendor === "apple" && arch === "arm64",
    // 探测成功才算有独显：装过 nvidia-smi 但驱动/显卡不在的机器（无头服务器）不该被推荐 CUDA 引擎。
    hasNvidiaGpu: hardware.gpu.kind === "nvidia",
    hardware,
    installSupport: {
      "llama.cpp": engineInstallSupport("llama.cpp", platform, arch),
      vllm: engineInstallSupport("vllm", platform, arch),
      sglang: engineInstallSupport("sglang", platform, arch),
      mlx: engineInstallSupport("mlx", platform, arch),
    },
    installedVersions: {
      "llama.cpp": readInstalledEngineVersion("llama.cpp"),
      vllm: readInstalledEngineVersion("vllm"),
      sglang: readInstalledEngineVersion("sglang"),
      mlx: readInstalledEngineVersion("mlx"),
    },
    installing: isEngineInstalling(),
    llama: { found: llama.found, path: llama.path },
    vllm: { found: vllm.found },
    sglang: { found: sglang.found },
    mlx: { found: mlx.found },
  };
}
