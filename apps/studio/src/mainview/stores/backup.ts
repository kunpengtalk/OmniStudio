import { create } from "zustand";
import type { BackupFinishedEvent, BackupProgress } from "../../shared/backup";

/**
 * 全局备份 / 恢复的进行态与最近一次结果。
 *
 * 进度来自主进程的 `backupProgress` 事件（已在主进程按 120ms 节流），
 * 终态来自 `backupFinished`；页面切走再回来仍能看到正在跑的任务。
 */
interface BackupState {
  progress: BackupProgress | null;
  /** 最近一次任务的终态，直到用户开始新任务或手动清掉。 */
  last: BackupFinishedEvent | null;
  /** 目标目录校验失败等界面级提示。 */
  notice: string | null;
  setProgress: (p: BackupProgress) => void;
  setFinished: (e: BackupFinishedEvent) => void;
  setNotice: (notice: string | null) => void;
  clearFinished: () => void;
}

export const useBackupStore = create<BackupState>((set) => ({
  progress: null,
  last: null,
  notice: null,
  setProgress: (progress) => set({ progress }),
  setFinished: (last) => set({ last, progress: null }),
  setNotice: (notice) => set({ notice }),
  clearFinished: () => set({ last: null, notice: null }),
}));

/** 备份任务是否正在进行（按钮禁用 / 显示进度条）。 */
export function isBackupRunning(progress: BackupProgress | null): boolean {
  return !!progress && progress.phase !== "done" && progress.phase !== "error";
}
