/**
 * Agent 读笔记的三个只读工具：`note_list` / `note_search` / `note_read`。
 *
 * 为什么必须有它们：笔记会沉淀成记忆，但**记忆只有 500 字的索引级摘要**——
 * 模型能"想起"用户写过一篇日记，却读不到正文。没有这三个工具时，用户问
 * 「看看我的日记」，Agent 只能去 grep 工作区、翻知识库，最后回一句
 * "这只是历史记忆里的内容，无法确认是否仍保存为独立文件" —— 有能力却调不到，
 * 是最让人恼火的一类回答。
 *
 * 三条设计约定：
 *   - **只读**：不提供写入 / 删除。写笔记是用户在笔记页做的事；Agent 要落东西有
 *     `write_file` 与产出物（写数据目录而不是替用户"记日记"）。
 *   - **和记忆同一把开关**（`NOTES_AGENT_ACCESS`）：笔记对 Agent 可见就同时意味着
 *     "能沉淀记忆"与"能读正文"，用户不必理解两个开关的区别；关掉后三个工具直接不出现。
 *   - **结果要克制**：列表默认 8 条、正文按工具的通用上限截断（`capToolResultText`），
 *     不然一篇 2 万字的日记能一口气吃光上下文预算。
 */
import { Type } from "typebox";

import { getNote, searchNotes, type Note } from "./notes";
import { noteAgentAccessEnabled } from "./memory";
import { textResult, errorResult, type BuiltTool } from "./agent-tools";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
/** 列表里每条摘要的长度：够模型判断"是不是这条"，又不至于把整个正文倒进去。 */
const EXCERPT_CHARS = 140;
/** `note_read` 单次返回的正文上限（正文本身的上限是 20000）。 */
const READ_CHARS = 12_000;

function excerpt(body: string, chars = EXCERPT_CHARS): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > chars ? `${flat.slice(0, chars)}…` : flat;
}

/** 一行标题：`#12 2026-09-15 《天气》 #日记 #生活`。 */
function titleLine(note: Note): string {
  const tags = note.tags.length > 0 ? `  ${note.tags.map((tag) => `#${tag}`).join(" ")}` : "";
  return `#${note.id} ${note.day} 《${note.title || "(untitled)"}》${tags}`;
}

function listText(notes: Note[]): string {
  const lines: string[] = [];
  for (const note of notes) {
    lines.push(titleLine(note));
    const summary = excerpt(note.body);
    if (summary) lines.push(`    ${summary}`);
  }
  lines.push("");
  lines.push(`Use note_read with an id (e.g. note_read {id: ${notes[0]!.id}}) to read a note in full.`);
  return lines.join("\n");
}

function buildNoteList(): BuiltTool {
  return {
    name: "note_list",
    label: "List notes",
    description:
      "List the user's notes from OmniStudio's Notes app (日记 / 随手记) — id, date, title, tags and a short " +
      "excerpt, most recently updated first. Use it when the user asks about their notes or diary in general " +
      '("看看我的日记", "我最近记了什么", "what did I write down"), instead of asking them to paste the text.',
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: `Max notes (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` })),
    }),
    execute: async (_toolCallId, params: { limit?: number }) => {
      try {
        if (!noteAgentAccessEnabled()) return textResult("Notes are not shared with agents (disabled in the Notes app settings).");
        const limit = Math.max(1, Math.min(Number(params.limit) || DEFAULT_LIMIT, MAX_LIMIT));
        const notes = searchNotes("", limit);
        if (notes.length === 0) return textResult("The user has no notes yet.");
        return textResult(listText(notes));
      } catch (e) {
        return errorResult(`note_list failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

function buildNoteSearch(): BuiltTool {
  return {
    name: "note_search",
    label: "Search notes",
    description:
      "Search the user's notes (title, body and tags) by keyword. Use it when the user refers to something they " +
      'wrote before ("我上次记的那条", "笔记里关于部署的"), and when a memory entry begins with 笔记《…》 — ' +
      "then use the id from the results with note_read to get the full text.",
    parameters: Type.Object({
      query: Type.String({ description: "Keywords to look for, e.g. '爬山' / 'deployment'." }),
      limit: Type.Optional(Type.Number({ description: `Max notes (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` })),
    }),
    execute: async (_toolCallId, params: { query: string; limit?: number }) => {
      try {
        if (!noteAgentAccessEnabled()) return textResult("Notes are not shared with agents (disabled in the Notes app settings).");
        const query = String(params.query ?? "").trim();
        if (!query) return errorResult("note_search needs a query; use note_list to see recent notes.");
        const limit = Math.max(1, Math.min(Number(params.limit) || DEFAULT_LIMIT, MAX_LIMIT));
        const notes = searchNotes(query, limit);
        if (notes.length === 0) {
          return textResult(`No note matches “${query}”. Try fewer keywords, or note_list to see what exists.`);
        }
        return textResult(`${notes.length} matching note(s):\n\n${listText(notes)}`);
      } catch (e) {
        return errorResult(`note_search failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

function buildNoteRead(): BuiltTool {
  return {
    name: "note_read",
    label: "Read a note",
    description:
      "Read one note in full (Markdown) by id. Ids come from note_list / note_search, and a memory entry " +
      "mentioning `note_read #<id>` points at one too. The text is the user's own writing — treat it as their " +
      "words, do not rewrite it unless asked.",
    parameters: Type.Object({
      id: Type.Number({ description: "Note id, e.g. 12." }),
    }),
    execute: async (_toolCallId, params: { id: number }) => {
      try {
        if (!noteAgentAccessEnabled()) return textResult("Notes are not shared with agents (disabled in the Notes app settings).");
        const note = getNote(Number(params.id));
        if (!note) return errorResult(`No note #${params.id}. Use note_search or note_list to find the right id.`);
        const head = [titleLine(note), note.images.length > 0 ? `(${note.images.length} image(s) attached)` : ""]
          .filter(Boolean)
          .join("\n");
        const body = note.body.length > READ_CHARS ? `${note.body.slice(0, READ_CHARS)}\n…[truncated]` : note.body;
        return textResult(`${head}\n\n${body || "(empty body)"}`);
      } catch (e) {
        return errorResult(`note_read failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

/** 三件套一起给：模型先 list / search 找到 id，再 read 读全文。 */
export function buildNotesAgentTools(): BuiltTool[] {
  if (!noteAgentAccessEnabled()) return [];
  return [buildNoteList(), buildNoteSearch(), buildNoteRead()];
}
