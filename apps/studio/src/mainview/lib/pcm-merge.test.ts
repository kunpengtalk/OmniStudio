import { expect, test } from "bun:test";

/**
 * 云端实时音频（裸 PCM16）的解码与拼接规则。
 *
 * 两个真实踩过的坑，听感都是"杂音严重 / 刺耳白噪声"，表面上完全看不出是代码问题：
 *
 * 1. **不能按首字节猜 tagged-v1 前缀**。下行是裸 PCM16，而 16bit 采样的首字节是
 *    **低字节** —— 正常语音里它经常正好是 0x00（任何 256 整数倍的采样值，以及接近
 *    静音的样本）。按 `buf[0] === 0x00` 剥掉一个字节后，这一帧里所有采样的高低字节
 *    全部颠倒，那段音频就变成白噪声。
 * 2. **必须先拼字节流再切样本**。PCM16 的"块"只是 WebSocket 分片，字节流本身连续；
 *    逐块各自 `floor(len/2)` 的话，某块长度为奇数时会丢掉末尾半个样本，**它之后的
 *    所有采样都错位一个字节**（同样听成白噪声）。
 *
 * 这里把 `pcmBatchToAudioBuffer` 的合并算法单独复刻出来（它只依赖 DataView，
 * 不碰 Web Audio），用来钉住上面两条。
 */

/** 修复后的合并：先拼成一条字节流，再整体按 16bit 切样本。 */
function mergeChunksFixed(chunks: Uint8Array[]): Int16Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  const frames = Math.floor(total / 2);
  const out = new Int16Array(frames);
  const dv = new DataView(all.buffer, all.byteOffset, all.byteLength);
  for (let i = 0; i < frames; i++) out[i] = dv.getInt16(i * 2, true);
  return out;
}

/** 逐块各自切样本（修复前的实现），用来证明这个 bug 真实存在。 */
function mergeChunksPerBlock(chunks: Uint8Array[]): Int16Array {
  const parts: Int16Array[] = [];
  for (const c of chunks) {
    const frames = Math.floor(c.length / 2);
    const dv = new DataView(c.buffer, c.byteOffset, c.byteLength);
    const a = new Int16Array(frames);
    for (let i = 0; i < frames; i++) a[i] = dv.getInt16(i * 2, true);
    parts.push(a);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Int16Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function pcm16(samples: number[]): Uint8Array {
  const b = new Uint8Array(samples.length * 2);
  const dv = new DataView(b.buffer);
  samples.forEach((v, i) => dv.setInt16(i * 2, v, true));
  return b;
}

/** 一段可辨识的采样（含正负、非对称，错位一定会被发现）。 */
const RAMP = Array.from({ length: 100 }, (_, i) => (i - 50) * 600);

test("修复后：正常分块拼接，采样与原始完全一致", () => {
  const src = pcm16(RAMP);
  const chunks = [src.subarray(0, 40), src.subarray(40, 100), src.subarray(100)];
  expect([...mergeChunksFixed(chunks)]).toEqual(RAMP);
});

test("修复后：夹一个奇数长度分片，后续采样不再错位", () => {
  // 41 字节是奇数 —— WebSocket 分片不保证按样本对齐，这是会真实发生的。
  const src = pcm16(RAMP);
  const chunks = [src.subarray(0, 41), src.subarray(41)];
  expect([...mergeChunksFixed(chunks)]).toEqual(RAMP);
});

test("修复前逐块切样本：奇数分片之后全部错位（这就是杂音来源）", () => {
  const src = pcm16(RAMP);
  const chunks = [src.subarray(0, 41), src.subarray(41)];
  const broken = mergeChunksPerBlock(chunks);
  const mismatches = RAMP.filter((v, i) => broken[i] !== v).length;
  // 丢掉半个样本后，后面的字节全部高低颠倒 —— 绝大部分采样都对不上。
  expect(mismatches).toBeGreaterThan(50);
});

test("首字节为 0x00 是正常采样值，不是 tagged-v1 前缀", () => {
  // 256 的整数倍采样，低字节必然是 0x00；静音（0）也是。这类帧很常见。
  const values = [0, 256, 512, -256, 768];
  for (const v of values) {
    const bytes = pcm16([v]);
    expect(bytes[0]).toBe(0x00);
  }
  // 剥掉首字节会把 0 读成 0 但把 256 读成 1：整段电平塌到几乎静音/噪声。
  const stripped = pcm16([256]).subarray(1);
  expect(stripped.length).toBe(1); // 只剩半个样本
});
