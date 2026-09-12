/**
 * 上下文压缩（对齐 Claude Code / OpenWork 的 compaction）。
 *
 * 为什么必须有：本地模型上下文通常只有 8k，一个稍微长点的任务（读几个文件 +
 * 跑几轮命令）就会顶到上限 —— 表现是「模型突然胡言乱语」或请求直接报超长。
 * 这里在请求前做一道裁剪：保留任务陈述 + 最近的若干条消息，中间的用一条
 * 说明性消息占位，保证长任务能继续跑下去。
 *
 * 裁剪是确定性的（不额外调模型）：宁可丢中间的细节，也不引入一次可能挂住的
 * 额外推理调用。丢掉的量会在 UI 轨迹里明说，用户不会以为模型"忘了"。
 */

/** 粗略 token 估算：CJK 约 1 token/字，英文约 1 token/4 字符。够用来做阈值判断。 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    // CJK / 全角标点：按 1 字 ≈ 1 token
    if (
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      tokens += 1;
    } else {
      tokens += 0.25;
    }
  }
  return Math.ceil(tokens);
}

type MessageLike = {
  role?: string;
  content?: unknown;
  [key: string]: unknown;
};

/** 取出一条消息的纯文本（content 可能是字符串或分块数组）。 */
function textOf(message: MessageLike): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const candidate = part as { text?: unknown; type?: unknown };
        if (typeof candidate.text === "string") return candidate.text;
        // 工具调用 / 工具结果也占上下文，用类型名占位，估算不至于漏掉它们。
        return typeof candidate.type === "string" ? `[${candidate.type}]` : "";
      })
      .join(" ");
  }
  return "";
}

export function estimateMessagesTokens(messages: MessageLike[]): number {
  return messages.reduce((total, message) => total + estimateTokens(textOf(message)), 0);
}

export type CompactionResult<T> = {
  messages: T[];
  /** 被省略的消息条数（0 = 没有压缩）。 */
  dropped: number;
  tokensBefore: number;
  tokensAfter: number;
};

/**
 * 按预算裁剪消息列表：
 * - 第一条消息一定是任务陈述，永远保留（丢了模型就不知道要干什么）；
 * - 从后往前保留，直到接近预算；
 * - 中间被省略的部分换成一条说明消息，明确告诉模型"这里断过"。
 *
 * 预算默认按上下文的 60% 算（其余留给系统提示、工具定义和模型的回答）。
 */
export function compactMessages<T extends MessageLike>(
  messages: T[],
  budgetTokens: number,
  placeholder: (dropped: number) => T,
): CompactionResult<T> {
  const tokensBefore = estimateMessagesTokens(messages);
  if (messages.length <= 3 || tokensBefore <= budgetTokens) {
    return { messages, dropped: 0, tokensBefore, tokensAfter: tokensBefore };
  }

  const head = messages[0]!;
  const headTokens = estimateTokens(textOf(head));
  let used = headTokens;
  const kept: T[] = [];
  for (let index = messages.length - 1; index >= 1; index -= 1) {
    const message = messages[index]!;
    const cost = estimateTokens(textOf(message));
    // 至少保留最后 4 条（否则模型看不到刚刚发生了什么）。
    if (kept.length >= 4 && used + cost > budgetTokens) break;
    kept.unshift(message);
    used += cost;
  }

  // 尾部不能以「工具结果」开头：它的 tool_call 已经被裁掉了，
  // 真实的 OpenAI 兼容服务会因此直接 400（tool 消息必须紧跟带 tool_calls 的助手消息）。
  while (kept.length > 1 && kept[0]?.role === "tool") kept.shift();

  const dropped = messages.length - kept.length - 1;
  if (dropped <= 0) {
    return { messages, dropped: 0, tokensBefore, tokensAfter: tokensBefore };
  }
  const compacted = [head, placeholder(dropped), ...kept];
  return {
    messages: compacted,
    dropped,
    tokensBefore,
    tokensAfter: estimateMessagesTokens(compacted),
  };
}
