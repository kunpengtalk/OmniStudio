import { describe, expect, test } from "bun:test";

import {
  BENCHMARK_DEFAULT_CACHE_MODES,
  BENCHMARK_DEFAULT_CONTEXTS,
  BENCHMARK_MAX_CONTEXT,
  BENCHMARK_MIN_CONTEXT,
  BENCHMARK_PRESET_CONTEXTS,
  cacheComparison,
  fmtCtx,
  normalizeCacheModes,
  normalizeContexts,
  parseCacheModes,
  parseContext,
  parseContexts,
  serverContextWindow,
  type CacheCompareRow,
} from "./benchmark";

/**
 * 档位表是主进程、CLI、界面共用的同一份：这三处以前各写各的，扩到 1M 时
 * 最容易出的岔子就是"界面能勾 1M、CLI 只扫到 32k"这类漂移。
 */
describe("档位表", () => {
  test("预设覆盖 1k ~ 1M，默认只到 32k（1M 一档要跑几十分钟，不能默认带上）", () => {
    expect(BENCHMARK_PRESET_CONTEXTS[0]).toBe(1024);
    expect(BENCHMARK_PRESET_CONTEXTS[BENCHMARK_PRESET_CONTEXTS.length - 1]).toBe(
      BENCHMARK_MAX_CONTEXT,
    );
    expect(BENCHMARK_MAX_CONTEXT).toBe(1048576);
    expect(BENCHMARK_DEFAULT_CONTEXTS[BENCHMARK_DEFAULT_CONTEXTS.length - 1]).toBe(32768);
    // 默认档位都得在预设里（界面上默认勾中的 chip 必须看得见）
    for (const c of BENCHMARK_DEFAULT_CONTEXTS) expect(BENCHMARK_PRESET_CONTEXTS).toContain(c);
  });
});

describe("fmtCtx", () => {
  const cases: [number, string][] = [
    [128, "128"],
    [1024, "1k"],
    [4096, "4k"],
    [32768, "32k"],
    [131072, "128k"],
    [262144, "256k"],
    [1048576, "1M"],
    // 非 2 的幂（自定义档位）按二进制换算成一位小数
    [200000, "195.3k"],
  ];

  test.each(cases)("%d → %s", (tokens, label) => {
    expect(fmtCtx(tokens)).toBe(label);
  });
});

describe("parseContext / parseContexts", () => {
  const cases: [string, number | null][] = [
    ["1024", 1024],
    ["128k", 131072],
    ["1.5k", 1536],
    ["1m", 1048576],
    [" 200000 ", 200000],
    ["", null],
    ["abc", null],
    ["0", null],
    ["-5", null],
  ];

  test.each(cases)("%s → %j", (text, expected) => {
    expect(parseContext(text)).toBe(expected);
  });

  test("列表接受逗号 / 空格分隔与 k、m 后缀，输出已规范化", () => {
    expect(parseContexts("8k, 32k,1m")).toEqual([8192, 32768, 1048576]);
    // 乱序、重复、超范围的输入一律收敛：升序去重、夹在 128 ~ 1M
    expect(parseContexts("1m,1m,64,999999999")).toEqual([128, 1048576]);
  });
});

describe("normalizeContexts", () => {
  test("去重升序，夹在 [128, 1M]", () => {
    expect(normalizeContexts([4096, 1024, 4096])).toEqual([1024, 4096]);
    expect(normalizeContexts([1, 4096, 1 << 30])).toEqual([BENCHMARK_MIN_CONTEXT, 4096, BENCHMARK_MAX_CONTEXT]);
    expect(normalizeContexts([])).toEqual([]);
  });

  test("非有限值被丢掉（RPC / 控制 socket 传来 NaN / Infinity 不能变成 prompt 长度）", () => {
    expect(normalizeContexts([Number.NaN, Number.POSITIVE_INFINITY, 8192])).toEqual([8192]);
  });
});

