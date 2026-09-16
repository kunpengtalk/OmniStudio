import { describe, expect, test } from "bun:test";

import {
  dropTrailingFailures,
  emptyTurnNudgeText,
  failureReasonOf,
  isEmptyAssistantTurn,
  isLengthClampedTurn,
  isRetryableTurnFailure,
  lastAssistantMessage,
  retryBackoffMs,
  retryNoticeText,
} from "./agent-retry";

const assistant = (input: {
  stopReason?: string;
  text?: string;
  tool?: boolean;
  error?: string;
  output?: number;
}) => ({
  role: "assistant",
  stopReason: input.stopReason,
  errorMessage: input.error,
  usage: input.output === undefined ? undefined : { output: input.output },
  content: [
    ...(input.text === undefined ? [] : [{ type: "text", text: input.text }]),
    ...(input.tool ? [{ type: "toolCall", id: "c1", name: "read_file", arguments: {} }] : []),
  ],
});

describe("isRetryableTurnFailure", () => {
  test("瞬时错误（503 / 网络中断 / 超时）算可重试", () => {
    for (const error of [
      "503 Service Unavailable",
      "fetch failed",
      "socket hang up",
      "request timed out",
    ]) {
      expect(isRetryableTurnFailure(assistant({ stopReason: "error", error: error }))).toBe(true);
    }
  });

  test("配额 / 计费类错误不重试：再试多少次都一样，属于该换模型", () => {
    expect(
      isRetryableTurnFailure(
        assistant({ stopReason: "error", error: "insufficient_quota: out of budget" }),
      ),
    ).toBe(false);
  });

  test("正常答完、被中断、没有消息都不算可重试", () => {
    expect(isRetryableTurnFailure(assistant({ stopReason: "stop", text: "done" }))).toBe(false);
    expect(isRetryableTurnFailure(assistant({ stopReason: "aborted", error: "aborted" }))).toBe(
      false,
    );
    expect(isRetryableTurnFailure(assistant({ stopReason: "error" }))).toBe(false);
    expect(isRetryableTurnFailure(undefined)).toBe(false);
    expect(isRetryableTurnFailure({ role: "user" })).toBe(false);
  });
});

describe("isEmptyAssistantTurn", () => {
  test("没正文也没工具调用 = 空回合", () => {
    expect(isEmptyAssistantTurn(assistant({ stopReason: "stop" }))).toBe(true);
    expect(isEmptyAssistantTurn(assistant({ stopReason: "stop", text: "   " }))).toBe(true);
  });

  test("有正文或工具调用就不是空回合", () => {
    expect(isEmptyAssistantTurn(assistant({ stopReason: "stop", text: "好" }))).toBe(false);
    expect(isEmptyAssistantTurn(assistant({ stopReason: "toolUse", tool: true }))).toBe(false);
  });

  test("出错 / 被中断另有路径，不算空回合（否则会同时触发两条自愈）", () => {
    expect(isEmptyAssistantTurn(assistant({ stopReason: "error", error: "503" }))).toBe(false);
    expect(isEmptyAssistantTurn(assistant({ stopReason: "aborted", error: "aborted" }))).toBe(
      false,
    );
  });
});

describe("isLengthClampedTurn", () => {
  test("length 且输出 ≤ 1 token = 钳制型（拿不到 usage 也按是算）", () => {
    expect(isLengthClampedTurn(assistant({ stopReason: "length", output: 1 }))).toBe(true);
    expect(isLengthClampedTurn(assistant({ stopReason: "length", output: 0 }))).toBe(true);
    expect(isLengthClampedTurn(assistant({ stopReason: "length" }))).toBe(true);
  });

  test("其他 stopReason、或 length 但确实生成了内容的不算", () => {
    expect(isLengthClampedTurn(assistant({ stopReason: "stop" }))).toBe(false);
    expect(isLengthClampedTurn(assistant({ stopReason: "error", error: "503" }))).toBe(false);
    expect(isLengthClampedTurn(assistant({ stopReason: "length", output: 64 }))).toBe(false);
    expect(isLengthClampedTurn(undefined)).toBe(false);
    expect(isLengthClampedTurn({ role: "user" })).toBe(false);
  });
});

describe("dropTrailingFailures", () => {
  test("摘掉末尾的失败空壳，continue() 才不会因为最后一条是 assistant 而抛", () => {
    const messages = [
      { role: "user", content: "做点事" },
      assistant({ stopReason: "error", error: "503" }),
    ];
    expect(dropTrailingFailures(messages)).toHaveLength(1);
  });

  test("正常答完的助手消息永远不动（那可能是这一轮的结论）", () => {
    const messages = [{ role: "user" }, assistant({ stopReason: "stop", text: "好了" })];
    expect(dropTrailingFailures(messages)).toHaveLength(2);
  });

  test("连续多条失败一起摘掉；中间夹着工具结果就停下", () => {
    const consecutive = [
      { role: "user" },
      assistant({ stopReason: "error", error: "503" }),
      assistant({ stopReason: "aborted" }),
    ];
    expect(dropTrailingFailures(consecutive)).toHaveLength(1);

    const withTool = [
      { role: "user" },
      { role: "toolResult", toolCallId: "c1" },
      assistant({ stopReason: "error", error: "503" }),
    ];
    const kept = dropTrailingFailures(withTool);
    expect(kept).toHaveLength(2);
    expect(kept[kept.length - 1]!.role).toBe("toolResult");
  });

  test("没有可摘的就原样返回（不产生无谓的数组拷贝）", () => {
    const messages = [{ role: "user" }, assistant({ stopReason: "stop", text: "x" })];
    expect(dropTrailingFailures(messages)).toBe(messages);
  });
});

describe("lastAssistantMessage / failureReasonOf", () => {
  test("从后往前找助手消息", () => {
    const messages: { role?: string; stopReason?: string }[] = [
      { role: "user" },
      assistant({ stopReason: "stop" }),
    ];
    expect(lastAssistantMessage(messages)?.stopReason).toBe("stop");
    expect(lastAssistantMessage([{ role: "user" }])).toBeUndefined();
  });

  test("原因缺省时说明「未给出原因」，过长则截断", () => {
    expect(failureReasonOf(assistant({ stopReason: "error" }))).toBe("未给出原因");
    expect(failureReasonOf(assistant({ stopReason: "error", error: "x".repeat(500) })).length).toBe(
      301,
    );
  });
});

describe("退避与文案", () => {
  test("800ms 起翻倍，8s 封顶", () => {
    expect(retryBackoffMs(1)).toBe(800);
    expect(retryBackoffMs(2)).toBe(1600);
    expect(retryBackoffMs(3)).toBe(3200);
    expect(retryBackoffMs(4)).toBe(6400);
    expect(retryBackoffMs(5)).toBe(8000);
    expect(retryBackoffMs(99)).toBe(8000);
  });

  test("轨迹文案带次数与原因，空回合提醒标明是系统消息", () => {
    const notice = retryNoticeText({ attempt: 2, max: 3, reason: "503" });
    expect(notice).toContain("2/3");
    expect(notice).toContain("503");
    expect(emptyTurnNudgeText(1)).toContain("系统消息");
    expect(emptyTurnNudgeText(2)).toContain("最后一次");
    // 提醒是给模型看的，不能反过来变成"再问用户一次"。
    expect(emptyTurnNudgeText(2)).not.toContain("ask_user");
  });
});
