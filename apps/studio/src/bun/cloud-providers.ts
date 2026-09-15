import { eq } from "drizzle-orm";

import { db } from "./db";
import { cloudProviders } from "./db/schema";
import { ensureSettingsEncrypted, getAllSettings, getSetting, updateSettings } from "./db/settings";
import { logEvent } from "./app-log";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "./secrets";
import {
  getPreset,
  isLocalBaseUrl,
  modelTypeOf,
  parseCloudModels,
  type CloudModelEntry,
  type CloudModelType,
  type CloudProviderInfo,
  type CloudVideoApi,
} from "../shared/cloud-providers";
import { isChatModelCategory } from "../shared/modelscope";

/**
 * 模型云服务商管理（cloud_providers 表）。
 *
 * 架构：多服务商配置同时存在，**可以同时启用多个**（enabled=1，启用时校验密钥）。
 * 各功能页（生图 / 语音 / OCR / 视频）只从「已启用」的厂商里挑模型 —— 页面不再
 * 保存地址与密钥，只存 provider id；地址 / 密钥统一由本表提供。
 *
 * 另有单一「激活」服务商（CLOUD_PROVIDER）：对话 / 网关走的是全局推理地址，
 * 激活行的 baseUrl/apiKey/models 同步写回 VLLM_API_BASE / VLLM_API_KEY /
 * CLOUD_PROVIDER / CLOUD_MODELS 等旧 settings 槽位，网关、chat-model、`omi`
 * CLI 与集成模型选择器继续读旧键，无需感知本表。
 *
 * 旧数据一次性迁移入表：CUSTOM_PROVIDERS / CLOUD_MODELS（首读迁移）与各功能页
 * 自带的地址密钥（IMG_API_* / TTS_PROVIDER_* / ASR_PROVIDER_* / OCR_PROVIDER_* /
 * VIDEO_MINIMAX_* / VIDEO_SEEDANCE_* → 生成对应厂商行并按需启用）。
 */

function rowToInfo(row: typeof cloudProviders.$inferSelect): CloudProviderInfo {
  return {
    id: row.id,
    name: row.name,
    vendor: row.vendor,
    baseUrl: row.baseUrl,
    apiKey: decryptSecret(row.apiKey),
    models: parseCloudModels(row.models),
    enabled: row.enabled === 1,
    videoApi: (row.videoApi ?? "") as CloudVideoApi,
    createdAt: row.createdAt ?? 0,
    updatedAt: row.updatedAt ?? 0,
  };
}

