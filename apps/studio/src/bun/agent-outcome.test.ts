import { describe, expect, test } from "bun:test";

import { classifyTurnOutcome } from "./agent-outcome";

describe("classifyTurnOutcome", () => {
  test("正常答完：有正文就是 ok", () => {
    expect(
      classifyTurnOutcome({ hasText: true, reachedStepLimit: false, lastStopReason: "stop" }),
    ).toEqual({ kind: "ok" });
  });

  test("请求失败不抛异常，只能靠 errorMessage 认出来", () => {
    expect(
      classifyTurnOutcome({
        errorMessage: "fetch failed: ECONNRESET",
        lastStopReason: "error",
        hasText: false,
        reachedStepLimit: false,
      }),
    ).toEqual({ kind: "error", detail: "fetch failed: ECONNRESET" });
  });

  test("被中断（stopReason=aborted）判成 aborted，不是 error", () => {
    expect(
      classifyTurnOutcome({
        errorMessage: "This operation was aborted",
        lastStopReason: "aborted",
        hasText: true,
        reachedStepLimit: false,
      }).kind,
    ).toBe("aborted");
  });

  test("没有 stopReason 时按错误文本兜底识别中断", () => {
    expect(
      classifyTurnOutcome({
        errorMessage: "Request aborted by user",
        hasText: false,
        reachedStepLimit: false,
      }).kind,
    ).toBe("aborted");
  });

  test("没有任何输出也没报错：判定为空回答（界面必须解释一句）", () => {
    expect(
      classifyTurnOutcome({ hasText: false, reachedStepLimit: false, lastStopReason: "stop" }),
    ).toEqual({ kind: "empty" });
  });

  test("到达步数上限时不再重复提示空回答", () => {
    expect(
      classifyTurnOutcome({ hasText: false, reachedStepLimit: true, lastStopReason: "toolUse" }),
    ).toEqual({ kind: "ok" });
  });

  test("只有空白正文（换行 / 空格）也算空回答", () => {
    const hasText = " \n\n\n ".trim().length > 0;
    expect(
      classifyTurnOutcome({ hasText, reachedStepLimit: false, lastStopReason: "stop" }).kind,
    ).toBe("empty");
  });

  test("长度钳制型空回合（length 且输出 ≤ 1 token）带上配置诊断标记", () => {
    expect(
      classifyTurnOutcome({
        hasText: false,
        reachedStepLimit: false,
        lastStopReason: "length",
        lastOutputTokens: 1,
      }),
    ).toEqual({ kind: "empty", lengthClamped: true, lastOutputTokens: 1 });
    // 拿不到 usage 时同样按钳制算：length + 空正文 + 无 token 数 ≈ 一开始就没名额。
    expect(
      classifyTurnOutcome({ hasText: false, reachedStepLimit: false, lastStopReason: "length" }),
    ).toEqual({ kind: "empty", lengthClamped: true, lastOutputTokens: undefined });
  });

  test("length 但确实生成了几个 token 的空回合并入普通空回合（另有成因）", () => {
    expect(
      classifyTurnOutcome({
        hasText: false,
        reachedStepLimit: false,
        lastStopReason: "length",
        lastOutputTokens: 6,
      }),
    ).toEqual({ kind: "empty" });
  });
});
