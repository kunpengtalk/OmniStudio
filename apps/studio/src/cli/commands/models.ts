import type { ParsedArgs } from "../args";
import { optBool } from "../args";
import { controlRequest, ensureAppRunning } from "../client";
import {
  cloudProvidersFallback,
  getAllSettingsFallback,
  listInstalledModelsFallback,
  setActiveModelFallback,
} from "../db";
import { formatBytes, printTable, slugModelFileName } from "../format";
import { pickNumbered } from "../tui";
import { CMD_HELP } from "../help";

type InstalledModel = {
  repo: string;
  fileName: string;
  path: string;
  size: number;
  isActive: boolean;
  isChatModel: boolean;
  category: string;
  favorite: boolean;
  servedName: string;
};

type CloudModelEntry = { id: string; name?: string; group?: string; remark?: string };

function parseCloud(models: unknown[]): CloudModelEntry[] {
  return models
    .filter((m): m is CloudModelEntry => !!m && typeof (m as CloudModelEntry).id === "string")
    .map((m) => ({ ...m }));
}

/** 尽力拿到已装模型列表：优先走应用 socket，应用没跑则直接读库。 */
export async function getInstalledModels(): Promise<InstalledModel[]> {
  const r = await controlRequest("models", undefined, 15_000);
  if (r.connected && r.ok && Array.isArray(r.data?.installed)) {
    return r.data.installed;
  }
  const fallback = await listInstalledModelsFallback().catch(() => []);
  return (fallback as unknown[]).map((m) => ({
    ...(m as InstalledModel),
    servedName: slugModelFileName((m as InstalledModel).fileName),
  }));
}

/** 云端模型 + 它所属的服务商（同名模型可能出现在多家，靠 active / enabled 区分优先）。 */
export type CloudModelRef = {
  id: string;
  providerId: string;
  providerName: string;
  enabled: boolean;
  active: boolean;
  hasKey: boolean;
};

/** 控制通道 / 离线兜底拿到的 `{ providers, activeId }` → 扁平模型清单。 */
export function cloudModelRefsFromProviders(data: unknown): CloudModelRef[] {
  const list = (data as { providers?: unknown } | null | undefined)?.providers;
  if (!Array.isArray(list)) return [];
  const activeId = (data as { activeId?: unknown }).activeId;
  const refs: CloudModelRef[] = [];
  for (const raw of list as Array<Record<string, unknown>>) {
    const providerId = typeof raw?.id === "string" ? raw.id : "";
    if (!providerId) continue;
    const providerName = typeof raw?.name === "string" && raw.name ? raw.name : providerId;
    const enabled = raw?.enabled === true;
    const active = providerId === activeId;
    const hasKey = typeof raw?.apiKey === "string" && raw.apiKey.length > 0;
    for (const entry of Array.isArray(raw?.models) ? (raw.models as unknown[]) : []) {
      const id = typeof (entry as { id?: unknown })?.id === "string" ? (entry as { id: string }).id : "";
      if (id) refs.push({ id, providerId, providerName, enabled, active, hasKey });
    }
  }
  return refs;
}

/**
 * 所有云服务商的模型清单（含未启用 / 非默认的）。
 *
 * 为什么不看 CLOUD_MODELS 那个旧槽位：它只镜像**激活**厂商一家，而 GUI 的模型选择器
 * 是按「全部已启用厂商」聚合的（chat-model.ts 的 enabledCloudProviders）。只认激活
 * 厂商会出现"应用里明明能用、`omi launch --model` 却说找不到"。控制通道拿不到
 * （旧版实例 / 应用没跑）时直接读同一张表 —— CLI 与应用共用一份 SQLite。
 */
export async function getCloudModelRefs(): Promise<CloudModelRef[]> {
  const r = await controlRequest("cloudProviders", undefined, 15_000);
  if (r.connected && r.ok) {
    const refs = cloudModelRefsFromProviders(r.data);
    if (refs.length > 0) return refs;
  }
  const fb = await cloudProvidersFallback().catch((err: unknown) => {
    // 读不出厂商表（secrets.key 丢了 / 库损坏）时别静默当成"没有云模型"：
    // 那只会让用户再看到一句莫名其妙的"未找到模型"。
    console.error(`读取云服务商配置失败：${err instanceof Error ? err.message : String(err)}`);
    return null;
  });
  return fb ? cloudModelRefsFromProviders(fb) : [];
}

