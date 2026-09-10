import { Utils } from "electrobun/bun";
import { join } from "path";

/**
 * 解析应用数据目录下的路径。
 *
 * 打包后的应用通过 electrobun 的 `Utils.paths.userData` 定位（读取 bundle 内
 * `Resources/version.json`），这在独立运行的进程（如 `omni` CLI）里会抛错。
 * `OMNI_DATA_DIR` 环境变量让它短路 —— `??` 只在左侧为 null 时才求值右侧，
 * 所以设置了环境变量时永远不会触碰 `Utils.paths`。
 */
export function getDataDir(...parts: string[]): string {
  const base = process.env.OMNI_DATA_DIR ?? Utils.paths.userData;
  return parts.length ? join(base, ...parts) : base;
}
