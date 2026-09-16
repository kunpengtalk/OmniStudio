import { ActivityIcon, GraduationCapIcon, SquareIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { fmtMb } from "./parts";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import { Spinner } from "@ui/spinner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { BENCHMARK_CACHE_MODES, BENCHMARK_MAX_CONTEXT, BENCHMARK_MIN_CONTEXT, fmtCtx } from "@/shared/benchmark";
import { cn } from "@/mainview/lib/utils";
import { SegmentedControl } from "@components/segmented-control";
import type { BenchmarkConfig } from "./use-benchmark-config";

/** 左栏配置面板：测速 / 评测的全部参数与启动按钮。 */
export function BenchmarkConfigPanel({ cfg }: { cfg: BenchmarkConfig }) {
  const {
    t, mode, setMode, source, setSource, isRunning, modelOptions, effectiveModel, setModel, providers, setRoute, providerId, setProviderId, providerIncomplete, providerKeyMissing, cloudModelOptions, effectiveCloudModel, setCloudModel, genLength, setGenLength, batchSize, setBatchSize, chipContexts, isPresetCtx, contexts, toggleContext, customCtx, setCustomCtx, customCtxError, setCustomCtxError, addCustomContext, overWindow, serverWindow, cacheModes, toggleCacheMode, evalSuitesQuery, suite, setSuite, sampleSize, setSampleSize, evalConcurrency, setEvalConcurrency, selectedSuiteInfo, startRun, startError, run,
  } = cfg;
  return (
    <>
        {/* 左：340px 配置面板（与其他工具页同款布局） */}
        <aside className="w-[340px] shrink-0 overflow-y-auto border-r p-4">
          <div className="flex flex-col gap-5">
            <div>
              <Label className="mb-1.5 block text-xs">{t("benchmark.tab")}</Label>
              <SegmentedControl
                variant="attached"
                disabled={isRunning}
                value={mode}
                onChange={setMode}
                options={[
                  { value: "speed", label: t("benchmark.tab.speed") },
                  { value: "eval", label: t("benchmark.tab.eval") },
                ]}
              />
            </div>
  
            <div>
              <Label className="mb-1.5 block text-xs">{t("benchmark.source")}</Label>
              <SegmentedControl
                variant="attached"
                disabled={isRunning}
                value={source}
                onChange={setSource}
                options={[
                  { value: "local", label: t("benchmark.source.local") },
                  { value: "cloud", label: t("benchmark.source.cloud") },
                ]}
              />
            </div>
  
            {source === "local" ? (
              <div>
                <Label htmlFor="benchModel" className="mb-1.5 block text-xs">
                  {t("benchmark.model")}
                </Label>
                {modelOptions.length === 0 ? (
                  <div className="rounded-lg border border-dashed px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                    {t("benchmark.noLocalModels")}
                  </div>
                ) : (
                  <Select
                    value={effectiveModel || undefined}
                    onValueChange={setModel}
                    disabled={isRunning}
                  >
                    <SelectTrigger id="benchModel" className="h-8 w-full text-xs">
                      <SelectValue placeholder={t("benchmark.modelPlaceholder")} />
                    </SelectTrigger>
                    <SelectContent className="max-w-96">
                      {/* 当前值不在已装清单里（HF repo id、手工填的名字）：占一行，别让它看起来像没选 */}
                      {effectiveModel !== "" && !modelOptions.includes(effectiveModel) && (
                        <SelectItem value={effectiveModel}>
                          <span className="min-w-0 flex-1 truncate">{effectiveModel}</span>
                          <span className="shrink-0 text-[10px] text-muted-foreground/70">
                            {t("defaults.current")}
                          </span>
                        </SelectItem>
                      )}
                      {modelOptions.map((m) => (
                        <SelectItem key={m} value={m}>
                          <span className="min-w-0 flex-1 truncate">{m}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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
  
                {/* 一个服务商都没配时上面那行已经说清楚了：不摆一个空的模型框 */}
                {providers.length > 0 && (
                  <div>
                    <Label htmlFor="benchCloudModel" className="mb-1.5 block text-xs">
                      {t("benchmark.model")}
                    </Label>
                    {cloudModelOptions.length === 0 ? (
                      <div className="rounded-lg border border-dashed px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                        {t("benchmark.cloud.noModels")}
                      </div>
                    ) : (
                      <Select
                        value={effectiveCloudModel || undefined}
                        onValueChange={setCloudModel}
                        disabled={isRunning}
                      >
                        <SelectTrigger id="benchCloudModel" className="h-8 w-full text-xs">
                          <SelectValue placeholder={t("benchmark.cloud.modelPlaceholder")} />
                        </SelectTrigger>
                        <SelectContent className="max-w-96">
                          {cloudModelOptions.map((m) => (
                            <SelectItem key={m} value={m}>
                              <span className="min-w-0 flex-1 truncate">{m}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                )}
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
                    {chipContexts.map((c) => (
                      <button
                        key={c}
                        type="button"
                        disabled={isRunning}
                        title={isPresetCtx(c) ? undefined : t("benchmark.contexts.customChip")}
                        onClick={() => toggleContext(c)}
                        className={cn(
                          "rounded-full border px-2.5 py-1 text-xs transition-colors",
                          contexts.includes(c)
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
                          !isPresetCtx(c) && "border-dashed",
                        )}
                      >
                        {fmtCtx(c)}
                      </button>
                    ))}
                  </div>
                  {/* 自定义档位：预设里没有的长度（如 200k / 1.5m 这种非 2 的幂） */}
                  <div className="mt-2 flex items-center gap-1.5">
                    <Input
                      id="benchCtxCustom"
                      type="text"
                      inputMode="numeric"
                      placeholder={t("benchmark.contexts.customPlaceholder")}
                      value={customCtx}
                      disabled={isRunning}
                      onChange={(e) => {
                        setCustomCtx(e.target.value);
                        setCustomCtxError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addCustomContext();
                        }
                      }}
                      className="h-7 flex-1 text-xs"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-[11px]"
                      disabled={isRunning || customCtx.trim() === ""}
                      onClick={addCustomContext}
                    >
                      {t("benchmark.contexts.add")}
                    </Button>
                  </div>
                  {customCtxError ? (
                    <p className="mt-1 text-[11px] leading-relaxed text-destructive">{customCtxError}</p>
                  ) : overWindow.length > 0 ? (
                    <p className="mt-1 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
                      {t("benchmark.contexts.overWindow", {
                        window: fmtCtx(serverWindow!),
                        count: String(overWindow.length),
                      })}
                    </p>
                  ) : (
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                      {t("benchmark.contexts.hint", {
                        min: String(BENCHMARK_MIN_CONTEXT),
                        max: fmtCtx(BENCHMARK_MAX_CONTEXT),
                      })}
                    </p>
                  )}
                </div>
  
                <div>
                  <Label className="mb-1.5 block text-xs">{t("benchmark.cache")}</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {BENCHMARK_CACHE_MODES.map((m) => (
                      <button
                        key={m}
                        type="button"
                        disabled={isRunning}
                        onClick={() => toggleCacheMode(m)}
                        className={cn(
                          "rounded-full border px-2.5 py-1 text-xs transition-colors",
                          cacheModes.includes(m)
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
                        )}
                      >
                        {t(`benchmark.cache.${m}`)}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    {t("benchmark.cache.hint", { count: String(contexts.length * cacheModes.length) })}
                  </p>
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
                        {
                          ctx: `${fmtCtx(run.progress.currentContext ?? 0)}${
                            run.progress.currentCache ? ` · ${t(`benchmark.cache.${run.progress.currentCache}`)}` : ""
                          }`,
                        },
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
    </>
  );
}