/** 读行时取明文 apiKey（密文落盘、读取解密；旧明文透传）。 */
function rowApiKey(row: { apiKey: string }): string {
  return decryptSecret(row.apiKey);
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
 * 一次性把历史遗留的**明文** apiKey 加密落盘（幂等：已加密的跳过）。
 *
 * 老版本把 cloud_providers.apiKey 与 settings 里的密钥明文存 SQLite；升级后读取侧
 * （decryptSecret / settings 透明层）能透传旧明文，但值仍躺在盘上。本函数在每次
 * 访问云服务配置时兜底扫描，把明文翻成密文，保证「不写回就不落密文」的旧行也能
 * 被收进来。成本是一次全表扫描，命中明文才写库，日常调用开销可忽略。
 */
function ensureApiKeysEncrypted(): void {
  const rows = db.select().from(cloudProviders).all();
  for (const row of rows) {
    if (row.apiKey && !isEncryptedSecret(row.apiKey)) {
      db.update(cloudProviders)
        .set({ apiKey: encryptSecret(row.apiKey), updatedAt: Date.now() })
        .where(eq(cloudProviders.id, row.id))
        .run();
    }
  }
  // settings 里的敏感槽位（VLLM_API_KEY / GATEWAY_API_KEY）同样兜底：交给 settings
  // 层的 ENCRYPTED_KEYS 统一加密，这里不重复其明细逻辑。
  ensureSettingsEncrypted();
}

/**
 * 首次访问时把散落在 settings 里的旧云服务配置迁移入表（幂等：表非空即跳过）。
 * - CUSTOM_PROVIDERS 里的自定义服务商 → 各一行（api_key 为空，旧版未存）；
 * - 当前 CLOUD_PROVIDER（预设或自定义）→ 一行，带上 VLLM_API_KEY 与 CLOUD_MODELS；
 * - 全新安装（无任何云配置）→ 预置一行 OmniLabs（未激活），引导用户补 Key。
 */
export function ensureMigrated(): void {
  ensureApiKeysEncrypted();
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
        apiKey: key === "EMPTY" ? "" : encryptSecret(key),
        models: JSON.stringify(Array.from(merged.values())),
        // 迁移过来的激活厂商直接置为已启用：用户本来就在用它。
        enabled: 1,
        videoApi: preset.videoApi ?? "",
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
  // apiKey 落库是密文（见 secrets.ts）。传给 settings 前先解成明文 —— settings 层
  // 对 VLLM_API_KEY 会再加密存储、读取时透明解出，所以这里拿到的一定是明文。
  updateSettings({
    CLOUD_PROVIDER: row.id,
    VLLM_API_BASE: row.baseUrl,
    VLLM_API_KEY: decryptSecret(row.apiKey) || "EMPTY",
    CLOUD_MODELS: row.models,
  });
}

export function listCloudProviders(): { providers: CloudProviderInfo[]; activeId: string | null } {
  ensureMigrated();
  ensureAppProvidersMigrated();
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
  ensureAppProvidersMigrated();
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
      // 新加的厂商默认未启用：填好 Key 并通过校验后才「启动」。
      enabled: 0,
      videoApi: preset.videoApi ?? "",
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
    videoApi?: CloudVideoApi;
  },
): { ok: boolean; error?: string } {
  const row = getRow(id);
  if (!row) return { ok: false, error: "服务商不存在" };

  const next = {
    name: patch.name?.trim() || row.name,
    baseUrl: patch.baseUrl !== undefined ? patch.baseUrl.trim() : row.baseUrl,
    // 新 key 前端传来的是明文，落盘前加密；未提供时保持库里既有值（已是密文，不再动）。
    apiKey: patch.apiKey !== undefined ? encryptSecret(patch.apiKey.trim()) : row.apiKey,
    models: patch.models !== undefined ? JSON.stringify(patch.models) : row.models,
    videoApi: patch.videoApi !== undefined ? patch.videoApi : (row.videoApi ?? ""),
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
  // 成为对话的默认厂商 = 正在使用它，顺带置为已启用（各功能页才能选到它的模型）。
  if (row.enabled !== 1) {
    db.update(cloudProviders).set({ enabled: 1 }).where(eq(cloudProviders.id, id)).run();
  }

  const current = getSetting("VLLM_MODEL_NAME");
  const models = parseCloudModels(row.models);
  // 当前模型为空或不属于该服务商时，自动切到它的**第一个对话模型**，避免激活后无模型可用。
  // 不能直接取 models[0]：清单第一条常常是生图 / 语音 / 嵌入模型（用户最早配的往往是生图），
  // 拿它当对话模型发出去，云端只会回一句 "Model does not exist"。
  const stillValid = !!current && models.some((m) => m.id === current);
  const patch: Record<string, string> = { SERVER_MODE: "remote" };
  if (!stillValid) {
    const firstChat = models.find((m) => isChatModelCategory(modelTypeOf(m)));
    // 清单为空（还没拉取）/ 一个对话模型都没有时：保留当前模型名，避免误清空。
    const next = firstChat?.id ?? (models.length === 0 ? current : "");
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

// ---------------------------------------------------------------------------
// 启用 / 停用（可同时启用多个厂商）+ 密钥校验
// ---------------------------------------------------------------------------

/** 已启用的服务商（各功能页的可选厂商就来自这里）。 */
export function listEnabledCloudProviders(): CloudProviderInfo[] {
  return listCloudProviders().providers.filter((p) => p.enabled);
}

/** 按 id 取服务商，供功能页解析地址 / 密钥（页面本身不再保存连接信息）。 */
export function resolveCloudProvider(id: string | undefined | null): CloudProviderInfo | null {
  const providerId = (id ?? "").trim();
  if (!providerId) return null;
  return getCloudProviderInfo(providerId);
}

/**
 * 探测地址的候选（按顺序试）。
 *
 * 地址带不带版本段由用户填的 base 决定，仓库里两种约定都有：设置页「获取模型列表」
 * 直接补 `/models`（base 自带 `/v1`），对话请求则先去掉 `/v1` 再补 `/v1/…`。
 * 只按后者补 `/v1/models` 会让 Gemini 这类 base 已经带了 `/v1beta/openai` 的厂商
 * 探到一个不存在的路径（404）——而启用是功能页选到该厂商的前提，等于这家永远用不了。
 *
 * 不带版本段的地址两个都试：New API / one-api 这类聚合站，根路径往往就是**前端首页**
 * （200 + text/html），只补 `/models` 拿到的是网页而不是模型清单。
 */
export function modelListUrls(base: string): string[] {
  const b = base.trim().replace(/\/+$/, "");
  if (!b) return [];
  return /\/v\d/i.test(b) ? [`${b}/models`] : [`${b}/models`, `${b}/v1/models`];
}

/** 错误信息里只带路径：同一条地址会试两个候选，整条贴两遍没人看得下去。 */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname || url;
  } catch {
    return url;
  }
}

/** 从响应体里读模型 id；不是 OpenAI 兼容清单时给出下一步动作，而不是 SyntaxError。 */
async function readModelList(
  res: Response,
): Promise<{ ok: true; models: string[] } | { ok: false; reason: string }> {
  const text = (await res.text().catch(() => "")).replace(/^\uFEFF/, "").trim();
  if (!text) return { ok: false, reason: "响应是空的" };

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
    // 聚合站的首页就是这种「看着成功、其实不是接口」的响应：200 + 一页 HTML。
    return {
      ok: false,
      reason:
        /html/i.test(type) || text.startsWith("<")
          ? `返回的是网页（${type || "text/html"}）而不是接口，服务地址要填到 /v1 这一级`
          : `不是 JSON（${type || "未知类型"}）：${text.slice(0, 120)}`,
    };
  }

  const items = Array.isArray(json)
    ? json
    : ((json as { data?: unknown }).data ?? (json as { models?: unknown }).models);
  if (!Array.isArray(items)) {
    // 派生实现（New API 的管理接口）是这种形状：{"success":false,"message":"..."}。
    const body = json as { message?: unknown; error?: unknown };
    const nested = (body.error as { message?: unknown } | undefined)?.message;
    const upstream =
      typeof body.message === "string" && body.message
        ? body.message
        : typeof nested === "string" && nested
          ? nested
          : "";
    return {
      ok: false,
      reason: upstream ? `上游返回：${upstream}` : "响应里没有模型清单（data / models 字段）",
    };
  }

  const models = Array.from(
    new Set(
      items
        .map((m) => (typeof (m as { id?: unknown } | null)?.id === "string" ? (m as { id: string }).id : ""))
        .filter(Boolean),
    ),
  );
  return { ok: true, models };
}

