import { create } from "zustand";

type BenchmarkStore = {
  /** 当前（或最近一次）运行中的任务 id，跨页面切换保持轮询上下文。 */
  runId: string | null;
  /** 侧栏选中的历史记录 id；null = 显示最近一次运行结果。 */
  selectedRecordId: number | null;
  setRunId: (runId: string | null) => void;
  setSelectedRecordId: (id: number | null) => void;
};

export const useBenchmarkStore = create<BenchmarkStore>((set) => ({
  runId: null,
  selectedRecordId: null,
  setRunId: (runId) => set({ runId }),
  setSelectedRecordId: (selectedRecordId) => set({ selectedRecordId }),
}));
