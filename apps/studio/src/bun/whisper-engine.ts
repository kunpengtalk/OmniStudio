import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "fs";
import path from "path";
import { WHISPER_CPP_RELEASE_TAG, WHISPER_CPP_REPO } from "../shared/whispercpp";
import { getDataDir } from "./paths";

/**
 * whisper.cpp 本地识别引擎（whisper-cli / whisper-server）的一键安装。
 *
 * 上游新版 Release 不再发布 macOS CLI 二进制（只有 Linux/Windows 资产），
 * macOS 因此走 conda-forge 官方预编译包（whisper.cpp + 依赖 llvm-openmp / libcxx，
 * 自带 @rpath 可迁移布局），其余平台走 GitHub Release 资产。统一解压到
 * userData/engines/whispercpp/current/，识别时优先于 PATH（brew 等）使用。
 */

export type WhisperEngineInfo = {
  installed: boolean;
  version: string | null;
  binaryPath: string | null;
  /** 当前平台是否支持一键安装。 */
  supported: boolean;
};

function getEnginesDir(): string {
  return getDataDir("engines", "whispercpp");
}

/** 引擎安装根目录：conda 布局为 bin/ + lib/；Linux/Windows 资产直接在根下。 */
function getEngineRoot(): string {
  return path.join(getEnginesDir(), "current");
}

function getSearchPath(): string {
  const home = process.env.HOME ?? "";
  const extra = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    home ? `${home}/.local/bin` : "",
    home ? `${home}/bin` : "",
  ];
  const current = process.env.PATH ?? "";
  return [...extra, current].join(":");
}

async function findOnPath(name: string): Promise<string | null> {
  const p = Bun.which(name, { PATH: getSearchPath() });
  return p ?? null;
}

