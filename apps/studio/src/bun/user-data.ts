import { Utils } from "electrobun/bun";

/**
 * 打包应用启动时先解析并把 userData 目录写进环境变量，
 * 这样 `paths.ts` 里的 `getDataDir()` 直接短路，不必再 `require("electrobun/bun")`。
 *
 * 为什么需要这一步：electrobun 的 `./bun` 出口指向 TypeScript 源码
 * （`dist/api/bun/index.ts`）且含顶层 await，Bun 不允许用 `require()` 加载异步模块
 * （`TypeError: require() async module ... is unsupported`），
 * 打包后的主进程会在 db 初始化阶段直接崩溃、连窗口都出不来。
 *
 * 这里用的是静态 ESM 导入 —— 主进程本来就会加载 electrobun（见 `index.ts`），
 * 因此没有额外副作用；而 `omni` CLI 不会引入本模块，仍保持惰性。
 *
 * 必须在任何引入 `./db`（进而引入 `paths.ts`）的模块之前被导入。
 */
try {
  const dir = Utils.paths.userData;
  if (dir) process.env.OMNI_DATA_DIR ??= dir;
} catch {
  // 拿不到时留给 paths.ts 的原有逻辑兜底。
}
