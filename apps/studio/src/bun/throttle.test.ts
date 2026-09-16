import { describe, expect, test } from "bun:test";

import { throttleBatch, throttleLatest } from "./throttle";

/**
 * 推送节流的两条语义。
 *
 * 踩过的坑：MLX / PaddleOCR / Tesseract 的进度与日志都是"每个回调直接 send"，
 * 而 AGENTS.md 的口径是 progress 400ms / log 80ms —— 一次 pip 安装或几 GB 权重下载
 * 能瞬间打出几百条 IPC，每条都让 webview 写一次 store、重渲染一次。
 * 这里钉住两条不能搞反的规则：进度只留最后值、日志一行不丢。
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("throttleLatest（进度）", () => {
  test("首个事件立刻发，窗口内的中间值合并，最后一个值仍然送达", async () => {
    const seen: number[] = [];
    const t = throttleLatest<[number]>((n) => seen.push(n), 20);
    t.push(1);
    expect(seen).toEqual([1]); // leading：点下去就能看到动
    t.push(2);
    t.push(3);
    t.push(4);
    expect(seen).toEqual([1]); // 中间值被合掉
    await sleep(60);
    expect(seen).toEqual([1, 4]); // trailing：窗口结束发最后那个
    t.flush();
  });

  test("flush 把待发的值立刻发出去（收尾用）", () => {
    const seen: number[] = [];
    const t = throttleLatest<[number]>((n) => seen.push(n), 1000);
    t.push(1);
    t.push(2);
    t.flush();
    expect(seen).toEqual([1, 2]);
    t.flush(); // 幂等：没有待发值时不重复发
    expect(seen).toEqual([1, 2]);
  });

  test("没有后续事件时不会自己凭空发一条", async () => {
    const seen: number[] = [];
    const t = throttleLatest<[number]>((n) => seen.push(n), 10);
    t.push(7);
    await sleep(40);
    expect(seen).toEqual([7]);
  });
});

describe("throttleBatch（日志）", () => {
  test("窗口内的多行攒成一批发，顺序不变、一行不丢", async () => {
    const batches: string[][] = [];
    const t = throttleBatch((lines) => batches.push(lines), 20);
    t.push("a");
    t.push("b");
    t.push("c");
    expect(batches).toEqual([]); // 还没到窗口
    await sleep(60);
    expect(batches).toEqual([["a", "b", "c"]]);
  });

  test("flush 把尾巴整批发出去（安装结束时的最后几行）", () => {
    const batches: string[][] = [];
    const t = throttleBatch((lines) => batches.push(lines), 1000);
    t.push("最后一行");
    t.flush();
    expect(batches).toEqual([["最后一行"]]);
    t.flush();
    expect(batches).toHaveLength(1);
  });

  test("空行不入批（stdout 里大量空行不值得占 IPC）", async () => {
    const batches: string[][] = [];
    const t = throttleBatch((lines) => batches.push(lines), 10);
    t.push("");
    await sleep(30);
    expect(batches).toEqual([]);
  });
});
