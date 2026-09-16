import { randomBytes, randomUUID } from "crypto";
import { asc, eq } from "drizzle-orm";

import { logEvent } from "./app-log";
import { db } from "./db";
import { gatewayKeys, type GatewayKeyRow } from "./db/schema";
import { getSetting, updateSettings } from "./db/settings";
import { decryptSecret, encryptSecret } from "./secrets";
import { GATEWAY_KEY_PREFIX } from "../shared/gateway-key";

/**
 * 网关 API Key 的多 Key 管理（设置 → 网关 → API Key）。
 *
 * 与之前"设置里存一把 Key"的区别：现在一个网关可以挂多把带名字的 Key，各自能停用 /
 * 删除（例如"笔记本""CI""Claude Code"各一把，停用一把不影响其它客户端）。网关每个
 * 请求都从这张表现读，所以停用 / 删除 **立即生效**，不需要重启网关。
 *
 * 三个来源必须同时成立，才不会有"看着没有、实际能用"的隐藏 Key：
 *
 * 1. **表里启用的 Key** —— 界面管理的对象，也是校验的准。
 * 2. **遗留槽位 `settings.GATEWAY_API_KEY`** —— `omi serve --api-key`、隧道页的
 *    一键生成、旧版本升级上来的用户都往这里写。它照样能用（否则升级会把人锁在门外），
 *    并且**镜像**成"最早启用的一把 Key"：`/health`、OpenAI 兼容文档、`omi launch`
 *    打印的示例 Key 都读这个槽位，镜像过去它们才不会显示一把已经不存在的 Key。
 * 3. **单向采纳**：界面上打开列表时，若遗留槽位里的值不在表里，就补一行（名为
 *    "默认密钥"）——否则 CLI 写进去的 Key 会永远停在"不在列表里但能用"的状态。
 *
 * 没有启用的 Key（且遗留槽位为空）时，网关回到历史行为：对本机进程开放访问、
 * 公网暴露期间一律 401（见 gateway.ts 的 requestAuthorized）。
 */

export type GatewayKeyView = {
  id: string;
  name: string;
  /** 明文值：只在进程内 / RPC 响应里流转，界面默认掩码展示。 */
  key: string;
  enabled: boolean;
  createdAt: number;
};

export type GatewayKeyResult = { ok: true; key?: GatewayKeyView } | { ok: false; error: string };

/** 采纳遗留槽位时给那一行起的名字（用户可见，也可删）。 */
const LEGACY_KEY_NAME = "默认密钥";
const MAX_NAME_LENGTH = 60;

function rowToView(row: GatewayKeyRow): GatewayKeyView {
  return {
    id: row.id,
    name: row.name,
    key: decryptSecret(row.key),
    enabled: row.enabled !== 0,
    createdAt: row.createdAt,
  };
}

/** 按创建时间升序：列表顺序稳定，镜像取到的也是"最早启用的那一把"。 */
function selectAll(): GatewayKeyView[] {
  return db.select().from(gatewayKeys).orderBy(asc(gatewayKeys.createdAt)).all().map(rowToView);
}

function insertKey(name: string, key: string): GatewayKeyView {
  const row: GatewayKeyRow = {
    id: randomUUID(),
    name,
    key: encryptSecret(key),
    enabled: 1,
    createdAt: Date.now(),
  };
  db.insert(gatewayKeys).values(row).run();
  return rowToView(row);
}

/** 生成一把新 Key 的明文值（`osk-` + 24 位随机串）。 */
export function newGatewayKeyValue(): string {
  return `${GATEWAY_KEY_PREFIX}${randomBytes(18).toString("base64url")}`;
}

/**
 * 把遗留槽位镜像成"最早启用的一把 Key"（没有启用的 Key 则为空串）。
 *
 * 消费方（隧道开关、`/health`、`/docs`、`omi launch`、KB 接入页、CLI 文档页）读的
 * 都是这个槽位，镜像保证它们看到的是表里真实存在、当前有效的 Key。隧道侧的
 * "没 Key 就下线"判据也因此自动跟上：全部停用 = 槽位清空 = 隧道断开。
 */
