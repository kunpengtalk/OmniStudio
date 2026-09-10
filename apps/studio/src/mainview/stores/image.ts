import { create } from "zustand";

export type ImageTool = "generate" | "upscale" | "batch";
/** 生图页内部视图：参数生成页 / 全部历史页。 */
export type ImageView = "generate" | "history";

interface ImageState {
  /** 左侧边栏「生图」工具菜单当前选中项（放大/批量暂未开放）。 */
  tool: ImageTool;
  setTool: (tool: ImageTool) => void;
  /** 当前视图；切到工具菜单时自动回到生成页。 */
  view: ImageView;
  setView: (view: ImageView) => void;
  /** 在侧边栏点击某条历史记录时聚焦它。 */
  focusRecordId: number | null;
  setFocusRecordId: (id: number | null) => void;
}

export const useImageStore = create<ImageState>((set) => ({
  tool: "generate",
  setTool: (tool) => set({ tool, view: "generate" }),
  view: "generate",
  setView: (view) => set({ view }),
  focusRecordId: null,
  setFocusRecordId: (id) => set({ focusRecordId: id }),
}));
