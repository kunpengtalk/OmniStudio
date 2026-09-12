import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ActivityIcon,
  CheckIcon,
  CpuIcon,
  CopyIcon,
  GaugeIcon,
  HardDriveIcon,
  LayoutDashboardIcon,
  Loader2Icon,
  MemoryStickIcon,
  PlayIcon,
  RefreshCwIcon,
  ServerIcon,
  SquareIcon,
  TimerIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Badge } from "@ui/badge";
import { Button } from "@ui/button";
import { Spinner } from "@ui/spinner";
import { useT } from "@stores/ui-lang";
import { useServerStore } from "@stores/server";
import type { ServerStatus } from "../../bun/server-manager";
import type { ServerStats } from "../../bun/stats";
import { ENGINE_PORT_KEYS, type InferenceEngine } from "@/shared/modelscope";
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

const SPARK_POINTS = 60; // 60 × 2s poll ≈ 2 min window

function Sparkline({ series, active }: { series: number[]; active: boolean }) {
  const max = Math.max(1, ...series);
  const n = series.length;
  const pts =
    n > 1
      ? series.map((v, i) => `${(i / (n - 1)) * 100},${32 - (v / max) * 29 - 2}`).join(" ")
      : "0,31 100,31";
  const areaPts = n > 1 ? `0,32 ${pts} 100,32` : "";
  return (
    <svg viewBox="0 0 100 32" preserveAspectRatio="none" className="h-10 w-full">
      {areaPts && (
        <polygon points={areaPts} className={active ? "fill-emerald-500/10" : "fill-muted"} />
      )}
      <polyline
        points={pts}
        fill="none"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={active ? "stroke-emerald-500" : "stroke-muted-foreground/30"}
      />
    </svg>
  );
}

function UsageBar({ label, icon, used, total }: { label: string; icon: React.ReactNode; used: number; total: number }) {
  const pct = total > 0 ? (used / total) * 100 : 0;
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <p className="mt-1.5 text-sm font-semibold tabular-nums">
        {total > 0 ? (
          <>
            {formatBytes(used)}
            <span className="font-normal text-muted-foreground"> / {formatBytes(total)}</span>
          </>
        ) : (
          "—"
        )}
      </p>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500",
            pct > 90 ? "bg-destructive" : pct > 75 ? "bg-amber-500" : "bg-primary",
          )}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
    </div>
  );
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

type DashboardData = {
  stats: ServerStats;
  status: ServerStatus;
  serverError?: string;
  settings: Record<string, string>;
};

