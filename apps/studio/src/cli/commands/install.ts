import { join } from "path";
import { resolveDataDir } from "../data-dir";
import { ENGINE_INSTALL_HINTS, availableEngines } from "../../shared/engines";

/** 检查各推理引擎的二进制 / 运行环境，缺失时打印安装命令。 */
export async function cmdInstall() {
  const dataDir = resolveDataDir();
  process.env.OMNI_DATA_DIR = dataDir;
  process.env.OMNI_DB_PATH = join(dataDir, "omni-studio.db");

  const { createRuntime } = await import("../../bun/runtimes");
  // 平台可用引擎来自注册表（mlx 仅 macOS）。
  const engines = availableEngines();

  let missing = false;
  for (const engine of engines) {
    try {
      const result = await createRuntime(engine).checkBinary();
      if (result.found) {
        console.log(`✓ ${engine.padEnd(10)} ${result.path}`);
      } else {
        missing = true;
        console.log(`✗ ${engine.padEnd(10)} 未找到。安装：${ENGINE_INSTALL_HINTS[engine]}`);
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
