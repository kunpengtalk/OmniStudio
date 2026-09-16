import { desc, eq, sql } from "drizzle-orm";
import { db } from "./db";
import { benchmarkRecords } from "./db/schema";
import {
  getSetting,
  getActiveServerPort,
  getActiveInferenceEngine,
} from "./db/settings";
import { getCloudProviderInfo } from "./cloud-providers";
import { getChatModelName, getLocalRequestModelId } from "./chat-model";
import { modelNameFromRef } from "../shared/modelscope";
import {
  BENCHMARK_DEFAULT_CACHE_MODES,
  BENCHMARK_DEFAULT_CONTEXTS,
  fmtCtx,
  normalizeCacheModes,
  normalizeContexts,
  type BenchmarkCacheMode,
} from "../shared/benchmark";
import { logEvent } from "./app-log";
import { listInstalledModels, slugModelFileName } from "./model-store";
import { isMlxActive } from "./runtimes/mlx";
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
  /** 缓存场景；缺省测全部三种（见 shared/benchmark.ts 的说明）。 */
  cacheModes?: BenchmarkCacheMode[];
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
  /** 实际 prompt tokens（测量请求的 usage；拿不到时按 4 字符/token 估算）。 */
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
  /**
   * 这一档为什么没测出来（服务端拒绝 / 超时 / 全档失败）。ok=0 时必有值：
   * 档位扫描的意义就是"哪一档是墙"，把失败原因丢掉等于让用户自己猜。
   */
  error?: string;
  /**
   * 服务端收到的 prompt 明显短于目标档位（被静默截断，云端 API 常见）：
   * 这一档的速度看着最快，但测的根本不是目标长度。
   */
  truncated?: boolean;
  /** 这一行是哪种缓存场景（老记录没有这个字段 = 当年只有"预热过再测"的命中态）。 */
  cache?: BenchmarkCacheMode;
  /**
   * 服务端自报的"复用自缓存的 prompt tokens"（llama.cpp 的 `timings.cache_n`）。
   * 有的引擎不报（vLLM / SGLang 的 OpenAI 兼容流里没有），那时只能看 TTFT 差值。
   */
  cacheReusedTokens?: number;
};

/** 任务提前收尾的档位（1M 扫描里"更大的档位只会更糟"的两种情形）。 */
export type BenchmarkStopReason = "context-overflow" | "timeout";

export type BenchmarkSummary = {
  avgTps: number;
  peakTps: number;
  avgTtftMs: number;
  bestTtftMs: number;
  peakAggTps: number;
  peakPrefillTps: number;
  totalTokens: number;
  /** 没跑完所有档位时的收尾原因（界面按 reason 出文案，不去解析 error 串）。 */
  stopped?: { reason: BenchmarkStopReason; contextLength: number };
  /**
   * 平均 / 最佳这几个数取自哪种缓存场景。
   *
   * 冷启和命中混在一起平均没有意义（那是两种完全不同的工况），所以有冷启就报冷启
   * —— 它是唯一不会被缓存粉饰的数字；只勾了命中场景时才报命中。
   */
  basis?: BenchmarkCacheMode;
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
    /** 当前正在跑的缓存场景。 */
    currentCache?: BenchmarkCacheMode;
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
  /** 速度扫描提前收尾时，跳过了哪些档位、为什么。 */
  stopped?: { reason: BenchmarkStopReason; contextLength: number };
  /** **展示名**（模型名 / 云模型 id），落库与界面都用它 —— 绝不是 MLX 那种路径型请求 id。 */
  model: string;
  /** local（本地引擎）/ remote（激活的云服务商槽位）/ cloud（按 id 直连的云服务商）。 */
  serverMode: string;
  engine?: string;
  /** 任务参数；本地任务额外带 `requestModel`（真正发到服务器的模型 id，MLX 下是绝对路径）。 */
  params: Record<string, unknown>;
};

export type BenchmarkRecordRow = {
  id: number;
  kind: "speed" | "eval";
  model: string;
  serverMode: string | null;
  engine: string | null;
  params: Record<string, unknown> | null;
  rows: SpeedBenchRow[] | EvalCategoryRow[] | null;
  summary: BenchmarkSummary | null;
  status: "done" | "cancelled" | "error";
  durationMs: number | null;
  error: string | null;
  createdAt: number;
};

