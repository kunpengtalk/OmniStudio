import { join } from "path";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";

import { optString, type ParsedArgs } from "../args";
import { controlRequest } from "../client";
import { resolveDataDir } from "../data-dir";
import { helpFor } from "../help";
import type { MemoryCategory, MemoryEntry, MemoryStats } from "../../shared/memory";
import { MEMORY_MCP_TOOLS, MEMORY_MCP_SERVER_INFO, handleMemoryMcpCall } from "../../bun/memory-api";

/**
 * `omi memory` — 记忆的命令行入口，也是外部 Agent 的写回通道。
 *
 * - add/search/list/stats/forget/export/import：应用运行时走控制 socket（实时），
 *   未运行时直连 SQLite；
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
    const flags = [
      m.pinned ? "置顶" : "",
      m.source === "agent" ? "Agent" : "手动",
      m.scope ? "项目" : "",
      m.status !== "active" ? m.status : "",
    ]
      .filter(Boolean)
      .join(",");
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
      return cmdList(parsed);
    case "stats":
      return cmdStats();
    case "maintain":
    case "tidy":
      return cmdMaintain();
    case "forget":
    case "rm":
      return cmdForget(parsed);
    case "export":
      return cmdExport(parsed);
    case "import":
      return cmdImport(parsed);
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

  const res = await controlRequest("memoryAdd", { content, category, tags, sourceRef: "cli" }, 10_000);
  if (res.connected && res.ok) {
    const data = res.data as { memory: MemoryEntry; action: string };
    console.log(actionLine(data.memory, data.action));
    return;
  }
  if (res.connected) {
    console.error(res.error ?? "写入失败");
    process.exit(1);
  }
  // 应用未运行：直连库。
  const memory = await loadMemory();
  const outcome = await memory.saveAgentMemory({ content, category, tags, sourceRef: "cli" });
  if (!outcome.ok) {
    console.error(outcome.error);
    process.exit(1);
  }
  console.log(actionLine(outcome.result.memory, outcome.result.action));
}

function actionLine(memory: MemoryEntry, action: string): string {
  if (action === "merged") return `已合并到既有记忆 #${memory.id}（${memory.category}）`;
  if (action === "pending") return `已保存记忆 #${memory.id}（待确认，请在应用「记忆」页批准）`;
  return `已保存记忆 #${memory.id}（${memory.category}）`;
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
  printMemories(await memory.searchMemories(query, { limit, scope: "all" }));
}

async function cmdList(parsed: ParsedArgs): Promise<void> {
  const status = (optString(parsed.options, "status") ?? "open") as "open" | "active" | "pending" | "archived" | "all";
  const limit = Number(optString(parsed.options, "limit") ?? 0) || undefined;
  const res = await controlRequest("memoryList", { status }, 10_000);
  if (res.connected && res.ok) {
    printMemories((res.data as { memories: MemoryEntry[] }).memories);
    return;
  }
  const memory = await loadMemory();
  printMemories(memory.listMemories({ status, scope: "all", limit }));
}

async function cmdMaintain(): Promise<void> {
  const res = await controlRequest("memoryMaintain", undefined, 120_000);
  const result =
    res.connected && res.ok
      ? (res.data as { hashed: number; expired: number; archived: number; consolidated: number; embedded: number })
      : await (await loadMemory()).runMemoryMaintenance();
  console.log(
    `整理完成：合并重复 ${result.consolidated} 条，归档 ${result.archived + result.expired} 条，` +
      `补哈希 ${result.hashed} 条，向量化 ${result.embedded} 条`,
  );
}

async function cmdStats(): Promise<void> {
  const res = await controlRequest("memoryStats", undefined, 10_000);
  if (res.connected && res.ok) {
    printStats(res.data as unknown as MemoryStats);
    return;
  }
  const memory = await loadMemory();
  printStats(memory.memoryStats());
}

function printStats(s: MemoryStats): void {
  console.log(`记忆总数：${s.total}（可用 ${s.active} / 待确认 ${s.pending} / 归档 ${s.archived} / 已取代 ${s.superseded}）`);
  console.log(`置顶 ${s.pinned} · 项目记忆 ${s.scoped} · Agent 写入 ${s.agentWritten} · 近 7 天更新 ${s.updatedLast7d}`);
  const cats = Object.entries(s.byCategory)
    .filter(([, n]) => n > 0)
    .map(([c, n]) => `${c} ${n}`)
    .join(" · ");
  console.log(`分类：${cats || "（空）"}`);
  console.log(`正文总量：${s.chars} 字符（约 ${Math.round(s.chars / 2)} tokens，按需注入，不整库进上下文）`);
  const rate = s.searches > 0 ? Math.round((s.hitSearches / s.searches) * 100) : 0;
  console.log(`检索 ${s.searches} 次，其中 ${s.hitSearches} 次命中（${rate}%）· 合并 ${s.merges} 次 · 拦截敏感内容 ${s.blocked} 次`);
  console.log(`向量：${s.embeddingModel ? `${s.embeddingModel}（已向量化 ${s.embedded}/${s.total}）` : "未配置（纯关键词检索）"}`);
}

async function cmdForget(parsed: ParsedArgs): Promise<void> {
  const raw = parsed.positionals[1] ?? optString(parsed.options, "id") ?? "";
  const id = Number(raw);
  if (!Number.isFinite(id) || id <= 0) {
    console.error("缺少记忆编号：omi memory forget <id>（编号见 omi memory list / search）");
    process.exit(1);
  }
  const res = await controlRequest("memoryForget", { id }, 10_000);
  if (res.connected && res.ok) {
    console.log((res.data as { deleted: boolean }).deleted ? `已删除记忆 #${id}` : `没有找到记忆 #${id}`);
    return;
  }
  const memory = await loadMemory();
  console.log(memory.deleteMemory(id) ? `已删除记忆 #${id}` : `没有找到记忆 #${id}`);
}

async function cmdExport(parsed: ParsedArgs): Promise<void> {
  const out = optString(parsed.options, "out");
  const res = await controlRequest("memoryExport", undefined, 15_000);
  const payload = res.connected && res.ok
    ? JSON.stringify(res.data, null, 2)
    : JSON.stringify((await loadMemory()).exportMemories(), null, 2);
  if (out) {
    writeFileSync(out, `${payload}\n`);
    console.log(`已导出到 ${out}`);
  } else {
    console.log(payload);
  }
}

async function cmdImport(parsed: ParsedArgs): Promise<void> {
  const file = parsed.positionals[1] ?? optString(parsed.options, "file");
  if (!file) {
    console.error("缺少文件：omi memory import <file.json>");
    process.exit(1);
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`读取失败：${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
    return;
  }
  const res = await controlRequest("memoryImport", { payload: parsedJson }, 60_000);
  const result =
    res.connected && res.ok
      ? (res.data as { imported: number; merged: number; rejected: number })
      : await (await loadMemory()).importMemories(parsedJson);
  console.log(`导入完成：新增 ${result.imported} 条，合并 ${result.merged} 条，拒绝 ${result.rejected} 条`);
}

// ---------------------------------------------------------------------------
// stdio MCP 服务器（omni-memory）：initialize → tools/list → tools/call。
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = "2025-06-18";

async function runMcpServer(): Promise<void> {
  const send = (obj: unknown) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  const rl = createInterface({ input: process.stdin });

  // 请求串行处理：读写都是异步的（判重可能要调嵌入服务），并发处理会让
  // 「先 save 再 search」的客户端拿到过期结果。逐条排队，保持会话内顺序语义。
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void>) => {
    queue = queue.then(task).catch(() => {});
  };

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    enqueue(() => handleMessage(msg, send));
  });
  // stdin 关闭即退出（宿主 Agent 结束会话）：等队列跑完再退，避免丢最后一条写入。
  rl.on("close", () => {
    void queue.finally(() => process.exit(0));
  });
  await new Promise<void>(() => {});
}

async function handleMessage(
  msg: { id?: unknown; method?: string; params?: Record<string, unknown> },
  send: (obj: unknown) => void,
): Promise<void> {
  {
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
      try {
        const { text, isError } = await handleMemoryMcpCall(name, args);
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }], isError: isError ?? false } });
      } catch (e) {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text: `error: ${e instanceof Error ? e.message : String(e)}` }], isError: true },
        });
      }
    } else if (msg.method === "ping") {
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
    // notifications（initialized 等）与未知请求：静默忽略。
  }
}
