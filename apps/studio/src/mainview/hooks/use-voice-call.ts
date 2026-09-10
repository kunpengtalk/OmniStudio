import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { rpcClient } from "../lib/rpc";
import { useChatStore } from "../stores/chat";
import { useVoiceCallStore, type AudioEntry, type VoiceCallProvider } from "../stores/voice-call";
import { encodePcm16Base64 } from "../lib/wav";

/**
 * 实时语音通话引擎（前端侧）：
 * - 麦克风采集 + 能量 VAD：说话开始/结束自动断句，680ms 静音判定一句话说完
 * - 本地模式：说话期间每 ~280ms 推一帧 16k WAV（整段）给后端做增量转写
 * - 云端模式：说话期间每 ~120ms 推增量 PCM16 16k 给 Qwen Realtime（服务端 smart_turn 断句）
 * - 抢话打断：agent 正在想/正在说（云端）时检测到人声 → voicecallInterrupt + 清空播放队列
 * - 播放：消费 store.audioQueue 顺序播放（WAV decodeAudioData / PCM16 24k 直构），
 *   interrupt/hangup 可立即停声
 */
const INPUT_RATE = 48000;
const CHUNK_SIZE = 4096;
const PUSH_INTERVAL_MS = 280;
const CLOUD_PUSH_INTERVAL_MS = 120; // 云端实时流：推得越勤，断句与响应的延迟越低
const UTTERANCE_MIN_SAMPLES = INPUT_RATE * 0.08; // <80ms 视为误触发
const SILENCE_END_CHUNKS = 5; // ≈430ms 连续低电平 → 一句话结束（早一点进下一轮，响应更快）
const SPEECH_START_CHUNKS = 2;
/** 云端输出采样率（Qwen Realtime 返回 PCM16 24k）。 */
const REALTIME_OUTPUT_RATE = 24000;

/** PCM16 base64 → AudioBuffer（云端音频无 WAV 头，24k 单声道）。 */
function pcm16ToAudioBuffer(ctx: AudioContext, base64: string, sampleRate: number): AudioBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const frames = Math.floor(bytes.length / 2);
  const buf = ctx.createBuffer(1, frames, sampleRate);
  const ch = buf.getChannelData(0);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < frames; i++) ch[i] = dv.getInt16(i * 2, true) / 0x8000;
  return buf;
}

/**
 * 把连续多个 PCM 音频块拼成一块 AudioBuffer 再播。
 * 云端 `response.audio.delta` 每块只有一小段（几十到几百毫秒），若逐块
 * decodeAudioData→source.start() 会产生可闻的块间间隙；合并后一整段连续播放。
 */
