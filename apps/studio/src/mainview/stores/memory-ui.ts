import { create } from "zustand";

/** 记忆应用页与侧栏共享的过滤状态。 */
type MemoryUiState = {
  /** "all" | "pinned" | MemoryCategory。 */
  category: string;
  /** "open" | "active" | "pending" | "archived" | "all"。 */
  status: string;
  query: string;
  setCategory: (c: string) => void;
  setStatus: (s: string) => void;
  setQuery: (q: string) => void;
};

export const useMemoryUi = create<MemoryUiState>((set) => ({
  category: "all",
  status: "open",
  query: "",
  setCategory: (category) => set({ category }),
  setStatus: (status) => set({ status }),
  setQuery: (query) => set({ query }),
}));
