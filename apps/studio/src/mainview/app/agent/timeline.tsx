import { useMemo, useState } from "react";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  FileSearchIcon,
  GlobeIcon,
  InfoIcon,
  ListTodoIcon,
  Loader2Icon,
  MessageCircleQuestionIcon,
  NetworkIcon,
  PencilIcon,
  ShieldCheckIcon,
  SparklesIcon,
  SquareTerminalIcon,
  WrenchIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import { InlinePermissionCard, InlineQuestionCard } from "./inline-interactions";
import type { AgentEventRow } from "../../../bun/agent";

/** 从事件 args 里取交互 id（授权 / 提问的请求与结果都带）。 */
function parseEventId(event: AgentEventRow): string | undefined {
  if (!event.args) return undefined;
  try {
    const parsed = JSON.parse(event.args) as { id?: string };
    return typeof parsed?.id === "string" ? parsed.id : undefined;
  } catch {
    return undefined;
  }
}

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
      return { icon: NetworkIcon, labelKey: "agent.tool.task", detail: oneLine(str(value.description) || str(value.prompt)) };
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

/** 工具行的展开区：命令原文 / 参数 / 输出。 */
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
  const edit = toolName === "edit_file" || toolName === "write_file";
  const summary = useMemo(() => (edit ? summarizeEdit(args) : null), [edit, args]);
  const parsed = useMemo(() => parseArgs(args), [args]);
  const command = toolName === "bash" ? str(parsed.command) || str(parsed.cmd) : "";
  const rawArgs = JSON.stringify(parsed, null, 2);

  return (
    <div className="mb-1 space-y-1.5 border-l border-border/60 px-2 py-1.5 pl-3">
      {edit && summary ? (
        <pre className="max-h-64 overflow-auto rounded-lg border bg-background/70 text-[11px] leading-4">
          {summary.lines.map((line, index) => (
            <div
              key={index}
              className={cn(
                "px-2 whitespace-pre-wrap",
                line.type === "add" && "bg-emerald-500/10",
                line.type === "del" && "bg-destructive/10",
              )}
            >
              <span className="select-none text-muted-foreground/60">
                {line.type === "add" ? "+ " : line.type === "del" ? "- " : "  "}
              </span>
              {line.text}
            </div>
          ))}
        </pre>
      ) : command ? (
        <pre className="max-h-40 overflow-auto rounded-lg border bg-background/70 px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap">
          {command}
        </pre>
      ) : (
        rawArgs !== "{}" && (
          <pre className="max-h-40 overflow-auto rounded-lg border bg-background/70 px-2 py-1.5 text-[11px] break-all whitespace-pre-wrap text-muted-foreground">
            {rawArgs}
          </pre>
        )
      )}
      {output ? (
        <pre className="max-h-72 overflow-auto rounded-lg border bg-background/70 px-2 py-1.5 text-[11px] break-all whitespace-pre-wrap">
          {output}
        </pre>
      ) : (
        !pending && <span className="text-[11px] text-muted-foreground">{t("agent.noOutput")}</span>
      )}
    </div>
  );
}

/**
 * 单条工具调用：一行「图标 + 动作名 + 关键参数」，点开看命令原文 / diff / 输出。
 * 默认收起，行内不画边框 —— 一屏能看完整条轨迹，而不是被卡片堆满。
 */
function ToolRow({ start, end }: { start: AgentEventRow; end?: AgentEventRow }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const pending = !end;
  const failed = end?.isError === 1;
  const output = end?.output ?? "";
  const toolName = start.toolName ?? "";
  const meta = useMemo(() => toolMeta(toolName, start.args), [toolName, start.args]);
  const summary = useMemo(
    () => (toolName === "edit_file" || toolName === "write_file" ? summarizeEdit(start.args) : null),
    [toolName, start.args],
  );
  const Icon = meta.icon;

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "group flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left transition-colors hover:bg-muted/70",
          open && "bg-muted/50",
        )}
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          {pending ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : failed ? (
            <AlertTriangleIcon className="size-3.5 text-destructive" />
          ) : (
            <Icon className="size-3.5" />
          )}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{t(meta.labelKey)}</span>
        {meta.detail && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/80" title={meta.file || meta.detail}>
            {meta.detail}
          </span>
        )}
        {!meta.detail && <span className="min-w-0 flex-1" />}
        {summary && (summary.added > 0 || summary.removed > 0) && (
          <span className="shrink-0 font-mono text-[10px] tabular-nums">
            <span className="text-emerald-600">+{summary.added}</span>
            {summary.removed > 0 && <span className="ml-1 text-destructive">-{summary.removed}</span>}
          </span>
        )}
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/50 transition-transform",
            open ? "rotate-180" : "opacity-0 group-hover:opacity-100",
          )}
        />
      </button>
      {open && <ToolDetail toolName={toolName} args={start.args} output={output} pending={pending} />}
    </div>
  );
}