const CHARS_PER_TOKEN = 4;
/** 单请求超时的下限 = 老版本写死的 10 分钟；只有更大的档位才需要放宽。 */
const MIN_REQUEST_TIMEOUT_MS = 600_000;
/** 单请求超时的上限：卡死的服务端最多拖这么久，再长用户只能看到"还在跑"。 */
const MAX_REQUEST_TIMEOUT_MS = 3 * 3600_000;
/** 超时兜底用的 prefill / decode 速率（tok/s）。比任何能跑大窗口的机器都慢 —— 只用来兜底。 */
const FALLBACK_PREFILL_TPS = 30;
const FALLBACK_DECODE_TPS = 1;
/** 预热请求的超时上限（大档位的预热只是"叫醒模型"，不该占满整档的时间预算）。 */
const WARMUP_TIMEOUT_MS = 300_000;
/**
 * 超过这个档位就不再拿全量 prompt 预热：全量预热等于把这一档的 prefill 白跑一遍
 * （1M 档就是几十分钟），而精确 prompt tokens 与"超窗被拒"都能从测量请求本身拿到。
 */
const WARMUP_FULL_MAX_CONTEXT = 32768;
/** 大档位改用短 prompt 预热时的长度。 */
const WARMUP_PROBE_TOKENS = 256;
/** 实际 prompt tokens 低于目标档位的这个比例时，判定被服务端截断。 */
const TRUNCATION_RATIO = 0.85;

/**
 * 单请求的超时预算：随档位放大。
 *
 * 固定 10 分钟是给 32k 以下写的 —— 1M 档的 prefill 在本地机器上要几十分钟，
 * 拿老超时去测，最大几档永远只会得到一句 `timeout`，看着像模型不支持长上下文，
 * 其实是测的人自己把自己掐死了。反过来也不能不封顶：卡死的服务端要能收场。
 */
export function requestTimeoutMs(ctxTokens: number, genLength = 0): number {
  const scaled = (ctxTokens / FALLBACK_PREFILL_TPS) * 1000 + (genLength / FALLBACK_DECODE_TPS) * 1000;
  return Math.min(Math.max(scaled + 120_000, MIN_REQUEST_TIMEOUT_MS), MAX_REQUEST_TIMEOUT_MS);
}

/**
 * 服务端"这个 prompt 超出上下文窗口"的判定。
 *
 * 各家文案：llama.cpp `the request exceeds the available context size`、vLLM
 * `maximum context length is N tokens`、OpenAI 兼容云端 `context_length_exceeded`。
 * 命中说明窗口是硬墙 —— 更大的档位只会同样被拒，早点收尾比把剩下几档全撞一遍有用。
 */
