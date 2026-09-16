import { useQuery } from "@tanstack/react-query";
import { ArchiveIcon, BrainIcon, GlobeIcon, HistoryIcon, LayersIcon, PinIcon, ShieldAlertIcon, SparklesIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { useT } from "@stores/ui-lang";
import { StatCard } from "@components/stat-card";
import { MemoryEnableCard, MemoryMaintenanceCard, MemoryPendingCard, MemorySyncCard } from "./cards";
import { MemoryListCard } from "./list-card";
import { MemoryApiCard } from "./api-card";

export function MemoryScreen() {
  const t = useT();
  // 统计在服务端算（含检索命中率、合并/拦截次数、向量化进度），界面不再拉全库。
  const { data } = useQuery({
    queryKey: ["memory-stats"],
    queryFn: () => rpcClient.memoryStats(undefined),
  });
  const stats = data?.stats;
  const hitRate =
    stats && stats.searches > 0 ? `${Math.round((stats.hitSearches / stats.searches) * 100)}%` : "—";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-6 pt-2 pb-2">
        <h1 className="text-base font-semibold tracking-tight">{t("memory.screen.title")}</h1>
        <p className="truncate text-xs text-muted-foreground">{t("memory.screen.desc")}</p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label={t("memory.stats.total")} value={stats?.total ?? 0} icon={<BrainIcon className="size-4" />} />
            <StatCard label={t("memory.stats.pinned")} value={stats?.pinned ?? 0} icon={<PinIcon className="size-4" />} />
            <StatCard
              label={t("memory.stats.fromAgents")}
              value={stats?.agentWritten ?? 0}
              icon={<SparklesIcon className="size-4" />}
            />
            <StatCard
              label={t("memory.stats.recent")}
              value={stats?.updatedLast7d ?? 0}
              icon={<GlobeIcon className="size-4" />}
            />
            <StatCard
              label={t("memory.stats.hitRate")}
              value={hitRate}
              icon={<HistoryIcon className="size-4" />}
            />
            <StatCard
              label={t("memory.stats.merges")}
              value={stats?.merges ?? 0}
              icon={<LayersIcon className="size-4" />}
            />
            <StatCard
              label={t("memory.stats.archived")}
              value={stats?.archivedTotal ?? 0}
              icon={<ArchiveIcon className="size-4" />}
            />
            <StatCard
              label={t("memory.stats.blocked")}
              value={stats?.blocked ?? 0}
              icon={<ShieldAlertIcon className="size-4" />}
            />
          </div>

          <MemoryEnableCard />
          <MemoryPendingCard />
          <MemoryListCard />
          <MemoryMaintenanceCard />
          <MemorySyncCard />
          <MemoryApiCard />
        </div>
      </div>
    </div>
  );
}
