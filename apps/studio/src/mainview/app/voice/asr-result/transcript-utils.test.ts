import { describe, expect, test } from "bun:test";

import type { AsrSegment } from "../../../../bun/asr";
import {
  buildSrt,
  fmtClock,
  mergeSegments,
  searchSegments,
  speakerStyle,
  SPEAKER_STYLES,
  textScale,
} from "./transcript-utils";

const seg = (start: number, end: number, text: string, speaker?: number): AsrSegment => ({
  start,
  end,
  text,
  ...(speaker != null ? { speaker } : {}),
});

describe("mergeSegments（实时转写的增量合并）", () => {
  test("第一批直接采用", () => {
    const first = [seg(0, 2, "你好")];
    expect(mergeSegments([], first)).toEqual(first);
  });

  test("时间相近的片段被后到的结果替换（实时转写整段重转，前面那句可能被修正）", () => {
    const prev = [seg(0, 2, "你好世"), seg(2, 4, "欢迎")];
    const next = [seg(0, 2.3, "你好世界"), seg(2, 4.1, "欢迎你")];
    const out = mergeSegments(prev, next);
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.text)).toEqual(["你好世界", "欢迎你"]);
  });

  test("明显是新句子的（起点差 > 1.2s）追加进来", () => {
    const out = mergeSegments([seg(0, 2, "甲")], [seg(5, 7, "乙")]);
    expect(out.map((s) => s.text)).toEqual(["甲", "乙"]);
  });

  test("结果始终按时间排序（上游可能乱序返回）", () => {
    const out = mergeSegments([seg(10, 12, "后")], [seg(0, 2, "前")]);
    expect(out.map((s) => s.text)).toEqual(["前", "后"]);
  });
});

describe("searchSegments（稿内查找）", () => {
  const segments = [seg(0, 1, "Hello World"), seg(1, 2, "第二个问题"), seg(2, 3, "world peace")];

  test("空关键字返回全部，并带上原始下标", () => {
    const hit = searchSegments(segments, "  ");
    expect(hit.map((h) => h.index)).toEqual([0, 1, 2]);
  });

  test("忽略大小写，命中项带原始下标（点击要能定位回音频）", () => {
    const hit = searchSegments(segments, "WORLD");
    expect(hit.map((h) => h.index)).toEqual([0, 2]);
  });

  test("中文子串命中；没有命中返回空数组", () => {
    expect(searchSegments(segments, "问题").map((h) => h.index)).toEqual([1]);
    expect(searchSegments(segments, "不存在")).toEqual([]);
  });
});

describe("时间与字幕格式", () => {
  test("fmtClock：分秒 / 时分秒，负数与非数按 0 处理", () => {
    expect(fmtClock(0)).toBe("0:00");
    expect(fmtClock(65)).toBe("1:05");
    expect(fmtClock(3725)).toBe("1:02:05");
    expect(fmtClock(-5)).toBe("0:00");
    expect(fmtClock(NaN)).toBe("0:00");
  });

  test("buildSrt：序号 + 时间码 + 说话人前缀", () => {
    const srt = buildSrt([seg(0, 1.5, "第一句", 1)], true, "说话人");
    expect(srt).toBe("1\n00:00:00,000 --> 00:00:01,500\n[说话人 2] 第一句");
  });

  test("buildSrt：无人声分离信息时不加说话人前缀", () => {
    const srt = buildSrt([seg(1, 2, "第二句", 0)], false, "说话人");
    expect(srt).toBe("1\n00:00:01,000 --> 00:00:02,000\n第二句");
  });
});

describe("说话人配色与字号", () => {
  test("配色表按说话人编号循环，超大编号也不越界", () => {
    expect(speakerStyle(0)).toBe(SPEAKER_STYLES[0]!);
    expect(speakerStyle(SPEAKER_STYLES.length)).toBe(SPEAKER_STYLES[0]!);
    expect(speakerStyle(SPEAKER_STYLES.length + 3)).toBe(SPEAKER_STYLES[3]!);
    expect(speakerStyle(9999)).toBeDefined();
  });

  test("字号档位：认识的取到，不认识的回落中号", () => {
    expect(textScale("xl").className).toBe("text-[17px]");
    // @ts-expect-error 运行期可能拿到老配置里的值
    expect(textScale("huge")).toBe(textScale("m"));
  });
});
