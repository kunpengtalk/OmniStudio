import { describe, expect, test } from "bun:test";

import type { AsrSegment } from "../../bun/asr";
import { findActiveSegment, offsetUtteranceSegments } from "./segments";

const seg = (start: number, end: number, text: string, speaker?: number): AsrSegment => ({
  start,
  end,
  text,
  ...(speaker != null ? { speaker } : {}),
});

/**
 * 自动听写是一句一句送检的，引擎给的时间戳都从这一句的 0 开始。
 * 这个换算错了，逐句列表里所有句子都会挤在 0:00，而且会被去重逻辑合并成一条 ——
 * 界面上看起来"只识别出一句"，但音频其实全都识别了。
 */
describe("offsetUtteranceSegments", () => {
  test("引擎分段按这一句的起点整体平移", () => {
    const out = offsetUtteranceSegments([seg(0, 1.5, "前半句"), seg(1.5, 3, "后半句")], "", {
      startSec: 65,
      endSec: 68,
    });
    expect(out.map((s) => [s.start, s.end])).toEqual([
      [65, 66.5],
      [66.5, 68],
    ]);
  });

  test("引擎只回整段文本时，按这一句的起止造一条", () => {
    const out = offsetUtteranceSegments([], "只有一句话", { startSec: 10, endSec: 12.5 });
    expect(out).toEqual([{ start: 10, end: 12.5, text: "只有一句话" }]);
  });

  test("空文本不造出空行", () => {
    expect(offsetUtteranceSegments([], "   ", { startSec: 0, endSec: 1 })).toEqual([]);
    expect(offsetUtteranceSegments([seg(0, 1, "  ")], "", { startSec: 0, endSec: 1 })).toEqual([]);
  });

  test("超出这一句长度的结束时间被夹回句内（时间轴不重叠）", () => {
    const out = offsetUtteranceSegments([seg(0, 99, "幻觉的长尾")], "", { startSec: 5, endSec: 7 });
    expect(out[0]!.end).toBe(7);
  });

  test("说话人信息原样保留（下游要按它上色）", () => {
    const out = offsetUtteranceSegments([seg(0, 1, "甲", 2)], "", { startSec: 3, endSec: 4 });
    expect(out[0]!.speaker).toBe(2);
  });

  test("平移后的结果与整体转写的结果落在同一条时间轴上（可被 findActiveSegment 正常定位）", () => {
    const out = offsetUtteranceSegments([seg(0, 2, "第一句")], "", { startSec: 30, endSec: 32 });
    expect(findActiveSegment(out, 31)).toBe(0);
    expect(findActiveSegment(out, 10)).toBe(-1);
  });
});
