import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";

import { listMemories } from "./memory";
import type { MemoryEntry } from "../shared/memory";

/**
 * 记忆 ↔ 外部 CLI Agent 的注入通道（应用与 `omi` CLI 共用，不依赖 electrobun）。
 *
 * 注入：把记忆库写入各 Agent 的全局上下文文件（CLAUDE.md / AGENTS.md）的
 * 托管区块（marker 之间），区块外的用户内容不动；重复同步 = 原地替换区块。
 * 写回：区块尾部的指引告诉 Agent 用 `omi memory add "…"`（或启动时自动挂载的
 * omni-memory MCP 工具）把新记忆写回同一个 SQLite 库 —— 全部 Agent 记忆互通。
 *
 * 只选有公开全局上下文文件规范的工具，不猜不确定的路径。
 */

export const MEMORY_BLOCK_START = "<!-- omni-memory:start -->";
export const MEMORY_BLOCK_END = "<!-- omni-memory:end -->";

export interface MemorySyncTarget {
  tool: string;
  name: string;
  /** 相对 home 的上下文文件路径。 */
  file: string;
  /** 相对 home 的安装检测目录（存在 = 已安装，默认勾选）。 */
  detectDir: string;
}

export const MEMORY_SYNC_TARGETS: MemorySyncTarget[] = [
  { tool: "claude", name: "Claude Code", file: ".claude/CLAUDE.md", detectDir: ".claude" },
  { tool: "codex", name: "Codex", file: ".codex/AGENTS.md", detectDir: ".codex" },
  { tool: "opencode", name: "OpenCode", file: ".config/opencode/AGENTS.md", detectDir: ".config/opencode" },
];

export interface MemorySyncStatus {
  tool: string;
  name: string;
  path: string;
  installed: boolean;
  hasBlock: boolean;
  syncedAt: number | null;
}

export interface MemorySyncResult {
  tool: string;
  ok: boolean;
  error?: string;
}

function resolveUnderHome(rel: string, baseDir?: string): string {
  const root = baseDir ?? homedir();
  return rel.startsWith("~/") ? path.join(root, rel.slice(2)) : path.join(root, rel);
}

/** 托管区块内容：记忆列表 + 写回指引。 */
export function buildMemoryBlock(memories: MemoryEntry[]): string {
  const lines = [
    MEMORY_BLOCK_START,
    "## OmniStudio 共享记忆",
    "",
    "以下是用户跨工具共享的长期记忆（由 OmniStudio 记忆页同步，手动修改会被下次同步覆盖）：",
  ];
  if (memories.length === 0) {
    lines.push("（暂无记忆条目）");
  } else {
    for (const m of memories) {
      lines.push(`- [${m.category}] ${m.content}${m.tags.length > 0 ? `（${m.tags.map((t) => `#${t}`).join(" ")}）` : ""}`);
    }
  }
  lines.push(
    "",
    "### 写回新记忆",
    "",
    "在与用户协作中学到值得长期记住的信息（偏好 / 事实 / 经验）时，写回共享记忆库：",
    "",
    "- 已接入 omni-memory MCP 工具时，直接调用 `memory_save`；",
    "- 否则运行 shell 命令：`omi memory add \"一句话记忆\" --category preference`（category 可选 fact/preference/experience/skill/other）。",
    "",
    "写入的内容会同步给用户的所有 Agent（包括 OmniStudio 内置 Agent）。",
    MEMORY_BLOCK_END,
  );
  return lines.join("\n");
}

function replaceBlock(content: string, block: string): string {
  const startIdx = content.indexOf(MEMORY_BLOCK_START);
  const endIdx = content.indexOf(MEMORY_BLOCK_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return content.slice(0, startIdx) + block + content.slice(endIdx + MEMORY_BLOCK_END.length);
  }
  // 没有旧区块：追加到文件末尾（与既有内容空两行分隔）。
  const trimmed = content.replace(/\s+$/, "");
  return `${trimmed}\n\n${block}\n`;
}

function removeBlock(content: string): string {
  const startIdx = content.indexOf(MEMORY_BLOCK_START);
  const endIdx = content.indexOf(MEMORY_BLOCK_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return content;
  return (content.slice(0, startIdx) + content.slice(endIdx + MEMORY_BLOCK_END.length)).replace(/\n{3,}$/, "\n");
}

/** 把当前记忆库同步到目标工具的上下文文件（建文件 / 原地替换托管区块）。 */
export function syncMemoryToTools(tools: string[], baseDir?: string): MemorySyncResult[] {
  const memories = listMemories();
  const block = buildMemoryBlock(memories);
  return tools.map((tool) => {
    const target = MEMORY_SYNC_TARGETS.find((t) => t.tool === tool);
    if (!target) return { tool, ok: false, error: "unsupported target" };
    try {
      const file = resolveUnderHome(target.file, baseDir);
      mkdirSync(path.dirname(file), { recursive: true });
      const prev = existsSync(file) ? readFileSync(file, "utf8") : "";
      writeFileSync(file, replaceBlock(prev, block));
      return { tool, ok: true };
    } catch (e) {
      return { tool, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

/** 移除目标工具上下文文件里的托管区块（不动用户其余内容；区块删空后空文件保留）。 */
export function removeMemoryFromTools(tools: string[], baseDir?: string): MemorySyncResult[] {
  return tools.map((tool) => {
    const target = MEMORY_SYNC_TARGETS.find((t) => t.tool === tool);
    if (!target) return { tool, ok: false, error: "unsupported target" };
    try {
      const file = resolveUnderHome(target.file, baseDir);
      if (!existsSync(file)) return { tool, ok: true };
      const prev = readFileSync(file, "utf8");
      if (!prev.includes(MEMORY_BLOCK_START)) return { tool, ok: true };
      writeFileSync(file, removeBlock(prev));
      return { tool, ok: true };
    } catch (e) {
      return { tool, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

export function memorySyncStatus(baseDir?: string): MemorySyncStatus[] {
  return MEMORY_SYNC_TARGETS.map((target) => {
    const file = resolveUnderHome(target.file, baseDir);
    const installed = existsSync(resolveUnderHome(target.detectDir, baseDir));
    let hasBlock = false;
    let syncedAt: number | null = null;
    try {
      if (existsSync(file)) {
        hasBlock = readFileSync(file, "utf8").includes(MEMORY_BLOCK_START);
        syncedAt = Math.round(statSync(file).mtimeMs) || null;
      }
    } catch {}
    return { tool: target.tool, name: target.name, path: file, installed, hasBlock, syncedAt };
  });
}
