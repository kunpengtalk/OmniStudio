/**
 * 推理引擎的一键安装（引导页 / 设置里的「安装引擎」按钮走这里）。
 *
 * 两条完全不同的路径，但对界面是一件事：
 *  - **llama.cpp**：下载官方预编译二进制（ggml-org/llama.cpp 的 `b<构建号>` 发布），
 *    解包 → 验证能跑 → 原子落到 `<dataDir>/engines/llama.cpp/current`。有 NVIDIA 显卡的
 *    Linux / Windows 自动换 CUDA 构建（并带上配套的 cudart 包）；CUDA 起不来时回退 CPU
 *    构建，而不是丢一个跑不起来的二进制给用户。
 *  - **mlx-lm / vLLM / SGLang**：走 `python-engine.ts` 的 venv 安装。
 *
 * 上游没有可用的「latest」概念（`releases/latest` 指向一个只放 nightly-tag.txt 的稳定
 * 标签），所以装配清单在安装时读 releases 列表挑最新的 `b<构建号>`，再按平台 / 显卡在
 * 资产名里匹配 —— 构建号每次都在变（`llama-b10976-bin-macos-arm64.tar.gz`），不能写死。
 * 下载走 mirror-download 的多镜像链路，与云端模型 / 引擎下载共用代理与重试。
 */
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { join } from "path";

import { ENGINE_SHORT_NAMES, engineInstallSupport, type InferenceEngine } from "../shared/engines";
import type { GpuKind } from "../shared/hardware";
import { logEvent } from "./app-log";
import { defaultCommandRunner, type CommandRunner } from "./command-runner";
import { engineVersionFilePath, llamaCppRootDir, type PythonEngineId } from "./engine-paths";
import { getHardwareInfo } from "./hardware";
import { fetchAssetFromSources, githubReleaseUrls } from "./mirror-download";
import {
  installPythonEngine,
  readPythonEngineVersion,
  type InstallPhase,
  type InstallReporter,
} from "./python-engine";

export type { InstallPhase } from "./python-engine";

export type EngineInstallEvent = {
  engine: InferenceEngine;
  phase: InstallPhase;
  message: string;
  /** 下载类安装的百分比（未知时为 null，界面显示不确定进度）。 */
  percent?: number | null;
};

export type EngineInstallResult = { ok: boolean; error?: string; version?: string };

// ---------------------------------------------------------------------------
// 日志 / 阶段广播（主进程转推前端，见 rpc/index.ts 的 initEngineInstallBroadcast）
// ---------------------------------------------------------------------------

const logListeners = new Set<(text: string) => void>();
const phaseListeners = new Set<(event: EngineInstallEvent) => void>();

export function onEngineInstallLog(cb: (text: string) => void): () => void {
  logListeners.add(cb);
  return () => logListeners.delete(cb);
}

export function onEngineInstallPhase(cb: (event: EngineInstallEvent) => void): () => void {
  phaseListeners.add(cb);
  return () => phaseListeners.delete(cb);
}

function emitLog(text: string): void {
  for (const cb of logListeners) {
    try {
      cb(text);
    } catch {
      // 订阅方出错不影响安装
    }
  }
}

function emitPhase(event: EngineInstallEvent): void {
  for (const cb of phaseListeners) {
    try {
      cb(event);
    } catch {
      // 同上
    }
  }
}

// ---------------------------------------------------------------------------
// llama.cpp：官方构建的资产选择
// ---------------------------------------------------------------------------

export type LlamaAssetPlan = {
  asset: string;
  archive: "tar.gz" | "zip";
  /** CUDA 构建需要的伴随包（CUDA 运行库），解到同一个目录里才能跑。 */
  companion?: string;
  /** 装完用 `--list-devices` 验证 GPU 后端真的能起来（起不来就回退 CPU 构建）。 */
  expectGpu?: boolean;
  /** 日志与界面里给用户看的变体名。 */
  label: string;
};

type PlanRule = Omit<LlamaAssetPlan, "asset" | "companion"> & { match: RegExp; companionMatch?: RegExp };

