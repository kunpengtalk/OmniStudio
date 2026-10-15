import { useEffect, useRef, useState } from "react";

import { createVad, DEFAULT_VAD_CONFIG, type VadConfig, type VadEvent } from "@/shared/asr-vad";
import { createFrameSplitter } from "@/mainview/lib/audio-frames";
import { resampleToPcm16, wavBase64FromPcm16 } from "@/mainview/lib/wav";

/**
 * 自动听写（连续采集 + VAD 切句）：
 * 麦克风一直开着，本地按静音把话切成一句一句，**每切出一句就回调一次**
 * （`onUtterance`），并且在一句话还没说完时按 `interimMs` 回调中间结果
 * （`onInterim`）—— 前者是最终的句子，后者让字在人还在说的时候就先冒出来。
 *
 * 与旧的 `use-mic-recorder` 的区别（那边继续给同传页面用，别改）：
 *   旧：把**整场录音**攒在内存里，每 3 秒把累计的全量音频重发一遍识别。
 *       录十分钟就是几百 MB 的请求，而且每句都要等好几秒、前文还会被整段重写。
 *   这里：只发「这一句」，几百 KB 以内；说完停顿约一秒就落字；句子之间互不干扰。
 *
 * 采集侧的两个约定：
 *   - 音频上下文尽量开在 16k（Chromium 认这个提示）。降不下来时按实际采样率做一次
 *     带抗混叠的抽取，**WAV 头永远写真实的 16k**，否则识别结果会出现语速不对的鬼话。
 *   - 关掉浏览器的 `autoGainControl` / `noiseSuppression`：那两套是为通话调的，
 *     会把小声说话的动态压平、把词尾削掉，正好和 VAD 的阈值、峰值归一化打架。
 */
export type LiveDictation = ReturnType<typeof useLiveDictation>;

export type UtteranceMeta = {
  durationSec: number;
  /** 这一句在整场录音里的位置（秒）。每句独立送检，识别结果的时间戳从 0 开始，靠它对齐。 */
  startSec: number;
  endSec: number;
  reason: "silence" | "max";
};

