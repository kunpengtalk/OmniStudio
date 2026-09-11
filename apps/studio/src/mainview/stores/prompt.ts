import { create } from "zustand";
import type { PromptKind } from "../../bun/prompt-library";

/** 分类筛选值："all" 表示全部分类。 */
export type PromptCatFilter = "all" | string;

interface PromptState {
  /** 三大类：生图 / 大模型 / 视频。 */
  kind: PromptKind;
  setKind: (kind: PromptKind) => void;
  /** 当前所选分类（"all" = 全部）。 */
  category: PromptCatFilter;
  setCategory: (category: PromptCatFilter) => void;
  /** 题库来源筛选（"all" = 全部来源）。 */
  source: string;
  setSource: (source: string) => void;
  /** 搜索关键词（主区域输入框）。 */
  search: string;
  setSearch: (search: string) => void;
}

export const usePromptStore = create<PromptState>((set) => ({
  kind: "image",
  setKind: (kind) => set({ kind, category: "all", source: "all" }),
  category: "all",
  setCategory: (category) => set({ category }),
  source: "all",
  setSource: (source) => set({ source }),
  search: "",
  setSearch: (search) => set({ search }),
}));
