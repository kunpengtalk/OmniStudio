import { afterAll, expect, mock, test } from "bun:test";

/** 索引访问的辅助函数（tsconfig 开启了 noUncheckedIndexedAccess）。 */
function at<T>(arr: T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`index ${i} missing`);
  return v;
}
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { join } from "path";

import * as schema from "./db/schema";
import { mockModulePartial } from "./test-mocks";
import * as fs from "fs";

const tmpDb = `/tmp/chat-test-${process.pid}.db`;
fs.rmSync(tmpDb, { force: true });
const sqlite = new Database(tmpDb, { create: true });
const db = drizzle({ client: sqlite, schema });
migrate(db, { migrationsFolder: join(import.meta.dir, "db/migrations") });

/** 临时改写某个设置（用 `withSetting`），默认值见下。 */
const SETTING_OVERRIDES: Record<string, string> = {};

/** 假设置：只有对话链路真正会读的键有值，其余一律空串。 */
const fakeGetSetting = (key: string) => {
  const override = SETTING_OVERRIDES[key];
  if (override !== undefined) return override;
  return key === "SERVER_MODE"
    ? "remote"
    : key === "VLLM_API_BASE"
      ? "http://fake:8000"
      : key === "CHAT_MODEL"
        ? "test-model"
        : "";
};

/** 在指定设置下跑一段（跑完还原），用于驱动"界面语言"这类影响输出的键。 */
async function withSetting(key: string, value: string, fn: () => void | Promise<void>) {
  SETTING_OVERRIDES[key] = value;
  try {
    await fn();
  } finally {
    delete SETTING_OVERRIDES[key];
  }
}

await mockModulePartial<typeof import("./db")>("./db", { db });
await mockModulePartial<typeof import("./db/settings")>("./db/settings", {
  getSetting: fakeGetSetting,
  // knowledge.ts → vllm/vllm.ts 会读重试次数等数值设置。
  getNumericSetting: (key) => Number(fakeGetSetting(key)),
  updateSettings: () => {},
  getAllSettings: () => ({}),
  getActiveServerPort: () => "18080",
  getServerPort: () => "18080",
});
const realChatModel = await import("./chat-model");
/**
 * 请求侧模型 id：真实实现读设置，而本文件的设置是桩（`updateSettings` 是空函数），
 * 改设置驱动不了它。用一个可变的桩把它变成可测的开关 —— 否则"没配模型"这条早退路径
 * 永远跑不到。
 */
let stubRequestModelId = "test-model";
mock.module("./chat-model", () => ({
  ...realChatModel,
  getChatModelName: () => "test-model",
  getChatRequestModelId: () => stubRequestModelId,
}));
// 不 mock ./image-server：bun 的 mock.module 会跨文件泄漏、且 mock.restore() 撤不掉，
// 别的文件（image-server.route.test）拿到被换掉的模块就只能无声跳过——media 403 正是
// 从"本地从没跑到"的路由漏出去的。本文件只用到目录工具函数，真实实现（数据目录已由
// test-preload 隔离）本来就是安全的，起服务也是显式调用才会发生。
await mockModulePartial<typeof import("./stats")>("./stats", {
  recordUsage: () => {},
  markServerStarted: () => {},
});
await mockModulePartial<typeof import("./server-manager")>("./server-manager", {
  getStatus: () => "running",
  getLastError: () => "",
  startServer: async () => ({ ok: true }),
});

// 一段两条 token 的流式 SSE 响应，末尾带 usage。
const sseChunks = [
  `data: ${JSON.stringify({ choices: [{ delta: { content: "你好" } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ delta: { content: "世界" } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 4 } })}\n\n`,
  `data: [DONE]\n\n`,
];
// 有些网关（代理 / 老版本 llama.cpp）不回 usage：统计必须退回本地估算。
const sseChunksNoUsage = [
  `data: ${JSON.stringify({ choices: [{ delta: { content: "估" } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ delta: { content: "算" } }] })}\n\n`,
  `data: [DONE]\n\n`,
];
let fetchCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = mock(async (_url: unknown, init: unknown) => {
  fetchCalls++;
  const body = typeof init === "object" && init && "body" in init ? String((init as { body?: unknown }).body ?? "") : "";
  const chunks = body.includes("没有 usage") ? sseChunksNoUsage : sseChunks;
  const enc = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}) as never;

const { createConversation, sendMessage, deleteMessage, regenerateMessage, translateMessage, getConversation, onChatChunk, onChatDone, onChatStats, onChatMessageStarted, titleFromMessage } = await import("./chat");
const { clearAppLog, readAppLogsInMemory } = await import("./app-log");
const { forkConversation, stopChatGeneration } = await import("./chat");

