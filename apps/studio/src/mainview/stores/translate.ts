import { create } from "zustand";
import type { TranslationRecordRow } from "../../bun/translate";

/** 翻译应用的子工具：text = 文本翻译；live = 同传翻译（实时转写 + 多语输出）。 */
export type TranslateTool = "text" | "live";

interface TranslateState {
  tool: TranslateTool;
  setTool: (tool: TranslateTool) => void;
  /** 左侧边栏选中的翻译历史记录；编辑区据此加载原文与译文。 */
  activeRecord: TranslationRecordRow | null;
  selectRecord: (record: TranslationRecordRow) => void;
  clearActive: () => void;
}

export const useTranslateStore = create<TranslateState>((set) => ({
  tool: "text",
  setTool: (tool) => set({ tool }),
  activeRecord: null,
  selectRecord: (record) => set({ activeRecord: record }),
  clearActive: () => set({ activeRecord: null }),
}));
