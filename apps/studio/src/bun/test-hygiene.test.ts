import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

/**
 * 测试卫生的结构性检查：**任何测试文件都不许替换整个 `fs` 模块**。
 *
 * 为什么要有这条：`bun test --parallel` 的 mock 注册表在**同一批次里跨文件共享**
 * （仓库里多处以「单跑全绿、进批次必挂」的形式记着这件事）。`fs` 是唯一被几乎所有
 * 模块用到的内建模块，一旦某个测试把 `mock.module("fs", …)` 换成自己的桩，同批次里
 * 所有做真实 IO 的测试都会跟着看假数据 —— 实测代价是 `downloader.test.ts` 偶发失败
 * （「下载中断（2820/20971520 字节）」，6 次里 1 次）以及别的套件用例计数飘。
 *
 * 需要造「磁盘上已有数据」的场景时，用**真临时目录 + 真文件**（见
 * `download-manager.test.ts` 的 `reset()`：`mkdtempSync` + `writeFileSync`），
 * 别去桩内建模块。
 */
/**
 * 只认「行首的调用」，不认注释里的字样 —— 注释里正当地写着这条规则本身
 * （`// 别写 mock.module("fs", …)`），不能反过来把解释文字判成违规。
 */
const BANNED = [
  /^\s*mock\.module\(\s*["'](node:)?fs["']/m,
  /^\s*(?:await\s+)?mockModulePartial<\s*typeof\s+import\(\s*["'](node:)?fs["']\s*\)\s*>/m,
];

function testFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      testFiles(full, acc);
      continue;
    }
    if (/\.(test|tests)\.tsx?$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

describe("测试卫生：别把进程级全局换成自己的替身", () => {
  test("没有任何测试文件桩掉整个 fs 模块（会污染同批次的所有真实 IO）", () => {
    const src = join(import.meta.dir, "..");
    const offenders: string[] = [];
    for (const file of testFiles(src)) {
      if (!statSync(file).isFile()) continue;
      const text = readFileSync(file, "utf8");
      const hit = BANNED.find((pattern) => pattern.test(text));
      if (hit) offenders.push(`${file.slice(src.length + 1)} ← ${hit}`);
    }
    expect(offenders).toEqual([]);
  });

  // 注：`globalThis.fetch` 也是进程级全局，但它没法像 fs 那样用一条规则静态判死 ——
  // 全仓库有 11 个测试文件在换它，替换体各不相同（有的是「断言没发请求」、有的要拦云 API）。
  // 已确认会污染同批次的只有 cloud-providers / chat-model 两个（都改成走
  // `installFetchRouter()`，即只拦远端、放行回环）。其余 9 个的清单见
  // runs/2026-09-17T11-55-00-000Z-run.md，是否要一并迁移由维护者定。
});
