import { getSetting, getActiveServerPort } from "./db/settings";

export type BenchmarkParams = {
  model: string;
  batchSize?: number;
  genLength?: number;
  contexts?: number[];
  temperature?: number;
};

export type BenchmarkRow = {
  contextLength: number;
  batchSize: number;
  ttftMs: number;
  tpotMs: number;
  tps: number;
  tokens: number;
  totalMs: number;
};

export type BenchmarkResult = {
  ok: boolean;
  error?: string;
  rows: BenchmarkRow[];
};

const DEFAULT_CONTEXTS = [1024, 4096, 8192, 16384, 32768];
const CHARS_PER_TOKEN = 4;

function buildPrompt(ctxTokens: number): string {
  const unit =
    "The quick brown fox jumps over the lazy dog while measuring transformer throughput and latency across multiple context sizes. ";
  const needed = Math.max(ctxTokens * CHARS_PER_TOKEN, unit.length);
  const repeats = Math.ceil(needed / unit.length);
  return unit.repeat(repeats).slice(0, needed);
}

/** Stream a chat/completions request and return (ttftMs, tokens, totalMs). */
async function timedStream(
  base: string,
  model: string,
  prompt: string,
  genLength: number,
  temperature: number,
): Promise<{ ttftMs: number; tokens: number; totalMs: number }> {
  const start = performance.now();
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: genLength,
      temperature,
      stream: true,
    }),
    signal: AbortSignal.timeout(600_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Benchmark request failed (${res.status}): ${body.slice(0, 300)}`);
  }
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstTokenMs: number | null = null;
  let tokens = 0;

  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") return;
    try {
      const json = JSON.parse(payload);
      const delta = json.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        if (firstTokenMs === null) firstTokenMs = performance.now();
        tokens += 1;
      }
    } catch {
      // skip malformed chunk
    }
  };

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
  // consume any trailing line
  if (buffer.trim()) consumeLine(buffer);

  const totalMs = performance.now() - start;
  return {
    ttftMs: firstTokenMs !== null ? firstTokenMs - start : totalMs,
    tokens,
    totalMs,
  };
}

async function runBatch(
  base: string,
  model: string,
  prompt: string,
  genLength: number,
  batchSize: number,
  temperature: number,
): Promise<{ ttftAvg: number; tpot: number; tps: number; tokens: number; totalMs: number }> {
  const attempt = async () =>
    timedStream(base, model, prompt, genLength, temperature);

  // Warm-up single request
  try {
    await attempt();
  } catch {
    // ignore warm-up failures
  }

  const results = await Promise.all(
    Array.from({ length: batchSize }).map((_, i) =>
      attempt().catch((e) => {
        throw new Error(`Batch request ${i + 1} failed: ${e.message}`);
      }),
    ),
  );

  const totalTokens = results.reduce((s, r) => s + r.tokens, 0);
  const avgTotalMs = results.reduce((s, r) => s + r.totalMs, 0) / results.length;
  const ttftAvg = results.reduce((s, r) => s + r.ttftMs, 0) / results.length;
  const outputTokens = Math.max(totalTokens, 1);
  const genTime = results.reduce((s, r) => s + (r.totalMs - r.ttftMs), 0);
  const tpot = genTime / results.length / Math.max((totalTokens / results.length), 1);
  const tps = outputTokens / (avgTotalMs / 1000);

  return {
    ttftAvg,
    tpot,
    tps,
    tokens: totalTokens,
    totalMs: avgTotalMs,
  };
}

export async function runBenchmark(params: BenchmarkParams): Promise<BenchmarkResult> {
  const agent = getSetting("SERVER_MODE");
  const base =
    agent === "remote"
      ? (getSetting("VLLM_API_BASE") || "").replace(/\/$/, "").replace(/\/v1$/, "")
      : `http://localhost:${getActiveServerPort()}`;

  if (!base) return { ok: false, error: "No inference server configured", rows: [] };

  const model = params.model || getSetting("CHAT_MODEL") || getSetting("VLLM_MODEL_NAME");
  if (!model) return { ok: false, error: "No model configured", rows: [] };

  const batchSize = Math.max(params.batchSize ?? 1, 1);
  const genLength = Math.max(params.genLength ?? 128, 16);
  const temperature = params.temperature ?? 0;
  const contexts = (params.contexts?.length ? params.contexts : DEFAULT_CONTEXTS).map((c) =>
    Math.max(c, 128),
  );

  try {
    const rows: BenchmarkRow[] = [];
    for (const ctx of contexts) {
      const prompt = buildPrompt(ctx);
      const r = await runBatch(base, model, prompt, genLength, batchSize, temperature);
      rows.push({
        contextLength: ctx,
        batchSize,
        ttftMs: Math.round(r.ttftAvg),
        tpotMs: Number(r.tpot.toFixed(3)),
        tps: Number(r.tps.toFixed(1)),
        tokens: r.tokens,
        totalMs: Math.round(r.totalMs),
      });
    }
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), rows: [] };
  }
}

export const BENCHMARK_PRESET_CONTEXTS = DEFAULT_CONTEXTS;