import { describe, expect, test } from "bun:test";

import { engineInstallSupport } from "./engines";

/**
 * 「能不能一键安装」的判定是界面按钮与主进程真实行为的共同前提：这里错了，
 * 要么是一个点下去必然失败的按钮，要么是明明能装却只给一句手动提示。
 */
describe("engineInstallSupport", () => {
  test("llama.cpp：官方有预编译构建的平台都能装", () => {
    for (const [platform, arch] of [
      ["darwin", "arm64"],
      ["darwin", "x64"],
      ["linux", "x64"],
      ["linux", "arm64"],
      ["win32", "x64"],
      ["win32", "arm64"],
    ] as const) {
      const support = engineInstallSupport("llama.cpp", platform, arch);
      expect(support.supported).toBe(true);
      expect(support.kind).toBe("binary");
      expect(support.approxBytes).toBeGreaterThan(0);
    }
  });

  test("llama.cpp：没有官方构建的架构如实说不支持，并给出原因", () => {
    const support = engineInstallSupport("llama.cpp", "linux", "s390x");
    expect(support.supported).toBe(false);
    expect(support.note).toContain("s390x");
  });

  test("MLX：只有 Apple Silicon 的 macOS 能装", () => {
    expect(engineInstallSupport("mlx", "darwin", "arm64").supported).toBe(true);
    const intel = engineInstallSupport("mlx", "darwin", "x64");
    expect(intel.supported).toBe(false);
    expect(intel.note).toContain("Apple Silicon");
    expect(engineInstallSupport("mlx", "linux", "x64").supported).toBe(false);
  });

  test("vLLM / SGLang：只有 Linux 有 CUDA 轮子，macOS / Windows 只给手动提示", () => {
    for (const engine of ["vllm", "sglang"] as const) {
      expect(engineInstallSupport(engine, "linux", "x64").supported).toBe(true);
      expect(engineInstallSupport(engine, "linux", "x64").kind).toBe("python");

      const mac = engineInstallSupport(engine, "darwin", "arm64");
      expect(mac.supported).toBe(false);
      expect(mac.note).toContain("Linux");

      expect(engineInstallSupport(engine, "win32", "x64").supported).toBe(false);
      // 大体积如实标注：vLLM / SGLang 光 PyTorch 就是几个 GB
      expect(engineInstallSupport(engine, "linux", "x64").approxBytes).toBeGreaterThan(1e9);
    }
  });

  test("需要先具备的前提会写在 requirement 里（Python / 驱动）", () => {
    expect(engineInstallSupport("mlx", "darwin", "arm64").requirement).toContain("Python");
    expect(engineInstallSupport("vllm", "linux", "x64").requirement).toContain("NVIDIA");
  });
});
