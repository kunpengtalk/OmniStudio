import { describe, expect, test } from "bun:test";
import { join } from "path";

/**
 * 知识库摄取管线多模态测试的**入口**（真测试体见 kb-ingest-multimodal.tests.ts）。
 *
 * 为什么套一层子进程：`bun test` 的 mock 注册表在同一批次里跨文件共享（先例
 * model-store.embedding.test.ts / knowledge-multimodal.test.ts），直接进批次会
 * 拿到别的文件桩出来的假模块。真测试体放进 `.tests.ts`（批次不会自动发现），
 * 这里用子进程单独跑；bunfig 的 test-preload（临时数据目录）在子进程同样生效。
 */
const suite = join(import.meta.dir, "kb-ingest-multimodal.tests.ts");

describe("知识库摄取管线多模态", () => {
  test("分流 / 落块 / doc skip / 混合批嵌入路由 / 媒体命中标记（子进程隔离跑）", () => {
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
    // 子进程要真启动一次应用（预加载 + 全量迁移），bun 默认 5s 在并行批次下会偶发踩线。
  }, 30_000);
});
