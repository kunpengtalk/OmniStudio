/**
 * 一条助手消息的用量统计：把「这次生成花了多少、多快」算成可展示、可持久化的形状。
 *
 * 聊天与 Agent 两条路径的 token 来源不同（前者一次请求，后者跨多步累积 usage），
 * 但展示口径必须一致，所以算法只写在这里：
 *
 * - **生成速度**（卡片里的「模型生成」/ 底部的 `Token/秒`）只算解码窗口 ——
 *   首 token 之后到结束。把预填充与网络往返算进去的话，本地长上下文会显得
 *   比实际慢好几倍，用户拿它跟基准测试对照时会以为哪里出错了。
 * - **端到端吞吐**才是输出 tokens / 总耗时，Agent 回合里它还包含工具执行时间。
 *
 * 服务端给了 `usage` 就是实测值，没有（关掉 usage 的网关、老版本 llama.cpp）
 * 就退回本地估算，`source` 如实标注，界面上不把估算说成实测。
 */
export type TokenStatsSource = "usage" | "estimate" | "mixed";

/**
 * 可持久化的统计快照（挂在助手消息上）。
 * 不含 conversationId / messageId（消息行自带）与上下文占用（那是会话级的）。
 */
export type MessageStats = {
  /** 输出（生成）tokens —— 字段名沿用 `messages.tokens`，老前端读它不会读空。 */
  tokens: number;
  /** 生成窗口吞吐（首 token 之后的纯解码速度，tok/s）。 */
  tokensPerSec: number;
  /** 端到端耗时（毫秒）。 */
  elapsedMs: number;
  /** 输入 tokens。 */
  inputTokens?: number;
  /** 输出 tokens（与 tokens 同值，语义更明确的别名）。 */
  outputTokens?: number;
  /** 思考 tokens（推理模型才有）。 */
  reasoningTokens?: number;
  /** 命中缓存 / 复用的输入 tokens（服务端给得出时才有）。 */
  cachedTokens?: number;
  /** 首 token 耗时（毫秒，本地实测）。 */
  ttftMs?: number;
  /** 纯生成耗时（毫秒，首 token → 结束；Agent 回合里不含工具执行时间）。 */
  generationMs?: number;
  /** 端到端吞吐（输出 tokens / 总耗时）。 */
  endToEndTokensPerSec?: number;
  source: TokenStatsSource;
  /** 模型展示名与来源（本地引擎名 / 云端厂商名），详情卡片标题用。 */
  model?: string;
  provider?: string;
  /** Agent 回合：步数与工具调用次数。 */
  steps?: number;
  toolCalls?: number;
};

export type TokenStatsInput = {
  /** 输入 tokens；没有实测值时传 undefined，由调用方决定是否估算后传入。 */
  inputTokens?: number;
  outputTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  elapsedMs: number;
  /** 首 token 耗时；拿不到（一个 token 都没出）传 null。 */
  ttftMs?: number | null;
  /** 纯生成耗时；缺省按 elapsedMs - ttftMs 算。 */
  generationMs?: number | null;
  source: TokenStatsSource;
  model?: string;
  provider?: string;
  steps?: number;
  toolCalls?: number;
};

/** 一位小数：吞吐量展示不需要更高精度，多出来的位数只会让卡片宽度跳。 */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function computeTokenStats(input: TokenStatsInput): MessageStats {
  const elapsedMs = Math.max(1, Math.round(input.elapsedMs));
  const outputTokens = Math.max(0, Math.round(input.outputTokens));
  // 首 token 耗时不可能超过总耗时：流被中断时可能量到更大的值，夹一下更可信。
  const ttftMs =
    input.ttftMs == null ? null : Math.max(0, Math.min(elapsedMs, Math.round(input.ttftMs)));
  const generationMs = Math.max(
    1,
    Math.round(input.generationMs ?? (ttftMs == null ? elapsedMs : elapsedMs - ttftMs)),
  );

  return {
    tokens: outputTokens,
    outputTokens,
    tokensPerSec: round1(outputTokens / (generationMs / 1000)),
    endToEndTokensPerSec: round1(outputTokens / (elapsedMs / 1000)),
    elapsedMs,
    ...(ttftMs == null ? {} : { ttftMs }),
    generationMs,
    ...(input.inputTokens == null ? {} : { inputTokens: Math.max(0, Math.round(input.inputTokens)) }),
    ...(input.reasoningTokens == null
      ? {}
      : { reasoningTokens: Math.max(0, Math.round(input.reasoningTokens)) }),
    ...(input.cachedTokens == null
      ? {}
      : { cachedTokens: Math.max(0, Math.round(input.cachedTokens)) }),
    source: input.source,
    ...(input.model ? { model: input.model } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.steps == null ? {} : { steps: input.steps }),
    ...(input.toolCalls == null ? {} : { toolCalls: input.toolCalls }),
  };
}

/** 解析消息行里持久化的统计 JSON；坏数据一律当作"没有统计"，不让界面炸。 */
export function parseMessageStats(raw: string | null | undefined): MessageStats | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as Partial<MessageStats>;
    if (typeof value.tokens !== "number" || typeof value.tokensPerSec !== "number") return null;
    return {
      ...value,
      tokens: value.tokens,
      tokensPerSec: value.tokensPerSec,
      elapsedMs: typeof value.elapsedMs === "number" ? value.elapsedMs : 0,
      source: value.source ?? "usage",
    } as MessageStats;
  } catch {
    return null;
  }
}
