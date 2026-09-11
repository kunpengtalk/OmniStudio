import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync } from "fs";

export const APP_NAME = "OmniStudio";
export const APP_IDENTIFIER = "omni-studio.kunpengtalk.com";

type VersionInfo = { identifier: string; channel: string };

const BUNDLE_CANDIDATES = [
  "/Applications/OmniStudio.app",
  join(homedir(), "Applications", "OmniStudio.app"),
];

/** 打包应用会写 `<bundle>/Contents/Resources/version.json`（含 identifier/channel）。 */
function findAppVersionInfo(): VersionInfo | null {
  for (const bundle of BUNDLE_CANDIDATES) {
    try {
      const p = join(bundle, "Contents", "Resources", "version.json");
      if (!existsSync(p)) continue;
      const v = JSON.parse(readFileSync(p, "utf8")) as Partial<VersionInfo>;
      if (typeof v.identifier === "string" && typeof v.channel === "string") {
        return { identifier: v.identifier, channel: v.channel };
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

export function appBundlePath(): string | null {
  for (const bundle of BUNDLE_CANDIDATES) {
    if (existsSync(bundle)) return bundle;
  }
  return null;
}

/**
 * 与主进程 `paths.getDataDir` 一致的数据目录（CLI 独立进程版）。
 * 主进程读 electrobun 的 `Utils.paths.userData`（bundle 内 version.json），
 * CLI 在这里做同样的解析；两者都优先尊重 `OMNI_DATA_DIR`。
 */
export function resolveDataDir(): string {
  if (process.env.OMNI_DATA_DIR) return process.env.OMNI_DATA_DIR;
  if (process.platform === "darwin") {
    const info = findAppVersionInfo();
    if (info) return join(homedir(), "Library", "Application Support", info.identifier, info.channel);
  }
  // 源码/开发环境下的稳定回退 —— 与主进程 paths.getUserDataDir 的默认一致。
  return join(homedir(), "Library", "Application Support", APP_IDENTIFIER, "dev");
}

/** 与主进程 `paths.controlSocketPath` 相同的 socket 路径。 */
export function controlSocketPath(): string {
  return process.env.OMNI_CONTROL_SOCKET ?? join(resolveDataDir(), "omni-control.sock");
}

/** 仓库根 package.json 的版本（CLI 以源码方式运行时读取）。 */
export function rootVersion(): string | null {
  const candidates = [
    join(import.meta.dir, "..", "..", "..", "..", "package.json"),
    join(import.meta.dir, "..", "..", "package.json"),
  ];
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const pkg = JSON.parse(readFileSync(p, "utf8")) as { version?: unknown };
      if (typeof pkg.version === "string" && pkg.version) return pkg.version;
    } catch {
      // try next
    }
  }
  return null;
}