const CONTEXT_OVERFLOW_RE =
  /(exceeds?[^"]{0,40}context|context (size|length|window)|context_length_exceeded|maximum context|too (long|many tokens)|reduce the length|n_ctx|input is too long)/i;

export function isContextOverflowError(text: string): boolean {
  return CONTEXT_OVERFLOW_RE.test(text);
}

/** 我们自己的超时（combineSignals 用 Error("timeout") 中止）与底层网络超时。 */
export function isTimeoutError(text: string): boolean {
  return /\btimeout\b|timed out|ETIMEDOUT|AbortError/i.test(text);
}

/** 去掉尾斜杠与 /v1 后缀，统一成拼接 /v1/chat/completions 的形态。 */
function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

/**
 * 噪声 prompt 的句子池。
 *
 * 轮转不同句子而不是同一句重复 N 次：重复文本在 BPE 下压缩得更狠，1M 档实测
 * prompt tokens 会明显低于目标（把"1M 上下文"测成 700k）。句子池循环周期近千字符，
 * 已经足够让字符/词元比例贴近自然文本。
 */
const PROMPT_SENTENCES = [
  "The quick brown fox jumps over the lazy dog while measuring transformer throughput and latency across multiple context sizes. ",
  "A local inference server must keep the key-value cache resident, so longer prompts trade memory for fewer decode steps per second. ",
  "Prefill time grows super-linearly once the attention window stops fitting into the fastest cache level on the accelerator. ",
  "Batch size 8 with a 128 token generation is a common smoke test for chat workloads served from a single GPU. ",
  "量化权重把显存占用压到四分之一，代价通常是长上下文里更早出现的数值漂移和重复。 ",
  "The scheduler interleaves decode steps from several sequences, which raises aggregate throughput but inflates per-token latency. ",
  "长窗口模型在检索式问答上更稳，但把整本手册塞进 prompt 之前值得先量一量每档的首 token 延迟。 ",
  "Tokens per second is a poor single number on its own; report time to first token, time per output token and prefill rate together. ",
];

function buildPrompt(ctxTokens: number): string {
  const unit = PROMPT_SENTENCES.join("");
  const needed = Math.max(ctxTokens * CHARS_PER_TOKEN, unit.length);
  const repeats = Math.ceil(needed / unit.length);
  return unit.repeat(repeats).slice(0, needed);
}

/** 部分命中时新内容占的比例（尾巴越长，越多内容要重新算）。 */
const PARTIAL_TAIL_RATIO = 0.1;

/**
 * 每请求唯一的标记串。
 *
 * 用 randomUUID 而不是计数器：并发批次里的每个请求都要是不同的串，否则同批的第 2 个
 * 请求会命中第 1 个刚写进去的缓存，"冷启档"就变成了"同批命中档"。
 * 补位也用随机字符而不是 `0`：一长串 0 在 BPE 下的合并行为跟正文差太远。
 */
function uniqueMarker(seed: string, len: number): string {
  let out = `${seed}${crypto.randomUUID().replace(/-/g, "")}`;
  while (out.length < len) out += crypto.randomUUID().replace(/-/g, "");
  return out.slice(0, len);
}

/** 部分命中档共享的前缀长度（尾巴留给每个请求自己的新内容）。 */
function partialPrefixLength(promptLength: number): number {
  return Math.max(promptLength - Math.floor(promptLength * PARTIAL_TAIL_RATIO), 1);
}

/**
 * 按缓存场景造 prompt：长度都等于目标档位，只有"前缀是不是新的"不同。
 *
 * - cold：唯一标记放在**最前面**。前缀缓存是按最长公共前缀命中的，第 1 个 token 就
 *   不同 ⇒ 一定不命中（把标记放结尾会变成"整段都能复用"，那就不是冷启了）。
 * - partial：共享前缀 + 每个请求自己的新尾巴 —— 多轮对话的真实形态：前面的历史
 *   原样不动，只有新追问要算。
 * - warm：与预热完全相同的正文，测命中上限。
 */
function buildPromptFor(ctxTokens: number, mode: BenchmarkCacheMode, requestIndex: number): string {
  const base = buildPrompt(ctxTokens);
  if (mode === "warm") return base;
  if (mode === "cold") {
    const marker = uniqueMarker(`cold${requestIndex}-`, Math.min(base.length, 64));
    return marker + base.slice(marker.length);
  }
  const prefixLen = partialPrefixLength(base.length);
  const tailLen = base.length - prefixLen;
  return base.slice(0, prefixLen) + uniqueMarker(`partial${requestIndex}-`, tailLen);
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
  /** 服务端自报复用自缓存的 prompt tokens（llama.cpp 的 timings.cache_n）；不报为 null。 */
  cacheReusedTokens: number | null;
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
  timeoutMs: number,
  cancel: AbortSignal,
): Promise<StreamStats> {
  const start = performance.now();
  const { signal, cleanup } = combineSignals(cancel, timeoutMs);
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
  let cacheReusedTokens: number | null = null;

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
      // llama.cpp 在末块给 timings（cache_n = 直接复用、没有重算的 prompt tokens）：
      // 这是"到底有没有命中缓存"的唯一权威答案，别的引擎不报就只能看 TTFT 差值。
      const cacheN = json.timings?.cache_n;
      if (typeof cacheN === "number") cacheReusedTokens = cacheN;
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
    cacheReusedTokens,
  };
}

/**
 * 非流式短请求：叫醒模型并顺带看服务端收不收这个 prompt。
 *
 * 大档位只发一个短 prompt（见 WARMUP_FULL_MAX_CONTEXT）：这一档的精确 prompt tokens
 * 从测量请求的 usage 拿，预热不必再把整个 prefill 白跑一遍。
 */
async function warmupRequest(
  base: string,
  apiKey: string,
  model: string,
  prompt: string,
  cancel: AbortSignal,
): Promise<{ promptTokens: number; reject?: string }> {
  const { signal, cleanup } = combineSignals(cancel, WARMUP_TIMEOUT_MS);
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
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { promptTokens: 0, reject: `HTTP ${res.status}: ${text.slice(0, 300)}` };
    }
    const json = (await res.json().catch(() => null)) as { usage?: { prompt_tokens?: number } } | null;
    return { promptTokens: typeof json?.usage?.prompt_tokens === "number" ? json.usage.prompt_tokens : 0 };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // chatFetch 对 4xx 抛的是带服务端原文的 Error：那是"服务端说这个请求不行"，
    // 与超时/网络抖动区分开 —— 前者可以据此判档位，后者不能（可能只是慢）。
    return { promptTokens: 0, reject: /failed \(4\d\d\)/.test(msg) ? msg : undefined };
  } finally {
    cleanup();
  }
}

