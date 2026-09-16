import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import type { CommandResult, CommandRunner } from "./command-runner";
import {
  findLlamaServerDir,
  installLlamaCpp,
  planLlamaAsset,
  verifyLlamaBinary,
  type AssetFetcher,
  type LlamaRelease,
} from "./engine-install";
import type { InstallPhase, InstallReporter } from "./python-engine";

/**
 * llama.cpp 一键安装的回归：装配清单选择、下载 → 解包 → 验证 → 落位、GPU 变体失败
 * 回退 CPU、失败时不留半个安装。
 *
 * 全部走注入的假实现：不联网、不解真包、不依赖跑测试的机器是哪个平台 ——
 * 上游的资产名（`llama-b10976-bin-macos-arm64.tar.gz`）会随构建号与命名习惯变，
 * 这些用例正是用来钉住"名字变了我们还能不能挑对"。
 */
const decks = new Set<string>();

function tempRoot(label: string): string {
  const dir = join(tmpdir(), `omni-engine-install-${label}-${process.pid}-${decks.size}`);
  decks.add(dir);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterAll(() => {
  for (const dir of decks) rmSync(dir, { recursive: true, force: true });
});

const RELEASE_ASSETS = [
  "cudart-llama-b10976-bin-ubuntu-cuda-12.8-x64.tar.gz",
  "cudart-llama-b10976-bin-ubuntu-cuda-13.3-arm64.tar.gz",
  "llama-b10976-bin-macos-arm64.tar.gz",
  "llama-b10976-bin-macos-x64.tar.gz",
  "llama-b10976-bin-ubuntu-arm64.tar.gz",
  "llama-b10976-bin-ubuntu-cuda-12.8-x64.tar.gz",
  "llama-b10976-bin-ubuntu-vulkan-x64.tar.gz",
  "llama-b10976-bin-ubuntu-x64.tar.gz",
  "llama-b10976-bin-win-cpu-arm64.zip",
  "llama-b10976-bin-win-cpu-x64.zip",
  "cudart-llama-bin-win-cuda-12.4-x64.zip",
  "llama-b10976-bin-win-cuda-12.4-x64.zip",
  // 上游现在同时发 CUDA 13.4（新卡要它）与 Vulkan（不挑显卡）
  "cudart-llama-bin-win-cuda-13.4-x64.zip",
  "llama-b10976-bin-win-cuda-13.4-x64.zip",
  "llama-b10976-bin-win-vulkan-x64.zip",
];

function release(): LlamaRelease {
  return {
    tag: "b10976",
    assets: RELEASE_ASSETS,
    sizes: Object.fromEntries(RELEASE_ASSETS.map((name) => [name, 20_000_000])),
  };
}

/** 收集安装过程的日志与阶段，供断言"用户看得到什么"。 */
function reporter(): InstallReporter & { lines: string[]; phases: InstallPhase[] } {
  const lines: string[] = [];
  const phases: InstallPhase[] = [];
  return {
    lines,
    phases,
    log: (text) => lines.push(text),
    phase: (phase) => phases.push(phase),
  };
}

/** 假 runner：`tar` 直接"解包"出目标文件，二进制自证按配置返回。 */
function fakeRunner(options: {
  /** `--list-devices` 是否成功（模拟 CUDA / Vulkan 起不来）。 */
  gpuWorks?: boolean;
  /** `--version` 是否成功（模拟签名坏掉 / 架构不对）。 */
  binaryWorks?: boolean;
}): CommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: (cmd): CommandResult => {
      calls.push(cmd);
      if (cmd[0] === "tar") {
        // 最后一个参数是 -C 的输出目录
        const outDir = cmd[cmd.length - 1]!;
        const serverDir = join(outDir, "llama-b10976");
        mkdirSync(serverDir, { recursive: true });
        writeFileSync(join(serverDir, "llama-server"), "#!/bin/sh\n");
        writeFileSync(join(serverDir, "libllama.dylib"), "x");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (cmd[1] === "--version") {
        return options.binaryWorks === false
          ? { code: 1, stdout: "", stderr: "killed" }
          : { code: 0, stdout: "version: 10976 (abc123)\n", stderr: "" };
      }
      if (cmd[1] === "--list-devices") {
        return options.gpuWorks === false
          ? { code: 1, stdout: "", stderr: "ggml_cuda_init: failed to initialize CUDA" }
          : { code: 0, stdout: "CUDA0: NVIDIA GeForce RTX 4090\n", stderr: "" };
      }
      return { code: -1, stdout: "", stderr: `unexpected: ${cmd.join(" ")}` };
    },
    runStreaming: async (cmd, onLine) => {
      onLine(`unexpected streaming: ${cmd.join(" ")}`);
      return -1;
    },
  };
}