function syncLegacyApiKey(keys: GatewayKeyView[] = selectAll()): void {
  const canonical = keys.find((k) => k.enabled)?.key ?? "";
  if ((getSetting("GATEWAY_API_KEY") || "").trim() === canonical) return;
  updateSettings({ GATEWAY_API_KEY: canonical });
}

/** 全部 Key（含已停用），按创建时间升序；顺带采纳遗留槽位。 */
export function listGatewayKeys(): GatewayKeyView[] {
  let keys = selectAll();
  // 采纳：`omi serve --api-key` 等外部写入的值补成一行，否则它会一直停在
  // "不在列表里却能用"的状态 —— 用户既看不到也吊销不掉。
  const legacy = (getSetting("GATEWAY_API_KEY") || "").trim();
  if (legacy && !keys.some((k) => k.key === legacy)) {
    insertKey(LEGACY_KEY_NAME, legacy);
    keys = selectAll();
  }
  syncLegacyApiKey(keys);
  return keys;
}

/** 网关校验用的 Key 集合：表里启用的 + 遗留槽位里的（去重）。 */
export function gatewayAuthTokens(): string[] {
  const tokens = selectAll()
    .filter((k) => k.enabled)
    .map((k) => k.key)
    .filter(Boolean);
  const legacy = (getSetting("GATEWAY_API_KEY") || "").trim();
  if (legacy && !tokens.includes(legacy)) tokens.push(legacy);
  return tokens;
}

/** 是否配了任何可用的 Key：false = 网关对本机进程开放访问。 */
export function hasGatewayAuthKey(): boolean {
  return gatewayAuthTokens().length > 0;
}

/** 新建一把 Key。名字必填（列表里靠它区分是哪台机器 / 哪个客户端在用）。 */
export function createGatewayKey(name: string): GatewayKeyResult {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return { ok: false, error: "请填写密钥名称" };
  if (trimmed.length > MAX_NAME_LENGTH) {
    return { ok: false, error: `密钥名称过长（最多 ${MAX_NAME_LENGTH} 个字符）` };
  }
  const view = insertKey(trimmed, newGatewayKeyValue());
  syncLegacyApiKey();
  logEvent({
    level: "info",
    source: "gateway",
    event: "gateway.key.created",
    message: `新建网关 API Key「${trimmed}」`,
    // 只记 id / 名字，不记 Key 本身。
    detail: { id: view.id, name: trimmed },
  });
  return { ok: true, key: view };
}

/** 停用 / 启用一把 Key。停用立即生效（网关每个请求现读表）。 */
export function setGatewayKeyEnabled(id: string, enabled: boolean): GatewayKeyResult {
  const row = db.select().from(gatewayKeys).where(eq(gatewayKeys.id, id)).get();
  if (!row) return { ok: false, error: "密钥不存在（可能已被删除）" };
  const view = rowToView({ ...row, enabled: enabled ? 1 : 0 });
  db.update(gatewayKeys).set({ enabled: enabled ? 1 : 0 }).where(eq(gatewayKeys.id, id)).run();
  syncLegacyApiKey();
  logEvent({
    level: "info",
    source: "gateway",
    event: enabled ? "gateway.key.enabled" : "gateway.key.disabled",
    message: `${enabled ? "启用" : "停用"}网关 API Key「${view.name}」`,
    detail: { id, name: view.name },
  });
  return { ok: true, key: view };
}

export function deleteGatewayKey(id: string): GatewayKeyResult {
  const row = db.select().from(gatewayKeys).where(eq(gatewayKeys.id, id)).get();
  if (!row) return { ok: false, error: "密钥不存在（可能已被删除）" };
  const view = rowToView(row);
  db.delete(gatewayKeys).where(eq(gatewayKeys.id, id)).run();
  // 删掉的是遗留槽位那一把时，槽位会被镜像改写成别的 Key（或清空）——
  // 这正是"删除 = 立即吊销"的语义，公网暴露下的隧道会随之断开。
  syncLegacyApiKey();
  logEvent({
    level: "info",
    source: "gateway",
    event: "gateway.key.deleted",
    message: `删除网关 API Key「${view.name}」`,
    detail: { id, name: view.name },
  });
  return { ok: true, key: view };
}
