import { existsSync } from "fs";
import { join } from "path";
import type { ParsedArgs } from "../args";
import { optString } from "../args";
import { resolveDataDir } from "../data-dir";

const ENGINES = ["llama.cpp", "vllm", "sglang"] as const;
type Engine = (typeof ENGINES)[number];

/**
 * 前台独立运行推理服务器（不依赖 GUI）。复用主进程的 runtimes /
 * server-manager：导入前先设好 OMNI_DATA_DIR / OMNI_DB_PATH，
 * 使 db 层短路到同一份 SQLite（这就是路径抽象留给独立进程的用法）。
 */
export async function cmdServe(parsed: ParsedArgs) {
  const dataDir = resolveDataDir();
  process.env.OMNI_DATA_DIR = dataDir;
  process.env.OMNI_DB_PATH = join(dataDir, "omni-studio.db");

  const settingsMod = await import("../../bun/db/settings");
  const modelStore = await import("../../bun/model-store");
  const ServerManager = await import("../../bun/server-manager");

  const engine = optString(parsed.options, "engine");
  const port = optString(parsed.options, "port");
  const host = optString(parsed.options, "host");
  const model = optString(parsed.options, "model");
  const apiKey = optString(parsed.options, "api-key");

  const updates: Record<string, string> = {};
  if (engine) {
    if (!(ENGINES as readonly string[]).includes(engine)) {
      console.error(`未知引擎「${engine}」。可用：${ENGINES.join(" / ")}`);
      process.exit(1);
    }
    updates.INFERENCE_ENGINE = engine;
  }
  if (port) updates.SERVER_PORT = port;
  if (host) updates.SERVER_HOST = host;
  if (apiKey) updates.GATEWAY_API_KEY = apiKey;
  if (model) {
    if (!existsSync(model)) {
      console.error(`模型文件不存在：${model}`);
      process.exit(1);
    }
    const r = modelStore.setActiveModel(model);
    if (!r.ok) {
      console.error(r.error ?? "设置活动模型失败");
      process.exit(1);
    }
    console.log(`活动模型：${model}`);
  }
  if (Object.keys(updates).length) settingsMod.updateSettings(updates);

  const activeEngine = settingsMod.getSetting("INFERENCE_ENGINE") || "llama.cpp";
  console.log(`OmniStudio serve — ${activeEngine}`);
  console.log(`数据目录：${dataDir}`);
  console.log("Ctrl+C 停止\n");

  ServerManager.onLog((line) => {
    process.stdout.write(line + "\n");
  });
  ServerManager.onStatusChange((status) => {
    if (status === "running") {
      const hostVal = settingsMod.getSetting("SERVER_HOST") || "127.0.0.1";
      const portVal = settingsMod.getSetting("SERVER_PORT") || "8080";
      console.log(`\n推理服务器已就绪：http://${hostVal}:${portVal}\n`);
    } else if (status === "error") {
      console.error("\n推理服务器启动失败。\n");
    }
  });

  const result = await ServerManager.startServer();
  if (!result.ok) {
    console.error(`启动失败：${result.error ?? "未知错误"}`);
    process.exit(1);
  }

  const shutdown = async () => {
    console.log("\n正在停止…");
    await ServerManager.stopServer();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // 保持前台进程存活（子进程与回调不足以让事件循环挂住）。
  await new Promise<never>(() => {});
}
