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
 *
 * token 估算本身住在 `shared/token-estimate.ts`：webview 的流式实时速度用的是
 * 同一套口径，两边不能各写一份。这里原样再导出，老的 import 路径继续可用。
 */
import { estimateMessagesTokens } from "../shared/token-estimate";
export { estimateMessagesTokens, estimateTokens } from "../shared/token-estimate";
/** 压缩结果：新消息数组 + 被省略的条数与压缩前后的估算 token 数。 */
export type CompactionResult<T> = {
  messages: T[];
  /** 被省略的消息条数（0 = 没有压缩）。 */
  dropped: number;
  tokensBefore: number;
  tokensAfter: number;
};

/**
 * 压缩只关心「角色 + 正文」，所以约束放宽到这两个字段就够。
 * 用 type alias（不是 interface）是为了吃到隐式索引签名，好接住 AgentMessage 这类
 * 带联合成员的窄类型 —— 否则调用点得先 `as unknown as` 一层，很容易被后人删掉。
 */
type RoughMessage = { role?: string; content?: unknown };

/** 工具结果消息：`transformContext` 里是 `toolResult`，线上协议里是 `tool`。 */
function isToolResult(message: RoughMessage | undefined): boolean {
  return message?.role === "toolResult" || message?.role === "tool";
}

/**
 * 按预算裁剪消息列表：
 * - 第一条消息一定是任务陈述，永远保留（丢了模型就不知道要干什么）；
 * - 从后往前保留，直到接近预算；
 * - 中间被省略的部分换成一条说明消息，明确告诉模型"这里断过"。
 *
 * 预算默认按上下文的 60% 算（其余留给系统提示、工具定义和模型的回答）。
 */
export function compactMessages<T extends RoughMessage>(
  messages: T[],
  budgetTokens: number,
  placeholder: (dropped: number) => T,
): CompactionResult<T> {
  const tokensBefore = estimateMessagesTokens(messages);
  if (messages.length <= 3 || tokensBefore <= budgetTokens) {
    return { messages, dropped: 0, tokensBefore, tokensAfter: tokensBefore };
  }

  const head = messages[0]!;
  const headTokens = estimateMessagesTokens([head]);
  let used = headTokens;
  const kept: T[] = [];
  for (let index = messages.length - 1; index >= 1; index -= 1) {
    const message = messages[index]!;
    const cost = estimateMessagesTokens([message]);
    // 至少保留最后 4 条（否则模型看不到刚刚发生了什么）。
    if (kept.length >= 4 && used + cost > budgetTokens) break;
    kept.unshift(message);
    used += cost;
  }

  // 尾部不能以「工具结果」开头：它的 tool_call 已经被裁掉了，
  // 真实的 OpenAI 兼容服务会因此直接 400（tool 消息必须紧跟带 tool_calls 的助手消息）。
  // 注意角色名：`transformContext` 拿到的是 AgentMessage，工具结果在这里叫 `toolResult`；
  // 线上协议里才叫 `tool`。两个都认，免得哪天又只匹配到其中一个。
  while (kept.length > 1 && isToolResult(kept[0])) kept.shift();

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

/**
 * 「按路径复用」的工具：同一路径的旧结果可以被更新的结果取代。
 * 只收 **幂等且按路径取值** 的读工具 —— `grep` / `glob` 每次参数不同，结果互不取代。
 */
const PATH_KEYED_READ_TOOLS = new Set(["read_file", "list_dir"]);

/** 低于这个省下的量不值得动手：占位文本自己也要花 token。 */
const MIN_PRUNE_TOKENS = 200;

export type PruneResult<T> = {
  messages: T[];
  /** 被替换成占位的工具结果条数（0 = 没有可省）。 */
  pruned: number;
  tokensSaved: number;
};

function readKey(name: string, args: unknown): string | null {
  if (!PATH_KEYED_READ_TOOLS.has(name)) return null;
  if (!args || typeof args !== "object") return null;
  const path = (args as Record<string, unknown>).path;
  return typeof path === "string" && path ? `${name}\u0000${path}` : null;
}

/** 整份读取（没有 offset / limit）才敢说"旧的那份没有信息量了"。 */
function isWholeRead(name: string, args: unknown): boolean {
  if (name !== "read_file") return true;
  const record = (args ?? {}) as Record<string, unknown>;
  return record.offset == null && record.limit == null;
}

/**
 * 把「同一份文件更早的读取结果」换成占位，不调模型、不改顺序、不删消息。
 *
 * 为什么需要：本地窗口只有 8k，而 Agent 很爱把同一个文件读上三四遍
 * （改一行 → 重读 → 再改 → 再读）。这些旧副本占了窗口的大头，却没有任何
 * 增量信息 —— 后面那次完整读取已经包含了它们。
 *
 * 安全性来自判据本身：**只有更新的那次是整份读取**时，才认为旧副本可省。
 * 反过来（最新一次只读了 40-60 行）绝不动旧的那次全量读取 —— 那会真的丢内容。
 * 只替换 `content`，消息本身留在原位，工具调用与结果的配对不受影响。
 */
export function pruneSupersededReads<T extends RoughMessage>(
  messages: T[],
  placeholder: (path: string) => string,
): PruneResult<T> {
  if (messages.length < 3) return { messages, pruned: 0, tokensSaved: 0 };

  // 先按 toolCallId 找回每次调用的工具名与参数（结果消息上只有 id 和工具名）。
  const callArgs = new Map<string, { name: string; args: unknown }>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content as { type?: string; id?: string; name?: string; arguments?: unknown }[]) {
      if (part?.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string") {
        callArgs.set(part.id, { name: part.name, args: part.arguments });
      }
    }
  }

  // 从后往前走：记住哪些 key 已经被"更完整的一次读取"覆盖过。
  const covered = new Set<string>();
  const replaceAt = new Map<number, string>();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (!isToolResult(message)) continue;
    const fields = message as { toolName?: unknown; toolCallId?: unknown };
    const toolName = typeof fields.toolName === "string" ? fields.toolName : undefined;
    const toolCallId = typeof fields.toolCallId === "string" ? fields.toolCallId : undefined;
    const call = toolCallId ? callArgs.get(toolCallId) : undefined;
    const name = call?.name ?? toolName;
    if (!name) continue;
    const key = readKey(name, call?.args);
    if (!key) continue;
    if (covered.has(key)) {
      replaceAt.set(index, key.split("\u0000")[1] ?? "");
      continue;
    }
    if (isWholeRead(name, call?.args)) covered.add(key);
  }
  if (replaceAt.size === 0) return { messages, pruned: 0, tokensSaved: 0 };

  const before = estimateMessagesTokens(messages);
  const next = messages.map((message, index) => {
    const path = replaceAt.get(index);
    if (path === undefined) return message;
    return { ...message, content: [{ type: "text", text: placeholder(path) }] } as unknown as T;
  });
  const saved = before - estimateMessagesTokens(next);
  if (saved < MIN_PRUNE_TOKENS) return { messages, pruned: 0, tokensSaved: 0 };
  return { messages: next, pruned: replaceAt.size, tokensSaved: saved };
}

