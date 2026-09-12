import { eq, asc } from "drizzle-orm";
import path from "path";
import { appendFileSync } from "fs";

import { db } from "./db";
import { conversations, messages } from "./db/schema";
import { transcribeAudio, getAsrStatus, getASRProviderConfig, resolveModelPath } from "./asr";
import { DEFAULT_ASR_MODEL_FILE } from "../shared/modelscope";
import { getTTSProviderConfig, synthesizeCallSpeech } from "./voice";
import { isTtsLocalActive } from "./tts-local";
import { createConversation, getChatBaseUrl, streamChatTurn, type Conversation } from "./chat";
import { getChatModelLabel } from "./chat-model";
import {
  RealtimeVoiceClient,
  getVoiceCallProvider,
  getRealtimeProviderConfig,
  wavToPcm16,
  type RealtimeVoiceEvent,
  type VoiceCallProvider,
} from "./realtime-voice";

// ---------------------------------------------------------------------------
// 实时语音通话（电话式协作）
//
// 前端负责：麦克风采集、VAD 断句、TTS 播放队列与自然打断检测。
// 后端负责：把用户讲话增量转写（partial 实时字幕）→ 驱动标准对话管线
// （streamChatTurn，流式正文）→ 句子切分后逐句 TTS 推流回前端播放；
// 用户在 Agent 说话时随时插嘴即可打断（AbortSignal）。
// 会话与消息完全复用 chat 的对话模型（conversations.app = "voicecall"），
// 历史即通话记录。
// ---------------------------------------------------------------------------

/**
 * 语音通话专用系统提示：告诉模型自己是语音助手，口语化、简短、别用 Markdown、
 * 别输出思考过程，让输出既快又适合朗读。每次生成回合都注入。
 */
const VOICE_CALL_SYSTEM_PROMPT = [
  "你是一个正在通过语音通话与用户实时对话的智能语音助手。",
  "回答要求：",
  "1. 口语化、自然、简洁，像真人打电话一样，每次回答控制在 2 到 4 句。",
  "2. 直接给出最终回答，不要输出任何思考过程。",
  "3. 禁止使用 Markdown、列表、标题、代码块、表情符号或任何特殊符号，只输出纯文字正文。",
  "4. 用户没听清或表达有歧义时，礼貌地请对方再说一遍，不要妄加推测。",
].join("\n");

export type VoiceCallPhase = "listening" | "thinking" | "speaking";

export type VoiceCallOutgoing =
  | { type: "partial"; conversationId: number; text: string }
  | { type: "utterance"; conversationId: number; messageId: number; text: string }
  | { type: "state"; conversationId: number; phase: VoiceCallPhase }
  /** 音频事件：本地模式推 WAV；云端模式推裸 PCM16 24k（前端按 format 解码）。 */
  | { type: "audio"; conversationId: number; wavBase64: string; format: "wav" | "pcm" }
  | { type: "audioStop"; conversationId: number }
  /** 云端模式：助手流式正文 / 回合定稿（复用 chatChunk/chatDone 通道画气泡）。 */
  | { type: "assistantPartial"; conversationId: number; messageId: number; text: string }
  | { type: "assistantDone"; conversationId: number; messageId: number; text: string }
  | { type: "error"; conversationId: number; message: string };

export type VoiceCallPreflight = {
  model: { available: boolean; detail: string };
  asr: { available: boolean; detail: string };
  tts: { available: boolean; detail: string };
  provider: { mode: VoiceCallProvider; cloudConfigured: boolean; detail: string };
};

type Listener = (msg: VoiceCallOutgoing) => void;

const listeners = new Set<Listener>();

