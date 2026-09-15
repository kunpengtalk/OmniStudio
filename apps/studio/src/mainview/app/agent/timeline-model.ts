import type { AgentEventRow } from "../../../bun/agent";

/** 一次工具调用的两头（没有结果的那条 `end` 为空，见 ToolRow 的三种状态）。 */
export type TimelineToolCall = { start: AgentEventRow; end?: AgentEventRow };

/** 时间线上的一项：模型说了什么 / 工具调用 / 状态行 / 授权卡片 / 提问卡片 / 子智能体分组。 */
export type TimelineItem =
  | { type: "text"; event: AgentEventRow }
  | { type: "tool"; start: AgentEventRow; end?: AgentEventRow }
  | { type: "toolGroup"; family: ToolFamily; tools: TimelineToolCall[] }
  | { type: "status"; event: AgentEventRow }
  | { type: "permission"; ask: AgentEventRow; settle?: AgentEventRow }
  | { type: "question"; ask: AgentEventRow; settle?: AgentEventRow }
  | { type: "subagent"; start: AgentEventRow; end?: AgentEventRow; children: AgentEventRow[] };

/**
 * 工具行的「家族」：同一家族的**连续**调用在时间轴上收成一行。
 *
 * 一次调研动辄十几个 read / grep / list，一个调用占一行的话过程会把时间轴淹没，
 * 模型真正说的话反而被挤到看不见 —— 同行（参考实现）的写法是一行
 * 「查阅 · 1 搜索, 1 列表」：做了什么、各几次一眼看完，要细节再展开。
 *
 * 只有这几类**成串出现**的调用收组：终端的每条命令自带信息（命令原文就是答案）、
 * 生图 / 生视频各有各的产物、MCP 与未知工具的花样无法归类，它们都各自成行。
 * 返回 null = 不成组。
 */
export type ToolFamily = "browse" | "net" | "edit";

export function toolFamily(toolName: string): ToolFamily | null {
  switch (toolName) {
    case "read_file":
    case "list_dir":
    case "glob":
    case "grep":
    case "knowledge_search":
    case "view_image":
      return "browse";
    case "web_search":
    case "web_fetch":
      return "net";
    case "write_file":
    case "edit_file":
    case "apply_patch":
      return "edit";
    default:
      return null;
  }
}

/**
 * 已经落成事件的那截正文有多长（字符数）。
 *
 * 一条助手消息的正文是整轮拼接的（`text` 事件按顺序拼起来正是它的**前缀**，见
 * agent.ts 的 flushStepText），所以"还没进时间轴的部分"= `content.slice(这个长度)`：
 * 跑动中它就是正在流出的那一段（渲染成正文尾巴），跑完就空了。
 * 老消息没有 `text` 事件 → 返回 0 → 整条正文都当尾巴渲染（与改动前一致）。
 */
export function flushedTextChars(events: AgentEventRow[]): number {
  let chars = 0;
  for (const event of events) {
    if (event.kind === "text" && !event.subagentId) chars += event.output?.length ?? 0;
  }
  return chars;
}

/** 从事件 args 里取交互 id（授权 / 提问的请求与结果都带）。 */
export function parseEventId(event: AgentEventRow): string | undefined {
  if (!event.args) return undefined;
  try {
    const parsed = JSON.parse(event.args) as { id?: string };
    return typeof parsed?.id === "string" ? parsed.id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 工具行上的动作名：没有对应词条时退回工具名本身。
 *
 * MCP 工具、外部接入的工具、以及刚加进来还没配词条的内置工具都没有 `agent.tool.*`
 * 词条，而 `t()` 在缺键时会把 key 原样返回 —— 时间线上于是画出
 * `agent.tool.memory_search` 这种内部标识（真实发生过），用户看到的不是"它调了什么"。
 */
export function toolLabel(t: (key: string) => string, labelKey: string, toolName: string): string {
  const label = t(labelKey);
  return label === labelKey ? toolName : label;
}

/**
 * 把一次运行的事件流整理成时间线（纯函数，UI 只负责画）。
 *
 * 配对工具调用时**不能只看列表最后一项**：工具执行前可能要等用户授权，
 * 于是 `permission_request` / `permission` 这两条事件会插在 tool_start 与
 * tool_end 之间；上下文压缩、排队提示这些 status 行同样会插进来。
 * 只看最后一项会配不上，那一行就永远停在转圈的「运行中」状态 —— 会话早就跑完
 * 甚至早就结束了，界面上却像还在执行。所以这里往回找最近一个同名、还没配对的
 * 工具行（并行执行同一批工具时也能各自配对）。
 */
export function buildTimelineItems(events: AgentEventRow[]): TimelineItem[] {
  const rendered: TimelineItem[] = [];

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
    if (event.kind === "text") {
      // 模型说的话：时间轴上与工具行同序 —— 说了什么 → 调了什么工具 → 又说了什么。
      rendered.push({ type: "text", event });
    } else if (event.kind === "tool_start") {
      rendered.push({ type: "tool", start: event });
    } else if (event.kind === "tool_end") {
      const pending = findUnpairedTool(rendered, event.toolName);
      if (pending) pending.end = event;
      else rendered.push({ type: "tool", start: event, end: event });
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

  return groupToolRuns(rendered);
}

/**
 * 把**相邻**的同家族工具行收成一组（"查阅 · 2 搜索, 1 文件"）。
 *
 * 断了就重开一组，断点包括：模型说的话（`text`）、状态行、授权 / 提问卡片、
 * 子智能体分组，以及不属于同一家族的调用（终端命令、生图、MCP 工具）。
 * 顺序即因果 —— "先读了两个文件，跑一条命令，又搜了三处"读起来仍是这条线。
 *
 * 单独一次调用**不收组**：一行「检索记忆 · …」里带着参数（哪个文件、什么关键词）
 * 比「查阅 · 1 文件」有信息量，收起来只剩计数是净损失。
 */
function groupToolRuns(items: TimelineItem[]): TimelineItem[] {
  const out: TimelineItem[] = [];
  let run: TimelineToolCall[] = [];
  let runFamily: ToolFamily | null = null;

  const flush = () => {
    if (run.length > 1 && runFamily) out.push({ type: "toolGroup", family: runFamily, tools: run });
    else out.push(...run.map((call) => ({ type: "tool" as const, start: call.start, end: call.end })));
    run = [];
    runFamily = null;
  };

  for (const item of items) {
    const family = item.type === "tool" ? toolFamily(item.start.toolName ?? "") : null;
    if (item.type === "tool" && family) {
      if (runFamily && family !== runFamily) flush();
      runFamily = family;
      run.push({ start: item.start, end: item.end });
      continue;
    }
    flush();
    out.push(item);
  }
  flush();

  return out;
}

/** 最近一个同名、还没有配到结果的工具行（从后往前）。 */
function findUnpairedTool(
  items: TimelineItem[],
  toolName: string | null,
): Extract<TimelineItem, { type: "tool" }> | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!;
    if (item.type !== "tool") continue;
    if (item.end) continue;
    if (item.start.toolName === toolName) return item;
  }
  return undefined;
}
