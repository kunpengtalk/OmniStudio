import { create } from "zustand";
import type { SkillsInstallProgress, SkillsLeaderboard } from "../../shared/skills";

/** Skills 页六大区。 */
export type SkillsSection = "market" | "my" | "presets" | "projects" | "tools" | "backup";

/** 市场 Tab 的四个子区：skills.sh 市场 / Git 导入 / 本地导入 / 扫描收编。 */
export type SkillsMarketTab = "marketplace" | "git" | "local" | "scan";

interface SkillsState {
  section: SkillsSection;
  setSection: (section: SkillsSection) => void;
  marketTab: SkillsMarketTab;
  setMarketTab: (tab: SkillsMarketTab) => void;
  marketBoard: SkillsLeaderboard;
  setMarketBoard: (board: SkillsLeaderboard) => void;
  /** 安装进度（市场 / Git / 更新），按 ref keyed。 */
  progress: Record<string, SkillsInstallProgress>;
  setProgress: (p: SkillsInstallProgress) => void;
  clearProgress: (ref: string) => void;
}

export const useSkillsStore = create<SkillsState>((set) => ({
  section: "market",
  setSection: (section) => set({ section }),
  marketTab: "marketplace",
  setMarketTab: (marketTab) => set({ marketTab }),
  marketBoard: "alltime",
  setMarketBoard: (marketBoard) => set({ marketBoard }),
  progress: {},
  setProgress: (p) =>
    set((s) => {
      const progress = { ...s.progress, [p.ref]: p };
      // 终态 30 秒后自动清理，避免列表越来越长。
      if (p.phase === "done" || p.phase === "error" || p.phase === "canceled") {
        setTimeout(() => useSkillsStore.getState().clearProgress(p.ref), 30_000);
      }
      return { progress };
    }),
  clearProgress: (ref) =>
    set((s) => {
      if (!(ref in s.progress)) return s;
      const progress = { ...s.progress };
      delete progress[ref];
      return { progress };
    }),
}));
