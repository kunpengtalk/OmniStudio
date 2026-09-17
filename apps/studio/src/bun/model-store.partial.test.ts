import { describe, expect, test } from "bun:test";
import { join } from "path";

/**
 * 半成品过滤的测试入口（真测试体见 model-store.partial.tests.ts，子进程隔离跑）：
 * model-store 会被别的测试文件桩掉，批次里直接 import 会拿到假模块。
 */
const suite = join(import.meta.dir, "model-store.partial.tests.ts");

describe("listInstalledModels 不把没下完的文件当已安装模型（issue #16）", () => {
  test("半成品被过滤、完整文件保留（子进程隔离跑）", () => {
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
