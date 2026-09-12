import { eq } from "drizzle-orm";

import { db } from "./db";
import { cloudProviders } from "./db/schema";
import { getAllSettings, getSetting, updateSettings } from "./db/settings";
import {
  getPreset,
  parseCloudModels,
  type CloudModelEntry,
  type CloudProviderInfo,
} from "../shared/cloud-providers";

/**
 * 模型云服务商管理（cloud_providers 表）。
 *
 * 架构：多服务商配置并存，单一「激活」服务商。激活行的 baseUrl/apiKey/models
 * 同步写回 VLLM_API_BASE / VLLM_API_KEY / CLOUD_PROVIDER / CLOUD_MODELS 等旧
 * settings 槽位 —— 网关、chat-model、`omi` CLI 与集成模型选择器继续读旧键，
 * 无需感知本表。旧数据（CUSTOM_PROVIDERS / CLOUD_MODELS）在首次读取时一次性迁移入表。
 */

function rowToInfo(row: typeof cloudProviders.$inferSelect): CloudProviderInfo {
  return {
    id: row.id,
    name: row.name,
    vendor: row.vendor,
    baseUrl: row.baseUrl,
    apiKey: row.apiKey,
    models: parseCloudModels(row.models),
    createdAt: row.createdAt ?? 0,
    updatedAt: row.updatedAt ?? 0,
  };
}

function getRow(id: string) {
  return db.select().from(cloudProviders).where(eq(cloudProviders.id, id)).get();
}

/** 当前激活的服务商 id（settings.CLOUD_PROVIDER 指向的行存在才算）。 */
export function activeProviderId(): string | null {
  const id = getSetting("CLOUD_PROVIDER");
  return id && getRow(id) ? id : null;
}

/**
 * 首次访问时把散落在 settings 里的旧云服务配置迁移入表（幂等：表非空即跳过）。
 * - CUSTOM_PROVIDERS 里的自定义服务商 → 各一行（api_key 为空，旧版未存）；
 * - 当前 CLOUD_PROVIDER（预设或自定义）→ 一行，带上 VLLM_API_KEY 与 CLOUD_MODELS；
 * - 全新安装（无任何云配置）→ 预置一行 OmniLabs（未激活），引导用户补 Key。
 */
