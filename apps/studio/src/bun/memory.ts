import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { Type } from "typebox";
import { db } from "./db";
import { memories, type MemoryRow } from "./db/schema";
import type { BuiltTool } from "./agent-tools";
import { getSetting } from "./db/settings";
import type { MemoryCategory, MemoryEntry } from "../shared/memory";

/**
 * 记忆层（所有 Agent 共享）。
 *
 * 设计参照主流开源记忆框架（Mem0 / Letta / OpenMemory）的分层思路，但完全落在
 * 本地 SQLite 上，零外部依赖：
 * - 检索：关键词（内容 + 标签），置顶优先 —— 不依赖向量库，后续可叠加嵌入；
 * - 写入：Agent 经 memory_save 工具沉淀事实 / 偏好 / 经验，与手工录入同库；
 * - 常驻核心记忆：置顶条目注入 Agent 系统提示（Letta 的 core memory 思路）。
 */

const MAX_PROMPT_MEMORIES = 10;
const MAX_PROMPT_CHARS_PER_MEMORY = 160;

function parseTags(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function rowToEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    content: row.content,
    category: row.category,
    tags: parseTags(row.tags),
    source: row.source,
    pinned: row.pinned === 1,
    usageCount: row.usageCount,
    lastAccessedAt: row.lastAccessedAt ?? null,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

export function memoryEnabled(): boolean {
  return getSetting("MEMORY_ENABLED") !== "0";
}

export function listMemories(opts?: { query?: string; category?: MemoryCategory }): MemoryEntry[] {
  const filters = [];
  if (opts?.category) filters.push(eq(memories.category, opts.category));
  if (opts?.query) {
    const q = `%${opts.query.trim()}%`;
    filters.push(or(like(memories.content, q), like(memories.tags, q)));
  }
  const rows = db
    .select()
    .from(memories)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(memories.pinned), desc(memories.updatedAt))
    .all();
  return rows.map(rowToEntry);
}

export function saveMemory(input: {
  id?: number;
  content: string;
  category?: MemoryCategory;
  tags?: string[];
  pinned?: boolean;
  source?: "manual" | "agent";
}): MemoryEntry {
  const content = input.content.trim();
  const values = {
    content,
    category: input.category ?? "fact",
    tags: JSON.stringify((input.tags ?? []).map((t) => t.trim()).filter(Boolean)),
    pinned: input.pinned ? 1 : 0,
    updatedAt: Date.now(),
  };
  let row: MemoryRow | undefined;
  if (input.id) {
    row = db.update(memories).set(values).where(eq(memories.id, input.id)).returning().get();
  }
  if (!row) {
    row = db
      .insert(memories)
      .values({ ...values, source: input.source ?? "manual" })
      .returning()
      .get();
  }
  return rowToEntry(row!);
}

/** Agent 工具入口：内容已存在时合并（更新分类/标签并累计热度）而不是重复插入。 */
export function saveAgentMemory(content: string, category?: MemoryCategory, tags?: string[]): MemoryEntry {
  const trimmed = content.trim();
  const existing = db.select().from(memories).where(eq(memories.content, trimmed)).get();
  if (existing) {
    return rowToEntry(
      db
        .update(memories)
        .set({
          category: category ?? existing.category,
          tags: tags && tags.length > 0 ? JSON.stringify(tags) : existing.tags,
          usageCount: existing.usageCount + 1,
          updatedAt: Date.now(),
        })
        .where(eq(memories.id, existing.id))
        .returning()
        .get()!,
    );
  }
  return saveMemory({ content: trimmed, category, tags, source: "agent" });
}

export function deleteMemory(id: number) {
  db.delete(memories).where(eq(memories.id, id)).run();
}

export function setMemoryPinned(id: number, pinned: boolean) {
  db.update(memories)
    .set({ pinned: pinned ? 1 : 0, updatedAt: Date.now() })
    .where(eq(memories.id, id))
    .run();
}