afterAll(() => {
  // 恢复全局 fetch，避免把 mock 泄漏给同一批次运行的其他测试文件。
  globalThis.fetch = originalFetch;
  fs.rmSync(tmpDb, { force: true });
});

test("sendMessage streams, persists content+tokens and emits stats", async () => {
  const conv = createConversation(undefined, "chat");
  const events: string[] = [];
  const deltas: string[] = [];
  // 增量按 ~40ms 批量下发（减少 IPC 与前端重渲染），事件条数不再等于 token 数：
  // 这里断言真正的不变量 —— 内容一字不丢、done 最后收尾。
  const offChunk = onChatChunk((payload) => {
    events.push("chunk");
    if (payload.kind !== "reasoning") deltas.push(payload.delta);
  });
  const offDone = onChatDone(() => events.push("done"));
  const stats: number[] = [];
  const offStats = onChatStats((s) => stats.push(s.tokens));
  // 最后一份完整统计（用量卡片读的就是它）。
  let last: Parameters<Parameters<typeof onChatStats>[0]>[0] | null = null;
  const offStatsFull = onChatStats((s) => {
    last = s;
  });

  const res = await sendMessage(conv.id, "hello");
  expect(res.ok).toBe(true);
  expect(deltas.join("")).toBe("你好世界");
  expect(events.length).toBeGreaterThan(0);
  expect(events[events.length - 1]).toBe("done");
  expect(stats).toEqual([4]);

  // 用量卡片依赖这些字段：网关不回 usage 时也得靠自己算出来。
  expect(last!.inputTokens).toBe(10);
  expect(last!.outputTokens).toBe(4);
  expect(last!.source).toBe("usage");
  expect(last!.elapsedMs).toBeGreaterThan(0);
  expect(last!.tokensPerSec).toBeGreaterThan(0);
  expect(last!.endToEndTokensPerSec).toBeGreaterThan(0);
  expect(last!.ttftMs).toBeGreaterThanOrEqual(0);

  const { messages } = getConversation(conv.id);
  expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  expect(at(messages, 1).content).toBe("你好世界");
  expect(at(messages, 1).tokens).toBe(4);
  // 统计随消息落库：重开会话（刷新页面）后详情卡片仍显示当时那次的速度。
  expect(at(messages, 1).stats?.tokensPerSec).toBe(last!.tokensPerSec);
  expect(at(messages, 1).stats?.inputTokens).toBe(10);

  offChunk();
  offDone();
  offStats();
  offStatsFull();
});

/**
 * 助手行一建好就推「行已存在」（chatMessageStarted）。
 *
 * 界面靠它把"生成中 / 处理中"立刻画出来：推送必须早于第一个增量，且推的那个 id
 * 就是最终写回正文的那一行 —— 否则界面要么干等（首 token 前没反馈），要么挂出
 * 两条助手消息（一条空、一条有内容）。
 */
test("建好助手行就先推 started，再开始流增量", async () => {
  const conv = createConversation(undefined, "chat");
  const timeline: string[] = [];
  const started: number[] = [];
  const offStarted = onChatMessageStarted((payload) => {
    expect(payload.conversationId).toBe(conv.id);
    started.push(payload.messageId);
    timeline.push("started");
    // 推送这一刻行就必须已经存在（界面拿到 id 立刻渲染，读回来不能是空的）。
    const row = getConversation(conv.id).messages.find((m) => m.id === payload.messageId);
    expect(row?.role).toBe("assistant");
    expect(row?.content).toBe("");
  });
  const offChunk = onChatChunk(() => timeline.push("chunk"));
  const offDone = onChatDone(() => timeline.push("done"));

  const res = await sendMessage(conv.id, "你好");
  expect(res.ok).toBe(true);

  expect(timeline[0]).toBe("started");
  expect(timeline.filter((t) => t === "started")).toHaveLength(1);
  // 推的就是最后写回正文的那一行。
  const { messages } = getConversation(conv.id);
  expect(started).toEqual([at(messages, 1).id]);
  expect(at(messages, 1).content).toBe("你好世界");

  offStarted();
  offChunk();
  offDone();
});

test("重新生成也会先推 started（界面先看到「在重答」再看到字）", async () => {
  const conv = createConversation(undefined, "chat");
  await sendMessage(conv.id, "q1");
  const firstAssistantId = getConversation(conv.id).messages[1]!.id;

  const started: number[] = [];
  const offStarted = onChatMessageStarted((payload) => started.push(payload.messageId));
  await regenerateMessage(conv.id, firstAssistantId);
  offStarted();

  expect(started).toHaveLength(1);
  expect(started[0]).not.toBe(firstAssistantId);
});