describe("serverContextWindow", () => {
  test("llama.cpp 的窗口按并发槽位均分（--parallel 4 + 32k 时单请求只有 8k）", () => {
    expect(serverContextWindow("llama.cpp", { SERVER_CTX_SIZE: "32768" })).toBe(32768);
    expect(serverContextWindow("llama.cpp", { SERVER_CTX_SIZE: "32768", SERVER_PARALLEL: "4" })).toBe(8192);
    // 缺省值 / 脏值不猜：返回 null，界面就不提示
    expect(serverContextWindow("llama.cpp", { SERVER_PARALLEL: "4" })).toBeNull();
    expect(serverContextWindow("llama.cpp", { SERVER_CTX_SIZE: "0" })).toBeNull();
  });

  test("vLLM / SGLang 的长度参数本来就是单请求的", () => {
    expect(serverContextWindow("vllm", { VLLM_MAX_MODEL_LEN: "131072" })).toBe(131072);
    expect(serverContextWindow("sglang", { SGLANG_CONTEXT_LENGTH: "262144" })).toBe(262144);
  });

  test("MLX 没有对应的设置键：窗口由模型决定，返回 null", () => {
    expect(serverContextWindow("mlx", { MLX_CACHE_SIZE_GB: "8" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 缓存场景
// ---------------------------------------------------------------------------

/** 造一行缓存对比用的指标（字段名与 SpeedBenchRow 对齐）。 */
function row(partial: Partial<CacheCompareRow> & { contextLength: number; cache?: "cold" | "partial" | "warm" }): CacheCompareRow {
  return { ok: 1, ttftMs: 100, tps: 10, promptTokens: partial.contextLength, ...partial };
}

describe("缓存场景的规范形态", () => {
  test("去重并按 冷启 → 部分命中 → 完全命中 排序（顺序固定，跑出来的对比才可比）", () => {
    expect(normalizeCacheModes(["warm", "cold", "warm"])).toEqual(["cold", "warm"]);
    expect(normalizeCacheModes(["partial"])).toEqual(["partial"]);
  });

  test("认不出的值被丢掉；空集回落到默认（界面不会传空，别让扫描静默变成 0 档）", () => {
    expect(normalizeCacheModes(["nope", "cold"])).toEqual(["cold"]);
    expect(normalizeCacheModes([])).toEqual(BENCHMARK_DEFAULT_CACHE_MODES);
    expect(normalizeCacheModes([null, undefined])).toEqual(BENCHMARK_DEFAULT_CACHE_MODES);
  });

  test("默认三种都测：只有命中会得到偏乐观的 TTFT，只有冷启又看不到缓存收益", () => {
    expect(BENCHMARK_DEFAULT_CACHE_MODES).toEqual(["cold", "partial", "warm"]);
  });

  test("CLI 的 --cache 文本", () => {
    expect(parseCacheModes("warm, cold")).toEqual(["cold", "warm"]);
    expect(parseCacheModes("")).toEqual(BENCHMARK_DEFAULT_CACHE_MODES);
  });
});

describe("cacheComparison", () => {
  const rows: CacheCompareRow[] = [
    row({ contextLength: 8192, cache: "cold", ttftMs: 800, tps: 20 }),
    row({ contextLength: 8192, cache: "partial", ttftMs: 200, tps: 40 }),
    row({ contextLength: 8192, cache: "warm", ttftMs: 80, tps: 60, cacheReusedTokens: 8000 }),
    row({ contextLength: 32768, cache: "cold", ttftMs: 4000, tps: 5 }),
    row({ contextLength: 32768, cache: "warm", ttftMs: 100, tps: 50, cacheReusedTokens: 30000 }),
  ];

  test("按档位并排三种场景，算出倍数与服务端自报的复用比例", () => {
    const [a, b] = cacheComparison(rows);
    expect(a!.contextLength).toBe(8192);
    expect(a!.warmSpeedup).toBe(10); // 800ms → 80ms
    expect(a!.partialSpeedup).toBe(4);
    expect(a!.warmReuseRatio).toBe(0.977); // 8000 / 8192
    // 只有冷启与完全命中时，部分命中那格留空
    expect(b!.contextLength).toBe(32768);
    expect(b!.partial).toBeNull();
    expect(b!.partialSpeedup).toBeNull();
    expect(b!.warmSpeedup).toBe(40);
  });

  test("没测出来的档位不进对比（0 会算出无穷大的收益）", () => {
    const failed = [row({ contextLength: 1024, cache: "cold", ttftMs: 0, ok: 0 }), row({ contextLength: 1024, cache: "warm", ttftMs: 50 })];
    const [entry] = cacheComparison(failed);
    expect(entry!.cold).toBeNull();
    expect(entry!.warmSpeedup).toBeNull();
  });

  test("老记录没有 cache 字段：按完全命中看待（当年就是预热过再测）", () => {
    const legacy = [row({ contextLength: 1024, ttftMs: 50 })];
    const [entry] = cacheComparison(legacy);
    expect(entry!.warm).not.toBeNull();
    expect(entry!.cold).toBeNull();
  });

  test("不报 cache_n 的引擎（vLLM / SGLang）复用比例留空，不猜一个数出来", () => {
    const noTelemetry = [row({ contextLength: 1024, cache: "warm", ttftMs: 50 })];
    expect(cacheComparison(noTelemetry)[0]!.warmReuseRatio).toBeNull();
  });
});