type BatchOutcome = {
  row: SpeedBenchRow;
  /**
   * 这一档之后怎么走：
   *  - ok / partial      有数据，下一档继续；
   *  - context-overflow  服务端拒绝（超窗口）→ 更大的档位只会同样被拒，收尾；
   *  - timeout           单请求超时 → 更大的档位 prefill 更久，收尾；
   *  - fatal             一整档一个请求都没成功（服务没起 / 模型不对）；
   *  - cancelled         用户取消。
   */
  kind: "ok" | "partial" | "context-overflow" | "timeout" | "fatal" | "cancelled";
  error?: string;
};

async function runBatch(
  base: string,
  apiKey: string,
  model: string,
  ctx: number,
  genLength: number,
  batchSize: number,
  temperature: number,
  cache: BenchmarkCacheMode,
  cancel: AbortSignal,
): Promise<BatchOutcome> {
  const basePrompt = buildPrompt(ctx);
  // 预热要按场景挑内容 —— 这决定了测量时缓存里已经有什么：
  //  - warm    ：与测量请求**完全相同**（命中前提）；
  //  - partial ：只发共享前缀，把前缀填进缓存，测量请求的新尾巴仍然要现算；
  //  - cold    ：只发一小段探针（冷启档拿正文去预热毫无意义，反正命中不了）。
  const probe =
    cache === "warm"
      ? basePrompt
      : cache === "partial"
        ? basePrompt.slice(0, partialPrefixLength(basePrompt.length))
        : ctx > WARMUP_FULL_MAX_CONTEXT
          ? buildPrompt(WARMUP_PROBE_TOKENS)
          : basePrompt;
  const warm = await warmupRequest(base, apiKey, model, probe, cancel);
  // 服务端当场说不收（4xx）：不必再让每档的 prefill 跑满，几毫秒就能给出结论。
  if (warm.reject) {
    const kind = isContextOverflowError(warm.reject) ? "context-overflow" : "fatal";
    return { row: { ...emptyRow(ctx, batchSize, cache), error: warm.reject }, kind, error: warm.reject };
  }

  const timeoutMs = requestTimeoutMs(ctx, genLength);
  const wallStart = performance.now();
  const settled = await Promise.allSettled(
    Array.from({ length: batchSize }).map((_, i) =>
      timedStream(base, apiKey, model, buildPromptFor(ctx, cache, i), genLength, temperature, timeoutMs, cancel),
    ),
  );
  const okStats = settled
    .filter((s): s is PromiseFulfilledResult<StreamStats> => s.status === "fulfilled")
    .map((s) => s.value);
  const fails = settled.length - okStats.length;

  /** 失败请求的首个原因（服务端原文 / timeout）。 */
  const firstFailReason = (): string => {
    const first = settled.find((s) => s.status === "rejected") as PromiseRejectedResult | undefined;
    return first ? String(first.reason?.message ?? first.reason) : "all requests failed";
  };

  // 整档颗粒无收：若是用户主动取消则按取消处理，否则把原因写给这一档。
  if (okStats.length === 0) {
    if (cancel.aborted) return { row: emptyRow(ctx, batchSize, cache), kind: "cancelled" };
    const reason = firstFailReason();
    const kind = isContextOverflowError(reason) ? "context-overflow" : isTimeoutError(reason) ? "timeout" : "fatal";
    return { row: { ...emptyRow(ctx, batchSize, cache), error: reason }, kind, error: reason };
  }

  // prompt tokens 以测量请求的 usage 为准（大档位的预热只发短 prompt，值不是这一档的；
  // partial 档的尾巴长度也在这时才定得下来），退到预热值，再退到 4 字符/token 估算。
  const measuredPromptTokens = okStats.find((s) => s.promptTokens > 0)?.promptTokens ?? 0;
  const promptTokens = measuredPromptTokens || warm.promptTokens || Math.floor(basePrompt.length / CHARS_PER_TOKEN);
  const truncated = measuredPromptTokens > 0 && measuredPromptTokens < ctx * TRUNCATION_RATIO;
  // 只有部分引擎会报 cache_n；不报的留空，界面靠 TTFT 差值看缓存收益。
  const cacheReusedTokens = okStats.find((s) => s.cacheReusedTokens != null)?.cacheReusedTokens ?? null;

  const totalTokens = okStats.reduce((s, r) => s + r.tokens, 0);
  const ttftAvg = okStats.reduce((s, r) => s + r.ttftMs, 0) / okStats.length;
  const avgTotalMs = okStats.reduce((s, r) => s + r.totalMs, 0) / okStats.length;
  // 首 token 已计入 TTFT，之后每 token 平均耗时按 (tokens-1) 摊。
  const genTimeTotal = okStats.reduce((s, r) => s + (r.totalMs - r.ttftMs), 0);
  const genTokensTotal = okStats.reduce((s, r) => s + Math.max(r.tokens - 1, 1), 0);
  const wallMs = Math.max(performance.now() - wallStart, ...okStats.map((r) => r.totalMs));

  return {
    kind: fails > 0 ? "partial" : "ok",
    error: fails > 0 ? `${fails}/${settled.length} requests failed: ${firstFailReason()}` : undefined,
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
      truncated: truncated || undefined,
      cache,
      cacheReusedTokens: cacheReusedTokens ?? undefined,
    },
  };
}

