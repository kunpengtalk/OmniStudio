import { desc, eq } from "drizzle-orm";
import { db } from "./db";
import { benchmarkRecords } from "./db/schema";
import {
  getSetting,
  getActiveServerPort,
  getActiveInferenceEngine,
} from "./db/settings";

export type BenchmarkParams = {
  model: string;
  batchSize?: number;
  genLength?: number;
  contexts?: number[];
  temperature?: number;
};

/** 单档上下文的完整指标行。tokens 均为 usage 精确值（无 usage 时回退 chunk 计数）。 */
export type SpeedBenchRow = {
  contextLength: number;
  /** 实际 prompt tokens（预热请求的 usage；拿不到时按 4 字符/token 估算）。 */
  promptTokens: number;
  batchSize: number;
  /** 平均首 token 延迟（ms）。 */
  ttftMs: number;
  /** 平均每 token 生成耗时（ms，不含首 token）。 */
  tpotMs: number;
  /** 单流生成吞吐（tok/s，各请求均值）。 */
  tps: number;
  /** 并发聚合吞吐（tok/s，总输出 tokens / 批次墙钟时间）。 */
  aggTps: number;
  /** Prefill 吞吐（tok/s，总 prompt tokens / 总 TTFT）。 */
  prefillTps: number;
  /** 批次合计输出 tokens。 */
  tokens: number;
  totalMs: number;
  ok: number;
  fails: number;
};

export type BenchmarkSummary = {
  avgTps: number;
  peakTps: number;
  avgTtftMs: number;
  bestTtftMs: number;
  peakAggTps: number;
  peakPrefillTps: number;
  totalTokens: number;
};

export type BenchmarkRunState = {
  runId: string;
  status: "running" | "done" | "cancelled" | "error";
  error?: string;
  startedAt: number;
  progress: {
    total: number;
    done: number;
    phase: "warmup" | "measure";
    currentContext?: number;
  };
  rows: SpeedBenchRow[];
  summary?: BenchmarkSummary;
  /** 结束后落库的记录 id。 */
  recordId?: number;
  /** 运行总耗时（ms，结束时写入）。 */
  durationMs?: number;
  model: string;
  serverMode: string;
  engine?: string;
  params: {
    genLength: number;
    batchSize: number;
    contexts: number[];
    temperature: number;
  };
};

export type BenchmarkRecordRow = {
  id: number;
  kind: "speed" | "eval";
  model: string;
  serverMode: string | null;
  engine: string | null;
  params: BenchmarkRunState["params"] | null;
  rows: SpeedBenchRow[] | null;
  summary: BenchmarkSummary | null;
  status: "done" | "cancelled" | "error";
  durationMs: number | null;
  error: string | null;
  createdAt: number;
};

const DEFAULT_CONTEXTS = [1024, 4096, 8192, 16384, 32768];
const CHARS_PER_TOKEN = 4;

export const BENCHMARK_PRESET_CONTEXTS = DEFAULT_CONTEXTS;

function buildPrompt(ctxTokens: number): string {
  const unit =
    "The quick brown fox jumps over the lazy dog while measuring transformer throughput and latency across multiple context sizes. ";
  const needed = Math.max(ctxTokens * CHARS_PER_TOKEN, unit.length);
  const repeats = Math.ceil(needed / unit.length);
  return unit.repeat(repeats).slice(0, needed);
}

/** 把任务取消信号与单请求超时合成一个 AbortSignal。 */
function combineSignals(cancel: AbortSignal, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(cancel.reason);
  if (cancel.aborted) onAbort();
  else cancel.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      cancel.removeEventListener("abort", onAbort);
    },
  };
}

type StreamStats = {
  ttftMs: number;
  tokens: number;
  promptTokens: number;
  totalMs: number;
};

