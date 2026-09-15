import type { ModelCategory } from "@/shared/modelscope";
import { MODEL_CATEGORY_ICONS, MODEL_CATEGORY_SHORT_KEYS } from "@/mainview/components/model-category-badge";
import { useT } from "@/mainview/stores/ui-lang";
import { cn } from "@/mainview/lib/utils";

/** 筛选条上可能出现的一颗分类：分类本身、"全部"，以及云服务商清单里的"失效"。 */
export type CategoryChipValue = ModelCategory | "all" | "stale";

/**
 * 分类筛选颗：图标 + 两个字 + 计数（全名放 title）。
 *
 * 之前这里贴的是完整分类名（"语音合成 TTS"），一行八颗在窄栏里排不下，
 * 结果整条筛选栏出现横向滚动条，右边几类还被截断。短名之后一行放得下，
 * 排不下时由外层的 flex-wrap 换行 —— 换行也比滚动条好找。
 */
export function CategoryChip({
  value,
  active,
  count,
  onClick,
  className,
}: {
  value: CategoryChipValue;
  active: boolean;
  /** 该分类有几条；不知道条数（市场检索、服务商清单）时不传，就不显示计数。 */
  count?: number;
  onClick: () => void;
  className?: string;
}) {
  const t = useT();
  // "全部" / "失效" 是筛选口径，不是模型分类，没有对应图标。
  const Icon = value === "all" || value === "stale" ? null : MODEL_CATEGORY_ICONS[value];
  const short = value === "stale" ? t("cloud.tabStale") : t(MODEL_CATEGORY_SHORT_KEYS[value]);
  const full = value === "stale" ? t("cloud.tabStale") : t(`models.cat.${value}`);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={count === undefined ? full : `${full} · ${count}`}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors",
        value === "stale"
          ? active
            ? "border-destructive bg-destructive/10 text-destructive"
            : "border-border text-destructive/80 hover:border-destructive/50 hover:text-destructive"
          : active
            ? "border-primary bg-primary/10 text-primary"
            : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
        className,
      )}
    >
      {Icon && <Icon className="size-3.5" />}
      {short}
      {count !== undefined && <span className="tabular-nums opacity-60">{count}</span>}
    </button>
  );
}

/** 一排分类筛选颗：顺序由调用方给，计数逐颗取，排不下就换行。 */
export function ModelCategoryChips<T extends CategoryChipValue>({
  values,
  value,
  countOf,
  onChange,
  className,
}: {
  values: readonly T[];
  value: T;
  /** 逐颗取计数；不传则不显示计数。 */
  countOf?: (value: T) => number;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {values.map((v) => (
        <CategoryChip
          key={v}
          value={v}
          active={value === v}
          count={countOf?.(v)}
          onClick={() => onChange(v)}
        />
      ))}
    </div>
  );
}
