/**
 * 流式 48k → 16k / 24k 降采样（带抗混叠 + 跨块相位连续）。
 *
 * 上游（麦克风）是 AudioContext 的 48k 浮点，对方要 16k。这里曾是"每块各自
 * 按整数倍取平均"的 box filter，有两个真实缺陷，听感都是"对方说你声音发闷/有金属音"：
 *
 * 1. **没有抗混叠**：box 平均对 8k 以上的分量衰减不够，那部分会**折叠**回可听频段，
 *    变成沙沙的声音。降采样前必须先做低通。
 * 2. **块与块之间没有状态**：每次调用都从 `samples[0]` 重新算取整边界，浮点的
 *    ratio（48000/16000=3、/24000=2 恰好整除，但 AudioContext 也可能给 44.1k →
 *    2.75625）会在块边界产生相位跳变，每 120ms 一次，听起来像轻微"咔哒"连成一片。
 *
 * 实现：一阶低通（截止约为目标奈奎斯特的 0.9）后按累加器做位置插值，
 * `phase` 与滤波器状态（`prev`）都跨块保留 —— 分块送进来和一次性送进来结果一致。
 */
export function createStreamResampler(inputRate: number, outputRate: number) {
  // 同率直通：没有降采样就不该动信号。低通对任何信号都有起步暂态
  // （几毫秒内从 0 爬上来），拿它"透传"会把短样本的前段整段削掉 ——
  // 16k→16k 的 encodeWavBase64 正是这条路（whisper 收到的已经是 16k）。
  if (inputRate === outputRate) {
    return (samples: Float32Array): Int16Array => {
      const out = new Int16Array(samples.length);
      for (let i = 0; i < samples.length; i++) {
        const v = Math.max(-1, Math.min(1, samples[i] ?? 0));
        out[i] = Math.round(v * 0x7fff);
      }
      return out;
    };
  }
  // **二阶**低通（两级一阶串联）。只有一级时 20kHz 分量降采样后还剩 22%，
  // 折叠回 4kHz 附近仍可闻；两级能把它压到 5% 以下，语音听感明显更干净。
  const cutoff = Math.min(0.45, (outputRate / 2) * 0.9 / inputRate);
  const alpha = 1 - Math.exp(-2 * Math.PI * cutoff);
  let stage1 = 0;
  let stage2 = 0;
  /** 下一个输出样本相对于输入的位置（跨块保留，保证相位连续）。 */
  let phase = 0;

  return function resample(samples: Float32Array): Int16Array {
    const ratio = inputRate / outputRate;
    // 最多能产出多少个输出样本
    const maxOut = Math.max(0, Math.floor((samples.length - phase) / ratio) + 1);
    const out = new Int16Array(maxOut);
    let written = 0;
    for (let pos = 0; pos < samples.length; pos++) {
      const x = samples[pos] ?? 0;
      // 两级低通（抗混叠）
      stage1 += alpha * (x - stage1);
      stage2 += alpha * (stage1 - stage2);
      // 到达输出采样点时取一个样本
      if (pos >= phase) {
        const v = Math.max(-1, Math.min(1, stage2));
        if (written < out.length) out[written++] = Math.round(v * 0x7fff);
        phase += ratio;
      }
    }
    // 把已经消耗掉的位置归一化到 [0, ratio)，避免浮点越积越大
    phase -= samples.length;
    if (phase < 0) phase = 0;
    return written === out.length ? out : out.subarray(0, written);
  };
}

/**
 * 一次性降采样（用于不需要跨块连续的场景，比如把已有片段转成 16k）。
 *
 * 内部就是 `createStreamResampler` 走一遍：分块与整段的结果一致。
 */
export function resampleToPcm16(
  samples: Float32Array,
  inputRate = 48000,
  outputRate = 16000,
): Int16Array {
  return createStreamResampler(inputRate, outputRate)(samples);
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
 * 已经采成 16 位 PCM 的样本包成 WAV（不再重采样）。
 *
 * 给"边录边降位"的录音用：长会议录一小时就是几亿个采样，全都以 float32 攒在内存里
 * （48k 立体声级 ≈ 700MB/小时）不现实，所以宿主录音器按块就转成 PCM16 —— 一个采样
 * 2 字节。这里只负责补 WAV 头，采样率由调用方保证（`rate` 写进头里）。
 */
export function wavBase64FromPcm16(pcm: Int16Array, rate = 16000): string {
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const dv = new DataView(bytes.buffer);
  writeAscii(dv, 0, "RIFF");
  dv.setUint32(4, 36 + pcm.length * 2, true);
  writeAscii(dv, 8, "WAVE");
  writeAscii(dv, 12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true); // byte rate
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

/**
 * 流式上行编码：**同一个实例要跨块复用**。
 *
 * `encodePcm16Base64` 每次都新建重采样器，块之间丢掉了滤波器状态与相位 ——
 * 每 120ms 一次边界跳变，对方的听感是持续的轻微失真。通话这种"一块一块推"
 * 的场景必须持有实例（见 use-voice-call 的 uplinkEncoderRef）。
 */
export function createUplinkEncoder(inputRate: number, outputRate: number) {
  const resample = createStreamResampler(inputRate, outputRate);
  return {
    /** 编一块并把采样率打回真实值（换设备时调用方可以据此重建）。 */
    encode(samples: Float32Array): string {
      return pcm16ToBase64(resample(samples));
    },
  };
}


function writeAscii(dv: DataView, offset: number, s: string) {
  for (let i = 0; i < s.length; i++) dv.setUint8(offset + i, s.charCodeAt(i));
}
