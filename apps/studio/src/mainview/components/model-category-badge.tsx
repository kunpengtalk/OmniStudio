import {
  AppleIcon,
  ArrowUpDownIcon,
  AudioLinesIcon,
  BoxesIcon,
  FileBoxIcon,
  FileIcon,
  FilmIcon,
  ImageIcon,
  LayersIcon,
  MessageSquareIcon,
  MicIcon,
  TagIcon,
  type LucideIcon,
} from "lucide-react";

import type { ModelCategory, ModelFileKind } from "@/shared/modelscope";
import { cn } from "@/mainview/lib/utils";

/** 能打格式标的所有取值：磁盘上的权重格式 + 市场检索用的 mlx。 */
export type ModelFormatKind = ModelFileKind | "mlx";

/**
 * 模型标签统一样式：分类 / 格式 / 来源 / 目录来源都长这样 —— 中性底色 + 小图标，
 * 靠图标形状和文字区分含义。一行里会并排四五个标签，各配一种颜色就成调色板了，
 * 颜色只留给状态（使用中 / 默认 / 警告 / 失败）。
 */
export const MODEL_TAG_CLASS =
  "inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-muted/60 px-1.5 text-[10px] font-medium text-muted-foreground";

/** 分类 → 图标（分类靠图标区分）。 */
export const MODEL_CATEGORY_ICONS: Record<ModelCategory, LucideIcon> = {
  chat: MessageSquareIcon,
  embedding: BoxesIcon,
  rerank: ArrowUpDownIcon,
  tts: AudioLinesIcon,
  asr: MicIcon,
  image: ImageIcon,
  video: FilmIcon,
  other: TagIcon,
};

/** 权重格式 → 图标。 */
export const MODEL_FORMAT_ICONS: Record<ModelFormatKind, LucideIcon> = {
  gguf: FileBoxIcon,
  safetensors: LayersIcon,
  mlx: AppleIcon,
  other: FileIcon,
};

/** 带图标 + 文字的模型分类标签。 */
export function ModelCategoryBadge({
  category,
  label,
  className,
}: {
  category: ModelCategory;
  /** 已翻译好的分类名（调用方持有 t）；不传则只显示图标。 */
  label?: string;
  className?: string;
}) {
  const Icon = MODEL_CATEGORY_ICONS[category];
  return (
    <span data-model-category={category} title={label} className={cn(MODEL_TAG_CLASS, className)}>
      <Icon className="size-3" />
      {label && <span className="truncate">{label}</span>}
    </span>
  );
}

/** 紧凑版：只有图标（下拉框选项、密集表格行用）。 */
export function ModelCategoryIcon({
  category,
  label,
  className,
}: {
  category: ModelCategory;
  label?: string;
  className?: string;
}) {
  const Icon = MODEL_CATEGORY_ICONS[category];
  return (
    <span
      data-model-category={category}
      title={label}
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground",
        className,
      )}
    >
      <Icon className="size-3.5" />
    </span>
  );
}

/** 权重格式标签（GGUF / safetensors / MLX / 其它）：与分类标签同一套样式。 */
export function ModelFormatBadge({
  kind,
  label,
  className,
}: {
  kind: ModelFormatKind;
  /** 已翻译好的格式名。 */
  label: string;
  className?: string;
}) {
  const Icon = MODEL_FORMAT_ICONS[kind];
  return (
    <span data-model-format={kind} className={cn(MODEL_TAG_CLASS, className)}>
      <Icon className="size-3" />
      <span className="truncate">{label}</span>
    </span>
  );
}
