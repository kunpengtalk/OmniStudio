import { SparklesIcon } from "lucide-react";

import { Badge } from "@ui/badge";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import type { MediaSource } from "../../bun/db/schema";

/**
 * 素材来源徽标 / 筛选：区分「用户在界面里手工生成的」和「Agent 生成的」。
 *
 * 手工生成是常态，所以徽标只在 `agent` 时出现（不给每张图都挂标签造成视觉噪音）；
 * 需要专门看某一类时用 `MediaSourceFilter` 过滤。
 *
 * `iconOnly` 给窄列表行用：侧栏一行只有两百来像素，"Agent 生成"五个字能把模型名挤没，
 * 只留那颗火花图标（判读靠 `title`），来源照样看得出来。
 */
export function MediaSourceBadge({
  source,
  className,
  iconOnly,
}: {
  source: MediaSource;
  className?: string;
  iconOnly?: boolean;
}) {
  const t = useT();
  if (source !== "agent") return null;
  return (
    <Badge
      variant="outline"
      title={t("media.source.agentHint")}
      className={cn(
        "h-4 shrink-0 gap-0.5 px-1 text-[9px] font-normal text-muted-foreground",
        className,
      )}
    >
      <SparklesIcon className="size-2.5" />
      {!iconOnly && t("media.source.agent")}
    </Badge>
  );
}

const FILTER_OPTIONS: (MediaSource | "all")[] = ["all", "manual", "agent"];

/** 来源筛选：全部 / 我生成 / Agent 生成。 */
export function MediaSourceFilter({
  value,
  onChange,
  className,
}: {
  value: MediaSource | "all";
  onChange: (next: MediaSource | "all") => void;
  className?: string;
}) {
  const t = useT();
  return (
    <div
      role="group"
      aria-label={t("media.source.filter")}
      className={cn("flex items-center gap-1", className)}
    >
      {FILTER_OPTIONS.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={cn(
            "rounded-full border px-2 py-0.5 text-[10px] transition-colors",
            value === option
              ? "border-primary bg-primary/10 text-primary"
              : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
          )}
        >
          {t(`media.source.${option}`)}
        </button>
      ))}
    </div>
  );
}
