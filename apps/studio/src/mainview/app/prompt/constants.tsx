import { ImageIcon, FilmIcon, BotIcon } from "lucide-react";
import { PROMPT_PAGE_SIZE } from "../../../shared/prompts";
import type { PromptKind } from "../../../bun/prompt-library";

// ---------------------------------------------------------------------------

export const KINDS: { kind: PromptKind; icon: React.ReactNode; labelKey: string }[] = [
  { kind: "image", icon: <ImageIcon className="size-4" />, labelKey: "prompt.kind.image" },
  { kind: "llm", icon: <BotIcon className="size-4" />, labelKey: "prompt.kind.llm" },
  { kind: "video", icon: <FilmIcon className="size-4" />, labelKey: "prompt.kind.video" },
];

/**
 * 广场来源筛选 chips（内置第三方题库移除后只剩「全部」；将来接**已确认许可**的
 * 服务端题库时在这里把来源加回来）。「全部」跟着界面语言走，用词条键。
 */
export const SOURCE_FILTERS: Record<PromptKind, { id: string; label: string; labelKey?: string }[]> = {
  image: [{ id: "all", label: "全部题库", labelKey: "prompt.source.all" }],
  video: [{ id: "all", label: "全部来源", labelKey: "prompt.source.allSources" }],
  llm: [],
};

/** 分类简介（没有选中分类时显示的默认说明）：中文写在词条里，英文界面不再显示中文。 */
export const DEFAULT_INTROS: Record<PromptKind, { fallback: string; key: string }> = {
  image: {
    key: "prompt.intro.image",
    fallback: "复制即用的图片提示词库：运营 / APP / 海报 / 插画 / IP 场景，支持自建分类与全文搜索。",
  },
  llm: {
    key: "prompt.intro.llm",
    fallback: "面向本地大模型工作台的常用角色提示词，支持自建分类与全文搜索。",
  },
  video: {
    key: "prompt.intro.video",
    fallback: "视频提示词库：完整提示词可直接复制，支持自建分类与全文搜索。",
  },
};

/** 每页条数：与后端默认值同一个常量（见 shared/prompts.ts）。 */
export const PAGE_SIZE = PROMPT_PAGE_SIZE;
