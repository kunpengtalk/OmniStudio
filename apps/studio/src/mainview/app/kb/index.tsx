import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  FileTextIcon,
  LayersIcon,
  LibraryIcon,
  Loader2Icon,
  PlusIcon,
  SearchIcon,
  SparklesIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { useKbStore, type KbTab } from "@stores/kb";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import { StatCard } from "@components/stat-card";
import type { KbView } from "@/bun/knowledge";
import { KbDocsTab } from "./docs-tab";
import { KbRecallTab } from "./recall-tab";
import { KbSettingsTab } from "./settings-tab";
import { KbGovernanceTab } from "./governance-tab";
import { KbAccessTab } from "./access-tab";
// 新建弹窗已拆到 ./create-dialog；这里再导出，保持侧栏与测试的导入路径不变。
import { KbCreateDialog } from "./create-dialog";
export { KbCreateDialog };

/** 知识库列表（侧栏 / 主页 / 聊天选择器共用）。 */
export function useKbListQuery() {
  return useQuery({ queryKey: ["kb-list"], queryFn: () => rpcClient.kbList(undefined) });
}

const TABS: { key: KbTab; labelKey: string }[] = [
  { key: "docs", labelKey: "kb.tab.docs" },
  { key: "recall", labelKey: "kb.tab.recall" },
  { key: "settings", labelKey: "kb.tab.settings" },
  { key: "governance", labelKey: "kb.tab.governance" },
  { key: "access", labelKey: "kb.tab.access" },
];

/** 库详情头部：名称/描述 + 四格统计带 + 标签栏。 */
function KbHeader({ kb }: { kb: KbView }) {
  const t = useT();
  const setTab = useKbStore((s) => s.setTab);
  const tab = useKbStore((s) => s.tab);

  const vectorPct =
    kb.chunkCount > 0 ? Math.round((kb.embeddedCount / kb.chunkCount) * 100) : kb.embeddingModel ? 0 : 100;

  return (
    <div className="flex shrink-0 flex-col gap-3 border-b px-6 pb-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <LibraryIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold leading-tight">{kb.name}</h1>
          {kb.description && (
            <p className="truncate text-[11px] leading-tight text-muted-foreground">{kb.description}</p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <StatCard
          variant="rowCompact"
          icon={<FileTextIcon className="size-4" />}
          value={String(kb.docCount)}
          label={t("kb.stats.docs")}
        />
        <StatCard
          variant="rowCompact"
          icon={<LayersIcon className="size-4" />}
          value={String(kb.chunkCount)}
          label={t("kb.stats.chunks")}
        />
        <StatCard
          variant="rowCompact"
          icon={<SparklesIcon className="size-4" />}
          value={kb.embeddingModel ? `${kb.embeddedCount}/${kb.chunkCount}` : "—"}
          label={t("kb.stats.vectors")}
          caption={kb.embeddingModel ? `${vectorPct}%` : undefined}
        />
        <StatCard
          variant="rowCompact"
          icon={<SearchIcon className="size-4" />}
          value={kb.embeddingModel ? t("kb.stats.mixed") : t("kb.stats.keyword")}
          label={t("kb.stats.retrieval")}
          caption={t("kb.stats.topKCaption", { count: String(kb.topK) })}
        />
      </div>

      <div className="flex w-fit items-center gap-0.5 rounded-lg bg-muted/60 p-0.5">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            className={cn(
              "rounded-md px-3 py-1 text-xs transition-colors",
              tab === item.key
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t(item.labelKey)}
          </button>
        ))}
      </div>
    </div>
  );
}

export function KbScreen() {
  const t = useT();
  const selectedKbId = useKbStore((s) => s.selectedKbId);
  const setSelectedKbId = useKbStore((s) => s.setSelectedKbId);
  const tab = useKbStore((s) => s.tab);
  const listQuery = useKbListQuery();

  const kbs = listQuery.data?.kbs ?? [];
  const selected: KbView | null = kbs.find((k) => k.id === selectedKbId) ?? null;

  // 选中项被删除后回落到第一个
  useEffect(() => {
    if (listQuery.isSuccess && !selected && kbs.length > 0) {
      setSelectedKbId(kbs[0]!.id);
    }
  }, [listQuery.isSuccess, selected, kbs, setSelectedKbId]);

  if (listQuery.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (kbs.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <LibraryIcon className="size-7" />
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">{t("kb.empty.title")}</p>
          <p className="max-w-sm text-xs leading-5 text-muted-foreground">{t("kb.empty.hint")}</p>
        </div>
        <Button size="sm" className="gap-1.5" onClick={() => useKbStore.getState().setCreateOpen(true)}>
          <PlusIcon className="size-3.5" />
          {t("kb.create.submit")}
        </Button>
        <KbCreateDialog />
      </div>
    );
  }

  if (!selected) return null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <KbHeader kb={selected} />
      <div className="flex min-h-0 flex-1 flex-col">
        {tab === "docs" && <KbDocsTab kb={selected} />}
        {tab === "recall" && <KbRecallTab kb={selected} />}
        {tab === "settings" && <KbSettingsTab kb={selected} />}
        {tab === "governance" && <KbGovernanceTab kb={selected} />}
        {tab === "access" && <KbAccessTab kb={selected} />}
      </div>
      <KbCreateDialog />
    </div>
  );
}