/** 状态 / 错误 / 授权结果行：一行灰字，不抢正文的注意力。 */
function StatusLine({ event }: { event: AgentEventRow }) {
  const isError = event.kind === "error" || event.isError === 1;
  const isPermission = event.toolName === "permission";
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg px-2 py-1 text-[11px]",
        isError ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {isError ? (
        <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
      ) : isPermission ? (
        <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0" />
      ) : (
        <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1 whitespace-pre-wrap">{event.output}</span>
    </div>
  );
}

/**
 * 子智能体分组：一条 task 派发 → 它自己的工具调用 → 结论，收进一个可折叠块，
 * 主线只留一行「子任务：描述 · N 次工具调用」。
 */
function SubagentGroup({
  start,
  end,
  children,
}: {
  start: AgentEventRow;
  end?: AgentEventRow;
  children: AgentEventRow[];
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const failed = end?.isError === 1;
  const running = !end;
  const toolCount = children.filter((event) => event.kind === "tool_start").length;

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "group flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left transition-colors hover:bg-muted/70",
          open && "bg-muted/50",
        )}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          {running ? (
            <Loader2Icon className="size-3.5 animate-spin text-primary" />
          ) : failed ? (
            <AlertTriangleIcon className="size-3.5 text-destructive" />
          ) : (
            <CheckCircle2Icon className="size-3.5 text-emerald-600" />
          )}
        </span>
        <NetworkIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {t("agent.tool.task")}
          <span className="ml-2 font-mono text-[11px] text-foreground/80">{oneLine(start.output ?? "")}</span>
        </span>
        {toolCount > 0 && (
          <span className="shrink-0 text-[10px] text-muted-foreground/70">
            {t("agent.subagent.tools", { count: String(toolCount) })}
          </span>
        )}
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/50 transition-transform",
            open ? "rotate-180" : "opacity-0 group-hover:opacity-100",
          )}
        />
      </button>
      {open && (
        <div className="mt-0.5 mb-1 ml-3 space-y-0.5 border-l border-border/60 pl-2">
          {children.map((event) => (
            <ToolRow key={event.id} start={event} end={event.kind === "tool_end" ? event : undefined} />
          ))}
          {end?.output && (
            <pre className="max-h-40 overflow-auto px-2 py-1 text-[11px] break-all whitespace-pre-wrap text-muted-foreground">
              {end.output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 把一次运行的事件流渲染成时间线：
 * 普通工具调用两两配对成卡片，子智能体的调用折叠进 SubagentGroup，
 * 状态 / 错误单独成行。
 */
export function AgentEventTimeline({ events }: { events: AgentEventRow[] }) {
  const items = useMemo(() => {
    const rendered: (
      | { type: "tool"; start: AgentEventRow; end?: AgentEventRow }
      | { type: "status"; event: AgentEventRow }
      | { type: "permission"; ask: AgentEventRow; settle?: AgentEventRow }
      | { type: "question"; ask: AgentEventRow; settle?: AgentEventRow }
      | { type: "subagent"; start: AgentEventRow; end?: AgentEventRow; children: AgentEventRow[] }
    )[] = [];

    // 子智能体事件按 subagentId 归类，主 Agent 的事件按顺序配对。
    const subagents = new Map<string, { start?: AgentEventRow; end?: AgentEventRow; children: AgentEventRow[] }>();
    const subagentOrder: string[] = [];
    for (const event of events) {
      if (event.subagentId) {
        const bucket = subagents.get(event.subagentId) ?? { children: [] };
        if (event.kind === "subagent_start") bucket.start = event;
        else if (event.kind === "subagent_end") bucket.end = event;
        else bucket.children.push(event);
        subagents.set(event.subagentId, bucket);
        if (!subagentOrder.includes(event.subagentId)) subagentOrder.push(event.subagentId);
      }
    }

    // 授权 / 提问：请求事件与结果事件按 id 配对（两条都落在库里，回看历史也在）。
    const settleByRequestId = new Map<string, AgentEventRow>();
    const requestIds = new Set<string>();
    for (const event of events) {
      if (event.toolName === "permission_request" || event.toolName === "question_request") {
        const id = parseEventId(event);
        if (id) requestIds.add(id);
      } else if (event.toolName === "permission" || event.toolName === "question") {
        const id = parseEventId(event);
        if (id) settleByRequestId.set(id, event);
      }
    }

    for (const event of events) {
      if (event.subagentId) continue;
      if (event.kind === "tool_start") {
        rendered.push({ type: "tool", start: event });
      } else if (event.kind === "tool_end") {
        const last = rendered[rendered.length - 1];
        if (last?.type === "tool" && !last.end && last.start.toolName === event.toolName) {
          last.end = event;
        } else {
          rendered.push({ type: "tool", start: event, end: event });
        }
      } else if (event.toolName === "permission_request" || event.toolName === "question_request") {
        const id = parseEventId(event);
        rendered.push({
          type: event.toolName === "permission_request" ? "permission" : "question",
          ask: event,
          settle: id ? settleByRequestId.get(id) : undefined,
        });
      } else if (event.toolName === "permission" || event.toolName === "question") {
        // 结果事件已经被请求卡片消费掉了：没有对应请求（理论上不会）才单独显示。
        const id = parseEventId(event);
        if (!id || !requestIds.has(id)) rendered.push({ type: "status", event });
      } else {
        rendered.push({ type: "status", event });
      }
    }

    for (const id of subagentOrder) {
      const bucket = subagents.get(id)!;
      if (!bucket.start) continue;
      rendered.push({ type: "subagent", start: bucket.start, end: bucket.end, children: bucket.children });
    }

    return rendered;
  }, [events]);

  if (items.length === 0) return null;

  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      {items.map((item, index) => {
        if (item.type === "tool") {
          return <ToolRow key={`${item.start.id}-${index}`} start={item.start} end={item.end} />;
        }
        if (item.type === "status") {
          return <StatusLine key={`${item.event.id}-${index}`} event={item.event} />;
        }
        if (item.type === "permission") {
          return (
            <InlinePermissionCard
              key={`${item.ask.id}-${index}`}
              askEvent={item.ask}
              settleEvent={item.settle}
            />
          );
        }
        if (item.type === "question") {
          return (
            <InlineQuestionCard
              key={`${item.ask.id}-${index}`}
              askEvent={item.ask}
              settleEvent={item.settle}
            />
          );
        }
        return (
          <SubagentGroup key={`${item.start.id}-${index}`} start={item.start} end={item.end}>
            {item.children}
          </SubagentGroup>
        );
      })}
    </div>
  );
}
