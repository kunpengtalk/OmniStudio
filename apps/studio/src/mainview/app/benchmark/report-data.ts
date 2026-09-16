import { cacheComparison, fmtCtx } from "@/shared/benchmark";
import type { EvalSuiteId } from "../../../bun/eval";
import type { DisplayResult } from "./parts";

/** 报告里的翻译函数（`useT()` 的返回值，或任何等价的 key → 文案）。 */
export type ReportT = (key: string, params?: Record<string, string>) => string;

/**
 * 推理后端的展示名：本地引擎 / 激活的服务商 / 按 id 直连的服务商。
 *
 * 界面表头和导出的 HTML 报告都读这一份 —— 两处各写一遍的话，报告里写着
 * "本地 llama.cpp" 而界面写着"云端 · 某某"就没人发现。
 */
export function engineLabelOf(result: DisplayResult, t: ReportT): string {
  if (result.serverMode === "cloud") return t("benchmark.mode.cloud", { provider: result.engine ?? "" });
  if (result.serverMode === "remote") return t("benchmark.mode.remote");
  return t("benchmark.mode.local", { engine: result.engine ?? "llama.cpp" });
}

export type ReportNote = { key: string; text: string; tone: "error" | "warn" };

/**
 * 档位级的"为什么没数据 / 数据为什么不可信"。
 *
 * 失败原因与静默截断都不能只体现在数字里；导出的报告同样要带上，否则
 * 分享出去的那份 HTML 看起来像"每一档都测得好好的"。
 */
export function speedReportNotes(result: DisplayResult, t: ReportT): ReportNote[] {
  const notes: ReportNote[] = [];
  const stopped = result.summary?.stopped;
  if (stopped) {
    notes.push({
      key: "stopped",
      tone: stopped.reason === "context-overflow" ? "warn" : "error",
      text: t(
        stopped.reason === "context-overflow"
          ? "benchmark.note.stopped.overflow"
          : "benchmark.note.stopped.timeout",
        { ctx: fmtCtx(stopped.contextLength) },
      ),
    });
  }
  for (const r of result.rows) {
    if (r.error) {
      notes.push({
        key: `error-${r.contextLength}-${r.cache ?? ""}`,
        tone: "error",
        text: t("benchmark.note.failed", { ctx: fmtCtx(r.contextLength), error: r.error }),
      });
    }
    if (r.truncated) {
      notes.push({
        key: `truncated-${r.contextLength}`,
        tone: "warn",
        text: t("benchmark.note.truncated", {
          ctx: fmtCtx(r.contextLength),
          actual: r.promptTokens.toLocaleString(),
        }),
      });
    }
  }
  // 缓存对比：同一档位下"冷启 vs 命中"的差就是缓存买到的速度。命中档没有变快时
  // 单独提示 —— 那说明这台服务端根本没吃到前缀缓存，是排查配置的第一步。
  for (const c of cacheRowsOf(result)) {
    if (c.warmSpeedup != null && c.warmSpeedup < 1.2) {
      notes.push({
        key: `nocache-${c.contextLength}`,
        tone: "warn",
        text: t("benchmark.note.noCacheGain", {
          ctx: fmtCtx(c.contextLength),
          speedup: String(c.warmSpeedup),
        }),
      });
    }
  }
  return notes;
}

/** 能横向比较的档位（至少两种缓存场景都测出来了）。 */
export function cacheRowsOf(result: DisplayResult) {
  return cacheComparison(result.rows).filter(
    (c) => (c.cold ? 1 : 0) + (c.partial ? 1 : 0) + (c.warm ? 1 : 0) > 1,
  );
}

export type EvalReportStats = {
  suite: EvalSuiteId;
  accuracy: number;
  correct: number;
  answered: number;
  datasetTotal: number;
  sampleSize: number;
  failures: number;
};

/** 评测结果的关键数字：跑动中读实时进度，跑完读落库汇总，都没有才回落到参数。 */
export function evalReportStats(
  result: DisplayResult,
  evalParams?: { suite?: string; sampleSize?: number },
): EvalReportStats {
  const summaryEval = result.summary?.eval;
  const live = result.eval;
  return {
    suite: summaryEval?.suite ?? live?.suite ?? (evalParams?.suite as EvalSuiteId | undefined) ?? "mmlu",
    accuracy: summaryEval?.accuracy ?? live?.accuracy ?? 0,
    correct: summaryEval?.correctCount ?? live?.correct ?? 0,
    answered: summaryEval?.totalQuestions ?? live?.done ?? 0,
    datasetTotal: summaryEval?.datasetTotal ?? live?.datasetTotal ?? 0,
    sampleSize: evalParams?.sampleSize ?? live?.sampleSize ?? 0,
    failures: summaryEval?.failures ?? live?.failures ?? 0,
  };
}
