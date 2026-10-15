import { describe, expect, test } from "bun:test";

import {
  applySensitivity,
  createVad,
  DEFAULT_VAD_CONFIG,
  frameMetrics,
  normalizePeak,
  type VadConfig,
  type VadEvent,
} from "./asr-vad";

/**
 * 切句测试用的小参数：hop = 4 采样，读起来就是"帧"而不是几百个样本。
 * 阈值调得很干净 —— 安静帧 0.02（非零但不算语音，用来验证预备量真的被接上），
 * 语音帧 0.5。噪声门关掉，否则 0.02 会被归零，就看不出预备量了。
 */
const TINY: Partial<VadConfig> = {
  hopSize: 4,
  noiseGate: 0,
  rmsThreshold: 0.05,
  peakThreshold: 0.1,
  silenceHops: 2,
  minSpeechHops: 2,
  preSpeechHops: 2,
  maxUtteranceSeconds: 30,
  tailSilenceMs: 0,
};

const frame = (amp: number, hop = TINY.hopSize!) => new Float32Array(hop).fill(amp);
const quiet = () => frame(0.02);
const loud = () => frame(0.5);

/** 把一串帧喂进去，收集事件。 */
function feed(vad: ReturnType<typeof createVad>, frames: Float32Array[]): VadEvent[] {
  const out: VadEvent[] = [];
  for (const f of frames) out.push(...vad.push(f));
  return out;
}

describe("切句：起句 / 收句 / 丢弃", () => {
  test("全程安静：没有任何事件", () => {
    const vad = createVad(TINY);
    expect(feed(vad, Array.from({ length: 20 }, quiet))).toEqual([]);
    expect(vad.inSpeech).toBe(false);
  });

  test("说一句 → 静音够久就收句，且起句前的预备量被接在这句前面", () => {
    const vad = createVad(TINY);
    const events = feed(vad, [quiet(), quiet(), loud(), loud(), quiet(), quiet()]);

    expect(events.map((e) => e.type)).toEqual(["speech-start", "speech-end"]);
    const end = events[1]!;
    expect(end.type).toBe("speech-end");
    if (end.type !== "speech-end") throw new Error("unreachable");
    // 2 帧预备量 + 2 帧语音 = 16 个采样（2 帧尾静音被裁掉，tailSilenceMs = 0）
    expect(end.audio.length).toBe(16);
    expect(end.reason).toBe("silence");
    expect(end.durationSec).toBeCloseTo(16 / 16000, 6);
    // 前 8 个采样是预备量（比语音安静），后 8 个是语音本身 —— 证明第一个字不会被切掉。
    expect(end.audio[0]!).toBeGreaterThan(0);
    expect(end.audio[0]!).toBeLessThan(end.audio[8]!);
    // 收句后回到待命，可以接着听下一句。
    expect(vad.inSpeech).toBe(false);
  });

  test("事件带整场录音里的位置：每句独立送检，只有这个偏移能把它们对回同一条时间轴", () => {
    const vad = createVad({ ...TINY, hopSize: 160, silenceHops: 2, minSpeechHops: 2, preSpeechHops: 2 });
    // 10 帧静音（1s）→ 说 2 帧 → 2 帧静音收句 → 再 10 帧静音 → 第二句
    const events = feed(vad, [
      ...Array.from({ length: 10 }, () => frame(0.02, 160)),
      frame(0.5, 160),
      frame(0.5, 160),
      frame(0.02, 160),
      frame(0.02, 160),
      ...Array.from({ length: 10 }, () => frame(0.02, 160)),
      frame(0.5, 160),
      frame(0.5, 160),
      frame(0.02, 160),
      frame(0.02, 160),
    ]);
    const first = events.find((e) => e.type === "speech-start")!;
    const ends = events.filter((e) => e.type === "speech-end");
    expect(ends).toHaveLength(2);

    const [a, b] = ends as Extract<VadEvent, { type: "speech-end" }>[];
    // 一帧 = 160 采样 = 0.01s：第一句从 10 帧静音后起，扣掉 2 帧预备量 = 0.08s；
    // 句子长 4 帧 = 0.04s（2 帧语音 + 2 帧尾静音被裁掉）。
    expect(first.type === "speech-start" && first.startSec).toBeCloseTo(0.08, 3);
    expect(a!.startSec).toBeCloseTo(0.08, 3);
    expect(a!.endSec).toBeCloseTo(0.12, 3);
    expect(a!.endSec - a!.startSec).toBeCloseTo(a!.durationSec, 6);
    // 第二句在第一句之后（不是又从 0 开始）
    expect(b!.startSec).toBeGreaterThan(a!.endSec);
  });

  test("太短的片段被丢掉（咳嗽 / 碰桌子 / 单字误触），不会落成一句", () => {
    const vad = createVad(TINY);
    const events = feed(vad, [loud(), quiet(), quiet()]);
    expect(events.map((e) => e.type)).toEqual(["speech-start", "discarded"]);
  });

  test("句间极短的静音（不足 silenceHops）不会把一句话切成两句", () => {
    const vad = createVad(TINY);
    const events = feed(vad, [loud(), loud(), quiet(), loud(), loud(), quiet(), quiet()]);
    expect(events.filter((e) => e.type === "speech-end")).toHaveLength(1);
    expect(events.filter((e) => e.type === "speech-start")).toHaveLength(1);
  });

  test("说话超过上限：强制收句（reason=max），并立刻开始听下一段", () => {
    // maxUtteranceSeconds 很小 → 上限 = 16 个采样 = 4 帧
    const vad = createVad({ ...TINY, maxUtteranceSeconds: 0.001 });
    const events = feed(vad, [loud(), loud(), loud(), loud(), loud()]);
    const ends = events.filter((e) => e.type === "speech-end");
    expect(ends).toHaveLength(1);
    expect(ends[0]!.type === "speech-end" && ends[0]!.reason).toBe("max");
    // 第 5 帧已经在听新的一段了。
    expect(vad.inSpeech).toBe(true);
  });

  test("停止采集时把没等到静音的那句交出来（最后一句话不能丢）", () => {
    const vad = createVad(TINY);
    feed(vad, [loud(), loud(), loud()]);
    expect(vad.inSpeech).toBe(true);
    const flushed = vad.flush();
    expect(flushed.map((e) => e.type)).toEqual(["speech-end"]);
    expect(vad.inSpeech).toBe(false);
    // 已经收尾后再 flush 不该再吐东西。
    expect(vad.flush()).toEqual([]);
  });

  test("cursorSec 反映已消费的音频长度（界面计时用）", () => {
    const vad = createVad({ ...TINY, hopSize: 1600 }); // 0.1s 一帧
    feed(vad, [frame(0, 1600), frame(0, 1600), frame(0, 1600)]);
    expect(vad.cursorSec).toBeCloseTo(0.3, 3);
  });
});

