import { eq, sql, and, asc, desc } from "drizzle-orm";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { db } from "./db";
import { prompts as promptsTable, promptCategories as catsTable } from "./db/schema";
import { PROMPT_PAGE_SIZE } from "../shared/prompts";
import { containsLikePattern } from "../shared/sql-like";
import { logEvent } from "./app-log";
import type { PromptKind } from "./db/schema";

export type { PromptKind } from "./db/schema";

// ---------------------------------------------------------------------------
// 提示词库媒体 URL 解析
// ---------------------------------------------------------------------------
//
// 我的提示词 / 广场条目的 image 字段：绝对地址直接透传。历史遗留的
// `/prompt-library/...` 相对路径（旧内置题库的素材引用）不再解析——第三方
// 热链/下载管线已随题库清空一并拆除，返回 null 走界面占位图。

/**
 * 界面上加载用的媒体地址：绝对地址原样返回，其余返回 null。
 */
export function mediaUrl(raw: string | null): string | null {
  if (!raw || raw.startsWith("/prompt-library/")) return null;
  return raw;
}

// ---------------------------------------------------------------------------
// 种子数据：首次启动时把随包 JSON 灌入本地 SQLite（幂等）。
// 内置的第三方聚合题库已于 2026-10-03 法律风险排查中清空；空壳保留灌库管线，
// 将来接**已确认许可**的服务端题库时直接填回 seed 目录。测试经 seedDir 注入 fixture。
// ---------------------------------------------------------------------------

const SEED_FILES: { kind: PromptKind; file: string }[] = [
  { kind: "image", file: "image-prompts.json" },
  { kind: "video", file: "video-prompts.json" },
  { kind: "llm", file: "llm-prompts.json" },
];

/** 数据库里 prompt 数量；供前端展示。 */
export function countPromptsByKind(): Record<PromptKind, number> {
  const rows = db
    .select({ kind: promptsTable.kind, n: sql<number>`count(*)` })
    .from(promptsTable)
    .groupBy(promptsTable.kind)
    .all();
  const out: Record<PromptKind, number> = { image: 0, llm: 0, video: 0 };
  for (const r of rows) out[r.kind as PromptKind] = r.n;
  return out;
}

/**
 * 增量灌入：每次启动按 key / 分类去重，只插入库里还没有的条目（幂等）。
 * 这样已有数据的安装也能补齐随版本新增的提示词，且不触碰既有记录。
 */
