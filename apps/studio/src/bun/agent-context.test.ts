import { beforeEach, describe, expect, test } from "bun:test";

import {
  contextBudgetTokens,
  contextUsage,
  contextWindowTokens,
  describeContextUsage,
  forgetPromptTokens,
  rememberPromptTokens,
  resetContextUsageCache,
} from "./agent-context";
import * as Chat from "./chat";
import { db } from "./db";
import { messages } from "./db/schema";
import { updateSettings } from "./db/settings";
import { buildReadOnlyTools } from "./agent-tools";

/**
 * 上下文占用（对齐 Codex 的 get_context_remaining / 状态行）。
 *
 * 两个来源：会话内有实测用量时用实测（服务端 usage.prompt_tokens），
 * 否则按消息估算 —— 估算用的必须是**压缩那套** token 估算，
 * 否则"占用条"和"什么时候开始裁历史"会对不上。
 */
beforeEach(() => {
  resetContextUsageCache();
  updateSettings({ SERVER_CTX_SIZE: "8192" });
});

describe("预算与窗口", () => {
  test("预算 = 窗口的 60%，与压缩的算法一致", () => {
    expect(contextWindowTokens()).toBe(8192);
    expect(contextBudgetTokens(8192)).toBe(Math.floor(8192 * 0.6));
    expect(contextBudgetTokens(1000)).toBe(600);
    // 窗口极小时仍有下限，与 transformContext 的 max(256, …) 对齐。
    expect(contextBudgetTokens(100)).toBe(256);
  });

  test("窗口设置非法时回落 8192", () => {
    updateSettings({ SERVER_CTX_SIZE: "0" });
    expect(contextWindowTokens()).toBe(8192);
    updateSettings({ SERVER_CTX_SIZE: "32768" });
    expect(contextWindowTokens()).toBe(32768);
  });
});

describe("占用计算", () => {
  test("没有实测时按消息估算，系统提示也算进去", () => {
    const conversation = Chat.createConversation("上下文估算", "agent");
    db.insert(messages)
      .values({ conversationId: conversation.id, role: "user", content: "这是一段用来占用上下文的中文内容。" })
      .run();

    const usage = contextUsage(conversation.id, { systemPromptTokens: 500 });
    expect(usage.source).toBe("estimate");
    expect(usage.usedTokens).toBeGreaterThan(500);
    expect(usage.remainingTokens).toBe(usage.budgetTokens - usage.usedTokens);
  });

  test("有实测用量时用实测值（服务端说的才算数）", () => {
    const conversation = Chat.createConversation("上下文实测", "agent");
    rememberPromptTokens(conversation.id, 6000);
    const usage = contextUsage(conversation.id);
    expect(usage.source).toBe("usage");
    expect(usage.usedTokens).toBe(6000);
    expect(usage.percent).toBe(Math.min(100, Math.round((6000 / (8192 * 0.6)) * 100)));
    expect(usage.percent).toBe(100); // 6000 > 4915，已经到压缩线

    forgetPromptTokens(conversation.id);
    expect(contextUsage(conversation.id).source).toBe("estimate");
  });
});

describe("给模型看的状态文案", () => {
  test("接近压缩线时提示先记录进度", () => {
    const text = describeContextUsage({
      windowTokens: 8192,
      budgetTokens: 4915,
      usedTokens: 4600,
      remainingTokens: 315,
      percent: 94,
      source: "usage",
    });
    expect(text).toContain("压缩线");
    expect(text).toContain("todo_write");
  });

  test("占用过半时提示少读一点", () => {
    const text = describeContextUsage({
      windowTokens: 8192,
      budgetTokens: 4915,
      usedTokens: 3000,
      remainingTokens: 1915,
      percent: 61,
      source: "estimate",
    });
    expect(text).toContain("一半以上");
  });

  test("空闲时不啰嗦", () => {
    const text = describeContextUsage({
      windowTokens: 8192,
      budgetTokens: 4915,
      usedTokens: 100,
      remainingTokens: 4815,
      percent: 2,
      source: "estimate",
    });
    expect(text).not.toContain("压缩线");
    expect(text).not.toContain("一半以上");
  });
});

describe("工具面", () => {
  test("get_context_remaining 是只读工具，且需要会话上下文", async () => {
    const conversation = Chat.createConversation("上下文工具", "agent");
    const tools = buildReadOnlyTools({
      workspace: "/tmp/ws",
      allowShell: false,
      conversationId: conversation.id,
      systemPromptTokens: 700,
    });
    const tool = tools.find((item) => item.name === "get_context_remaining");
    expect(tool).toBeDefined();
    const result = (await tool!.execute("ctx", {})) as { content: { text?: string }[] };
    expect(result.content[0]?.text ?? "").toContain("上下文窗口");

    // 没有会话（子智能体 / 一次性调用）时明确报错，而不是给一个假数字。
    const bare = buildReadOnlyTools({ workspace: "/tmp/ws", allowShell: false });
    const bareResult = (await bare.find((item) => item.name === "get_context_remaining")!.execute("ctx", {})) as {
      content: { text?: string }[];
    };
    expect(bareResult.content[0]?.text ?? "").toContain("only available inside a conversation");
  });
});
