import { join } from "path";
import { resolveDataDir } from "./data-dir";

type AppModules = {
  modelStore: typeof import("../bun/model-store");
  settings: typeof import("../bun/db/settings");
};

let loaded: AppModules | null = null;

/**
 * 应用未运行时的本地兜底：直接 import 主进程的 bun 模块读写同一份 SQLite。
 * 必须先设置 `OMNI_DATA_DIR` / `OMNI_DB_PATH`，这样 `db/index.ts` 不会去
 * 触碰 electrobun 的 `Utils.paths`（这正是路径抽象预留给独立进程的用法）。
 */
async function appModules(): Promise<AppModules> {
  if (loaded) return loaded;
  const dataDir = resolveDataDir();
  process.env.OMNI_DATA_DIR = dataDir;
  process.env.OMNI_DB_PATH = join(dataDir, "omni-studio.db");
  const [modelStore, settings] = await Promise.all([
    import("../bun/model-store"),
    import("../bun/db/settings"),
  ]);
  loaded = { modelStore, settings };
  return loaded;
}

export async function listInstalledModelsFallback(): Promise<ReturnType<typeof import("../bun/model-store")["listInstalledModels"]>> {
  const { modelStore } = await appModules();
  return modelStore.listInstalledModels();
}

export async function getAllSettingsFallback(): Promise<Record<string, string>> {
  const { settings } = await appModules();
  return settings.getAllSettings();
}

export async function updateSettingsFallback(values: Record<string, string>): Promise<void> {
  const { settings } = await appModules();
  settings.updateSettings(values);
}

export async function setActiveModelFallback(path: string): Promise<{ ok: boolean; error?: string }> {
  const { modelStore } = await appModules();
  const r = modelStore.setActiveModel(path);
  return { ok: r.ok, error: r.error };
}

export async function activeModelPathFallback(): Promise<string> {
  const { modelStore } = await appModules();
  return modelStore.getActiveModelPath();
}
