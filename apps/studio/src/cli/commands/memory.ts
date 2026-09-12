import { join } from "path";
import { createInterface } from "node:readline";

import { optString, type ParsedArgs } from "../args";
import { controlRequest } from "../client";
import { resolveDataDir } from "../data-dir";
import { helpFor } from "../help";
import type { MemoryCategory, MemoryEntry } from "../../shared/memory";
import { MEMORY_MCP_TOOLS, MEMORY_MCP_SERVER_INFO, handleMemoryMcpCall } from "../../bun/memory-api";

/**
 * `omi memory` — 记忆的命令行入口，也是外部 Agent 的写回通道。
 *
 * - add/search/list：应用运行时走控制 socket（实时），未运行时直连 SQLite；
 * - mcp：stdio MCP 服务器（omni-memory），供 Claude Code / Codex / OpenCode 等
 *   以 MCP 工具方式读写同一份记忆库；应用在不在都能用（直连库，WAL 并发安全）。
 */

type MemoryModule = typeof import("../../bun/memory");

let memoryMod: MemoryModule | null = null;

/** 独立进程直连主库：必须先设 OMNI_DATA_DIR/OMNI_DB_PATH（见 db/index.ts 约定）。 */
async function loadMemory(): Promise<MemoryModule> {
  if (memoryMod) return memoryMod;
  const dataDir = resolveDataDir();
  process.env.OMNI_DATA_DIR = dataDir;
  process.env.OMNI_DB_PATH = join(dataDir, "omni-studio.db");
  memoryMod = await import("../../bun/memory");
  return memoryMod;
}

function printMemories(memories: MemoryEntry[]) {
  if (memories.length === 0) {
    console.log("（无记忆）");
    return;
  }
  for (const m of memories) {
    const tags = m.tags.length > 0 ? `  ${m.tags.map((t) => `#${t}`).join(" ")}` : "";
    const flags = [m.pinned ? "置顶" : "", m.source === "agent" ? "Agent" : "手动"].filter(Boolean).join(",");
    console.log(`#${m.id} [${m.category}]${flags ? `(${flags})` : ""} ${m.content}${tags}`);
  }
}

export async function cmdMemory(parsed: ParsedArgs): Promise<void> {
  // dispatch 传入的 positionals 不含命令名（memory），第一个就是子命令。
  const sub = parsed.positionals[0];
  switch (sub) {
    case "add":
      return cmdAdd(parsed);
    case "search":
      return cmdSearch(parsed);
    case "list":
      return cmdList();
    case "mcp":
      return runMcpServer();
    case "help":
      // `omi memory help [子命令]`，与 `omi help memory [子命令]` 等价。
      console.log(helpFor(["memory", parsed.positionals[1]]));
      return;
    default:
      if (!sub) {
        console.log(helpFor(["memory"]));
        return;
      }
      console.error(`未知子命令：${sub}\n`);
      console.log(helpFor(["memory"]));
      process.exitCode = 1;
  }
}

async function cmdAdd(parsed: ParsedArgs): Promise<void> {
  const content = parsed.positionals.slice(1).join(" ").trim() || optString(parsed.options, "content") || "";
  if (!content) {
    console.error('缺少内容：omi memory add "一句话记忆"');
    process.exit(1);
  }
  const category = optString(parsed.options, "category") as MemoryCategory | undefined;
  const tags = optString(parsed.options, "tags")?.split(/[,，]/).map((s) => s.trim()).filter(Boolean);

  const res = await controlRequest("memoryAdd", { content, category, tags }, 10_000);
  if (res.connected && res.ok) {
    const memory = (res.data as { memory: MemoryEntry }).memory;
    console.log(`已保存记忆 #${memory.id}（${memory.category}）`);
    return;
  }
  if (res.connected) {
    console.error(res.error ?? "写入失败");
    process.exit(1);
  }
  // 应用未运行：直连库。
  const memory = await loadMemory();
  const saved = memory.saveAgentMemory(content, category, tags);
  console.log(`已保存记忆 #${saved.id}（${saved.category}）`);
}

async function cmdSearch(parsed: ParsedArgs): Promise<void> {
  const query = parsed.positionals.slice(1).join(" ").trim() || optString(parsed.options, "query") || "";
  if (!query) {
    console.error("缺少关键词：omi memory search <关键词>");
    process.exit(1);
  }
  const limit = Number(optString(parsed.options, "limit") ?? 8) || 8;

  const res = await controlRequest("memorySearch", { query, limit }, 10_000);
  if (res.connected && res.ok) {
    printMemories((res.data as { memories: MemoryEntry[] }).memories);
    return;
  }
  const memory = await loadMemory();
  printMemories(memory.searchMemories(query, limit));
}

async function cmdList(): Promise<void> {
  const res = await controlRequest("memoryList", undefined, 10_000);
  if (res.connected && res.ok) {
    printMemories((res.data as { memories: MemoryEntry[] }).memories);
    return;
  }
  const memory = await loadMemory();
  printMemories(memory.listMemories());
}

// ---------------------------------------------------------------------------
// stdio MCP 服务器（omni-memory）：initialize → tools/list → tools/call。
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = "2025-06-18";

async function runMcpServer(): Promise<void> {
  const send = (obj: unknown) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (msg.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: MEMORY_MCP_SERVER_INFO,
        },
      });
    } else if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: MEMORY_MCP_TOOLS } });
    } else if (msg.method === "tools/call") {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments as Record<string, unknown>) ?? {};
      handleMemoryMcpCall(name, args)
        .then(({ text, isError }) =>
          send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }], isError: isError ?? false } }),
        )
        .catch((e) =>
          send({
            jsonrpc: "2.0",
            id: msg.id,
            result: { content: [{ type: "text", text: `error: ${e instanceof Error ? e.message : String(e)}` }], isError: true },
          }),
        );
    } else if (msg.method === "ping") {
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
    // notifications（initialized 等）与未知请求：静默忽略。
  });
  // stdin 关闭即退出（宿主 Agent 结束会话）。
  rl.on("close", () => process.exit(0));
  await new Promise<void>(() => {});
}
