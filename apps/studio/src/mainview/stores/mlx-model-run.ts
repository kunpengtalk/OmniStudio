import { create } from "zustand";
import type { MlxGenPhase } from "../../bun/mlx-gen";

interface MlxModelRunState {
  /** 常驻 worker 最近一次推来的阶段（启动/加载/生成 n/N/完成）。 */
  phase: MlxGenPhase | null;
  setPhase: (p: MlxGenPhase) => void;
  reset: () => void;
}

export const useMlxModelRunStore = create<MlxModelRunState>((set) => ({
  phase: null,
  setPhase: (p) => set({ phase: p }),
  reset: () => set({ phase: null }),
}));
