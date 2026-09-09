import { expect, test } from "bun:test";
import { normalizeSegments, num } from "./asr-parse";

test("normalizes OpenAI-style seconds", () => {
  const segs = normalizeSegments({
    text: "你好世界",
    segments: [
      { start: 0, end: 2.5, text: "你好" },
      { start: 2.5, end: 5.32, text: "世界" },
    ],
  } as never);
  expect(segs).toEqual([
    { start: 0, end: 2.5, text: "你好" },
    { start: 2.5, end: 5.32, text: "世界" },
  ]);
});

test("normalizes millisecond timestamps and speaker ids", () => {
  const segs = normalizeSegments({
    text: "",
    segments: [
      { start: 0, end: 2500, text: "第一句", speaker: 0 },
      { start: 2500, end: 5300, text: "第二句", speaker_id: "1" },
      { start: 5300, end: 8100, text: "第三句", spk: 0 },
    ],
  });
  expect(segs).toEqual([
    { start: 0, end: 2.5, text: "第一句", speaker: 0 },
    { start: 2.5, end: 5.3, text: "第二句", speaker: 1 },
    { start: 5.3, end: 8.1, text: "第三句", speaker: 0 },
  ]);
});

test("falls back to offsets when start/end missing", () => {
  // whisper-cli 路径不走这里（它单独按厘秒 /100）；通用路径把 offsets 当秒处理。
  const segs = normalizeSegments({
    text: "",
    segments: [
      { text: "hello", offsets: { from: 0, to: 900 } },
    ] as never,
  });
  expect(segs[0]!.start).toBe(0);
  expect(segs[0]!.end).toBe(900);
});

test("drops empty text segments", () => {
  const segs = normalizeSegments({
    segments: [
      { start: 0, end: 1, text: "" },
      { start: 1, end: 2, text: "   " },
      { start: 2, end: 3, text: "有效" },
    ],
  });
  expect(segs).toHaveLength(1);
  expect(segs[0]!.text).toBe("有效");
});

test("num parses numbers and numeric strings", () => {
  expect(num(3.5)).toBe(3.5);
  expect(num("42")).toBe(42);
  expect(num("abc")).toBeUndefined();
  expect(num(undefined)).toBeUndefined();
});
