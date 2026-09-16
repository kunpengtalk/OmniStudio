import type { ReactNode } from "react";

import { cn } from "@/mainview/lib/utils";

/**
 * 统计小卡。原来在记忆概览 / 知识库详情 / 概览页 / 知识库治理页各写一份，
 * 布局、字号、底色都略有差异 —— 这里用 `variant` 把四种外观固化成同一实现，
 * 逐字保留各自的类串，避免"统一卡片"顺带改了观感。
 *
 *  - row：图标胶囊 + 大号数值（记忆概览）
 *  - rowCompact：图标胶囊 + 紧凑数值，可在标签后追加 caption（知识库详情）
 *  - stack：图标在标签行的竖排大卡（概览页）
 *  - stackCompact：无图标、muted 底色的竖排小卡（知识库治理）
 */
export function StatCard({
  label,
  value,
  icon,
  caption,
  hint,
  variant = "row",
  className,
}: {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  /** 追加在标签后的补充值（如 kb 的百分比 / topK）。 */
  caption?: string;
  /** 数值下方的一行说明（如 dashboard 的 hint）。 */
  hint?: string;
  variant?: "row" | "rowCompact" | "stack" | "stackCompact";
  className?: string;
}) {
  if (variant === "stack" || variant === "stackCompact") {
    const compact = variant === "stackCompact";
    return (
      <div
        className={cn(
          compact
            ? "flex flex-col gap-0.5 rounded-lg border bg-muted/30 px-2.5 py-1.5"
            : "rounded-xl border bg-card p-4",
          className,
        )}
      >
        {!compact && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {icon}
            {label}
          </div>
        )}
        <span
          className={cn(
            "font-semibold tabular-nums",
            compact ? "text-sm leading-tight" : "mt-1.5 text-2xl tracking-tight",
          )}
        >
          {value}
        </span>
        {compact && <span className="text-[10px] leading-tight text-muted-foreground">{label}</span>}
        {!compact && hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
      </div>
    );
  }

  const compact = variant === "rowCompact";
  return (
    <div
      className={cn(
        compact
          ? "flex min-w-0 flex-1 items-center gap-2.5 rounded-xl border bg-card px-3 py-2"
          : "flex items-center gap-3 rounded-xl border bg-card px-4 py-3",
        className,
      )}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0">
        <span
          className={cn(
            "block truncate font-semibold tabular-nums leading-tight",
            compact ? "text-sm" : "text-lg",
          )}
        >
          {value}
        </span>
        <span
          className={cn(
            "block truncate leading-tight text-muted-foreground",
            compact ? "text-[10px]" : "text-[11px]",
          )}
        >
          {label}
          {caption ? ` · ${caption}` : ""}
        </span>
      </span>
    </div>
  );
}
