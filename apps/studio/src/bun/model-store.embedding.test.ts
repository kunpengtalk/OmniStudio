import { describe, expect, test } from "bun:test";
import { join } from "path";

/**
 * model-store 类别守卫 / 启动自愈的测试入口（真测试体见 model-store.embedding.tests.ts）。
 *
 * 为什么套一层子进程：`bun test` 的 mock 注册表在同一批次里跨文件共享（见
 * chat-model.test.ts 顶部说明），而 model-store 恰好是被 chat-model / gateway /
 * download-manager 等测试桩掉的模块 —— 批次里直接 `await import("./model-store")`
 * 会拿到别的文件桩出来的假模块，结果取决于文件执行顺序（实测：单跑全绿、进批次必挂）。
 * 所以真测试体放进 `model-store.embedding.tests.ts`（文件名不带 `.test.`，批次不会
 * 自动发现它），这里用子进程单独跑它：与其他文件的 mock 完全隔离，结果确定。
 */
const suite = join(import.meta.dir, "model-store.embedding.tests.ts");

describe("setActiveModel 类别守卫 / healDriftedChatConfig 自愈", () => {
  test("嵌入 / 重排拒绝写聊天三把键；自愈清理漂移配置（子进程隔离跑）", () => {
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
