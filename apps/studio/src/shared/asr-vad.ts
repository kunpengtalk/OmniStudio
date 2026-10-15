/**
 * 语音活动检测（VAD）：把连续音频切成「一句一句」，这是「边说话边出字」的开关。
 *
 * 为什么必须做这一步：不做 VAD 就只有两种选择 —— 要么按固定间隔把**累计的整段音频**
 * 反复重转（录十分钟就是几百 MB 的请求，而且每句都要等好几秒、前面的结果还会被整段重写），
 * 要么让用户每说一句点一次按钮。按静音切句之后，每次只发这一句（几百 KB 以内），
 * 说完停顿约一秒就能落字，句子之间互不干扰 —— 这也是同类工具（见
 * `docs/`/提交说明里的对照分析）采用的做法。
 *
 * 算法与参数口径（与参考实现同量级，都在 16k 单声道上）：
 *   1. 先过噪声门（低于门限的采样直接归零），掉风扇 / 键盘的低电平底噪；
 *   2. 按 hop 统计 RMS 与峰值，任一超过阈值即算「这一帧有语音」；
 *   3. 有语音且此前静音 → 起句，并把**起句前的预备量**接上（否则第一个字常被切掉）；
 *   4. 连续 silenceHops 帧静音 → 收句；语音帧数不足 minSpeechHops 的片段丢掉（咳嗽 / 碰桌子）；
 *   5. 单句超过 maxUtteranceSeconds 强制作废，避免一段噪音把缓冲区撑爆；
 *   6. 收句时裁掉多余尾静音（保留一点，听感自然），再按峰值归一化 —— 小声说话也能识别。
 *
 * 纯逻辑、无 UI / 无 electrobun：单测直接覆盖（切句是最容易改坏、也最难靠肉眼发现的部分）。
 */

export type VadConfig = {
  /** 每帧样本数（16k 下 512 ≈ 32ms）。 */
  hopSize: number;
  /** 噪声门限：低于它的采样按 0 处理。 */
  noiseGate: number;
  /** 判定「有语音」的 RMS 阈值。 */
  rmsThreshold: number;
  /** 判定「有语音」的峰值阈值（与 RMS 是「或」的关系，抓爆破音）。 */
  peakThreshold: number;
  /** 连续多少帧静音算一句结束。 */
  silenceHops: number;
  /** 一句里至少要有多少帧语音，否则丢弃。 */
  minSpeechHops: number;
  /** 起句前接上的预备量帧数。 */
  preSpeechHops: number;
  /** 单句时长上限，超过就强制收句。 */
  maxUtteranceSeconds: number;
  /** 收句时保留的尾静音（毫秒），让结尾听感自然。 */
  tailSilenceMs: number;
  /** 收句后把峰值归一化到这个水平。 */
  normalizePeak: number;
};

/**
 * 默认值。灵敏度这一档是"家用麦克风 + 安静房间"的折中：
 * 阈值再低会把键盘声当语音切出大量空句，再高则会漏掉轻声起句。
 */
export const DEFAULT_VAD_CONFIG: VadConfig = {
  hopSize: 512,
  noiseGate: 0.006,
  rmsThreshold: 0.012,
  peakThreshold: 0.03,
  silenceHops: 32, // ≈1.0s
  minSpeechHops: 6, // ≈0.19s
  preSpeechHops: 6, // ≈0.19s
  maxUtteranceSeconds: 30,
  tailSilenceMs: 150,
  normalizePeak: 0.9,
};

/** 界面上暴露的三档灵敏度（只改阈值，其余参数不动）。 */
export type VadSensitivity = "low" | "medium" | "high";

export function applySensitivity(config: VadConfig, level: VadSensitivity): VadConfig {
  const scale = level === "high" ? 0.5 : level === "low" ? 2 : 1;
  return {
    ...config,
    rmsThreshold: DEFAULT_VAD_CONFIG.rmsThreshold * scale,
    peakThreshold: DEFAULT_VAD_CONFIG.peakThreshold * scale,
  };
}

export type VadEvent =
  /** 检测到起句；`startSec` 是它在整场录音里的位置。 */
  | { type: "speech-start"; startSec: number }
  /**
   * 一句话收尾，`audio` 是这一句的样本（已裁尾、已归一化）。
   * `startSec` / `endSec` 是**整场录音**里的位置：每句都是独立送检的，识别结果里的
   * 时间戳从 0 开始，只有这里的偏移才能把它们对回一条时间轴。
   * `reason: "max"` 表示是撞上限强制作废的（还在说话），界面据此决定要不要接着听。
   */
  | {
      type: "speech-end";
      audio: Float32Array;
      durationSec: number;
      startSec: number;
      endSec: number;
      reason: "silence" | "max";
    }
  /** 片段太短被丢掉（咳嗽、碰桌子、单字误触）。 */
  | { type: "discarded"; reason: "too-short" };

/** 逐帧的音频指标（导出是为了让阈值调参能被单测钉住）。 */
export function frameMetrics(frame: Float32Array, noiseGate: number): { rms: number; peak: number } {
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = Math.abs(frame[i] ?? 0) < noiseGate ? 0 : (frame[i] ?? 0);
    sum += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  return { rms: Math.sqrt(sum / Math.max(1, frame.length)), peak };
}

/** 峰值归一化：留出让放大后不削顶的余量，同时给增益设上限（否则纯静音会被抬成噪音）。 */
export function normalizePeak(samples: Float32Array, target: number, maxGain = 8): Float32Array {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i] ?? 0);
    if (a > peak) peak = a;
  }
  if (peak <= 0 || peak >= target) return samples;
  const gain = Math.min(target / peak, maxGain);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = Math.max(-1, Math.min(1, (samples[i] ?? 0) * gain));
  return out;
}

