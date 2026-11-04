import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { rpcClient } from "../lib/rpc";
import { useChatStore } from "../stores/chat";
import { useVoiceCallStore, type AudioEntry, type VoiceCallProvider } from "../stores/voice-call";
import { encodePcm16Base64 } from "../lib/wav";
import { describeCaptureContext, describeCaptureFailure, describeMicFailure } from "../lib/capture-errors";
import { REALTIME_OUTPUT_RATE, realtimeDialectFor, realtimeInputRate, realtimeOutputRate } from "@/shared/realtime-voice";

/**
 * 实时语音通话引擎（前端侧）：
 * - 麦克风采集 + 能量 VAD：说话开始/结束自动断句，680ms 静音判定一句话说完
 * - 本地 / omni 模式：只在说话窗口内推流，每 ~280ms 推一帧增量 PCM16 16k，
 *   由后端累积成整段（本地拿去转写，omni 拿去当音频输入发给多模态模型）
 * - 云端模式：说话期间每 ~120ms 推增量 PCM16 给实时模型（服务端 VAD 断句）；
 *   采样率按厂商取（百炼 16k / 阶跃 24k，喂错会被当成另一种语速）
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

/**
 * 云端实时 PCM 的**连续播放调度器**。
 *
 * 以前是"攒一批 → 播完（onended）→ 再取下一批"的接力：每一批之间都要等
 * `onended` 回调 + 一次 `await`，而 Web Audio 的调度精度是"排程时刻"，两次
 * 独立 `start()` 之间必然有几十毫秒空隙 —— 连续说话时就听成持续卡顿；每批
 * 又各自新建 `AudioBuffer`，块边界处的波形不连续又变成"咔哒"声。
 *
 * 现在的做法（也是 Web Audio 处理流式音频的标准做法）：**按时间轴排程**。
 * 每个块算出它在音频时间轴上的起点 `nextStartTime`，后一块紧接前一块的结束时刻
 * 调用 `start(when)`，于是播放由音频硬件时钟连续驱动，块之间没有空隙也没有
 * 重新起振的跳变。
 *
 * 同时解决字节对齐：PCM16 的字节流是连续的，**上一块剩下的半个样本要接到下一块
 * 开头**，而不是各自 `floor(len/2)` 丢掉。
 */
function createPcmScheduler(ctx: AudioContext, sampleRate: number) {
  /** 上一块还剩下的半个样本（奇数长度时），拼到下一块开头。 */
  let carry: Uint8Array | null = null;
  /** 下一块应当开始播放的音频时钟时刻。 */
  let nextStartTime = 0;
  /** 已调度的 source；打断时要一起停。 */
  const sources = new Set<AudioBufferSourceNode>();

  return {
    /** 排入一块裸 PCM16 字节。 */
    push(bytes: Uint8Array): void {
      // 1) 接上上一块残留的半个样本，保持字节流连续。
      let all = bytes;
      if (carry) {
        all = new Uint8Array(carry.length + bytes.length);
        all.set(carry, 0);
        all.set(bytes, carry.length);
        carry = null;
      }
      // 2) 奇数长度：把末尾那一个字节留到下一块，不能丢（丢了后面全部错位）。
      if (all.length % 2 !== 0) {
        carry = all.slice(all.length - 1);
        all = all.subarray(0, all.length - 1);
      }
      const frames = all.length / 2;
      if (frames === 0) return;

      // 3) 切样本。
      const ch = new Float32Array(frames);
      const dv = new DataView(all.buffer, all.byteOffset, all.byteLength);
      for (let i = 0; i < frames; i++) ch[i] = dv.getInt16(i * 2, true) / 0x8000;

      const buf = ctx.createBuffer(1, frames, sampleRate);
      buf.getChannelData(0).set(ch);

      const source = ctx.createBufferSource();
      source.buffer = buf;
      source.connect(ctx.destination);
      // 4) 排程：晚于当前时刻就从现在开始，否则紧接着上一块结束 —— 不留空隙。
      const startAt = Math.max(ctx.currentTime, nextStartTime);
      source.start(startAt);
      nextStartTime = startAt + buf.duration;
      sources.add(source);
      source.onended = () => sources.delete(source);
    },

    /** 下一次可以安全排程的时刻（用来判断缓冲是否已经落后）。 */
    get nextTime(): number {
      return nextStartTime;
    },

    /** 停止全部已排程音频（打断 / 挂断）。 */
    stop(): void {
      carry = null;
      nextStartTime = 0;
      for (const s of sources) {
        try {
          s.stop();
          s.disconnect();
        } catch {
          // ignore
        }
      }
      sources.clear();
    },
  };
}

