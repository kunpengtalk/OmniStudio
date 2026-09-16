import type { ReactNode } from "react";

import { cn } from "@lib/utils";

/**
 * 设置页统一的排版组件（参照主流客户端的行式卡片）：
 * - SettingsSection：一张卡片，可带标题与说明；
 * - SettingRow：卡片内的一行，左边标题 + 说明，右边控件。
 */

export function SettingsSection({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-xl border bg-card", className)}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            {title && <h3 className="text-sm font-medium">{title}</h3>}
            {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function SettingRow({
  title,
  description,
  children,
  stacked,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** 控件较宽（输入框 / 下拉）时用上下堆叠。 */
  stacked?: boolean;
  children: ReactNode;
  className?: string;
}) {
  if (stacked) {
    return (
      <div className={cn("flex flex-col gap-2 border-b px-4 py-3 last:border-b-0", className)}>
        <div className="text-sm font-medium">{title}</div>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
        {children}
      </div>
    );
  }
  return (
    <div className={cn("flex items-center justify-between gap-4 border-b px-4 py-3 last:border-b-0", className)}>
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

export function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-5">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
    </div>
  );
}

/**
 * 一级页面的内容宽度。设置页的每个标签页都走 `PageShell`，宽度只在这里改 ——
 * 各页各写一个 `max-w-*` 会让概览 / 使用统计 / 本地模型 / 默认模型左右边缘互相对不齐，
 * 切标签页时整块内容还会横向跳动。
 */
export const PAGE_WIDTH = "max-w-5xl";

/**
 * 一级页面的内容容器：居中 + 统一宽度与内边距 + 纵向间距。
 * 页面自身的差异（`gap-3`、`h-full` 等）通过 `className` 覆盖默认值。
 */
export function PageShell({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="page-shell"
      className={cn("mx-auto flex w-full flex-col gap-5 px-6 py-6", PAGE_WIDTH, className)}
    >
      {children}
    </div>
  );
}
