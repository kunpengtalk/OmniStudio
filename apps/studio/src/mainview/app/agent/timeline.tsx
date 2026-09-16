import { useMemo, useState } from "react";
import {
  BotIcon,
  ChevronRightIcon,
  FileSearchIcon,
  GlobeIcon,
  ImageIcon,
  ListTodoIcon,
  MessageCircleQuestionIcon,
  PencilIcon,
  SparklesIcon,
  SquareTerminalIcon,
  WrenchIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { useT } from "@stores/ui-lang";
import { Markdown } from "@components/markdown";
import { InlinePermissionCard, InlineQuestionCard } from "./inline-interactions";
import {
  buildTimelineItems,
  toolLabel,
  type TimelineItem,
  type TimelineToolCall,
  type ToolFamily,
} from "./timeline-model";
import type { AgentEventRow } from "../../../bun/agent";

function parseArgs(args: string | null): Record<string, unknown> {
  if (!args) return {};
  try {
    const parsed = JSON.parse(args) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 相对路径只留文件名（工具行里给的是"改的是哪个文件"，不是完整路径）。 */
function baseName(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** apply_patch 的段落头 → 改动到的文件（与 bun/apply-patch.ts 的格式一致）。 */
function patchFilePaths(patch: string): string[] {
  const paths: string[] = [];
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    const value = match[1]?.trim();
    if (value) paths.push(value);
  }
  return paths;
}

/** 单行化：把命令 / 查询里的换行压成空格，避免工具行被撑成多行。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export type DiffSummary = { added: number; removed: number; lines: { type: "same" | "add" | "del"; text: string }[] };

/**
 * 极简行级 diff：把 old_str / new_str 按行做 LCS，只展示改变的部分（± 前缀）。
 * 编辑类工具卡片据此显示「改了什么」，而不是让用户去读 JSON 参数。
 */
function diffLines(oldText: string, newText: string): DiffSummary["lines"] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  // 超过 400 行就不做 LCS（O(n*m) 会卡住渲染），退化成整段替换。
  if (a.length > 400 || b.length > 400) {
    return [
      ...a.map((text) => ({ type: "del" as const, text })),
      ...b.map((text) => ({ type: "add" as const, text })),
    ];
  }
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const out: DiffSummary["lines"] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      out.push({ type: "del", text: a[i]! });
      i += 1;
    } else {
      out.push({ type: "add", text: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) out.push({ type: "del", text: a[i++]! });
  while (j < b.length) out.push({ type: "add", text: b[j++]! });
  return out;
}

/**
 * diff 结果按参数串缓存：LCS 是 O(n×m)，而工具行会在每次流式增量时重渲染
 * （每秒几十次），不缓存的话大文件编辑会把主线程占满。
 */
const diffCache = new Map<string, DiffSummary | null>();

export function summarizeEdit(args: string | null): DiffSummary | null {
  if (!args) return null;
  if (diffCache.has(args)) return diffCache.get(args) ?? null;
  const value = parseArgs(args);
  let summary: DiffSummary | null = null;
  if (typeof value.new_str === "string" && typeof value.old_str === "string") {
    const lines = diffLines(value.old_str, value.new_str);
    summary = {
      lines,
      added: lines.filter((line) => line.type === "add").length,
      removed: lines.filter((line) => line.type === "del").length,
    };
  } else if (typeof value.content === "string") {
    const lines = value.content
      .split("\n")
      .slice(0, 400)
      .map((text) => ({ type: "add" as const, text }));
    summary = { lines, added: lines.length, removed: 0 };
  } else if (typeof value.patch === "string") {
    // apply_patch：补丁文本本身就是 diff，按前缀渲染（+ 新增 / - 删除 / 其余是上下文）。
    const lines = value.patch
      .split("\n")
      .slice(0, 400)
      .map((text) => {
        if (text.startsWith("+") && !text.startsWith("+++")) return { type: "add" as const, text };
        if (text.startsWith("-") && !text.startsWith("---")) return { type: "del" as const, text };
        return { type: "same" as const, text };
      });
    summary = {
      lines,
      added: lines.filter((line) => line.type === "add").length,
      removed: lines.filter((line) => line.type === "del").length,
    };
  }
  // 缓存别无限涨：超出就整体丢掉重来（条目小，重建成本可以忽略）。
  if (diffCache.size > 300) diffCache.clear();
  diffCache.set(args, summary);
  return summary;
}

type ToolMeta = { icon: LucideIcon; labelKey: string; detail: string; file?: string };

/** 工具 → 一行的「图标 + 动作名 + 关键参数」。 */
function toolMeta(toolName: string, args: string | null): ToolMeta {
  const value = parseArgs(args);
  switch (toolName) {
    case "bash":
      return {
        icon: SquareTerminalIcon,
        labelKey: "agent.tool.terminal",
        detail: oneLine(str(value.command) || str(value.cmd) || ""),
      };
    case "read_file":
      return {
        icon: FileSearchIcon,
        labelKey: "agent.tool.read",
        detail: baseName(str(value.path)),
        file: str(value.path),
      };
    case "list_dir":
      return {
        icon: FileSearchIcon,
        labelKey: "agent.tool.list",
        detail: baseName(str(value.path) || "."),
        file: str(value.path),
      };
    case "glob":
      return { icon: FileSearchIcon, labelKey: "agent.tool.glob", detail: oneLine(str(value.pattern)), file: str(value.pattern) };
    case "grep":
      return { icon: FileSearchIcon, labelKey: "agent.tool.grep", detail: oneLine(str(value.pattern)), file: str(value.pattern) };
    case "write_file":
      return {
        icon: PencilIcon,
        labelKey: "agent.tool.write",
        detail: baseName(str(value.path)),
        file: str(value.path),
      };
    case "edit_file":
      return {
        icon: PencilIcon,
        labelKey: "agent.tool.edit",
        detail: baseName(str(value.path)),
        file: str(value.path),
      };
    case "apply_patch": {
      // 摘要里给"改了几个文件"，比一整段补丁更适合收成一行。
      const paths = patchFilePaths(str(value.patch));
      return {
        icon: PencilIcon,
        labelKey: "agent.tool.applyPatch",
        detail: paths.length ? `${paths.length} 个文件 · ${paths.slice(0, 3).map(baseName).join(", ")}` : "",
        file: paths[0],
      };
    }
    case "view_image":
      return {
        icon: ImageIcon,
        labelKey: "agent.tool.viewImage",
        detail: baseName(str(value.path)),
        file: str(value.path),
      };
    case "web_search":
      return { icon: GlobeIcon, labelKey: "agent.tool.webSearch", detail: oneLine(str(value.query)) };
    case "web_fetch":
      return { icon: GlobeIcon, labelKey: "agent.tool.webFetch", detail: oneLine(str(value.url)) };
    case "knowledge_search":
      return { icon: FileSearchIcon, labelKey: "agent.tool.knowledge", detail: oneLine(str(value.query)) };
    case "todo_write":
      return { icon: ListTodoIcon, labelKey: "agent.tool.todo", detail: "" };
    case "ask_user":
      return { icon: MessageCircleQuestionIcon, labelKey: "agent.tool.ask", detail: "" };
    case "task":
      return { icon: BotIcon, labelKey: "agent.tool.task", detail: oneLine(str(value.description) || str(value.prompt)) };
    default: {
      // 媒体类工具（生图 / 生视频 / 语音）走同一套行样式，只是图标不同。
      const isMedia = toolName.startsWith("generate") || toolName.includes("image") || toolName.includes("video");
      return {
        icon: isMedia ? SparklesIcon : WrenchIcon,
        labelKey: `agent.tool.${toolName}`,
        detail: oneLine(str(value.prompt) || str(value.query) || ""),
      };
    }
  }
}

/** 家族的图标与动作名（分组行的一行里只有家族名 + 计数，细节收在展开区）。 */
const FAMILY_META: Record<ToolFamily, { icon: LucideIcon; labelKey: string }> = {
  browse: { icon: FileSearchIcon, labelKey: "agent.tool.family.browse" },
  net: { icon: GlobeIcon, labelKey: "agent.tool.family.net" },
  edit: { icon: PencilIcon, labelKey: "agent.tool.family.edit" },
};

/**
 * 分组行里"每种调用几次"的量词：`2 搜索, 1 列表`。
 *
 * 用名词而不是动作名（"文件"而不是"读取"、"列表"而不是"目录"）：`2 文件, 1 列表`
 * 读起来是"两个文件、一个列表"，而不是"读了两次、列了一次目录"。
 */
function toolUnitKey(toolName: string): string {
  switch (toolName) {
    case "read_file":
    case "write_file":
    case "edit_file":
    case "apply_patch":
      return "agent.tool.unit.file";
    case "list_dir":
      return "agent.tool.unit.list";
    case "glob":
      return "agent.tool.unit.match";
    case "grep":
    case "web_search":
      return "agent.tool.unit.search";
    case "knowledge_search":
      return "agent.tool.unit.knowledge";
    case "view_image":
      return "agent.tool.unit.image";
    case "web_fetch":
      return "agent.tool.unit.fetch";
    default:
      // 未知工具（MCP / 外部接入）走工具名本身，画不出 `agent.tool.unit.*` 这种内部 key。
      return "";
  }
}

/** 组内每种调用各几次，按**首次出现**的顺序（先搜后读，读起来就是先搜后读）。 */
function groupBreakdown(t: (key: string, params?: Record<string, string>) => string, tools: TimelineToolCall[]): string {
  // 按"量词键"归并（`grep` 与 `web_search` 都算「搜索」），展示的是翻好的文案。
  const counts = new Map<string, { label: string; count: number }>();
  for (const tool of tools) {
    const name = tool.start.toolName ?? "";
    const unitKey = toolUnitKey(name);
    const label = unitKey ? t(unitKey) : toolLabel(t, `agent.tool.${name}`, name);
    const bucket = counts.get(unitKey || name);
    if (bucket) bucket.count += 1;
    else counts.set(unitKey || name, { label, count: 1 });
  }
  return [...counts.values()].map(({ label, count }) => `${count} ${label}`).join(", ");
}

/** 组内每次调用的关键参数（分组行的 title：不展开也能看到读了 / 改了哪些文件）。 */
function groupDetails(tools: TimelineToolCall[], t: (key: string) => string): string {
  return tools
    .map((tool) => {
      const name = tool.start.toolName ?? "";
      const meta = toolMeta(name, tool.start.args);
      // 有路径 / 关键词就给完整的那一份（行内是短名，悬浮时给全路径）。
      return meta.file || meta.detail || toolLabel(t, meta.labelKey, name);
    })
    .filter(Boolean)
    .join("\n");
}

/** diff 块：新增 / 删除分别染色，上下文不着色。 */
function DiffBlock({ summary }: { summary: DiffSummary }) {
  return (
    <div className="tool-diff">
      {summary.lines.map((line, index) => (
        <div key={index} className={`tool-diff-line${line.type === "add" ? " add" : line.type === "del" ? " del" : ""}`}>
          <span style={{ flex: "none", color: "var(--ds-text-muted)" }}>
            {line.type === "add" ? "+ " : line.type === "del" ? "- " : "  "}
          </span>
          <span style={{ minWidth: 0 }}>{line.text}</span>
        </div>
      ))}
    </div>
  );
}

/** 工具行的展开区：diff / 命令原文 / 参数 / 输出。 */
function ToolDetail({
  toolName,
  args,
  output,
  pending,
}: {
  toolName: string;
  args: string | null;
  output: string;
  pending: boolean;
}) {
  const t = useT();
  const edit = toolName === "edit_file" || toolName === "write_file" || toolName === "apply_patch";
  const summary = useMemo(() => (edit ? summarizeEdit(args) : null), [edit, args]);
  const parsed = useMemo(() => parseArgs(args), [args]);
  const command = toolName === "bash" ? str(parsed.command) || str(parsed.cmd) : "";
  const rawArgs = JSON.stringify(parsed, null, 2);

  return (
    <div style={{ display: "flex", minWidth: 0, flexDirection: "column", gap: 6 }}>
      {summary ? (
        <DiffBlock summary={summary} />
      ) : command ? (
        <div className="tool-block">{command}</div>
      ) : rawArgs !== "{}" ? (
        <div className="tool-block" style={{ color: "var(--ds-text-muted)" }}>
          {rawArgs}
        </div>
      ) : null}
      {output ? (
        <div className="tool-block">{output}</div>
      ) : !pending ? (
        <div className="tool-note">{t("agent.noOutput")}</div>
      ) : null}
    </div>
  );
}

/**
 * 工具行的状态位：跑动中转圈、没配到结果留一行灰字、出错一个红点。
 *
 * 跑完且正常时**什么都不画**：每一行都缀一个绿点等于什么都没说（真实的调研里
 * 几十行清一色是绿的），只有例外值得被看见 —— 收着的那一行更该是干净的一行字。
 * "还在跑吗"由消息最上面那一行与时间轴末尾的转圈行回答。
 */
function ToolRowState({ pending, missing, failed }: { pending: boolean; missing: boolean; failed: boolean }) {
  const t = useT();
  if (pending) return <span className="tool-spinner" aria-hidden />;
  if (missing) return <span className="tool-row-state">{t("agent.tool.interrupted")}</span>;
  if (!failed) return null;
  return (
    <span className="tool-row-state error">
      <span className="tool-row-dot error" aria-hidden />
    </span>
  );
}

/**
 * 单条工具调用：一行「图标 + 动作名 + 关键参数」，点开看 diff / 命令 / 输出。
 *
 * `live` = 这一轮还在跑：只有还在跑的时候才转圈。跑完（或会话早就结束）却因为
 * 事件没配到结果的行，展示成「没有结果记录」，绝不能一直转圈 —— 那会让人以为
 * 任务还在执行。
 */
function ToolRow({ start, end, live }: { start: AgentEventRow; end?: AgentEventRow; live: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const pending = !end && live;
  const missing = !end && !live;
  const failed = (end?.isError ?? 0) === 1;
  const output = end?.output ?? "";
  const toolName = start.toolName ?? "";
  const meta = useMemo(() => toolMeta(toolName, start.args), [toolName, start.args]);
  const summary = useMemo(
    () => (toolName === "edit_file" || toolName === "write_file" ? summarizeEdit(start.args) : null),
    [toolName, start.args],
  );
  const Icon = meta.icon;

  return (
    <div className="tool-row">
      <button
        type="button"
        className="tool-row-header"
        aria-expanded={open}
        title={meta.file || meta.detail}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRightIcon size={13} className={`pi-caret${open ? " open" : ""}`} aria-hidden />
        <Icon size={13} aria-hidden style={{ flex: "none", color: "var(--ds-text-muted)" }} />
        <span className="tool-row-name">{toolLabel(t, meta.labelKey, toolName)}</span>
        {meta.detail ? <span className="tool-row-summary">{meta.detail}</span> : null}
        {summary && (summary.added > 0 || summary.removed > 0) ? (
          <span className="review-counters">
            <span className="review-add">+{summary.added}</span>
            {summary.removed > 0 ? <span className="review-del">-{summary.removed}</span> : null}
          </span>
        ) : null}
        <ToolRowState pending={pending} missing={missing} failed={failed} />
      </button>
      {open ? (
        <div className="tool-row-body">
          <ToolDetail toolName={toolName} args={start.args} output={output} pending={pending} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * 分组行：同家族的相邻调用收成一行 —— 「查阅 · 2 搜索, 1 列表」，点开是每一次调用。
 *
 * 一次调研十几个 read / grep，一个调用一行的话过程会把时间轴铺满（真实会话里
 * 四十行工具里三十行是 read_file），模型说的话反而读不到。收起来只留"做了什么、
 * 各几次"，展开还是原来那一行行（各自的 diff / 命令 / 输出），信息一点没少；
 * `title` 里带着每次调用的文件名，不展开也能看到改的是哪些文件。
 *
 * 编辑家族额外报 +/- 合计：那一行正是"这一轮改了多少"最该出现的位置。
 */
function ToolGroupRow({ family, tools, live }: { family: ToolFamily; tools: TimelineToolCall[]; live: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const pending = live && tools.some((tool) => !tool.end);
  const missing = !live && tools.some((tool) => !tool.end);
  const failed = tools.some((tool) => (tool.end?.isError ?? 0) === 1);
  const meta = FAMILY_META[family];
  const Icon = meta.icon;
  const breakdown = useMemo(() => groupBreakdown(t, tools), [t, tools]);
  // title 要解析每次调用的参数：工具行会随流式增量重渲染（每秒几十次），不缓存白解析。
  const details = useMemo(() => groupDetails(tools, t), [t, tools]);
  const counters = useMemo(() => {
    if (family !== "edit") return null;
    let added = 0;
    let removed = 0;
    for (const tool of tools) {
      const summary = summarizeEdit(tool.start.args);
      added += summary?.added ?? 0;
      removed += summary?.removed ?? 0;
    }
    return added > 0 || removed > 0 ? { added, removed } : null;
  }, [family, tools]);

  return (
    <div className="tool-row">
      <button
        type="button"
        className="tool-row-header"
        aria-expanded={open}
        title={details}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRightIcon size={13} className={`pi-caret${open ? " open" : ""}`} aria-hidden />
        <Icon size={13} aria-hidden style={{ flex: "none", color: "var(--ds-text-muted)" }} />
        <span className="tool-row-name">{t(meta.labelKey)}</span>
        <span className="tool-sep" aria-hidden>
          ·
        </span>
        <span className="tool-row-counts">{breakdown}</span>
        {counters ? (
          <span className="review-counters">
            <span className="review-add">+{counters.added}</span>
            {counters.removed > 0 ? <span className="review-del">-{counters.removed}</span> : null}
          </span>
        ) : null}
        <ToolRowState pending={pending} missing={missing} failed={failed} />
      </button>
      {open ? (
        <div className="tool-group-rows">
          {tools.map((tool) => (
            <ToolRow key={tool.start.id} start={tool.start} end={tool.end} live={live} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 状态 / 错误 / 授权结果行：一行灰字，不抢正文的注意力。 */
function StatusLine({ event }: { event: AgentEventRow }) {
  const isError = event.kind === "error" || event.isError === 1;
  if (!(event.output ?? "").trim()) return null;
  return (
    <div className={`tool-note${isError ? " error" : ""}`} style={{ margin: "3px 0", whiteSpace: "pre-wrap" }}>
      {event.output}
    </div>
  );
}

/** 子智能体的类型：词条给界面语言，缺词条时退回类型名本身。 */
const SUBAGENT_TYPE_KEYS: Record<string, string> = {
  explore: "agent.subagent.type.explore",
  review: "agent.subagent.type.review",
  general: "agent.subagent.type.general",
};

/** 老记录（`subagent_start` 没有结构化参数）从 label 前缀还原类型 —— 写入端见 agent.ts 的 `label`。 */
const LEGACY_SUBAGENT_TYPES: Record<string, string> = { 探索: "explore", 审阅: "review", 执行: "general" };

/**
 * 子智能体的类型 + 任务描述。
 *
 * 事件里 `subagent_start` 的 output 是 `探索：<描述>`（agent.ts 拼的 label），
 * 新记录另外带上了 `subagent_type` / `description` 两个结构化参数；老记录只有
 * 那段 label，就从"："切出描述、按前缀认类型 —— 界面上不该出现 `探索：` 这个前缀，
 * 类型已经单独占了一格。
 */
function subagentMeta(event: AgentEventRow): { typeName: string; typeKey: string; description: string } {
  const value = parseArgs(event.args);
  const text = oneLine(event.output ?? "");
  const colon = text.indexOf("：");
  const declared = str(value.subagent_type) || LEGACY_SUBAGENT_TYPES[colon > 0 ? text.slice(0, colon) : ""] || "general";
  const description = str(value.description) || (colon > 0 ? text.slice(colon + 1) : text);
  return { typeName: declared, typeKey: SUBAGENT_TYPE_KEYS[declared] ?? "", description };
}

/**
 * 子智能体分组：一条 task 派发 → 它自己的工具调用 → 结论，收进一个可折叠块，
 * 主线只留一行「子智能体 探索 · 找配置 · N 次工具调用」。
 */
function SubagentGroup({
  start,
  end,
  children,
  live,
}: {
  start: AgentEventRow;
  end?: AgentEventRow;
  children: AgentEventRow[];
  live: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const failed = (end?.isError ?? 0) === 1;
  const running = !end && live;
  const toolCount = children.filter((event) => event.kind === "tool_start").length;
  const meta = useMemo(() => subagentMeta(start), [start]);
  const typeLabel = meta.typeKey ? t(meta.typeKey) : meta.typeName;

  return (
    <div className="tool-group" style={{ margin: "4px 0" }}>
      <button
        type="button"
        className="tool-group-header subagent-head"
        aria-expanded={open}
        title={meta.description}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRightIcon size={13} className={`pi-caret${open ? " open" : ""}`} aria-hidden />
        <BotIcon size={13} aria-hidden style={{ flex: "none", color: "var(--ds-purple)" }} />
        <span className="tool-group-label">{t("agent.subagent.label")}</span>
        <span className="tool-group-type">{typeLabel}</span>
        {meta.description ? (
          <>
            <span className="tool-sep" aria-hidden>
              ·
            </span>
            <span className="tool-row-desc">{meta.description}</span>
          </>
        ) : null}
        {toolCount > 0 ? (
          <span className="tool-group-count">{t("agent.subagent.tools", { count: String(toolCount) })}</span>
        ) : null}
        {running ? (
          <span className="tool-spinner" aria-hidden />
        ) : failed ? (
          <span className="tool-row-dot error" aria-hidden />
        ) : null}
      </button>
      <div className={`tool-group-collapse${open ? " open" : ""}`}>
        <div>
          <div className="tool-group-body">
            {children.map((event) => (
              <ToolRow
                key={event.id}
                start={event}
                end={event.kind === "tool_end" ? event : undefined}
                live={live}
              />
            ))}
            {end?.output ? (
              <div className="tool-block" style={{ marginTop: 4 }}>
                {end.output}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 把一次运行的事件流渲染成**时间轴**：
 * 模型说的话（`text` 事件）与工具行按发生顺序混排 —— 说了什么 → 调了什么工具 →
 * 又说了什么，而不是"所有工具在上、所有正文在下"（正文在库里是整轮拼接的一块，
 * 顺序只能靠事件还原，见 agent.ts 的 flushStepText）。
 * 配对逻辑在 timeline-model.ts（纯函数，有单测），这里只负责画。
 * `live` = 这一轮还在跑（只有最后一条消息在流式时才是 true），
 * 用来区分"正在执行"和"没有结果记录"。
 */
export function AgentEventTimeline({
  events,
  live = false,
}: {
  events: AgentEventRow[];
  live?: boolean;
}) {
  const items = useMemo(() => buildTimelineItems(events), [events]);

  if (items.length === 0) return null;

  // 不自己套容器：时间轴的容器（.msg-timeline）由消息那一层提供 —— 思考行、
  // 流式尾巴、转圈行都要和这些项排在同一个队列里，套两层会让它们之间的间距与
  // 缩进规则各管一半。
  return (
    <>
      {items.map((item, index) => {
        if (item.type === "text") {
          return (
            <div key={`${item.event.id}-${index}`} className="msg-bubble-agent prose-pi selectable">
              <Markdown content={item.event.output ?? ""} />
            </div>
          );
        }
        // 工具 / 状态 / 卡片都缩进一级：它们是"过程"，正文才是这轮说的话。
        return (
          <div key={timelineItemKey(item, index)} className="timeline-detail">
            {item.type === "tool" ? (
              <ToolRow start={item.start} end={item.end} live={live} />
            ) : item.type === "toolGroup" ? (
              <ToolGroupRow family={item.family} tools={item.tools} live={live} />
            ) : item.type === "status" ? (
              <StatusLine event={item.event} />
            ) : item.type === "permission" ? (
              <InlinePermissionCard askEvent={item.ask} settleEvent={item.settle} />
            ) : item.type === "question" ? (
              <InlineQuestionCard askEvent={item.ask} settleEvent={item.settle} />
            ) : (
              <SubagentGroup start={item.start} end={item.end} live={live}>
                {item.children}
              </SubagentGroup>
            )}
          </div>
        );
      })}
    </>
  );
}

/** 时间轴每一项的 React key（工具行按起始事件 id，其它按自身事件 id）。 */
function timelineItemKey(item: TimelineItem, index: number): string {
  switch (item.type) {
    case "tool":
      return `${item.start.id}-${index}`;
    case "toolGroup":
      return `${item.tools[0]?.start.id ?? "group"}-${index}`;
    case "text":
    case "status":
      return `${item.event.id}-${index}`;
    case "permission":
    case "question":
      return `${item.ask.id}-${index}`;
    default:
      return `${item.start.id}-${index}`;
  }
}

