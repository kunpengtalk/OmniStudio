/**
 * 一轮 Agent 跑完之后，该给用户一个什么交代。
 *
 * pi-agent-core 的 StreamFn 契约写得很清楚：**失败不许抛异常** —— 模型请求出错、
 * 被中断，都会被编码成一条 stopReason = "error" | "aborted" 的助手消息，然后
 * `agent.prompt()` 照常 resolve（见 pi-agent-core `handleRunFailure`）。
 *
 * 换句话说：一次失败的请求，从调用方看和"模型答完了、只是什么都没说"长得一模一样。
 * 不主动认领这个状态，用户看到的就是「任务跑了一半 → 没有产出 → 也没有任何报错」。
 * 这里把这几种收尾状态判出来，交给 agent.ts 落成事件与可见提示。
 */
export type TurnOutcome =
  | { kind: "ok" }
  /** 既没有正文也没有工具调用就结束了：界面会是一个空白气泡，必须补一句说明。
   * `lengthClamped` = stopReason=length 且输出 ≤ 1 token：请求侧把 max_tokens 钳到了
   * 下限（典型根因：上下文窗口配置小于系统提示 + 工具定义 + 安全垫），重试无济于事，
   * agent.ts 会给出指向配置的诊断文案而不是通用的「模型/推理服务的问题」。 */
  | { kind: "empty"; lengthClamped?: boolean; lastOutputTokens?: number }
  | { kind: "aborted"; detail: string }
  | { kind: "error"; detail: string };

export function classifyTurnOutcome(input: {
  /** `agent.state.errorMessage`：本轮失败 / 被中断时的错误文本。 */
  errorMessage?: string;
  /** 最后一条助手消息的 stopReason，用来区分"被中断"和"真出错"。 */
  lastStopReason?: string;
  /** 最后一条助手消息的输出 token 数（判「length 且几乎没生成」用，可能拿不到）。 */
  lastOutputTokens?: number;
  /** 本轮累计的正文（思考内容不算）是否非空。 */
  hasText: boolean;
  /** 是否因为到达步数上限而停止 —— 那种情况 agent.ts 另有提示，不重复。 */
  reachedStepLimit: boolean;
}): TurnOutcome {
  const detail = input.errorMessage?.trim() ?? "";
  if (detail) {
    const aborted = input.lastStopReason === "aborted" || /abort/i.test(detail);
    return aborted ? { kind: "aborted", detail } : { kind: "error", detail };
  }
  if (input.hasText || input.reachedStepLimit) return { kind: "ok" };
  const lengthClamped =
    input.lastStopReason === "length" && (input.lastOutputTokens == null || input.lastOutputTokens <= 1);
  return lengthClamped
    ? { kind: "empty", lengthClamped: true, lastOutputTokens: input.lastOutputTokens }
    : { kind: "empty" };
}