function emptyRow(ctx: number, batchSize: number, cache?: BenchmarkCacheMode): SpeedBenchRow {
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
    cache,
  };
}

function summarize(
  rows: SpeedBenchRow[],
  stopped?: { reason: BenchmarkStopReason; contextLength: number },
): BenchmarkSummary {
  // 失败档位（ok=0）不进平均：把"一整档没测出来"当 0 摊进平均值，会让恰好最关键的
  // 结论被拉成无意义的数字。峰值本来取 Max，0 值不影响。
  const ok = rows.filter((r) => r.ok > 0);
  // 平均 / 最佳只取一种缓存场景：冷启和命中是两种工况，混着平均出来的数谁都不像。
  // 有冷启就报冷启（唯一没被缓存粉饰的那个）；只勾了命中场景时才报命中。
  const basis: BenchmarkCacheMode | undefined =
    ok.some((r) => r.cache === "cold") ? "cold" : ok.some((r) => r.cache === "warm") ? "warm" : undefined;
  const basisRows = basis ? ok.filter((r) => r.cache === basis) : ok;
  const summary: BenchmarkSummary = {
    avgTps: 0,
    peakTps: 0,
    avgTtftMs: 0,
    bestTtftMs: 0,
    peakAggTps: 0,
    peakPrefillTps: 0,
    totalTokens: rows.reduce((s, r) => s + r.tokens, 0),
  };
  if (basis) summary.basis = basis;
  if (basisRows.length > 0) {
    summary.avgTps = Number((basisRows.reduce((s, r) => s + r.tps, 0) / basisRows.length).toFixed(1));
    summary.peakTps = Math.max(...basisRows.map((r) => r.tps));
    summary.avgTtftMs = Math.round(basisRows.reduce((s, r) => s + r.ttftMs, 0) / basisRows.length);
    summary.bestTtftMs = Math.min(...basisRows.map((r) => r.ttftMs));
    summary.peakAggTps = Math.max(...basisRows.map((r) => r.aggTps));
    summary.peakPrefillTps = Math.max(...basisRows.map((r) => r.prefillTps));
  }
  if (stopped) summary.stopped = stopped;
  return summary;
}

