import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ActivityIcon, GaugeIcon, GraduationCapIcon, SquareIcon } from "lucide-react";

import { Badge } from "@ui/badge";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import { Spinner } from "@ui/spinner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui/select";
import { rpcClient } from "@lib/rpc";
import {
  classifyModelName,
  filterModelIds,
  isChatModelCategory,
  MODEL_CATEGORY_SETS,
} from "@/shared/modelscope";
import { useT } from "@stores/ui-lang";
import { useBenchmarkStore } from "@stores/benchmark";
import { useRouter } from "@stores/router";
import { cn } from "@/mainview/lib/utils";
import type { BenchmarkRecordRow, BenchmarkRunState, SpeedBenchRow } from "../../bun/benchmark";
import type { EvalCategoryRow, EvalSuiteId, EvalSuiteInfo } from "../../bun/eval";

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
  kind: "speed" | "eval";
  model: string;
  engine?: string | null;
  serverMode: string;
  status: BenchmarkRunState["status"];
  rows: SpeedBenchRow[];
  evalRows?: EvalCategoryRow[];
  eval?: BenchmarkRunState["eval"];
  summary?: BenchmarkRecordRow["summary"];
  params?: BenchmarkRecordRow["params"];
  createdAt: number;
  durationMs?: number | null;
  error?: string | null;
  progress?: BenchmarkRunState["progress"];
};

function fmtMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function BenchmarkScreen() {
  const t = useT();
  const queryClient = useQueryClient();
  const setRoute = useRouter((s) => s.setRoute);
  const runId = useBenchmarkStore((s) => s.runId);
  const setRunId = useBenchmarkStore((s) => s.setRunId);
  const selectedRecordId = useBenchmarkStore((s) => s.selectedRecordId);
  const setSelectedRecordId = useBenchmarkStore((s) => s.setSelectedRecordId);

  const [mode, setMode] = useState<"speed" | "eval">("speed");
  const [source, setSource] = useState<"local" | "cloud">("local");
  const [model, setModel] = useState("");
  const [cloudModel, setCloudModel] = useState("");
  const [providerId, setProviderId] = useState<string | null>(null);
  const [genLength, setGenLength] = useState(128);
  const [batchSize, setBatchSize] = useState(1);
  const [contexts, setContexts] = useState<number[]>(PRESET_CONTEXTS);
  const [startError, setStartError] = useState<string | null>(null);
  // 能力评测参数：套件 + 抽样题数（0 = 全量）+ 并发跑题数。
  const [suite, setSuite] = useState<EvalSuiteId>("mmlu");
  const [sampleSize, setSampleSize] = useState(0);
  const [evalConcurrency, setEvalConcurrency] = useState(4);

  const { data: settingsData } = useQuery({ queryKey: ["settings"], queryFn: () => rpcClient.getSettings(undefined) });
  const { data: installed } = useQuery({ queryKey: ["installed-models"], queryFn: () => rpcClient.listInstalledModels() });
  const providersQuery = useQuery({
    queryKey: ["cloud-providers"],
    queryFn: () => rpcClient.cloudProviderList(undefined),
  });
  const recordsQuery = useQuery({
    queryKey: ["benchmark-records"],
    queryFn: () => rpcClient.listBenchmarkRecords(undefined),
  });
  const evalSuitesQuery = useQuery({
    queryKey: ["eval-suites"],
    queryFn: () => rpcClient.getEvalSuites(undefined),
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
  // 测速 / 评测跑的是 LLM：本机模型的嵌入 / 语音 / 生图条目不进候选。
  const modelOptions = useMemo(
    () =>
      Array.from(
        new Set(
          (installed?.models ?? [])
            .filter((m) => isChatModelCategory(m.category ?? classifyModelName(m.fileName)))
            .map((m) => m.fileName.replace(/\.gguf$/i, "")),
        ),
      ).filter(Boolean),
    [installed],
  );
  const effectiveModel = model || settingsData?.settings?.CHAT_MODEL || modelOptions[0] || "";

  // 云端：cloud_providers 表直连，与全局激活状态无关。
  const providers = providersQuery.data?.providers ?? [];
  const cloudActiveId = providersQuery.data?.activeId ?? null;
  useEffect(() => {
    if (providers.length === 0) {
      setProviderId(null);
      return;
    }
    if (!providerId || !providers.some((p) => p.id === providerId)) {
      setProviderId(cloudActiveId ?? providers[0]!.id);
    }
  }, [providers, cloudActiveId, providerId]);
  const selectedProvider = providers.find((p) => p.id === providerId) ?? null;
  // 服务商清单里混着嵌入 / 语音 / 生图模型，测速只列对话模型（认不出的保留）。
  const cloudModelOptions = useMemo(
    () =>
      filterModelIds(
        Array.from(new Set((selectedProvider?.models ?? []).map((m) => m.id).filter(Boolean))),
        MODEL_CATEGORY_SETS.chat,
        { keepOther: true },
      ).ids,
    [selectedProvider],
  );
  const effectiveCloudModel = cloudModel || cloudModelOptions[0] || "";
  const providerIncomplete = !selectedProvider || !selectedProvider.baseUrl.trim();
  const providerKeyMissing = !!selectedProvider && !selectedProvider.apiKey.trim();

  const selectedSuiteInfo: EvalSuiteInfo | undefined = evalSuitesQuery.data?.suites.find((s) => s.id === suite);

  const startRun = async () => {
    setStartError(null);
    const res = await rpcClient.startBenchmark({
      model: source === "cloud" ? effectiveCloudModel : effectiveModel,
      providerId: source === "cloud" && providerId ? providerId : undefined,
      mode,
      suite: mode === "eval" ? suite : undefined,
      sampleSize: mode === "eval" ? sampleSize : undefined,
      concurrency: mode === "eval" ? evalConcurrency : undefined,
      genLength: mode === "speed" ? genLength : undefined,
      batchSize: mode === "speed" ? batchSize : undefined,
      contexts: mode === "speed" ? contexts : undefined,
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
          kind: rec.kind,
          model: rec.model,
          engine: rec.engine,
          serverMode: rec.serverMode ?? "local",
          status: rec.status,
          rows: rec.kind === "speed" ? (rec.rows as SpeedBenchRow[]) : [],
          evalRows: rec.kind === "eval" ? (rec.rows as EvalCategoryRow[]) : undefined,
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
        kind: run.kind,
        model: run.model,
        engine: run.engine,
        serverMode: run.serverMode,
        status: run.status,
        rows: run.rows,
        evalRows: run.evalRows,
        eval: run.eval,
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
        kind: latest.kind,
        model: latest.model,
        engine: latest.engine,
        serverMode: latest.serverMode ?? "local",
        status: latest.status,
        rows: latest.kind === "speed" ? (latest.rows as SpeedBenchRow[]) : [],
        evalRows: latest.kind === "eval" ? (latest.rows as EvalCategoryRow[]) : undefined,
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
            <Label className="mb-1.5 block text-xs">{t("benchmark.tab")}</Label>
            <div className="flex overflow-hidden rounded-lg border">
              {(["speed", "eval"] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  disabled={isRunning}
                  onClick={() => setMode(key)}
                  className={cn(
                    "flex-1 px-3 py-1.5 text-xs transition-colors",
                    mode === key
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {t(key === "speed" ? "benchmark.tab.speed" : "benchmark.tab.eval")}
                </button>
              ))}
            </div>
          </div>

          <div>
            <Label className="mb-1.5 block text-xs">{t("benchmark.source")}</Label>
            <div className="flex overflow-hidden rounded-lg border">
              {(["local", "cloud"] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  disabled={isRunning}
                  onClick={() => setSource(key)}
                  className={cn(
                    "flex-1 px-3 py-1.5 text-xs transition-colors",
                    source === key
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {t(key === "local" ? "benchmark.source.local" : "benchmark.source.cloud")}
                </button>
              ))}
            </div>
          </div>

          {source === "local" ? (
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
          ) : (
            <div className="flex flex-col gap-3">
              <div>
                <Label className="mb-1.5 block text-xs">{t("benchmark.provider")}</Label>
                {providers.length === 0 ? (
                  <div className="flex items-center justify-between rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
                    <span>{t("benchmark.cloud.noProviders")}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[11px]"
                      onClick={() => setRoute({ path: "settings", tab: "network" })}
                    >
                      {t("benchmark.cloud.goSettings")}
                    </Button>
                  </div>
                ) : (
                  <Select value={providerId ?? undefined} onValueChange={setProviderId} disabled={isRunning}>
                    <SelectTrigger className="h-8 w-full text-xs">
                      <SelectValue placeholder={t("benchmark.providerPlaceholder")} />
                    </SelectTrigger>
                    <SelectContent className="max-w-72">
                      {providers.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          <span className="truncate">{p.name}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {(providerIncomplete || providerKeyMissing) && providers.length > 0 && (
                  <p className="mt-1.5 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
                    {t("benchmark.cloud.noKey")}
                  </p>
                )}
              </div>

              <div>
                <Label htmlFor="benchCloudModel" className="mb-1.5 block text-xs">
                  {t("benchmark.model")}
                </Label>
                <Input
                  id="benchCloudModel"
                  placeholder={cloudModelOptions[0] ?? t("benchmark.cloud.modelPlaceholder")}
                  value={effectiveCloudModel}
                  onChange={(e) => setCloudModel(e.target.value)}
                  disabled={isRunning || providers.length === 0}
                  className="h-8 text-xs"
                />
                {cloudModelOptions.length > 0 && (
                  <div className="mt-1.5 flex max-h-28 flex-wrap gap-1 overflow-y-auto">
                    {cloudModelOptions.map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setCloudModel(m)}
                        className={cn(
                          "rounded-full border px-2 py-0.5 text-[10px] transition-colors",
                          effectiveCloudModel === m
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
            </div>
          )}

          {mode === "speed" ? (
            <>
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
            </>
          ) : (
            <>
              <div>
                <Label className="mb-1.5 block text-xs">{t("benchmark.eval.suite")}</Label>
                <div className="flex flex-col gap-1.5">
                  {(evalSuitesQuery.data?.suites ?? []).map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      disabled={isRunning}
                      onClick={() => {
                        setSuite(s.id);
                        if (!sampleSize) setSampleSize(s.quickSize);
                      }}
                      className={cn(
                        "flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors",
                        suite === s.id
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
                      )}
                    >
                      <GraduationCapIcon className="size-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate font-medium">{t(`benchmark.suite.${s.id}`)}</span>
                      <span
                        className={cn(
                          "shrink-0 text-[10px] tabular-nums",
                          suite === s.id ? "text-primary/80" : "text-muted-foreground",
                        )}
                      >
                        {s.files.every((f) => f.downloaded) ? (
                          <span className="text-emerald-600 dark:text-emerald-400">✓</span>
                        ) : (
                          fmtMb(s.totalSizeBytes)
                        )}
                      </span>
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                  {t("benchmark.eval.suiteHint", {
                    count: (evalSuitesQuery.data?.suites.find((s) => s.id === suite)?.totalQuestions ?? 0).toLocaleString(),
                  })}
                </p>
                {selectedSuiteInfo?.kind === "code" && (
                  <p className="mt-1 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
                    {t("benchmark.eval.codeExecNote")}
                  </p>
                )}
                {selectedSuiteInfo?.kind === "long-context" && (
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    {t("benchmark.eval.longctxNote")}
                  </p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="benchSample" className="mb-1 block text-xs">
                    {t("benchmark.eval.sampleSize")}
                  </Label>
                  <Input
                    id="benchSample"
                    type="text"
                    inputMode="numeric"
                    placeholder="0"
                    value={String(sampleSize)}
                    disabled={isRunning}
                    onChange={(e) => setSampleSize(Math.max(parseInt(e.target.value || "0", 10) || 0, 0))}
                    className="h-8 text-xs"
                  />
                </div>
                <div>
                  <Label htmlFor="benchEvalConc" className="mb-1 block text-xs">
                    {t("benchmark.eval.concurrency")}
                  </Label>
                  <Input
                    id="benchEvalConc"
                    type="text"
                    inputMode="numeric"
                    value={String(evalConcurrency)}
                    disabled={isRunning}
                    onChange={(e) => setEvalConcurrency(Math.max(parseInt(e.target.value || "0", 10) || 1, 1))}
                    className="h-8 text-xs"
                  />
                </div>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">{t("benchmark.eval.sampleHint")}</p>
            </>
          )}

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
                disabled={
                  mode === "speed" && contexts.length === 0
                    ? true
                    : source === "cloud"
                      ? providers.length === 0 || providerIncomplete || !effectiveCloudModel
                      : !effectiveModel
                }
              >
                {mode === "eval" ? <GraduationCapIcon data-icon="inline-start" /> : <ActivityIcon data-icon="inline-start" />}
                {mode === "eval" ? t("benchmark.eval.run") : t("benchmark.run")}
              </Button>
            )}
            {isRunning && run && run.kind === "speed" && (
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
            {isRunning && run && run.kind === "eval" && run.eval && (
              <div className="rounded-lg border bg-card px-3 py-2.5 text-xs">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <Spinner className="size-3" />
                    {run.eval.download
                      ? t("benchmark.eval.downloading", {
                          received: fmtMb(run.eval.download.received),
                          total: fmtMb(run.eval.download.total),
                        })
                      : t("benchmark.eval.evaluating", { suite: t(`benchmark.suite.${run.eval.suite}`) })}
                  </span>
                  {run.eval.total > 0 && !run.eval.download && (
                    <span className="tabular-nums text-muted-foreground">
                      {run.eval.done}/{run.eval.total} · {run.eval.accuracy}%
                    </span>
                  )}
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary/70 transition-all"
                    style={{
                      width: run.eval.download
                        ? `${(run.eval.download.received / Math.max(run.eval.download.total, 1)) * 100}%`
                        : `${(run.eval.done / Math.max(run.eval.total, 1)) * 100}%`,
                    }}
                  />
                </div>
              </div>
            )}
            {startError && (
              <p className="text-xs leading-relaxed text-destructive">{startError}</p>
            )}
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {mode === "eval"
                ? t("benchmark.eval.desc")
                : source === "cloud"
                  ? t("benchmark.cloud.costHint")
                  : t("benchmark.desc")}
            </p>
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
    result.serverMode === "cloud"
      ? t("benchmark.mode.cloud", { provider: result.engine ?? "" })
      : result.serverMode === "remote"
        ? t("benchmark.mode.remote")
        : t("benchmark.mode.local", { engine: result.engine ?? "llama.cpp" });
  const speedParams = result.params as { genLength?: number; batchSize?: number } | undefined;
  const evalParams = result.params as { suite?: string; sampleSize?: number } | undefined;

  if (result.kind === "eval") {
    return (
      <EvalResultView
        result={result}
        isRunning={isRunning}
        engineLabel={engineLabel}
        evalParams={evalParams}
      />
    );
  }

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
        {speedParams?.genLength != null && (
          <Badge variant="secondary" className="text-[10px] tabular-nums">
            {speedParams.genLength} tok × {speedParams.batchSize ?? 1}
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

/** 能力评测结果视图：总分大卡 + 题量统计 + 类别得分条形列表。 */
function EvalResultView({
  result,
  isRunning,
  engineLabel,
  evalParams,
}: {
  result: DisplayResult;
  isRunning: boolean;
  engineLabel: string;
  evalParams: { suite?: string; sampleSize?: number } | undefined;
}) {
  const t = useT();
  const summaryEval = result.summary?.eval;
  // 运行中读实时 eval 进度；结束后读落库汇总。
  const live = result.eval;
  const suite = summaryEval?.suite ?? live?.suite ?? (evalParams?.suite as EvalSuiteId | undefined) ?? "mmlu";
  const accuracy = summaryEval?.accuracy ?? live?.accuracy ?? 0;
  const correct = summaryEval?.correctCount ?? live?.correct ?? 0;
  const answered = summaryEval?.totalQuestions ?? live?.done ?? 0;
  const datasetTotal = summaryEval?.datasetTotal ?? live?.datasetTotal ?? 0;
  const sampleSize = evalParams?.sampleSize ?? live?.sampleSize ?? 0;
  const categories = result.evalRows ?? [];
  const failures = summaryEval?.failures ?? live?.failures ?? 0;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
      {/* 头部：模型 / 套件 / 引擎 / 状态 / 时间 */}
      <div className="flex flex-wrap items-center gap-2">
        <GraduationCapIcon className="size-4 text-primary" />
        <span className="text-sm font-semibold">{result.model}</span>
        <Badge variant="secondary" className="text-[10px]">
          {t(`benchmark.suite.${suite}`)}
        </Badge>
        <Badge variant="secondary" className="text-[10px]">
          {engineLabel}
        </Badge>
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

      {/* 总分大卡 */}
      <div className="flex flex-wrap items-stretch gap-3">
        <div className="flex min-w-40 flex-col justify-center rounded-lg border bg-card px-5 py-4">
          <p className="text-[10px] text-muted-foreground">{t("benchmark.eval.score")}</p>
          <p className="mt-1 text-3xl font-bold tabular-nums text-primary">
            {accuracy}
            <span className="text-base font-semibold">%</span>
          </p>
        </div>
        <div className="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-lg border bg-card px-3 py-2.5">
            <p className="text-[10px] text-muted-foreground">{t("benchmark.eval.correct")}</p>
            <p className="mt-0.5 text-sm font-semibold tabular-nums">
              {correct} / {answered}
            </p>
          </div>
          <div className="rounded-lg border bg-card px-3 py-2.5">
            <p className="text-[10px] text-muted-foreground">{t("benchmark.eval.questions")}</p>
            <p className="mt-0.5 text-sm font-semibold tabular-nums">
              {sampleSize > 0 ? sampleSize.toLocaleString() : (datasetTotal || answered).toLocaleString()}
              {datasetTotal > 0 && (
                <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                  / {datasetTotal.toLocaleString()}
                </span>
              )}
            </p>
          </div>
          <div className="rounded-lg border bg-card px-3 py-2.5">
            <p className="text-[10px] text-muted-foreground">{t("benchmark.eval.failures")}</p>
            <p className={cn("mt-0.5 text-sm font-semibold tabular-nums", failures > 0 && "text-destructive")}>
              {failures}
            </p>
          </div>
          <div className="rounded-lg border bg-card px-3 py-2.5">
            <p className="text-[10px] text-muted-foreground">{t("benchmark.eval.duration")}</p>
            <p className="mt-0.5 text-sm font-semibold tabular-nums">
              {result.durationMs != null ? `${Math.round(result.durationMs / 1000)}s` : "—"}
            </p>
          </div>
        </div>
      </div>

      {/* 类别得分 */}
      <div>
        <h3 className="mb-2 text-sm font-medium">{t("benchmark.eval.categories")}</h3>
        {categories.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">
            {t("benchmark.eval.noCategories")}
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {categories.map((c) => (
              <div key={c.category} className="flex items-center gap-2">
                <span className="w-40 shrink-0 truncate text-[11px] text-muted-foreground" title={c.category}>
                  {c.category}
                </span>
                <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      c.accuracy >= 60 ? "bg-emerald-500/70" : c.accuracy >= 30 ? "bg-primary/70" : "bg-destructive/60",
                    )}
                    style={{ width: `${Math.min(c.accuracy, 100)}%` }}
                  />
                </div>
                <span className="w-24 shrink-0 text-right font-mono text-[10px] tabular-nums">
                  {c.accuracy}% ({c.correct}/{c.total})
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
