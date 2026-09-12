import { desc, eq } from "drizzle-orm";
import { db } from "./db";
import { benchmarkRecords } from "./db/schema";
import {
  getSetting,
  getActiveServerPort,
  getActiveInferenceEngine,
} from "./db/settings";
import { getCloudProviderInfo } from "./cloud-providers";
import {
  ensureEvalData,
  evalDataReady,
  loadEvalSuite,
  runEvalQuestions,
  stripThinkTags,
  type EvalCategoryRow,
  type EvalSuiteId,
} from "./eval";

export type BenchmarkParams = {
  model: string;
  /** 指定 cloud_providers 行 id 时直连该云服务商测速（无需全局激活）。 */
  providerId?: string;
  batchSize?: number;
  genLength?: number;
  contexts?: number[];
  temperature?: number;
  /** 缺省 speed = 速度扫描；eval = 能力评测（suite 必填）。 */
  mode?: "speed" | "eval";
  suite?: EvalSuiteId;
  /** 评测抽样题数；0 = 全量。 */
  sampleSize?: number;
  /** 评测并发跑题数。 */
  concurrency?: number;
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
  /** kind='eval' 时有值（速度字段全 0）。 */
  eval?: {
    suite: EvalSuiteId;
    accuracy: number;
    correctCount: number;
    totalQuestions: number;
    datasetTotal: number;
    failures: number;
  };
};

/** 能力评测的运行时进度（BenchmarkRunState.eval）。 */
export type BenchmarkEvalInfo = {
  suite: EvalSuiteId;
  sampleSize: number;
  total: number;
  done: number;
  correct: number;
  accuracy: number;
  datasetTotal: number;
  failures: number;
  /** 题库下载阶段进度（phase=download 时有值）。 */
  download?: { received: number; total: number };
};

export type BenchmarkRunState = {
  runId: string;
  status: "running" | "done" | "cancelled" | "error";
  error?: string;
  startedAt: number;
  kind: "speed" | "eval";
  progress: {
    total: number;
    done: number;
    phase: "warmup" | "measure";
    currentContext?: number;
  };
  rows: SpeedBenchRow[];
  /** eval 任务的类别得分行。 */
  evalRows?: EvalCategoryRow[];
  summary?: BenchmarkSummary;
  /** 结束后落库的记录 id。 */
  recordId?: number;
  /** 运行总耗时（ms，结束时写入）。 */
  durationMs?: number;
  /** eval 任务的实时进度。 */
  eval?: BenchmarkEvalInfo;
  model: string;
  /** local（本地引擎）/ remote（激活的云服务商槽位）/ cloud（按 id 直连的云服务商）。 */
  serverMode: string;
  engine?: string;
  params: Record<string, unknown>;
};

export type BenchmarkRecordRow = {
  id: number;
  kind: "speed" | "eval";
  model: string;
  serverMode: string | null;
  engine: string | null;
  params: Record<string, unknown> | null;
  rows: SpeedBenchRow[] | EvalCategoryRow[];
  summary: BenchmarkSummary | null;
  status: "done" | "cancelled" | "error";
  durationMs: number | null;
  error: string | null;
  createdAt: number;
};

const DEFAULT_CONTEXTS = [1024, 4096, 8192, 16384, 32768];
const CHARS_PER_TOKEN = 4;

export const BENCHMARK_PRESET_CONTEXTS = DEFAULT_CONTEXTS;

/** 去掉尾斜杠与 /v1 后缀，统一成拼接 /v1/chat/completions 的形态。 */
function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

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

// ---------------------------------------------------------------------------
// 云 API 参数兼容：不同厂商对 OpenAI 参数的支持参差（如 gpt-5 系列只认
// max_completion_tokens，部分厂商不认 stream_options）。首次 400 时按错误
// 文案自动降级重试一次，结果按 base 缓存，同服务商后续请求直接用兼容形态。
// ---------------------------------------------------------------------------

type CloudCompat = { maxCompletionTokens: boolean; noStreamOptions: boolean };
const compatByBase = new Map<string, CloudCompat>();

function compatFor(base: string): CloudCompat {
  let c = compatByBase.get(base);
  if (!c) {
    c = { maxCompletionTokens: false, noStreamOptions: false };
    compatByBase.set(base, c);
  }
  return c;
}

/** 从 400 错误文案推断需要的参数降级；无需调整时返回 null。 */
function adaptCompat(c: CloudCompat, errText: string): Partial<CloudCompat> | null {
  const t = errText.toLowerCase();
  if (!c.maxCompletionTokens && t.includes("max_completion_tokens")) return { maxCompletionTokens: true };
  if (!c.noStreamOptions && t.includes("stream_options")) return { noStreamOptions: true };
  return null;
}

