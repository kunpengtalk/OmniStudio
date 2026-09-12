import { create } from "zustand";

/** 视频页内部视图：参数生成页 / 全部历史页。 */
export type VideoView = "generate" | "history";

interface VideoState {
  /** 当前视图。 */
  view: VideoView;
  setView: (view: VideoView) => void;
  /** 当前聚焦展示的记录（侧栏点击 / 最近条点击 / 刚提交的任务）。 */
  focusRecordId: number | null;
  setFocusRecordId: (id: number | null) => void;
  /** 提示词库「去试试」带过来的草稿，视频页挂载时读入提示词框。 */
  pendingPrompt: string | null;
  setPendingPrompt: (prompt: string | null) => void;
}

export const useVideoStore = create<VideoState>((set) => ({
  view: "generate",
  setView: (view) => set({ view }),
  focusRecordId: null,
  setFocusRecordId: (id) => set({ focusRecordId: id }),
  pendingPrompt: null,
  setPendingPrompt: (pendingPrompt) => set({ pendingPrompt }),
}));
