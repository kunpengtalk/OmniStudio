import { GlobeIcon } from "lucide-react";

import { MODEL_SOURCE_META, type ModelSource } from "../../shared/modelscope";
import { cn } from "@/mainview/lib/utils";

/**
 * 下载来源徽标：把"这个模型 / 这次下载是从哪个平台来的"直接标在界面上。
 * 市场结果行、模型详情、下载任务、本地模型库都用它，保证同一来源到处长得一样。
 */
export function SourceBadge({
  source,
  className,
}: {
  source: ModelSource;
  className?: string;
}) {
  const meta = MODEL_SOURCE_META[source];
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 text-[10px] font-medium",
        meta.badgeClass,
        className,
      )}
      title={`${meta.label} · ${meta.host}`}
    >
      <GlobeIcon className="size-2.5" />
      {meta.label}
    </span>
  );
}
