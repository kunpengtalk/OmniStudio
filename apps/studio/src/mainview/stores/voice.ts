import { create } from "zustand";

export type VoiceTab = "tts" | "asr" | "clone";

interface VoiceState {
  tab: VoiceTab;
  setTab: (tab: VoiceTab) => void;
  /**
   * 左侧历史里选中的那条记录（`null` = 正在做的这一份）。
   * 右侧据此把那次任务还原出来；三个工具页共用，切工具时记录 kind 必然对不上，跟着一起清掉。
   */
  focusRecordId: number | null;
  setFocusRecordId: (id: number | null) => void;
}

export const useVoiceStore = create<VoiceState>((set) => ({
  tab: "tts",
  setTab: (tab) => set({ tab, focusRecordId: null }),
  focusRecordId: null,
  setFocusRecordId: (focusRecordId) => set({ focusRecordId }),
}));
