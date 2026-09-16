import { Badge } from "@ui/badge";
import { GaugeIcon, GraduationCapIcon } from "lucide-react";
import { fmtCtx } from "@/shared/benchmark";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import { ReportExportButton } from "./export-button";
import { cacheRowsOf, engineLabelOf, evalReportStats, speedReportNotes } from "./report-data";
import { fmtTime, type DisplayResult } from "./parts";

const STATUS_STYLES: Record<DisplayResult["status"], string> = {
  running: "bg-primary/10 text-primary",
  done: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  cancelled: "bg-muted text-muted-foreground",
  error: "bg-destructive/10 text-destructive",
};

export function ResultView({
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
  const engineLabel = engineLabelOf(result, t);
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

  // 每一档的"为什么没数据/数据不可信"：失败原因与静默截断都不能只体现在数字里。
  const notes = speedReportNotes(result, t);

  // 缓存对比：同档位下"冷启 vs 命中"的差就是缓存买到的速度。
  const cacheRows = cacheRowsOf(result);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
      {/* 头部：模型 / 引擎 / 时间 / 状态 / 导出 */}
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
        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs tabular-nums text-muted-foreground">{fmtTime(result.createdAt)}</span>
          <ReportExportButton result={result} />
        </div>
      </div>

      {result.error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-xs text-destructive">
          {result.error}
        </div>
      )}

      {/* 汇总卡（平均 / 最佳只取一种缓存场景，标题里写清是哪一种） */}
      {cards.length > 0 && (
        <div>
          {summary?.basis && (
            <p className="mb-1.5 text-[10px] text-muted-foreground">
              {t("benchmark.summaryBasis", { basis: t(`benchmark.cache.${summary.basis}`) })}
            </p>
          )}
          <div className="grid grid-cols-3 gap-3 lg:grid-cols-6">
            {cards.map((c) => (
              <div key={c.label} className="rounded-lg border bg-card px-3 py-2.5">
                <p className="text-[10px] text-muted-foreground">{c.label}</p>
                <p className="mt-0.5 text-sm font-semibold tabular-nums">{c.value}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 档位级的注意项：失败原因 / 截断 / 提前收尾 */}
      {notes.length > 0 && (
        <div className="flex flex-col gap-1 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
          <p className="text-[10px] font-medium text-amber-700 dark:text-amber-400">{t("benchmark.notes")}</p>
          {notes.map((n) => (
            <p
              key={n.key}
              className={cn(
                "text-[11px] leading-relaxed",
                n.tone === "error" ? "text-destructive" : "text-amber-700 dark:text-amber-400",
              )}
            >
              {n.text}
            </p>
          ))}
        </div>
      )}

      {/* 缓存命中对比：同一档位下"冷启 vs 命中"的差就是缓存买到的速度 */}
      {cacheRows.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-medium">{t("benchmark.cacheCompare")}</h3>
          <div className="flex flex-col gap-1.5">
            {cacheRows.map((c) => (
              <div
                key={c.contextLength}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-card px-3 py-2 text-xs"
              >
                <span className="w-10 shrink-0 font-mono text-[10px] text-muted-foreground">
                  {fmtCtx(c.contextLength)}
                </span>
                {c.cold && (
                  <span className="tabular-nums text-muted-foreground">
                    {t("benchmark.cache.cold")} {c.cold.ttftMs} ms
                  </span>
                )}
                {c.partial && (
                  <span className="tabular-nums">
                    {t("benchmark.cache.partial")} {c.partial.ttftMs} ms
                    {c.partialSpeedup != null && (
                      <span className="ml-1 text-emerald-600 dark:text-emerald-400">×{c.partialSpeedup}</span>
                    )}
                  </span>
                )}
                {c.warm && (
                  <span className="tabular-nums">
                    {t("benchmark.cache.warm")} {c.warm.ttftMs} ms
                    {c.warmSpeedup != null && (
                      <span className="ml-1 text-emerald-600 dark:text-emerald-400">×{c.warmSpeedup}</span>
                    )}
                  </span>
                )}
                {/* 服务端自报的复用比例（llama.cpp 才有）：直接回答"到底命中了多少" */}
                {c.warmReuseRatio != null && (
                  <span className="ml-auto text-[11px] text-muted-foreground">
                    {t("benchmark.cacheCompare.reuse", {
                      percent: String(Math.round(c.warmReuseRatio * 100)),
                    })}
                  </span>
                )}
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{t("benchmark.cacheCompare.hint")}</p>
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
                  <th className="px-2 py-1.5 font-medium">{t("benchmark.col.cache")}</th>
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
                  <tr key={`${r.contextLength}-${r.cache ?? "legacy"}`} className="border-b border-muted/50">
                    <td className="px-2 py-1.5 tabular-nums">
                      <span className={cn(r.error && "text-destructive", !r.error && r.truncated && "text-amber-600 dark:text-amber-400")}>
                        {fmtCtx(r.contextLength)}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-muted-foreground">
                      {t(`benchmark.cache.${r.cache ?? "warm"}`)}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                      <span title={r.truncated ? t("benchmark.note.truncated", { ctx: fmtCtx(r.contextLength), actual: r.promptTokens.toLocaleString() }) : undefined}>
                        {r.promptTokens}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{r.batchSize}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{r.ttftMs}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{r.tpotMs}</td>
                    <td className="px-2 py-1.5 text-right font-semibold tabular-nums text-primary">{r.tps}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{r.aggTps}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{r.prefillTps}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{r.tokens}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {r.fails > 0 ? (
                        <span className="text-destructive" title={r.error}>
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
              <div key={`${r.contextLength}-${r.cache ?? "legacy"}`} className="flex items-center gap-2">
                <span className="w-10 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
                  {fmtCtx(r.contextLength)}
                </span>
                <span className="w-16 shrink-0 text-[10px] text-muted-foreground">
                  {t(`benchmark.cache.${r.cache ?? "warm"}`)}
                </span>
                {/* 失败档位没有 TPS 可比：空条 + 破折号，别画成一根 0 的柱子 */}
                <div className="h-2.5 flex-1 rounded-full bg-muted">
                  {r.ok > 0 && (
                    <div
                      className="h-full rounded-full bg-primary/70"
                      style={{ width: `${(r.tps / maxTps) * 100}%` }}
                    />
                  )}
                </div>
                <span
                  className={cn(
                    "w-16 shrink-0 font-mono text-[10px] tabular-nums",
                    r.ok === 0 && "text-destructive",
                  )}
                  title={r.error}
                >
                  {r.ok === 0 ? "—" : `${r.tps} tps`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** 能力评测结果视图：总分大卡 + 题量统计 + 类别得分条形列表。 */
export function EvalResultView({
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
  // 运行中读实时 eval 进度；结束后读落库汇总。
  const stats = evalReportStats(result, evalParams);
  const { suite, accuracy, correct, answered, datasetTotal, sampleSize, failures } = stats;
  const categories = result.evalRows ?? [];

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
      {/* 头部：模型 / 套件 / 引擎 / 状态 / 时间 / 导出 */}
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
        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs tabular-nums text-muted-foreground">{fmtTime(result.createdAt)}</span>
          <ReportExportButton result={result} />
        </div>
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
