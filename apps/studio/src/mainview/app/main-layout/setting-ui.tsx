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
