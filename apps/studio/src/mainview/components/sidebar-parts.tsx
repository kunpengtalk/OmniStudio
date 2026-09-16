import type { ReactNode } from "react";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";

/**
 * 侧栏顶部的工具切换按钮组（生图 / OCR / 语音 / 翻译 / 视频共用一套外观）。
 * 各页原本各写一份、类串逐字相同，这里用 items + columns 吸收列数差异，
 * `soon` 表示未开放（保持原位但不可点、置灰并给出提示）。
 */
export interface ToolSwitcherItem<K extends string> {
  key: K;
  icon: ReactNode;
  labelKey: string;
  soon?: boolean;
  /** `soon` 时的悬浮提示（各页文案不同，由调用方给）。 */
  soonTitle?: string;
}

export function ToolSwitcher<K extends string>({
  items,
  active,
  onSelect,
  columns = 2,
  className,
}: {
  items: ToolSwitcherItem<K>[];
  active: K;
  onSelect: (key: K) => void;
  columns?: 2 | 3;
  className?: string;
}) {
  const t = useT();
  return (
    <div
      className={cn(
        "grid gap-1 px-1 pb-1",
        columns === 3 ? "grid-cols-3" : "grid-cols-2",
        className,
      )}
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          disabled={item.soon}
          title={item.soon ? item.soonTitle : undefined}
          onClick={() => onSelect(item.key)}
          className={cn(
            "flex flex-col items-center gap-1 rounded-lg px-1 py-2 text-[11px] transition-colors",
            item.soon && "cursor-not-allowed opacity-45",
            !item.soon && active === item.key
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {item.icon}
          <span className="leading-none">{t(item.labelKey)}</span>
        </button>
      ))}
    </div>
  );
}

/** 单工具页的侧栏顶部入口（与多工具页的入口按钮组同款位置与选中样式）。 */
export function SingleToolEntry({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="mx-1 mb-1 flex items-center gap-2 rounded-lg bg-primary/10 px-3 py-2 text-xs font-medium text-primary">
      {icon}
      <span className="leading-none">{label}</span>
    </div>
  );
}