export function useLiveDictation(
  onUtterance: (wavBase64: string, meta: UtteranceMeta) => void,
  onInterim?: (wavBase64: string) => void,
  onLevel?: (level: number) => void,
  options: { vad?: Partial<VadConfig>; interimMs?: number } = {},
) {
  const [listening, setListening] = useState(false);
  /** 本地判定"这一段有语音"（界面上的听写中指示用，不等识别结果）。 */
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string>();

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const srcRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const nodeRef = useRef<ScriptProcessorNode | null>(null);
  const vadRef = useRef<ReturnType<typeof createVad> | null>(null);
  const splitterRef = useRef<ReturnType<typeof createFrameSplitter> | null>(null);
  const interimTimerRef = useRef<number | null>(null);
  const lastLevelRef = useRef(0);
  /** 暂停：继续采集、继续切句，但不往外发（省算力，也让用户能安静几秒）。 */
  const pausedRef = useRef(false);
  const vadOptionsRef = useRef(options.vad);
  vadOptionsRef.current = options.vad;

  // 回调放 ref：调用方通常每次渲染都传新函数，不该因此重建采集链路。
  const utteranceRef = useRef(onUtterance);
  utteranceRef.current = onUtterance;
  const interimRef = useRef(onInterim);
  interimRef.current = onInterim;
  const levelRef = useRef(onLevel);
  levelRef.current = onLevel;

  const emit = (events: VadEvent[]) => {
    for (const event of events) {
      if (event.type === "speech-start") {
        setSpeaking(true);
        continue;
      }
      if (event.type === "discarded") {
        setSpeaking(false);
        continue;
      }
      setSpeaking(false);
      if (pausedRef.current) continue;
      utteranceRef.current(toWav(event.audio), {
        durationSec: event.durationSec,
        startSec: event.startSec,
        endSec: event.endSec,
        reason: event.reason,
      });
    }
  };

  const stop = (opts: { flush?: boolean } = { flush: true }) => {
    if (interimTimerRef.current !== null) {
      clearInterval(interimTimerRef.current);
      interimTimerRef.current = null;
    }
    // 还没等到静音的那句先交出去（不然最后半句话会丢）。
    const vad = vadRef.current;
    if (opts.flush && vad && !pausedRef.current) {
      const events = vad.flush();
      for (const event of events) {
        if (event.type === "speech-end") {
          utteranceRef.current(toWav(event.audio), {
            durationSec: event.durationSec,
            startSec: event.startSec,
            endSec: event.endSec,
            reason: event.reason,
          });
        }
      }
    }
    try {
      nodeRef.current?.disconnect();
      srcRef.current?.disconnect();
    } catch {}
    try {
      void ctxRef.current?.close();
    } catch {}
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    nodeRef.current = null;
    srcRef.current = null;
    ctxRef.current = null;
    vadRef.current = null;
    splitterRef.current = null;
    setListening(false);
    setSpeaking(false);
    levelRef.current?.(0);
  };

  const start = async () => {
    if (listening) return;
    setError(undefined);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      streamRef.current = stream;
      // 尽量开在 16k：VAD 的 hop 与阈值都按 16k 口径，省掉一路重采样。
      let ctx: AudioContext;
      try {
        ctx = new AudioContext({ sampleRate: 16000 });
      } catch {
        ctx = new AudioContext();
      }
      const sourceRate = ctx.sampleRate;
      const source = ctx.createMediaStreamSource(stream);
      // 2048 @16k ≈ 128ms 一块：电平与切句的响应快于 4096，CPU 开销仍可忽略。
      const node = ctx.createScriptProcessor(2048, 1, 1);
      const vad = createVad({ ...DEFAULT_VAD_CONFIG, ...vadOptionsRef.current });
      vadRef.current = vad;
      splitterRef.current = createFrameSplitter(vad.config.hopSize);

      node.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        const mono = sourceRate === 16000 ? new Float32Array(input) : to16k(input, sourceRate);

        // 电平（约 10fps 节流，界面上的电平条用）。
        const now = performance.now();
        if (now - lastLevelRef.current > 100) {
          lastLevelRef.current = now;
          let sum = 0;
          for (let i = 0; i < mono.length; i++) {
            const v = mono[i] ?? 0;
            sum += v * v;
          }
          levelRef.current?.(Math.min(1, Math.sqrt(sum / Math.max(1, mono.length)) * 4));
        }

        // 切成定长帧喂 VAD（帧长恒定，切句时间点才算得准）。攒不够的余数留在切帧器里。
        const splitter = splitterRef.current;
        if (!splitter) return;
        for (const frame of splitter.push(mono)) emit(vad.push(frame));
      };

      // 采集图要保持活着，但不能把麦克风接到扬声器（会啸叫）。
      const silent = ctx.createGain();
      silent.gain.value = 0;
      source.connect(node);
      node.connect(silent);
      silent.connect(ctx.destination);
      srcRef.current = source;
      nodeRef.current = node;
      ctxRef.current = ctx;
      setListening(true);

      // 中间结果：一句话还在说的时候，每秒把它先送去识别一次（收句时被完整的一句覆盖）。
      const interimMs = options.interimMs ?? 1200;
      interimTimerRef.current = setInterval(() => {
        if (pausedRef.current || !interimRef.current) return;
        const partial = vadRef.current?.snapshot();
        if (!partial || partial.length < 16000 * 0.5) return; // 太短就先不打扰
        interimRef.current(toWav(partial));
      }, interimMs) as unknown as number;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // 卸载时只收摊、不再往外发（组件都没了，回调只会往已卸载的界面上写状态）。
  useEffect(() => () => stop({ flush: false }), []);

  return {
    listening,
    speaking,
    error,
    start,
    stop,
    setPaused: (value: boolean) => {
      pausedRef.current = value;
    },
  };
}

/** float32 → 16k WAV base64（VAD 交出来的样本已经是 16k）。 */
function toWav(samples: Float32Array): string {
  return wavBase64FromPcm16(floatToPcm16(samples), 16000);
}

function floatToPcm16(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] ?? 0));
    pcm[i] = Math.round(v * 0x7fff);
  }
  return pcm;
}

/** 非 16k 的设备（44.1k 等）走这一路：带抗混叠抽取，结果当 16k 用。 */
function to16k(samples: Float32Array, sourceRate: number): Float32Array {
  const pcm = resampleToPcm16(samples, sourceRate, 16000);
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = (pcm[i] ?? 0) / 0x7fff;
  return out;
}
