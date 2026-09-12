import { create } from "zustand";

export type KbTab = "docs" | "recall" | "settings" | "governance" | "access";

type KbState = {
  selectedKbId: number | null;
  /** 新建知识库弹窗（侧栏与空状态共用）。 */
  createOpen: boolean;
  tab: KbTab;
  setSelectedKbId: (id: number | null) => void;
  setCreateOpen: (open: boolean) => void;
  setTab: (tab: KbTab) => void;
};

export const useKbStore = create<KbState>((set) => ({
  selectedKbId: null,
  createOpen: false,
  tab: "docs",
  setSelectedKbId: (selectedKbId) => set({ selectedKbId, tab: "docs" }),
  setCreateOpen: (createOpen) => set({ createOpen }),
  setTab: (tab) => set({ tab }),
}));
