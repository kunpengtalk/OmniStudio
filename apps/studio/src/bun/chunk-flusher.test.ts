import { describe, expect, test } from "bun:test";

import { CHUNK_FLUSH_INTERVAL_MS, createChunkFlusher } from "./chunk-flusher";

/**
 * 增量批量下发的共用件（对话与 Agent 同一条链路）。
 *
 * 这里钉的是三条已经踩过或极易踩到的规则：
 *   1. 一批里的增量合并成一条事件，但**内容一字不丢、顺序不变**；
 *   2. 收尾前必须能立刻冲干净 —— 漏了就是"收尾了又冒出来半句话"；
 *   3. 失败重发要能丢掉缓冲 —— 漏了就是"半截旧文本 + 新回答"挤在同一个气泡里。
 */
type Emitted = { delta: string; kind?: "reasoning" | "content" };

function collect() {
  const events: Emitted[] = [];
  const flusher = createChunkFlusher({
    conversationId: 1,
    messageId: 2,
    emit: (payload) => events.push({ delta: payload.delta, kind: payload.kind }),
    intervalMs: 5,
  });
  return { events, flusher };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createChunkFlusher", () => {
  test("攒到时间窗才发，内容与顺序都不丢", async () => {
    const { events, flusher } = collect();
    flusher.pushContent("你");
    flusher.pushContent("好");
    expect(events).toHaveLength(0); // 还没到时间窗
    await sleep(CHUNK_FLUSH_INTERVAL_MS + 20);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ delta: "你好", kind: "content" });
  });

  test("正文与思考分成两条事件（前端按 kind 分栏渲染）", async () => {
    const { events, flusher } = collect();
    flusher.pushReasoning("想一下");
    flusher.pushContent("答案");
    flusher.flushNow();
    expect(events).toEqual([
      { delta: "答案", kind: "content" },
      { delta: "想一下", kind: "reasoning" },
    ]);
  });

  test("flushNow 一定会把尾巴冲干净，且不重复发", async () => {
    const { events, flusher } = collect();
    flusher.pushContent("尾巴");
    flusher.flushNow();
    flusher.flushNow();
    expect(events).toHaveLength(1);
    await sleep(CHUNK_FLUSH_INTERVAL_MS + 20);
    expect(events).toHaveLength(1); // 定时器已被取消，不会再来一条
  });

  test("discard 丢掉还没发出去的缓冲（失败重发场景）", async () => {
    const { events, flusher } = collect();
    flusher.pushContent("半截旧文本");
    flusher.discard();
    await sleep(CHUNK_FLUSH_INTERVAL_MS + 20);
    expect(events).toHaveLength(0);

    flusher.pushContent("新回答");
    flusher.flushNow();
    expect(events).toEqual([{ delta: "新回答", kind: "content" }]);
  });

  test("空增量不入缓冲：一次 RPC 送一个空串纯属浪费", async () => {
    const { events, flusher } = collect();
    flusher.pushContent("");
    flusher.pushReasoning("");
    flusher.flushNow();
    expect(events).toHaveLength(0);
  });

  test("dispose 之后残留的定时器不会再发", async () => {
    const { events, flusher } = collect();
    flusher.pushContent("x");
    flusher.dispose();
    await sleep(CHUNK_FLUSH_INTERVAL_MS + 20);
    // 定时器取消了，但缓冲还在 —— 下一次 flushNow 仍能把它发出去
    expect(events).toHaveLength(0);
    flusher.flushNow();
    expect(events).toEqual([{ delta: "x", kind: "content" }]);
  });
});
