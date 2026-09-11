import { homedir } from "os";
import { join } from "path";
import { readFileSync } from "fs";

const APP_IDENTIFIER = "omni-studio.kunpengtalk.com";
const FALLBACK_CHANNEL = "dev";

function getAppDataDir(): string {
  const home = homedir();
  switch (process.platform) {
    case "win32":
      return process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    case "linux":
      return process.env.XDG_DATA_HOME || join(home, ".local", "share");
    default:
      return join(home, "Library", "Application Support");
  }
}

/**
 * 打包应用的 userData 目录 = `<appData>/<identifier>/<channel>`，与 electrobun
 * `Utils.paths.userData` 同一规则（读 bundle 内的 `../Resources/version.json`）。
 *
 * 这里不 import electrobun，而是自己按同规则解析 —— `electrobun/bun` 模块
 * 求值会产生副作用（拉起 dev server / 读 version.json），会让独立进程
 * （`omi` CLI）在只打算复用数据层时被污染。
 */
export function getUserDataDir(): string {
  let identifier = APP_IDENTIFIER;
  let channel = FALLBACK_CHANNEL;
  try {
    const raw = readFileSync(join("..", "Resources", "version.json"), "utf8");
    const parsed = JSON.parse(raw) as { identifier?: unknown; channel?: unknown };
    if (typeof parsed.identifier === "string" && parsed.identifier) identifier = parsed.identifier;
    if (typeof parsed.channel === "string" && parsed.channel) channel = parsed.channel;
  } catch {
    // 源码 / 未打包环境：无 version.json，用默认值（打包应用固定存在该文件）
  }
  return join(getAppDataDir(), identifier, channel);
}

/**
 * 解析应用数据目录下的路径。
 *
 * `OMNI_DATA_DIR` 直接短路 —— 独立进程（`omi` CLI）靠它把数据层指向
 * 打包应用的 userData，避免触碰 electrobun。
 */
export function getDataDir(...parts: string[]): string {
  const base = process.env.OMNI_DATA_DIR ?? getUserDataDir();
  return parts.length ? join(base, ...parts) : base;
}

/**
 * CLI ↔ 应用的控制 socket 路径。`omi` CLI 复用同一条规则定位（见
 * `src/cli/data-dir.ts`），`OMNI_CONTROL_SOCKET` 用于开发环境覆盖。
 */
export function controlSocketPath(): string {
  return process.env.OMNI_CONTROL_SOCKET ?? join(getDataDir(), "omni-control.sock");
}