/** 各平台 / 显卡的资产规则；顺序即优先级（GPU 变体在前，CPU 兜底在后）。 */
function planRules(platform: string, arch: string, gpuKind: GpuKind): PlanRule[] {
  // 架构不在官方产物里就**不给任何规则**：宁可在界面上说"这台机器没有官方构建"，
  // 也不能把一个 x64 二进制塞给 s390x / riscv 之类的机器（装上了也跑不起来）。
  if (arch !== "x64" && arch !== "arm64") return [];

  if (platform === "darwin") {
    const suffix = arch === "arm64" ? "macos-arm64" : "macos-x64";
    return [
      {
        match: new RegExp(`^llama-b\\d+-bin-${suffix}\\.tar\\.gz$`),
        archive: "tar.gz",
        label: arch === "arm64" ? "macOS arm64（Metal）" : "macOS x64（Metal）",
      },
    ];
  }
  if (platform === "win32") {
    const rules: PlanRule[] = [];
    if (gpuKind === "nvidia" && arch === "x64") {
      // 新卡要新 CUDA：12.4 的构建在 Blackwell（RTX 50 系）上连后端都起不来，装完校验
      // 一失败就会掉到 CPU 构建 —— 表现是「跑起来了，但显存占用 0%」（issue #10 的
      // RTX 5090）。上游现在同时发 12.4 与 13.4，新的排前面；缺哪一份（或没有配套
      // cudart）就自动落到下一条。
      rules.push({
        match: /^llama-b\d+-bin-win-cuda-13\.4-x64\.zip$/,
        companionMatch: /^cudart-llama-bin-win-cuda-13\.4-x64\.zip$/,
        archive: "zip",
        expectGpu: true,
        label: "Windows x64（CUDA 13.4）",
      });
      rules.push({
        match: /^llama-b\d+-bin-win-cuda-12\.4-x64\.zip$/,
        companionMatch: /^cudart-llama-bin-win-cuda-12\.4-x64\.zip$/,
        archive: "zip",
        expectGpu: true,
        label: "Windows x64（CUDA 12.4）",
      });
    }
    if (arch === "x64" && gpuKind !== "none") {
      // Vulkan 不挑显卡：AMD / Intel 独显在 Windows 上以前只有 CPU 可退，NVIDIA 机器上
      // CUDA 起不来时它也比 CPU 值得试。上游的 win-vulkan 构建不需要额外运行库。
      rules.push({
        match: /^llama-b\d+-bin-win-vulkan-x64\.zip$/,
        archive: "zip",
        expectGpu: true,
        label: "Windows x64（Vulkan）",
      });
    }
    rules.push({
      match:
        arch === "arm64" ? /^llama-b\d+-bin-win-cpu-arm64\.zip$/ : /^llama-b\d+-bin-win-cpu-x64\.zip$/,
      archive: "zip",
      label: arch === "arm64" ? "Windows arm64（CPU）" : "Windows x64（CPU）",
    });
    return rules;
  }
  if (platform !== "linux") return [];

  const rules: PlanRule[] = [];
  if (gpuKind === "nvidia") {
    const cuda = arch === "arm64" ? "cuda-13\\.3-arm64" : "cuda-12\\.8-x64";
    rules.push({
      match: new RegExp(`^llama-b\\d+-bin-ubuntu-${cuda}\\.tar\\.gz$`),
      companionMatch: new RegExp(`^cudart-llama-b\\d+-bin-ubuntu-${cuda}\\.tar\\.gz$`),
      archive: "tar.gz",
      expectGpu: true,
      label: arch === "arm64" ? "Linux arm64（CUDA 13.3）" : "Linux x64（CUDA 12.8）",
    });
  } else if ((gpuKind === "amd" || gpuKind === "intel") && arch === "x64") {
    // AMD / Intel 独显走 Vulkan：不需要额外运行库（Vulkan loader 由系统提供）。
    rules.push({
      match: /^llama-b\d+-bin-ubuntu-vulkan-x64\.tar\.gz$/,
      archive: "tar.gz",
      expectGpu: true,
      label: "Linux x64（Vulkan）",
    });
  }
  rules.push({
    match:
      arch === "arm64" ? /^llama-b\d+-bin-ubuntu-arm64\.tar\.gz$/ : /^llama-b\d+-bin-ubuntu-x64\.tar\.gz$/,
    archive: "tar.gz",
    label: arch === "arm64" ? "Linux arm64（CPU）" : "Linux x64（CPU）",
  });
  return rules;
}

