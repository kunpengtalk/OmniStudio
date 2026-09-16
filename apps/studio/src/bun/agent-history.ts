/**
 * 会话重建时的历史回填。
 *
 * 之前只回填 user / assistant 的**正文**，工具调用与结果全丢。后果是：
 * 换模型、换工作区、重开会话之后，模型"不记得自己刚才做过什么" ——
 * 会重新读同一批文件、重跑同一条命令，用户看到的是"它怎么又在做一遍"。
 *
 * 工具调用的事实来源是 `agent_events`（每轮工具调用都落了 `tool_start` / `tool_end`），
 * 这里把它按助手消息分组配对，还原成「助手发起调用 → 工具结果」的形状。
 *
 * 三条不能破的规矩：
 * 1. **每个 toolCall 必须有对应的 toolResult**（哪怕结果是"被中断了"）——
 *    线上协议要求 tool 消息紧跟带 tool_calls 的助手消息，缺一条就是 400；
 * 2. 工具输出要**截断**：历史里的输出动辄上万字符，原样回填会把 8k 窗口直接吃光，
 *    截断处写明"想要细节请重新执行"；
 * 3. 子智能体内部的事件（`subagentId != null`）不回填 —— 它们是子会话的过程，
 *    对主 Agent 只有 `task` 那一次调用的结论有意义。
 */
import type { AgentEventRow } from "./agent";

/** 回填时单条工具结果的字符上限（对齐 oh-my-pi 的摘要输入口径）。 */
export const MAX_HISTORY_TOOL_RESULT_CHARS = 2_000;

/** 数据库里的会话消息（`getHistory` 的形状）。 */
export type HistoryRow = { id: number; role: string; content: string; createdAt: number };

type ToolCallBlock = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};
type TextBlock = { type: "text"; text: string };
type ToolResultBlock = { type: "text"; text: string };

/** 回填出来的消息（调用方按 AgentMessage 使用）。 */
export type RehydratedMessage = {
  role: "user" | "assistant" | "toolResult";
  content: (TextBlock | ToolCallBlock | ToolResultBlock)[];
  [key: string]: unknown;
};

type PairedCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  isError: boolean;
};