/** 通话调试日志（便于排查无声音输出）。 */
const CALL_LOG = "/tmp/omni-voicecall.log";
function callLog(line: string): void {
  try {
    appendFileSync(CALL_LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // 日志失败不影响主流程
  }
}

export function onVoiceCallEvent(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function emit(msg: VoiceCallOutgoing) {
  for (const cb of listeners) {
    try {
      cb(msg);
    } catch {
      // 单个监听器异常不影响其他监听器
    }
  }
}

/** 阶段变更时才推送状态，避免刷屏。 */
function setPhase(session: Session, phase: VoiceCallPhase | "listening"): void {
  if (session.phase === phase) return;
  session.phase = phase;
  emit({ type: "state", conversationId: session.conversationId, phase });
}

// 16k mono 16bit PCM：1 秒 ≈ 32000 字节。
const SAMPLE_BYTES_PER_SEC = 32_000;

/** 16k/16bit 单声道裸 PCM → WAV（增量推流攒的是裸 PCM，转写前包一个头）。 */
function pcm16ToWav(pcm: Buffer, sampleRate = 16000): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
/** 增量转写只取最近 6 秒，保证字幕跟手不至于越拖越慢。 */
const PARTIAL_WINDOW_BYTES = SAMPLE_BYTES_PER_SEC * 6;
/** 一段话超过 30 秒不落句时强制切句（避免内存与转写延迟失控）。 */
const MAX_UTTERANCE_BYTES = SAMPLE_BYTES_PER_SEC * 30;
/** 少于 40ms 的音频视为无效输入。 */
const MIN_UTTERANCE_BYTES = SAMPLE_BYTES_PER_SEC * 0.04;
/** 转写去抖：两句 partial 之间至少间隔 320ms。 */
const PARTIAL_DEBOUNCE_MS = 320;

type Session = {
  conversationId: number;
  active: boolean;
  /** local = 本地 ASR+LLM+TTS 三段管线；cloud = Qwen Realtime 全双工。 */
  provider: VoiceCallProvider;
  /** 云端实时客户端（仅 cloud 模式持有）。 */
  realtime: RealtimeVoiceClient | null;
  /** 当前阶段（用于给前端推送状态；本地跟随，跨调用保持）。 */
  phase: VoiceCallPhase | "listening";
  /** 当前这段话音的完整 16k PCM WAV（前端每次整段重发，因此这里整体替换）。 */
  utterance: Buffer;
  /** 正在进行的增量转写请求（结束时端句前要等它落定）。 */
  asrInFlight: Promise<void> | null;
  asrTimer: ReturnType<typeof setTimeout> | null;
  liveText: string;
  // 生成（对话管线 + TTS）侧
  generation: Promise<unknown> | null;
  ctrl: AbortController | null;
  ttsTurn: number;
  sayBuf: string;
  speakQueue: string[];
  draining: boolean;
  agentDone: boolean;
  /** 本轮是否已经真正推出一句音频（用于「思考中 → 说话中」的状态切换时机）。 */
  spoken: boolean;
  // 云端侧：当前助手回合占位的消息行与累计正文（定稿时落库 + chatDone）。
  cloudMessageId: number | null;
  cloudText: string;
  /** 用户抢话/打断后，丢弃服务端截断前残余的音频块（避免停顿处又冒出半句）。 */
  cloudBargeIn: boolean;
  /**
   * startVoiceCall 等待「云端连接就绪」的回执。连接成功后置回 null；
   * 错误/超时路径返回失败，前端据此提示而不是假装已接通。
   */
  readyAck: ((r: { ok: boolean; message?: string }) => void) | null;
};

/** 等待云端实时连接就绪的兜底时长（超过即视为失败，避免无限转圈）。 */
const CONNECT_ACK_TIMEOUT_MS = 10_000;

const sessions = new Map<number, Session>();

function getSession(conversationId: number): Session | undefined {
  return sessions.get(conversationId);
}

// ---------------------------------------------------------------------------
// 增量转写（实时字幕）
// ---------------------------------------------------------------------------

async function runPartial(session: Session): Promise<void> {
  const total = session.utterance.length;
  if (total < MIN_UTTERANCE_BYTES) return;
  // 整段转写太慢，只取最近一段窗口；字幕以替换方式下发，无需前端拼接。
  const start = Math.max(0, total - PARTIAL_WINDOW_BYTES);
  const buf = session.utterance.subarray(start);
  try {
    const res = await transcribeAudio({ wavBase64: pcm16ToWav(buf).toString("base64") });
    const text = res.text.trim();
    if (text && text !== session.liveText) {
      session.liveText = text;
      emit({ type: "partial", conversationId: session.conversationId, text });
    }
  } catch {
    // 增量转写失败不打断通话，等下一片或端句时再试。
  }
}

/**
 * 一段话音期间，前端约每 300ms 推一帧音频；后端去抖后做增量转写。
 * 同一时刻只允许一个转写请求（whisper-server 串行处理）。
 */
function schedulePartial(session: Session): void {
  if (session.asrInFlight || session.asrTimer) return;
  session.asrTimer = setTimeout(() => {
    session.asrTimer = null;
    const p = runPartial(session).finally(() => {
      session.asrInFlight = null;
    });
    session.asrInFlight = p;
  }, PARTIAL_DEBOUNCE_MS);
}

async function settleAsr(session: Session): Promise<void> {
  if (session.asrInFlight) {
    try {
      await session.asrInFlight;
    } catch {
      // ignore
    }
  }
  if (session.asrTimer) {
    clearTimeout(session.asrTimer);
    session.asrTimer = null;
  }
}

// ---------------------------------------------------------------------------
// 句子切分（用于逐句 TTS）
// ---------------------------------------------------------------------------

const SENTENCE_END = /[。！？!?；;\n]/;
/** 逗号级停顿点（中文里逗号是自然换气点，拆短一点能让第一个音频更快出声）。 */
const PAUSE_POINT = /[，、,]/;
/** 逗号点至少积累这么多字才切，避免"首先，"这类碎片被单独朗读。 */
const MIN_UNIT_CHARS = 8;
const MAX_UNIT_CHARS = 80;

function splitSentences(buf: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let rest = buf;
  // 1) 句末标点：完整一句，优先切。
  for (let i = 0; i < rest.length; i++) {
    if (SENTENCE_END.test(rest[i]!)) {
      sentences.push(rest.slice(0, i + 1));
      rest = rest.slice(i + 1);
      return { sentences, rest };
    }
  }
  // 2) 逗号级停顿：已积累足够多字再切，兼顾出声速度与朗读连贯性。
  for (let i = 0; i < rest.length; i++) {
    if (PAUSE_POINT.test(rest[i]!) && i >= MIN_UNIT_CHARS) {
      sentences.push(rest.slice(0, i + 1));
      rest = rest.slice(i + 1);
      return { sentences, rest };
    }
  }
  // 3) 无标点的长段（英文/代码）在最近空格处强制切分，避免一整段读完才出声。
  if (rest.length >= MAX_UNIT_CHARS) {
    const cut = rest.lastIndexOf(" ", MAX_UNIT_CHARS - 1);
    if (cut > 40) {
      sentences.push(rest.slice(0, cut));
      rest = rest.slice(cut + 1);
    }
  }
  return { sentences, rest };
}

// ---------------------------------------------------------------------------
// 逐句 TTS 推流
// ---------------------------------------------------------------------------

/**
 * 去掉 Markdown 语法，只留可朗读的正文（模型回复常用标题、加粗、列表、反引号等符号，
 * 逐字念会跟渲染后的文字对不上）。
 */
function stripMarkdownText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/^```\w*\s*/m, "").replace(/```$/m, ""))
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*(\d+)[.)]\s+/gm, "$1 ")
    .replace(/[#*_~`|<>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 是否包含可朗读的文字/数字（排除纯标点——纯符号碎片会让 TTS 瞎编）。 */
function hasSpeakableText(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

function maybeFinishSpeaking(session: Session, turn: number): void {
  if (session.ttsTurn !== turn || !session.active || !session.agentDone) return;
  if (session.speakQueue.length > 0 || session.sayBuf.trim()) {
    // 生成结束时的收尾碎片也朗读出来，避免「文字显示了但没读」的尾巴。
    const tail = stripMarkdownText(session.sayBuf);
    if (hasSpeakableText(tail) && session.speakQueue.length === 0) {
      session.speakQueue.push(tail);
    }
    session.sayBuf = "";
    kickSpeak(session, turn);
    return;
  }
  setPhase(session, "listening");
}

function kickSpeak(session: Session, turn: number): void {
  if (session.draining) return;
  session.draining = true;
  void (async () => {
    try {
      while (session.ttsTurn === turn && session.active && session.speakQueue.length > 0) {
        const text = session.speakQueue.shift()!;
        if (!text.trim()) continue;
        try {
          // 兜底超时：本地 audio.cpp 进程偶发卡死时，不能让 draining 被永久占住，
          // 否则后续句子与新一轮回合都无法继续朗读。
          const { buffer, engine } = await Promise.race([
            synthesizeCallSpeech(text),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("synthesize timeout")), 30_000),
            ),
          ]);
          if (session.ttsTurn !== turn || !session.active) {
            // 回合被新一轮生成/打断替换：这句已经合成但不再属于当前输出，丢弃。
            callLog(
              `sentence dropped: turn=${turn} cur=${session.ttsTurn} active=${session.active} text=${text.trim().slice(0, 40)}`,
            );
            return;
          }
          // 只有真正推出一句音频才从「思考中」切到「说话中」；
          // 合成/等待阶段保持 thinking（首句合成通常耗时最长）。
          if (!session.spoken) {
            session.spoken = true;
            setPhase(session, "speaking");
          }
          emit({
            type: "audio",
            conversationId: session.conversationId,
            wavBase64: buffer.toString("base64"),
            format: "wav",
          });
          callLog(
            `audio shipped: engine=${engine} bytes=${buffer.byteLength} chars=${text.trim().length} text=${text.trim().slice(0, 40)}`,
          );
        } catch (e) {
          callLog(`sentence failed: ${String(e)}`);
          // 单句合成失败：跳过继续下一句，保证整轮至少能说完。
        }
      }
    } finally {
      session.draining = false;
      // 用「当前回合」而非本 drain 的 turn 决定续跑：新回合开始时老 drain 可能还在
      // 合成（此时 onDelta 的 kickSpeak 都会因 draining 早退），若按旧 turn 收尾，
      // 新回合的残留句子会卡在队列里没人朗读。按当前回合接管即可正常续播。
      const cur = session.ttsTurn;
      if (session.active && session.speakQueue.length > 0) {
        kickSpeak(session, cur);
      } else {
        maybeFinishSpeaking(session, cur);
      }
    }
  })();
}

