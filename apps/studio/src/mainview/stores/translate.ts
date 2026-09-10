import { create } from "zustand";
import type { TranslationRecordRow } from "../../bun/translate";

interface TranslateState {
  /** 左侧边栏选中的翻译历史记录；编辑区据此加载原文与译文。 */
  activeRecord: TranslationRecordRow | null;
  selectRecord: (record: TranslationRecordRow) => void;
  clearActive: () => void;
}

export const useTranslateStore = create<TranslateState>((set) => ({
  activeRecord: null,
  selectRecord: (record) => set({ activeRecord: record }),
  clearActive: () => set({ activeRecord: null }),
}));