describe("音频指标与归一化", () => {
  test("噪声门把低电平采样归零后再统计", () => {
    const quietFrame = new Float32Array([0.001, -0.002, 0.003, -0.004]);
    expect(frameMetrics(quietFrame, 0.006)).toEqual({ rms: 0, peak: 0 });
    // 门限关掉时能看见它们
    expect(frameMetrics(quietFrame, 0).peak).toBeCloseTo(0.004, 6);
  });

  test("小声说话被抬到目标峰值", () => {
    // 0.2 → 0.9 需要 4.5 倍，在默认 8 倍上限内。
    const out = normalizePeak(new Float32Array([0.2, -0.1]), 0.9);
    expect(Math.max(...out)).toBeCloseTo(0.9, 5);
    // 相对关系不变（不是削平，是整体放大）
    expect(out[0]! / Math.abs(out[1]!)).toBeCloseTo(2, 5);
  });

  test("已经够响的不动；纯静音不放大（否则底噪会被抬成噪音）", () => {
    const loud = new Float32Array([0.95, -0.9]);
    expect(normalizePeak(loud, 0.9)).toBe(loud);
    const silent = new Float32Array([0, 0, 0]);
    expect(normalizePeak(silent, 0.9)).toBe(silent);
  });

  test("增益有上限：比目标低太多的信号不会被放大到失真的程度", () => {
    const tiny = new Float32Array([0.001, -0.001]);
    const out = normalizePeak(tiny, 0.9, 2); // 最多 2 倍
    expect(Math.max(...out)).toBeCloseTo(0.002, 6);
  });
});

describe("灵敏度档位", () => {
  test("三档只改阈值，且单调（高灵敏更容易判成语音）", () => {
    const low = applySensitivity(DEFAULT_VAD_CONFIG, "low");
    const mid = applySensitivity(DEFAULT_VAD_CONFIG, "medium");
    const high = applySensitivity(DEFAULT_VAD_CONFIG, "high");
    expect(low.rmsThreshold).toBeGreaterThan(mid.rmsThreshold);
    expect(high.rmsThreshold).toBeLessThan(mid.rmsThreshold);
    expect(mid.rmsThreshold).toBe(DEFAULT_VAD_CONFIG.rmsThreshold);
    // 其余参数不跟着变（静音时长这类由用户单独调）
    expect(high.silenceHops).toBe(DEFAULT_VAD_CONFIG.silenceHops);
  });
});