// ---------------------------------------------------------------------------
// 任务管理：同一时刻只允许一个运行中的基准任务；结束后状态保留在内存供
// 前端拉取（历史以 SQLite 记录为准）。
// ---------------------------------------------------------------------------

type ActiveRun = { state: BenchmarkRunState; cancel: AbortController };

const runs = new Map<string, ActiveRun>();
let runCounter = 0;

/**
 * 本地引擎的基准测试模型 id。
 *
 * 界面传来的通常是服务名 slug，直接发过去在 MLX 上会失败：mlx_lm.server 没有
 * `--served-model-name`，对本地目录暴露的 id 是**解析后的绝对路径**（见 resolveMlxModel），
 * 拿到不认识的名字它会去 HuggingFace 找仓库 —— 基准测试页看到的就是
 * `404 ... Repository Not Found for url: .../models/<slug>/revision/main`。
 *
 * - 活动模型（界面默认填的就是它）→ 本地引擎认的 id；
 * - 已装的其它模型 → 用它的加载目标（MLX 能按需加载该目录；其它引擎认服务名 slug）。
 *
 * 返回的是**请求 id**：只往 HTTP body 里填，别拿它当展示名（MLX 下是一串绝对路径，
 * 见 `startBenchmark` 里的 displayModel）。
 */
