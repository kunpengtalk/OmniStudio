import { eq, sql, and, desc } from "drizzle-orm";
import { db } from "./db";
import { userPrompts as upTable, prompts as promptsTable } from "./db/schema";
import type { PromptKind } from "./db/schema";
import { mediaUrl } from "./prompt-library";

export type { PromptKind };

/** 空分类在界面上统一显示为「未分类」。 */
export const UNCATEGORIZED = "未分类";

/**
 * 我的提示词的 UI 行：字段与广场 PromptRow 兼容（卡片 / 详情浮层直接复用），
 * 额外带 sourceKey（从广场导入的来源）与创建/更新时间。
 */
export type UserPromptView = {
  id: number;
  /** 与 PromptRow.key 对齐的唯一标识。 */
  key: string;
  kind: PromptKind;
  category: string;
  subcategory: string | null;
  name: string;
  prompt: string;
  summary: string | null;
  ratio: string | null;
  /** 已解析的图片 URL（本地缓存 → 云端直链）。 */
  image: string | null;
  video: string | null;
  /** 原始媒体相对路径，供前端 ensurePromptMedia 拉取本地缓存。 */
  mediaKey: string | null;
  playUrl: string | null;
  playLabel: string | null;
  source: string | null;
  sourceUrl: string | null;
  sourceLabel: string | null;
  featured: number;
  mode: string | null;
  duration: number | null;
  /** 从广场导入时对应的 prompts.key；手动新建为 null。 */
  sourceKey: string | null;
  createdAt: number;
  updatedAt: number;
};

export type MyPromptInput = {
  kind: PromptKind;
  category?: string;
  name: string;
  prompt: string;
  summary?: string;
  ratio?: string;
  image?: string;
  sourceKey?: string;
};

export type MyPromptPatch = Partial<MyPromptInput>;

function toView(r: (typeof upTable.$inferSelect)): UserPromptView {
  const mediaKey =
    r.image && r.image.startsWith("/prompt-library/") ? r.image.slice(1) : null;
  return {
    id: r.id,
    key: `user-${r.id}`,
    kind: r.kind,
    category: r.category || UNCATEGORIZED,
    subcategory: null,
    name: r.name,
    prompt: r.prompt,
    summary: r.summary,
    ratio: r.ratio,
    image: mediaUrl(r.image),
    video: null,
    mediaKey,
    playUrl: null,
    playLabel: null,
    source: r.sourceKey ? "plaza" : "mine",
    sourceUrl: null,
    sourceLabel: null,
    featured: 0,
    mode: null,
    duration: null,
    sourceKey: r.sourceKey,
    createdAt: r.createdAt ?? 0,
    updatedAt: r.updatedAt ?? 0,
  };
}

export type MyPromptListParams = {
  kind?: PromptKind;
  /** 「未分类」映射到空分类。 */
  category?: string;
  search?: string;
  limit?: number;
  offset?: number;
};

/** 我的提示词各类型的数量（侧边栏徽标用）。 */
export function countMyPromptsByKind(): Record<PromptKind, number> {
  const rows = db
    .select({ kind: upTable.kind, n: sql<number>`count(*)` })
    .from(upTable)
    .groupBy(upTable.kind)
    .all();
  const out: Record<PromptKind, number> = { image: 0, llm: 0, video: 0 };
  for (const r of rows) out[r.kind as PromptKind] = r.n;
  return out;
}

/** 分页列出我的提示词（按最近更新倒序）。 */
export function listMyPrompts(
  params: MyPromptListParams,
): { items: UserPromptView[]; total: number } {
  const limit = Math.min(params.limit ?? 60, 200);
  const offset = params.offset ?? 0;
  const conds = [];
  if (params.kind) conds.push(eq(upTable.kind, params.kind));
  if (params.category === UNCATEGORIZED) {
    conds.push(sql`${upTable.category} = ''`);
  } else if (params.category) {
    conds.push(eq(upTable.category, params.category));
  }
  if (params.search?.trim()) {
    const kw = `%${params.search.trim()}%`;
    conds.push(
      sql`(${upTable.name} like ${kw} or ${upTable.category} like ${kw} or ${upTable.summary} like ${kw} or ${upTable.prompt} like ${kw})`,
    );
  }
  const where = and(...conds);
  const items = db
    .select()
    .from(upTable)
    .where(where)
    .orderBy(desc(upTable.updatedAt), desc(upTable.id))
    .limit(limit)
    .offset(offset)
    .all()
    .map(toView);
  const totalRow = db
    .select({ n: sql<number>`count(*)` })
    .from(upTable)
    .where(where)
    .get();
  return { items, total: totalRow?.n ?? 0 };
}