// ---------------------------------------------------------------------------
// Agent 回合（聊天管线流式正文 + 逐句朗读）
// ---------------------------------------------------------------------------

async function runGeneration(session: Session, text: string): Promise<void> {
  const { conversationId } = session;
  // 防御：上一轮还在生成（例如打断信号丢失）则先中止再开新回合。
  if (session.generation) {
    session.ctrl?.abort();
    await session.generation.catch(() => {});
  }

  session.agentDone = false;
  session.ttsTurn += 1;
  session.spoken = false;
  const turn = session.ttsTurn;
  session.sayBuf = "";
  session.speakQueue = [];
  // 注意：不要在这里复位 session.draining。清掉它会让上一轮仍在合成的 drain
  // （await synthesizeCallSpeech 中）与新一轮 drain 并发跑，白白合成后被丢弃，
  // 徒增“只念出最后一句”的概率。draining 只应由 kickSpeak 自己的 finally 复位。
  const ctrl = new AbortController();
  session.ctrl = ctrl;
  setPhase(session, "thinking");

  const promise = streamChatTurn({
    conversationId,
    content: text,
    signal: ctrl.signal,
    // 语音通话：注入语音助手系统提示 + 关闭思考模式，让首字出来快、内容适合朗读。
    extraSystem: VOICE_CALL_SYSTEM_PROMPT,
    disableThinking: true,
    onDelta: (delta) => {
      if (session.ttsTurn !== turn || !session.active) return;
      session.sayBuf += delta;
      const { sentences, rest } = splitSentences(session.sayBuf);
      session.sayBuf = rest;
      for (const s of sentences) {
        if (!session.active) break;
        // 剥掉 Markdown 只念正文；纯空白/纯标点碎片不合成（否则 TTS 会对着符号瞎编）。
        const clean = stripMarkdownText(s);
        if (!hasSpeakableText(clean)) continue;
        session.speakQueue.push(clean);
      }
      kickSpeak(session, turn);
    },
  });
  session.generation = promise;
  try {
    await promise;
  } finally {
    if (session.generation === promise) session.generation = null;
    if (session.ctrl === ctrl) session.ctrl = null;
    // 兜底：无输出 / 出错等路径也要把剩余文本说完并回到聆听状态。
    if (session.active && session.ttsTurn === turn) {
      session.agentDone = true;
      kickSpeak(session, turn);
    }
  }
}

