import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BrainIcon, PlusIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { useT } from "@stores/ui-lang";
import { useMemoryUi } from "@stores/memory-ui";
import { SettingsSection, SettingRow } from "@components/setting-ui";
import { MEMORY_CATEGORIES, type MemoryCategory, type MemoryEntry, type MemoryStatus } from "@/shared/memory";
import { CATEGORY_KEY, STATUS_KEY } from "./constants";
import { MemoryDialog, MemoryRow } from "./entry";

export function MemoryListCard() {
  const t = useT();
  const query = useMemoryUi((s) => s.query);
  const setQuery = useMemoryUi((s) => s.setQuery);
  const category = useMemoryUi((s) => s.category);
  const setCategory = useMemoryUi((s) => s.setCategory);
  const status = useMemoryUi((s) => s.status);
  const setStatus = useMemoryUi((s) => s.setStatus);
  const [editing, setEditing] = useState<MemoryEntry | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  // 输入防抖：命中路径是排序检索（RPC memoryList），每次按键都发一遍会把
  // 本地模型/检索压满（同提示词 300ms、技能市场 450ms）。
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const { data } = useQuery({
    queryKey: ["memories", debouncedQuery, category, status],
    queryFn: () =>
      rpcClient.memoryList({
        query: debouncedQuery || undefined,
        category: category === "all" || category === "pinned" ? undefined : (category as MemoryCategory),
        status: status as MemoryStatus | "open" | "all",
        pinned: category === "pinned" || undefined,
      }),
  });
  const memories = data?.memories ?? [];

  return (
    <>
      <SettingsSection
        title={t("settings.memory.listTitle")}
        description={t("settings.memory.listDesc")}
        actions={
          <div className="flex items-center gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("settings.memory.searchPh")}
              className="h-7 w-40 text-xs"
            />
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="h-7 w-24 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("settings.memory.all")}</SelectItem>
                <SelectItem value="pinned">{t("settings.memory.pinned")}</SelectItem>
                {MEMORY_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {t(CATEGORY_KEY(c))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="h-7 w-24 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">{t("settings.memory.statusFilter.open")}</SelectItem>
                <SelectItem value="active">{t(STATUS_KEY("active"))}</SelectItem>
                <SelectItem value="pending">{t(STATUS_KEY("pending"))}</SelectItem>
                <SelectItem value="archived">{t(STATUS_KEY("archived"))}</SelectItem>
                <SelectItem value="all">{t("settings.memory.statusFilter.all")}</SelectItem>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <PlusIcon data-icon="inline-start" />
              {t("settings.memory.add")}
            </Button>
          </div>
        }
      >
        {memories.length === 0 ? (
          <SettingRow title={t("settings.memory.empty")} description={t("settings.memory.emptyHint")}>
            <BrainIcon className="size-4 text-muted-foreground" />
          </SettingRow>
        ) : (
          memories.map((m) => (
            <MemoryRow
              key={m.id}
              memory={m}
              onEdit={(mem) => {
                setEditing(mem);
                setDialogOpen(true);
              }}
            />
          ))
        )}
      </SettingsSection>

      <MemoryDialog open={dialogOpen} initial={editing} onClose={() => setDialogOpen(false)} />
    </>
  );
}

