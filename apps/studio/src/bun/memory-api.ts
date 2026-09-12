import * as Memory from "./memory";
import type { MemoryCategory, MemoryEntry } from "../shared/memory";

/**
 * 记忆对外服务层：MCP 工具定义 + 调用分发。
 * 两个宿主共用同一份定义，保证行为一致：
 * - 网关的 Streamable HTTP 端点（POST /mcp，任何 MCP 客户端可直连）；
 * - `omi memory mcp` stdio 桥接（launch 自动挂给 Claude Code / Codex / OpenCode）。
 */

export const MEMORY_MCP_SERVER_INFO = { name: "omni-memory", version: "1.0.0" };

export const MEMORY_MCP_TOOLS = [
  {
    name: "memory_search",
    description:
      "Search the user's shared long-term memory (facts, preferences, past decisions) by keyword. Shared across OmniStudio and all connected CLI agents.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords to look up." },
        limit: { type: "number", description: "Max entries (1-20, default 8)." },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_save",
    description:
      "Persist a durable fact, preference or lesson to the user's shared long-term memory. Only save stable, reusable knowledge — not transient task details. Duplicate content is merged.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The memory, one concise sentence." },
        category: {
          type: "string",
          enum: ["fact", "preference", "experience", "skill", "other"],
          description: "Memory category (default fact).",
        },
        tags: { type: "array", items: { type: "string" }, description: "Short lookup tags." },
      },
      required: ["content"],
    },
  },
  {
    name: "memory_list",
    description: "List all memories in the user's shared long-term memory store.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

export function formatMemoryEntry(m: MemoryEntry): string {
  const tags = m.tags.length > 0 ? `（${m.tags.map((t) => `#${t}`).join(" ")}）` : "";
  return `[${m.category}${m.pinned ? "/置顶" : ""}] ${m.content}${tags}`;
}

export function isMemoryMcpTool(name: string): boolean {
  return MEMORY_MCP_TOOLS.some((t) => t.name === name);
}

export async function handleMemoryMcpCall(
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean }> {
  if (name === "memory_search") {
    const hits = Memory.searchMemories(String(args.query ?? ""), Number(args.limit ?? 8) || 8);
    return { text: hits.length > 0 ? hits.map(formatMemoryEntry).join("\n") : "No matching memories." };
  }
  if (name === "memory_save") {
    const content = String(args.content ?? "").trim();
    if (!content) return { text: "memory_save: content is required", isError: true };
    const saved = Memory.saveAgentMemory(
      content,
      args.category as MemoryCategory | undefined,
      Array.isArray(args.tags) ? args.tags.map(String) : undefined,
    );
    return { text: `Saved memory #${saved.id} (${saved.category}).` };
  }
  if (name === "memory_list") {
    const all = Memory.listMemories();
    return { text: all.length > 0 ? all.map(formatMemoryEntry).join("\n") : "No memories yet." };
  }
  return { text: `Unknown tool: ${name}`, isError: true };
}