export function localBenchmarkModelId(requested: string): string {
  const active = new Set(
    [getChatModelName(), getSetting("LOCAL_MODEL_NAME"), getSetting("LOCAL_MODEL_PATH")].filter(Boolean),
  );
  if (!requested || active.has(requested)) return getLocalRequestModelId() || requested;

  const slug = slugModelFileName(requested);
  const hit = listInstalledModels().find(
    (m) =>
      m.path === requested ||
      m.runtimeTarget === requested ||
      m.fileName === requested ||
      slugModelFileName(m.fileName) === slug,
  );
  if (!hit) return requested;
  return isMlxActive() ? hit.runtimeTarget : slugModelFileName(hit.fileName);
}

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
  const requested = params.providerId
    ? params.model.trim()
    : params.model || getSetting("CHAT_MODEL") || getSetting("VLLM_MODEL_NAME");
  if (!requested) return { error: "No model configured" };
  // 本地目标要把服务名换算成引擎认的 id（云端按模型 id 直传）。
  const model = params.providerId || serverMode === "remote" ? requested : localBenchmarkModelId(requested);
  // 请求 id 与展示名分开：MLX 的请求 id 是绝对路径（它只认这个），历史记录 / 界面里
  // 显示的必须是模型名 —— 表头和侧栏不该出现 `/Users/…`。请求 id 留在 params.requestModel。
  const displayModel = modelNameFromRef(requested, requested);

  const batchSize = Math.max(params.batchSize ?? 1, 1);
  const genLength = Math.max(params.genLength ?? 128, 16);
  const temperature = params.temperature ?? 0;
  // 档位统一规范化：去重、升序、夹在 128 ~ 1M（上限也是防呆 —— 1M 的 prompt 已是 4MB）。
  const contexts = normalizeContexts(
    params.contexts?.length ? params.contexts : BENCHMARK_DEFAULT_CONTEXTS,
  );
  // 缓存场景（冷启 / 部分命中 / 完全命中）：每个档位每种场景各测一轮。
  const cacheModes = normalizeCacheModes(
    params.cacheModes?.length ? params.cacheModes : BENCHMARK_DEFAULT_CACHE_MODES,
  );

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
    // 一档一片（contexts × cacheModes），进度条按这个总数走。
    progress: { total: contexts.length * cacheModes.length, done: 0, phase: "warmup" },
    rows: [],
    model: displayModel,
    serverMode,
    engine,
    params:
      kind === "speed"
        ? { genLength, batchSize, contexts, cacheModes, temperature, requestModel: model }
        : { suite, sampleSize, concurrency, requestModel: model },
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

  logEvent({
    source: "benchmark",
    event: "benchmark.run.started",
    message: `基准测试开始：${displayModel}（${kind === "speed" ? `${contexts.map(fmtCtx).join(" / ")} × ${cacheModes.length} 种缓存场景` : `评测 ${suite}`}）`,
    detail: { runId, kind, serverMode, engine, model, contexts, cacheModes, genLength, batchSize, suite, sampleSize, concurrency },
  });

  if (kind === "eval") {
    void executeEvalRun(runId, { base, apiKey, model, suite, sampleSize, concurrency, cancel, state });
  } else {
    void executeRun(runId, { base, apiKey, model, genLength, batchSize, contexts, cacheModes, temperature, cancel, state });
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
  logRunFinished("eval", state, { suite, answered: info.done, accuracy: info.accuracy });
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
    cacheModes: BenchmarkCacheMode[];
    temperature: number;
    cancel: AbortController;
    state: BenchmarkRunState;
  },
) {
  const { state, cancel } = env;
  const { base, apiKey, model, genLength, batchSize, contexts, cacheModes, temperature } = env;
  // 扫描顺序：档位 × 缓存场景（每个档位先冷启、再部分命中、最后完全命中）。
  // 同一档位的三种场景连着跑：服务和机器状态最接近，TTFT 的差值才是缓存带来的。
  const slots = contexts.flatMap((ctx) => cacheModes.map((cache) => ({ ctx, cache })));
  try {
    for (let i = 0; i < slots.length; i++) {
      if (cancel.signal.aborted) break;
      const { ctx, cache } = slots[i]!;
      state.progress = {
        total: slots.length,
        done: i,
        phase: "warmup",
        currentContext: ctx,
        currentCache: cache,
      };
      const outcome = await runBatch(
        base,
        apiKey,
        model,
        ctx,
        genLength,
        batchSize,
        temperature,
        cache,
        cancel.signal,
      );
      if (outcome.kind === "cancelled") break;

      state.rows.push(outcome.row);
      state.progress = {
        total: slots.length,
        done: i + 1,
        phase: "measure",
        currentContext: ctx,
        currentCache: cache,
      };
      if (outcome.error) {
        logEvent({
          level: "warn",
          source: "benchmark",
          event: "benchmark.bucket.failed",
          message: `基准测试 ${fmtCtx(ctx)} · ${cache} 档失败：${outcome.error}`,
          detail: { runId, contextLength: ctx, cache, kind: outcome.kind, batchSize, error: outcome.error },
        });
      }

      // 更大的档位只会更糟：超窗是服务端的硬墙（拒绝得干脆），超时说明这一档
      // 已经到了这台机器的 prefill 极限 —— 再翻一倍只是把同样的等待重来一遍。
      // 同一档位的其它缓存场景也没必要再试：prompt 长度一样，窗口不会因此变大。
      if (outcome.kind === "context-overflow" || outcome.kind === "timeout") {
        state.stopped = { reason: outcome.kind, contextLength: ctx };
        break;
      }
      // 一整档颗粒无收、而且前面也一档都没成：服务没起 / 模型不对，早点报错，
      // 别让用户对着五个必然失败的档位等下去。前面有成过的档位则说明服务是好的，
      // 这一档的失败已经记在行里，继续扫。
      if (outcome.kind === "fatal" && !state.rows.some((r) => r.ok > 0)) {
        throw new Error(outcome.error ?? "all requests failed");
      }
    }
    state.status = cancel.signal.aborted ? "cancelled" : "done";
  } catch (e) {
    state.status = cancel.signal.aborted ? "cancelled" : "error";
    state.error = e instanceof Error ? e.message : String(e);
  }

  state.durationMs = Date.now() - state.startedAt;
  state.summary = summarize(state.rows, state.stopped);
  // 取消时已完成的档位仍有价值，一并落库。
  if (state.rows.length > 0 || state.status === "error") {
    persistRun(state, { kind: "speed", rows: state.rows, summary: state.summary });
  }
  logRunFinished("speed", state, { contexts, cacheModes });
}

