/**
 * 摘要式压缩的纯逻辑单测：切点选择、摘要提示拼装、替换消息的文案。
 *
 * 真正调模型的部分（`summarizeHistory`）不在这里测 —— 那需要桩服务端，属于 live-check 的活；
 * 这里钉住的是"出错会 400 / 会把内容摘丢"的两类判断。
 */
import { describe, expect, test } from "bun:test";

import { estimateMessagesTokens } from "../shared/token-estimate";
import {
  buildSummaryPrompt,
  findSummaryCut,
  isTurnStart,
  SUMMARY_SYSTEM_PROMPT,
  summaryMessageText,
} from "./agent-summary";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const toolResult = (text: string) => ({ role: "toolResult", content: [{ type: "text", text }] });
const big = (label: string) => `${label} `.repeat(200);

describe("findSummaryCut", () => {
  const estimate = estimateMessagesTokens;

  test("切点落在一轮的起点（user 消息）上", () => {
    const messages = [
      user("任务"),
      assistant(big("第一轮回答")),
      toolResult(big("工具结果")),
      user(big("第二个问题")),
      assistant(big("第二轮回答")),
      user("第三个问题"),
      assistant("第三轮回答"),
    ];
    const cut = findSummaryCut(messages, 10, estimate);
    expect(cut).not.toBeNull();
    // 被切掉之后，保留下来的第一条必须是 user（否则助手消息与工具结果会被切开 → 400）
    expect(messages[cut!]!.role).toBe("user");
  });

  test("保留尾部不少于 minKeep 条，且不会切到只剩最后一条", () => {
    const messages = [user("任务"), user(big("一")), user(big("二")), user(big("三"))];
    const cut = findSummaryCut(messages, 1, estimate, 2);
    expect(cut).not.toBeNull();
    expect(messages.length - cut!).toBeGreaterThanOrEqual(2);
    // 下界取 2：摘要区域至少两条，否则等于没摘
    expect(cut!).toBeGreaterThanOrEqual(2);
  });

  test("整段历史里没有干净的回合边界时返回 null（交给确定性裁剪兜底）", () => {
    const messages = [user("任务"), assistant(big("回答")), toolResult(big("结果")), assistant(big("收尾"))];
    expect(findSummaryCut(messages, 1, estimate)).toBeNull();
  });

  test("历史太短不动手", () => {
    expect(findSummaryCut([user("任务"), assistant("好的")], 1, estimate)).toBeNull();
    expect(findSummaryCut([user("任务"), assistant("好的"), user("再问")], 1, estimate)).toBeNull();
  });

  test("keepRecent 大到能装下全部历史时不摘要（没有可摘的部分）", () => {
    const messages = [user("任务"), user("问"), assistant("答"), user("再问"), assistant("再答")];
    expect(findSummaryCut(messages, 1_000_000, estimate, 2)).toBeNull();
  });
});

describe("buildSummaryPrompt", () => {
  test("首次摘要：带转录与输出格式，不含系统提示（系统提示单独传）", () => {
    const prompt = buildSummaryPrompt({ transcript: "[User]: 把项目跑起来" });
    expect(prompt).toContain("把项目跑起来");
    expect(prompt).toContain("## 目标");
    expect(prompt).toContain("## 未解决 / 下一步");
    // 系统提示那一句不应该被重复塞进用户消息
    expect(prompt).not.toContain(SUMMARY_SYSTEM_PROMPT);
  });

  test("续写：把已有摘要带进来，并要求更新而不是重写", () => {
    const prompt = buildSummaryPrompt({ transcript: "新增内容", previousSummary: "## 目标\n跑起来" });
    expect(prompt).toContain("之前已经生成的摘要");
    expect(prompt).toContain("跑起来");
    expect(prompt).toContain("更新");
  });

  test("带召回记忆时标明是参考资料（不是指令）", () => {
    const prompt = buildSummaryPrompt({ transcript: "x", recalled: "用户偏好用 pnpm" });
    expect(prompt).toContain("用户偏好用 pnpm");
    expect(prompt).toContain("参考资料");
  });

  test("空白的上一版摘要 / 记忆不会产生空段落", () => {
    const prompt = buildSummaryPrompt({ transcript: "x", previousSummary: "   ", recalled: "" });
    expect(prompt).not.toContain("之前已经生成的摘要");
    expect(prompt).not.toContain("召回");
  });
});

describe("summaryMessageText", () => {
  test("写明条数、来源，并提醒摘要可能遗漏细节", () => {
    const text = summaryMessageText("## 目标\n跑起来", 12, "auto");
    expect(text).toContain("12 条");
    expect(text).toContain("自动压缩");
    expect(text).toContain("可能遗漏细节");
    expect(text).toContain("跑起来");
  });

  test("手动压缩与自动压缩的措辞不同（用户看得到区别）", () => {
    expect(summaryMessageText("x", 1, "manual")).toContain("手动压缩");
  });
});

describe("isTurnStart", () => {
  test("只有 user 消息算一轮的起点", () => {
    expect(isTurnStart(user("x"))).toBe(true);
    expect(isTurnStart(assistant("x"))).toBe(false);
    expect(isTurnStart(toolResult("x"))).toBe(false);
    expect(isTurnStart(undefined)).toBe(false);
  });
});