/** 关键词检索：内容 + 标签模糊匹配，命中后累计使用次数（记忆热度同步反馈）。 */
export function searchMemories(query: string, limit = 8): MemoryEntry[] {
  const q = query.trim();
  if (!q) return [];
  const likeQ = `%${q}%`;
  const rows = db
    .select()
    .from(memories)
    .where(or(like(memories.content, likeQ), like(memories.tags, likeQ)))
    .orderBy(desc(memories.pinned), desc(memories.usageCount), desc(memories.updatedAt))
    .limit(Math.min(Math.max(limit, 1), 20))
    .all();
  if (rows.length > 0) {
    const ids = sql.join(
      rows.map((r) => sql`${r.id}`),
      sql`, `,
    );
    db.update(memories)
      .set({ usageCount: sql`${memories.usageCount} + 1`, lastAccessedAt: Date.now() })
      .where(sql`${memories.id} in (${ids})`)
      .run();
  }
  return rows.map(rowToEntry);
}

/** 注入 Agent 系统提示的常驻记忆块（置顶优先，条数与长度受限）。 */
export function memoryPromptSection(): string | null {
  if (!memoryEnabled()) return null;
  const rows = db
    .select()
    .from(memories)
    .orderBy(desc(memories.pinned), desc(memories.usageCount), desc(memories.updatedAt))
    .limit(MAX_PROMPT_MEMORIES)
    .all();
  if (rows.length === 0) return null;
  const lines = rows.map((r) => {
    const clip =
      r.content.length > MAX_PROMPT_CHARS_PER_MEMORY
        ? `${r.content.slice(0, MAX_PROMPT_CHARS_PER_MEMORY)}…`
        : r.content;
    return `- [${r.category}${r.pinned ? "/置顶" : ""}] ${clip}`;
  });
  return [
    "## 用户记忆（长期，跨会话共享）",
    "以下是关于用户与过往任务的持久记忆，回答时直接结合使用；",
    "需要更多背景时用 memory_search 检索，学到稳定的新事实/偏好时用 memory_save 记录。",
    ...lines,
  ].join("\n");
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], details: { error: message } };
}

/**
 * 记忆工具集：任何模型跑 Agent 时都拿到同一对工具，读写同一个库，
 * 换模型 / 多会话之间记忆天然同步。
 */
export function buildMemoryAgentTools(): BuiltTool[] {
  const search: BuiltTool = {
    name: "memory_search",
    label: "Memory search",
    description:
      "Search the user's long-term memory (facts, preferences, past decisions) by keyword. Use it when personal context or earlier task history could inform the answer.",
    parameters: Type.Object({
      query: Type.String({ description: "Keywords to look up, e.g. '部署' / 'editor'." }),
      limit: Type.Optional(Type.Number({ description: "Max entries to return (1-20, default 8)." })),
    }),
    execute: async (_toolCallId, params: { query: string; limit?: number }) => {
      try {
        const hits = searchMemories(params.query, params.limit ?? 8);
        if (hits.length === 0) return textResult("No matching memories.");
        const formatted = hits
          .map((m, i) => `[${i + 1}] (${m.category}${m.pinned ? ", pinned" : ""}) ${m.content}`)
          .join("\n");
        return textResult(formatted);
      } catch (e) {
        return errorResult(`memory_search failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };

  const save: BuiltTool = {
    name: "memory_save",
    label: "Memory save",
    description:
      "Persist a durable fact, preference or lesson to the user's shared long-term memory. Only save stable, reusable knowledge — not transient task details. Duplicate content is merged, not duplicated.",
    parameters: Type.Object({
      content: Type.String({ description: "The memory to store, one concise sentence." }),
      category: Type.Optional(
        Type.Union(
          [
            Type.Literal("fact"),
            Type.Literal("preference"),
            Type.Literal("experience"),
            Type.Literal("skill"),
            Type.Literal("other"),
          ],
          { description: "fact | preference | experience | skill | other" },
        ),
      ),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Short lookup tags." })),
    }),
    execute: async (_toolCallId, params: { content: string; category?: MemoryCategory; tags?: string[] }) => {
      try {
        if (!params.content?.trim()) return errorResult("memory_save: content is required");
        const saved = saveAgentMemory(params.content, params.category, params.tags);
        return textResult(`Saved memory #${saved.id} (${saved.category}).`);
      } catch (e) {
        return errorResult(`memory_save failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };

  return [search, save];
}
