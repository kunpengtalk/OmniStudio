import { join } from "path";
import { findLiveDataDir, resolveDataDir } from "./data-dir";

type AppModules = {
  modelStore: typeof import("../bun/model-store");
  settings: typeof import("../bun/db/settings");
  cloudProviders: typeof import("../bun/cloud-providers");
};

let loaded: AppModules | null = null;

/**
 * 应用未运行时的本地兜底：直接 import 主进程的 bun 模块读写同一份 SQLite。
 * 必须先设置 `OMNI_DATA_DIR` / `OMNI_DB_PATH`，这样 `db/index.ts` 不会去
 * 触碰 electrobun 的 `Utils.paths`（这正是路径抽象预留给独立进程的用法）。
 *
 * 数据目录优先取**正在运行的那个实例**（真的 ping 出来的），
 * 否则取显式指定 / 最近用过的那份。
 */
async function appModules(): Promise<AppModules> {
  if (loaded) return loaded;
  const dataDir = (await findLiveDataDir()) ?? resolveDataDir();
  process.env.OMNI_DATA_DIR = dataDir;
  process.env.OMNI_DB_PATH = join(dataDir, "omni-studio.db");
  const [modelStore, settings, cloudProviders] = await Promise.all([
    import("../bun/model-store"),
    import("../bun/db/settings"),
    import("../bun/cloud-providers"),
  ]);
  // 数据层已经加载了，顺手按设置接上代理：CLI 的远端备份 / 版本检查等请求也认它
  // （见 bun/proxy.ts）。放在这里而不是入口，是为了不把数据层拖进 `omi backup`。
  const { installProxy } = await import("../bun/proxy");
  installProxy();
  loaded = { modelStore, settings, cloudProviders };
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

/** 本地模型路径 → 服务名：与主进程 setActiveModel 写入 LOCAL_MODEL_NAME 的解析一致。 */
export async function servedNameForModelPathFallback(path: string): Promise<string> {
  const { modelStore } = await appModules();
  return modelStore.servedNameForModelPath(path);
}

/** 云服务商全表 + 当前激活项（与控制通道 `cloudProviders` 同一份数据）。 */
export async function cloudProvidersFallback(): Promise<
  ReturnType<typeof import("../bun/cloud-providers")["listCloudProviders"]>
> {
  const { cloudProviders } = await appModules();
  return cloudProviders.listCloudProviders();
}

/** 切换默认（激活）云服务商：网关只往它发云端请求。 */
export async function activateCloudProviderFallback(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const { cloudProviders } = await appModules();
  return cloudProviders.activateCloudProvider(id);
}
