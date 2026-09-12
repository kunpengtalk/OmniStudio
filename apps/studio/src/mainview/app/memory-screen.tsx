import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArchiveIcon,
  BrainIcon,
  CheckIcon,
  CopyIcon,
  GlobeIcon,
  HashIcon,
  HistoryIcon,
  LayersIcon,
  PinIcon,
  ShieldAlertIcon,
  SparklesIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { cn } from "@lib/utils";
import { useT } from "@stores/ui-lang";
import { useMemoryUi } from "@stores/memory-ui";
import { MEMORY_CATEGORIES, type MemoryCategory } from "@/shared/memory";
import {
  MemoryEnableCard,
  MemoryListCard,
  MemoryMaintenanceCard,
  MemoryPendingCard,
  MemorySyncCard,
} from "./main-layout/memory-tab";
import { SettingsSection } from "./main-layout/setting-ui";

/**
 * 记忆应用页（一级入口）：统计总览 + 记忆库管理 + 外部 Agent 同步 + 接入方式。
 * 与设置 → 工具 → 记忆共用底层卡片（MemoryListCard / MemorySyncCard）。
 */

function StatCard({ label, value, icon }: { label: string; value: string | number; icon: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-card px-4 py-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-lg font-semibold leading-tight tabular-nums">{value}</p>
        <p className="truncate text-[11px] text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}

function CopyRow({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  return (
    <div className="flex items-center gap-2 rounded-md bg-muted/60 px-3 py-1.5">
      <span className="shrink-0 text-[10px] text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-[11px]">{text}</code>
      <Button type="button" variant="ghost" size="icon-sm" className="h-6 w-6 shrink-0" onClick={copy}>
        {copied ? <CheckIcon className="size-3.5 text-primary" /> : <CopyIcon className="size-3.5" />}
      </Button>
    </div>
  );
}

/** 对外接入方式：REST + MCP（挂在本地网关上，OpenMemory 同款对外形式）。 */
function MemoryApiCard() {
  const t = useT();
  const { data } = useQuery({
    queryKey: ["gateway-status"],
    queryFn: () => rpcClient.getGatewayStatus(undefined),
  });
  const base = (data?.url ?? "http://127.0.0.1:10000").replace(/\/+$/, "");
  const mcpConfig = JSON.stringify(
    { mcpServers: { "omni-memory": { url: `${base}/mcp` } } },
    null,
    2,
  );

  return (
    <SettingsSection title={t("memory.api.title")} description={t("memory.api.desc")}>
      <div className="flex flex-col gap-2 px-4 py-3">
        <CopyRow label="GET" text={`curl ${base}/v1/memories?q=关键词`} />
        <CopyRow label="POST" text={`curl -X POST ${base}/v1/memories -H "content-type: application/json" -d '{"content":"一句话记忆","category":"fact"}'`} />
        <CopyRow label={t("memory.api.playground")} text={`${base}/mcp`} />
        <CopyRow label="MCP JSON" text={mcpConfig} />
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          {t("memory.api.hint")}
        </p>
      </div>
    </SettingsSection>
  );
}

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