// ---------------------------------------------------------------------------
// 云端实时通话（Qwen Realtime，全双工）
// ---------------------------------------------------------------------------

function openRealtime(session: Session, ack?: (r: { ok: boolean; error?: string }) => void): void {
  const cfg = getRealtimeProviderConfig();
  const client = new RealtimeVoiceClient(
    {
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      voice: cfg.voice,
      instructions: VOICE_CALL_SYSTEM_PROMPT,
      // 恢复历史通话时注入最近几轮对话，让云端会话记得上下文（新通话为空）。
      history: getCloudHistory(session.conversationId),
      onEvent: (ev) => onRealtimeEvent(session, ev),
    },
    callLog,
  );
  session.realtime = client;
  if (ack) {
    // 连接就绪（session.updated）或失败（error/超时）时回执给 startVoiceCall。
    const timer = setTimeout(() => {
      if (!session.readyAck) return; // 已被正常回执或挂断清理
      session.readyAck = null;
      session.realtime?.stop();
      session.realtime = null;
      ack({ ok: false, error: "连接云端实时语音超时，请检查网络或 API Key" });
    }, CONNECT_ACK_TIMEOUT_MS);
    session.readyAck = (r) => {
      clearTimeout(timer);
      session.readyAck = null;
      ack(r.ok ? { ok: true } : { ok: false, error: r.message });
    };
  }
  client.connect();
}

