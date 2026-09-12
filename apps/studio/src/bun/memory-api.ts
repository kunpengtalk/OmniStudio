import * as Memory from "./memory";
import type { MemoryCategory, MemoryEntry } from "../shared/memory";

/**
 * 记忆对外服务层：MCP 工具定义 + 调用分发。
 * 两个宿主共用同一份定义，保证行为一致：
 * - 网关的 Streamable HTTP 端点（POST /mcp，任何 MCP 客户端可直连）；
 * - `omi memory mcp` stdio 桥接（launch 自动挂给 Claude Code / Codex / OpenCode）。
 */

export const MEMORY_MCP_SERVER_INFO = { name: "omni-memory", version: "2.0.0" };

export const MEMORY_MCP_TOOLS = [
  {
    name: "memory_search",
    description:
      "Search the user's shared long-term memory (facts, preferences, past decisions, lessons), ranked by relevance, importance and freshness. " +
      "Shared across OmniStudio and all connected CLI agents.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords or a short question." },
        limit: { type: "number", description: "Max entries (1-20, default 8)." },
        category: {
          type: "string",
          enum: ["fact", "preference", "experience", "skill", "other"],
          description: "Restrict to one category.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_save",
    description:
      "Persist a durable fact, preference, decision or lesson to the user's shared long-term memory. " +
      "Save only stable, reusable knowledge — not transient task details, not secrets or credentials. " +
      "Near-duplicate content is merged automatically; pass supersedes with ids from memory_search when this replaces outdated memories.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The memory, one concise self-contained sentence." },
        category: {
          type: "string",
          enum: ["fact", "preference", "experience", "skill", "other"],
          description: "Memory category (default fact).",
        },
        tags: { type: "array", items: { type: "string" }, description: "Short lookup tags." },
        scope: {
          type: "string",
          enum: ["project", "global"],
          description:
            "project = only the current workspace (default for facts/experiences), global = every workspace (default for preferences/skills).",
        },
        supersedes: {
          type: "array",
          items: { type: "number" },
          description: "Ids of memories this one replaces (marked superseded).",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "memory_forget",
    description:
      "Delete a memory that is wrong, outdated, or that the user asked to forget. Pass the id from memory_search, or a query to match the best hit.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Memory id to delete." },
        query: { type: "string", description: "If no id: delete the best match for this query." },
        reason: { type: "string", description: "Why it should be forgotten (kept in the audit log)." },
      },
    },
  },
  {
    name: "memory_list",
    description: "List the user's shared long-term memory store (most important first).",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["open", "active", "pending", "archived", "superseded", "all"],
          description: "Filter by lifecycle status (default open = everything not superseded).",
        },
        limit: { type: "number", description: "Max entries (default 100, max 500)." },
      },
    },
  },
] as const;

export function formatMemoryEntry(m: MemoryEntry): string {
  const tags = m.tags.length > 0 ? `（${m.tags.map((t) => `#${t}`).join(" ")}）` : "";
  const flags = [m.category, m.pinned ? "置顶" : "", m.scope ? "项目" : "", m.status !== "active" ? m.status : ""]
    .filter(Boolean)
    .join("/");
  return `#${m.id} [${flags}] ${m.content}${tags}`;
}

export function isMemoryMcpTool(name: string): boolean {
  return MEMORY_MCP_TOOLS.some((t) => t.name === name);
}

/** 外部 MCP 调用统一记 sourceRef=mcp，审计里能看出是谁写的。 */
const MCP_SOURCE_REF = "mcp";

/**
 * 外部 Agent 写入的作用域归属：
 * - 偏好 / 技能是「关于用户」的 → 全局（换项目也成立）；
 * - 其余（事实 / 经验 / 其他）→ 跟随 `omi launch` 传进来的工作目录（OMNI_MEMORY_SCOPE），
 *   没传就落全局。模型可用 scope 参数显式覆盖。
 */
function resolveMcpScope(category: MemoryCategory | undefined, requested?: "project" | "global"): string | null {
  const workspace = process.env.OMNI_MEMORY_SCOPE?.trim() || null;
  if (requested === "global") return null;
  if (requested === "project") return workspace;
  if (category === "preference" || category === "skill") return null;
  return workspace;
}

export async function handleMemoryMcpCall(
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean }> {
  if (name === "memory_search") {
    const category = typeof args.category === "string" ? (args.category as MemoryCategory) : undefined;
    const hits = await Memory.searchMemories(String(args.query ?? ""), {
      limit: Number(args.limit ?? 8) || 8,
      category,
    });
    if (hits.length === 0) return { text: "No matching memories." };
    return {
      text: hits
        .map((h) => `${formatMemoryEntry(h)}（相关度 ${h.relevance}，重要度 ${h.importanceScore}）`)
        .join("\n"),
    };
  }

  if (name === "memory_save") {
    const category = args.category as MemoryCategory | undefined;
    const scopeArg = args.scope === "project" || args.scope === "global" ? args.scope : undefined;
    const outcome = await Memory.saveAgentMemory({
      content: String(args.content ?? ""),
      category,
      tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
      scope: resolveMcpScope(category, scopeArg),
      supersedes: Array.isArray(args.supersedes) ? args.supersedes.map(Number).filter(Number.isFinite) : undefined,
      sourceRef: MCP_SOURCE_REF,
    });
    if (!outcome.ok) return { text: `memory_save rejected: ${outcome.error}`, isError: true };
    const { memory, action, mergedWith, superseded } = outcome.result;
    if (action === "merged") return { text: `Merged into existing memory #${mergedWith}.` };
    if (action === "pending") return { text: `Saved memory #${memory.id} as pending user confirmation.` };
    const replaced = superseded?.length ? ` Superseded: ${superseded.map((id) => `#${id}`).join(", ")}.` : "";
    return { text: `Saved memory #${memory.id} (${memory.category}).${replaced}` };
  }

  if (name === "memory_forget") {
    const id = Number(args.id ?? 0) || 0;
    let target: MemoryEntry | null = null;
    if (id > 0) {
      target = Memory.listMemories({ status: "all" }).find((m) => m.id === id) ?? null;
    } else if (String(args.query ?? "").trim()) {
      const hits = await Memory.searchMemories(String(args.query), { limit: 1, includeArchived: true, trackUsage: false });
      target = hits[0] ?? null;
    }
    if (!target) return { text: "memory_forget: 没找到匹配的记忆（需要 id 或更精确的 query）", isError: true };
    Memory.deleteMemory(target.id);
    return { text: `Forgotten #${target.id}: ${target.content.slice(0, 80)}` };
  }

  if (name === "memory_list") {
    const status = (typeof args.status === "string" ? args.status : "open") as
      | "open"
      | "active"
      | "pending"
      | "archived"
      | "superseded"
      | "all";
    const limit = Math.min(Math.max(Number(args.limit ?? 100) || 100, 1), 500);
    const all = Memory.listMemories({ status, limit, scope: "all" });
    return { text: all.length > 0 ? all.map(formatMemoryEntry).join("\n") : "No memories yet." };
  }

  return { text: `Unknown tool: ${name}`, isError: true };
}
