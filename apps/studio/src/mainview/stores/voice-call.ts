import { create } from "zustand";
import { useChatStore } from "./chat";

/**
 * 通话阶段：
 * - idle          未在通话
 * - starting      拨号中（请求后台建会话 + 开麦）
 * - listening     聆听（VAD 运行中，可随时说话）
 * - transcribing  一句话说完了，正在转写 / 等模型接手
 * - thinking      模型思考中（还没有可朗读的正文）
 * - speaking      模型正在朗读
 * - error         通话异常（麦克风权限、缺模型等）
 */
export type CallPhase =
  | "idle"
  | "starting"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error";

export type AudioEntry = {
  conversationId: number;
  base64: string;
  /** wav = 本地 TTS（decodeAudioData）；pcm = 云端实时音频（PCM16 24k 裸流）。 */
  format: "wav" | "pcm";
};

export type VoiceCallProvider = "local" | "cloud";

interface VoiceCallState {
  phase: CallPhase;
  /** 当前通话绑定的会话（即一条通话记录）。 */
  callConversationId: number | null;
  /** 当前通话使用的模式（本地 / 云端）。 */
  provider: VoiceCallProvider | null;
  /** 实时字幕：用户正在说的话（后端增量转写回推）。 */
  liveText: string;
  /** 是否正在展示「正在听」实时字幕条。 */
  liveActive: boolean;
  /** 麦克风电平 0..1（驱动波形动画）。 */
  micLevel: number;
  error: string | null;
  /** 待播放的 TTS 音频队列（按到达顺序播放，支持打断清空）。 */
  audioQueue: AudioEntry[];
  setPhase: (phase: CallPhase) => void;
  setMicLevel: (level: number) => void;
  setLiveActive: (active: boolean) => void;
  setLiveText: (text: string) => void;
  setError: (error: string | null) => void;
  /** 通话正式开始（开麦成功后）。 */
  beginCall: (conversationId: number, provider: VoiceCallProvider) => void;
  /** 挂断并复位。 */
  endCall: () => void;
  /** 一句话定稿：清掉实时字幕，把用户消息直接进消息列表。 */
  commitUtterance: (conversationId: number, messageId: number, text: string) => void;
  enqueueAudio: (entry: AudioEntry) => void;
  clearAudio: () => void;
}

export const useVoiceCallStore = create<VoiceCallState>((set, get) => ({
  phase: "idle",
  callConversationId: null,
  provider: null,
  liveText: "",
  liveActive: false,
  micLevel: 0,
  error: null,
  audioQueue: [],

  setPhase: (phase) => {
    if (get().phase === phase) return;
    set({ phase });
  },

  setMicLevel: (micLevel) => set({ micLevel }),
  setLiveActive: (liveActive) => set({ liveActive }),
  setLiveText: (liveText) => set({ liveText }),
  setError: (error) => set({ error }),

  beginCall: (conversationId, provider) =>
    set({ callConversationId: conversationId, provider, phase: "listening", error: null, liveText: "" }),

  endCall: () =>
    set({
      phase: "idle",
      callConversationId: null,
      provider: null,
      liveText: "",
      liveActive: false,
      micLevel: 0,
      error: null,
      audioQueue: [],
    }),

  commitUtterance: (conversationId, messageId, text) => {
    set({ liveText: "", liveActive: false });
    const chat = useChatStore.getState();
    if (chat.activeConversationId !== conversationId) return;
    const message = {
      id: messageId,
      conversationId,
      role: "user" as const,
      content: text,
      createdAt: Date.now(),
    };
    if (chat.activeMessages.some((m) => m.id === messageId)) return;
    chat.setActiveMessages([...chat.activeMessages, message]);
  },

  enqueueAudio: (entry) => {
    const { callConversationId, audioQueue } = get();
    if (entry.conversationId !== callConversationId) return;
    set({ audioQueue: [...audioQueue, entry] });
  },

  clearAudio: () => {
    if (get().audioQueue.length === 0) return;
    set({ audioQueue: [] });
  },
}));
