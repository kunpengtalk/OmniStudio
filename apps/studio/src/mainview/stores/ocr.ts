import { create } from "zustand";

/** OCR 页的两个子工具（识别提取 / 文档处理），入口在左侧栏，与 OcrScreen 共享。 */
export type OcrToolTab = "extract" | "docs";

interface OcrState {
  tab: OcrToolTab;
  setTab: (tab: OcrToolTab) => void;
}

export const useOcrStore = create<OcrState>((set) => ({
  tab: "extract",
  setTab: (tab) => set({ tab }),
}));
