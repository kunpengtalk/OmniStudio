import { describe, expect, test } from "bun:test";

import { createFrameSplitter } from "./audio-frames";

const ramp = (from: number, len: number) =>
  Float32Array.from({ length: len }, (_, i) => from + i);

describe("createFrameSplitter", () => {
  test("块长等于帧长：一块一帧", () => {
    const splitter = createFrameSplitter(4);
    const frames = splitter.push(ramp(0, 4));
    expect(frames).toHaveLength(1);
    expect([...frames[0]!]).toEqual([0, 1, 2, 3]);
    expect(splitter.buffered).toBe(0);
  });

  test("块长是帧长的整数倍：一次交多帧", () => {
    const splitter = createFrameSplitter(4);
    const frames = splitter.push(ramp(0, 12));
    expect(frames.map((f) => [...f])).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7],
      [8, 9, 10, 11],
    ]);
  });

  test("块长与帧长不成整比：余数留到下一块，样本不丢不重", () => {
    const splitter = createFrameSplitter(4);
    // 3 + 3 + 6 = 12 → 3 帧，且顺序与原始序列一致
    const first = splitter.push(ramp(0, 3));
    expect(first).toEqual([]);
    expect(splitter.buffered).toBe(3);
    const second = splitter.push(ramp(3, 3));
    expect(second).toHaveLength(1);
    expect([...second[0]!]).toEqual([0, 1, 2, 3]);
    expect(splitter.buffered).toBe(2);
    const third = splitter.push(ramp(6, 6));
    expect(third.map((f) => [...f])).toEqual([
      [4, 5, 6, 7],
      [8, 9, 10, 11],
    ]);
    expect(splitter.buffered).toBe(0);
  });

  test("连续喂很多块后，拼出来的样本序列与输入完全一致（时间轴不会漂）", () => {
    const splitter = createFrameSplitter(7);
    const out: number[] = [];
    let next = 0;
    for (const size of [1, 13, 4, 20, 2, 9, 6]) {
      const block = ramp(next, size);
      next += size;
      for (const frame of splitter.push(block)) out.push(...frame);
    }
    // 用过的都是整帧，剩下的（next 对 7 取余）还在缓冲里
    expect(out).toEqual([...Array(out.length).keys()]);
    expect(splitter.buffered).toBe(next % 7);
  });

  test("空块什么也不做；reset 丢掉余数", () => {
    const splitter = createFrameSplitter(4);
    expect(splitter.push(new Float32Array(0))).toEqual([]);
    splitter.push(ramp(0, 3));
    splitter.reset();
    expect(splitter.buffered).toBe(0);
    // reset 之后从新的一帧开始，不会被上一段余数污染
    const frame = splitter.push(ramp(100, 4))[0]!;
    expect([...frame]).toEqual([100, 101, 102, 103]);
  });

  test("帧长非法直接报错（静默产出空帧会让 VAD 永远收不了句）", () => {
    expect(() => createFrameSplitter(0)).toThrow();
    expect(() => createFrameSplitter(-1)).toThrow();
    expect(() => createFrameSplitter(Number.NaN)).toThrow();
  });
});
