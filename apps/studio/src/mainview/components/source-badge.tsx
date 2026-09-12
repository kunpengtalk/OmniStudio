import { GlobeIcon } from "lucide-react";

import { MODEL_SOURCE_META, type ModelSource } from "../../shared/modelscope";
import { MODEL_TAG_CLASS } from "./model-category-badge";
import { cn } from "@/mainview/lib/utils";

/**
 * 下载来源徽标：把"这个模型 / 这次下载是从哪个平台来的"直接标在界面上。
 * 市场结果行、模型详情、下载任务、本地模型库都用它，保证同一来源到处长得一样。
 */
export function SourceBadge({ source, className }: { source: ModelSource; className?: string }) {
  const meta = MODEL_SOURCE_META[source];
  return (
    <span className={cn(MODEL_TAG_CLASS, className)} title={`${meta.label} · ${meta.host}`}>
      <GlobeIcon className="size-3" />
      {meta.label}
    </span>
  );
}
