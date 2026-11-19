import { expect, test } from "bun:test";

import { createPcmQueue } from "./pcm-player";

/**
 * 云端实时 PCM 的播放队列：**连续取数必须与原始字节流逐样本一致**。
 *
 * 这是"杂音"的最后一道防线。前面两层（剥离误判的前缀、逐块切样本）已经修过，
 * 但即使数据对了，只要播放端把样本顺序搞乱一个位置，听感依然是白噪声。
 * 所以这里用一份合成的可辨识波形，走**真实的** `createPcmQueue`
 * （分块推入 + 按拍取出 + 奇数分片跨块拼接），最后逐样本比对。
 *
 * 播放器壳（ScriptProcessorNode）happy-dom 里没有，只能在真机验证；
 * 队列的连续性全部钉在这里。
 */

function pcm16(samples: number[]): Uint8Array {
  const b = new Uint8Array(samples.length * 2);
  const dv = new DataView(b.buffer);
  samples.forEach((v, i) => dv.setInt16(i * 2, v, true));
  return b;
}

/** 可辨识波形：正负往返 + 非对称，任何错位都会暴露。 */
const WAVE = Array.from({ length: 20000 }, (_, i) => Math.round(Math.sin(i / 7) * 12000) + (i % 97));

test("分块推入后连续取出，与原始样本逐位一致", () => {
  const src = pcm16(WAVE);
  const q = createPcmQueue();
  // 按真实帧长的比例切（9600 / 4800 交替）
  let pos = 0;
  let i = 0;
  while (pos < src.length) {
    const len = Math.min(i % 2 === 0 ? 9600 : 4800, src.length - pos);
    q.push(src.subarray(pos, pos + len));
    pos += len;
    i++;
  }
  const got: number[] = [];
  while (q.pendingBytes >= 2) {
    for (const v of q.take(2048)) got.push(v);
  }
  expect(got).toEqual(WAVE);
});

test("奇数分片跨块拼接：那个字节必须接到下一块开头，不能丢", () => {
  const src = pcm16(WAVE);
  const q = createPcmQueue();
  // 每块都切成奇数长度（4001 字节）—— 最容易暴露半个样本处理错误
  let pos = 0;
  while (pos < src.length) {
    const len = Math.min(4001, src.length - pos);
    q.push(src.subarray(pos, pos + len));
    pos += len;
  }
  const got: number[] = [];
  while (q.pendingBytes >= 2) {
    for (const v of q.take(2048)) got.push(v);
  }
  expect(got).toEqual(WAVE);
});

test("首字节 0x00 的帧照常播（不能被当成前缀处理）", () => {
  // 低字节为 0 的采样：256 的整数倍
  const samples = [0, 256, 512, -256, 768, -512];
  const src = pcm16(samples);
  expect(src[0]).toBe(0x00);
  const q = createPcmQueue();
  q.push(src);
  const got: number[] = [];
  while (q.pendingBytes >= 2) for (const v of q.take(64)) got.push(v);
  expect(got).toEqual(samples);
});

test("take 超出队列时只取现有部分（欠载补静音由播放器壳做）", () => {
  const samples = [10, 20, 30, 40];
  const q = createPcmQueue();
  q.push(pcm16(samples));
  const first = q.take(3);
  expect([...first]).toEqual([10, 20, 30]);
  const rest = q.take(10);
  expect([...rest]).toEqual([40]);
  expect(q.pendingBytes).toBe(0);
  expect([...q.take(8)]).toEqual([]);
});

test("reset 清空：打断之后不得再有旧样本被取出来", () => {
  const q = createPcmQueue();
  q.push(pcm16([1, 2, 3]));
  q.take(1); // 部分消费后 reset，readPos/carry 都要归零
  q.push(new Uint8Array([9])); // 留一个 carry 字节
  q.reset();
  expect(q.pendingBytes).toBe(0);
  q.push(pcm16([7, 8]));
  // carry 若没清掉，这里会先拼出半个来自旧数据的样本。
  expect([...q.take(16)]).toEqual([7, 8]);
});