/** 云端会话上下文：取该通话最近 N 条用户/助手文本（只读，供实时会话回放）。 */
function getCloudHistory(conversationId: number, limit = 10): { role: "user" | "assistant"; content: string }[] {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.id))
    .all()
    .slice(-limit)
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content }));
}

/** 云端实时事件 → 现有 RPC 通道（partial/utterance/state/audio/chatChunk/chatDone）。 */
function onRealtimeEvent(session: Session, ev: RealtimeVoiceEvent): void {
  const { conversationId } = session;
  switch (ev.type) {
    case "ready":
      session.readyAck?.({ ok: true });
      setPhase(session, "listening");
      break;
    case "userPartial":
      emit({ type: "partial", conversationId, text: ev.text });
      break;
    case "userText": {
      if (!session.active) return;
      const inserted = db
        .insert(messages)
        .values({ conversationId, role: "user", content: ev.text.trim() })
        .returning({ id: messages.id })
        .get();
      emit({ type: "utterance", conversationId, messageId: inserted.id, text: ev.text.trim() });
      break;
    }
    case "turnStart": {
      if (!session.active) return;
      // 占位一条助手消息，流式正文经 chatChunk 通道回填气泡，定稿时落库全文。
      const row = db
        .insert(messages)
        .values({ conversationId, role: "assistant", content: "" })
        .returning({ id: messages.id })
        .get();
      session.cloudMessageId = row.id;
      session.cloudText = "";
      session.spoken = false;
      session.cloudBargeIn = false;
      setPhase(session, "thinking");
      break;
    }
    case "partial": {
      if (!session.active || session.cloudMessageId == null) return;
      session.cloudText += ev.text;
      emit({
        type: "assistantPartial",
        conversationId,
        messageId: session.cloudMessageId,
        text: ev.text,
      });
      break;
    }
    case "audio": {
      if (!session.active || session.cloudBargeIn) return;
      if (!session.spoken) {
        session.spoken = true;
        setPhase(session, "speaking");
      }
      emit({
        type: "audio",
        conversationId,
        wavBase64: ev.pcm.toString("base64"),
        format: "pcm",
      });
      break;
    }
    case "turnEnd": {
      if (!session.active) return;
      const text = ev.text.trim();
      if (session.cloudMessageId != null) {
        db.update(messages)
          .set({ content: text })
          .where(eq(messages.id, session.cloudMessageId))
          .run();
        emit({
          type: "assistantDone",
          conversationId,
          messageId: session.cloudMessageId,
          text,
        });
      }
      session.cloudMessageId = null;
      session.cloudText = "";
      session.spoken = false;
      setPhase(session, "listening");
      break;
    }
    case "speechStart":
      // 服务端 VAD（smart_turn）检测到用户开声：可能正在朗读中，立即停掉本地播放，
      // 并丢弃本回合剩余音频块（截断前服务端可能还会推来残余）。
      session.cloudBargeIn = true;
      emit({ type: "audioStop", conversationId });
      setPhase(session, "listening");
      break;
    case "speechEnd":
      break;
    case "error":
      session.readyAck?.({ ok: false, message: ev.message });
      emit({ type: "error", conversationId, message: ev.message });
      setPhase(session, "listening");
      break;
  }
}

