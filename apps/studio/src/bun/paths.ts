import { homedir } from "os";
import { basename, dirname, join, resolve, sep } from "path";
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

/**
 * 这个路径是不是本应用的数据目录（或其标识目录）里的东西？
 *
 * 两处要用它做拦截：Agent 的凭据路径黑名单（设置表里存着全部云端 API Key）
 * 与沙箱的凭据清单。判断规则收在这里一处 —— 两个调用方各写一遍迟早会走偏，
 * 而"看起来拦住了其实没拦住"是这类检查最坏的失败方式。
 *
 * "像我们自己的目录"这层条件是必须的：`OMNI_DATA_DIR` 可以被指向任意目录
 * （测试隔离、`omi` CLI 都会这么干），不看标识就把它的父目录也算成凭据目录，
 * 会把整片临时目录变成禁区 —— 工作区里正常的文件读写会被误报成"访问凭据路径"。
 */
export function isOmniDataPath(target: string): boolean {
  try {
    const resolved = resolve(target);
    const dataDir = resolve(getDataDir());
    const identifier = basename(dirname(dataDir));
    const ours = identifier === APP_IDENTIFIER || identifier.startsWith("omni-studio");
    const hits = (root: string) => resolved === root || resolved.startsWith(root + sep);
    // 数据目录本身无条件算（即使它是被 OMNI_DATA_DIR 指过去的临时目录 ——
    // 那里的设置表确实有密钥）；标识目录只在它确实像我们的标识时才一起算。
    return hits(dataDir) || (ours && hits(dirname(dataDir)));
  } catch {
    return false;
  }
}
