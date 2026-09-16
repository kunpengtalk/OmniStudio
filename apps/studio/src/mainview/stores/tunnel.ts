import { create } from "zustand";
import type { TunnelInfo } from "../../bun/tunnel";

interface TunnelState {
  /** 隧道状态快照（主进程推送，含公网地址与失败原因）。 */
  info: TunnelInfo | null;
  setInfo: (info: TunnelInfo) => void;
  /** cloudflared 安装日志（主进程实时推送）。 */
  logs: string[];
  /** 整批追加（主进程按 80ms 窗口合批推送，见 bun/throttle.ts）。 */
  appendLines: (lines: string[]) => void;
  clearLogs: () => void;
}

const MAX_LOGS = 200;

export const useTunnelStore = create<TunnelState>((set) => ({
  info: null,
  setInfo: (info) => set({ info }),
  logs: [],
  appendLines: (lines) =>
    set((s) => (lines.length === 0 ? s : { logs: [...s.logs, ...lines].slice(-MAX_LOGS) })),
  clearLogs: () => set({ logs: [] }),
}));
