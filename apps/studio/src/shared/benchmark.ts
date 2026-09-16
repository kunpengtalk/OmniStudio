/**
 * 基准测速的上下文档位 + 缓存场景 —— 主进程、CLI、界面共用同一份。
 *
 * 档位表以前在三个地方各写一遍（界面的 `PRESET_CONTEXTS`、主进程的
 * `DEFAULT_CONTEXTS`、CLI 自己一个 `fmtCtx`），窗口一扩就会漂移：界面能勾 1M，
 * CLI 默认只扫到 32k，历史记录里的标签还各写各的。
 * 缓存场景同理：它是"这一行的数是怎么测出来的"的一部分，三个入口必须说同一套话。
 */
import { ENGINE_CTX_KEYS, type InferenceEngine } from "./engines";

/** 最小档位：128 tokens 连一次像样的 prefill 都算不上。 */
export const BENCHMARK_MIN_CONTEXT = 128;
/** 最大档位：1M —— 百万级窗口的模型（Qwen2.5-1M / Llama-4 / 云端长文 API）就在这一段。 */
export const BENCHMARK_MAX_CONTEXT = 1 << 20;

/** 可点选的档位：1k 起，每档翻倍到 1M。 */
export const BENCHMARK_PRESET_CONTEXTS = [
  1024,
  4096,
  8192,
  16384,
  32768,
  65536,
  131072,
  262144,
  524288,
  BENCHMARK_MAX_CONTEXT,
];

/**
 * 默认勾选的档位：到 32k 为止。
 *
 * 一次测速的耗时基本就是各档 prefill 之和，1M 一档在本地机器上要几十分钟起 ——
 * 默认带上它等于让"点开就跑"变成几小时的意外等待，大档位留给用户自己勾。
 */
export const BENCHMARK_DEFAULT_CONTEXTS = [1024, 4096, 8192, 16384, 32768];

/**
 * 档位标签：用二进制口径（1024 → `1k`、1048576 → `1M`），与模型卡的窗口口径一致
 * —— 十进制会写出 `32.8k` 这种模型名里根本不存在的数字。
 */
export function fmtCtx(c: number): string {
  if (c >= 1 << 20) {
    const m = c / (1 << 20);
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (c >= 1024) {
    const k = c / 1024;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return String(c);
}

/** 单档文本 → tokens：接受 `200000` / `128k` / `1.5k` / `1m`。无法识别返回 null。 */
export function parseContext(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([kKmM])?$/.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] ?? "").toLowerCase();
  const scaled = unit === "k" ? n * 1024 : unit === "m" ? n * (1 << 20) : n;
  return Math.round(scaled);
}

/** 列表文本（CLI `--contexts`、界面的自定义输入）→ 规范档位列表。 */
export function parseContexts(text: string): number[] {
  const parsed = text
    .split(/[,，\s]+/)
    .map(parseContext)
    .filter((n): n is number => n !== null);
  return normalizeContexts(parsed);
}

/**
 * 规范形态：去重、夹在 [128, 1M]、升序。
 *
 * 上限不只是界面约束：1M 档的 prompt 已经是 4MB 字符串，webview / 控制 socket
 * 传来一个 100M 就是一次 400MB 的分配 —— 夹在这里，三个入口一起受益。
 */