/**
 * 把连续多个 PCM 音频块拼成一块 AudioBuffer（本地 / 单条播放用）。
 *
 * **先把所有块拼成一整条字节流，再整体按 16bit 切样本** —— 不能逐块各自
 * `floor(len/2)`。PCM16 的帧边界是协议层概念，字节流本身是连续的：某一块长度是
 * 奇数（网络分片不按样本对齐）时，逐块处理会把它末尾那半个样本丢掉，于是**这一块
 * 之后的所有采样都错位一个字节**（高低字节颠倒），听感就是刺耳白噪声。
 */
function pcmBatchToAudioBuffer(
  ctx: AudioContext,
  entries: Pick<AudioEntry, "base64">[],
  sampleRate: number,
): AudioBuffer {
  // 1) 拼成一整条连续字节流。
  let totalBytes = 0;
  const parts: Uint8Array[] = [];
  for (const e of entries) {
    const binary = atob(e.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    parts.push(bytes);
    totalBytes += bytes.length;
  }
  const all = new Uint8Array(totalBytes);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  // 2) 整体切样本：末尾若剩半个样本（奇数总长），丢掉它而不是让后续全部错位。
  const frames = Math.floor(totalBytes / 2);
  const ch = new Float32Array(frames);
  const dv = new DataView(all.buffer, all.byteOffset, all.byteLength);
  for (let i = 0; i < frames; i++) ch[i] = dv.getInt16(i * 2, true) / 0x8000;
  const buf = ctx.createBuffer(1, Math.max(1, frames), sampleRate);
  buf.getChannelData(0).set(ch);
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
  /** 云端模式（全双工，一直推）：已推送到后端的采样下标（只发增量，避免整段重发）。 */
  const lastPushRef = useRef(0);
  const providerRef = useRef<VoiceCallProvider>("local");
  /** 是不是"持续推流"的云端实时模式（本地与 omni 都只在说话窗口内推）。 */
  const isRealtime = () => providerRef.current === "cloud";
  /**
   * 云端上行采样率：拨号时按厂商定一次（百炼 16k / 阶跃 24k / MOSS 16k）。
   * 通话中不能改（改设置不影响正在进行的连接），所以存在 ref 里。
   */
  const inputRateRef = useRef(realtimeInputRate("dashscope"));
  /**
   * 云端下行采样率：MOSS 是 48k，另两家 24k。播放端按它建 AudioBuffer ——
   * 用固定 24k 去解 MOSS 的音频会变成慢放的低音。
   */
  const outputRateRef = useRef(REALTIME_OUTPUT_RATE);
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

  /**
   * `playNext` 的重入锁。
   *
   * `playingRef` 表达的是"扬声器正在出声"，不能兼职做重入保护：它由 `source.onended`
   * 复位，而 store 订阅与 onended 会同时触发 `playNext`，两者都在 `await ctx.resume()`
   * 前后交汇。并发进入时后来者会把**同一批音频再播一遍**（两路 source 叠加 → 噪声），
   * 或者把已取出的 batch 丢掉（这段音频就永远不播了）。所以用一把独立的、在
   * **取队列之前**就置位的锁。
   */
  const pumpingRef = useRef(false);

  /** 云端 PCM 的连续播放调度器（跟着 AudioContext 与采样率重建）。 */
  const pcmSchedulerRef = useRef<{
    ctx: AudioContext;
    rate: number;
    scheduler: ReturnType<typeof createPcmScheduler>;
  } | null>(null);

  /**
   * 取（或按需建立）PCM 调度器。
   *
   * 采样率变了（换厂商 / 换方言）就得重建：AudioBuffer 的采样率在创建时固定，
   * 用 24k 的缓冲配 48k 的时钟就是"变慢一倍"，反过来是"变快一倍"。
   */
  const getPcmScheduler = (ctx: AudioContext, rate: number) => {
    const cur = pcmSchedulerRef.current;
    if (cur && cur.ctx === ctx && cur.rate === rate) return cur.scheduler;
    cur?.scheduler.stop();
    const scheduler = createPcmScheduler(ctx, rate);
    pcmSchedulerRef.current = { ctx, rate, scheduler };
    return scheduler;
  };

  const playNext = async () => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    try {
      await playNextInner();
    } finally {
      pumpingRef.current = false;
    }
  };

  const playNextInner = async () => {
    const store = useVoiceCallStore.getState();
    const queue = store.audioQueue;
    if (queue.length === 0) {
      playingRef.current = false;
      return;
    }
    // 云端 PCM 走"排程"而不是"接力"：一次把队列里所有 PCM 块都排进时间轴，
    // 由音频时钟连续播出去（见 createPcmScheduler 的说明）。
    if (queue[0]!.format === "pcm") {
      let take = 0;
      while (take < queue.length && queue[take]!.format === "pcm") take++;
      const batch = queue.slice(0, take);
      useVoiceCallStore.setState({ audioQueue: queue.slice(take) });
      playingRef.current = true;
      agentAudibleRef.current = true;
      try {
        const ctx = getAudioCtx();
        if (ctx.state === "suspended") await ctx.resume();
        const scheduler = getPcmScheduler(ctx, outputRateRef.current);
        for (const e of batch) {
          const binary = atob(e.base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          scheduler.push(bytes);
        }
        // 回执：排程后按"这块应当播完的音频时刻"回报。MOSS 要求真正播完后才回，
        // 而排程模式下我们精确知道每块在时间轴上的结束时刻，不必等 onended
        // （等 onended 会把回执拖到整批结束，服务端以为一直没播完）。
        const conversationId = useVoiceCallStore.getState().callConversationId;
        const settleAt = scheduler.nextTime;
        const leadMs = Math.max(0, (settleAt - ctx.currentTime) * 1000);
        if (conversationId != null) {
          // filter 已保证 chunkId 非空，但 TS 不会跨数组收窄，这里显式取值。
          const acks = batch
            .filter((e): e is typeof e & { chunkId: string } => !!e.chunkId)
            .map((e) => ({ chunkId: e.chunkId, runId: e.runId, turnId: e.turnId }));
          if (acks.length > 0) {
            window.setTimeout(() => {
              const still = useVoiceCallStore.getState().callConversationId;
              if (still !== conversationId) return;
              for (const e of acks) {
                void rpcClient
                  .voicecallAckPlayback({ conversationId, ...e })
                  .catch(() => {});
              }
            }, leadMs);
          }
        }
        void rpcClient
          .voicecallDebug({
            line: `pcm scheduled ${batch.length} chunks, +${leadMs.toFixed(0)}ms (rate=${outputRateRef.current})`,
          })
          .catch(() => {});
      } catch (e) {
        playingRef.current = false;
        void rpcClient.voicecallDebug({ line: `pcm schedule error: ${String(e)}` }).catch(() => {});
      }
      // 排程完接着看队列里还有没有（播放本身不阻塞这里）。
      void playNext();
      return;
    }

    // 本地逐句 WAV：一条一个缓冲，播放仍然靠 onended 接力（本来就该一句一句播）。
    const batch = queue.slice(0, 1);
    useVoiceCallStore.setState({ audioQueue: queue.slice(1) });
    playingRef.current = true;
    agentAudibleRef.current = true;
    try {
      const ctx = getAudioCtx();
      if (ctx.state === "suspended") await ctx.resume();
      const binary = atob(batch[0]!.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0) as ArrayBuffer);
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
      void rpcClient
        .voicecallDebug({
          line: `web-audio playing ${audioBuffer.duration.toFixed(2)}s (wav)`,
        })
        .catch(() => {});
    } catch (e) {
      playingRef.current = false;
      agentAudibleRef.current = false;
      void rpcClient.voicecallDebug({ line: `web-audio error: ${String(e)}` }).catch(() => {});
      void playNext();
    }
  };

  /** 老的内部函数已由上面的 playNextInner 取代。 */

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

  const pushInterval = () => (isRealtime() ? CLOUD_PUSH_INTERVAL_MS : PUSH_INTERVAL_MS);

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
    const chunk = samples.subarray(from);
    // 三种模式统一发增量裸 PCM16：
    //  - 云端直接喂给实时模型（采样率按厂商取）；**不说话时也一直推** ——
    //    MOSS 要靠持续的静音流才能判定"用户说完了"，百炼 / 阶跃也靠它维持连接节奏
    //  - 本地 / omni 由后端累积，用前统一包 WAV 头（避免把多个 WAV 小块粘成一个非法文件）
    const pcmBase64 = isRealtime()
      ? encodePcm16Base64(chunk, INPUT_RATE, inputRateRef.current)
      : encodePcm16Base64(chunk, INPUT_RATE);
    if (isRealtime()) {
      // 云端是"推完即弃"的流：整段保留会让长通话的数组无限增长（一小时 ≈ 700MB）。
      // 本地 / omni 不能丢 —— 那段音频就是这一轮的输入。
      samplesRef.current = new Float32Array(0);
      lastPushRef.current = 0;
    } else {
      lastPushRef.current = samples.length;
    }
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
    // 本地 / omni：推流只在说话窗口内跑（omni 要整段音频一次发给模型）。
    if (!isRealtime()) startPushTimer();
  };

  const endUtterance = () => {
    const store = useVoiceCallStore.getState();
    const conversationId = store.callConversationId;
    // 本地 / omni 的推流随一段话音启停；云端模式持续推流（断句在服务端），这里不停。
    if (!isRealtime()) stopPushTimer();
    store.setLiveActive(false);
    const cloud = isRealtime();
    if (cloud) {
      // 先把还没到定时器的那几十毫秒音频推上去，再叫后端收尾 —— 云端没有
      // commit 语义，服务端靠字节流自己断句，最后一片晚到只会让断句更迟。
      if (conversationId != null) {
        sendUtterancePush();
        void rpcClient.voicecallEndUtterance({ conversationId }).catch(() => {});
      }
      return;
    }
    const samples = samplesRef.current;
    const start = utteranceStartRef.current;
    utteranceStartRef.current = samples.length;
    // 本地端句按增量补发（后端累积成整段再转写）。
    const from = Math.max(start, lastPushRef.current);
    if (conversationId == null || samples.length - from < UTTERANCE_MIN_SAMPLES) {
      return;
    }
    const finalPush = encodePcm16Base64(samples.subarray(from), INPUT_RATE);
    lastPushRef.current = samples.length;
    store.setPhase("transcribing");
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
        if ((!res.ok && res.error) || !res.text) {
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
      // 本地 / omni 的推流只在说话窗口内发生，长时间回声可以安全裁剪防止内存膨胀。
      if (!isRealtime() && next.length > INPUT_RATE * 3) {
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
    stopVideo();
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
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (e) {
      // 把判定所需的现场一并记进 app.log：`NotAllowedError` 在这台机器上到底是
      // 「系统权限关了」「之前拒绝过被记住」还是「这个 URL 根本不是安全上下文」，
      // 只看一句 message 分不出来，而三种情况的修法完全不同。
      void rpcClient
        .voicecallDebug({ line: `mic failed: ${describeCaptureContext(e)}` })
        .catch(() => {});
      // 原始的 DOMException 长这样：`NotAllowedError: The request is not allowed by the
      // user agent or the platform in the current context` —— 用户看到这句没法照着做。
      throw new Error(describeMicFailure(e), { cause: e });
    }
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
    if (isRealtime()) startPushTimer();
    levelLoop();
  };

  // ------------------------------------------------------------------
  // 画面（仅 MOSS）：摄像头 / 屏幕共享 → JPEG 帧
  // ------------------------------------------------------------------

  /** 当前画面流与它的定时器（只有 MOSS 会用到）。 */
  const videoRef = useRef<{
    source: "camera" | "screen";
    stream: MediaStream;
    canvas: HTMLCanvasElement;
    timer: number;
  } | null>(null);

  const stopVideo = () => {
    const v = videoRef.current;
    videoRef.current = null;
    if (!v) return;
    window.clearInterval(v.timer);
    v.stream.getTracks().forEach((t) => t.stop());
    useVoiceCallStore.getState().setVideoSource(null);
  };

  /**
   * 开一路画面。协议建议 1 FPS、长边 640（摄像头）/ 1024（屏幕），JPEG 质量 0.8 ——
   * 这些都是"客户端默认值"而非硬限制，但按它来最稳（上游在负载下会丢旧帧）。
   *
   * 关键实现点：`drawImage` 必须在**同一张 canvas** 上按长边等比缩放，
   * 直接把原始分辨率塞进去会让每帧 200KB+，1 FPS 也会把上行带宽吃满。
   */
  const startVideo = async (source: "camera" | "screen") => {
    const store = useVoiceCallStore.getState();
    const conversationId = store.callConversationId;
    if (conversationId == null) return;
    stopVideo();
    let stream: MediaStream;
    try {
      stream =
        source === "camera"
          ? await navigator.mediaDevices.getUserMedia({
              video: { width: { ideal: 640 }, height: { ideal: 480 } },
              audio: false,
            })
          : await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (e) {
      // 原始 DOMException 的文案（"The request is not allowed by the user agent or the
      // platform in the current context"）用户看了没法照着做 —— 换成能指到系统设置的一句话。
      // null = 用户在屏幕选择器里主动取消，不算错误。
      store.setError(describeCaptureFailure(source, e));
      return;
    }
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    try {
      await video.play();
    } catch {
      // 某些环境 play() 会被拒，帧循环里再试一次即可
    }
    const canvas = document.createElement("canvas");
    const longEdge = source === "camera" ? 640 : 1024;
    const res = await rpcClient.voicecallSetVideo({ conversationId, source, enabled: true });
    if (!res.ok) {
      stream.getTracks().forEach((t) => t.stop());
      store.setError(res.supported ? "无法开启画面：通话未就绪" : "当前通话渠道不支持画面理解");
      return;
    }
    const timer = window.setInterval(() => {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return;
      const scale = Math.min(1, longEdge / Math.max(vw, vh));
      canvas.width = Math.max(1, Math.round(vw * scale));
      canvas.height = Math.max(1, Math.round(vh * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
      const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      void rpcClient
        .voicecallPushVideoFrame({ conversationId, source, jpegBase64: b64 })
        .catch(() => {});
    }, 1000);
    videoRef.current = { source, stream, canvas, timer };
    store.setVideoSource(source);
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
    if (mode === "cloud") {
      // 上行 / 下行采样率跟着厂商走（百炼 16k/24k、阶跃 24k/24k、MOSS 16k/48k）：
      // 拿当前配置里的地址 + 模型判方言。取不到配置就沿用上一次的值 ——
      // 采样率猜错的代价是"听不清 / 变调"，不值得在这里失败。
      try {
        const { config } = await rpcClient.voicecallGetProviderConfig(undefined);
        const dialect = realtimeDialectFor({ baseUrl: config?.baseUrl, model: config?.model });
        inputRateRef.current = realtimeInputRate(dialect);
        outputRateRef.current = realtimeOutputRate(dialect);
        void rpcClient
          .voicecallDebug({
            line: `rates: dialect=${dialect} in=${inputRateRef.current} out=${outputRateRef.current}`,
          })
          .catch(() => {});
      } catch (e) {
        // 静默沿用旧值仍然是错的采样率（比如上一次是 24k、这次切到 MOSS 的 48k）：
        // 表现是"声音又慢又闷"，用户不会想到是采样率。至少留一条日志。
        void rpcClient
          .voicecallDebug({
            line: `rates: 读取厂商配置失败，沿用 in=${inputRateRef.current} out=${outputRateRef.current} (${
              e instanceof Error ? e.message : String(e)
            })`,
          })
          .catch(() => {});
      }
    }
    let convId: number | null = null;
    try {
      // 先拿麦克风，再拨号。反过来（先连云端再开麦）有两个真实的坏处：
      //   1. 云端已经开始按在线时长计费，麦克风一被拒就白连一次；
      //   2. 用户看到的是"点了启动就报错"，而此时服务端会话已经建好、又被回滚，
      //      日志里会多出一对 connect/stop，掩盖真正的原因（权限）。
      // 麦克风是所有模式的前提，先失败在最前面最省事。
      await beginCapture();
      const res = await rpcClient.voicecallStart({
        conversationId: conversationId ?? undefined,
        provider: mode,
      });
      if (!res.ok || !res.conversation) {
        stopCapture();
        store.setError(res.error ?? "无法开始通话");
        store.setPhase("error");
        return;
      }
      convId = res.conversation.id;
      useChatStore.getState().setActiveConversation(convId);
      useChatStore.getState().setActiveMessages([]);
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      store.beginCall(convId, mode);
    } catch (e) {
      // 拨号失败必须留痕：麦克风被拒这类错误此前只写进 store，界面上是一句话、
      // app.log 里什么都没有，事后只能靠用户复述"报了个英文错"。带上错误名与
      // 模式，才能分清是权限被拒（NotAllowedError）、设备不存在，还是云端连不上。
      const name = e instanceof DOMException ? e.name : e instanceof Error ? e.name : "";
      void rpcClient
        .voicecallDebug({
          line: `start failed provider=${mode} error=${name || "Error"}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        })
        .catch(() => {});
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

  return { start, hangup, stopCurrentAudio, startVideo, stopVideo };
}
