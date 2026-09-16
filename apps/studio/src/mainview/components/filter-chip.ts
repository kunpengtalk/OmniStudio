// 筛选 chip 的统一样式（提示词广场 / Skills 多处使用）。
// 原本两处各写一份逐字相同的类串，注释还互相点名。
import { cn } from "@/mainview/lib/utils";

export function chipClass(active: boolean): string {
  return cn(
    "shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
    active
      ? "bg-primary text-primary-foreground"
      : "border text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground",
  );
}
