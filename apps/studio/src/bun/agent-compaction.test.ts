/**
 * 上下文压缩单测：token 估算、裁剪边界（保留任务陈述与最近消息）、
 * 「预算充足时绝不改动」这条安全约束，以及重复读取的去重。
 */
import { describe, expect, test } from "bun:test";

import {
  compactMessages,
  estimateMessagesTokens,
  estimateTokens,
  pruneSupersededReads,
} from "./agent-compaction";

const message = (role: string, content: string) => ({ role, content });

/** 造一次「助手发起读取 → 收到结果」的配对。 */
const readCall = (id: string, path: string, args: Record<string, unknown> = {}) => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name: "read_file", arguments: { path, ...args } }],
});
const readResult = (id: string, text: string) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "read_file",
  content: [{ type: "text", text }],
});

describe("estimateTokens", () => {
  test("中文按字、英文按字符比例估算", () => {
    expect(estimateTokens("你好世界")).toBe(4);
    expect(estimateTokens("hello world")).toBe(3); // 11 * 0.25 → 3
    expect(estimateTokens("")).toBe(0);
  });

  test("混合内容比纯英文更贵（同样长度下中文占比越高 token 越多）", () => {
    expect(estimateTokens("这是一个测试")).toBeGreaterThan(estimateTokens("abcdefgh"));
  });

  test("分块 content 也会被算进去（工具调用块不能漏）", () => {
    const tokens = estimateMessagesTokens([
      { role: "assistant", content: [{ type: "text", text: "读文件" }, { type: "toolCall" }] },
    ]);
    expect(tokens).toBeGreaterThan(0);
  });
});

describe("compactMessages", () => {
  const placeholder = (dropped: number) => message("user", `（已省略 ${dropped} 条）`);

  test("预算充足时原样返回", () => {
    const messages = [message("user", "任务"), message("assistant", "好的"), message("user", "继续")];
    const result = compactMessages(messages, 10_000, placeholder);
    expect(result.dropped).toBe(0);
    expect(result.messages).toBe(messages);
  });

  test("超预算时保留任务陈述与最近消息，中间换成占位说明", () => {
    const messages = [message("user", "把项目跑起来")];
    for (let i = 0; i < 40; i += 1) {
      messages.push(message(i % 2 === 0 ? "assistant" : "user", `第 ${i} 步：这是一段比较长的中文内容用来撑爆预算`));
    }
    const result = compactMessages(messages, 200, placeholder);
    expect(result.dropped).toBeGreaterThan(0);
    expect(result.messages[0]).toEqual(message("user", "把项目跑起来"));
    expect(result.messages[1]?.content).toContain("已省略");
    expect(result.messages.length).toBeLessThan(messages.length);
    // 最后一条必须还是最新的那条，模型要能看到"刚刚发生了什么"
    expect(result.messages[result.messages.length - 1]).toEqual(messages[messages.length - 1]);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
  });

  test("至少保留最后 4 条（预算再紧也不把最近的上下文清空）", () => {
    const messages = [message("user", "任务")];
    for (let i = 0; i < 20; i += 1) messages.push(message("user", `很长的消息内容 ${i} `.repeat(20)));
    const result = compactMessages(messages, 10, placeholder);
    // 1 条任务 + 1 条占位 + 至少 4 条最近消息
    expect(result.messages.length).toBeGreaterThanOrEqual(6);
  });

  test("尾部不会以工具结果开头（否则真实服务会 400）", () => {
    const messages = [
      message("user", "任务陈述"),
      message("assistant", "先读文件"),
      message("tool", "文件内容很长很长的内容块 ".repeat(30)),
      message("tool", "另一段工具结果 ".repeat(30)),
      message("assistant", "继续"),
      message("tool", "工具结果 ".repeat(30)),
    ];
    const result = compactMessages(messages, 40, placeholder);
    expect(result.messages[0]?.role).toBe("user");
    expect(result.messages[1]?.role).toBe("user"); // 占位说明
    expect(result.messages[2]?.role).not.toBe("tool");
  });

  test("同样拦住 AgentMessage 形态的工具结果（transformContext 里角色叫 toolResult）", () => {
    // 回归：真实运行时 `transformContext` 收到的是 AgentMessage，工具结果的角色是
    // `toolResult` 而不是线上协议里的 `tool`。只匹配 `tool` 的话这道保护等于没生效。
    const messages = [
      message("user", "任务陈述"),
      message("assistant", "先读文件"),
      message("toolResult", "文件内容很长很长的内容块 ".repeat(30)),
      message("toolResult", "另一段工具结果 ".repeat(30)),
      message("assistant", "继续"),
      message("toolResult", "工具结果 ".repeat(30)),
    ];
    const result = compactMessages(messages, 40, placeholder);
    expect(result.messages[2]?.role).not.toBe("toolResult");
  });

  test("消息很少时不动（避免刚开会话就触发压缩）", () => {
    const messages = [message("user", "任务"), message("assistant", "x".repeat(5000))];
    const result = compactMessages(messages, 10, placeholder);
    expect(result.dropped).toBe(0);
    expect(result.messages).toBe(messages);
  });

  test("预算内裁剪；预算小到放不下最小保留量时以「保留最近 4 条」为准", () => {
    const many = () => [
      message("user", "任务"),
      ...Array.from({ length: 30 }, (_, i) => message("user", `第 ${i} 步的详细说明文字，用来把预算撑开`)),
    ];

    // 正常预算：裁剪后必须落在预算里
    const relaxed = compactMessages(many(), 120, placeholder);
    expect(relaxed.tokensAfter).toBeLessThanOrEqual(120);
    expect(relaxed.dropped).toBeGreaterThan(0);

    // 预算极端小：最小保留量优先（宁可超预算，也不能让模型看不见最近发生的事）
    const tight = compactMessages(many(), 20, placeholder);
    expect(tight.messages.length).toBe(6); // 任务 + 占位 + 最近 4 条
    expect(tight.tokensAfter).toBeLessThan(tight.tokensBefore);
  });
});