/** 取规则在该发布里能凑出的方案（同名资产可能被上游改掉，凑不齐返回 null）。
 *  `exclude` 用于逐级重试：上一个变体验证失败后把它的资产排除掉，自然落到下一档。 */
export function planFromRules(
  rules: readonly PlanRule[],
  assets: readonly string[],
  exclude: ReadonlySet<string> = new Set(),
): LlamaAssetPlan | null {
  for (const rule of rules) {
    const asset = assets.find((name) => rule.match.test(name) && !exclude.has(name));
    if (!asset) continue;
    const companion = rule.companionMatch ? assets.find((name) => rule.companionMatch!.test(name)) : undefined;
    // CUDA 构建缺了运行库包等于装了个跑不起来的东西：退到下一个（CPU）方案。
    if (rule.companionMatch && !companion) continue;
    return { asset, companion, archive: rule.archive, expectGpu: rule.expectGpu, label: rule.label };
  }
  return null;
}

/**
 * 发布资产列表 → 装配方案。上游改过资产命名（`-bin-` 前缀与 `.tar.gz` 后缀都变过），
 * 所以逐条降级：GPU 变体拿不到就退 CPU；一个都拿不到返回 null（界面给手动安装提示）。
 * `exclude` 给「上一个变体验证失败」的重试用（见 installLlamaCpp 里的阶梯）。
 */
export function planLlamaAsset(
  assets: readonly string[],
  platform: string,
  arch: string,
  gpuKind: GpuKind = "none",
  exclude: ReadonlySet<string> = new Set(),
): LlamaAssetPlan | null {
  return planFromRules(planRules(platform, arch, gpuKind), assets, exclude);
}

/** CPU 兜底方案（GPU 变体验证失败时重装用）。 */
export function cpuLlamaPlan(
  assets: readonly string[],
  platform: string,
  arch: string,
): LlamaAssetPlan | null {
  return planFromRules(planRules(platform, arch, "none"), assets);
}

/** 官方发布的 tag 形如 `b10976`；`v0.4.1` 那种稳定标签里没有二进制，跳过。 */
export const LLAMA_RELEASE_REPO = "ggml-org/llama.cpp";
const LLAMA_TAG = /^b\d+$/;

export type LlamaRelease = { tag: string; assets: string[]; sizes: Record<string, number> };