/** 我的提示词的分类列表（含条数；空分类归「未分类」）。 */
export function listMyPromptCategories(): {
  name: string;
  intro: string | null;
  count: number;
}[] {
  const rows = db
    .select({ category: upTable.category, n: sql<number>`count(*)` })
    .from(upTable)
    .groupBy(upTable.category)
    .all();
  return rows
    .map((r) => ({ name: r.category || UNCATEGORIZED, intro: null, count: r.n }))
    .sort((a, b) => b.count - a.count);
}

/** 已从广场导入的 prompts.key 集合（供广场卡片「已加入」判断）。 */
export function listMyPromptSourceKeys(): string[] {
  const rows = db
    .select({ k: upTable.sourceKey })
    .from(upTable)
    .where(sql`${upTable.sourceKey} is not null`)
    .all();
  return rows.map((r) => r.k!);
}

/** 新建（手动或程序导入）。 */
export function createMyPrompt(input: MyPromptInput): UserPromptView {
  const row = db
    .insert(upTable)
    .values({
      kind: input.kind,
      category: input.category?.trim() ?? "",
      name: input.name.trim(),
      prompt: input.prompt,
      summary: input.summary?.trim() || null,
      ratio: input.ratio?.trim() || null,
      image: input.image?.trim() || null,
      sourceKey: input.sourceKey ?? null,
    })
    .returning()
    .get();
  return toView(row);
}

/** 从广场导入：拷贝 prompts 行字段写入我的提示词；重复导入直接返回已有的。 */
export function importMyPromptFromPlaza(sourceId: number): {
  item?: UserPromptView;
  already?: boolean;
} {
  const src = db.select().from(promptsTable).where(eq(promptsTable.id, sourceId)).get();
  if (!src) return {};
  const existing = db
    .select()
    .from(upTable)
    .where(eq(upTable.sourceKey, src.key))
    .get();
  if (existing) return { already: true, item: toView(existing) };
  const row = db
    .insert(upTable)
    .values({
      kind: src.kind,
      category: src.category,
      name: src.name,
      prompt: src.prompt,
      summary: src.summary,
      ratio: src.ratio,
      image: src.image,
      sourceKey: src.key,
    })
    .returning()
    .get();
  return { item: toView(row) };
}

/** 更新；条目不存在返回 null。 */
export function updateMyPrompt(id: number, patch: MyPromptPatch): UserPromptView | null {
  const existing = db.select().from(upTable).where(eq(upTable.id, id)).get();
  if (!existing) return null;
  const values: Record<string, unknown> = { updatedAt: Date.now() };
  if (patch.kind !== undefined) values.kind = patch.kind;
  if (patch.category !== undefined) values.category = patch.category.trim() ?? "";
  if (patch.name !== undefined) values.name = patch.name.trim();
  if (patch.prompt !== undefined) values.prompt = patch.prompt;
  if (patch.summary !== undefined) values.summary = patch.summary.trim() || null;
  if (patch.ratio !== undefined) values.ratio = patch.ratio.trim() || null;
  if (patch.image !== undefined) values.image = patch.image.trim() || null;
  const row = db.update(upTable).set(values).where(eq(upTable.id, id)).returning().get();
  return toView(row);
}

/** 删除。 */
export function deleteMyPrompt(id: number): { ok: boolean } {
  db.delete(upTable).where(eq(upTable.id, id)).run();
  return { ok: true };
}