/** 假下载：把"资产"落成一个占位文件并记账。 */
function fakeFetcher(): AssetFetcher & { fetched: string[] } {
  const fetched: string[] = [];
  const fetcher = (async (urls, dest, what) => {
    fetched.push(what);
    expect(urls[0]).toContain("github.com/ggml-org/llama.cpp/releases/download/b10976/");
    writeFileSync(dest, "fake-archive");
    return { ok: true };
  }) as AssetFetcher & { fetched: string[] };
  fetcher.fetched = fetched;
  return fetcher;
}

describe("planLlamaAsset", () => {
  test("macOS：按架构挑带 Metal 的构建", () => {
    expect(planLlamaAsset(RELEASE_ASSETS, "darwin", "arm64")).toMatchObject({
      asset: "llama-b10976-bin-macos-arm64.tar.gz",
      archive: "tar.gz",
    });
    expect(planLlamaAsset(RELEASE_ASSETS, "darwin", "x64")?.asset).toBe("llama-b10976-bin-macos-x64.tar.gz");
  });

  test("Linux + NVIDIA：挑 CUDA 构建并带上配套的 cudart 包", () => {
    const plan = planLlamaAsset(RELEASE_ASSETS, "linux", "x64", "nvidia");
    expect(plan?.asset).toBe("llama-b10976-bin-ubuntu-cuda-12.8-x64.tar.gz");
    expect(plan?.companion).toBe("cudart-llama-b10976-bin-ubuntu-cuda-12.8-x64.tar.gz");
    expect(plan?.expectGpu).toBe(true);
  });

  test("Linux + NVIDIA 但发布里没有 cudart：退到 CPU 构建（缺运行库的 CUDA 包装不起来）", () => {
    const assets = RELEASE_ASSETS.filter((name) => !name.startsWith("cudart-"));
    const plan = planLlamaAsset(assets, "linux", "x64", "nvidia");
    expect(plan?.asset).toBe("llama-b10976-bin-ubuntu-x64.tar.gz");
    expect(plan?.companion).toBeUndefined();
    expect(plan?.expectGpu).toBeFalsy();
  });

  test("Linux + AMD/Intel 独显：走 Vulkan（不需要额外运行库）", () => {
    const plan = planLlamaAsset(RELEASE_ASSETS, "linux", "x64", "amd");
    expect(plan?.asset).toBe("llama-b10976-bin-ubuntu-vulkan-x64.tar.gz");
    expect(plan?.companion).toBeUndefined();
    expect(plan?.expectGpu).toBe(true);
  });

  test("Windows + NVIDIA：优先最新的 CUDA 构建（新卡要它），并带上配套 cudart", () => {
    const nvidia = planLlamaAsset(RELEASE_ASSETS, "win32", "x64", "nvidia");
    expect(nvidia?.asset).toBe("llama-b10976-bin-win-cuda-13.4-x64.zip");
    expect(nvidia?.companion).toBe("cudart-llama-bin-win-cuda-13.4-x64.zip");
    expect(nvidia?.archive).toBe("zip");
    expect(nvidia?.expectGpu).toBe(true);
  });

  test("Windows + NVIDIA 但只有旧 CUDA：退到 12.4，而不是直接 CPU", () => {
    const assets = RELEASE_ASSETS.filter((name) => !name.includes("cuda-13.4"));
    const plan = planLlamaAsset(assets, "win32", "x64", "nvidia");
    expect(plan?.asset).toBe("llama-b10976-bin-win-cuda-12.4-x64.zip");
    expect(plan?.companion).toBe("cudart-llama-bin-win-cuda-12.4-x64.zip");
  });

  test("Windows + AMD/Intel 独显：走 Vulkan（以前只有 CPU 可退 —— issue #10 的同类机器）", () => {
    const plan = planLlamaAsset(RELEASE_ASSETS, "win32", "x64", "amd");
    expect(plan?.asset).toBe("llama-b10976-bin-win-vulkan-x64.zip");
    expect(plan?.companion).toBeUndefined();
    expect(plan?.expectGpu).toBe(true);
  });

  test("Windows：没探到独显时不去下 Vulkan（省一次没意义的下载）", () => {
    const cpu = planLlamaAsset(RELEASE_ASSETS, "win32", "x64", "none");
    expect(cpu?.asset).toBe("llama-b10976-bin-win-cpu-x64.zip");
    expect(cpu?.archive).toBe("zip");

    expect(planLlamaAsset(RELEASE_ASSETS, "win32", "arm64", "none")?.asset).toBe(
      "llama-b10976-bin-win-cpu-arm64.zip",
    );
  });

  test("exclude：把已经试过的变体排掉，自然落到下一档", () => {
    const tried = new Set(["llama-b10976-bin-win-cuda-13.4-x64.zip"]);
    const next = planLlamaAsset(RELEASE_ASSETS, "win32", "x64", "nvidia", tried);
    expect(next?.asset).toBe("llama-b10976-bin-win-cuda-12.4-x64.zip");
  });

  test("上游改了命名（构建号变了）：仍然按模式匹配，不写死版本号", () => {
    const renamed = RELEASE_ASSETS.map((name) => name.replace("b10976", "b12000"));
    expect(planLlamaAsset(renamed, "darwin", "arm64")?.asset).toBe("llama-b12000-bin-macos-arm64.tar.gz");
  });

  test("资产列表里什么都没有：返回 null，界面给手动提示", () => {
    expect(planLlamaAsset(["nightly-tag.txt"], "darwin", "arm64")).toBeNull();
  });
});

