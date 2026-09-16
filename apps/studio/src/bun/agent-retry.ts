/**
 * 一轮失败之后能不能自己缓过来（对齐 OMP 的 retry classifier / empty-stop-retry）。
 *
 * 为什么需要：pi-agent-core 的契约是「失败不抛异常」—— 请求出错会被编码成一条
 * `stopReason = "error"` 的助手消息，从外面看和「答完了、只是什么都没说」一模一样
 * （见 `agent-outcome.ts` 的说明）。那边负责把这类收尾判出来给用户看；这里再往前一步：
 * **能自愈的就别让用户重发一次**。
 *
 * 分两层，便宜的在前面：
 *
 * 1. **传输层**（内核白送）：`StreamOptions.maxRetries` 交给 pi-ai 的
 *    `retryProviderRequest` —— 408/409/429/5xx 与网络错误按指数退避重试，
 *    遵守服务端的 `retry-after`、带 75–100% 抖动。本地推理服务「模型还在加载」
 *    时返回的 503 正好落在这一层，用户几乎无感。
 * 2. **回合层**（本文件）：整轮以可重试的错误结束时，丢掉那条空壳助手消息、
 *    用 `agent.continue()` 拿着同一条上下文再发一次；以及「空回合」（既没有正文
 *    也没有工具调用）时注入一条 harness 提示，让它重新决定要不要干活。
 *
 * 判据全部来自 pi-ai 的 `isRetryableAssistantError`：它按几十条厂商错误文本分类
 * （瞬时 / 限流 / 网络 / 流中断），并**排除**配额与计费类错误 —— 那些再试多少次
 * 都一样，属于「该换模型」而不是「该重试」。
 */
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";

/** 只看这几个字段，便于单测喂普通对象。 */
type RoughMessage = {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
  usage?: { output?: number };
};

/** 自动重试的次数上限（设置 `AGENT_RETRY_MAX`，0 = 关掉全部自愈）。 */
export const DEFAULT_RETRY_ATTEMPTS = 2;
/** 空回合最多提醒几次：本地小模型偶尔会把"我该说什么"也省掉，提醒一次多半能接着干。 */
export const MAX_EMPTY_TURN_NUDGES = 2;

/** 退避：800ms 起，翻倍，8s 封顶（与内核的传输层退避同一个量级）。 */
export function retryBackoffMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(8_000, 800 * 2 ** (n - 1));
}

/** 能不能重试：只有"错误形态 + 判据认为可恢复"才算，被中断的轮次永远不重试。 */
export function isRetryableTurnFailure(message: RoughMessage | undefined): boolean {
  if (!message || message.role !== "assistant") return false;
  if (message.stopReason !== "error") return false;
  return isRetryableAssistantError(message as never);
}

/**
 * 空回合：助手消息既没有正文，也没有工具调用就结束了。
 *
 * 出错 / 被中断的轮次不算空回合（那是另一条路径，见 `isRetryableTurnFailure`），
 * 也不该被当成"它说完了"—— 界面上就是一个空白气泡。
 */
export function isEmptyAssistantTurn(message: RoughMessage | undefined): boolean {
  if (!message || message.role !== "assistant") return false;
  const stop = message.stopReason;
  if (stop === "error" || stop === "aborted") return false;
  const content = Array.isArray(message.content) ? message.content : [];
  return !content.some((block) => {
    const part = block as { type?: string; text?: string };
    if (part?.type === "toolCall") return true;
    if (part?.type === "text") return typeof part.text === "string" && part.text.trim().length > 0;
    return false;
  });
}

/**
 * 长度钳制型空回合：`stopReason = length` 且输出 ≤ 1 token（拿不到 usage 时按是算）。
 *
 * 这不是「模型不想说话」，而是请求侧把 max_tokens 压到了下限 —— 典型根因是
 * 上下文窗口配置（contextWindow）小于系统提示 + 工具定义 + 安全垫，pi-ai 的
 * `clampMaxTokensToContext` 一算负数就钳到 `MIN_MAX_TOKENS = 1`。提醒它继续
 * 没有意义（重发一次算术还是同一条），自愈循环应当直接交出去，让外层给出
 * 指向配置的诊断（`agent-outcome.ts` 的 `lengthClamped`）。
 */
export function isLengthClampedTurn(message: RoughMessage | undefined): boolean {
  if (!message || message.role !== "assistant") return false;
  if (message.stopReason !== "length") return false;
  const output = message.usage?.output;
  return output == null || output <= 1;
}

/** 消息数组里最后一条助手消息（没有则 undefined）。 */
export function lastAssistantMessage<T extends RoughMessage>(messages: T[]): T | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

