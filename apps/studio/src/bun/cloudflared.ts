/**
 * cloudflared（Cloudflare Tunnel 客户端）的获取与安装。
 *
 * 「一键内网穿透」不能要求用户自己去 brew install / 下 zip：所有平台都由应用
 * 把官方二进制装进数据目录（`<dataDir>/engines/cloudflared/current`），用户在
 * 设置页点一次「下载」即可。用户自己装过（PATH 上找得到）时优先用他的版本，
 * 不重复下载 —— 与语音 / 图像引擎「先托管目录、再 PATH」的解析顺序一致。
 *
 * 安装流程沿用其它引擎的既有做法：多镜像下载（mirror-download.ts）→ 暂存目录
 * 解包 → 跑一次 `--version` 验证真的能执行 → 原子 rename 到 `current/` →
 * 写 VERSION 标记。暂存目录是关键：解包到一半被杀不会留下半个可执行文件。
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

import { logEvent } from "./app-log";
import { fetchAssetFromSources, githubReleaseUrls } from "./mirror-download";
import { getDataDir } from "./paths";

/**
 * 安装的 cloudflared 版本。**升级时刻意改动这里**：cloudflared 是安全敏感组件，
 * 但也不能用 `/releases/latest/` —— 那会让同一份代码在不同时间装上不同版本，
 * 出了问题没法复现。发布新版本时改这一行即可。
 */
export const CLOUDFLARED_VERSION = "2026.9.1";

/** 官方发布资产：macOS 是 .tgz，Linux / Windows 是裸二进制。 */
export type CloudflaredAsset = { asset: string; archive: "tgz" | "raw" };

/**
 * 平台 → 官方发布资产名。
 *
 * 注意 Windows **没有** arm64 产物，arm64 机器走 amd64（Windows 自带 x64 仿真）；
 * macOS 没有 32 位产物，直接判定为不支持。返回 null 时界面提示手动安装。
 */
export function cloudflaredAssetFor(platform: string, arch: string): CloudflaredAsset | null {
  if (platform === "darwin") {
    if (arch === "arm64") return { asset: "cloudflared-darwin-arm64.tgz", archive: "tgz" };
    if (arch === "x64") return { asset: "cloudflared-darwin-amd64.tgz", archive: "tgz" };
    return null;
  }
  if (platform === "win32") {
    if (arch === "ia32") return { asset: "cloudflared-windows-386.exe", archive: "raw" };
    return { asset: "cloudflared-windows-amd64.exe", archive: "raw" };
  }
  if (platform === "linux") {
    const name = arch === "arm64" ? "arm64" : arch === "arm" ? "arm" : arch === "ia32" ? "386" : "amd64";
    return { asset: `cloudflared-linux-${name}`, archive: "raw" };
  }
  return null;
}

function binaryName(): string {
  return process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
}

function cloudflaredRootDir(): string {
  return getDataDir("engines", "cloudflared");
}

/** 托管安装的目标路径（下载安装后由应用自己调用它）。 */
export function cloudflaredBinaryPath(): string {
  return join(cloudflaredRootDir(), "current", binaryName());
}

export type CloudflaredBinary = {
  path: string;
  /** managed = 应用自己装的；path = 用户系统里已有的（不接管、不删除）。 */
  source: "managed" | "path";
  version?: string;
};

let cached: CloudflaredBinary | null | undefined;

/** 清掉解析缓存：安装 / 删除之后必须调，否则一直用旧的判定结果。 */
export function invalidateCloudflaredCache(): void {
  cached = undefined;
}

/** 托管目录 → PATH 依次查找，都找不到返回 null。 */
export function resolveCloudflared(): CloudflaredBinary | null {
  if (cached !== undefined) return cached;
  const managed = cloudflaredBinaryPath();
  if (existsSync(managed)) {
    let version: string | undefined;
    try {
      version = readFileSync(join(cloudflaredRootDir(), "current", "VERSION"), "utf8").trim() || undefined;
    } catch {
      // 没有 VERSION 标记不影响使用
    }
    cached = { path: managed, source: "managed", version };
    return cached;
  }
  try {
    const found = Bun.which("cloudflared");
    if (found) {
      cached = { path: found, source: "path" };
      return cached;
    }
  } catch {
    // 查 PATH 失败按"没装"处理
  }
  cached = null;
  return cached;
}

