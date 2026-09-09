import { create } from "zustand";

interface MlxInstallState {
  /** mflux 引擎安装日志（主进程实时推送）。 */
  logs: string[];
  appendLog: (text: string) => void;
  clearLogs: () => void;
}

const MAX_LOGS = 200;

export const useMlxInstallStore = create<MlxInstallState>((set) => ({
  logs: [],
  appendLog: (text) =>
    set((s) => ({ logs: [...s.logs.slice(-MAX_LOGS + 1), text] })),
  clearLogs: () => set({ logs: [] }),
}));
