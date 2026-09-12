import { create } from "zustand";

export type AppId =
  | "chat"
  | "agent"
  | "voicecall"
  | "voice"
  | "image"
  | "video"
  | "ocr"
  | "translate"
  | "prompt"
  | "skills"
  | "kb"
  | "memory"
  | "benchmark";

type AppState = {
  activeApp: AppId;
  setActiveApp: (app: AppId) => void;
};

export const useAppStore = create<AppState>((set) => ({
  activeApp: "chat",
  setActiveApp: (activeApp) => set({ activeApp }),
}));