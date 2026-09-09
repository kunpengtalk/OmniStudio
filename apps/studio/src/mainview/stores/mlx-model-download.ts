import { create } from "zustand";
import type { MlxModelDownloadProgress } from "../../bun/mlx-gen";

interface MlxModelDownloadState {
  /** 最近一次主进程推送的下载进度（stage 为 downloading/done/error）。 */
  progress: MlxModelDownloadProgress | null;
  setProgress: (p: MlxModelDownloadProgress) => void;
  reset: () => void;
}

export const useMlxModelDownloadStore = create<MlxModelDownloadState>((set) => ({
  progress: null,
  setProgress: (p) => set({ progress: p }),
  reset: () => set({ progress: null }),
}));
