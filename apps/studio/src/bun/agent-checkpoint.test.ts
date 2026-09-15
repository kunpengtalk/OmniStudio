/**
 * 探索打点 / 收网的单测。
 *
 * 重点在 `applyRewind()`：它决定"哪一段被结论替换"。切错的两种后果都很难被发现 ——
 * 要么把打点之前的任务描述一起吞掉，要么把**收网之后**的新内容也吞掉
 * （后者尤其隐蔽：模型会突然"忘记"自己刚做完的事）。
 */
import { describe, expect, test } from "bun:test";

import { applyRewind, checkpointReminderText, rewindReportText, type RewindState } from "./agent-checkpoint";

const message = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const texts = (messages: { content: { text: string }[] }[]) => messages.map((m) => m.content[0]!.text);

describe("applyRewind", () => {
  test("打点之后的中间过程被结论替换，打点之前原样保留", () => {
    const messages = [message("任务"), message("打点前的一步"), message("探索 A"), message("探索 B")];
    const rewind: RewindState = { at: 2, report: "结论：问题在 a.ts:42", cutTo: null };
    const result = applyRewind(messages, rewind);
    expect(texts(result).slice(0, 2)).toEqual(["任务", "打点前的一步"]);
    expect(texts(result)[2]).toContain("问题在 a.ts:42");
    expect(texts(result).join()).not.toContain("探索 A");
    expect(result).toHaveLength(3);
  });

  test("收网之后新增的消息要接在结论后面（不能被一起吞掉）", () => {
    const messages = [message("任务"), message("探索 A"), message("探索 B")];
    const rewind: RewindState = { at: 1, report: "结论", cutTo: null };
    // 第一次应用：收网那一刻是 3 条
    applyRewind(messages, rewind);
    expect(rewind.cutTo).toBe(3);

    // 之后模型又干了两步
    const grown = [...messages, message("收网后的第一步"), message("收网后的第二步")];
    const second = applyRewind(grown, rewind);
    expect(texts(second).join()).toContain("收网后的第一步");
    expect(texts(second).join()).toContain("收网后的第二步");
    // 中间过程依然不在
    expect(texts(second).join()).not.toContain("探索 A");
    expect(second).toHaveLength(4); // 任务 + 结论 + 两步
  });

  test("打点在最后一条时不会吞掉任务描述", () => {
    const messages = [message("任务"), message("探索")];
    const result = applyRewind(messages, { at: 1, report: "结论", cutTo: null });
    expect(texts(result)).toEqual(["任务", expect.stringContaining("结论")]);
  });

  test("下标越界（消息被外部截短过）也不会抛错或丢光", () => {
    const messages = [message("任务")];
    const result = applyRewind(messages, { at: 99, report: "结论", cutTo: null });
    expect(texts(result).join()).toContain("结论");
    expect(texts(result).join()).toContain("任务");
  });

  test("结论消息写明「中间过程已移除」（否则模型会凭记忆编细节）", () => {
    const result = applyRewind([message("任务")], { at: 1, report: "结论" , cutTo: null });
    expect(texts(result)[1]).toContain("已从上下文移除");
    expect(texts(result)[1]).toContain("不要凭记忆复述");
  });
});

describe("提示文案", () => {
  test("未收网的提醒里带上打点目标", () => {
    expect(checkpointReminderText("查支付失败原因")).toContain("查支付失败原因");
    expect(checkpointReminderText("查支付失败原因")).toContain("rewind");
  });

  test("报告文本去掉首尾空白，空报告不产生空白块", () => {
    expect(rewindReportText("  结论  ")).toContain("结论");
    expect(rewindReportText("  ").endsWith("\n")).toBe(true);
  });
});