test("网关不回 usage 时退回本地估算并如实标注", async () => {
  const conv = createConversation(undefined, "chat");
  let last: Parameters<Parameters<typeof onChatStats>[0]>[0] | null = null;
  const offStats = onChatStats((s) => {
    last = s;
  });

  const res = await sendMessage(conv.id, "没有 usage 的一次请求");
  expect(res.ok).toBe(true);

  expect(last!.source).toBe("estimate");
  expect(last!.outputTokens).toBe(2); // "估算" → 2 个 CJK 字符
  expect(last!.inputTokens).toBeGreaterThan(0); // 按请求体估算，不留空
  expect(last!.ttftMs).toBeGreaterThanOrEqual(0);
  expect(last!.tokensPerSec).toBeGreaterThan(0);

  const { messages } = getConversation(conv.id);
  expect(at(messages, 1).stats?.source).toBe("estimate");
  offStats();
});

test("deleteMessage removes the row", async () => {  const conv = createConversation(undefined, "chat");
  const res = await sendMessage(conv.id, "to be deleted");
  expect(res.ok).toBe(true);
  const { messages } = getConversation(conv.id);
  const assistantId = at(messages, 1).id;
  expect(deleteMessage(conv.id, assistantId).ok).toBe(true);
  expect(getConversation(conv.id).messages.map((m) => m.id)).toEqual([at(messages, 0).id]);
});

test("regenerateMessage rewinds and produces a new answer", async () => {
  const conv = createConversation(undefined, "chat");
  await sendMessage(conv.id, "q1");
  let { messages } = getConversation(conv.id);
  const firstAssistantId = at(messages, 1).id;
  const callsBefore = fetchCalls;

  const res = await regenerateMessage(conv.id, firstAssistantId);
  expect(res.ok).toBe(true);
  expect(fetchCalls).toBe(callsBefore + 1);

  messages = getConversation(conv.id).messages;
  // 回退后只有 user；旧的 assistant 被删除，新的 assistant 以新 id 追加。
  expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  const regenerated = at(messages, 1);
  expect(regenerated.id).not.toBe(firstAssistantId);
  expect(regenerated.content).toBe("你好世界");
});

test("translateMessage appends a streamed translation", async () => {
  const conv = createConversation(undefined, "chat");
  await sendMessage(conv.id, "hello in en");
  let { messages } = getConversation(conv.id);
  const assistantId = at(messages, 1).id;
  const countBefore = messages.length;

  const res = await translateMessage(conv.id, assistantId, "zh-CN");
  expect(res.ok).toBe(true);

  messages = getConversation(conv.id).messages;
  expect(messages.length).toBe(countBefore + 1);
  const translated = at(messages, messages.length - 1);
  expect(translated.role).toBe("assistant");
  expect(translated.content).toBe("你好世界");
});

test("会话标题取首条消息开头：压平空白、超长补省略号", () => {  expect(titleFromMessage("你好")).toBe("你好");
  // 换行与连续空格归一成单个空格：标题里不该出现换行，也不该丢掉第二行
  expect(titleFromMessage("\n\n  帮我分析日志  \n\n顺便看看磁盘")).toBe("帮我分析日志 顺便看看磁盘");
  expect(titleFromMessage("帮我把这段代码\n改成 TypeScript")).toBe("帮我把这段代码 改成 TypeScript");

  // 超长：截断并**补省略号**。此前四处各写一遍 `slice(0, 40)` —— 40 个字的 nowrap
  // 标题放不进 275px 的侧栏，会把会话行顶到 530px，列表跟着长出横向滚动条。
  const long = "我用TTS生成一个你自己的一段介绍的音频。不用太长你可以调用咱们系统里面你能用到的模型";
  const title = titleFromMessage(long);
  expect(title).toBe(`${long.slice(0, 24)}…`);
  expect(title.endsWith("…")).toBe(true);
  expect(title.length).toBeLessThan(long.length);

  // 空白 / 只有图片时退回默认标题（与调用方约定一致）
  expect(titleFromMessage("   \n  ")).toBe("New conversation");
});

// ---------------------------------------------------------------------------
// 失败路径：必须有终态事件（否则输入框锁死）+ 必须进统一日志（否则没法诊断）。
// 这两件事此前都没有：早退分支只 `return { ok:false }`，前端等不到 chatDone 就停在
// 「生成中」；chat.ts 整个文件没有一处 logEvent，`omi logs` 里查不到任何对话故障。
// ---------------------------------------------------------------------------

/** 收一条 done 事件（没有超时保护：真收不到就让它挂到测试超时，比静默通过好）。 */
function nextDone(): Promise<Parameters<Parameters<typeof onChatDone>[0]>[0]> {
  return new Promise((resolve) => {
    const off = onChatDone((payload) => {
      off();
      resolve(payload);
    });
  });
}

