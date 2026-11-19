import { expect, test } from "bun:test";

import { createStreamResampler, createUplinkEncoder } from "./wav";

/**
 * 上行（麦克风 → 对方）的 48k 降采样。
 *
 * 这里曾是"每块各自按整数倍取平均"的 box filter，两个缺陷都会让对方觉得
 * "你声音发闷 / 有金属音"：
 *   1. 无抗混叠 —— 8k 以上分量折叠回可听频段，变成沙沙声；
 *   2. 无跨块状态 —— 每块从 samples[0] 重算边界，120ms 一次的相位跳变。
 *
 * 下面三条分别钉住：分块与整段等价、抗混叠有效、样本总量不丢。
 */

const RATE_IN = 48000;

/** 生成一秒 440Hz 正弦（可听频段内的干净信号）。 */
function tone(freq: number, n = RATE_IN): Float32Array {
  const sig = new Float32Array(n);
  for (let i = 0; i < n; i++) sig[i] = Math.sin((2 * Math.PI * freq * i) / RATE_IN) * 0.5;
  return sig;
}

test("分块送与整段送输出一致（跨块保留滤波器状态与相位）", () => {
  const sig = tone(440);
  const whole = createStreamResampler(RATE_IN, 16000)(sig);

  // 按通话的真实节奏分块（约 120ms 一块）
  const rs = createStreamResampler(RATE_IN, 16000);
  const parts: number[] = [];
  const chunk = Math.round(RATE_IN * 0.12);
  for (let off = 0; off < sig.length; off += chunk) {
    for (const v of rs(sig.subarray(off, Math.min(off + chunk, sig.length)))) parts.push(v);
  }

  expect(Math.abs(parts.length - whole.length)).toBeLessThanOrEqual(2);
  // 只要有一个样本因相位重置而跳变，这条就会失败。
  let diff = 0;
  for (let i = 0; i < Math.min(parts.length, whole.length); i++) {
    if (Math.abs(parts[i]! - whole[i]!) > 2) diff++;
  }
  expect(diff).toBe(0);
});

test("抗混叠：20kHz 分量降到 16k 后必须大幅衰减（否则折叠成沙沙声）", () => {
  const out = createStreamResampler(RATE_IN, 16000)(tone(20000));
  let peak = 0;
  // 跳过滤波器起始瞬态
  for (let i = 20; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]!));
  expect(peak / 0x7fff).toBeLessThan(0.15);
});

test("可听频段不被误伤：1kHz 分量应当基本原样通过", () => {
  const out = createStreamResampler(RATE_IN, 16000)(tone(1000));
  let peak = 0;
  for (let i = 20; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]!));
  // 原始幅度 0.5，通带内应保留大半
  expect(peak / 0x7fff).toBeGreaterThan(0.3);
});

test("逐块编码不丢样本总量（1 秒 → 约 32000 字节 @16k/16bit）", () => {
  const enc = createUplinkEncoder(RATE_IN, 16000);
  const chunk = 4800; // 100ms
  let bytes = 0;
  for (let k = 0; k < 10; k++) {
    bytes += Buffer.from(enc.encode(new Float32Array(chunk).fill(0.1)), "base64").length;
  }
  expect(Math.abs(bytes - 32000)).toBeLessThan(200);
});
