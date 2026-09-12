import { useEffect, useRef, useState } from "react";
import { encodeWavBase64 } from "@/mainview/lib/wav";

/**
 * 麦克风录音 hook（语音识别 / 同传翻译共用）：
 * 持续采集 16k 单声道采样，每隔 intervalMs 把「目前累计的整段音频」以 WAV base64
 * 回调出去（供后端实时转写，结果是全量转写、前端负责增量合并），
 * 同时按帧回调音量电平（0-1，驱动电平条）。
 */
export function useMicRecorder(
  onLive: (wavBase64: string) => void,
  onLevel?: (level: number) => void,
  /** 实时转写轮询间隔（毫秒），默认 3000。 */
  intervalMs = 3000,
) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string>();
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const srcRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const nodeRef = useRef<ScriptProcessorNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const samplesRef = useRef<number[]>([]);
  const timerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const onLiveRef = useRef(onLive);
  onLiveRef.current = onLive;
  const onLevelRef = useRef(onLevel);
  onLevelRef.current = onLevel;

  const stop = () => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current as number);
      timerRef.current = null;
    }
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    try {
      nodeRef.current?.disconnect();
      srcRef.current?.disconnect();
    } catch {}
    try {
      void ctxRef.current?.close();
    } catch {}
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    nodeRef.current = null;
    srcRef.current = null;
    ctxRef.current = null;
    analyserRef.current = null;
    setRecording(false);
    onLevelRef.current?.(0);
  };

  const start = async () => {
    setError(undefined);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      samplesRef.current = [];
      node.onaudioprocess = (e) => {
        const data = e.inputBuffer.getChannelData(0);
        const arr = samplesRef.current;
        for (let i = 0; i < data.length; i++) arr.push(data[i] ?? 0);
      };
      // Keep the processing graph alive without routing mic → speakers (no feedback).
      const silent = ctx.createGain();
      silent.gain.value = 0;
      src.connect(node);
      node.connect(silent);
      silent.connect(ctx.destination);
      // Analyser drives the recording level meter.
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      srcRef.current = src;
      nodeRef.current = node;
      analyserRef.current = analyser;
      ctxRef.current = ctx;
      setRecording(true);

      // Live transcription of the audio captured so far, every few seconds.
      timerRef.current = setInterval(() => {
        if (samplesRef.current.length > 0) {
          onLiveRef.current(encodeWavBase64(new Float32Array(samplesRef.current)));
        }
      }, intervalMs) as unknown as number;

      const levelLoop = () => {
        const an = analyserRef.current;
        if (an) {
          const buf = new Uint8Array(an.frequencyBinCount);
          an.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i]! - 128) / 128;
            sum += v * v;
          }
          onLevelRef.current?.(Math.min(1, Math.sqrt(sum / buf.length) * 4));
        }
        rafRef.current = requestAnimationFrame(levelLoop);
      };
      rafRef.current = requestAnimationFrame(levelLoop);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** Stop recording and return the captured audio as a 16k WAV base64 string. */
  const finish = (): string => {
    const wav = encodeWavBase64(new Float32Array(samplesRef.current));
    stop();
    return wav;
  };

  useEffect(() => stop, []);

  return { recording, error, start, finish };
}
