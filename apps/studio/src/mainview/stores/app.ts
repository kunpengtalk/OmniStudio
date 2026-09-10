import { create } from "zustand";

export type AppId = "chat" | "voice" | "image" | "ocr" | "translate" | "prompt";

type AppState = {
  activeApp: AppId;
  setActiveApp: (app: AppId) => void;
};

export const useAppStore = create<AppState>((set) => ({
  activeApp: "chat",
  setActiveApp: (activeApp) => set({ activeApp }),
}));