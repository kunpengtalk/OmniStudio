/**
 * 粗略 token 估算：CJK 约 1 token/字，英文约 1 token/4 字符。
 *
 * 主进程（上下文压缩阈值、没有 usage 元数据时的用量展示）与 webview
 * （流式过程中的实时速度）都用它 —— 两边必须是同一套口径，否则「生成中」
 * 的数字和收尾后的实测值会差得让人以为是 bug。放在 shared 里两边都能 import
 * （不依赖 electrobun / db）。
 */
/**
 * 把文本拆成「CJK 字符数」与「其他字符数」两笔。
 *
 * 分开计数是为了**累加**：流式过程中每个增量单独 `estimateTokens` 会各自向上取整，
 * 一秒几十个增量下来能把总数抬高一大截。累计字符、最后再折算就不会有这个偏差。
 */
export function tokenParts(text: string): { cjk: number; other: number } {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    // CJK / 假名 / 谚文 / 全角标点：按 1 字 ≈ 1 token
    if (
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return { cjk, other };
}

/** 累计字符 → token 估算（与 `estimateTokens` 同一口径）。 */
export function tokensFromParts(parts: { cjk: number; other: number }): number {
  if (parts.cjk === 0 && parts.other === 0) return 0;
  return parts.cjk + Math.ceil(parts.other / 4);
}

/** 粗略 token 估算：CJK 约 1 token/字，英文约 1 token/4 字符。 */
export function estimateTokens(text: string): number {
  return tokensFromParts(tokenParts(text));
}

export type MessageLike = {
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

/** 一轮请求体（系统提示 + 全部历史 + 本轮提问）的 token 估算。 */
export function estimateMessagesTokens(messages: MessageLike[]): number {
  return messages.reduce((total, message) => total + estimateTokens(textOf(message)), 0);
}
