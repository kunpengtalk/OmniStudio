import { create } from "zustand";

export type PpOcrDownloadProgress = {
  received: number;
  total: number | null;
  percent: number | null;
  speed: number;
};

interface PpOcrDownloadState {
  /** 每个模型文件（如 PP-OCRv6_medium_det）的实时下载进度。 */
  progress: Record<string, PpOcrDownloadProgress>;
  /** 是否正在下载（percent 在 0–99 之间）。percent=null（已取消/中断）或 100 时清为 false。 */
  downloading: Record<string, boolean>;
  setProgress: (model: string, progress: PpOcrDownloadProgress) => void;
  clear: (model: string) => void;
  reset: () => void;
}

export const usePpOcrDownloadStore = create<PpOcrDownloadState>((set) => ({
  progress: {},
  downloading: {},
  setProgress: (model, progress) =>
    set((s) => ({
      progress: { ...s.progress, [model]: progress },
      downloading: {
        ...s.downloading,
        [model]: progress.percent !== null && progress.percent < 100,
      },
    })),
  clear: (model) =>
    set((s) => {
      const next = { ...s.progress };
      const nd = { ...s.downloading };
      delete next[model];
      delete nd[model];
      return { progress: next, downloading: nd };
    }),
  reset: () => set({ progress: {}, downloading: {} }),
}));