/** 任务收尾统一记一条：长跑几十分钟的失败不能只在内存里。 */
function logRunFinished(kind: "speed" | "eval", state: BenchmarkRunState, detail: Record<string, unknown>): void {
  const okRows = state.rows.filter((r) => r.ok > 0).length;
  const failedRows = state.rows.length - okRows;
  logEvent({
    level: state.status === "error" ? "error" : state.status === "cancelled" ? "warn" : "info",
    source: "benchmark",
    event: state.status === "error" ? "benchmark.run.failed" : "benchmark.run.finished",
    message:
      state.status === "error"
        ? `基准测试失败：${state.model} — ${state.error ?? ""}`
        : `基准测试${state.status === "cancelled" ? "已取消" : "完成"}：${state.model}（${okRows} 档成功${failedRows > 0 ? ` / ${failedRows} 档失败` : ""}）`,
    detail: {
      runId: state.runId,
      kind,
      status: state.status,
      model: state.model,
      serverMode: state.serverMode,
      engine: state.engine,
      durationMs: state.durationMs,
      recordId: state.recordId,
      failedRows,
      stopped: state.stopped,
      error: state.error,
      ...detail,
    },
  });
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

/** 列表用的轻量元数据：不带 rows / summary（它们是大 JSON），只用于侧栏与选择器。 */
function parseRecordMeta(r: typeof benchmarkRecords.$inferSelect): BenchmarkRecordRow {
  return {
    id: r.id,
    kind: r.kind,
    model: r.model,
    serverMode: r.serverMode,
    engine: r.engine,
    params: null,
    rows: null,
    summary: null,
    status: r.status,
    durationMs: r.durationMs,
    error: r.error,
    createdAt: r.createdAt ?? 0,
  };
}

/**
 * 历史列表（完整正文）。供 CLI / 控制通道使用：它们一次只取前 20 条展示摘要。
 * 界面侧请用 `listBenchmarkRecordSummaries()` + `getBenchmarkRecord(id)`，
 * 避免把每条记录的 rows / summary 大 JSON 全量拉进 webview。
 */
export function listBenchmarkRecords(): BenchmarkRecordRow[] {
  return db
    .select()
    .from(benchmarkRecords)
    .orderBy(desc(benchmarkRecords.createdAt))
    .all()
    .map(parseRecord);
}

/**
 * 历史列表。
 *
 * 此前每次打开侧栏都全量取回所有记录（每条都带 rows / summary 两段大 JSON）。
 * 基准是长跑任务、历史会累积，这里只返回轻量元数据并带上上限与总数，
 * 选中某条时再用 `getBenchmarkRecord(id)` 取完整正文。
 */
export function listBenchmarkRecordSummaries(): { records: BenchmarkRecordRow[]; total: number } {
  const total =
    db.select({ n: sql<number>`count(*)` }).from(benchmarkRecords).get()?.n ?? 0;
  const records = db
    .select()
    .from(benchmarkRecords)
    .orderBy(desc(benchmarkRecords.createdAt))
    .limit(BENCHMARK_RECORD_LIST_MAX)
    .all()
    .map(parseRecordMeta);
  return { records, total: Number(total) };
}

/** 历史列表返回的上限（轻量元数据，上限可以放得比完整记录大）。 */
export const BENCHMARK_RECORD_LIST_MAX = 500;

/** 单条记录的完整内容（含 rows / summary），供结果页回放。 */
export function getBenchmarkRecord(id: number): BenchmarkRecordRow | null {
  const row = db.select().from(benchmarkRecords).where(eq(benchmarkRecords.id, id)).get();
  return row ? parseRecord(row) : null;
}

export function deleteBenchmarkRecord(id: number): { ok: boolean } {
  db.delete(benchmarkRecords).where(eq(benchmarkRecords.id, id)).run();
  return { ok: true };
}

export function clearBenchmarkRecords(): { ok: boolean } {
  db.delete(benchmarkRecords).run();
  return { ok: true };
}
