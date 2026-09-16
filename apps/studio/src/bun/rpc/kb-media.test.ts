import { describe, expect, test } from "bun:test";
import { join } from "path";

/**
 * RPC 层 kbChunkMedia 测试的**入口**（真测试体见 kb-media.tests.ts）。
 *
 * 为什么套一层子进程：与 knowledge-multimodal.test.ts 同款 —— 真测试体直接用
 * 真实 ./db，而同批次里其他测试文件会对 ./db / ./db/settings 注册 mock.module
 * （mock 注册表跨文件共享），直接进批次结果取决于文件执行顺序。子进程里
 * mock 泄漏不存在，bunfig 的 test-preload（临时数据目录）在子进程同样生效。
 */
const suite = join(import.meta.dir, "kb-media.tests.ts");

describe("RPC kbChunkMedia", () => {
  test("图片缩略/音视频/文本块/文件缺失/行不存在（子进程隔离跑）", () => {
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
