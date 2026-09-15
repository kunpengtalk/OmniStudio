/**
 * 无头执行（对齐 Codex 的 `codex exec`）：把一次 Agent 回合从"人坐在界面前"变成
 * "外部脚本可以调用的命令"。
 *
 * 为什么值得做：自动化（`automations.ts`）解决的是"到点自己跑"，但从 CI、编辑器插件、
 * 定时脚本里"跑一次并拿到结果"一直没有入口 —— 外部要的是**能消费的事件流**，
 * 而不是去看界面。
 *
 * 形态：
 * - `runHeadlessAgent()` 跑一个无人值守回合（`headless: true`：ask_user 不挂起、
 *   授权按当前策略直接判定），返回最终正文与会话 id；
 * - 传了 `onLine` 就是流式：轨迹事件 / 正文增量 / 最终结果各是一行 JSON（NDJSON），
 *   外部脚本可以边跑边消费（控制 socket 的 `agentRun` 命令与 `omi agent run --json` 就是它）。
 *
 * 有意不做的事：无头回合**不会**弹授权卡片（没人可点）——被策略拦下的动作
 * 直接以拒绝理由回到模型，行的就是"无人值守"的语义。
 */
import path from "path";

import * as Chat from "./chat";
import {
  getAgentWorkspace,
  onAgentChunk,
  onAgentDone,
  onAgentEvent,
  runAgentTurn,
  type AgentEventRow,
  type AgentMode,
} from "./agent";

/** NDJSON 的一行。 */
export type HeadlessLine =
  | { type: "start"; conversationId: number; workspace: string; mode: AgentMode }
  | { type: "event"; event: AgentEventRow }
  | { type: "chunk"; messageId: number; kind: "content" | "reasoning"; delta: string }
  | {
      type: "result";
      ok: boolean;
      conversationId: number;
      messageId: number | null;
      text: string;
      error?: string;
      events: number;
    };

export type HeadlessRunResult = {
  ok: boolean;
  conversationId: number;
  messageId: number | null;
  text: string;
  error?: string;
  /** 本次回合产生的轨迹事件条数（工具调用 / 状态 / 错误）。 */
  events: number;
};

export const HEADLESS_MODES: AgentMode[] = ["agent", "plan", "goal"];

export function isHeadlessMode(value: unknown): value is AgentMode {
  return typeof value === "string" && (HEADLESS_MODES as string[]).includes(value);
}

export async function runHeadlessAgent(opts: {
  prompt: string;
  workspace?: string;
  mode?: AgentMode;
  /** 复用已有会话（多轮脚本）；不传就新建一条，标题取提示词前 40 字。 */
  conversationId?: number;
  /** 流式消费（NDJSON）。不传就只拿最终结果。 */
  onLine?: (line: HeadlessLine) => void;
  /** 是否把正文增量也推成行（默认 false：脚本多数只要事件与结果）。 */
  includeChunks?: boolean;
}): Promise<HeadlessRunResult> {
  const prompt = opts.prompt?.trim();
  if (!prompt) {
    throw new Error("prompt 不能为空");
  }
  const mode = opts.mode ?? "agent";
  const workspace = opts.workspace?.trim() ? path.resolve(opts.workspace.trim()) : getAgentWorkspace();

  let conversationId = opts.conversationId;
  if (conversationId !== undefined) {
    const existing = Chat.getConversation(conversationId).conversation;
    if (!existing) throw new Error(`会话不存在：${conversationId}`);
  } else {
    // 标题的截断口径与界面一致（补省略号、别把整段提示词塞进去）
    const title = prompt.trim() ? Chat.titleFromMessage(prompt) : "omi agent run";
    const created = Chat.createConversation(title, "agent");
    conversationId = created.id;
  }

  const unsubscribe: (() => void)[] = [];
  let events = 0;
  let finalText = "";
  let finalMessageId: number | null = null;
  let error: string | undefined;

  unsubscribe.push(
    onAgentEvent((event) => {
      if (event.conversationId !== conversationId) return;
      events += 1;
      opts.onLine?.({ type: "event", event });
    }),
  );
  if (opts.onLine && opts.includeChunks) {
    unsubscribe.push(
      onAgentChunk((payload) => {
        if (payload.conversationId !== conversationId) return;
        opts.onLine?.({
          type: "chunk",
          messageId: payload.messageId,
          kind: payload.kind === "reasoning" ? "reasoning" : "content",
          delta: payload.delta,
        });
      }),
    );
  }
  unsubscribe.push(
    onAgentDone((payload) => {
      if (payload.conversationId !== conversationId) return;
      finalText = payload.content;
      finalMessageId = payload.messageId;
      if (payload.error) error = payload.error;
    }),
  );

  opts.onLine?.({ type: "start", conversationId, workspace, mode });
  try {
    const turn = await runAgentTurn({
      conversationId,
      content: prompt,
      mode,
      workspace,
      headless: true,
    });
    if (!turn.ok && turn.error) error = turn.error;
    // done 事件理论上一定会来；万一没来（进程被中断）也要给个结果行。
    if (!finalText && !error) {
      const lastAssistant = [...Chat.getHistory(conversationId)]
        .reverse()
        .find((message) => message.role === "assistant");
      finalText = lastAssistant?.content ?? "";
      finalMessageId = lastAssistant?.id ?? null;
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    for (const off of unsubscribe) off();
  }

  const result: HeadlessRunResult = {
    ok: !error,
    conversationId,
    messageId: finalMessageId,
    text: finalText,
    ...(error ? { error } : {}),
    events,
  };
  opts.onLine?.({ type: "result", ...result });
  return result;
}
