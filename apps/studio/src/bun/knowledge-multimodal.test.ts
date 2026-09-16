import { describe, expect, test } from "bun:test";
import { join } from "path";

/**
 * 知识库多模态数据层测试的**入口**（真测试体见 knowledge-multimodal.tests.ts）。
 *
 * 为什么套一层子进程：`bun test` 的 mock 注册表在同一批次里跨文件共享（先例
 * model-store.embedding.test.ts），而本仓的 embedding-defaults.test.ts 等会对 ./db /
 * ./db/settings 注册 mock.module —— 直接进批次会把真实 ./db 换成假模块，结果取决于
 * 文件执行顺序。所以真测试体放进 `.tests.ts`（批次不会自动发现），这里用子进程单独跑：
 * 子进程里 mock 泄漏不存在，bunfig 的 test-preload（临时数据目录）在子进程同样生效。
 */
const suite = join(import.meta.dir, "knowledge-multimodal.tests.ts");

describe("知识库多模态数据层", () => {
  test("三布尔/视图/合并/注入/导出导入/迁移默认值（子进程隔离跑）", () => {
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