/** 把 `args`（JSON 字符串）解析成对象；坏数据退化成空对象而不是抛错。 */
function parseArgs(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * 按消息分组，配对 `tool_start` / `tool_end`。
 *
 * 同名工具并行调用时结果顺序不保证，所以按**后进先出**配对（与时间线的渲染同一规则，
 * 见 `mainview/app/agent/timeline-model.ts`）：这样"最后一次调用"配到"最新一条结果"。
 * 没有配对上的调用会拿到一条合成的说明，保证 toolCall 不落单。
 */
export function pairToolEvents(events: AgentEventRow[]): Map<number, PairedCall[]> {
  const byMessage = new Map<number, PairedCall[]>();
  const pending = new Map<number, PairedCall[]>();

  for (const event of events) {
    // 子智能体的事件属于子会话，不进主 Agent 的历史。
    if (event.subagentId) continue;
    if (event.messageId === null || event.messageId === undefined) continue;
    if (event.kind !== "tool_start" && event.kind !== "tool_end") continue;
    const name = event.toolName ?? "tool";

    if (event.kind === "tool_start") {
      const call: PairedCall = {
        id: `hist-${event.id}`,
        name,
        args: parseArgs(event.args),
        isError: false,
      };
      const queue = pending.get(event.messageId) ?? [];
      queue.push(call);
      pending.set(event.messageId, queue);
      continue;
    }

    // tool_end：从后往前找同名且还没配到结果的调用。
    const queue = pending.get(event.messageId);
    const call = queue
      ? [...queue].reverse().find((item) => item.name === name && item.result === undefined)
      : undefined;
    if (!call) continue;
    call.result = event.output ?? "";
    call.isError = event.isError === 1;
  }

  for (const [messageId, queue] of pending) {
    if (queue.length === 0) continue;
    byMessage.set(messageId, queue);
  }
  return byMessage;
}

function truncateResult(text: string): string {
  if (text.length <= MAX_HISTORY_TOOL_RESULT_CHARS) return text;
  return (
    `${text.slice(0, MAX_HISTORY_TOOL_RESULT_CHARS)}\n` +
    `…（历史里的这条结果已被截断保存，需要完整内容请重新执行这个工具）`
  );
}

/**
 * 建会话那一刻，库里最后那条用户消息**就是本轮即将作为 prompt 发出去的那一条**
 * （`runAgentTurn` 先落库、再建会话），所以回填历史时要把它摘掉。
 *
 * 不摘的后果：每个"会话刚建立"的回合里，模型都会看到同一段任务两遍 ——
 * 首轮、换模型 / 换工作区之后的第一轮、重新生成都属于这一类；而这段任务描述里
 * 还捎着时间提醒、召回的记忆、hook 上下文与附件路径，整段都会翻倍。
 * 换个说法更好理解：**历史只该包含已经结束的回合，当前这一轮由 prompt 承载**。
 *
 * 这个缺陷是 `agent-resilience-smoke` 在检查"重发是接着发、不是重开一轮"时数出来的
 * （它数了请求里任务陈述出现的次数）—— 单测与单点场景都看不见。
 */
export function dropCurrentPrompt<T extends { role?: string }>(rows: T[]): T[] {
  return rows[rows.length - 1]?.role === "user" ? rows.slice(0, -1) : rows;
}

/**
 * 把「库里的消息」+「工具事件」还原成可以交给 Pi Agent 的历史。
 *
 * 带工具调用的助手消息会被拆成两条：先「只含 tool_calls 的助手消息」→「工具结果」→
 * 「模型最终回答」。这既符合线上协议要求（tool 消息必须紧跟调用），也还原了真实顺序
 * （模型是先调工具、拿到结果、才写结论的）。
 */
export function buildHistoryMessages(
  history: HistoryRow[],
  events: AgentEventRow[],
  meta: { model: string; provider: string; api: string },
): RehydratedMessage[] {
  const callsByMessage = pairToolEvents(events);
  const out: RehydratedMessage[] = [];

  for (const row of history) {
    const text = row.content.trim();
    if (row.role === "user") {
      if (text)
        out.push({ role: "user", content: [{ type: "text", text }], timestamp: row.createdAt });
      continue;
    }
    if (row.role !== "assistant") continue;

    const calls = callsByMessage.get(row.id) ?? [];
    if (calls.length === 0) {
      if (text) out.push(assistantMessage([{ type: "text", text }], meta, row.createdAt, "stop"));
      continue;
    }

    // 1) 只含工具调用的助手消息
    out.push(
      assistantMessage(
        calls.map((call) => ({
          type: "toolCall",
          id: call.id,
          name: call.name,
          arguments: call.args,
        })),
        meta,
        row.createdAt,
        "toolUse",
      ),
    );
    // 2) 每个调用都要有结果（没配上的合成一条，缺了会 400）
    for (const call of calls) {
      out.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [
          {
            type: "text",
            text:
              call.result === undefined
                ? "（这次调用没有留下结果：回合被中断了）"
                : truncateResult(call.result),
          },
        ],
        isError: call.isError,
        timestamp: row.createdAt,
      });
    }
    // 3) 模型这一轮最终写出来的正文
    if (text) out.push(assistantMessage([{ type: "text", text }], meta, row.createdAt, "stop"));
  }

  return out;
}

function assistantMessage(
  content: (TextBlock | ToolCallBlock)[],
  meta: { model: string; provider: string; api: string },
  timestamp: number,
  stopReason: "stop" | "toolUse",
): RehydratedMessage {
  return {
    role: "assistant",
    content,
    api: meta.api,
    provider: meta.provider,
    model: meta.model,
    // 回填的是历史，没有真实用量：全 0，别让占用条把它当成实测值。
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp,
  };
}

/**
 * 「重新生成」的上下文决策。
 *
 * 重新生成 = 删掉这条回答及其之后的一切，再用**同一条**用户消息重跑一遍。要点在于
 * 那条用户消息**不在删除区间内**（它排在目标回答之前），所以本轮绝不能再写一条 user 行：
 * 写下去就是同一段任务在历史里出现两遍 —— 界面上两个一模一样的用户气泡，模型侧则
 * 既在历史里看到它、又在 prompt 里收到它（这正是 dropCurrentPrompt 那条注释警告的形态）。
 *
 * 抽成纯函数是为了能单测：`regenerateAgentMessage` 那一层要连上模型才跑得起来，
 * 而这条规则错一次的代价是"每次重新生成都多一条用户消息"，很难在界面上认出来。
 */
export function planRegenerate(
  history: { id: number; role?: string | null; content?: string | null }[],
  messageId: number,
): { ok: false; error: string } | { ok: true; deleteFromId: number; prompt: string } {
  const beforeTarget = history.filter((m) => m.id < messageId);
  const lastUser = [...beforeTarget].reverse().find((m) => m.role === "user");
  if (!lastUser) return { ok: false, error: "Nothing to regenerate" };
  return { ok: true, deleteFromId: messageId, prompt: lastUser.content ?? "" };
}
