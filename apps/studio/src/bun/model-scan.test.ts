import { describe, expect, test } from "bun:test";
import { join } from "path";

/**
 * model-scan 的 mmproj 排除测试入口（真测试体见 model-scan.tests.ts）。
 *
 * 子进程隔离的理由与先例（model-store.embedding.test.ts:4-13）相同：bun 的 mock
 * 注册表在同一批次里跨文件共享，别的测试文件会桩掉 fs / db/settings
 * （download-manager.test.ts 把整个 fs 模块桩掉了），而扫描测试需要真实目录
 * 遍历；子进程里零 mock，结果确定。`.tests.ts` 文件名批次不会自动发现。
 */
const suite = join(import.meta.dir, "model-scan.tests.ts");

describe("model-scan: mmproj 不作为已安装模型列出", () => {
  test("平面目录里的 mmproj-*.gguf 不出现在扫描结果；仓库 files[] 不受损（子进程隔离跑）", () => {
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
