import { create } from "zustand";

import type { EngineInstallEvent } from "../../bun/engine-install";

/**
 * 推理引擎一键安装的实时状态：日志（主进程 80ms 合批推来）与当前阶段。
 *
 * 阶段与日志分开存：日志只进"安装详情"面板，阶段是每一行引擎条目都要读的
 * （哪一行在装、装到哪一步了）。安装结束（done / failed）后阶段会留在 store 里
 * 由界面自行判定终态，下一次安装直接覆盖。
 */
interface EngineInstallState {
  logs: string[];
  /** 当前（或最近一次）安装事件；engine 决定这些状态显示在哪一行上。 */
  phase: EngineInstallEvent | null;
  appendLines: (lines: string[]) => void;
  setPhase: (event: EngineInstallEvent) => void;
  /** 用户手动清空（例如失败后收起面板）。 */
  clear: () => void;
}

const MAX_LOGS = 300;

export const useEngineInstallStore = create<EngineInstallState>((set) => ({
  logs: [],
  phase: null,
  appendLines: (lines) =>
    set((s) => (lines.length === 0 ? s : { logs: [...s.logs, ...lines].slice(-MAX_LOGS) })),
  setPhase: (event) => set({ phase: event }),
  clear: () => set({ logs: [], phase: null }),
}));

/** 某个引擎正在安装（阶段不是终态）。 */
export function isEngineInstallRunning(
  phase: EngineInstallEvent | null,
  engine: string,
): boolean {
  if (!phase || phase.engine !== engine) return false;
  return phase.phase !== "done" && phase.phase !== "failed";
}

/** 安装阶段的界面文案（终态由调用方按 ok/失败分别处理）。 */
export const ENGINE_PHASE_LABEL: Record<EngineInstallEvent["phase"], string> = {
  preparing: "准备中…",
  downloading: "下载中…",
  extracting: "解包中…",
  installing: "安装中…",
  verifying: "验证中…",
  done: "已安装",
  failed: "安装失败",
};