/**
 * 拉取 OpenAI 兼容模型清单：候选地址逐个试，返回第一个能读出清单的结果。
 *
 * 这一份实现是设置页「获取模型列表」、启用厂商的密钥探针、各功能页的「获取模型」
 * 共用的 —— 以前它们各写各的（功能页会把 base 补成 `/v1`，设置页只补 `/models`
 * 还直接 `res.json()`），同一个上游在不同页面表现不一致：base 只填到域名一级时，
 * 设置页会拿到聚合站首页的 HTML，抛一句 `SyntaxError: Failed to parse JSON`。
 */
export async function fetchRemoteModels(input: {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; models: string[]; url?: string; error?: string }> {
  const urls = modelListUrls(input.baseUrl);
  if (urls.length === 0) return { ok: false, models: [], error: "缺少 API 地址" };

  const key = (input.apiKey ?? "").trim();
  const headers: Record<string, string> =
    key && key !== "EMPTY" ? { Authorization: `Bearer ${key}` } : {};

  const failures: string[] = [];
  let authError = "";
  for (const url of urls) {
    let res: Response;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(input.timeoutMs ?? 15_000) });
    } catch (e) {
      failures.push(`${pathOf(url)}：${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      // 鉴权失败与路径无关，但候选还是走完：有的网关只在 /v1 那一层鉴权。
      authError ||= `密钥无效或没有权限（HTTP ${res.status}）`;
      continue;
    }
    if (!res.ok) {
      failures.push(`${pathOf(url)}：HTTP ${res.status}`);
      continue;
    }
    const parsed = await readModelList(res);
    if (parsed.ok) return { ok: true, models: parsed.models, url };
    failures.push(`${pathOf(url)}：${parsed.reason}`);
  }
  return { ok: false, models: [], error: authError || failures.join("；") };
}

/**
 * 探测厂商地址 + 密钥是否可用（GET /models，与设置页「检查」同一个探针）。
 *
 * `/models` 是最轻的鉴权探针：401/403 判定为密钥无效，其余错误（404 / 网络不通）
 * 原样回给用户。本机端点（Ollama / LM Studio）不要求 Key。
 */
export async function probeProviderKey(input: {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; error?: string; models?: string[] }> {
  const base = input.baseUrl.trim();
  const key = input.apiKey.trim();
  if (!base) return { ok: false, error: "缺少 API 地址" };
  if (!key && !isLocalBaseUrl(base)) return { ok: false, error: "缺少 API 密钥" };

  const r = await fetchRemoteModels({ baseUrl: base, apiKey: key, timeoutMs: input.timeoutMs ?? 10_000 });
  // 顺便把模型清单带回去：启用时就能告诉用户这家有几张牌。
  return r.ok ? { ok: true, models: r.models } : { ok: false, error: r.error };
}

/**
 * 启用 / 停用服务商。可同时启用多个。
 *
 * 启用时先校验密钥（`probeProviderKey`）：校验不过就不启用，并把原因交回界面 ——
 * 「启动」这个动作本身要保证之后的生图 / 语音请求不会因为 Key 不对而失败。
 * 停用激活中的厂商会回到本地推理模式（否则对话会继续打到一个已停用的地址）。
 */
export async function setCloudProviderEnabled(
  id: string,
  enabled: boolean,
): Promise<{ ok: boolean; error?: string; modelCount?: number }> {
  const row = getRow(id);
  if (!row) return { ok: false, error: "服务商不存在" };

  if (!enabled) {
    db.update(cloudProviders).set({ enabled: 0, updatedAt: Date.now() })
      .where(eq(cloudProviders.id, id))
      .run();
    if (activeProviderId() === id) {
      updateSettings({ SERVER_MODE: "local", CLOUD_PROVIDER: "" });
    }
    logEvent({
      source: "app",
      event: "cloud-provider-disable",
      message: `停用云服务商 ${row.name}`,
      detail: { id, baseUrl: row.baseUrl },
    });
    return { ok: true };
  }

  const probe = await probeProviderKey({ baseUrl: row.baseUrl, apiKey: rowApiKey(row) });
  if (!probe.ok) {
    logEvent({
      level: "warn",
      source: "app",
      event: "cloud-provider-enable-failed",
      message: `启用云服务商 ${row.name} 失败：${probe.error ?? "校验未通过"}`,
      detail: { id, baseUrl: row.baseUrl },
    });
    return { ok: false, error: probe.error ?? "密钥校验未通过" };
  }
  db.update(cloudProviders).set({ enabled: 1, updatedAt: Date.now() })
    .where(eq(cloudProviders.id, id))
    .run();

  // 启用时把探到的模型并进清单：新上线的模型不用等用户手动「获取模型列表」。
  if (probe.models && probe.models.length > 0) {
    mergeDiscoveredModels(row, probe.models);
  }
  logEvent({
    source: "app",
    event: "cloud-provider-enable",
    message: `启用云服务商 ${row.name}`,
    detail: { id, baseUrl: row.baseUrl, models: probe.models?.length ?? 0 },
  });
  return { ok: true, modelCount: probe.models?.length };
}

/**
 * 首次启动时把探到的模型并入清单（分类留空，读取时按名字自动识别）。
 *
 * 只在清单还是空的时候并：`/v1/models` 动辄上百条，全量塞进来会让各功能页的
 * 选择器被淹掉 —— 已经有清单的厂商维持用户挑过的那些，要补新模型走设置页的
 * 「获取模型列表」（那里逐个挑，还能标用途）。
 */
function mergeDiscoveredModels(row: typeof cloudProviders.$inferSelect, ids: string[]): void {
  if (parseCloudModels(row.models).length > 0) return;
  const added: CloudModelEntry[] = ids.map((id) => ({ id }));
  if (added.length === 0) return;
  db.update(cloudProviders)
    .set({ models: JSON.stringify(added), updatedAt: Date.now() })
    .where(eq(cloudProviders.id, row.id))
    .run();
}

// ---------------------------------------------------------------------------
// 旧配置搬家：各功能页自带的地址 + 密钥 → 服务商行
// ---------------------------------------------------------------------------

/** 生成 / 合并服务商时用的友好名称（按常见域名认厂商）。 */
const LEGACY_HOST_NAMES: [RegExp, string][] = [
  [/minimaxi|minimax/i, "MiniMax"],
  [/volces|volcengine/i, "火山方舟 (Seedance)"],
  [/dashscope|aliyuncs/i, "通义千问 (Qwen)"],
  [/siliconflow/i, "硅基流动"],
  [/deepseek/i, "DeepSeek"],
  [/bigmodel/i, "智谱 GLM"],
  [/moonshot/i, "Kimi"],
  [/omnilabs/i, "OmniLabs"],
  [/openai\.com/i, "OpenAI"],
];

function providerNameForBase(base: string): string {
  for (const [re, name] of LEGACY_HOST_NAMES) if (re.test(base)) return name;
  try {
    return new URL(base).hostname;
  } catch {
    return "自定义服务商";
  }
}

function normalizeBaseForCompare(base: string): string {
  return base.trim().replace(/\/+$/, "").toLowerCase();
}

function findRowByBase(base: string) {
  const target = normalizeBaseForCompare(base);
  if (!target) return undefined;
  return db
    .select()
    .from(cloudProviders)
    .all()
    .find((r) => normalizeBaseForCompare(r.baseUrl) === target);
}

/**
 * 各功能页历史上自带一套地址 + 密钥（生图 / TTS / ASR / OCR / 视频）。
 * 新模型是「功能页只选厂商 + 模型」，连接信息统一放服务商表 —— 这里把旧配置
 * 一次性搬成服务商行并选中，老用户升级后原来的接口继续能用，不用重填。
 *
 * 只在用户真配过时迁移：TTS / ASR / 视频的地址键自带默认值，没填过 Key
 * （且不是本机端点）就当作没配置，避免凭空多出几个用不了的厂商。
 */
export function ensureAppProvidersMigrated(): void {
  if (getSetting("CLOUD_APP_PROVIDERS_MIGRATED") === "1") return;
  ensureMigrated();
  const s = getAllSettings();
  // 视频按当前后端只搬一套（另一套留在旧键里，不再使用）。
  const videoBackend = (s.VIDEO_BACKEND ?? "").trim();

  const apps: {
    settingKey: string;
    baseKey: string;
    keyKey: string;
    /** 新版模型设置键（功能页读这个）。 */
    modelKey: string;
    /** 旧版模型设置键（视频两套后端各有一个）；缺省等于 modelKey。 */
    legacyModelKey?: string;
    type: CloudModelType;
    videoApi?: CloudVideoApi;
    /** 迁移后写回的后端值（视频从 minimax/seedance 归一成 cloud）。 */
    backendKey?: string;
    backendValue?: string;
  }[] = [
    {
      settingKey: "IMG_PROVIDER_ID",
      baseKey: "IMG_API_BASE",
      keyKey: "IMG_API_KEY",
      modelKey: "IMG_MODEL",
      type: "image",
    },
    {
      settingKey: "TTS_PROVIDER_ID",
      baseKey: "TTS_PROVIDER_BASE",
      keyKey: "TTS_PROVIDER_API_KEY",
      modelKey: "TTS_PROVIDER_MODEL",
      type: "tts",
    },
    {
      settingKey: "ASR_PROVIDER_ID",
      baseKey: "ASR_PROVIDER_BASE",
      keyKey: "ASR_PROVIDER_API_KEY",
      modelKey: "ASR_PROVIDER_MODEL",
      type: "asr",
    },
    {
      settingKey: "OCR_PROVIDER_ID",
      baseKey: "OCR_PROVIDER_BASE",
      keyKey: "OCR_PROVIDER_API_KEY",
      modelKey: "OCR_PROVIDER_MODEL",
      type: "chat",
    },
  ];
  if (videoBackend === "minimax") {
    apps.push({
      settingKey: "VIDEO_PROVIDER_ID",
      baseKey: "VIDEO_MINIMAX_BASE",
      keyKey: "VIDEO_MINIMAX_API_KEY",
      modelKey: "VIDEO_MODEL",
      legacyModelKey: "VIDEO_MINIMAX_MODEL",
      type: "video",
      videoApi: "minimax",
      backendKey: "VIDEO_BACKEND",
      backendValue: "cloud",
    });
  } else if (videoBackend === "seedance") {
    apps.push({
      settingKey: "VIDEO_PROVIDER_ID",
      baseKey: "VIDEO_SEEDANCE_BASE",
      keyKey: "VIDEO_SEEDANCE_API_KEY",
      modelKey: "VIDEO_MODEL",
      legacyModelKey: "VIDEO_SEEDANCE_MODEL",
      type: "video",
      videoApi: "seedance",
      backendKey: "VIDEO_BACKEND",
      backendValue: "cloud",
    });
  }

  const now = Date.now();
  for (const app of apps) {
    if ((s[app.settingKey] ?? "").trim()) continue; // 已经选过厂商（新装 / 已迁移）
    const base = (s[app.baseKey] ?? "").trim();
    const key = (s[app.keyKey] ?? "").trim();
    if (!base) continue;
    if (!key && !isLocalBaseUrl(base)) continue; // 只有默认地址，用户没配过

    let row = findRowByBase(base);
    if (!row) {
      let id = `custom-${now}`;
      while (getRow(id)) id = `custom-${Date.now()}`;
      const insert = {
        id,
        name: providerNameForBase(base),
        vendor: "旧配置迁移",
        baseUrl: base,
        apiKey: key ? encryptSecret(key) : "",
        models: "[]",
        // 正在被使用的厂商直接启用：它已经被用户用了很久了。
        enabled: 1,
        videoApi: app.videoApi ?? "",
        createdAt: now,
        updatedAt: now,
      };
      db.insert(cloudProviders).values(insert).run();
      row = getRow(id);
    } else {
      const patch: Record<string, unknown> = { updatedAt: now };
      if (row.enabled !== 1) patch.enabled = 1;
      if (key && !row.apiKey.trim()) patch.apiKey = encryptSecret(key);
      if (app.videoApi && (row.videoApi ?? "") !== app.videoApi) patch.videoApi = app.videoApi;
      if (Object.keys(patch).length > 1) {
        db.update(cloudProviders).set(patch).where(eq(cloudProviders.id, row.id)).run();
        row = getRow(row.id)!;
      }
    }
    if (!row) continue;

    const model = (s[app.legacyModelKey ?? app.modelKey] ?? "").trim();
    if (model) {
      const existing = parseCloudModels(row.models);
      if (!existing.some((m) => m.id === model)) {
        const entry: CloudModelEntry = { id: model, type: app.type };
        db.update(cloudProviders)
          .set({ models: JSON.stringify([...existing, entry]), updatedAt: now })
          .where(eq(cloudProviders.id, row.id))
          .run();
      } else if (modelTypeOf(existing.find((m) => m.id === model)!) !== app.type) {
        // 用途对不上（比如生图模型 id 被自动识别成对话）：按功能页的用途纠正，
        // 否则刚迁移完的选择器里会看不到这个模型。
        const next = existing.map((m) => (m.id === model ? { ...m, type: app.type } : m));
        db.update(cloudProviders)
          .set({ models: JSON.stringify(next), updatedAt: now })
          .where(eq(cloudProviders.id, row.id))
          .run();
      }
    }

    updateSettings({
      [app.settingKey]: row.id,
      // 视频的模型键换过名字（VIDEO_SEEDANCE_MODEL → VIDEO_MODEL）：搬过来。
      ...(app.legacyModelKey && model ? { [app.modelKey]: model } : {}),
      ...(app.backendKey && app.backendValue ? { [app.backendKey]: app.backendValue } : {}),
    });
    logEvent({
      source: "app",
      event: "cloud-provider-migrate-legacy",
      message: `旧配置迁移为云服务商：${row.name}`,
      detail: { app: app.settingKey, providerId: row.id, baseUrl: base, model },
    });
  }

  updateSettings({ CLOUD_APP_PROVIDERS_MIGRATED: "1" });
}

/**
 * 功能页保存「厂商 + 模型」：写 id 与模型名，并把模型补进厂商清单（带用途分类）。
 * 页面只挑模型，不再保存地址与密钥。
 */
export function saveAppModelChoice(input: {
  settingKey: "IMG_PROVIDER_ID" | "TTS_PROVIDER_ID" | "ASR_PROVIDER_ID" | "OCR_PROVIDER_ID" | "VIDEO_PROVIDER_ID";
  modelKey?: string;
  providerId: string;
  model?: string;
  type: CloudModelType;
}): { ok: boolean; error?: string } {
  const provider = getRow(input.providerId);
  if (!provider) return { ok: false, error: "服务商不存在" };
  if (provider.enabled !== 1) return { ok: false, error: "该服务商还没启用（去「设置 → 模型云服务」启动）" };

  const patch: Record<string, string> = { [input.settingKey]: provider.id };
  const model = (input.model ?? "").trim();
  if (input.modelKey && input.model !== undefined) patch[input.modelKey] = model;
  updateSettings(patch);

  if (model) {
    const existing = parseCloudModels(provider.models);
    const found = existing.find((m) => m.id === model);
    if (!found) {
      db.update(cloudProviders)
        .set({
          models: JSON.stringify([...existing, { id: model, type: input.type }]),
          updatedAt: Date.now(),
        })
        .where(eq(cloudProviders.id, provider.id))
        .run();
    } else if (found.type === undefined) {
      // 自动识别可能认错（生图 / 视频模型命名千奇百怪）：功能页选中的模型
      // 一定属于这个用途，落一个显式分类，其他页面就不会把它列错位置。
      const next = existing.map((m) => (m.id === model ? { ...m, type: input.type } : m));
      db.update(cloudProviders)
        .set({ models: JSON.stringify(next), updatedAt: Date.now() })
        .where(eq(cloudProviders.id, provider.id))
        .run();
    }
  }
  return { ok: true };
}