/** 应用内置的 whisper 二进制（userData/engines/whispercpp/current/bin 或根目录）。 */
function bundledBinary(name: "whisper-cli" | "whisper-server"): string | null {
  for (const dir of [path.join(getEngineRoot(), "bin"), getEngineRoot()]) {
    const p = path.join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/** 找到 whisper 二进制：优先应用内置引擎，其次 PATH（brew 等）。 */
export async function resolveWhisperBinary(
  name: "whisper-cli" | "whisper-server",
): Promise<string | null> {
  try {
    const bundled = bundledBinary(name);
    if (bundled) return bundled;
  } catch {}
  return await findOnPath(name);
}

export async function getWhisperEngineInfo(): Promise<WhisperEngineInfo> {
  const [cli, server] = await Promise.all([
    resolveWhisperBinary("whisper-cli"),
    resolveWhisperBinary("whisper-server"),
  ]);
  let version: string | null = null;
  try {
    const marker = path.join(getEngineRoot(), "VERSION");
    if (existsSync(marker)) version = (await Bun.file(marker).text()).trim() || null;
  } catch {
    // ignore
  }
  return {
    installed: !!cli || !!server,
    version,
    binaryPath: cli ?? server ?? null,
    supported: process.platform === "darwin" || releaseAssetName() !== null,
  };
}

// ---------------------------------------------------------------------------
// 安装收尾
// ---------------------------------------------------------------------------

/** 保证二进制可执行并写入版本标记。 */
async function finalize(engineRoot: string, version: string): Promise<void> {
  for (const name of ["whisper-cli", "whisper-server"] as const) {
    const p = bundledBinary(name);
    if (p) {
      try {
        chmodSync(p, 0o755);
      } catch {
        // Windows 无 POSIX 权限
      }
    }
  }
  try {
    await Bun.write(path.join(engineRoot, "VERSION"), version);
  } catch {
    // ignore
  }
}

function cleanupStaging(staging: string): void {
  rmSync(staging, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// macOS：conda-forge 官方预编译包
// ---------------------------------------------------------------------------

type CondaFile = { pkg: string; version: string; basename: string } | null;

/** 锚定 conda-forge 的 whisper.cpp 及其依赖（llvm-openmp / libcxx），取当前平台最新。 */
async function fetchCondaFile(pkg: string): Promise<CondaFile> {
  try {
    const res = await fetch(`https://api.anaconda.org/package/conda-forge/${pkg}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      latest_version?: string;
      files?: { basename?: string; version?: string }[];
    };
    const version = json.latest_version;
    if (!version || !Array.isArray(json.files)) return null;
    const subdir = process.platform === "darwin"
      ? process.arch === "arm64" ? "osx-arm64" : "osx-64"
      : "";
    const file = json.files.find(
      (f) => f.version === version && f.basename?.startsWith(`${subdir}/`) && f.basename.endsWith(".conda"),
    );
    if (!file?.basename) return null;
    return { pkg, version, basename: file.basename };
  } catch {
    return null;
  }
}

/** conda 包下载地址（官方 + 国内镜像回退）。 */
function condaUrls(f: NonNullable<CondaFile>): string[] {
  const { pkg, version, basename } = f;
  const rel = `${pkg}/${version}/${basename}`;
  return [
    `https://api.anaconda.org/download/conda-forge/${rel}`,
    `https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge/${rel}`,
    `https://mirrors.sjtug.sjtu.edu.cn/anaconda/cloud/conda-forge/${rel}`,
  ];
}

/** 解压 .conda（zip 内含 pkg-*.tar.zst 数据包）到 staging。 */
async function extractCondaArchive(tmp: string, staging: string): Promise<void> {
  const unzip = Bun.spawnSync(["unzip", "-q", "-o", tmp, "-d", staging], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (unzip.exitCode !== 0) {
    throw new Error(`conda 解压失败：${unzip.stderr.toString().slice(-200)}`);
  }
  const data = readdirSync(staging).find((n) => n.startsWith("pkg-") && n.endsWith(".tar.zst"));
  if (!data) throw new Error("conda 包内缺少 pkg 数据");
  // bsdtar 可自动识别 zstd；个别系统不支持时再显式加 --zstd。
  let tar = Bun.spawnSync(["tar", "-xf", path.join(staging, data), "-C", staging], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (tar.exitCode !== 0) {
    tar = Bun.spawnSync(["tar", "--zstd", "-xf", path.join(staging, data), "-C", staging], {
      stdout: "pipe",
      stderr: "pipe",
    });
  }
  if (tar.exitCode !== 0) {
    throw new Error(`conda 数据解压失败：${tar.stderr.toString().slice(-200)}`);
  }
  for (const n of readdirSync(staging)) {
    if (n.endsWith(".tar.zst") || n === "metadata.json") {
      rmSync(path.join(staging, n), { force: true });
    }
  }
}

/**
 * 下载并合并 whisper.cpp + llvm-openmp + libcxx 三个 conda 包到引擎目录。
 * （libomp / libc++ 是 whisper.cpp 的运行依赖，合并后即可脱离 conda 使用。）
 */
async function downloadCondaEngine(): Promise<{ ok: boolean; error?: string; version?: string }> {
  const [whisper, omp, cxx] = await Promise.all([
    fetchCondaFile("whisper.cpp"),
    fetchCondaFile("llvm-openmp"),
    fetchCondaFile("libcxx"),
  ]);
  for (const f of [whisper, omp, cxx]) {
    if (!f) {
      return { ok: false, error: "无法获取 whisper.cpp 的 macOS 预编译包（conda-forge 不可达）" };
    }
  }
  const cfgs = [whisper!, omp!, cxx!];
  const version = whisper!.version;

  mkdirSync(getEnginesDir(), { recursive: true });
  const staging = path.join(getEnginesDir(), `.staging-${process.pid}`);
  cleanupStaging(staging);
  mkdirSync(staging, { recursive: true });

  for (const f of cfgs) {
    const basename = f.basename.split("/").pop()!;
    let lastError = "";
    let ok = false;
    for (const url of condaUrls(f)) {
      const tmp = path.join(getEnginesDir(), `.${basename}`);
      try {
        const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(600_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await Bun.write(tmp, res);
        await extractCondaArchive(tmp, staging);
        ok = true;
        break;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        rmSync(tmp, { force: true });
        rmSync(path.join(getEnginesDir(), `.staging-${process.pid}`), { recursive: true, force: true });
        // 重新铺白 staging，避免上一个失败包留下脏数据。
        mkdirSync(staging, { recursive: true });
      }
    }
    if (!ok) {
      cleanupStaging(staging);
      return { ok: false, error: `whisper.cpp 引擎安装失败（${f.pkg}）：${lastError}` };
    }
  }

  const engineRoot = getEngineRoot();
  rmSync(engineRoot, { recursive: true, force: true });
  try {
    renameSync(staging, engineRoot);
  } catch (e) {
    cleanupStaging(staging);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  await finalize(engineRoot, version);
  return bundledBinary("whisper-cli")
    ? { ok: true, version }
    : { ok: false, error: "安装后未找到 whisper-cli" };
}

// ---------------------------------------------------------------------------
// Linux / Windows：GitHub Release 资产
// ---------------------------------------------------------------------------

/** GitHub Release 资产文件名（Linux / Windows）。 */
function releaseAssetName(): string | null {
  if (process.platform === "linux" && process.arch === "x64") return "whisper-bin-ubuntu-x64.tar.gz";
  if (process.platform === "linux" && process.arch === "arm64") return "whisper-bin-ubuntu-arm64.tar.gz";
  if (process.platform === "win32" && process.arch === "x64") return "whisper-bin-x64.zip";
  return null;
}

function githubAssetUrls(asset: string): string[] {
  const gh = `https://github.com/${WHISPER_CPP_REPO}/releases/download/${WHISPER_CPP_RELEASE_TAG}/${asset}`;
  // 国内镜像（GitHub 加速），依次回退。
  return [gh, `https://gh-proxy.com/${gh}`, `https://ghfast.top/${gh}`];
}

/** 在解压目录里定位“内容根”（Linux 资产顶层即含 whisper-cli 的目录）。 */
function findContentRoot(root: string): string | null {
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      if (entries.some((e) => e.isFile() && e.name === "whisper-cli")) return dir;
      if (depth < 4) {
        for (const e of entries) {
          if (e.isDirectory()) stack.push({ dir: path.join(dir, e.name), depth: depth + 1 });
        }
      }
    } catch {
      // unreadable entry — skip
    }
  }
  return null;
}

async function installGitHubRelease(tmp: string, version: string): Promise<{ ok: boolean; error?: string }> {
  const engineRoot = getEngineRoot();
  rmSync(engineRoot, { recursive: true, force: true });
  mkdirSync(engineRoot, { recursive: true });

  const staging = path.join(getEnginesDir(), `.staging-${process.pid}`);
  cleanupStaging(staging);
  mkdirSync(staging, { recursive: true });
  try {
    // bsdtar 同时支持 gzip 与 zip；macOS / Windows 10+ 均自带。
    const tar = Bun.spawnSync(["tar", "-xf", tmp, "-C", staging], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (tar.exitCode !== 0) throw new Error(tar.stderr.toString().slice(-200));
  } catch (e) {
    cleanupStaging(staging);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const contentRoot = findContentRoot(staging);
  if (!contentRoot) {
    cleanupStaging(staging);
    return { ok: false, error: "解压后未找到 whisper-cli" };
  }

  try {
    renameSync(contentRoot, engineRoot);
  } catch (e) {
    cleanupStaging(staging);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  cleanupStaging(staging);
  await finalize(engineRoot, version);
  return bundledBinary("whisper-cli") ? { ok: true } : { ok: false, error: "安装后未找到 whisper-cli" };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 一键安装 whisper.cpp 引擎（whisper-cli / whisper-server 均含）：
 * - macOS：conda-forge 预编译包（whisper.cpp + llvm-openmp + libcxx，多镜像回退）
 * - Linux / Windows：GitHub Release 资产（多镜像回退）
 * 已安装（应用内置或 PATH 已有）时直接返回成功。
 */
export async function downloadWhisperEngine(): Promise<{ ok: boolean; error?: string; version?: string }> {
  const installed = await resolveWhisperBinary("whisper-cli");
  if (installed) {
    return { ok: true, version: (await getWhisperEngineInfo()).version ?? undefined };
  }

  if (process.platform === "darwin") {
    return await downloadCondaEngine();
  }

  const asset = releaseAssetName();
  if (!asset) {
    return {
      ok: false,
      error: `当前平台（${process.platform}/${process.arch}）暂不支持自动安装 whisper.cpp，请手动安装 whisper-cli / whisper-server 并加入 PATH`,
    };
  }

  mkdirSync(getEnginesDir(), { recursive: true });
  const tmpName = `.engine-${asset}`;
  let lastError = "";
  for (const url of githubAssetUrls(asset)) {
    const tmp = path.join(getEnginesDir(), tmpName);
    try {
      const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(600_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await Bun.write(tmp, res);
      const r = await installGitHubRelease(tmp, WHISPER_CPP_RELEASE_TAG);
      rmSync(tmp, { force: true });
      if (r.ok) return { ok: true, version: WHISPER_CPP_RELEASE_TAG };
      throw new Error(r.error ?? "安装失败");
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      rmSync(tmp, { force: true });
      cleanupStaging(path.join(getEnginesDir(), `.staging-${process.pid}`));
    }
  }
  return { ok: false, error: `whisper.cpp 引擎安装失败：${lastError}` };
}

/** 删除应用内置的引擎（PATH 上的不受影响）。 */
export function deleteWhisperEngine(): void {
  rmSync(getEngineRoot(), { recursive: true, force: true });
}
