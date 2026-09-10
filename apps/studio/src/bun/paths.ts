import { createRequire } from "node:module";
import { join } from "path";

// 惰性加载注意：一旦加载 `electrobun/bun`，它就会启动本机更新服务并异步读取
// 打包应用内的 `Resources/version.json` —— 独立进程（如 `omni` CLI）里必然抛错。
// 所以只有真正需要 userData（未设置 OMNI_DATA_DIR，即打包应用运行时）才 require；
// 打包应用里 electrobun 已被其它静态导入加载，这里的 require 直接命中缓存，无副作用。
const require = createRequire(import.meta.url);

function packagedUserDataDir(): string {
  const { Utils } = require("electrobun/bun") as typeof import("electrobun/bun");
  return Utils.paths.userData;
}

/**
 * 解析应用数据目录下的路径。
 *
 * 打包后的应用通过 electrobun 的 `Utils.paths.userData` 定位（读取 bundle 内
 * `Resources/version.json`），这在独立运行的进程（`omni` CLI）里会抛错。
 * `OMNI_DATA_DIR` 环境变量让它短路 —— `??` 只在左侧为 null 时才求值右侧，
 * 所以设置了环境变量时永远不会触碰 `electrobun/bun`。
 */
export function getDataDir(...parts: string[]): string {
  const base = process.env.OMNI_DATA_DIR ?? packagedUserDataDir();
  return parts.length ? join(base, ...parts) : base;
}