export type Vad = ReturnType<typeof createVad>;

/**
 * 逐帧喂音频，拿回切句事件。**帧长必须等于 `hopSize`**（调用方负责切帧），
 * 这样每条事件都能对应到确定的采样数，时间轴才准。
 */
export function createVad(overrides: Partial<VadConfig> = {}) {
  const config: VadConfig = { ...DEFAULT_VAD_CONFIG, ...overrides };
  const maxSamples = Math.max(config.hopSize, Math.round(config.maxUtteranceSeconds * 16000));
  const tailSamples = Math.round((config.tailSilenceMs / 1000) * 16000);

  /** 起句前的滚动预备量。 */
  let pre: Float32Array[] = [];
  let inSpeech = false;
  let speechHops = 0;
  let silenceHops = 0;
  let buffer: Float32Array[] = [];
  let buffered = 0;
  /** 已消费的总采样数（时间轴用，16k 口径）。 */
  let cursor = 0;
  /** 当前这一句在整场录音里的起点（含预备量）。 */
  let startCursor = 0;

  const reset = () => {
    pre = [];
    buffer = [];
    buffered = 0;
    inSpeech = false;
    speechHops = 0;
    silenceHops = 0;
    startCursor = 0;
  };

  const takeUtterance = (): Float32Array => {
    const out = new Float32Array(buffered);
    let at = 0;
    for (const chunk of buffer) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  };

  /** 裁掉多余尾静音：只留 tailSamples，避免每句都拖着一声"空"。 */
  const trimSilence = (extraSilenceSamples: number): Float32Array => {
    const trim = Math.max(0, extraSilenceSamples - tailSamples);
    const out = takeUtterance();
    if (trim <= 0 || out.length <= trim) return out;
    return out.subarray(0, out.length - trim);
  };

  const finish = (reason: "silence" | "max", extraSilenceSamples: number): VadEvent[] => {
    const events: VadEvent[] = [];
    const enoughSpeech = speechHops >= config.minSpeechHops;
    if (enoughSpeech && buffered > 0) {
      const audio = normalizePeak(trimSilence(extraSilenceSamples), config.normalizePeak);
      const startSec = startCursor / 16000;
      events.push({
        type: "speech-end",
        audio,
        durationSec: audio.length / 16000,
        startSec,
        // 用裁剪后的长度算结尾，而不是当前游标 —— 那些尾静音没有进这一句。
        endSec: startSec + audio.length / 16000,
        reason,
      });
    } else {
      events.push({ type: "discarded", reason: "too-short" });
    }
    reset();
    return events;
  };

  return {
    config,
    get inSpeech() {
      return inSpeech;
    },
    /** 已完成音频的时长（秒），用于界面上的计时。 */
    get cursorSec() {
      return cursor / 16000;
    },
    /**
     * 默认开关「一直在听」只需要喂帧；不需要额外调用。
     * 返回 0~2 条事件（起句与收句可能落在同一帧上：极短的静音间隔）。
     */
    push(frame: Float32Array): VadEvent[] {
      const events: VadEvent[] = [];
      cursor += frame.length;
      const { rms, peak } = frameMetrics(frame, config.noiseGate);
      const isSpeech = rms > config.rmsThreshold || peak > config.peakThreshold;

      if (isSpeech) {
        if (!inSpeech) {
          inSpeech = true;
          speechHops = 0;
          silenceHops = 0;
          buffer = [...pre];
          buffered = buffer.reduce((n, c) => n + c.length, 0);
          pre = [];
          // 起点 = 当前游标（已含本帧）回退「本句攒下的长度 + 这一帧」：
          // 此刻 buffered 只算上了预备量，本帧还没进 buffer。
          startCursor = Math.max(0, cursor - buffered - frame.length);
          events.push({ type: "speech-start", startSec: startCursor / 16000 });
        }
        speechHops += 1;
        silenceHops = 0;
        buffer.push(frame);
        buffered += frame.length;
        if (buffered >= maxSamples) {
          // 撞上限：还在说话也只能先落一句，否则一直在长的缓冲区既占内存又拖慢识别。
          events.push(...finish("max", 0));
        }
        return events;
      }

      // 静音
      if (inSpeech) {
        // 收句判定期间静音帧同样留在缓冲区里（句尾的停顿是真实停顿，切掉反而突兀），
        // 最后按 tailSilenceMs 统一裁一次。
        buffer.push(frame);
        buffered += frame.length;
        silenceHops += 1;
        if (silenceHops >= config.silenceHops) {
          events.push(...finish("silence", silenceHops * frame.length));
        }
        return events;
      }

      pre.push(frame);
      while (pre.length > config.preSpeechHops) pre.shift();
      return events;
    },
    /** 停止采集时把还没收尾的一句交出来（最后一句话不该因为"没等到静音"而丢掉）。 */
    flush(): VadEvent[] {
      if (!inSpeech) {
        reset();
        return [];
      }
      return finish("silence", 0);
    },
    /**
     * 正在说的这一句到目前为止的音频（没在说就返回 null）。
     * 给「边说边显示」的中间结果用：每隔一秒把这段先送去识别，字就跟着出来了，
     * 收句时再用完整的一句覆盖它。
     */
    snapshot(maxSeconds = 15): Float32Array | null {
      if (!inSpeech || buffered === 0) return null;
      const audio = takeUtterance();
      const cap = Math.round(maxSeconds * 16000);
      return audio.length > cap ? audio.subarray(audio.length - cap) : audio;
    },
    reset,
  };
}
