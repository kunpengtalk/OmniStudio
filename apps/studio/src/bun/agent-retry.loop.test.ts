/**
 * 自愈逻辑与**内核契约**的对接测试。
 *
 * 前面那些用例只验证了判据与文案；这里用假模型流真跑一遍 `Agent`，
 * 钉住两件我们依赖的内核行为：
 *
 * 1. `shouldStopAfterTurn` 返回 false + `agent.followUp()` → 循环会真的再跑一轮
 *    （空回合自愈的实现基础）；
 * 2. 摘掉末尾那条失败的空壳助手消息之后，`agent.continue()` 能正常发起下一次请求
 *    （失败重发的实现基础）。
 *
 * 内核升级时这两条如果变了，这里会先炸 —— 而不是等用户看到"停止没用 / 白跑一轮"。
 */
import { describe, expect, test } from "bun:test";
import { Agent } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
} from "@earendil-works/pi-ai";

import { attachTurnRecovery, dropTrailingFailures, isRetryableTurnFailure } from "./agent-retry";

const MODEL = {
  id: "fake",
  name: "fake",
  api: "openai-completions",
  provider: "omni-studio",
  baseUrl: "http://127.0.0.1:1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
} as unknown as Model<string>;

/** 一轮的剧本：要么答一段正文，要么以某个错误结束。 */
type Script = { text: string } | { error: string };

function message(input: Script, text: string): AssistantMessage {
  const failed = "error" in input;
  return {
    role: "assistant",
    content: failed ? [] : [{ type: "text", text }],
    api: "openai-completions",
    provider: "omni-studio",
    model: "fake",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } as never,
    stopReason: failed ? "error" : "stop",
    errorMessage: failed ? input.error : undefined,
    timestamp: Date.now(),
  } as AssistantMessage;
}

/** 假 streamFn：按剧本依次返回，调用次数记在 calls 里。 */
function fakeStream(
  scripts: Script[],
  calls: { count: number },
  sink: AssistantMessage[],
): unknown {
  return () => {
    const script = scripts[Math.min(calls.count, scripts.length - 1)]!;
    calls.count += 1;
    const stream = createAssistantMessageEventStream();
    const final = message(script, "text" in script ? script.text : "");
    sink.push(final);
    const done: AssistantMessageEvent =
      "error" in script
        ? { type: "error", reason: "error", error: final }
        : { type: "done", reason: "stop", message: final };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: final });
      stream.push(done);
    });
    return stream as never;
  };
}

const buildAgent = (scripts: Script[], calls: { count: number }, sink: AssistantMessage[]) =>
  new Agent({
    streamFn: fakeStream(scripts, calls, sink) as never,
    initialState: { model: MODEL, systemPrompt: "你是测试用助手", tools: [], messages: [] },
  });

describe("空回合自愈（内核契约）", () => {
  test("空回合会注入提醒并继续，直到模型真的给出结论", async () => {
    const calls = { count: 0 };
    const sink: AssistantMessage[] = [];
    const agent = buildAgent([{ text: "" }, { text: "这次答了" }], calls, sink);
    const nudges: number[] = [];
    attachTurnRecovery(agent, {
      steps: () => 0,
      maxSteps: 10,
      budget: 2,
      onNudge: (attempt) => nudges.push(attempt),
    });

    await agent.prompt("做点事");

    expect(calls.count).toBe(2);
    expect(nudges).toEqual([1]);
    // 提醒是作为 harness 消息进上下文的（模型下一轮才看得见），并且标注了不是用户发言。
    const nudge = agent.state.messages.find(
      (item) =>
        item.role === "user" && JSON.stringify(item.content).includes("系统消息，不是用户发言"),
    );
    expect(nudge).toBeDefined();
  });

  test("一路空到底：提醒用完就放手（不会无限要它说话）", async () => {
    const calls = { count: 0 };
    const agent = buildAgent([{ text: "" }], calls, []);
    const nudges: number[] = [];
    attachTurnRecovery(agent, {
      steps: () => 0,
      maxSteps: 10,
      budget: 2,
      onNudge: (attempt) => nudges.push(attempt),
    });

    await agent.prompt("做点事");

    expect(nudges).toEqual([1, 2]);
    expect(calls.count).toBe(3); // 首轮 + 两次提醒
  });

  test("预算为 0（用户关掉自愈）时一次都不提醒", async () => {
    const calls = { count: 0 };
    const agent = buildAgent([{ text: "" }], calls, []);
    attachTurnRecovery(agent, { steps: () => 0, maxSteps: 10, budget: 0, onNudge: () => {} });

    await agent.prompt("做点事");

    expect(calls.count).toBe(1);
  });

  test("步数到顶优先于提醒：先停，不再多跑一轮", async () => {
    const calls = { count: 0 };
    const agent = buildAgent([{ text: "" }], calls, []);
    attachTurnRecovery(agent, { steps: () => 5, maxSteps: 5, budget: 2, onNudge: () => {} });

    await agent.prompt("做点事");

    expect(calls.count).toBe(1);
  });
});

describe("失败重发（内核契约）", () => {
  test("错误回合之后：摘掉空壳 + continue() 能接着跑出结论", async () => {
    const calls = { count: 0 };
    const sink: AssistantMessage[] = [];
    const agent = buildAgent(
      [{ error: "503 Service Unavailable" }, { text: "重试之后答上了" }],
      calls,
      sink,
    );

    await agent.prompt("做点事");
    const failed = agent.state.messages[agent.state.messages.length - 1]!;
    expect(isRetryableTurnFailure(failed as never)).toBe(true);

    // 这就是 runAgentTurn 里做的两步：摘掉失败消息 → continue()。
    agent.state.messages = dropTrailingFailures(agent.state.messages as never[]) as never;
    expect(agent.state.messages.some((item) => item.role === "assistant")).toBe(false);
    await agent.continue();

    expect(calls.count).toBe(2);
    const last = agent.state.messages[agent.state.messages.length - 1] as { content?: unknown };
    expect(JSON.stringify(last.content)).toContain("重试之后答上了");
  });

  test("不摘就直接 continue()：内核会拒绝（说明这一步不是多余的）", async () => {
    const calls = { count: 0 };
    const agent = buildAgent([{ error: "503 Service Unavailable" }], calls, []);
    await agent.prompt("做点事");
    await expect(agent.continue()).rejects.toThrow(/assistant/i);
  });
});
