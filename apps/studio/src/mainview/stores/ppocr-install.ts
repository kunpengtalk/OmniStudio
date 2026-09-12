import { create } from "zustand";

interface PpOcrInstallState {
  /** PaddleOCR 引擎安装/模型下载日志（主进程实时推送）。 */
  logs: string[];
  appendLog: (text: string) => void;
  clearLogs: () => void;
}

const MAX_LOGS = 200;

export const usePpOcrInstallStore = create<PpOcrInstallState>((set) => ({
  logs: [],
  appendLog: (text) => set((s) => ({ logs: [...s.logs.slice(-MAX_LOGS + 1), text] })),
  clearLogs: () => set({ logs: [] }),
}));