// ---------------------------------------------------------------------------
// 对外 API（RPC handlers 直接调用）
// ---------------------------------------------------------------------------

export function voiceCallPreflight(): Promise<VoiceCallPreflight> {
  return (async () => {
    const modelLabel = getChatModelLabel();
    const modelDetail = modelLabel
      ? `模型：${modelLabel}`
      : "未配置对话模型，请先在设置中选择模型";
    const model = { available: !!modelLabel && !!getChatBaseUrl(), detail: modelDetail };

    let asr: VoiceCallPreflight["asr"];
    try {
      const status = await getAsrStatus();
      const provider = getASRProviderConfig();
      const localModel = resolveModelPath();
      const localOk = status.engineInstalled && !!localModel;
      // 未显式配置时，默认模型 = Whisper large-v3-turbo。
      const modelLabel = (() => {
        if (!localModel) return "";
        return path.basename(localModel) === DEFAULT_ASR_MODEL_FILE
          ? "Whisper large-v3-turbo"
          : path.basename(localModel);
      })();
      asr = localOk || !!provider.base
        ? {
            available: true,
            detail: localOk
              ? `本地 whisper.cpp（${modelLabel}）`
              : `远程：${provider.base}`,
          }
        : {
            available: false,
            detail: "未配置语音识别（ASR）：请安装 whisper.cpp 引擎并下载默认模型 Whisper large-v3-turbo，或配置远程 ASR",
          };
    } catch {
      asr = { available: false, detail: "无法检测语音识别引擎" };
    }

    const ttsProvider = getTTSProviderConfig();
    const tts = isTtsLocalActive()
      ? { available: true, detail: "本地 audio.cpp TTS（合成快、无网络延迟）" }
      : ttsProvider.base
        ? { available: true, detail: `远程 TTS：${ttsProvider.base}` }
        : { available: true, detail: "Edge TTS（在线，免密钥）" };

    const rtc = getRealtimeProviderConfig();
    const provider: VoiceCallPreflight["provider"] = {
      mode: rtc.provider,
      cloudConfigured: rtc.configured,
      detail:
        rtc.provider === "cloud"
          ? rtc.configured
            ? `已就绪：${rtc.model}（音色 ${rtc.voice}）`
            : "云端模式未配置 API Key"
          : "本地模式（whisper 转写 + 本地/远程模型 + TTS）",
    };

    return { model, asr, tts, provider };
  })();
}

/**
 * 开始/恢复一次通话。传入 conversationId 则沿用历史会话（继续上一通电话的上下文），
 * 否则新建一条 conversations.app = "voicecall" 的记录（即一条新的通话记录）。
 * provider 可为空（默认读设置）：local = 本地三段管线，cloud = Qwen Realtime。
 * 云端模式下会**等待实时连接就绪**（或明确失败）才返回，避免前端“假接通”：
 * 拨号期间的转圈即真实的连接中状态，失败时把真实原因带回给界面。
 */