async function chatFetch(
  base: string,
  apiKey: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  const make = (c: CloudCompat) => {
    const b = { ...body };
    if (c.maxCompletionTokens) {
      b.max_completion_tokens = b.max_tokens;
      delete b.max_tokens;
    }
    if (c.noStreamOptions) delete b.stream_options;
    return b;
  };
  const send = (bodyStr: string) =>
    fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: bodyStr,
      signal,
    });

  const compat = compatFor(base);
  let bodyStr = JSON.stringify(make(compat));
  let res = await send(bodyStr);
  // 最多两轮降级：max_tokens→max_completion_tokens、去掉 stream_options。
  for (let attempt = 0; attempt < 2 && res.status === 400; attempt++) {
    const text = await res.text().catch(() => "");
    const patch = adaptCompat(compat, text);
    if (patch) Object.assign(compat, patch);
    // 并发下 flags 可能已被其他请求降级：按最新形态重建，请求体确实变化才重试。
    const nextStr = JSON.stringify(make(compat));
    if (nextStr === bodyStr) {
      throw new Error(`Benchmark request failed (400): ${text.slice(0, 300)}`);
    }
    bodyStr = nextStr;
    res = await send(bodyStr);
  }
  if (res.status === 400) {
    const text = await res.text().catch(() => "");
    throw new Error(`Benchmark request failed (400): ${text.slice(0, 300)}`);
  }
  return res;
}

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
    res = await chatFetch(
      base,
      apiKey,
      {
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: genLength,
        temperature,
        stream: true,
        stream_options: { include_usage: true },
      },
      signal,
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Benchmark request failed (${res.status}): ${body.slice(0, 300)}`);
    }
  } finally {
    cleanup();
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
    const res = await chatFetch(
      base,
      apiKey,
      {
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1,
      },
      signal,
    );
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

  // 目标解析：providerId 直连 cloud_providers 行（不改变全局激活状态）；
  // 未指定时沿用全局 SERVER_MODE / VLLM_* 槽位。
  let serverMode: string;
  let engine: string | undefined;
  let base: string;
  let apiKey: string;
  if (params.providerId) {
    const provider = getCloudProviderInfo(params.providerId);
    if (!provider) return { error: "Cloud provider not found" };
    serverMode = "cloud";
    engine = provider.name;
    base = normalizeBase(provider.baseUrl);
    apiKey = provider.apiKey || "EMPTY";
  } else {
    serverMode = getSetting("SERVER_MODE") === "remote" ? "remote" : "local";
    engine = serverMode === "local" ? getActiveInferenceEngine() : undefined;
    base =
      serverMode === "remote"
        ? normalizeBase(getSetting("VLLM_API_BASE") || "")
        : `http://localhost:${getActiveServerPort()}`;
    apiKey = serverMode === "remote" ? getSetting("VLLM_API_KEY") || "EMPTY" : "EMPTY";
  }

  if (!base) return { error: "No inference server configured" };
  const model = params.providerId
    ? params.model.trim()
    : params.model || getSetting("CHAT_MODEL") || getSetting("VLLM_MODEL_NAME");
  if (!model) return { error: "No model configured" };

  const batchSize = Math.max(params.batchSize ?? 1, 1);
  const genLength = Math.max(params.genLength ?? 128, 16);
  const temperature = params.temperature ?? 0;
  const contexts = (params.contexts?.length ? params.contexts : DEFAULT_CONTEXTS)
    .map((c) => Math.max(c, 128))
    .sort((a, b) => a - b);

  const kind: "speed" | "eval" = params.mode === "eval" ? "eval" : "speed";
  if (kind === "eval" && !params.suite) return { error: "eval suite required" };
  const suite = params.suite ?? "mmlu";
  const sampleSize = Math.max(params.sampleSize ?? 0, 0);
  const concurrency = Math.max(params.concurrency ?? 4, 1);

  const runId = `bench-${Date.now()}-${++runCounter}`;
  const cancel = new AbortController();
  const state: BenchmarkRunState = {
    runId,
    status: "running",
    startedAt: Date.now(),
    kind,
    progress: { total: contexts.length, done: 0, phase: "warmup" },
    rows: [],
    model,
    serverMode,
    engine,
    params:
      kind === "speed"
        ? { genLength, batchSize, contexts, temperature }
        : { suite, sampleSize, concurrency },
  };
  if (kind === "eval") {
    state.eval = {
      suite,
      sampleSize,
      total: 0,
      done: 0,
      correct: 0,
      accuracy: 0,
      datasetTotal: 0,
      failures: 0,
    };
  }
  runs.set(runId, { state, cancel });
  // 只保留最近几个已结束任务，避免内存增长。
  for (const [id, run] of runs) {
    if (run.state.status !== "running" && runs.size > 3 && id !== runId) runs.delete(id);
  }

  if (kind === "eval") {
    void executeEvalRun(runId, { base, apiKey, model, suite, sampleSize, concurrency, cancel, state });
  } else {
    void executeRun(runId, { base, apiKey, model, genLength, batchSize, contexts, temperature, cancel, state });
  }
  return { runId };
}

