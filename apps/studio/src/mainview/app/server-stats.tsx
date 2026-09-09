import { useQuery } from "@tanstack/react-query";
import {
  ActivityIcon,
  CpuIcon,
  MemoryStickIcon,
  HardDriveIcon,
  GaugeIcon,
  TimerIcon,
  CheckCircle2Icon,
  Loader2Icon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Badge } from "@ui/badge";
import { Spinner } from "@ui/spinner";
import { useT } from "@stores/ui-lang";
import type { ServerStats } from "../../bun/stats";
import { cn } from "@/mainview/lib/utils";

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

function formatRate(tokPerSec: number): string {
  return `${tokPerSec.toFixed(1)} tok/s`;
}

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return "—";
  const sec = Math.floor(ms / 1000);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${sec % 60}s`;
}

function StatCard({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <p className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function ServerStatsScreen() {
  const t = useT();

  const { data, isLoading } = useQuery({
    queryKey: ["server-stats"],
    queryFn: async (): Promise<{ stats: ServerStats; status: string }> => {
      const [stats, status] = await Promise.all([
        rpcClient.getServerStats(),
        rpcClient.getServerStatus(),
      ]);
      return { stats, status: status.status };
    },
    refetchInterval: 2000,
  });

  const stats = data?.stats;
  const status = data?.status ?? "stopped";

  if (isLoading || !stats) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-5" />
      </div>
    );
  }

  const running = status === "running";
  const serverUptime = stats.serverStartedAt ? Date.now() - stats.serverStartedAt : 0;
  const memUsed = stats.system.totalMem - stats.system.freeMem;
  const memPercent = stats.system.totalMem > 0 ? (memUsed / stats.system.totalMem) * 100 : 0;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-6">
        {/* Header */}
        <div className="flex items-center gap-2">
          <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
            <ActivityIcon className="size-4" />
          </span>
          <h2 className="text-lg font-semibold tracking-tight">{t("stats.title")}</h2>
          <span
            className={cn(
              "flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
              running
                ? "bg-emerald-500/20 text-emerald-500"
                : status === "error"
                  ? "bg-destructive/20 text-destructive"
                  : "bg-muted-foreground/20 text-muted-foreground",
            )}
          >
            {running ? <CheckCircle2Icon className="size-3" /> : <Loader2Icon className="size-3" />}
            {status}
          </span>
          <p className="text-xs text-muted-foreground">
            {t("stats.serverUptime")}: {formatDuration(serverUptime)}
          </p>
        </div>

        {/* Token stats */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatCard
            icon={<GaugeIcon className="size-3.5" />}
            label={t("stats.prefill")}
            value={formatTokens(stats.prefillTokens)}
          />
          <StatCard
            icon={<GaugeIcon className="size-3.5" />}
            label={t("stats.generation")}
            value={formatTokens(stats.generationTokens)}
          />
          <StatCard
            icon={<TimerIcon className="size-3.5" />}
            label={t("stats.requests")}
            value={String(stats.requests)}
          />
          <StatCard
            icon={<ActivityIcon className="size-3.5" />}
            label={t("stats.prefillRate")}
            value={formatRate(stats.prefillTokensPerSec)}
          />
          <StatCard
            icon={<ActivityIcon className="size-3.5" />}
            label={t("stats.genRate")}
            value={formatRate(stats.generationTokensPerSec)}
          />
          <StatCard
            icon={<HardDriveIcon className="size-3.5" />}
            label={t("stats.modelsSize")}
            value={formatBytes(stats.modelsSize)}
          />
        </div>

        {/* System */}
        <div className="rounded-xl border bg-card p-4">
          <h3 className="mb-3 flex items-center gap-1.5 text-sm font-medium">
            <CpuIcon className="size-4 text-muted-foreground" />
            {t("stats.system")}
          </h3>
          <div className="flex flex-col gap-4">
            <div>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <MemoryStickIcon className="size-3.5" />
                  {t("stats.memory")}
                </span>
                <span className="tabular-nums">
                  {formatBytes(memUsed)} / {formatBytes(stats.system.totalMem)}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-500"
                  style={{ width: `${Math.min(memPercent, 100)}%` }}
                />
              </div>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">
                {t("stats.cpuLoad")} (1/5/15m)
              </span>
              <span className="tabular-nums">
                {stats.system.loadAvg.map((v) => v.toFixed(2)).join(" / ")}
              </span>
            </div>
          </div>
        </div>

        {/* Active models */}
        <div className="rounded-xl border bg-card p-4">
          <h3 className="mb-3 flex items-center gap-1.5 text-sm font-medium">
            <ActivityIcon className="size-4 text-muted-foreground" />
            {t("stats.activeModels")}
          </h3>
          {stats.activeModels.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              No inference requests yet this session.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {stats.activeModels.map((m) => (
                <div
                  key={m.name}
                  className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
                >
                  <span className="min-w-0 truncate font-mono text-xs">{m.name}</span>
                  <Badge
                    variant={m.loaded ? "default" : "secondary"}
                    className="shrink-0 text-[10px]"
                  >
                    {m.loaded ? t("stats.loaded") : "idle"}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
