/**
 * Encode mono float32 PCM samples (from AudioContext, typically 48 kHz) as
 * 16-bit PCM at a lower rate. A small box filter decimation reduces aliasing
 * during downsampling.
 */
export function resampleToPcm16(
  samples: Float32Array,
  inputRate = 48000,
  outputRate = 16000,
): Int16Array {
  const ratio = inputRate / outputRate;
  const outLen = Math.max(1, Math.floor(samples.length / ratio));
  const pcm = new Int16Array(outLen);

  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), samples.length);
    if (end <= start) continue;
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j] ?? 0;
    const v = Math.max(-1, Math.min(1, sum / (end - start)));
    pcm[i] = v * 0x7fff;
  }
  return pcm;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) {
    const v16 = pcm[i] ?? 0;
    bytes[i * 2] = v16 & 0xff;
    bytes[i * 2 + 1] = (v16 >> 8) & 0xff;
  }
  return bytesToBase64(bytes);
}

/**
 * Encode mono float32 PCM samples (from AudioContext, typically 48 kHz) as a
 * base64 16-bit PCM WAV at 16 kHz — the format whisper.cpp expects.
 */
export function encodeWavBase64(
  samples: Float32Array,
  inputRate = 48000,
  outputRate = 16000,
): string {
  const pcm = resampleToPcm16(samples, inputRate, outputRate);

  const bytes = new Uint8Array(44 + pcm.length * 2);
  const dv = new DataView(bytes.buffer);
  writeAscii(dv, 0, "RIFF");
  dv.setUint32(4, 36 + pcm.length * 2, true);
  writeAscii(dv, 8, "WAVE");
  writeAscii(dv, 12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, outputRate, true);
  dv.setUint32(28, outputRate * 2, true); // byte rate
  dv.setUint16(32, 2, true); // block align
  dv.setUint16(34, 16, true); // bits per sample
  writeAscii(dv, 36, "data");
  dv.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const v16 = pcm[i] ?? 0;
    bytes[44 + i * 2] = v16 & 0xff;
    bytes[45 + i * 2] = (v16 >> 8) & 0xff;
  }
  return bytesToBase64(bytes);
}

/**
 * Encode samples as raw PCM16 base64 (no WAV header) at 16 kHz — the format
 * the Qwen Realtime input_audio_buffer.append expects. 云端模式增量推流用。
 */
export function encodePcm16Base64(
  samples: Float32Array,
  inputRate = 48000,
  outputRate = 16000,
): string {
  return pcm16ToBase64(resampleToPcm16(samples, inputRate, outputRate));
}

function writeAscii(dv: DataView, offset: number, s: string) {
  for (let i = 0; i < s.length; i++) dv.setUint8(offset + i, s.charCodeAt(i));
}