export function normalizeContexts(list: number[]): number[] {
  const seen = new Set<number>();
  for (const raw of list) {
    if (!Number.isFinite(raw)) continue;
    seen.add(Math.min(Math.max(Math.round(raw), BENCHMARK_MIN_CONTEXT), BENCHMARK_MAX_CONTEXT));
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * 推理服务器当前**单请求**能吃多少 tokens（界面在勾档位前提示用）。
 *
 * - llama.cpp 的 `SERVER_CTX_SIZE` 是 KV 总量，会按 `--parallel` 的槽位数均分，
 *   所以并发 4、窗口 32k 时单请求只有 8k —— 界面上勾 16k 就会整档被拒；
 * - vLLM / SGLang 的长度参数本来就是单请求的；
 * - MLX 没有对应的设置键（窗口由模型自己决定），返回 null。
 *
 * 返回 null = 不知道，界面不要瞎提示。
 */
export function serverContextWindow(
  engine: InferenceEngine,
  settings: Record<string, string>,
): number | null {
  const key = ENGINE_CTX_KEYS[engine];
  if (!key) return null;
  const raw = Number(settings[key]);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  if (engine !== "llama.cpp") return Math.round(raw);
  const parallel = Number(settings.SERVER_PARALLEL);
  return Math.round(raw / (Number.isFinite(parallel) && parallel > 0 ? parallel : 1));
}

// ---------------------------------------------------------------------------
// 缓存场景（前缀缓存 / KV 复用）
//
// 同一套硬件，prefill 的耗时差全在"服务端能不能复用上次算过的 KV"上：
// 命中时首 token 可以快到几毫秒，不命中就是老老实实把整段 prompt 算一遍。
// 只报一个 TTFT 数字等于把这两件事混在一起 —— 长上下文扫描里最容易被它骗。
//
// 三种场景各自的 prompt 形态（长度都是目标档位，差别只在前缀是否新）：
//   cold    唯一前缀 + 正文        → 服务端不可能命中，真实 prefill 成本
//   partial 正文前缀 90% + 新尾巴   → 多轮对话的典型形态（只有新增内容要算）
//   warm    与预热完全相同的一段    → 命中上限：整段 KV 都复用
// ---------------------------------------------------------------------------

export type BenchmarkCacheMode = "cold" | "partial" | "warm";

/** 缓存场景的展示顺序：从"最冷"到"最热"，与对比区的列顺序一致。 */
export const BENCHMARK_CACHE_MODES: BenchmarkCacheMode[] = ["cold", "partial", "warm"];

/**
 * 默认三种都测。
 *
 * 只测命中会得到偏乐观的 TTFT（服务端复用上一轮的 KV），只测冷启又看不到缓存收益 ——
 * 缓存这件事的价值恰恰在两者的差值里，默认把差值测出来。代价是每个档位跑三遍。
 */
export const BENCHMARK_DEFAULT_CACHE_MODES: BenchmarkCacheMode[] = ["cold", "partial", "warm"];

/** 规范形态：去重、按 cold → partial → warm 排序；空集回落到默认（界面不会传空，别让扫描静默变成 0 档）。 */
export function normalizeCacheModes(modes: (string | null | undefined)[]): BenchmarkCacheMode[] {
  const picked = BENCHMARK_CACHE_MODES.filter((m) => modes.includes(m));
  return picked.length > 0 ? picked : [...BENCHMARK_DEFAULT_CACHE_MODES];
}

/** 列表文本（CLI `--cache cold,warm`）→ 场景列表。 */
export function parseCacheModes(text: string): BenchmarkCacheMode[] {
  return normalizeCacheModes(text.split(/[,，\s]+/));
}

/** 一行指标里与缓存对比有关的字段（SpeedBenchRow 与界面里的历史行都满足）。 */
export type CacheCompareRow = {
  contextLength: number;
  /** 老记录没有这个字段：当年只有"预热过再测"一条路，按 warm 看待。 */
  cache?: BenchmarkCacheMode;
  ok: number;
  ttftMs: number;
  tps: number;
  promptTokens: number;
  /** 服务端自报的复用 tokens（llama.cpp 的 timings.cache_n）；不报的引擎没有。 */
  cacheReusedTokens?: number;
};

export type CacheComparison = {
  contextLength: number;
  cold: CacheCompareRow | null;
  partial: CacheCompareRow | null;
  warm: CacheCompareRow | null;
  /** 冷启 ÷ 完全命中的 TTFT 倍数（越大说明缓存越值钱）；缺一边时为 null。 */
  warmSpeedup: number | null;
  /** 冷启 ÷ 部分命中的 TTFT 倍数。 */
  partialSpeedup: number | null;
  /** 完全命中时服务端自报的复用比例（0~1，没数据为 null）。 */
  warmReuseRatio: number | null;
};

function modeOf(row: CacheCompareRow): BenchmarkCacheMode {
  return row.cache ?? "warm";
}

/** 按档位把三种场景并排放：界面/CLI 的对比区都读它，避免两边各算一套。 */
export function cacheComparison<T extends CacheCompareRow>(rows: T[]): CacheComparison[] {
  const byCtx = new Map<number, Partial<Record<BenchmarkCacheMode, T>>>();
  for (const row of rows) {
    if (row.ok <= 0) continue; // 没测出来的档位没有可比性
    const entry = byCtx.get(row.contextLength) ?? {};
    entry[modeOf(row)] = row;
    byCtx.set(row.contextLength, entry);
  }

  const ratio = (cold: CacheCompareRow | null, other: CacheCompareRow | null): number | null => {
    if (!cold || !other || other.ttftMs <= 0 || cold.ttftMs <= 0) return null;
    return Number((cold.ttftMs / other.ttftMs).toFixed(2));
  };

  return [...byCtx.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([contextLength, entry]) => {
      const cold = entry.cold ?? null;
      const partial = entry.partial ?? null;
      const warm = entry.warm ?? null;
      return {
        contextLength,
        cold,
        partial,
        warm,
        warmSpeedup: ratio(cold, warm),
        partialSpeedup: ratio(cold, partial),
        warmReuseRatio:
          warm && warm.cacheReusedTokens != null && warm.promptTokens > 0
            ? Number((warm.cacheReusedTokens / warm.promptTokens).toFixed(3))
            : null,
      };
    });
}
