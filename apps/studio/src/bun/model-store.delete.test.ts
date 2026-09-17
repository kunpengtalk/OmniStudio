import { describe, expect, test } from "bun:test";
import { join } from "path";

/**
 * 删除留痕测试的入口（真测试体见 model-store.delete.tests.ts）。
 *
 * 同 model-store.embedding.test.ts：`bun test` 的 mock 注册表在同一批次里跨文件共享，
 * 而 model-store 会被 chat-model / gateway / download-manager 等测试桩掉 —— 直接 import
 * 会拿到别人的假模块（结果取决于执行顺序）。所以真测试体放不带 `.test.` 的文件里，
 * 用子进程单独跑，与批次完全隔离。
 */
const suite = join(import.meta.dir, "model-store.delete.tests.ts");

describe("deleteLocalModel 留痕（子进程隔离跑）", () => {
  test("删除写日志 / 越界拒绝写日志", () => {
    const proc = Bun.spawnSync({
      cmd: [process.execPath, "test", suite],
      // apps/studio 根：让 bunfig.toml 的 test-preload（临时数据目录）生效
      cwd: join(import.meta.dir, "..", ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${proc.stdout.toString()}${proc.stderr.toString()}`;
    if (proc.exitCode !== 0) console.error(output);
    expect(proc.exitCode).toBe(0);
  });
});
