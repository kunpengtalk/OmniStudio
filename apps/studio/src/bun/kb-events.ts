/**
 * 知识库审计流水：谁在什么时候导入/删除了什么、检索打了多少次命中多少。
 *
 * 企业场景里「这个答案从哪来、谁把它放进来的、什么时候放进来」必须可回答，
 * 所以写路径与查询路径都留痕；detail 存 JSON，容忍字段演进。
 * 只依赖 db/schema，避免与摄取、检索层形成环。
 */
import { and, desc, eq, lt, sql } from "drizzle-orm";

import { db } from "./db";
import { kbEvents } from "./db/schema";
import type { KbEventEntry } from "../shared/knowledge";

export type KbEventAction =
  | "kb_created"
  | "kb_deleted"
  | "kb_config"
  | "doc_added"
  | "doc_ingested"
  | "doc_skipped"
  | "doc_failed"
  | "doc_deleted"
  | "doc_reingested"
  | "recall"
  | "export"
  | "import"
  | "maintenance";

/** 写审计流水。审计失败不能影响主流程，因此所有异常就地吞掉。 */
export function recordKbEvent(input: {
  kbId?: number | null;
  docId?: number | null;
  action: KbEventAction;
  detail?: unknown;
  /** 来源：ui / chat / agent / cli / rest / mcp。 */
  actor?: string;
}): void {
  try {
    db.insert(kbEvents)
      .values({
        kbId: input.kbId ?? null,
        docId: input.docId ?? null,
        action: input.action,
        detail: input.detail === undefined ? null : JSON.stringify(input.detail).slice(0, 4000),
        actor: input.actor ?? "ui",
      })
      .run();
  } catch {
    // ignore
  }
}

function parseDetail(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export function listKbEvents(opts: { kbId?: number; limit?: number; action?: KbEventAction } = {}): KbEventEntry[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  const where = [
    opts.kbId != null ? eq(kbEvents.kbId, opts.kbId) : undefined,
    opts.action ? eq(kbEvents.action, opts.action) : undefined,
  ].filter(Boolean);
  const rows = db
    .select()
    .from(kbEvents)
    .where(where.length > 0 ? and(...where) : undefined)
    .orderBy(desc(kbEvents.id))
    .limit(limit)
    .all();
  return rows.map((r) => ({
    id: r.id,
    kbId: r.kbId,
    docId: r.docId,
    action: r.action,
    detail: parseDetail(r.detail),
    actor: r.actor,
    createdAt: r.createdAt,
  }));
}

/** 各动作计数（治理页概览）。 */
export function kbEventCounts(kbId?: number): Record<string, number> {
  const rows = db
    .select({ action: kbEvents.action, count: sql<number>`count(*)` })
    .from(kbEvents)
    .where(kbId != null ? eq(kbEvents.kbId, kbId) : undefined)
    .groupBy(kbEvents.action)
    .all();
  return Object.fromEntries(rows.map((r) => [r.action, Number(r.count)]));
}

/**
 * 保留策略：检索流水量级最大，只留最近 `keepRecall` 条；
 * 其余动作（导入/删除/配置）是真正的审计凭据，保留窗口按条数宽松得多。
 */
export function pruneKbEvents(opts: { keepRecall?: number; keepOthers?: number } = {}): number {
  const keepRecall = opts.keepRecall ?? 2000;
  const keepOthers = opts.keepOthers ?? 20000;
  let removed = 0;
  const cutoffRecall = db
    .select({ id: kbEvents.id })
    .from(kbEvents)
    .where(eq(kbEvents.action, "recall"))
    .orderBy(desc(kbEvents.id))
    .limit(1)
    .offset(keepRecall - 1)
    .get();
  if (cutoffRecall) {
    removed += db
      .delete(kbEvents)
      .where(and(eq(kbEvents.action, "recall"), lt(kbEvents.id, cutoffRecall.id)))
      .returning({ id: kbEvents.id })
      .all().length;
  }
  const cutoffOthers = db
    .select({ id: kbEvents.id })
    .from(kbEvents)
    .orderBy(desc(kbEvents.id))
    .limit(1)
    .offset(keepOthers - 1)
    .get();
  if (cutoffOthers) {
    removed += db.delete(kbEvents).where(lt(kbEvents.id, cutoffOthers.id)).returning({ id: kbEvents.id }).all().length;
  }
  return removed;
}