export async function startVoiceCall(opts: {
  conversationId?: number;
  provider?: "local" | "cloud";
}): Promise<{ ok: boolean; conversation?: Conversation; error?: string }> {
  const provider = opts.provider ?? getVoiceCallProvider();
  if (provider === "cloud" && !getRealtimeProviderConfig().configured) {
    return { ok: false, error: "云端模式未配置 API Key，请先在通话界面的「云端配置」中填写" };
  }

  let conv: Conversation;
  if (opts.conversationId) {
    const existing = db
      .select()
      .from(conversations)
      .where(eq(conversations.id, opts.conversationId))
      .get();
    if (existing) conv = existing as Conversation;
    else return { ok: false, error: "会话不存在" };
  } else {
    conv = createConversation(undefined, "voicecall");
  }

  let session = sessions.get(conv.id);
  if (session?.active) return { ok: true, conversation: conv };
  if (session) sessions.delete(conv.id);
  session = {
    conversationId: conv.id,
    active: true,
    provider,
    realtime: null,
    phase: "listening",
    utterance: Buffer.alloc(0),
    asrInFlight: null,
    asrTimer: null,
    liveText: "",
    generation: null,
    ctrl: null,
    ttsTurn: 0,
    sayBuf: "",
    speakQueue: [],
    draining: false,
    agentDone: true,
    spoken: false,
    cloudMessageId: null,
    cloudText: "",
    cloudBargeIn: false,
    readyAck: null,
  };
  sessions.set(conv.id, session);
  emit({ type: "state", conversationId: conv.id, phase: "listening" });
  if (provider === "cloud") {
    const ack = await new Promise<{ ok: boolean; error?: string }>((resolve) =>
      openRealtime(session, resolve),
    );
    if (!ack.ok) {
      // 连接没起来：清掉这个会话（会话记录保留），把真实原因交给前端展示。
      session.active = false;
      session.readyAck = null;
      session.realtime?.stop();
      session.realtime = null;
      sessions.delete(conv.id);
      return { ok: false, conversation: conv, error: ack.error };
    }
  }
  return { ok: true, conversation: conv };
}

/**
 * 用户说话期间推音频帧。本地模式推整段 16k WAV（后端做增量转写）；
 * 云端模式推增量 PCM16 16k（或兼容 wav，后端剥头后追加给实时模型）。
 */
export function pushVoiceCallAudio(opts: {
  conversationId: number;
  wavBase64: string;
  format?: "wav" | "pcm";
}): { ok: boolean } {
  const session = getSession(opts.conversationId);
  if (!session?.active) return { ok: false };
  if (session.provider === "cloud") {
    const raw = Buffer.from(opts.wavBase64, "base64");
    const pcm = opts.format === "pcm" ? raw : wavToPcm16(raw);
    session.realtime?.appendAudio(pcm);
    return { ok: true };
  }
  // 本地模式：前端按增量推裸 PCM16 16k，这里累积成整段（端句时整段转写拿准确文本）。
  const raw = Buffer.from(opts.wavBase64, "base64");
  const pcm = opts.format === "wav" ? wavToPcm16(raw) : raw;
  if (pcm.length) {
    session.utterance =
      session.utterance.length === 0 ? pcm : Buffer.concat([session.utterance, pcm]);
  }
  if (session.utterance.length > MAX_UTTERANCE_BYTES) {
    // 一句话说得过长：强制切句，等端句流程接手。
    void endVoiceCallUtterance({ conversationId: session.conversationId });
    return { ok: true };
  }
  schedulePartial(session);
  return { ok: true };
}

/**
 * 一段话音结束（VAD 静音 / 用户停止说话）：整段重新转写拿到准确文本，
 * 落库为用户消息并触发对话回合（正文流式回来、逐句 TTS 播放）。
 */
