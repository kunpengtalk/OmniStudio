import { CpuIcon, SparklesIcon } from "lucide-react";

import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";

/** 时间戳：同一年只写 月/日 时:分，跨年才补年份（会话列表里的读法一致）。 */
export function formatMessageTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.getFullYear() === new Date().getFullYear()
    ? `${d.getMonth() + 1}/${d.getDate()} ${clock}`
    : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${clock}`;
}

/**
 * 助手消息的头部：头像 + 名称 + 这条用的模型 + 时间。
 *
 * 模型标签是这里的关键：一部会话里可能换过模型（本地 / 云端、不同尺寸的模型），
 * 而"这条回答是谁生成的"直接影响用户怎么读它 —— 只有头部能说清楚。
 */
export function AssistantHeader({
  model,
  createdAt,
  className,
}: {
  model?: string;
  createdAt?: number;
  className?: string;
}) {
  const t = useT();
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <SparklesIcon className="size-3.5" />
      </span>
      <span className="shrink-0 text-xs font-semibold">{t("chat.assistantName")}</span>
      {model && (
        <span className="inline-flex min-w-0 items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground">
          <CpuIcon className="size-2.5 shrink-0" />
          <span className="truncate">{model}</span>
        </span>
      )}
      {createdAt != null && (
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
          {formatMessageTime(createdAt)}
        </span>
      )}
    </div>
  );
}
