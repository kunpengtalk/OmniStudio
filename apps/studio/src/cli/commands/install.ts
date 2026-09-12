import { join } from "path";
import { resolveDataDir } from "../data-dir";

const ENGINE_HINTS: Record<string, string> = {
  "llama.cpp": "brew install llama.cpp",
  vllm: "pip install vllm  （或 uv pip install vllm）",
  sglang: "pip install 'sglang[all]'",
  mlx: "pip install -U mlx-lm  （Apple Silicon / macOS）",
};

/** 检查各推理引擎的二进制 / 运行环境，缺失时打印安装命令。 */
export async function cmdInstall() {
  const dataDir = resolveDataDir();
  process.env.OMNI_DATA_DIR = dataDir;
  process.env.OMNI_DB_PATH = join(dataDir, "omni-studio.db");

  const { createRuntime } = await import("../../bun/runtimes");
  // MLX 引擎只面向 macOS。
  const engines = [
    "llama.cpp",
    "vllm",
    "sglang",
    ...(process.platform === "darwin" ? (["mlx"] as const) : []),
  ] as const;

  let missing = false;
  for (const engine of engines) {
    try {
      const result = await createRuntime(engine).checkBinary();
      if (result.found) {
        console.log(`✓ ${engine.padEnd(10)} ${result.path}`);
      } else {
        missing = true;
        console.log(`✗ ${engine.padEnd(10)} 未找到。安装：${ENGINE_HINTS[engine]}`);
      }
    } catch (err) {
      missing = true;
      console.log(`✗ ${engine.padEnd(10)} 检查失败：${String(err)}`);
    }
  }
  if (missing) {
    console.log("\n安装完成后重新运行 `omi install` 确认。");
  } else {
    console.log("\n推理引擎依赖齐全。");
  }
}