test("会话不存在时发送：既回 ok:false，也发一条带错误的终态事件（输入框不能锁死）", async () => {
  clearAppLog();
  const done = nextDone();
  const res = await sendMessage(999_999, "在吗");

  expect(res.ok).toBe(false);
  expect(res.error).toBe("Conversation not found");
  // 之前这条路径不发终态事件 → 前端的 setStreaming(true) 再也没人解除。
  const payload = await done;
  expect(payload.error).toBe("Conversation not found");

  const logged = readAppLogsInMemory({ source: "chat" });
  expect(logged.map((e) => e.event)).toContain("chat.send.rejected");
});

test("空消息被拒：同样发终态事件", async () => {
  const conv = createConversation(undefined, "chat");
  const done = nextDone();
  const res = await sendMessage(conv.id, "   ");
  expect(res.ok).toBe(false);
  expect((await done).error).toBe("Empty message");
});

test("模型没配时发送：终态事件 + chat.send.no_model 日志", async () => {
  clearAppLog();
  stubRequestModelId = "";
  try {
    const conv = createConversation(undefined, "chat");
    const done = nextDone();
    const res = await sendMessage(conv.id, "你好");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("No model configured");
    expect((await done).error).toBe("No model configured");
    const logged = readAppLogsInMemory({ source: "chat" });
    expect(logged.map((e) => e.event)).toContain("chat.send.no_model");
  } finally {
    stubRequestModelId = "test-model";
  }
});

test("流式过程中失败：写 chat.stream.failed，并带上上游地址与已生成字数", async () => {  clearAppLog();
  const conv = createConversation(undefined, "chat");
  const realFetch = globalThis.fetch;
  globalThis.fetch = mock(async () => {
    throw new Error("连接被重置");
  }) as never;
  try {
    const res = await sendMessage(conv.id, "写点什么");
    expect(res.ok).toBe(false);
    const failures = readAppLogsInMemory({ source: "chat" }).filter(
      (e) => e.event === "chat.stream.failed",
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]!.level).toBe("error");
    const detail = failures[0]!.detail as Record<string, unknown>;
    expect(detail.conversationId).toBe(conv.id);
    expect(detail.charsStreamed).toBe(0);
    expect(typeof detail.base).toBe("string");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("分叉会话的标题后缀跟随界面语言（标题是落库数据，不能写死中文）", async () => {
  const conv = createConversation(undefined, "chat");
  await sendMessage(conv.id, "帮我写个落地页");

  const firstMessageId = getConversation(conv.id).messages[0]!.id;

  const zh = forkConversation(conv.id, firstMessageId);
  expect(getConversation(zh.conversationId!).conversation!.title.endsWith(" · 分支")).toBe(true);

  await withSetting("UI_LANG", "en", () => {
    const en = forkConversation(conv.id, firstMessageId);
    expect(getConversation(en.conversationId!).conversation!.title.endsWith(" · branch")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 停止生成：本地模型一轮能跑几分钟，用户必须能中途叫停（此前只能等 600s 超时）。
// 叫停后已生成的部分要保留、要落库、要标上「已停止」——丢掉半截回答比不让停更糟。
// ---------------------------------------------------------------------------

test("停止生成：保留已生成的部分、标上「已停止」，不当作错误", async () => {
  const conv = createConversation(undefined, "chat");
  const realFetch = globalThis.fetch;
  globalThis.fetch = mock(async (_url: unknown, init: unknown) => {
    const signal = (init as { signal?: AbortSignal }).signal;
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          enc.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: "半截回答" } }] })}\n\n`,
          ),
        );
        // 之后一直挂着不动（模拟还在生成），直到请求被 abort。
        signal?.addEventListener("abort", () => {
          controller.error(new Error("The operation was aborted."));
        });
      },
    });
    return new Response(stream, { status: 200 });
  }) as never;

  try {
    const pending = sendMessage(conv.id, "讲个长故事");
    // 等第一个增量真的读进来（`full` 在读取时就累积，不等 40ms 的批量下发展示）
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(stopChatGeneration(conv.id).ok).toBe(true);
    const res = await pending;

    expect(res.ok).toBe(true);
    // 落库内容 = 已生成的部分 + 停止标记（刷新会话后还在）
    const messages = getConversation(conv.id).messages;
    const last = messages[messages.length - 1]!;
    expect(last.content).toContain("半截回答");
    expect(last.content).toContain("已停止");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("没有在生成时按停止：如实回 ok:false，不报错", () => {
  const conv = createConversation(undefined, "chat");
  expect(stopChatGeneration(conv.id)).toEqual({ ok: false });
});
