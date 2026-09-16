import { create } from "zustand";

/** 音乐页内部视图：参数生成页 / 全部历史页。 */
export type MusicView = "generate" | "history";

interface MusicState {
  /** 当前视图。 */
  view: MusicView;
  setView: (view: MusicView) => void;
  /** 当前聚焦展示的记录（侧栏点击 / 最近条点击 / 刚提交的任务）。 */
  focusRecordId: number | null;
  setFocusRecordId: (id: number | null) => void;
}

export const useMusicStore = create<MusicState>((set) => ({
  view: "generate",
  setView: (view) => set({ view }),
  focusRecordId: null,
  setFocusRecordId: (id) => set({ focusRecordId: id }),
}));
