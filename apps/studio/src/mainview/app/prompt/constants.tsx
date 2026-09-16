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
 * 广场来源筛选 chips（image / video 有题库来源；llm 无）。
 *
 * 带词条键而不是直接把中文写在常量里：来源名（Image2Hub 这类）本身是产品名不进词典，
 * 「全部题库 / 全部来源」要跟着界面语言走。
 */
export const SOURCE_FILTERS: Record<PromptKind, { id: string; label: string; labelKey?: string }[]> = {
  image: [
    { id: "all", label: "全部题库", labelKey: "prompt.source.all" },
    { id: "img2hub", label: "Image2Hub" },
    { id: "awesome", label: "GPT-Image-2" },
  ],
  video: [
    { id: "all", label: "全部来源", labelKey: "prompt.source.allSources" },
    { id: "h3cases", label: "H3 Cases" },
    { id: "atlas", label: "AtlasCloudAI" },
    { id: "xianyu", label: "MiniMax" },
    { id: "flaqai", label: "Template" },
    { id: "god", label: "God" },
  ],
  llm: [],
};

/** 分类简介（没有选中分类时显示的默认说明）：中文写在词条里，英文界面不再显示中文。 */
export const DEFAULT_INTROS: Record<PromptKind, { fallback: string; key: string }> = {
  image: {
    key: "prompt.intro.image",
    fallback:
      "复制即用的图片提示词库：Image2Hub 实拍验证的运营/APP/海报/插画/IP 场景 + awesome-gpt-image-2 高保真案例。",
  },
  llm: {
    key: "prompt.intro.llm",
    fallback:
      "大模型提示词：vibedesign 设计与 Agent 的实战系统提示词 + 面向本地大模型工作台的常用角色提示词。",
  },
  video: {
    key: "prompt.intro.video",
    fallback: "MiniMax H3（海螺 3.0）视频提示词与案例库：完整提示词可直接复制，纯案例供参考成片。",
  },
};

/** 每页条数：与后端默认值同一个常量（见 shared/prompts.ts）。 */
export const PAGE_SIZE = PROMPT_PAGE_SIZE;