export function seedIfNeeded(seedDir: string = join(import.meta.dir, "prompt-library/seed")): void {
  for (const { kind, file } of SEED_FILES) {
    const path = join(seedDir, file);
    if (!existsSync(path)) continue;
    try {
      const data = JSON.parse(readFileSync(path, "utf8")) as {
        categories?: { name: string; intro?: string }[];
        items?: Record<string, unknown>[];
      };

      const items = data.items ?? [];
      if (items.length === 0) continue;

      const existingKeys = new Set(
        db
          .select({ key: promptsTable.key })
          .from(promptsTable)
          .where(eq(promptsTable.kind, kind))
          .all()
          .map((r) => r.key),
      );
      const toInsert = items.filter((it) => !existingKeys.has(String(it.id)));
      if (toInsert.length === 0) continue;

      // 分类：表里没有的才补，sort 接在现有分类后面
      const existingCats = new Set(
        db
          .select({ name: catsTable.name })
          .from(catsTable)
          .where(eq(catsTable.kind, kind))
          .all()
          .map((c) => c.name),
      );
      const maxSort =
        db
          .select({ m: sql<number>`coalesce(max(${catsTable.sort}), -1)` })
          .from(catsTable)
          .where(eq(catsTable.kind, kind))
          .get()?.m ?? -1;
      let catIdx = 0;
      for (const c of data.categories ?? []) {
        if (existingCats.has(c.name)) continue;
        db.insert(catsTable)
          .values({ kind, name: c.name, intro: c.intro ?? "", sort: maxSort + 1 + catIdx })
          .run();
        existingCats.add(c.name);
        catIdx++;
      }

      db.transaction((tx) => {
        for (const it of toInsert) {
          tx.insert(promptsTable)
            .values({
              key: String(it.id),
              kind,
              category: String(it.category ?? ""),
              subcategory: it.subcategory ? String(it.subcategory) : null,
              name: String(it.name ?? ""),
              prompt: String(it.prompt ?? ""),
              summary: it.summary ? String(it.summary) : null,
              ratio: it.ratio ? String(it.ratio) : null,
              image: it.image ? String(it.image) : null,
              video: it.video ? String(it.video) : null,
              mode: it.mode ? String(it.mode) : null,
              duration: it.duration ? Number(it.duration) : null,
              playUrl: it.playUrl ? String(it.playUrl) : null,
              playLabel: it.playLabel ? String(it.playLabel) : null,
              source: it.source ? String(it.source) : null,
              sourceUrl: it.sourceUrl ? String(it.sourceUrl) : null,
              sourceLabel: it.sourceLabel ? String(it.sourceLabel) : null,
              featured: Number(it.featured) || 0,
            })
            .onConflictDoNothing()
            .run();
        }
      });
      console.log(`[prompt-library] seeded ${kind}: +${toInsert.length} prompts`);
    } catch (e) {
      // 灌种子失败 = 广场永远是空的，而这条路径此前只有 console.warn（打包后没人接）。
      logEvent({
        level: "error",
        source: "app",
        event: "prompt.seed.failed",
        message: e instanceof Error ? e.message : String(e),
        detail: { kind, error: e },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

export type PromptCategoryRow = {
  name: string;
  intro: string | null;
  count: number;
};

export type PromptRow = {
  id: number;
  key: string;
  kind: PromptKind;
  category: string;
  subcategory: string | null;
  name: string;
  prompt: string;
  summary: string | null;
  ratio: string | null;
  image: string | null;
  video: string | null;
  playUrl: string | null;
  playLabel: string | null;
  source: string | null;
  sourceUrl: string | null;
  sourceLabel: string | null;
  featured: number;
  /** 从广场导入时对应的 prompts.key（仅我的提示词有值）。 */
  sourceKey?: string | null;
  /** 视频提示词的生成方式（文生视频 / 首尾帧 / 图生视频 …）。 */
  mode: string | null;
  /** 视频提示词的参考时长（秒）。 */
  duration: number | null;
};

export type PromptListParams = {
  kind: PromptKind;
  category?: string;
  search?: string;
  source?: string;
  limit?: number;
  offset?: number;
};

/** 默认分页大小：与前端共用同一个常量（见 shared/prompts.ts）。 */
const PAGE_SIZE = PROMPT_PAGE_SIZE;

/** 某类型下的分类列表（含条数）。 */
export function listCategories(kind: PromptKind): PromptCategoryRow[] {
  const cats = db.select().from(catsTable).where(eq(catsTable.kind, kind)).all();
  const counts = db
    .select({ category: promptsTable.category, n: sql<number>`count(*)` })
    .from(promptsTable)
    .where(eq(promptsTable.kind, kind))
    .groupBy(promptsTable.category)
    .all();
  const countMap = new Map(counts.map((c) => [c.category, c.n]));
  return cats.map((c) => ({
    name: c.name,
    intro: c.intro,
    count: countMap.get(c.name) ?? 0,
  }));
}

/** 分页列出提示词（按分类/来源/关键词过滤）。 */
export function listPrompts(params: PromptListParams): { items: PromptRow[]; total: number } {
  const { kind, category, source, search } = params;
  const limit = Math.min(params.limit ?? PAGE_SIZE, 200);
  const offset = params.offset ?? 0;

  const conds = [eq(promptsTable.kind, kind)];
  if (category) conds.push(eq(promptsTable.category, category));
  if (source) conds.push(eq(promptsTable.source, source));
  if (search?.trim()) {
    // 转义 + ESCAPE：搜「100%」不再命中全库（见 shared/sql-like.ts）。
    const kw = containsLikePattern(search.trim());
    conds.push(
      sql`(${promptsTable.name} like ${kw} escape '\\' or ${promptsTable.subcategory} like ${kw} escape '\\' or ${promptsTable.summary} like ${kw} escape '\\' or ${promptsTable.prompt} like ${kw} escape '\\')`,
    );
  }

  const where = and(...conds);
  const items = db
    .select()
    .from(promptsTable)
    .where(where)
    .orderBy(desc(promptsTable.featured), asc(promptsTable.name))
    .limit(limit)
    .offset(offset)
    .all()
    .map(toRow);

  const totalRow = db
    .select({ n: sql<number>`count(*)` })
    .from(promptsTable)
    .where(where)
    .get();
  return { items, total: totalRow?.n ?? 0 };
}

function toRow(r: (typeof promptsTable.$inferSelect)): PromptRow {
  return {
    id: r.id,
    key: r.key,
    kind: r.kind,
    category: r.category,
    subcategory: r.subcategory,
    name: r.name,
    prompt: r.prompt,
    summary: r.summary,
    ratio: r.ratio,
    image: mediaUrl(r.image),
    video: mediaUrl(r.video),
    mode: r.mode,
    duration: r.duration,
    playUrl: r.playUrl,
    playLabel: r.playLabel,
    source: r.source,
    sourceUrl: r.sourceUrl,
    sourceLabel: r.sourceLabel,
    featured: r.featured,
  };
}