export function DashboardScreen() {
  const t = useT();
  const queryClient = useQueryClient();
  const pushedStatus = useServerStore((s) => s.status);

  const { data, isLoading } = useQuery({
    queryKey: ["dashboard"],
    queryFn: async (): Promise<DashboardData> => {
      const [stats, status, settingsRes] = await Promise.all([
        rpcClient.getServerStats(),
        rpcClient.getServerStatus(),
        rpcClient.getSettings(undefined),
      ]);
      return { stats, status: status.status, serverError: status.error, settings: settingsRes.settings };
    },
    refetchInterval: 2000,
  });

  // Push channel only fires on transitions (no initial sync), so it is only
  // trusted when it reports a non-stopped state; polling is the source of truth.
  const status: ServerStatus =
    pushedStatus !== "stopped" ? pushedStatus : (data?.status ?? "stopped");

  const running = status === "running";

  // Instantaneous throughput: delta of cumulative tokens between polls.
  const prevRef = useRef<{ tokens: number; at: number } | null>(null);
  const [series, setSeries] = useState<number[]>([]);
  useEffect(() => {
    if (!data) return;
    const tokens = data.stats.prefillTokens + data.stats.generationTokens;
    const now = Date.now();
    const prev = prevRef.current;
    prevRef.current = { tokens, at: now };
    if (prev && now > prev.at) {
      const rate = Math.max(0, (tokens - prev.tokens) / ((now - prev.at) / 1000));
      setSeries((s) => [...s, rate].slice(-SPARK_POINTS));
    }
  }, [data]);

  const [copied, setCopied] = useState(false);
  const action = useMutation({
    mutationFn: (a: "start" | "stop" | "restart") =>
      a === "start"
        ? rpcClient.startServer()
        : a === "stop"
          ? rpcClient.stopServer()
          : rpcClient.restartServer(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
  });

  if (isLoading || !data) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-5" />
      </div>
    );
  }

  const { stats, settings } = data;
  const engine = (settings.INFERENCE_ENGINE as InferenceEngine) || "llama.cpp";
  const host = settings.SERVER_HOST || "127.0.0.1";
  const port = settings[ENGINE_PORT_KEYS[engine]] || "8080";
  const endpoint = `http://${host}:${port}`;
  const uptime = stats.serverStartedAt ? Date.now() - stats.serverStartedAt : 0;
  const busy = action.isPending;

  const statusPill = (
    <span
      className={cn(
        "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium",
        status === "running"
          ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
          : status === "error"
            ? "bg-destructive/15 text-destructive"
            : status === "stopped"
              ? "bg-muted text-muted-foreground"
              : "bg-amber-500/15 text-amber-600 dark:text-amber-400",
      )}
    >
      {status === "running" ? (
        <span className="relative flex size-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />
          <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
        </span>
      ) : status === "starting" || status === "downloading" ? (
        <Loader2Icon className="size-3 animate-spin" />
      ) : (
        <span
          className={cn(
            "size-2 rounded-full",
            status === "error" ? "bg-destructive" : "bg-muted-foreground/50",
          )}
        />
      )}
      {t(`dashboard.status.${status}`)}
    </span>
  );

  const copyEndpoint = async () => {
    try {
      await navigator.clipboard.writeText(endpoint);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — ignore
    }
  };

  const cfg: Array<[string, string]> = [
    [t("dashboard.config.engine"), engine],
    [t("dashboard.config.model"), settings.VLLM_MODEL_NAME || "—"],
    [t("dashboard.config.host"), host],
    [t("dashboard.config.port"), port],
    [t("dashboard.config.ctx"), settings.SERVER_CTX_SIZE || "—"],
    [t("dashboard.config.gpu"), settings.SERVER_GPU_LAYERS || "—"],
    [t("dashboard.config.parallel"), settings.SERVER_PARALLEL || "—"],
    [
      t("dashboard.config.batch"),
      settings.SERVER_BATCH_SIZE
        ? `${settings.SERVER_BATCH_SIZE} / ${settings.SERVER_UBATCH_SIZE || "—"}`
        : "—",
    ],
  ];

  const memUsed = stats.system.totalMem - stats.system.freeMem;
  const diskUsed = stats.system.disk.total - stats.system.disk.free;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-6">
        {/* Header */}
        <div className="flex items-center gap-2">
          <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
            <LayoutDashboardIcon className="size-4" />
          </span>
          <h2 className="text-lg font-semibold tracking-tight">{t("dashboard.title")}</h2>
        </div>

        {/* Engine status hero */}
        <div className="rounded-xl border bg-card p-5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <div className="flex items-center gap-3">
              <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <CpuIcon className="size-5" />
              </span>
              <div>
                <p className="text-sm font-semibold tracking-tight">{engine}</p>
                <p className="text-[11px] text-muted-foreground">{t("dashboard.engine")}</p>
              </div>
            </div>
            {statusPill}
            <div className="ml-auto flex items-center gap-2">
              {(status === "stopped" || status === "error") && (
                <Button size="sm" disabled={busy} onClick={() => action.mutate("start")}>
                  {busy ? <Spinner className="size-3.5" /> : <PlayIcon className="size-3.5" />}
                  {t("dashboard.start")}
                </Button>
              )}
              {status !== "stopped" && status !== "error" && (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => action.mutate("stop")}>
                  {busy ? <Spinner className="size-3.5" /> : <SquareIcon className="size-3.5" />}
                  {t("dashboard.stop")}
                </Button>
              )}
              {running && (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => action.mutate("restart")}>
                  {busy ? <Spinner className="size-3.5" /> : <RefreshCwIcon className="size-3.5" />}
                  {t("dashboard.restart")}
                </Button>
              )}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
            <button
              type="button"
              onClick={copyEndpoint}
              className="group flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[11px] transition-colors hover:bg-muted"
              title={t("dashboard.copy")}
            >
              {endpoint}
              {copied ? (
                <CheckIcon className="size-3 text-emerald-500" />
              ) : (
                <CopyIcon className="size-3 text-muted-foreground group-hover:text-foreground" />
              )}
            </button>
            <span className="flex items-center gap-1 text-muted-foreground">
              <ServerIcon className="size-3.5" />
              {t("dashboard.port")}: <span className="font-mono text-foreground">{port}</span>
            </span>
            {stats.serverStartedAt > 0 && (
              <span className="flex items-center gap-1 text-muted-foreground">
                <TimerIcon className="size-3.5" />
                {t("dashboard.uptime")}: <span className="tabular-nums text-foreground">{formatDuration(uptime)}</span>
              </span>
            )}
            {data.serverError && status === "error" && (
              <span className="max-w-full truncate text-destructive" title={data.serverError}>
                {data.serverError}
              </span>
            )}
          </div>

          {/* Throughput heartbeat */}
          <div className="mt-4 rounded-lg border bg-muted/30 p-3">
            <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <ActivityIcon className="size-3.5" />
                {t("dashboard.throughput")}
              </span>
              <span className="tabular-nums">
                {formatRate(
                  running
                    ? stats.prefillTokensPerSec + stats.generationTokensPerSec
                    : (series[series.length - 1] ?? 0),
                )}
              </span>
            </div>
            <Sparkline series={series} active={running} />
          </div>
        </div>

        {/* Hardware usage */}
        <div>
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
            <GaugeIcon className="size-4 text-muted-foreground" />
            {t("dashboard.hardware")}
          </h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <UsageBar
              label={t("dashboard.memory")}
              icon={<MemoryStickIcon className="size-3.5" />}
              used={memUsed}
              total={stats.system.totalMem}
            />
            <UsageBar
              label={t("dashboard.disk")}
              icon={<HardDriveIcon className="size-3.5" />}
              used={diskUsed}
              total={stats.system.disk.total}
            />
            <div className="rounded-xl border bg-card p-4">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <CpuIcon className="size-3.5" />
                {t("dashboard.cpu")}
              </div>
              <p className="mt-1.5 text-sm font-semibold tabular-nums">
                {stats.system.loadAvg.map((v) => v.toFixed(2)).join(" / ")}
              </p>
              <p className="mt-2 text-[10px] text-muted-foreground">1 / 5 / 15 min</p>
            </div>
          </div>
        </div>

        {/* Basic configuration */}
        <div>
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
            <ServerIcon className="size-4 text-muted-foreground" />
            {t("dashboard.config")}
          </h3>
          <div className="rounded-xl border bg-card">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 p-4">
              {cfg.map(([label, value]) => (
                <div key={label} className="flex items-baseline justify-between gap-3 border-b border-border/50 pb-2 last:border-0">
                  <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
                  <dd className="min-w-0 truncate text-right font-mono text-xs" title={value}>
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>

        {/* Session stats */}
        <div>
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
            <ActivityIcon className="size-4 text-muted-foreground" />
            {t("dashboard.session")}
          </h3>
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
        </div>

        {/* Active models */}
        <div className="rounded-xl border bg-card p-4">
          <h3 className="mb-3 flex items-center gap-1.5 text-sm font-medium">
            <CpuIcon className="size-4 text-muted-foreground" />
            {t("stats.activeModels")}
          </h3>
          {stats.activeModels.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">{t("stats.noActivity")}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {stats.activeModels.map((m) => (
                <div
                  key={m.name}
                  className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
                >
                  <span className="min-w-0 truncate font-mono text-xs">{m.name}</span>
                  <Badge variant={m.loaded ? "default" : "secondary"} className="shrink-0 text-[10px]">
                    {m.loaded ? t("stats.loaded") : t("stats.idle")}
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
