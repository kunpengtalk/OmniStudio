import { describe, expect, test } from "bun:test";

import { computeTokenStats, parseMessageStats } from "./chat-stats";

describe("computeTokenStats", () => {
  test("生成速度只算解码窗口，端到端吞吐另算", () => {
    // 与实测语义一致：输出 779、总耗时 5300ms、首 token 899ms
    // → 779 / 4.4s ≈ 177.0 tok/s；端到端 779 / 5.3s ≈ 147.0 tok/s
    const stats = computeTokenStats({
      inputTokens: 233,
      outputTokens: 779,
      elapsedMs: 5300,
      ttftMs: 899,
      source: "usage",
    });
    expect(stats.tokensPerSec).toBe(177);
    expect(stats.endToEndTokensPerSec).toBe(147);
    expect(stats.generationMs).toBe(4401);
    expect(stats.tokens).toBe(779);
    expect(stats.outputTokens).toBe(779);
    expect(stats.inputTokens).toBe(233);
    expect(stats.ttftMs).toBe(899);
  });

  test("引擎报了纯解码速度时以它为准（不信本地测的窗口）", () => {
    const stats = computeTokenStats({
      outputTokens: 500,
      elapsedMs: 10_000,
      ttftMs: 1000,
      generationMs: 2500, // = 500 / 200 tok/s
      source: "usage",
    });
    expect(stats.tokensPerSec).toBe(200);
    expect(stats.endToEndTokensPerSec).toBe(50);
  });

  test("首 token 耗时被夹在总耗时内（中断时可能量到更大的值）", () => {
    const stats = computeTokenStats({ outputTokens: 10, elapsedMs: 100, ttftMs: 900, source: "usage" });
    expect(stats.ttftMs).toBe(100);
    expect(stats.generationMs).toBe(1);
  });

  test("没有首 token 时刻时退化成整段窗口，不会除零", () => {
    const stats = computeTokenStats({ outputTokens: 60, elapsedMs: 3000, ttftMs: null, source: "usage" });
    expect(stats.ttftMs).toBeUndefined();
    expect(stats.tokensPerSec).toBe(20);
    expect(stats.endToEndTokensPerSec).toBe(20);
  });

  test("零输出不产生 NaN / Infinity", () => {
    const stats = computeTokenStats({ outputTokens: 0, elapsedMs: 0, source: "estimate" });
    expect(stats.tokensPerSec).toBe(0);
    expect(stats.endToEndTokensPerSec).toBe(0);
    expect(stats.elapsedMs).toBe(1);
  });

  test("可选字段缺省时不写进结果（界面据此决定显不显示那一格）", () => {
    const stats = computeTokenStats({ outputTokens: 12, elapsedMs: 1000, source: "estimate" });
    expect("inputTokens" in stats).toBe(false);
    expect("reasoningTokens" in stats).toBe(false);
    expect("cachedTokens" in stats).toBe(false);
    expect(stats.source).toBe("estimate");
  });
});

describe("parseMessageStats", () => {
  test("坏数据一律当作没有统计", () => {
    expect(parseMessageStats(null)).toBeNull();
    expect(parseMessageStats("")).toBeNull();
    expect(parseMessageStats("not json")).toBeNull();
    expect(parseMessageStats('{"tokens": 3}')).toBeNull(); // 缺 tokensPerSec
    expect(parseMessageStats('"str"')).toBeNull();
  });

  test("正常数据原样取回，缺 elapsedMs 补 0", () => {
    const parsed = parseMessageStats('{"tokens":10,"tokensPerSec":5,"source":"usage"}');
    expect(parsed).toEqual({
      tokens: 10,
      tokensPerSec: 5,
      elapsedMs: 0,
      source: "usage",
    });
  });
});
