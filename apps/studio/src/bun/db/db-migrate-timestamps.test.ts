import { describe, expect, test } from "bun:test";
import { join } from "path";

/**
 * 迁移时间戳自愈测试的**入口**（真测试体见 db-migrate-timestamps.tests.ts）。
 *
 * 为什么套一层子进程：真测试体要用子进程反复「重启」同一个库文件（import ./db 即
 * 迁移），且不能被批次里其他文件的 mock.module（./db 桩，先例见
 * knowledge-multimodal.test.ts 头注释）污染。子进程里两者都干净。
 */
const suite = join(import.meta.dir, "db-migrate-timestamps.tests.ts");

describe("迁移时间戳自愈", () => {
  test("journal 单调性 + 中毒库重启补齐 0029（子进程隔离跑）", () => {
    const proc = Bun.spawnSync({
      cmd: [process.execPath, "test", suite],
      // apps/studio 根：让 bunfig.toml 的 test-preload（临时数据目录）生效
      cwd: join(import.meta.dir, "..", "..", ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${proc.stdout.toString()}${proc.stderr.toString()}`;
    if (proc.exitCode !== 0) console.error(output);
    expect(proc.exitCode).toBe(0);
    // 子进程要真启动一次应用（预加载 + 全量迁移），bun 默认 5s 在并行批次下会偶发踩线。
  }, 30_000);
});