/** 结果落库（speed 与 eval 共用；rows 传类别行时 kind 须为 eval）。 */
function persistRun(
  state: BenchmarkRunState,
  values: {
    kind: "speed" | "eval";
    rows: SpeedBenchRow[] | EvalCategoryRow[];
    summary: BenchmarkSummary;
  },
): void {
  try {
    const inserted = db
      .insert(benchmarkRecords)
      .values({
        kind: values.kind,
        model: state.model,
        serverMode: state.serverMode,
        engine: state.engine ?? null,
        params: JSON.stringify(state.params),
        rows: JSON.stringify(values.rows),
          summary: JSON.stringify(values.summary),
          // persistRun 只在任务结束后调用，running 兜底为 done 满足列类型窄化。
          status: state.status === "running" ? "done" : state.status,
        durationMs: state.durationMs ?? 0,
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

async function executeEvalRun(
  runId: string,
  env: {
    base: string;
    apiKey: string;
    model: string;
    suite: EvalSuiteId;
    sampleSize: number;
    concurrency: number;
    cancel: AbortController;
    state: BenchmarkRunState;
  },
) {
  const { state, cancel } = env;
  const { base, apiKey, model, suite, sampleSize, concurrency } = env;
  const info = state.eval!;
  try {
    // 题库缺失时先下载（phase=download 进度透出）。
    if (!evalDataReady(suite)) {
      await ensureEvalData(
        suite,
        (received, total) => {
          info.download = { received, total };
        },
        cancel.signal,
      );
    }
    info.download = undefined;

    const { items, fewShot, datasetTotal } = loadEvalSuite(suite, sampleSize);
    info.total = items.length;
    info.datasetTotal = datasetTotal;

    const outcome = await runEvalQuestions({
      ask: async (prompt, maxTokens) => {
        const { signal, cleanup } = combineSignals(cancel.signal, 600_000);
        try {
          const res = await chatFetch(
            base,
            apiKey,
            {
              model,
              messages: [{ role: "user", content: prompt }],
              max_tokens: maxTokens,
              temperature: 0,
            },
            signal,
          );
          if (!res.ok) return null;
          const json = (await res.json().catch(() => null)) as {
            choices?: { message?: { content?: string } }[];
          } | null;
          const content = json?.choices?.[0]?.message?.content;
          return typeof content === "string" && content ? stripThinkTags(content) : null;
        } catch {
          return null;
        } finally {
          cleanup();
        }
      },
      suite,
      items,
      fewShot,
      datasetTotal,
      concurrency,
      cancel: cancel.signal,
      onProgress: (done, total, correct) => {
        info.done = done;
        info.total = total;
        info.correct = correct;
        info.accuracy = done > 0 ? Number(((correct / done) * 100).toFixed(1)) : 0;
      },
    });

    info.failures = outcome.failures;
    info.correct = outcome.correctCount;
    info.accuracy = outcome.accuracy;
    state.evalRows = outcome.categories;
    state.summary = {
      avgTps: 0,
      peakTps: 0,
      avgTtftMs: 0,
      bestTtftMs: 0,
      peakAggTps: 0,
      peakPrefillTps: 0,
      totalTokens: 0,
      eval: {
        suite,
        accuracy: outcome.accuracy,
        correctCount: outcome.correctCount,
        totalQuestions: outcome.totalQuestions,
        datasetTotal: outcome.datasetTotal,
        failures: outcome.failures,
      },
    };
    state.status = cancel.signal.aborted ? "cancelled" : "done";
  } catch (e) {
    state.status = cancel.signal.aborted ? "cancelled" : "error";
    state.error = e instanceof Error ? e.message : String(e);
  }

  state.durationMs = Date.now() - state.startedAt;
  if (!state.summary) {
    state.summary = {
      avgTps: 0,
      peakTps: 0,
      avgTtftMs: 0,
      bestTtftMs: 0,
      peakAggTps: 0,
      peakPrefillTps: 0,
      totalTokens: 0,
    };
  }
  // 已答出的题仍有价值（含取消 / 出错路径）。
  if (info.done > 0 && state.summary.eval) {
    state.summary.eval.totalQuestions = info.done;
    state.summary.eval.correctCount = info.correct;
    state.summary.eval.accuracy = info.done > 0 ? Number(((info.correct / info.done) * 100).toFixed(1)) : 0;
  }
  if (info.done > 0 || state.status === "error") {
    persistRun(state, { kind: "eval", rows: state.evalRows ?? [], summary: state.summary });
  }
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
  state.summary = summarize(state.rows);
  // 取消时已完成的档位仍有价值，一并落库。
  if (state.rows.length > 0 || state.status === "error") {
    persistRun(state, { kind: "speed", rows: state.rows, summary: state.summary });
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