/** 跑一次 `--version`，用于安装后验证和界面展示；失败返回 null。 */
export async function probeCloudflaredVersion(binPath: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([binPath, "--version"], { stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([
      Bun.readableStreamToText(proc.stdout as ReadableStream<Uint8Array>),
      Bun.readableStreamToText(proc.stderr as ReadableStream<Uint8Array>),
      proc.exited,
    ]);
    const text = `${out} ${err}`.trim();
    const match = text.match(/cloudflared version (\S+)/i) ?? text.match(/(\d{4}\.\d+\.\d+)/);
    return match?.[1] ?? (text.split("\n")[0] || null);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 安装
// ---------------------------------------------------------------------------

const installLogListeners = new Set<(text: string) => void>();

export function onCloudflaredInstallLog(cb: (text: string) => void): () => void {
  installLogListeners.add(cb);
  return () => installLogListeners.delete(cb);
}

function emitInstallLog(text: string): void {
  for (const cb of installLogListeners) {
    try {
      cb(text);
    } catch {
      // 忽略：日志订阅方出错不影响安装
    }
  }
}

/** 可执行文件魔数：Mach-O（含 fat）/ ELF / PE。挡住代理错误页与半截文件。 */
export function looksLikeExecutable(head: Uint8Array): boolean {
  if (head.length < 4) return false;
  const [a, b, c, d] = head;
  // Mach-O 64 / 32、fat binary（大端小端都认）
  const machO =
    (a === 0xcf && b === 0xfa && c === 0xed && d === 0xfe) ||
    (a === 0xfe && b === 0xed && c === 0xfa && d === 0xcf) ||
    (a === 0xce && b === 0xfa && c === 0xed && d === 0xfe) ||
    (a === 0xca && b === 0xfe && c === 0xba && d === 0xbe);
  const elf = a === 0x7f && b === 0x45 && c === 0x4c && d === 0x46; // \x7fELF
  const pe = a === 0x4d && b === 0x5a; // MZ
  return machO || elf || pe;
}

async function runTar(args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(["tar", ...args], { stdout: "pipe", stderr: "pipe" });
    const err = await Bun.readableStreamToText(proc.stderr as ReadableStream<Uint8Array>);
    const code = await proc.exited;
    if (code !== 0) return err.trim() || `tar 退出码 ${code}`;
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

let installing = false;

/**
 * 下载并安装 cloudflared 到托管目录。
 *
 * 任何一步失败都保持"未安装"的干净状态（暂存目录整体删掉），不会留下半个
 * 可执行文件 —— 否则下次启动会拿一个残缺二进制去跑隧道，报错还看不出原因。
 */
export async function installCloudflared(): Promise<{ ok: boolean; error?: string; version?: string }> {
  if (installing) return { ok: false, error: "cloudflared 正在安装中" };
  installing = true;
  const staging = join(cloudflaredRootDir(), `.staging-${process.pid}`);
  try {
    const result = await runCloudflaredInstall(staging);
    // 收尾行沿用引擎安装的既有约定（`安装成功：…` / `… 安装失败`）：前端
    // install-log.ts 靠它判断"这批日志里有没有终态"，决定要不要刷新二进制状态。
    emitInstallLog(
      result.ok ? `安装成功：cloudflared ${result.version ?? CLOUDFLARED_VERSION}\n` : "cloudflared 安装失败\n",
    );
    return result;
  } finally {
    installing = false;
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      // 暂存目录删不掉不影响已装好的结果
    }
  }
}

async function runCloudflaredInstall(
  staging: string,
): Promise<{ ok: boolean; error?: string; version?: string }> {
  const target = cloudflaredAssetFor(process.platform, process.arch);
  if (!target) {
    return {
      ok: false,
      error: `当前平台（${process.platform}/${process.arch}）没有官方构建，请自行安装 cloudflared 后重试`,
    };
  }
  const outDir = join(staging, "out");

  try {
    emitInstallLog(`准备安装 cloudflared ${CLOUDFLARED_VERSION}（${target.asset}）\n`);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });

    const archivePath = join(staging, target.asset);
    const urls = await githubReleaseUrls("cloudflare/cloudflared", CLOUDFLARED_VERSION, target.asset);
    const result = await fetchAssetFromSources({
      urls,
      dest: archivePath,
      what: "cloudflared（Cloudflare 隧道客户端）",
      source: "tunnel",
      accept: (_file, head, bytes) => {
        if (bytes < 1_000_000) return `文件过小（${bytes} 字节），不是 cloudflared 二进制`;
        // .tgz 是压缩流（gzip 魔数 1f 8b），裸二进制必须是可执行文件头
        if (target.archive === "tgz") {
          return head[0] === 0x1f && head[1] === 0x8b ? null : "不是有效的 gzip 包";
        }
        return looksLikeExecutable(head) ? null : "不是有效的可执行文件";
      },
    });

    if (!result.ok) {
      emitInstallLog(`下载失败：${result.error}\n`);
      logEvent({
        level: "error",
        source: "tunnel",
        event: "tunnel.install.download_failed",
        message: result.error,
        detail: { version: CLOUDFLARED_VERSION, asset: target.asset, attempts: result.attempts },
      });
      return { ok: false, error: `下载失败：${result.error}` };
    }
    emitInstallLog(`下载完成（${Math.round(result.bytes / 1048576)} MB，来源 ${result.source}）\n`);

    const finalBin = join(outDir, binaryName());
    if (target.archive === "tgz") {
      emitInstallLog("解压中…\n");
      const tarError = await runTar(["-xzf", archivePath, "-C", outDir]);
      if (tarError) {
        emitInstallLog(`解压失败：${tarError}\n`);
        return { ok: false, error: `解压失败：${tarError}` };
      }
      if (!existsSync(finalBin)) {
        return { ok: false, error: "压缩包里没有 cloudflared 可执行文件" };
      }
    } else {
      copyFileSync(archivePath, finalBin);
    }
    chmodSync(finalBin, 0o755);

    // 装完立刻跑一次：能执行才算装好（架构不匹配 / 下载被截断都在这里暴露）。
    const version = await probeCloudflaredVersion(finalBin);
    if (!version) {
      emitInstallLog("校验失败：下载的二进制无法执行\n");
      logEvent({
        level: "error",
        source: "tunnel",
        event: "tunnel.install.probe_failed",
        message: "cloudflared 安装后无法执行",
        detail: { platform: process.platform, arch: process.arch, asset: target.asset },
      });
      return { ok: false, error: "下载的 cloudflared 无法执行（平台/架构不匹配？）" };
    }
    emitInstallLog(`校验通过：cloudflared version ${version}\n`);

    const current = join(cloudflaredRootDir(), "current");
    rmSync(current, { recursive: true, force: true });
    mkdirSync(cloudflaredRootDir(), { recursive: true });
    renameSync(outDir, current);
    writeFileSync(join(current, "VERSION"), `${version}\n`);

    invalidateCloudflaredCache();
    emitInstallLog(`已安装到：${join(current, binaryName())}\n`);
    logEvent({
      level: "info",
      source: "tunnel",
      event: "tunnel.install.ok",
      message: `cloudflared ${version} 安装完成`,
      detail: { version, asset: target.asset, path: join(current, binaryName()) },
    });
    return { ok: true, version };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    emitInstallLog(`安装失败：${message}\n`);
    logEvent({
      level: "error",
      source: "tunnel",
      event: "tunnel.install.failed",
      message,
      detail: { error: e, version: CLOUDFLARED_VERSION },
    });
    return { ok: false, error: message };
  }
}

/** 删除托管安装（用户系统里那份不动）。 */
export function removeCloudflared(): { ok: boolean; error?: string; notice?: string } {
  if (!existsSync(cloudflaredBinaryPath())) {
    const system = resolveCloudflared();
    if (system?.source === "path") {
      return { ok: false, error: "当前用的是系统已安装的 cloudflared，应用不负责卸载它" };
    }
    return { ok: false, error: "cloudflared 尚未安装" };
  }
  try {
    rmSync(join(cloudflaredRootDir(), "current"), { recursive: true, force: true });
    invalidateCloudflaredCache();
    logEvent({
      level: "info",
      source: "tunnel",
      event: "tunnel.uninstall.ok",
      message: "cloudflared 已从应用数据目录移除",
    });
    return { ok: true, notice: "已移除应用下载的 cloudflared" };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logEvent({
      level: "error",
      source: "tunnel",
      event: "tunnel.uninstall.failed",
      message,
      detail: { error: e },
    });
    return { ok: false, error: message };
  }
}
