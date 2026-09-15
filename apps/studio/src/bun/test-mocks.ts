import { mock } from "bun:test";

/**
 * `mock.module` 的「真实导出 + 局部覆盖」写法。
 *
 * bun 的 `mock.module` 是**整体替换**：工厂函数返回什么，之后 import 这个模块的文件
 * 就只能拿到什么。而它又是**进程级生效且撤不掉**的（`mock.restore()` 不管模块 mock），
 * 所以一个测试文件写下的替身会一直留到本次运行结束。两处必然踩到的坑都源于此：
 *
 * 1. **新增导出即炸**：`db/settings` 后来加了 `ensureSettingsEncrypted`、
 *    `shared/server-info` 加了 `chatImageUrl`，所有只列了自己用到的那几个导出的
 *    替身立刻在 import 阶段报 `Export named "x" not found` —— 炸的还是那些本身
 *    没问题的文件（chat.test.ts 就是这么被云端加密那次改动打红的）。
 * 2. **顺序决定结果**：后跑到的文件拿到上一个文件留下的替身，同一批用例单跑绿、
 *    全量跑红，或反过来。
 *
 * 这个 helper 统一先取真实模块、把它的导出铺开，再叠上调用方要改的那几个函数。
 * 「模块表面」这件事交还给真实模块：以后 `db/settings` 再新增导出，各处替身自动
 * 跟上，不用去改一圈测试。泄漏本身还在（要彻底隔离得靠 `bun test --parallel`，
 * 每个文件一个进程），但泄漏出去的是真实实现，而不是残缺的替身。
 *
 * 本文件放在 `src/bun/` 下是**故意的**：`mock.module` 的 specifier 相对「调用方文件」
 * 解析，而这里同样按本文件的目录解析 —— 与 `src/bun/*.test.ts` 里的相对路径落到
 * 同一个模块。放到别处（如 src/）会让 `"./db/settings"` 解析到不存在的路径。
 *
 * @param specifier 相对 `src/bun/` 的模块路径（如 `"./db/settings"`）
 * @param overrides 需要替换掉的导出；其余导出保持真实实现
 * @returns 真实模块，方便调用方在覆盖里转调原实现
 */
export async function mockModulePartial<T extends object>(
  specifier: string,
  overrides: Partial<T>,
): Promise<T> {
  const real = (await import(specifier)) as T;
  mock.module(specifier, () => ({ ...real, ...overrides }));
  return real;
}