describe("findLlamaServerDir / verifyLlamaBinary", () => {
  test("在解包出来的目录树里找到 llama-server 那一层", () => {
    const root = tempRoot("find");
    const nested = join(root, "out", "llama-b10976");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "llama-server"), "");
    expect(findLlamaServerDir(join(root, "out"))).toBe(nested);
    expect(findLlamaServerDir(join(root, "nope"))).toBeNull();
  });

  test("GPU 变体要额外过 --list-devices（后端真能起来才算装好）", () => {
    const ok = verifyLlamaBinary("/x/llama-server", { runner: fakeRunner({}), expectGpu: true });
    expect(ok.ok).toBe(true);

    const badGpu = verifyLlamaBinary("/x/llama-server", {
      runner: fakeRunner({ gpuWorks: false }),
      expectGpu: true,
    });
    expect(badGpu.ok).toBe(false);
    expect(badGpu.output).toContain("CUDA");

    const badBinary = verifyLlamaBinary("/x/llama-server", { runner: fakeRunner({ binaryWorks: false }) });
    expect(badBinary.ok).toBe(false);
  });
});

describe("installLlamaCpp", () => {
  test("macOS arm64：下载 → 解包 → 验证 → 落到 current/ 并写版本标记", async () => {
    const rootDir = tempRoot("mac");
    const run = fakeRunner({});
    const fetch = fakeFetcher();
    const report = reporter();

    const result = await installLlamaCpp({
      reporter: report,
      runner: run,
      platform: "darwin",
      arch: "arm64",
      gpuKind: "apple",
      rootDir,
      fetchRelease: async () => release(),
      fetchAsset: fetch,
    });

    expect(result).toEqual({ ok: true, version: "b10976" });
    expect(fetch.fetched).toEqual(["llama-b10976-bin-macos-arm64.tar.gz"]);
    expect(existsSync(join(rootDir, "current", "llama-server"))).toBe(true);
    expect(existsSync(join(rootDir, "current", "VERSION"))).toBe(true);
    expect(readFileSync(join(rootDir, "current", "VERSION"), "utf8").trim()).toBe("b10976");
    // 暂存目录不留垃圾
    expect(existsSync(join(rootDir, `.staging-${process.pid}`))).toBe(false);
    // 收尾行是前端判定"安装结束、去刷新引擎状态"的依据
    expect(report.lines[report.lines.length - 1]).toBe("安装成功：llama-server b10976\n");
    expect(report.phases).toContain("downloading");
    expect(report.phases[report.phases.length - 1]).toBe("done");
  });

  test("Linux + NVIDIA：CUDA 构建 + cudart 一起下，解到同一个目录", async () => {
    const rootDir = tempRoot("cuda");
    const fetch = fakeFetcher();
    const result = await installLlamaCpp({
      reporter: reporter(),
      runner: fakeRunner({}),
      platform: "linux",
      arch: "x64",
      gpuKind: "nvidia",
      rootDir,
      fetchRelease: async () => release(),
      fetchAsset: fetch,
    });

    expect(result.ok).toBe(true);
    expect(fetch.fetched).toEqual([
      "llama-b10976-bin-ubuntu-cuda-12.8-x64.tar.gz",
      "cudart-llama-b10976-bin-ubuntu-cuda-12.8-x64.tar.gz",
    ]);
    expect(existsSync(join(rootDir, "current", "llama-server"))).toBe(true);
  });

  test("GPU 变体起不来：自动回退 CPU 构建重装，并说明原因", async () => {
    const rootDir = tempRoot("fallback");
    const fetch = fakeFetcher();
    const report = reporter();

    const result = await installLlamaCpp({
      reporter: report,
      runner: fakeRunner({ gpuWorks: false }),
      platform: "linux",
      arch: "x64",
      gpuKind: "nvidia",
      rootDir,
      fetchRelease: async () => release(),
      fetchAsset: fetch,
    });

    // 第一次 CUDA（主包 + cudart）失败后，第二次只下 CPU 包
    expect(fetch.fetched).toEqual([
      "llama-b10976-bin-ubuntu-cuda-12.8-x64.tar.gz",
      "cudart-llama-b10976-bin-ubuntu-cuda-12.8-x64.tar.gz",
      "llama-b10976-bin-ubuntu-x64.tar.gz",
    ]);
    // CPU 构建仍要过 --list-devices？不 —— 方案本身没有 expectGpu
    expect(result.ok).toBe(true);
    expect(report.lines.some((line) => line.includes("改用 Linux x64（CPU）"))).toBe(true);
  });

  test("Windows + NVIDIA 的变体阶梯：CUDA 13.4 → 12.4 → Vulkan → CPU（issue #10 的回归）", async () => {
    const rootDir = tempRoot("win-ladder");
    const fetch = fakeFetcher();
    const report = reporter();

    const result = await installLlamaCpp({
      reporter: report,
      // 这张卡所有 GPU 变体都起不来（模拟"构建不支持这张卡"）：必须逐档往下换，
      // 而不是像以前那样从第一个 CUDA 直接掉到 CPU。
      runner: fakeRunner({ gpuWorks: false }),
      platform: "win32",
      arch: "x64",
      gpuKind: "nvidia",
      rootDir,
      fetchRelease: async () => release(),
      fetchAsset: fetch,
    });

    expect(fetch.fetched).toEqual([
      "llama-b10976-bin-win-cuda-13.4-x64.zip",
      "cudart-llama-bin-win-cuda-13.4-x64.zip",
      "llama-b10976-bin-win-cuda-12.4-x64.zip",
      "cudart-llama-bin-win-cuda-12.4-x64.zip",
      "llama-b10976-bin-win-vulkan-x64.zip",
      "llama-b10976-bin-win-cpu-x64.zip",
    ]);
    expect(result.ok).toBe(true);
    // 每一档换成了什么都写在日志里：用户看到"显存 0%"时能对上原因
    expect(report.lines.some((line) => line.includes("改用 Windows x64（CUDA 12.4）"))).toBe(true);
    expect(report.lines.some((line) => line.includes("改用 Windows x64（Vulkan）"))).toBe(true);
    expect(report.lines.some((line) => line.includes("改用 Windows x64（CPU）"))).toBe(true);
  });

  test("下载失败：不留半个安装，日志与返回值都说明白", async () => {
    const rootDir = tempRoot("dlfail");
    const report = reporter();
    const result = await installLlamaCpp({
      reporter: report,
      runner: fakeRunner({}),
      platform: "darwin",
      arch: "arm64",
      gpuKind: "apple",
      rootDir,
      fetchRelease: async () => release(),
      fetchAsset: async () => ({ ok: false, error: "所有镜像都不通" }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("所有镜像都不通");
    expect(existsSync(join(rootDir, "current"))).toBe(false);
    expect(existsSync(join(rootDir, `.staging-${process.pid}`))).toBe(false);
    expect(report.lines[report.lines.length - 1]).toBe("llama.cpp 安装失败\n");
    expect(report.phases[report.phases.length - 1]).toBe("failed");
  });

  test("查询发布失败（离线 / 代理不通）：报错可读，不碰托管目录", async () => {
    const rootDir = tempRoot("offline");
    const report = reporter();
    const result = await installLlamaCpp({
      reporter: report,
      runner: fakeRunner({}),
      platform: "darwin",
      arch: "arm64",
      gpuKind: "apple",
      rootDir,
      fetchRelease: async () => {
        throw new Error("GitHub API 返回 403");
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("GitHub API 返回 403");
    expect(result.error).toContain("网络或代理");
    expect(existsSync(join(rootDir, "current"))).toBe(false);
  });

  test("平台没有对应资产：明确说不支持一键安装", async () => {
    const result = await installLlamaCpp({
      reporter: reporter(),
      runner: fakeRunner({}),
      platform: "linux",
      arch: "s390x",
      gpuKind: "none",
      rootDir: tempRoot("s390x"),
      fetchRelease: async () => release(),
      fetchAsset: fakeFetcher(),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("s390x");
  });
});
