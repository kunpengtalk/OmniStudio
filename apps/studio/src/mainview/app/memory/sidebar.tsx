import { HashIcon, LayersIcon, PinIcon } from "lucide-react";
import { cn } from "@lib/utils";
import { useT } from "@stores/ui-lang";
import { useMemoryUi } from "@stores/memory-ui";
import { MEMORY_CATEGORIES } from "@/shared/memory";
import type { MemoryCategory } from "@/shared/memory";

/** 记忆应用页侧栏：分类过滤（与 MemoryListCard 共享 memory-ui store）。 */
export function MemorySidebar() {
  const t = useT();
  const category = useMemoryUi((s) => s.category);
  const setCategory = useMemoryUi((s) => s.setCategory);

  const items: { key: string; label: string; icon: React.ReactNode }[] = [
    { key: "all", label: t("settings.memory.all"), icon: <LayersIcon className="size-4" /> },
    { key: "pinned", label: t("settings.memory.pinned"), icon: <PinIcon className="size-4" /> },
    ...MEMORY_CATEGORIES.map((c: MemoryCategory) => ({
      key: c,
      label: t(`settings.memory.category.${c}`),
      icon: <HashIcon className="size-4" />,
    })),
  ];

  return (
    <nav className="flex flex-col gap-0.5 px-2 py-2" aria-label="memory categories">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={() => setCategory(item.key)}
          className={cn(
            "flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs transition-colors",
            category === item.key
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {item.icon}
          <span className="truncate">{item.label}</span>
        </button>
      ))}
    </nav>
  );
}