async function getCloudModels(): Promise<{ cloud: CloudModelEntry[]; provider: string; mode: string }> {
  const r = await controlRequest("models", undefined, 15_000);
  if (r.connected && r.ok) {
    return {
      cloud: parseCloud(r.data?.cloud ?? []),
      provider: r.data?.cloudProvider ?? "",
      mode: r.data?.mode ?? "",
    };
  }
  const settings = await getAllSettingsFallback().catch(() => ({} as Record<string, string>));
  let cloud: CloudModelEntry[] = [];
  try {
    const raw = JSON.parse(settings.CLOUD_MODELS ?? "[]");
    cloud = Array.isArray(raw) ? parseCloud(raw) : [];
  } catch {
    cloud = [];
  }
  return { cloud, provider: settings.CLOUD_PROVIDER ?? "", mode: settings.SERVER_MODE ?? "" };
}

async function setActiveModel(path: string): Promise<void> {
  const r = await controlRequest("setActiveModel", { path }, 15_000);
  if (r.connected) {
    if (!r.ok) {
      console.error(r.error ?? "设置活动模型失败");
      process.exit(1);
    }
    return;
  }
  const fb = await setActiveModelFallback(path);
  if (!fb.ok) {
    console.error(fb.error ?? "设置活动模型失败");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// omi models
// ---------------------------------------------------------------------------

export async function cmdModels() {
  const installed = await getInstalledModels();

  if (installed.length === 0) {
    console.log("（本地没有已安装模型）在应用里打开模型列表可以下载/导入：`omi model`");
  } else {
    console.log(`本地模型（${installed.length}）：`);
    printTable(
      ["名称", "大小", "类型", "状态"],
      installed.map((m) => [
        m.servedName || m.fileName,
        formatBytes(m.size),
        m.category,
        m.isActive ? "● 活动" : "",
      ]),
    );
  }

  // 云端段按厂商列出**所有已启用**的（不是只有默认那家）：GUI 的模型选择器就是这个
  // 口径，`omi launch --model <id>` 也认这些 id —— 两边清单不一致会让人以为模型丢了。
  const refs = await getCloudModelRefs().catch(() => []);
  const rows = refs
    .filter((m) => m.enabled || m.active)
    .map((m) => [m.active ? `${m.providerName} ● 默认` : m.providerName, m.id]);
  if (rows.length) {
    const vendors = new Set(refs.filter((m) => m.enabled || m.active).map((m) => m.providerId)).size;
    console.log(`\n云端模型（${vendors} 个已启用厂商）：`);
    printTable(["厂商", "ID"], rows);
    return;
  }
  // 厂商表读不出来时的退路：老样式只显示默认厂商那一家的模型。
  const { cloud, provider } = await getCloudModels();
  if (cloud.length) {
    console.log(`\n云端模型（${provider || "未配置服务商"}）：`);
    printTable(
      ["ID", "名称", "分组"],
      cloud.map((m) => [m.id, m.name ?? "", m.group ?? ""]),
    );
  } else if (installed.length === 0) {
    console.log("\n（没有云端模型）配置云端服务：`omi cloud --set <provider> <endpoint> [models...]`");
  }
}

// ---------------------------------------------------------------------------
// omi model
// ---------------------------------------------------------------------------

export async function cmdModel(parsed: ParsedArgs) {
  const list = optBool(parsed.options, "list");
  const select = optBool(parsed.options, "select");

  if (list) {
    const installed = await getInstalledModels();
    if (installed.length === 0) {
      console.log("（本地没有已安装模型）运行 `omi model` 打开应用模型列表下载。");
      return;
    }
    printTable(
      ["名称", "大小", "类型", "状态"],
      installed.map((m) => [
        m.servedName || m.fileName,
        formatBytes(m.size),
        m.category,
        m.isActive ? "● 活动" : "",
      ]),
    );
    return;
  }

  if (select) {
    const installed = await getInstalledModels();
    if (installed.length === 0) {
      console.log("（本地没有已安装模型）运行 `omi model` 打开应用模型列表下载。");
      return;
    }
    const pick = await pickNumbered(
      "选择模型设为活动模型：",
      installed.map((m) => ({
        label: m.servedName || m.fileName,
        value: m.path,
        dim: `${formatBytes(m.size)} · ${m.category}${m.isActive ? " · 活动" : ""}`,
      })),
    );
    if (!pick) {
      console.log("已取消。");
      return;
    }
    await setActiveModel(pick);
    const chosen = installed.find((m) => m.path === pick);
    console.log(`已设为活动模型：${chosen ? chosen.servedName || chosen.fileName : pick}`);
    const r = await controlRequest("serverRestart", undefined, 120_000);
    if (r.connected && r.ok) console.log("推理服务器已用新模型重启。");
    return;
  }

  // 默认：在应用 GUI 里打开模型列表
  const connected = await ensureAppRunning();
  if (!connected) {
    console.error("应用未运行。");
    process.exit(1);
  }
  await controlRequest("navigate", { path: "models" });
  console.log("已在应用里打开模型列表，请在窗口中选择模型。");
}

// ---------------------------------------------------------------------------
// omi model-info
// ---------------------------------------------------------------------------

export async function cmdModelInfo(parsed: ParsedArgs) {
  const name = parsed.positionals[0];
  if (!name) {
    console.log(CMD_HELP["model-info"]);
    return;
  }
  const installed = await getInstalledModels();
  const match =
    installed.find((m) => m.path === name) ??
    installed.find((m) => m.fileName === name) ??
    installed.find((m) => m.servedName === name) ??
    installed.find((m) => m.repo === name);

  if (!match) {
    console.error(`未找到模型「${name}」。运行 \`omi models\` 查看已装模型。`);
    process.exit(1);
  }

  console.log(`模型详情：${match.servedName || match.fileName}`);
  console.log(`  仓库：${match.repo}`);
  console.log(`  文件：${match.fileName}`);
  console.log(`  服务名：${match.servedName}`);
  console.log(`  路径：${match.path}`);
  console.log(`  大小：${formatBytes(match.size)}`);
  console.log(`  类型：${match.category}`);
  console.log(`  状态：${match.isActive ? "● 活动" : "未激活"}`);
  if (match.isChatModel) console.log(`  角色：对话模型`);
}

// ---------------------------------------------------------------------------
// omi cloud
// ---------------------------------------------------------------------------

export async function cmdCloud(parsed: ParsedArgs) {
  const list = optBool(parsed.options, "list");
  // `--set <provider> <endpoint> [models...]`：provider 被解析为选项值，
  // endpoint 与 models 在 positionals 里。
  const providerFromFlag = typeof parsed.options.set === "string" ? parsed.options.set : undefined;

  if (providerFromFlag !== undefined) {
    const values = parsed.positionals;
    if (values.length < 1) {
      console.error("用法：omi cloud --set <provider> <endpoint> [models...]");
      process.exit(1);
    }
    const endpoint = values[0]!;
    const models = values.slice(1);
    const settings: Record<string, string> = {
      SERVER_MODE: "remote",
      CLOUD_PROVIDER: providerFromFlag,
      VLLM_API_BASE: endpoint,
    };
    if (models.length) {
      settings.CLOUD_MODELS = JSON.stringify(models.map((id) => ({ id })));
    }
    const r = await controlRequest("updateSettings", { settings }, 15_000);
    if (r.connected && !r.ok) {
      console.error(r.error ?? "写入配置失败");
      process.exit(1);
    }
    if (!r.connected) {
      const { updateSettingsFallback } = await import("../db");
      await updateSettingsFallback(settings);
    }
    console.log(
      `已配置云端服务：${providerFromFlag} @ ${endpoint}${models.length ? `（模型：${models.join(", ")}）` : ""}`,
    );
    return;
  }

  if (list) {
    const { cloud, provider, mode } = await getCloudModels();
    console.log(`模式：${mode === "remote" ? "云端（remote）" : "本地（local）"}`);
    console.log(`服务商：${provider || "未配置"}`);
    if (cloud.length) {
      console.log("云端模型：");
      for (const m of cloud) {
        console.log(`  - ${m.id}${m.name ? `（${m.name}）` : ""}${m.group ? ` [${m.group}]` : ""}`);
      }
    } else {
      console.log("（没有云端模型）");
    }
    return;
  }

  // 默认：打开应用云端配置页
  const connected = await ensureAppRunning();
  if (!connected) {
    console.error("应用未运行。");
    process.exit(1);
  }
  await controlRequest("navigate", { path: "settings" });
  console.log("已在应用里打开“设置 → 云端”配置页。");
}