function ensureMigrated(): void {
  const existing = db.select({ id: cloudProviders.id }).from(cloudProviders).all();
  if (existing.length > 0) return;

  const legacy = getAllSettings();
  const now = Date.now();
  const rows: (typeof cloudProviders.$inferInsert)[] = [];

  // 旧版「添加服务商」加入的自定义服务商
  try {
    const customs: unknown = JSON.parse(legacy.CUSTOM_PROVIDERS ?? "[]");
    if (Array.isArray(customs)) {
      for (const c of customs) {
        if (
          !c ||
          typeof c !== "object" ||
          typeof (c as Record<string, unknown>).id !== "string" ||
          typeof (c as Record<string, unknown>).label !== "string"
        ) {
          continue;
        }
        const o = c as Record<string, unknown>;
        rows.push({
          id: o.id as string,
          name: o.label as string,
          vendor: typeof o.vendor === "string" ? o.vendor : "自定义",
          baseUrl: typeof o.baseUrl === "string" ? o.baseUrl : "",
          apiKey: "",
          models: JSON.stringify(
            Array.isArray(o.models) ? (o.models.filter((m) => typeof m === "string") as string[]).map((id) => ({ id })) : [],
          ),
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  } catch {
    // 旧 JSON 损坏时忽略，仅迁移预设部分
  }

  // 当前激活的预设服务商（带上真实 Key 与已拉取的模型列表）
  const activeId = legacy.CLOUD_PROVIDER ?? "";
  if (activeId && !rows.some((r) => r.id === activeId)) {
    const preset = getPreset(activeId);
    const key = (legacy.VLLM_API_KEY ?? "").trim();
    if (preset) {
      const savedModels = parseCloudModels(legacy.CLOUD_MODELS);
      const merged = new Map(savedModels.map((m) => [m.id, m]));
      for (const id of preset.models) if (!merged.has(id)) merged.set(id, { id });
      rows.push({
        id: preset.id,
        name: preset.name,
        vendor: preset.vendor,
        baseUrl: (legacy.VLLM_API_BASE ?? "").trim() || preset.baseUrl,
        apiKey: key === "EMPTY" ? "" : key,
        models: JSON.stringify(Array.from(merged.values())),
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  if (rows.length === 0) {
    const preset = getPreset("omnilabs")!;
    rows.push({
      id: preset.id,
      name: preset.name,
      vendor: preset.vendor,
      baseUrl: preset.baseUrl,
      apiKey: "",
      models: JSON.stringify(preset.models.map((id) => ({ id }))),
      createdAt: now,
      updatedAt: now,
    });
  }

  for (const row of rows) {
    db.insert(cloudProviders).values(row).onConflictDoNothing().run();
  }
}

/** 激活行的配置写回旧 settings 槽位（网关 / chat-model / CLI / 集成选择器消费）。 */
function syncActiveSlot(row: typeof cloudProviders.$inferSelect): void {
  updateSettings({
    CLOUD_PROVIDER: row.id,
    VLLM_API_BASE: row.baseUrl,
    VLLM_API_KEY: row.apiKey || "EMPTY",
    CLOUD_MODELS: row.models,
  });
}

export function listCloudProviders(): { providers: CloudProviderInfo[]; activeId: string | null } {
  ensureMigrated();
  const rows = db.select().from(cloudProviders).all();
  // 激活的排最前，其余按创建时间
  const activeId = activeProviderId();
  const sorted = rows
    .map(rowToInfo)
    .sort((a, b) => {
      if (a.id === activeId) return -1;
      if (b.id === activeId) return 1;
      return a.createdAt - b.createdAt;
    });
  return { providers: sorted, activeId };
}

/** 按 id 取单个服务商（基准测试等按需直连，无需全局激活）。 */
export function getCloudProviderInfo(id: string): CloudProviderInfo | null {
  ensureMigrated();
  const row = getRow(id);
  return row ? rowToInfo(row) : null;
}

export function createCloudProvider(input: {
  presetId?: string;
  name?: string;
  baseUrl?: string;
}): { ok: boolean; id?: string; error?: string } {
  ensureMigrated();
  const now = Date.now();
  let row: typeof cloudProviders.$inferInsert;

  if (input.presetId) {
    const preset = getPreset(input.presetId);
    if (!preset) return { ok: false, error: `未知预设：${input.presetId}` };
    if (getRow(preset.id)) return { ok: false, error: "该服务商已在列表中" };
    row = {
      id: preset.id,
      name: preset.name,
      vendor: preset.vendor,
      baseUrl: preset.baseUrl,
      apiKey: "",
      models: JSON.stringify(preset.models.map((id) => ({ id }))),
      createdAt: now,
      updatedAt: now,
    };
  } else {
    const name = (input.name ?? "").trim();
    if (!name) return { ok: false, error: "缺少服务商名称" };
    let id = `custom-${now}`;
    while (getRow(id)) id = `custom-${Date.now()}`;
    row = {
      id,
      name,
      vendor: "自定义",
      baseUrl: (input.baseUrl ?? "").trim(),
      apiKey: "",
      models: "[]",
      createdAt: now,
      updatedAt: now,
    };
  }

  db.insert(cloudProviders).values(row).run();
  return { ok: true, id: row.id };
}

export function updateCloudProvider(
  id: string,
  patch: {
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    models?: CloudModelEntry[];
  },
): { ok: boolean; error?: string } {
  const row = getRow(id);
  if (!row) return { ok: false, error: "服务商不存在" };

  const next = {
    name: patch.name?.trim() || row.name,
    baseUrl: patch.baseUrl !== undefined ? patch.baseUrl.trim() : row.baseUrl,
    apiKey: patch.apiKey !== undefined ? patch.apiKey.trim() : row.apiKey,
    models: patch.models !== undefined ? JSON.stringify(patch.models) : row.models,
  };
  db.update(cloudProviders).set({ ...next, updatedAt: Date.now() }).where(eq(cloudProviders.id, id)).run();

  // 激活行的配置变化即时生效（写回 VLLM_* 槽位）
  if (activeProviderId() === id) {
    syncActiveSlot({ ...row, ...next });
  }
  return { ok: true };
}

export function deleteCloudProvider(id: string): { ok: boolean; error?: string } {
  const row = getRow(id);
  if (!row) return { ok: false, error: "服务商不存在" };
  db.delete(cloudProviders).where(eq(cloudProviders.id, id)).run();

  // 删除的是激活服务商：清空槽位并回到本地模式
  if (activeProviderId() === id || getSetting("CLOUD_PROVIDER") === id) {
    updateSettings({
      CLOUD_PROVIDER: "",
      SERVER_MODE: "local",
      VLLM_API_BASE: `http://localhost:${getSetting("SERVER_PORT")}/v1`,
      VLLM_API_KEY: "EMPTY",
      CLOUD_MODELS: "[]",
    });
  }
  return { ok: true };
}

/**
 * 激活/停用服务商。激活 = 该行成为唯一云服务来源（写回槽位 + SERVER_MODE=remote，
 * 当前模型不在其模型列表时自动换成第一个可用模型）；停用 = 回到本地推理模式。
 */
export function activateCloudProvider(id: string): { ok: boolean; error?: string } {
  const row = getRow(id);
  if (!row) return { ok: false, error: "服务商不存在" };
  syncActiveSlot(row);

  const current = getSetting("VLLM_MODEL_NAME");
  const models = parseCloudModels(row.models);
  // 当前模型为空或不属于该服务商时，自动切换到其第一个模型，避免激活后无模型可用。
  const stillValid = !!current && models.some((m) => m.id === current);
  const patch: Record<string, string> = { SERVER_MODE: "remote" };
  if (!stillValid) {
    // 模型列表为空（尚未拉取）时保留当前模型名，避免误清空。
    const next = models[0]?.id ?? current;
    patch.VLLM_MODEL_NAME = next;
    patch.CHAT_MODEL = next;
  }
  updateSettings(patch);
  return { ok: true };
}

export function deactivateCloudProvider(): { ok: boolean } {
  updateSettings({ SERVER_MODE: "local" });
  return { ok: true };
}