describe("pruneSupersededReads", () => {
  const placeholder = (path: string) => `（已省略：${path} 的旧读取结果）`;
  const big = (label: string) => `${label} `.repeat(400); // 每条都足够大，能过 MIN_PRUNE_TOKENS

  test("同一路径的旧读取被最新的整份读取取代", () => {
    const messages = [
      message("user", "改一下 a.ts"),
      readCall("c1", "a.ts"),
      readResult("c1", big("第一次读到的旧内容")),
      message("assistant", "改完再读一遍"),
      readCall("c2", "a.ts"),
      readResult("c2", big("第二次读到的内容")),
    ];
    const result = pruneSupersededReads(messages, placeholder);
    expect(result.pruned).toBe(1);
    expect(result.tokensSaved).toBeGreaterThan(0);
    // 旧的那条被换成占位，新的那条原样保留
    expect(JSON.stringify(result.messages[2])).toContain("已省略");
    expect(JSON.stringify(result.messages[2])).not.toContain("第一次读到的旧内容");
    expect(JSON.stringify(result.messages[5])).toContain("第二次读到的内容");
    // 消息条数与顺序不变（工具调用与结果的配对不能被打散）
    expect(result.messages.length).toBe(messages.length);
    expect(result.messages[1]).toEqual(messages[1]);
  });

  test("最新一次只是分页读取时，绝不丢旧的全量结果", () => {
    const messages = [
      readCall("c1", "a.ts"),
      readResult("c1", big("全量内容")),
      readCall("c2", "a.ts", { offset: 40, limit: 20 }),
      readResult("c2", big("只看 40-60 行")),
    ];
    const result = pruneSupersededReads(messages, placeholder);
    expect(result.pruned).toBe(0);
    expect(result.messages).toBe(messages);
  });

  test("分页读在前、全量读在后：旧的分页结果可以省", () => {
    const messages = [
      readCall("c1", "a.ts", { offset: 0, limit: 20 }),
      readResult("c1", big("前 20 行")),
      readCall("c2", "a.ts"),
      readResult("c2", big("后来整份读了一遍")),
    ];
    expect(pruneSupersededReads(messages, placeholder).pruned).toBe(1);
  });

  test("不同路径 / 不同工具之间互不取代", () => {
    const messages = [
      readCall("c1", "a.ts"),
      readResult("c1", big("a 的内容")),
      readCall("c2", "b.ts"),
      readResult("c2", big("b 的内容")),
      { role: "assistant", content: [{ type: "toolCall", id: "c3", name: "grep", arguments: { pattern: "x" } }] },
      { role: "toolResult", toolCallId: "c3", toolName: "grep", content: [{ type: "text", text: big("grep 结果") }] },
    ];
    expect(pruneSupersededReads(messages, placeholder).pruned).toBe(0);
  });

  test("省下的量太小就不动手（占位文本自己也要花 token）", () => {
    const messages = [
      readCall("c1", "a.ts"),
      readResult("c1", "短"),
      readCall("c2", "a.ts"),
      readResult("c2", "也短"),
    ];
    expect(pruneSupersededReads(messages, placeholder).pruned).toBe(0);
  });
});
