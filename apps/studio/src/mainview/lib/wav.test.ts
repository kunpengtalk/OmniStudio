import { expect, test } from "bun:test";

import { encodeWavBase64, wavBase64FromPcm16 } from "./wav";

function decodeHeader(base64: string) {
  const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
  const dv = new DataView(bytes.buffer);
  const ascii = (at: number, len: number) =>
    String.fromCharCode(...bytes.subarray(at, at + len));
  return {
    bytes,
    riff: ascii(0, 4),
    wave: ascii(8, 4),
    fmt: ascii(12, 4),
    data: ascii(36, 4),
    audioFormat: dv.getUint16(20, true),
    channels: dv.getUint16(22, true),
    rate: dv.getUint32(24, true),
    byteRate: dv.getUint32(28, true),
    bits: dv.getUint16(34, true),
    dataSize: dv.getUint32(40, true),
  };
}

/**
 * 宿主录音器按块转 PCM16 之后，最后一步就是包这个头。头写错的表现很隐蔽：
 * 采样率写成 16000 而数据其实是 48000（或反过来），转写会变调、识别率暴跌，
 * 但没有任何报错。
 */
test("PCM16 包 WAV：头字段与数据长度一致", () => {
  const pcm = new Int16Array([0, 1, -1, 32767, -32768]);
  const h = decodeHeader(wavBase64FromPcm16(pcm, 16000));

  expect(h.riff).toBe("RIFF");
  expect(h.wave).toBe("WAVE");
  expect(h.fmt).toBe("fmt ");
  expect(h.data).toBe("data");
  expect(h.audioFormat).toBe(1); // PCM
  expect(h.channels).toBe(1);
  expect(h.rate).toBe(16000);
  expect(h.byteRate).toBe(16000 * 2);
  expect(h.bits).toBe(16);
  expect(h.dataSize).toBe(pcm.length * 2);
  expect(h.bytes.length).toBe(44 + pcm.length * 2);
  // RIFF 块长度 = 整个文件 - 8
  expect(new DataView(h.bytes.buffer).getUint32(4, true)).toBe(h.bytes.length - 8);
});

test("PCM16 包 WAV：采样按小端补码写入（不重采样）", () => {
  const h = decodeHeader(wavBase64FromPcm16(new Int16Array([1000, -1000]), 16000));
  const sampleAt = (i: number) =>
    ((h.bytes[44 + i * 2]! | (h.bytes[45 + i * 2]! << 8)) << 16) >> 16;
  expect(sampleAt(0)).toBe(1000);
  expect(sampleAt(1)).toBe(-1000);
});

test("16k 的 float 样本经 encodeWavBase64 后与直接包 PCM16 一致（只差量化误差，不会变速）", () => {
  // 录音引擎给的是 16k 时宿主走 wavBase64FromPcm16，否则走 encodeWavBase64 重采样。
  // 两条路径对同一段 16k 音频必须产出同样长度、同样速率的 WAV；样本允许差 1 个最低位
  // （一条是 Int16Array 赋值截断，一条是 Math.round），但**绝不能**差出整数倍 ——
  // 那意味着有人把采样率搞错了，听感变调、识别率断崖。
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
  const viaFloat = decodeHeader(encodeWavBase64(samples, 16000, 16000));
  const viaPcm = decodeHeader(wavBase64FromPcm16(new Int16Array([0, 16384, -16384, 32767, -32767]), 16000));
  expect(viaFloat.rate).toBe(viaPcm.rate);
  expect(viaFloat.dataSize).toBe(viaPcm.dataSize);

  const read = (bytes: Uint8Array, i: number) =>
    ((bytes[44 + i * 2]! | (bytes[45 + i * 2]! << 8)) << 16) >> 16;
  for (let i = 0; i < samples.length; i += 1) {
    expect(Math.abs(read(viaFloat.bytes, i) - read(viaPcm.bytes, i))).toBeLessThanOrEqual(1);
  }
});