/** 流式 chat/completions：精确到 usage（stream_options.include_usage），无 usage 时回退 chunk 计数。 */
async function timedStream(
  base: string,
  apiKey: string,
  model: string,
  prompt: string,
  genLength: number,
  temperature: number,
  cancel: AbortSignal,
): Promise<StreamStats> {
  const start = performance.now();
  const { signal, cleanup } = combineSignals(cancel, 600_000);
  let res: Response;
  try {
    res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: genLength,
        temperature,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal,
    });
  } finally {
    cleanup();
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Benchmark request failed (${res.status}): ${body.slice(0, 300)}`);
  }
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstTokenMs: number | null = null;
  let chunkCount = 0;
  let usageTokens: number | null = null;
  let usagePromptTokens: number | null = null;

  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      const json = JSON.parse(payload);
      const delta = json.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        if (firstTokenMs === null) firstTokenMs = performance.now();
        chunkCount += 1;
      }
      if (json.usage) {
        if (typeof json.usage.completion_tokens === "number") usageTokens = json.usage.completion_tokens;
        if (typeof json.usage.prompt_tokens === "number") usagePromptTokens = json.usage.prompt_tokens;
      }
    } catch {
      // skip malformed chunk
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        consumeLine(line);
      }
    }
    if (buffer.trim()) consumeLine(buffer);
  } finally {
    reader.cancel().catch(() => {});
  }

  const totalMs = performance.now() - start;
  const tokens = usageTokens ?? chunkCount;
  if (tokens <= 0) throw new Error("Benchmark stream produced no tokens");
  return {
    ttftMs: firstTokenMs !== null ? firstTokenMs - start : totalMs,
    tokens,
    promptTokens: usagePromptTokens ?? 0,
    totalMs,
  };
}

/** 非流式短请求：预热模型并拿该 prompt 的精确 prompt tokens。 */
async function warmupRequest(
  base: string,
  apiKey: string,
  model: string,
  prompt: string,
  cancel: AbortSignal,
): Promise<number> {
  const { signal, cleanup } = combineSignals(cancel, 120_000);
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1,
      }),
      signal,
    });
    if (!res.ok) return 0;
    const json = (await res.json().catch(() => null)) as { usage?: { prompt_tokens?: number } } | null;
    return typeof json?.usage?.prompt_tokens === "number" ? json.usage.prompt_tokens : 0;
  } catch {
    return 0;
  } finally {
    cleanup();
  }
}

type BatchOutcome = {
  row: SpeedBenchRow;
  hardError?: string;
};

async function runBatch(
  base: string,
  apiKey: string,
  model: string,
  ctx: number,
  genLength: number,
  batchSize: number,
  temperature: number,
  cancel: AbortSignal,
): Promise<BatchOutcome> {
  const prompt = buildPrompt(ctx);
  const promptTokens =
    (await warmupRequest(base, apiKey, model, prompt, cancel)) || Math.floor(prompt.length / CHARS_PER_TOKEN);

  const wallStart = performance.now();
  const settled = await Promise.allSettled(
    Array.from({ length: batchSize }).map(() => timedStream(base, apiKey, model, prompt, genLength, temperature, cancel)),
  );
  const okStats = settled
    .filter((s): s is PromiseFulfilledResult<StreamStats> => s.status === "fulfilled")
    .map((s) => s.value);
  const fails = settled.length - okStats.length;
  // 全部失败：若是用户主动取消则按取消处理，否则上报首个错误。
  if (okStats.length === 0) {
    if (cancel.aborted) return { row: emptyRow(ctx, batchSize), hardError: "cancelled" };
    const first = settled.find((s) => s.status === "rejected") as PromiseRejectedResult | undefined;
    return {
      row: emptyRow(ctx, batchSize),
      hardError: first ? String(first.reason?.message ?? first.reason) : "all requests failed",
    };
  }

  const totalTokens = okStats.reduce((s, r) => s + r.tokens, 0);
  const ttftAvg = okStats.reduce((s, r) => s + r.ttftMs, 0) / okStats.length;
  const avgTotalMs = okStats.reduce((s, r) => s + r.totalMs, 0) / okStats.length;
  // 首 token 已计入 TTFT，之后每 token 平均耗时按 (tokens-1) 摊。
  const genTimeTotal = okStats.reduce((s, r) => s + (r.totalMs - r.ttftMs), 0);
  const genTokensTotal = okStats.reduce((s, r) => s + Math.max(r.tokens - 1, 1), 0);
  const wallMs = Math.max(performance.now() - wallStart, ...okStats.map((r) => r.totalMs));

  return {
    row: {
      contextLength: ctx,
      promptTokens,
      batchSize,
      ttftMs: Math.round(ttftAvg),
      tpotMs: Number((genTimeTotal / genTokensTotal).toFixed(3)),
      tps: Number((totalTokens / okStats.length / (avgTotalMs / 1000)).toFixed(1)),
      aggTps: Number((totalTokens / (wallMs / 1000)).toFixed(1)),
      prefillTps: Number(((promptTokens * okStats.length * 1000) / Math.max(ttftAvg, 1)).toFixed(1)),
      tokens: totalTokens,
      totalMs: Math.round(avgTotalMs),
      ok: okStats.length,
      fails,
    },
  };
}

function emptyRow(ctx: number, batchSize: number): SpeedBenchRow {
  return {
    contextLength: ctx,
    promptTokens: 0,
    batchSize,
    ttftMs: 0,
    tpotMs: 0,
    tps: 0,
    aggTps: 0,
    prefillTps: 0,
    tokens: 0,
    totalMs: 0,
    ok: 0,
    fails: batchSize,
  };
}

function summarize(rows: SpeedBenchRow[]): BenchmarkSummary {
  if (rows.length === 0) {
    return { avgTps: 0, peakTps: 0, avgTtftMs: 0, bestTtftMs: 0, peakAggTps: 0, peakPrefillTps: 0, totalTokens: 0 };
  }
  return {
    avgTps: Number((rows.reduce((s, r) => s + r.tps, 0) / rows.length).toFixed(1)),
    peakTps: Math.max(...rows.map((r) => r.tps)),
    avgTtftMs: Math.round(rows.reduce((s, r) => s + r.ttftMs, 0) / rows.length),
    bestTtftMs: Math.min(...rows.map((r) => r.ttftMs)),
    peakAggTps: Math.max(...rows.map((r) => r.aggTps)),
    peakPrefillTps: Math.max(...rows.map((r) => r.prefillTps)),
    totalTokens: rows.reduce((s, r) => s + r.tokens, 0),
  };
}

// ---------------------------------------------------------------------------
// 任务管理：同一时刻只允许一个运行中的基准任务；结束后状态保留在内存供
// 前端拉取（历史以 SQLite 记录为准）。
// ---------------------------------------------------------------------------

type ActiveRun = { state: BenchmarkRunState; cancel: AbortController };

const runs = new Map<string, ActiveRun>();
let runCounter = 0;

export function startBenchmark(params: BenchmarkParams): { runId: string } | { error: string } {
  for (const run of runs.values()) {
    if (run.state.status === "running") return { error: "benchmark_already_running" };
  }

  const serverMode = getSetting("SERVER_MODE") === "remote" ? "remote" : "local";
  const engine = serverMode === "local" ? getActiveInferenceEngine() : undefined;
  const base =
    serverMode === "remote"
      ? (getSetting("VLLM_API_BASE") || "").replace(/\/$/, "").replace(/\/v1$/, "")
      : `http://localhost:${getActiveServerPort()}`;
  const apiKey = serverMode === "remote" ? getSetting("VLLM_API_KEY") || "EMPTY" : "EMPTY";

  if (!base) return { error: "No inference server configured" };
  const model = params.model || getSetting("CHAT_MODEL") || getSetting("VLLM_MODEL_NAME");
  if (!model) return { error: "No model configured" };

  const batchSize = Math.max(params.batchSize ?? 1, 1);
  const genLength = Math.max(params.genLength ?? 128, 16);
  const temperature = params.temperature ?? 0;
  const contexts = (params.contexts?.length ? params.contexts : DEFAULT_CONTEXTS)
    .map((c) => Math.max(c, 128))
    .sort((a, b) => a - b);

  const runId = `bench-${Date.now()}-${++runCounter}`;
  const cancel = new AbortController();
  const state: BenchmarkRunState = {
    runId,
    status: "running",
    startedAt: Date.now(),
    progress: { total: contexts.length, done: 0, phase: "warmup" },
    rows: [],
    model,
    serverMode,
    engine,
    params: { genLength, batchSize, contexts, temperature },
  };
  runs.set(runId, { state, cancel });
  // 只保留最近几个已结束任务，避免内存增长。
  for (const [id, run] of runs) {
    if (run.state.status !== "running" && runs.size > 3 && id !== runId) runs.delete(id);
  }

  void executeRun(runId, { base, apiKey, model, genLength, batchSize, contexts, temperature, cancel, state });
  return { runId };
}

