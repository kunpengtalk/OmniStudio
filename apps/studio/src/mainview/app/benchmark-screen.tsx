import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ActivityIcon, GaugeIcon, SquareIcon, Trash2Icon } from "lucide-react";

import { Badge } from "@ui/badge";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import { Spinner } from "@ui/spinner";
import { rpcClient } from "@lib/rpc";
import { useT } from "@stores/ui-lang";
import { useBenchmarkStore } from "@stores/benchmark";
import { cn } from "@/mainview/lib/utils";
import type { BenchmarkRecordRow, BenchmarkRunState, SpeedBenchRow } from "../../bun/benchmark";

const PRESET_CONTEXTS = [1024, 4096, 8192, 16384, 32768];

function fmtCtx(c: number) {
  return c >= 1000 ? `${(c / 1000).toFixed(c % 1000 === 0 ? 0 : 1)}k` : String(c);
}

function fmtTime(ms: number) {
  const d = new Date(ms);
  const now = new Date();
  const md = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.getFullYear() === now.getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}-${md} ${hm}`;
}

/** 一份可展示的测试结果：运行中任务或历史记录的统一视图。 */
type DisplayResult = {
  source: "run" | "record";
  model: string;
  engine?: string | null;
  serverMode: string;
  status: BenchmarkRunState["status"];
  rows: SpeedBenchRow[];
  summary?: BenchmarkRecordRow["summary"];
  params?: BenchmarkRecordRow["params"];
  createdAt: number;
  durationMs?: number | null;
  error?: string | null;
  progress?: BenchmarkRunState["progress"];
};

export function BenchmarkScreen() {
  const t = useT();
  const queryClient = useQueryClient();
  const runId = useBenchmarkStore((s) => s.runId);
  const setRunId = useBenchmarkStore((s) => s.setRunId);
  const selectedRecordId = useBenchmarkStore((s) => s.selectedRecordId);
  const setSelectedRecordId = useBenchmarkStore((s) => s.setSelectedRecordId);

  const [model, setModel] = useState("");
  const [genLength, setGenLength] = useState(128);
  const [batchSize, setBatchSize] = useState(1);
  const [contexts, setContexts] = useState<number[]>(PRESET_CONTEXTS);
  const [startError, setStartError] = useState<string | null>(null);

  const { data: settingsData } = useQuery({ queryKey: ["settings"], queryFn: () => rpcClient.getSettings(undefined) });
  const { data: installed } = useQuery({ queryKey: ["installed-models"], queryFn: () => rpcClient.listInstalledModels() });
  const recordsQuery = useQuery({
    queryKey: ["benchmark-records"],
    queryFn: () => rpcClient.listBenchmarkRecords(undefined),
  });

  const runQuery = useQuery({
    queryKey: ["benchmark-run", runId],
    queryFn: () => rpcClient.getBenchmarkRun({ runId: runId! }),
    enabled: !!runId,
    refetchInterval: (query) => (query.state.data?.run?.status === "running" ? 800 : false),
  });
  const run = runQuery.data?.run ?? null;

  // 运行结束：刷新历史并自动选中新记录。
  const runStatus = run?.status;
  useEffect(() => {
    if (!run || runStatus === "running") return;
    queryClient.invalidateQueries({ queryKey: ["benchmark-records"] });
    if (run.recordId) {
      setSelectedRecordId(run.recordId);
      setRunId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runStatus]);

  const records = recordsQuery.data?.records ?? [];
  const modelOptions = useMemo(
    () =>
      Array.from(new Set((installed?.models ?? []).map((m) => m.fileName.replace(/\.gguf$/i, "")))).filter(Boolean),
    [installed],
  );
  const effectiveModel = model || settingsData?.settings?.CHAT_MODEL || modelOptions[0] || "";

  const startRun = async () => {
    setStartError(null);
    const res = await rpcClient.startBenchmark({
      model: effectiveModel,
      genLength,
      batchSize,
      contexts,
    });
    if ("error" in res) {
      setStartError(
        res.error === "benchmark_already_running" ? t("benchmark.alreadyRunning") : res.error,
      );
      return;
    }
    setSelectedRecordId(null);
    setRunId(res.runId);
  };

  const display: DisplayResult | null = useMemo(() => {
    if (selectedRecordId != null) {
      const rec = records.find((r) => r.id === selectedRecordId);
      if (rec) {
        return {
          source: "record",
          model: rec.model,
          engine: rec.engine,
          serverMode: rec.serverMode ?? "local",
          status: rec.status,
          rows: rec.rows ?? [],
          summary: rec.summary,
          params: rec.params,
          createdAt: rec.createdAt,
          durationMs: rec.durationMs,
          error: rec.error,
        };
      }
    }
    if (run) {
      return {
        source: "run",
        model: run.model,
        engine: run.engine,
        serverMode: run.serverMode,
        status: run.status,
        rows: run.rows,
        summary: run.summary,
        params: run.params,
        createdAt: run.startedAt,
        durationMs: run.durationMs,
        error: run.error,
        progress: run.progress,
      };
    }
    const latest = records[0];
    if (latest) {
      return {
        source: "record",
        model: latest.model,
        engine: latest.engine,
        serverMode: latest.serverMode ?? "local",
        status: latest.status,
        rows: latest.rows ?? [],
        summary: latest.summary,
        params: latest.params,
        createdAt: latest.createdAt,
        durationMs: latest.durationMs,
        error: latest.error,
      };
    }
    return null;
  }, [records, run, selectedRecordId]);

  const isRunning = run?.status === "running";
  const maxTps = Math.max(...(display?.rows ?? []).map((r) => r.tps), 0.0001);

  const toggleContext = (c: number) => {
    setContexts((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c].sort((a, b) => a - b)));
  };

  return (
    <div className="flex h-full min-h-0">
      {/* 左：340px 配置面板（与其他工具页同款布局） */}
      <aside className="w-[340px] shrink-0 overflow-y-auto border-r p-4">
        <div className="flex flex-col gap-5">
          <div>
            <Label htmlFor="benchModel" className="mb-1.5 block text-xs">
              {t("benchmark.model")}
            </Label>
            <Input
              id="benchModel"
              placeholder={modelOptions[0] ?? "model name"}
              value={effectiveModel}
              onChange={(e) => setModel(e.target.value)}
              disabled={isRunning}
              className="h-8 text-xs"
            />
            {modelOptions.length > 0 && (
              <div className="mt-1.5 flex max-h-28 flex-wrap gap-1 overflow-y-auto">
                {modelOptions.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setModel(m)}
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[10px] transition-colors",
                      effectiveModel === m
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="benchGen" className="mb-1 block text-xs">
                {t("benchmark.genLength")}
              </Label>
              <Input
                id="benchGen"
                type="text"
                inputMode="numeric"
                value={String(genLength)}
                disabled={isRunning}
                onChange={(e) => setGenLength(Math.max(parseInt(e.target.value || "0", 10) || 16, 16))}
                className="h-8 text-xs"
              />
            </div>
            <div>
              <Label htmlFor="benchBatch" className="mb-1 block text-xs">
                {t("benchmark.concurrency")}
              </Label>
              <Input
                id="benchBatch"
                type="text"
                inputMode="numeric"
                value={String(batchSize)}
                disabled={isRunning}
                onChange={(e) => setBatchSize(Math.max(parseInt(e.target.value || "0", 10) || 1, 1))}
                className="h-8 text-xs"
              />
            </div>
          </div>

          <div>
            <Label className="mb-1.5 block text-xs">{t("benchmark.contexts")}</Label>
            <div className="flex flex-wrap gap-1.5">
              {PRESET_CONTEXTS.map((c) => (
                <button
                  key={c}
                  type="button"
                  disabled={isRunning}
                  onClick={() => toggleContext(c)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs transition-colors",
                    contexts.includes(c)
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
                  )}
                >
                  {fmtCtx(c)}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            {isRunning ? (
              <Button size="sm" variant="destructive" onClick={() => rpcClient.cancelBenchmark({ runId: run!.runId })}>
                <SquareIcon data-icon="inline-start" />
                {t("benchmark.stop")}
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => void startRun()}
                disabled={contexts.length === 0 || !effectiveModel}
              >
                <ActivityIcon data-icon="inline-start" />
                {t("benchmark.run")}
              </Button>
            )}
            {isRunning && run && (
              <div className="rounded-lg border bg-card px-3 py-2.5 text-xs">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <Spinner className="size-3" />
                    {t(
                      run.progress.phase === "warmup"
                        ? "benchmark.progress.warmup"
                        : "benchmark.progress.measure",
                      { ctx: fmtCtx(run.progress.currentContext ?? 0) },
                    )}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {t("benchmark.progress.done", {
                      done: String(run.progress.done),
                      total: String(run.progress.total),
                    })}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary/70 transition-all"
                    style={{ width: `${(run.progress.done / Math.max(run.progress.total, 1)) * 100}%` }}
                  />
                </div>
              </div>
            )}
            {startError && (
              <p className="text-xs leading-relaxed text-destructive">{startError}</p>
            )}
            <p className="text-[11px] leading-relaxed text-muted-foreground">{t("benchmark.desc")}</p>
          </div>
        </div>
      </aside>

      {/* 右：结果区 */}
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-5">
        {!display ? (
          <div className="flex flex-1 items-center justify-center">
            <p className="rounded-lg border border-dashed px-6 py-10 text-center text-xs text-muted-foreground">
              {t("benchmark.empty")}
            </p>
          </div>
        ) : (
          <ResultView result={display} isRunning={isRunning} maxTps={maxTps} />
        )}
      </div>
    </div>
  );
}

const STATUS_STYLES: Record<DisplayResult["status"], string> = {
  running: "bg-primary/10 text-primary",
  done: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  cancelled: "bg-muted text-muted-foreground",
  error: "bg-destructive/10 text-destructive",
};

function ResultView({
  result,
  isRunning,
  maxTps,
}: {
  result: DisplayResult;
  isRunning: boolean;
  maxTps: number;
}) {
  const t = useT();
  const summary = result.summary;
  const engineLabel =
    result.serverMode === "remote"
      ? t("benchmark.mode.remote")
      : t("benchmark.mode.local", { engine: result.engine ?? "llama.cpp" });

  const cards: { label: string; value: string }[] = summary
    ? [
        { label: t("benchmark.summary.avgTps"), value: String(summary.avgTps) },
        { label: t("benchmark.summary.peakTps"), value: String(summary.peakTps) },
        { label: t("benchmark.summary.bestTtft"), value: `${summary.bestTtftMs} ms` },
        { label: t("benchmark.summary.peakAgg"), value: String(summary.peakAggTps) },
        { label: t("benchmark.summary.peakPrefill"), value: String(summary.peakPrefillTps) },
        { label: t("benchmark.summary.tokens"), value: summary.totalTokens.toLocaleString() },
      ]
    : [];

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
      {/* 头部：模型 / 引擎 / 时间 / 状态 */}
      <div className="flex flex-wrap items-center gap-2">
        <GaugeIcon className="size-4 text-primary" />
        <span className="text-sm font-semibold">{result.model}</span>
        <Badge variant="secondary" className="text-[10px]">
          {engineLabel}
        </Badge>
        {result.params && (
          <Badge variant="secondary" className="text-[10px] tabular-nums">
            {result.params.genLength} tok × {result.params.batchSize}
          </Badge>
        )}
        <Badge className={cn("text-[10px]", STATUS_STYLES[result.status])}>
          {isRunning && result.status === "running"
            ? t("benchmark.status.running")
            : t(`benchmark.status.${result.status}`)}
        </Badge>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">{fmtTime(result.createdAt)}</span>
      </div>

      {result.error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-xs text-destructive">
          {result.error}
        </div>
      )}

      {/* 汇总卡 */}
      {cards.length > 0 && (
        <div className="grid grid-cols-3 gap-3 lg:grid-cols-6">
          {cards.map((c) => (
            <div key={c.label} className="rounded-lg border bg-card px-3 py-2.5">
              <p className="text-[10px] text-muted-foreground">{c.label}</p>
              <p className="mt-0.5 text-sm font-semibold tabular-nums">{c.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* 明细表 */}
      <div>
        <h3 className="mb-2 text-sm font-medium">{t("benchmark.results")}</h3>
        {result.rows.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">
            {t("benchmark.noRows")}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-2 py-1.5 font-medium">{t("benchmark.col.context")}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t("benchmark.col.prompt")}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t("benchmark.col.batch")}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t("benchmark.col.ttft")}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t("benchmark.col.tpot")}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t("benchmark.col.tps")}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t("benchmark.col.aggTps")}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t("benchmark.col.prefill")}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t("benchmark.col.tokens")}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t("benchmark.col.ok")}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t("benchmark.col.total")}</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={r.contextLength} className="border-b border-muted/50">
                    <td className="px-2 py-1.5 tabular-nums">{fmtCtx(r.contextLength)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{r.promptTokens}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{r.batchSize}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{r.ttftMs}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{r.tpotMs}</td>
                    <td className="px-2 py-1.5 text-right font-semibold tabular-nums text-primary">{r.tps}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{r.aggTps}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{r.prefillTps}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{r.tokens}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {r.fails > 0 ? (
                        <span className="text-destructive">
                          {r.ok}/{r.fails}
                        </span>
                      ) : (
                        r.ok
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{r.totalMs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* TPS 条形图 */}
      {result.rows.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-medium">{t("benchmark.chart")}</h3>
          <div className="flex flex-col gap-1.5">
            {result.rows.map((r) => (
              <div key={r.contextLength} className="flex items-center gap-2">
                <span className="w-10 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
                  {fmtCtx(r.contextLength)}
                </span>
                <div className="h-2.5 flex-1 rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary/70"
                    style={{ width: `${(r.tps / maxTps) * 100}%` }}
                  />
                </div>
                <span className="w-14 shrink-0 font-mono text-[10px] tabular-nums">{r.tps} tps</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