function pcmBatchToAudioBuffer(
  ctx: AudioContext,
  entries: Pick<AudioEntry, "base64">[],
  sampleRate: number,
): AudioBuffer {
  const channels: Float32Array[] = [];
  let totalFrames = 0;
  for (const e of entries) {
    const binary = atob(e.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const frames = Math.floor(bytes.length / 2);
    const ch = new Float32Array(frames);
    const dv = new DataView(bytes.buffer);
    for (let i = 0; i < frames; i++) ch[i] = dv.getInt16(i * 2, true) / 0x8000;
    channels.push(ch);
    totalFrames += frames;
  }
  const buf = ctx.createBuffer(1, Math.max(1, totalFrames), sampleRate);
  const out = buf.getChannelData(0);
  let offset = 0;
  for (const ch of channels) {
    out.set(ch, offset);
    offset += ch.length;
  }
  return buf;
}

export function useVoiceCallEngine() {
  const queryClient = useQueryClient();

  // ---- 采集 ----
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<ScriptProcessorNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const samplesRef = useRef<Float32Array>(new Float32Array(0));
  const utteranceStartRef = useRef(0);
  /** 云端模式：已推送到后端的采样下标（只发增量，避免整段重发）。 */
  const lastPushRef = useRef(0);
  const providerRef = useRef<VoiceCallProvider>("local");
  const pushTimerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const activeRef = useRef(false);
  const vadRef = useRef({
    speaking: false,
    speechStreak: 0,
    silenceStreak: 0,
    noiseFloor: 0.015,
    started: false,
  });

  // ---- 播放（Web Audio：decodeAudioData + BufferSource，对 WAV/MP3 都可靠）----
  const playingRef = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const activeSourceRef = useRef<AudioBufferSourceNode | null>(null);
  // ---- 回声防护 ----
  // 喇叭外放的 TTS 会被麦克风收进去（桌面应用里 Web Audio 播放与采集未必走同一条
  // 回声消除链路）。如果不防护，VAD 会把助手自己的声音当成“用户抢话”：
  // 反复打断助手、丢掉没念完的句子，还把回声转写成垃圾“用户消息”，助手开始自问自答。
  // 因此只要“助手音频正在播放 / 刚播完（余音未散）”，就一律不把麦克风信号当说话。
  const agentAudibleRef = useRef(false);
  const agentQuietAtRef = useRef(0);
  /** 助手回声余音窗口：音频停止后再缓冲这么久，覆盖扬声器余音与后端阶段回传延迟。 */
  const AGENT_ECHO_TAIL_MS = 800;
  const isAgentAudible = (): boolean =>
    agentAudibleRef.current || performance.now() < agentQuietAtRef.current;

  const getAudioCtx = (): AudioContext => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext();
    }
    return audioCtxRef.current;
  };

  /** 在拨号点击的 user-gesture 窗口内创建并解锁 AudioContext，稍后的 TTS 才能出声。 */
  const primeAudio = () => {
    try {
      const ctx = getAudioCtx();
      if (ctx.state === "suspended") void ctx.resume();
    } catch {
      // ignore
    }
  };

  const stopCurrentAudio = () => {
    const src = activeSourceRef.current;
    if (src) {
      activeSourceRef.current = null;
      try {
        src.stop();
      } catch {
        // ignore
      }
      try {
        src.disconnect();
      } catch {
        // ignore
      }
    }
    playingRef.current = false;
    // stop() 之后 onended 不一定触发；在这里复位，避免回声门控一直卡住。
    agentAudibleRef.current = false;
    agentQuietAtRef.current = performance.now() + AGENT_ECHO_TAIL_MS;
  };

  const playNext = async () => {
    const store = useVoiceCallStore.getState();
    const queue = store.audioQueue;
    if (queue.length === 0) {
      playingRef.current = false;
      return;
    }
    // 连续 PCM 块合并成一块缓冲播放（消除块间间隙）；wav 单条独立播放（本地逐句）。
    let take = 1;
    if (queue[0]!.format === "pcm") {
      while (take < queue.length && queue[take]!.format === "pcm") take++;
    }
    const batch = queue.slice(0, take);
    useVoiceCallStore.setState({ audioQueue: queue.slice(take) });
    playingRef.current = true;
    agentAudibleRef.current = true;
    try {
      const ctx = getAudioCtx();
      if (ctx.state === "suspended") await ctx.resume();
      let audioBuffer: AudioBuffer;
      if (batch[0]!.format === "pcm") {
        // 云端实时音频：PCM16 24k 裸流，直接构 AudioBuffer（没有 WAV 头）。
        audioBuffer = pcmBatchToAudioBuffer(ctx, batch, REALTIME_OUTPUT_RATE);
      } else {
        const binary = atob(batch[0]!.base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0) as ArrayBuffer);
      }
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      activeSourceRef.current = source;
      source.onended = () => {
        if (activeSourceRef.current === source) activeSourceRef.current = null;
        playingRef.current = false;
        agentAudibleRef.current = false;
        agentQuietAtRef.current = performance.now() + AGENT_ECHO_TAIL_MS;
        void playNext();
      };
      source.start();
      const byteLen = Math.floor((batch[0]!.base64.length * 3 * batch.length) / 4);
      void rpcClient.voicecallDebug({
        line: `web-audio playing ${audioBuffer.duration.toFixed(2)}s (${byteLen}B, ${batch.length}×${batch[0]!.format})`,
      });
    } catch (e) {
      playingRef.current = false;
      agentAudibleRef.current = false;
      void rpcClient.voicecallDebug({ line: `web-audio error: ${String(e)}` });
      void playNext();
    }
  };

  // 队列有新音频就接着播；被清空（打断/挂断）则立即停声。
  useEffect(() => {
    const unsub = useVoiceCallStore.subscribe((state) => {
      if (state.audioQueue.length > 0 && !playingRef.current) {
        void playNext();
      } else if (state.audioQueue.length === 0 && playingRef.current) {
        stopCurrentAudio();
      }
    });
    return () => {
      unsub();
      stopCurrentAudio();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------------
  // VAD + 采集
  // ------------------------------------------------------------------

  const pushInterval = () =>
    providerRef.current === "cloud" ? CLOUD_PUSH_INTERVAL_MS : PUSH_INTERVAL_MS;

  const startPushTimer = () => {
    if (pushTimerRef.current !== null) return;
    pushTimerRef.current = window.setInterval(sendUtterancePush, pushInterval());
  };

  const stopPushTimer = () => {
    if (pushTimerRef.current !== null) {
      clearInterval(pushTimerRef.current);
      pushTimerRef.current = null;
    }
  };

  const sendUtterancePush = () => {
    const store = useVoiceCallStore.getState();
    const conversationId = store.callConversationId;
    if (conversationId == null) return;
    const samples = samplesRef.current;
    const from = lastPushRef.current;
    if (samples.length - from < UTTERANCE_MIN_SAMPLES) return;
    // 本地/云端统一发增量裸 PCM16 16k：
    //  - 云端直接喂给 Qwen Realtime（input_audio_buffer.append）
    //  - 本地由后端累积，转写前统一包 WAV 头（避免把多个 WAV 小块粘成一个非法文件）
    const pcmBase64 = encodePcm16Base64(samples.subarray(from), INPUT_RATE);
    lastPushRef.current = samples.length;
    void rpcClient.voicecallPushAudio({ conversationId, wavBase64: pcmBase64, format: "pcm" });
  };

  const beginUtterance = () => {
    // 助手正在说话/余音未散时，麦克风里的“语音”基本是回声：既不开新话语，
    // 也不抢话打断（否则助手每轮都被自己打断，只剩最后一句能读完）。
    // 云端模式的抢话由服务端 smart_turn 直接裁决（见 onAudio 的回声分支），
    // 本地 VAD 在说话窗口内一律不发声，避免把回声当成抢话。
    if (isAgentAudible()) return;
    const store = useVoiceCallStore.getState();
    // 抢话：本地模式只在「思考中」保留（此刻无外放，信号不可能是回声）。
    if (store.phase === "thinking" && store.callConversationId != null) {
      void rpcClient.voicecallInterrupt({ conversationId: store.callConversationId });
      stopCurrentAudio();
      store.clearAudio();
    }
    // 只保留当前这段话的采样（上一段已在上一次端句时同步送出）。
    samplesRef.current = new Float32Array(0);
    utteranceStartRef.current = 0;
    lastPushRef.current = 0;
    store.setLiveText("");
    store.setLiveActive(true);
    if (providerRef.current === "local") startPushTimer();
  };

  const endUtterance = () => {
    const store = useVoiceCallStore.getState();
    const conversationId = store.callConversationId;
    // 本地模式的推流随一段话音启停；云端模式持续推流（断句在服务端），这里不停。
    if (providerRef.current === "local") stopPushTimer();
    const samples = samplesRef.current;
    const start = utteranceStartRef.current;
    utteranceStartRef.current = samples.length;
    store.setLiveActive(false);
    const cloud = providerRef.current === "cloud";
    // 云端推流本来就持续，端句只补发最后一段增量并给服务端 commit 信号；
    // 本地端句也按增量补发（后端累积成整段再转写）。
    const from = Math.max(start, lastPushRef.current);
    if (conversationId == null || samples.length - from < UTTERANCE_MIN_SAMPLES) {
      // 没有可补发的音频：云端仍需 commit 信号让服务端尽快断句。
      if (cloud && conversationId != null) {
        void rpcClient.voicecallEndUtterance({ conversationId }).catch(() => {});
      }
      return;
    }
    const finalPush = encodePcm16Base64(samples.subarray(from), INPUT_RATE);
    lastPushRef.current = samples.length;
    if (!cloud) store.setPhase("transcribing");
    void (async () => {
      try {
        await rpcClient.voicecallPushAudio({
          conversationId,
          wavBase64: finalPush,
          format: "pcm",
        });
      } catch {
        // 末片推送失败：端句仍会尝试用后端已收到的音频
      }
      try {
        const res = await rpcClient.voicecallEndUtterance({ conversationId });
        const s = useVoiceCallStore.getState();
        if (cloud) {
          // 云端断句在服务端，不显示「转写中」；真有错误才提示。
          if (!res.ok && res.error) s.setError(res.error);
        } else if ((!res.ok && res.error) || !res.text) {
          // 空转写（没听清），回到聆听；失败则提示。
          if (s.phase === "transcribing") s.setPhase("listening");
          if (res.error) s.setError(res.error);
        }
      } catch (e) {
        const s = useVoiceCallStore.getState();
        if (s.phase === "transcribing") s.setPhase("listening");
        s.setError(e instanceof Error ? e.message : String(e));
      }
    })();
  };

  const onAudio = (e: AudioProcessingEvent) => {
    if (!activeRef.current) return;
    const data = e.inputBuffer.getChannelData(0);
    const prev = samplesRef.current;
    const next =
      prev.length === 0
        ? new Float32Array(data)
        : (() => {
            const merged = new Float32Array(prev.length + data.length);
            merged.set(prev, 0);
            merged.set(data, prev.length);
            return merged;
          })();
    samplesRef.current = next;

    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i] ?? 0;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);
    const vad = vadRef.current;

    // 前 ~0.6s 校准环境噪声底
    if (!vad.started) {
      vad.noiseFloor = vad.noiseFloor * 0.92 + rms * 0.08;
      if (next.length >= INPUT_RATE * 0.6) vad.started = true;
      return;
    }

    // 回声防护：助手正在朗读/刚播完时，把这段时间的麦克风信号当环境音忽略掉。
    // 直接复位 VAD 计数，避免余音一停就立刻触发一次“用户说话”。
    if (isAgentAudible()) {
      vad.silenceStreak = 0;
      vad.speechStreak = 0;
      vad.speaking = false;
      // 云端模式持续推流由定时器按 lastPush 增量抽取，裁剪会丢掉尚未发送的采样；
      // 本地模式推流只在说话窗口内发生，长时间回声可以安全裁剪防止内存膨胀。
      if (providerRef.current === "local" && next.length > INPUT_RATE * 3) {
        samplesRef.current = next.subarray(next.length - INPUT_RATE);
      }
      return;
    }

    if (rms >= Math.min(0.06, Math.max(0.014, vad.noiseFloor * 3))) {
      vad.silenceStreak = 0;
      vad.speechStreak += 1;
      if (!vad.speaking && vad.speechStreak >= SPEECH_START_CHUNKS) {
        vad.speaking = true;
        beginUtterance();
      }
    } else {
      vad.speechStreak = 0;
      if (vad.speaking) {
        vad.silenceStreak += 1;
        if (vad.silenceStreak >= SILENCE_END_CHUNKS) {
          vad.speaking = false;
          vad.silenceStreak = 0;
          endUtterance();
        }
      } else if (next.length > INPUT_RATE * 3) {
        // 长时间安静：丢弃全部采样并复位推流游标。推流按增量走（lastPushRef），
        // 若只截断数组而不复位游标，会把已推送过的音频再发一遍、污染后端转写。
        samplesRef.current = new Float32Array(0);
        utteranceStartRef.current = 0;
        lastPushRef.current = 0;
      }
    }
  };

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
      useVoiceCallStore.getState().setMicLevel(Math.min(1, Math.sqrt(sum / buf.length) * 3.5));
    }
    rafRef.current = requestAnimationFrame(levelLoop);
  };

  const stopCapture = () => {
    activeRef.current = false;
    stopPushTimer();
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    try {
      nodeRef.current?.disconnect();
      ctxRef.current?.close();
    } catch {
      // ignore
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    nodeRef.current = null;
    ctxRef.current = null;
    analyserRef.current = null;
    useVoiceCallStore.getState().setMicLevel(0);
  };

  const beginCapture = async () => {
    // 回声消除 + 降噪 + 自动增益：TTS 从扬声器出声时不让它被 VAD 当成"用户说话"。
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    streamRef.current = stream;
    const ctx = new AudioContext({ sampleRate: INPUT_RATE });
    const src = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(CHUNK_SIZE, 1, 1);
    samplesRef.current = new Float32Array(0);
    utteranceStartRef.current = 0;
    lastPushRef.current = 0;
    vadRef.current = {
      speaking: false,
      speechStreak: 0,
      silenceStreak: 0,
      noiseFloor: 0.015,
      started: false,
    };
    node.onaudioprocess = onAudio;
    // 不把麦克风接到扬声器，避免啸叫
    const silent = ctx.createGain();
    silent.gain.value = 0;
    src.connect(node);
    node.connect(silent);
    silent.connect(ctx.destination);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    nodeRef.current = node;
    ctxRef.current = ctx;
    analyserRef.current = analyser;
    activeRef.current = true;
    // 云端是持续全双工：开麦即开始增量推流（断句交给服务端 smart_turn）。
    if (providerRef.current === "cloud") startPushTimer();
    levelLoop();
  };

  // ------------------------------------------------------------------
  // 对外控制
  // ------------------------------------------------------------------

  const start = async (conversationId: number | null, provider?: VoiceCallProvider) => {
    const store = useVoiceCallStore.getState();
    if (store.callConversationId != null) return;
    const mode = provider ?? "local";
    providerRef.current = mode;
    store.setPhase("starting");
    store.setError(null);
    primeAudio();
    let convId: number | null = null;
    try {
      const res = await rpcClient.voicecallStart({
        conversationId: conversationId ?? undefined,
        provider: mode,
      });
      if (!res.ok || !res.conversation) {
        store.setError(res.error ?? "无法开始通话");
        store.setPhase("error");
        return;
      }
      convId = res.conversation.id;
      useChatStore.getState().setActiveConversation(convId);
      useChatStore.getState().setActiveMessages([]);
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      await beginCapture();
      store.beginCall(convId, mode);
    } catch (e) {
      store.setError(e instanceof Error ? e.message : String(e));
      store.setPhase("error");
      if (convId != null) void rpcClient.voicecallStop({ conversationId: convId });
    }
  };

  const hangup = async () => {
    const store = useVoiceCallStore.getState();
    const conversationId = store.callConversationId;
    stopCapture();
    stopCurrentAudio();
    store.clearAudio();
    store.setPhase("idle");
    if (conversationId != null) {
      try {
        await rpcClient.voicecallStop({ conversationId });
        queryClient.invalidateQueries({ queryKey: ["conversations"] });
      } catch {
        // 挂断失败不阻塞 UI 复位
      }
    }
    store.endCall();
  };

  // 切走（卸载）时自动挂断，避免麦克风在后台常驻。
  useEffect(() => {
    return () => {
      const { callConversationId } = useVoiceCallStore.getState();
      if (callConversationId != null) {
        stopCapture();
        stopCurrentAudio();
        void rpcClient.voicecallStop({ conversationId: callConversationId });
        useVoiceCallStore.getState().endCall();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { start, hangup, stopCurrentAudio };
}
