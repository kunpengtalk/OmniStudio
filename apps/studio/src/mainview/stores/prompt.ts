import { create } from "zustand";
import type { PromptKind } from "../../bun/prompt-library";
import type { UserPromptView } from "../../bun/user-prompt";

/** 分类筛选值："all" 表示全部分类。 */
export type PromptCatFilter = "all" | string;

/** 提示词页两大区：广场（内置精选） / 我的（用户自建+导入）。 */
export type PromptTab = "plaza" | "mine";

/** 新建/编辑弹窗：由侧边栏或卡片触发，主区域统一渲染。 */
export type PromptEditor = { mode: "create"; kind?: PromptKind } | { mode: "edit"; item: UserPromptView } | null;

interface PromptState {
  /** 当前大区：广场 / 我的。 */
  tab: PromptTab;
  setTab: (tab: PromptTab) => void;
  /** 三大类：生图 / 大模型 / 视频。 */
  kind: PromptKind;
  setKind: (kind: PromptKind) => void;
  /** 当前所选分类（"all" = 全部）。 */
  category: PromptCatFilter;
  setCategory: (category: PromptCatFilter) => void;
  /** 题库来源筛选（"all" = 全部来源，仅广场用）。 */
  source: string;
  setSource: (source: string) => void;
  /** 搜索关键词（主区域输入框）。 */
  search: string;
  setSearch: (search: string) => void;
  /** 新建/编辑弹窗状态。 */
  editor: PromptEditor;
  openCreate: (kind?: PromptKind) => void;
  openEdit: (item: UserPromptView) => void;
  closeEditor: () => void;
}

export const usePromptStore = create<PromptState>((set) => ({
  tab: "plaza",
  setTab: (tab) => set({ tab, category: "all", source: "all", search: "" }),
  kind: "image",
  setKind: (kind) => set({ kind, category: "all", source: "all" }),
  category: "all",
  setCategory: (category) => set({ category }),
  source: "all",
  setSource: (source) => set({ source }),
  search: "",
  setSearch: (search) => set({ search }),
  editor: null,
  openCreate: (kind) => set({ editor: { mode: "create", kind } }),
  openEdit: (item) => set({ editor: { mode: "edit", item } }),
  closeEditor: () => set({ editor: null }),
}));
