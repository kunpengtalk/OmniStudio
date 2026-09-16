// 分段切换控件（互斥选项）。
//
// 两个变体：
//  - detached（默认）：带内边距的圆角按钮组，原 OCR / Skills 的逐字相同实现。
//  - attached：`flex overflow-hidden rounded-lg border` 的按钮组，原本在
//    benchmark / live-translate / translate / voicecall / image / video / voice 等
//    共 9 处逐字复制，仅"带图标/纯文字"的内边距略有差异，这里按是否出现图标自动选。
import type { ReactNode } from "react";

import { cn } from "@/mainview/lib/utils";

export type SegmentedOption<T extends string> = { value: T; label: string; icon?: ReactNode };

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  variant = "detached",
  disabled,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly SegmentedOption<T>[];
  variant?: "detached" | "attached";
  disabled?: boolean;
  className?: string;
}) {
  // 图标会占一点宽度，带图标时左右内边距收窄，与原实现保持一致。
  const hasIcon = options.some((o) => o.icon);

  return (
    <div
      className={cn(
        variant === "detached"
          ? "flex gap-0.5 rounded-lg border bg-background p-0.5"
          : "flex overflow-hidden rounded-lg border",
        className,
      )}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            "flex flex-1 items-center justify-center text-xs transition-colors",
            variant === "detached"
              ? "gap-1.5 rounded-md px-2 py-1 font-medium"
              : hasIcon
                ? "gap-1.5 px-2 py-1.5"
                : "px-3 py-1.5",
            value === o.value
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {o.icon}
          <span className={variant === "detached" ? "truncate" : undefined}>{o.label}</span>
        </button>
      ))}
    </div>
  );
}
