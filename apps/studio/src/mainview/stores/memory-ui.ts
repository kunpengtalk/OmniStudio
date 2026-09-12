import { create } from "zustand";

/** 记忆应用页与侧栏共享的过滤状态。 */
type MemoryUiState = {
  /** "all" | "pinned" | MemoryCategory。 */
  category: string;
  query: string;
  setCategory: (c: string) => void;
  setQuery: (q: string) => void;
};

export const useMemoryUi = create<MemoryUiState>((set) => ({
  category: "all",
  query: "",
  setCategory: (category) => set({ category }),
  setQuery: (query) => set({ query }),
}));