export async function endVoiceCallUtterance(opts: {
  conversationId: number;
}): Promise<{ ok: boolean; text?: string; error?: string }> {
  const session = getSession(opts.conversationId);
  if (!session?.active) return { ok: false, error: "通话未开始" };
  // 云端：断句由服务端 smart_turn 负责；这里只发「输入缓冲可落定」信号让断句更跟手。
  if (session.provider === "cloud") {
    session.realtime?.commit();
    return { ok: true };
  }
  await settleAsr(session);

  // 先引用当前这段话的音频；转写 await 期间用户可能又开始说新一段，
  // pushVoiceCallAudio 会用新 Buffer 追加，不能把新音频一并清掉。
  const utterance = session.utterance;
  const total = utterance.length;
  let text = session.liveText;
  if (total >= MIN_UTTERANCE_BYTES) {
    const wavBase64 = pcm16ToWav(utterance).toString("base64");
    try {
      const res = await transcribeAudio({ wavBase64 });
      const finalText = res.text.trim();
      if (finalText) text = finalText;
    } catch {
      // 转写失败：沿用增量字幕
    }
  }
  if (session.utterance === utterance) session.utterance = Buffer.alloc(0);
  session.liveText = "";
  if (!text.trim()) {
    setPhase(session, "listening");
    return { ok: true, text: "" };
  }

  const inserted = db
    .insert(messages)
    .values({ conversationId: session.conversationId, role: "user", content: text.trim() })
    .returning({ id: messages.id })
    .get();
  emit({
    type: "utterance",
    conversationId: session.conversationId,
    messageId: inserted.id,
    text: text.trim(),
  });
  void runGeneration(session, text.trim());
  return { ok: true, text: text.trim() };
}

/** 打断：用户抢话。停掉正在朗读的 TTS 与正在生成的对话回合，回到聆听。 */
export function interruptVoiceCall(conversationId: number): { ok: boolean } {
  const session = getSession(conversationId);
  if (!session?.active) return { ok: false };
  if (session.provider === "cloud") {
    // 云端：response.cancel 停掉生成；服务端 smart_turn 同时负责本回合截断。
    session.realtime?.interrupt();
    session.spoken = false;
    session.cloudText = "";
    session.cloudBargeIn = true;
    emit({ type: "audioStop", conversationId });
    setPhase(session, "listening");
    return { ok: true };
  }
  callLog(
    `interrupt: phase=${session.phase} queued=${session.speakQueue.length} sayBuf=${session.sayBuf.trim().slice(0, 40)}`,
  );
  session.ttsTurn += 1;
  session.sayBuf = "";
  session.speakQueue = [];
  session.agentDone = false;
  session.spoken = false;
  session.ctrl?.abort();
  // 推流是增量追加（pushVoiceCallAudio 累积成整段），这里必须清掉旧缓冲；
  // 前端在抢话瞬间先发 interrupt 再发新一段的音频帧，IPC 有序保证不会丢新音频。
  session.utterance = Buffer.alloc(0);
  session.liveText = "";
  if (session.asrTimer) {
    clearTimeout(session.asrTimer);
    session.asrTimer = null;
  }
  emit({ type: "audioStop", conversationId });
  setPhase(session, "listening");
  return { ok: true };
}

/** 挂断：结束通话并释放资源（通话记录保留在会话里）。 */
export function stopVoiceCall(conversationId: number): { ok: boolean } {
  const session = getSession(conversationId);
  if (!session) return { ok: false };
  session.active = false;
  if (session.provider === "cloud") {
    session.readyAck = null;
    session.realtime?.stop();
    session.realtime = null;
  }
  if (session.asrTimer) {
    clearTimeout(session.asrTimer);
    session.asrTimer = null;
  }
  session.ttsTurn += 1;
  session.sayBuf = "";
  session.speakQueue = [];
  session.utterance = Buffer.alloc(0);
  session.liveText = "";
  session.ctrl?.abort();
  session.ctrl = null;
  session.cloudMessageId = null;
  session.cloudText = "";
  session.cloudBargeIn = false;
  sessions.delete(conversationId);
  emit({ type: "audioStop", conversationId });
  return { ok: true };
}

/** 通话是否进行中（供界面/切换兜底查询）。 */
export function isVoiceCallActive(conversationId: number): boolean {
  return sessions.get(conversationId)?.active ?? false;
}

/** 配置引导里的「测试连接」：用给定（或已保存）的配置开一条真实 WS 验证。 */
export { testRealtimeConnection } from "./realtime-voice";