async function executeRun(
  runId: string,
  env: {
    base: string;
    apiKey: string;
    model: string;
    genLength: number;
    batchSize: number;
    contexts: number[];
    temperature: number;
    cancel: AbortController;
    state: BenchmarkRunState;
  },
) {
  const { state, cancel } = env;
  const { base, apiKey, model, genLength, batchSize, contexts, temperature } = env;
  try {
    for (let i = 0; i < contexts.length; i++) {
      if (cancel.signal.aborted) break;
      const ctx = contexts[i]!;
      state.progress = { total: contexts.length, done: i, phase: "warmup", currentContext: ctx };
      const outcome = await runBatch(base, apiKey, model, ctx, genLength, batchSize, temperature, cancel.signal);
      if (outcome.hardError === "cancelled") break;
      if (outcome.hardError) throw new Error(outcome.hardError);
      state.rows.push(outcome.row);
      state.progress = { total: contexts.length, done: i + 1, phase: "measure", currentContext: ctx };
    }
    state.status = cancel.signal.aborted ? "cancelled" : "done";
  } catch (e) {
    state.status = cancel.signal.aborted ? "cancelled" : "error";
    state.error = e instanceof Error ? e.message : String(e);
  }

  state.durationMs = Date.now() - state.startedAt;
  const durationMs = state.durationMs;
  state.summary = summarize(state.rows);
  // 取消时已完成的档位仍有价值，一并落库。
  if (state.rows.length > 0 || state.status === "error") {
    try {
      const inserted = db
        .insert(benchmarkRecords)
        .values({
          kind: "speed",
          model: state.model,
          serverMode: state.serverMode,
          engine: state.engine ?? null,
          params: JSON.stringify(state.params),
          rows: JSON.stringify(state.rows),
          summary: JSON.stringify(state.summary),
          status: state.status,
          durationMs,
          error: state.error ?? null,
        })
        .returning({ id: benchmarkRecords.id })
        .get();
      state.recordId = inserted?.id;
    } catch (e) {
      // 落库失败不影响已测得的指标展示。
      state.error = state.error ?? `save failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}

export function getBenchmarkRun(runId: string): BenchmarkRunState | null {
  return runs.get(runId)?.state ?? null;
}

export function cancelBenchmark(runId: string): { ok: boolean } {
  const run = runs.get(runId);
  if (!run || run.state.status !== "running") return { ok: false };
  run.cancel.abort(new Error("cancelled"));
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 历史记录 CRUD
// ---------------------------------------------------------------------------

function parseRecord(r: typeof benchmarkRecords.$inferSelect): BenchmarkRecordRow {
  return {
    id: r.id,
    kind: r.kind,
    model: r.model,
    serverMode: r.serverMode,
    engine: r.engine,
    params: r.params ? JSON.parse(r.params) : null,
    rows: r.rows ? JSON.parse(r.rows) : null,
    summary: r.summary ? JSON.parse(r.summary) : null,
    status: r.status,
    durationMs: r.durationMs,
    error: r.error,
    createdAt: r.createdAt ?? 0,
  };
}

export function listBenchmarkRecords(): BenchmarkRecordRow[] {
  return db
    .select()
    .from(benchmarkRecords)
    .orderBy(desc(benchmarkRecords.createdAt))
    .all()
    .map(parseRecord);
}

export function deleteBenchmarkRecord(id: number): { ok: boolean } {
  db.delete(benchmarkRecords).where(eq(benchmarkRecords.id, id)).run();
  return { ok: true };
}

export function clearBenchmarkRecords(): { ok: boolean } {
  db.delete(benchmarkRecords).run();
  return { ok: true };
}