/**
 * 重试前把末尾那条失败的空壳助手消息摘掉。
 *
 * 必须摘：`agent.continue()` 要求最后一条是 user / toolResult（内核会直接抛
 * "Cannot continue from message role: assistant"），而且线上协议里带着一条
 * 空助手消息重发也没有意义 —— 模型会把它当成"我说过话"。
 *
 * 保守起见只在末尾连续出现时摘，且只摘 error / aborted 形态的：正常答完的
 * 助手消息永远不动（那可能是这一轮的结论）。
 */
export function dropTrailingFailures<T extends RoughMessage>(messages: T[]): T[] {
  let end = messages.length;
  while (end > 0) {
    const message = messages[end - 1];
    if (!message || message.role !== "assistant") break;
    if (message.stopReason !== "error" && message.stopReason !== "aborted") break;
    end -= 1;
  }
  return end === messages.length ? messages : messages.slice(0, end);
}

/** 失败原因（给轨迹与日志看的一行，太长截断）。 */
export function failureReasonOf(message: RoughMessage | undefined, max = 300): string {
  const raw = message?.errorMessage?.trim();
  if (!raw) return "未给出原因";
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

/** 轨迹里那条"自动重试"的说明（用户滚回去要看得懂它为什么又发了一次）。 */
export function retryNoticeText(opts: { attempt: number; max: number; reason: string }): string {
  return (
    `第 ${opts.attempt}/${opts.max} 次自动重试：上一轮请求失败（${opts.reason}）。` +
    "这是瞬时错误，已按同一段上下文重新发起；如果反复出现，请在控制台确认推理服务是否正常。"
  );
}

/** 空回合提醒的那条消息（标明是 harness 消息，见 `emptyTurnNudgeText`）。 */
export function nudgeMessage(attempt: number): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text" as const, text: emptyTurnNudgeText(attempt) }],
    timestamp: Date.now(),
  } as AgentMessage;
}

/**
 * 空回合自愈（对齐 OMP 的 empty-stop-retry）：
 * 助手既没给正文、也没调工具就停下来时，注入一条 harness 提醒让它重新决定，
 * 而不是直接把这轮交出去（界面上那会是一个空白气泡）。
 *
 * 用内核的 followUp 队列实现，**没有另起一轮**：`shouldStopAfterTurn` 里返回 false
 * 并在队列里放一条消息，循环会在"本来要停"的那一刻把它取出来接着跑 ——
 * 提醒只活在这次运行里，不会在会话里多出一条用户消息，也不会再走一遍落库。
 *
 * 提醒次数受自愈预算约束（`AGENT_RETRY_MAX`）：模型要是一路空到底，提醒几次就放手，
 * 免得把窗口和推理时间浪费在"求它说话"上。
 *
 * 这条实现依赖的内核契约（`agent-retry.loop.test.ts` 用假模型流钉住了）：
 * `shouldStopAfterTurn` 返回 false 之后，内层循环结束前会 drain followUp 队列，
 * 队列非空就继续下一轮。
 */
export function attachTurnRecovery(
  agent: Agent,
  opts: {
    steps: () => number;
    maxSteps: number;
    budget: number;
    onNudge: (attempt: number) => void;
  },
): void {
  let nudges = 0;
  agent.shouldStopAfterTurn = (context) => {
    if (opts.steps() >= opts.maxSteps) return true;
    if (!isEmptyAssistantTurn(context.message as never)) return false;
    // 长度钳制型空回合：提醒无济于事（重发的 max_tokens 还是会被钳到 1），
    // 直接交出去，外层 classifyTurnOutcome 会给出指向配置的诊断文案。
    if (isLengthClampedTurn(context.message as never)) return true;
    if (nudges >= opts.budget) return false;
    nudges += 1;
    opts.onNudge(nudges);
    agent.followUp(nudgeMessage(nudges));
    return false;
  };
}

/**
 * 空回合的提醒文案。
 *
 * 明确标注是**harness 消息**而不是用户发言 —— 否则模型容易把它当成新需求去理解，
 * 或者在正文里回答"好的我继续"然后又不干活（OMP 的 empty-stop-retry 同样标注）。
 */
export function emptyTurnNudgeText(attempt: number): string {
  const lines = [
    "（系统消息，不是用户发言）你上一回合既没有给出正文，也没有调用任何工具就结束了，用户那边看到的是一个空白气泡。",
  ];
  if (attempt <= 1) {
    lines.push(
      "现在重新决定一次：任务还没做完就先做一个**实际动作**（读文件 / 搜代码 / 跑命令），不要只在脑子里想；",
      "任务已经做完就直接把结论写出来（做了什么、结果如何、还剩什么没做）。",
      "不要复述这条消息，也不要回复「好的」这类空话。",
    );
  } else {
    lines.push(
      "这是最后一次提醒：要么现在调一个工具，要么用一两句话把结论说清楚（哪怕只是「这一步做不了，因为…」）。",
      "如果确实无事可做，就直接说明原因。",
    );
  }
  return lines.join("\n");
}
