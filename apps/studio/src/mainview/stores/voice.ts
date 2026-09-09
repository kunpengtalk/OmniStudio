import { create } from "zustand";

export type VoiceTab = "tts" | "asr" | "clone";

interface VoiceState {
  tab: VoiceTab;
  setTab: (tab: VoiceTab) => void;
}

export const useVoiceStore = create<VoiceState>((set) => ({
  tab: "tts",
  setTab: (tab) => set({ tab }),
}));