/** 读最新几个发布（新到旧），挑第一个带二进制的 `b<构建号>`。 */
export async function fetchLatestLlamaRelease(fetchImpl: typeof fetch = fetch): Promise<LlamaRelease | null> {
  const res = await fetchImpl(`https://api.github.com/repos/${LLAMA_RELEASE_REPO}/releases?per_page=15`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "OmniStudio" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GitHub API 返回 ${res.status}`);
  const releases = (await res.json()) as { tag_name?: string; assets?: { name?: string; size?: number }[] }[];
  for (const release of releases) {
    const tag = release.tag_name ?? "";
    const assets = (release.assets ?? []).map((a) => a.name ?? "").filter(Boolean);
    if (!LLAMA_TAG.test(tag) || assets.length === 0) continue;
    const sizes: Record<string, number> = {};
    for (const asset of release.assets ?? []) {
      if (asset.name && typeof asset.size === "number") sizes[asset.name] = asset.size;
    }
    return { tag, assets, sizes };
  }
  return null;
}

// ---------------------------------------------------------------------------
// llama.cpp：下载 / 解包 / 验证 / 落位
// ---------------------------------------------------------------------------

function archiveArgs(archive: "tar.gz" | "zip", file: string, outDir: string): string[] {
  // Windows 的 tar.exe 是 bsdtar，能解 zip；GNU tar 不能 —— zip 只出现在 Windows 方案里。
  return archive === "zip" ? ["tar", "-xf", file, "-C", outDir] : ["tar", "-xzf", file, "-C", outDir];
}

/** 解包后找 llama-server 所在目录（发布包里是一层 `llama-b10976/`）。 */
export function findLlamaServerDir(root: string, depth = 3): string | null {
  const queue: { dir: string; level: number }[] = [{ dir: root, level: 0 }];
  while (queue.length > 0) {
    const { dir, level } = queue.shift()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    if (entries.some((name) => name === "llama-server" || name === "llama-server.exe")) return dir;
    if (level >= depth) continue;
    for (const name of entries) {
      const child = join(dir, name);
      try {
        if (statSync(child).isDirectory()) queue.push({ dir: child, level: level + 1 });
      } catch {
        // 读不动的条目跳过
      }
    }
  }
  return null;
}

/** Mach-O 魔数：macOS 上"跑不起来 → 自查签名"这一步用。 */
function isMachO(file: string): boolean {
  try {
    const head = readFileSync(file);
    const [a, b, c, d] = [head[0]!, head[1]!, head[2]!, head[3]!];
    return (
      (a === 0xcf && b === 0xfa && c === 0xed && d === 0xfe) || // 64 位小端
      (a === 0xfe && b === 0xed && c === 0xfa && d === 0xcf) || // 64 位大端
      (a === 0xca && b === 0xfe && c === 0xba && d === 0xbe) // fat
    );
  } catch {
    return false;
  }
}

/**
 * macOS 的 ad-hoc 重签名兜底：官方二进制本来就能直接跑，但签名一旦被破坏
 * （代理改写、解包丢元数据），内核会直接 SIGKILL —— 不重签就只剩"装好了却跑不了"。
 */
function adhocSign(dir: string, runner: CommandRunner): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const file = join(dir, name);
    try {
      if (!statSync(file).isFile() || !isMachO(file)) continue;
    } catch {
      continue;
    }
    runner.run(["codesign", "--force", "--sign", "-", file], 20_000);
  }
}

/** 跑一次二进制自证能执行：`--version`；GPU 变体再加 `--list-devices`（真正加载后端）。 */
export function verifyLlamaBinary(
  binary: string,
  options: { expectGpu?: boolean; runner: CommandRunner },
): { ok: boolean; output: string } {
  const version = options.runner.run([binary, "--version"], 60_000);
  const output = `${version.stdout}\n${version.stderr}`.trim();
  if (version.code !== 0) return { ok: false, output: output || `退出码 ${version.code}` };
  if (options.expectGpu) {
    const devices = options.runner.run([binary, "--list-devices"], 60_000);
    const deviceOutput = `${devices.stdout}\n${devices.stderr}`.trim();
    if (devices.code !== 0) {
      return { ok: false, output: deviceOutput || `--list-devices 退出码 ${devices.code}` };
    }
  }
  return { ok: true, output };
}

/** 下载期间按已落盘的字节数报进度（下载器写的是 `<dest>.partN`）。 */
function watchDownloadProgress(
  dir: string,
  expectedBytes: number | null,
  onPercent: (percent: number) => void,
): () => void {
  if (!expectedBytes || expectedBytes <= 0) return () => {};
  const timer = setInterval(() => {
    let received = 0;
    try {
      for (const name of readdirSync(dir)) {
        if (!name.includes(".part")) continue;
        try {
          received = Math.max(received, statSync(join(dir, name)).size);
        } catch {
          // 文件正在被替换，忽略
        }
      }
    } catch {
      return;
    }
    if (received > 0) onPercent(Math.min(99, Math.floor((received / expectedBytes) * 100)));
  }, 400);
  return () => clearInterval(timer);
}

export type AssetFetcher = (
  urls: string[],
  dest: string,
  what: string,
) => Promise<{ ok: boolean; error?: string }>;

/** 默认下载：多镜像链路 + 内容校验（挡住代理错误页与半截文件）。 */
const defaultAssetFetcher: AssetFetcher = async (urls, dest, what) => {
  const result = await fetchAssetFromSources({
    urls,
    dest,
    what,
    source: "server",
    accept: (_file, head, bytes) => {
      if (bytes < 1_000_000) return `文件过小（${bytes} 字节），不是 llama.cpp 构建包`;
      if (head[0] === 0x1f && head[1] === 0x8b) return null; // gzip（.tar.gz）
      if (head[0] === 0x50 && head[1] === 0x4b) return null; // zip（PK）
      return "不是有效的压缩包（可能下到了代理错误页）";
    },
  });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
};

export type LlamaInstallDeps = {
  reporter: InstallReporter;
  runner?: CommandRunner;
  platform?: string;
  arch?: string;
  gpuKind?: GpuKind;
  rootDir?: string;
  fetchRelease?: () => Promise<LlamaRelease | null>;
  fetchAsset?: AssetFetcher;
};

export async function installLlamaCpp(deps: LlamaInstallDeps): Promise<EngineInstallResult> {
  const reporter = deps.reporter;
  const runner = deps.runner ?? defaultCommandRunner;
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const gpuKind = deps.gpuKind ?? getHardwareInfo().gpu.kind;
  const rootDir = deps.rootDir ?? llamaCppRootDir();
  const fetchRelease = deps.fetchRelease ?? (() => fetchLatestLlamaRelease());
  const fetchAsset = deps.fetchAsset ?? defaultAssetFetcher;

  const finish = (result: EngineInstallResult, why?: string): EngineInstallResult => {
    reporter.log(
      result.ok ? `安装成功：llama-server ${result.version ?? ""}`.trimEnd() + "\n" : "llama.cpp 安装失败\n",
    );
    logEvent({
      level: result.ok ? "info" : "error",
      source: "server",
      event: result.ok ? "engine.install.ok" : "engine.install.failed",
      message: result.ok ? `llama.cpp 安装完成（${result.version}）` : "llama.cpp 安装失败",
      detail: { engine: "llama.cpp", platform, arch, gpuKind, version: result.version, why, error: result.error },
    });
    reporter.phase(result.ok ? "done" : "failed", result.ok ? "安装完成：llama.cpp" : (result.error ?? "安装失败"));
    return result;
  };

  reporter.phase("preparing", "查询 llama.cpp 官方构建");
  let release: LlamaRelease | null;
  try {
    release = await fetchRelease();
  } catch (err) {
    const error = `查询官方发布失败：${err instanceof Error ? err.message : err}。请检查网络或代理后重试`;
    reporter.log(`${error}\n`);
    return finish({ ok: false, error }, "release-query-failed");
  }
  if (!release) {
    const error = "没有找到带二进制的官方发布，请手动安装 llama.cpp";
    reporter.log(`${error}\n`);
    return finish({ ok: false, error }, "no-release");
  }

  // 变体阶梯：CUDA 最新 → CUDA 旧 → Vulkan → CPU（顺序见 planRules）。前一档装完
  // 验证不过（驱动太旧 / 这份构建不支持这张卡）就换下一档，而不是直接掉到 CPU ——
  // Windows 上 CUDA 12.4 的构建在 Blackwell（RTX 50 系）上就是这样一路退到 CPU 的
  // （issue #10：进程跑起来了，但显存占用 0%，模型全在内存里）。
  const firstPlan = planLlamaAsset(release.assets, platform, arch, gpuKind);
  if (!firstPlan) {
    const error = `官方构建里没有匹配当前平台（${platform}/${arch}）的二进制，请手动安装`;
    reporter.log(`${error}\n`);
    return finish({ ok: false, error }, "no-asset");
  }

  const staging = join(rootDir, `.staging-${process.pid}`);
  try {
    rmSync(staging, { recursive: true, force: true });
    // 已装过还来点一次 = 想升级（界面在已就绪的行上不给按钮，但 RPC 是通的）：说清楚
    // 这次是重新装，而不是让用户以为点了个没反应的按钮。
    const currentVersion = readInstalledEngineVersion("llama.cpp");
    if (currentVersion) {
      reporter.log(`检测到已安装的 llama.cpp ${currentVersion}，将重新安装最新构建（升级）\n`);
    }

    const tried = new Set<string>();
    let plan: LlamaAssetPlan | null = firstPlan;
    let lastError = "";
    while (plan) {
      reporter.log(`准备安装 llama.cpp ${release.tag} · ${plan.label}\n`);
      const attempt = await installLlamaPlan({
        release,
        plan,
        staging,
        rootDir,
        reporter,
        runner,
        platform,
        fetchAsset,
      });
      if (attempt.ok) {
        // 是靠回退才装上的，就在日志里（why）留个记号：用户看到"显存 0%"时有据可查。
        const fellBack = tried.size > 0;
        const isCpu = plan.label.includes("（CPU）");
        return finish({ ok: true, version: release.tag }, fellBack ? (isCpu ? "cpu-fallback" : "gpu-fallback") : undefined);
      }
      lastError = attempt.error ?? "安装失败";
      // 只有 GPU 变体值得往下换：CPU 构建都起不来就是真装不上（缺 dll / 权限 / 杀软拦截）。
      if (!plan.expectGpu) return finish({ ok: false, error: lastError }, "install-failed");
      tried.add(plan.asset);
      const next = planLlamaAsset(release.assets, platform, arch, gpuKind, tried);
      if (!next) return finish({ ok: false, error: lastError }, "install-failed");
      reporter.log(`${plan.label} 没通过验证（${lastError}），改用 ${next.label}…\n`);
      rmSync(staging, { recursive: true, force: true });
      plan = next;
    }
    return finish({ ok: false, error: lastError }, "install-failed");
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    reporter.log(`${error}\n`);
    return finish({ ok: false, error }, "exception");
  } finally {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      // 暂存目录删不掉不影响已装好的结果
    }
  }
}

/** 一个方案的完整流程：下载（含伴随包）→ 解包 → 补执行位 → 验证 → 原子落位。 */
async function installLlamaPlan(input: {
  release: LlamaRelease;
  plan: LlamaAssetPlan;
  staging: string;
  rootDir: string;
  reporter: InstallReporter;
  runner: CommandRunner;
  platform: string;
  fetchAsset: AssetFetcher;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { release, plan, staging, rootDir, reporter, runner, platform, fetchAsset } = input;
  const outDir = join(staging, "out");
  mkdirSync(outDir, { recursive: true });
  const assets = plan.companion ? [plan.asset, plan.companion] : [plan.asset];
  const totalBytes = assets.reduce((sum, name) => sum + (release.sizes[name] ?? 0), 0) || null;

  const label = `下载 llama.cpp（${plan.label}）`;
  reporter.phase("downloading", label, totalBytes ? 0 : null);
  const stopWatch = watchDownloadProgress(staging, totalBytes, (percent) =>
    reporter.phase("downloading", label, percent),
  );
  try {
    for (const asset of assets) {
      const archivePath = join(staging, asset);
      reporter.log(`下载 ${asset}\n`);
      const urls = await githubReleaseUrls(LLAMA_RELEASE_REPO, release.tag, asset);
      const fetched = await fetchAsset(urls, archivePath, asset);
      if (!fetched.ok) return { ok: false, error: fetched.error ?? `下载 ${asset} 失败` };

      reporter.phase("extracting", `解包 ${asset}`, null);
      const code = runner.run(archiveArgs(plan.archive, archivePath, outDir), 300_000);
      if (code.code !== 0) {
        return { ok: false, error: `解包失败：${code.stderr.trim() || `退出码 ${code.code}`}` };
      }
      rmSync(archivePath, { force: true });
    }
  } finally {
    stopWatch();
  }

  const serverDir = findLlamaServerDir(outDir);
  if (!serverDir) return { ok: false, error: "解包后没有找到 llama-server" };

  const binary = join(serverDir, platform === "win32" ? "llama-server.exe" : "llama-server");
  if (platform !== "win32") {
    // 解包出来的可执行位可能丢（zip / 某些代理链路），自己补上。
    for (const name of readdirSync(serverDir)) {
      try {
        chmodSync(join(serverDir, name), 0o755);
      } catch {
        // 不可改的条目跳过
      }
    }
  }

  reporter.phase("verifying", "验证 llama-server 可执行");
  let verified = verifyLlamaBinary(binary, { expectGpu: plan.expectGpu, runner });
  if (!verified.ok && platform === "darwin") {
    reporter.log("二进制无法执行，尝试重新签名（ad-hoc）…\n");
    adhocSign(serverDir, runner);
    verified = verifyLlamaBinary(binary, { expectGpu: plan.expectGpu, runner });
  }
  if (!verified.ok) return { ok: false, error: `验证失败：${verified.output.slice(-400)}` };
  reporter.log(`${(verified.output.split("\n")[0] ?? "").trim()}\n`);

  // 原子落位：current/ 整体替换，中途失败不会留下半个安装。
  const current = join(rootDir, "current");
  rmSync(current, { recursive: true, force: true });
  renameSync(serverDir, current);
  try {
    // 标记写在 current/ 里（跟着 rootDir 走，不读全局数据目录 —— 否则注入其它根目录时
    // 版本号会写到另一个地方，越界到真实数据目录上去）。
    writeFileSync(join(current, "VERSION"), `${release.tag}\n`, "utf8");
  } catch {
    // 标记写不进去不影响使用
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 统一入口
// ---------------------------------------------------------------------------

/** Python 引擎的 pip 包与探测模块（装完能不能用，以"模块导得进来"为准）。 */
const PYTHON_ENGINE_TARGETS: Record<Exclude<InferenceEngine, "llama.cpp">, {
  id: PythonEngineId;
  packages: string[];
  probeModule: string;
  distribution: string;
}> = {
  mlx: { id: "mlx-lm", packages: ["mlx-lm"], probeModule: "mlx_lm", distribution: "mlx-lm" },
  vllm: { id: "vllm", packages: ["vllm"], probeModule: "vllm", distribution: "vllm" },
  sglang: { id: "sglang", packages: ["sglang[all]"], probeModule: "sglang", distribution: "sglang" },
};

/** 同一时刻只允许一个安装：pip / 下载同时跑两份只会互相踩（同一个 venv / 同一个暂存目录）。 */
let installing: InferenceEngine | null = null;

/** 正在安装的引擎（`null` = 空闲）；界面重载后据此恢复「安装中」状态。 */
export function isEngineInstalling(): InferenceEngine | null {
  return installing;
}

export type EngineInstallOverrides = Partial<LlamaInstallDeps> & {
  /** Python 引擎：注入的系统 Python 查找（测试用）。 */
  findPython?: () => string | null;
};

export async function installInferenceEngine(
  engine: InferenceEngine,
  overrides: EngineInstallOverrides = {},
): Promise<EngineInstallResult> {
  if (installing) {
    return { ok: false, error: `正在安装 ${ENGINE_SHORT_NAMES[installing]}，请等它装完` };
  }
  const support = engineInstallSupport(engine);
  if (!support.supported) {
    return { ok: false, error: support.note ?? "当前平台不支持一键安装" };
  }

  installing = engine;
  const reporter: InstallReporter = {
    log: (text) => emitLog(text),
    phase: (phase, message, percent) => emitPhase({ engine, phase, message, percent: percent ?? null }),
  };
  try {
    if (engine === "llama.cpp") {
      return await installLlamaCpp({ reporter, ...overrides });
    }
    const target = PYTHON_ENGINE_TARGETS[engine];
    const result = await installPythonEngine({
      id: target.id,
      label: ENGINE_SHORT_NAMES[engine],
      packages: target.packages,
      probeModule: target.probeModule,
      distributionName: target.distribution,
      reporter,
      findPython: overrides.findPython,
    });
    return { ok: result.ok, error: result.error, version: result.version };
  } finally {
    installing = null;
  }
}

/**
 * 托管安装的版本号（界面显示「已安装 b10976」）。系统 PATH 上那个版本不在这里读 ——
 * 用户自己的安装我们不去猜它的版本，探测到能用就够了。
 */
export function readInstalledEngineVersion(engine: InferenceEngine): string | null {
  if (engine === "llama.cpp") {
    try {
      return readFileSync(engineVersionFilePath("llama.cpp"), "utf8").trim() || null;
    } catch {
      return null;
    }
  }
  return readPythonEngineVersion(PYTHON_ENGINE_TARGETS[engine].id);
}
