import { create } from "zustand";

export type ImageTool = "generate" | "upscale" | "batch";

interface ImageState {
  /** 左侧边栏「生图」工具菜单当前选中项（放大/批量暂未开放）。 */
  tool: ImageTool;
  setTool: (tool: ImageTool) => void;
  /** 在侧边栏点击某条历史记录时聚焦它。 */
  focusRecordId: number | null;
  setFocusRecordId: (id: number | null) => void;
}

export const useImageStore = create<ImageState>((set) => ({
  tool: "generate",
  setTool: (tool) => set({ tool }),
  focusRecordId: null,
  setFocusRecordId: (id) => set({ focusRecordId: id }),
}));
