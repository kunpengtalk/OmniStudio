/**
 * 历史回填单测：工具调用与结果的配对、截断、以及"每个 toolCall 都要有结果"这条
 * 会直接导致 400 的硬约束。
 */
import { describe, expect, test } from "bun:test";

import type { AgentEventRow } from "./agent";
import {
  buildHistoryMessages,
  dropCurrentPrompt,
  MAX_HISTORY_TOOL_RESULT_CHARS,
  pairToolEvents,
} from "./agent-history";

const meta = { model: "test-model", provider: "omni-studio", api: "openai-completions" };

let nextId = 1;
const event = (
  partial: Partial<AgentEventRow> & Pick<AgentEventRow, "kind" | "toolName">,
): AgentEventRow => ({
  id: nextId++,
  conversationId: 1,
  messageId: 10,
  args: null,
  output: null,
  isError: 0,
  subagentId: null,
  createdAt: 1_700_000_000_000,
  ...partial,
});

const history = [
  { id: 1, role: "user", content: "把项目跑起来", createdAt: 1 },
  { id: 10, role: "assistant", content: "已经跑起来了", createdAt: 2 },
];

describe("pairToolEvents", () => {
  test("start / end 按工具名配对，输出与错误标记带到调用上", () => {
    const calls = pairToolEvents([
      event({ kind: "tool_start", toolName: "read_file", args: '{"path":"a.ts"}' }),
      event({ kind: "tool_end", toolName: "read_file", output: "文件内容" }),
    ]).get(10)!;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("read_file");
    expect(calls[0]!.args).toEqual({ path: "a.ts" });
    expect(calls[0]!.result).toBe("文件内容");
    expect(calls[0]!.isError).toBe(false);
  });

  test("同名工具并行调用时按后进先出配对（结果顺序不保证）", () => {
    const calls = pairToolEvents([
      event({ kind: "tool_start", toolName: "grep", args: '{"pattern":"one"}' }),
      event({ kind: "tool_start", toolName: "grep", args: '{"pattern":"two"}' }),
      event({ kind: "tool_end", toolName: "grep", output: "结果 B" }),
      event({ kind: "tool_end", toolName: "grep", output: "结果 A" }),
    ]).get(10)!;
    expect(calls[0]!.args).toEqual({ pattern: "one" });
    expect(calls[0]!.result).toBe("结果 A");
    expect(calls[1]!.args).toEqual({ pattern: "two" });
    expect(calls[1]!.result).toBe("结果 B");
  });

  test("子智能体内部的事件不进主 Agent 的历史", () => {
    const map = pairToolEvents([
      event({ kind: "tool_start", toolName: "read_file", subagentId: "abc12345" }),
      event({
        kind: "tool_end",
        toolName: "read_file",
        output: "子智能体读到的",
        subagentId: "abc12345",
      }),
    ]);
    expect(map.size).toBe(0);
  });

  test("只认工具事件：授权 / 状态 / 提问都不算工具调用", () => {
    const map = pairToolEvents([
      event({ kind: "status", toolName: "permission_request" }),
      event({ kind: "status", toolName: "permission" }),
    ]);
    expect(map.size).toBe(0);
  });

  test("坏掉的 args（不是 JSON）退化成空对象而不是抛错", () => {
    const calls = pairToolEvents([
      event({ kind: "tool_start", toolName: "bash", args: "{不是 JSON" }),
      event({ kind: "tool_end", toolName: "bash", output: "ok" }),
    ]).get(10)!;
    expect(calls[0]!.args).toEqual({});
  });
});

describe("buildHistoryMessages", () => {
  test("带工具调用的助手消息被拆成「调用 → 结果 → 正文」", () => {
    const messages = buildHistoryMessages(
      history,
      [
        event({ kind: "tool_start", toolName: "read_file", args: '{"path":"a.ts"}' }),
        event({ kind: "tool_end", toolName: "read_file", output: "export const a = 1;" }),
      ],
      meta,
    );
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    // 第一条助手消息只带调用，带正文的那条在结果之后
    expect(messages[1]!.content[0]).toMatchObject({ type: "toolCall", name: "read_file" });
    expect(messages[1]!.stopReason).toBe("toolUse");
    expect(messages[3]!.content[0]).toMatchObject({ type: "text", text: "已经跑起来了" });
    expect(messages[3]!.stopReason).toBe("stop");
  });

  test("每个 toolCall 都有对应的 toolResult（缺了真实服务会 400）", () => {
    const messages = buildHistoryMessages(
      history,
      [
        event({ kind: "tool_start", toolName: "bash", args: '{"command":"ls"}' }),
        event({ kind: "tool_start", toolName: "read_file", args: '{"path":"a.ts"}' }),
        event({ kind: "tool_end", toolName: "read_file", output: "内容" }),
      ],
      meta,
    );
    const calls = messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) =>
        message.content.filter((block) => (block as { type?: string }).type === "toolCall"),
      );
    const results = messages.filter((message) => message.role === "toolResult");
    expect(calls).toHaveLength(2);
    expect(results).toHaveLength(2);
    // 没等到结果的那次调用拿到一条合成说明，而不是留空
    const ids = new Set(results.map((message) => message.toolCallId));
    for (const call of calls) expect(ids.has((call as { id: string }).id)).toBe(true);
    expect(JSON.stringify(results)).toContain("回合被中断");
  });

  test("工具输出被截断（历史原样回填会把 8k 窗口吃光）", () => {
    const huge = "x".repeat(MAX_HISTORY_TOOL_RESULT_CHARS + 5_000);
    const messages = buildHistoryMessages(
      history,
      [
        event({ kind: "tool_start", toolName: "bash" }),
        event({ kind: "tool_end", toolName: "bash", output: huge }),
      ],
      meta,
    );
    const result = messages.find((message) => message.role === "toolResult")!;
    const text = (result.content[0] as { text: string }).text;
    expect(text.length).toBeLessThan(huge.length);
    expect(text).toContain("已被截断保存");
  });

  test("没有工具调用的会话与以前一样：只有 user / assistant 正文", () => {
    const messages = buildHistoryMessages(history, [], meta);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  test("空正文的用户消息被跳过（不往历史里塞空回合）", () => {
    const messages = buildHistoryMessages(
      [...history, { id: 11, role: "assistant", content: "   ", createdAt: 3 }],
      [],
      meta,
    );
    expect(messages).toHaveLength(2);
  });

  test("回填的助手消息带 0 用量（别让占用条把它当成实测值）", () => {
    const messages = buildHistoryMessages(history, [], meta);
    const assistant = messages.find((message) => message.role === "assistant")!;
    expect((assistant.usage as { totalTokens: number }).totalTokens).toBe(0);
  });
});

describe("建会话时的历史回填", () => {
  test("末尾那条用户消息就是本轮的 prompt，要摘掉（否则任务会重复一遍）", () => {
    const rows = [
      { id: 1, role: "user", content: "第一轮的问题" },
      { id: 2, role: "assistant", content: "第一轮的回答" },
      { id: 3, role: "user", content: "本轮的问题（马上要作为 prompt 发出去）" },
    ];
    expect(dropCurrentPrompt(rows).map((row) => row.id)).toEqual([1, 2]);
  });

  test("末尾不是用户消息时原样返回（重新生成 / 无人值守那条路径）", () => {
    const rows = [
      { id: 1, role: "user", content: "问题" },
      { id: 2, role: "assistant", content: "回答" },
    ];
    expect(dropCurrentPrompt(rows)).toHaveLength(2);
    expect(dropCurrentPrompt([])).toHaveLength(0);
  });
});
