import { create } from "zustand";
import type { DownloadTask } from "../../bun/download-manager";

export type DownloadProgress = {
  repo: string;
  fileName: string;
  received: number;
  total: number | null;
  percent: number | null;
};

interface ModelDownloadState {
  downloads: Record<string, DownloadProgress>;
  tasks: DownloadTask[];
  setProgress: (repo: string, fileName: string, progress: {
    received: number;
    total: number | null;
    percent: number | null;
  }) => void;
  setTasks: (tasks: DownloadTask[]) => void;
  reset: (repo: string, fileName: string) => void;
}

function key(repo: string, fileName: string) {
  return `${repo}::${fileName}`;
}

export const useModelDownloadStore = create<ModelDownloadState>((set) => ({
  downloads: {},
  tasks: [],
  setProgress: (repo, fileName, progress) =>
    set((state) => ({
      downloads: {
        ...state.downloads,
        [key(repo, fileName)]: { repo, fileName, ...progress },
      },
    })),
  setTasks: (tasks) => set({ tasks }),
  reset: (repo, fileName) =>
    set((state) => {
      const downloads = { ...state.downloads };
      delete downloads[key(repo, fileName)];
      return { downloads };
    }),
}));