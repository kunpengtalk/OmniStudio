/**
 * 上下文占用（对齐 Codex 的 get_context_remaining / 状态行）。
 *
 * 为什么需要：本地模型窗口往往只有 8k，长任务跑到一半"还剩多少"直接决定
 * 它该继续读文件还是先收尾。现在压缩发生时才在轨迹里说一句，模型和用户
 * 都看不见占用曲线，于是要么过早收手、要么一头撞上压缩。
 *
 * 两个数据来源，优先用真实的：
 * 1. **上一轮的真实用量**（服务端返回的 `usage.prompt_tokens`）：本轮请求发出去
 *    多少 token 是实测值，会话内一直有效；
 * 2. 没有实测值时按消息估算 —— 用的就是压缩那套 `estimateTokens`，
 *    所以显示的"预算占比"和真正触发压缩的判据是同一个数，不会互相打架。
 */
import { estimateMessagesTokens } from "./agent-compaction";
import { getHistory } from "./chat";
import { chatContextWindow } from "./chat-context";

export type ContextUsage = {
  /** 模型窗口（本地 = 引擎设置，云端 = 模型本身，见 `chat-context.ts`）。 */
  windowTokens: number;
  /** 压缩预算：窗口的 60%（与 agent.ts 的 transformContext 一致）。 */
  budgetTokens: number;
  /** 已占用（实测优先，其次估算）。 */
  usedTokens: number;
  remainingTokens: number;
  /** 已占用 / 预算，0–100（超过 100 表示已经顶到压缩线）。 */
  percent: number;
  /** usedTokens 的来源：usage = 上一轮实测，estimate = 按消息估算。 */
  source: "usage" | "estimate";
};

/** 会话里最近一轮实测的 prompt tokens（由 agent.ts 在回合结束时写入）。 */
const lastPromptTokens = new Map<number, number>();

export function rememberPromptTokens(conversationId: number, tokens: number): void {
  if (tokens > 0) lastPromptTokens.set(conversationId, tokens);
}

export function forgetPromptTokens(conversationId: number): void {
  lastPromptTokens.delete(conversationId);
}

/** 压缩预算 = 窗口的 60%，下限 256（与 `agent.ts` 的 transformContext 保持同一算法）。 */
export function contextBudgetTokens(windowTokens: number): number {
  return Math.max(256, Math.floor(windowTokens * 0.6));
}

/** 当前上下文窗口大小（本地看引擎设置，云端看模型本身，见 `chat-context.ts`）。 */
export function contextWindowTokens(): number {
  return chatContextWindow();
}

/**
 * 算一次上下文占用。`systemPromptTokens` 由调用方传入（Agent 手里的系统提示
 * 与工作区有关，只有 agent.ts 拿得到），估算路径下会被算进去。
 */
export function contextUsage(
  conversationId: number,
  opts: { systemPromptTokens?: number; toolTokens?: number } = {},
): ContextUsage {
  const windowTokens = contextWindowTokens();
  const budgetTokens = contextBudgetTokens(windowTokens);
  const measured = lastPromptTokens.get(conversationId);
  let usedTokens: number;
  let source: ContextUsage["source"];
  if (measured && measured > 0) {
    usedTokens = measured;
    source = "usage";
  } else {
    const history = getHistory(conversationId).map((message) => ({
      role: message.role,
      content: message.content,
    }));
    const extra = (opts.systemPromptTokens ?? 0) + (opts.toolTokens ?? 0);
    usedTokens = estimateMessagesTokens(history) + extra;
    source = "estimate";
  }
  const percent = Math.min(100, Math.round((usedTokens / budgetTokens) * 100));
  return {
    windowTokens,
    budgetTokens,
    usedTokens,
    remainingTokens: Math.max(0, budgetTokens - usedTokens),
    percent,
    source,
  };
}

/** 给模型看的一行状态（get_context_remaining 工具的结果）。 */
export function describeContextUsage(usage: ContextUsage): string {
  const lines = [
    `上下文窗口 ${usage.windowTokens} tokens；压缩预算 ${usage.budgetTokens}（窗口的 60%）。`,
    `当前已用约 ${usage.usedTokens} tokens（${usage.percent}%，来源：${
      usage.source === "usage" ? "上一轮实测" : "按消息估算"
    }），剩余约 ${usage.remainingTokens}。`,
  ];
  if (usage.percent >= 80) {
    lines.push(
      "已经接近压缩线：继续做大范围读取会被裁掉中间历史。" +
        "建议先用 todo_write 把进度记下来，把结论写进文件，再继续下一步。",
    );
  } else if (usage.percent >= 50) {
    lines.push("已经用掉一半以上：优先读必要的片段，避免整文件通读。");
  }
  return lines.join("\n");
}

/** 测试用：清空实测缓存。 */
export function resetContextUsageCache(): void {
  lastPromptTokens.clear();
}
