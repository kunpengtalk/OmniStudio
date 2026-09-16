import { create } from "zustand";

interface PpOcrInstallState {
  /** PaddleOCR 引擎安装/模型下载日志（主进程实时推送）。 */
  logs: string[];
  /** 整批追加（主进程按 80ms 窗口合批推送，见 bun/throttle.ts）。 */
  appendLines: (lines: string[]) => void;
  clearLogs: () => void;
}

const MAX_LOGS = 200;

export const usePpOcrInstallStore = create<PpOcrInstallState>((set) => ({
  logs: [],
  appendLines: (lines) =>
    set((s) => (lines.length === 0 ? s : { logs: [...s.logs, ...lines].slice(-MAX_LOGS) })),
  clearLogs: () => set({ logs: [] }),
}));
