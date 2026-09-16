import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { mockModulePartial } from "./test-mocks";
import { BENCHMARK_MAX_CONTEXT, BENCHMARK_MIN_CONTEXT } from "../shared/benchmark";

/**
 * 速度扫描的行为：档位规范化、缓存场景（冷启 / 部分命中 / 完全命中）、单档失败
 * 不打断整轮、超窗早停。
 *
 * 假服务端不是"收下请求就回"，它带一个**前缀缓存预言机**：按最长公共前缀算出
 * 有多少 tokens 可以直接复用（就是 llama.cpp 的 timings.cache_n），再原样报回来。
 * 于是"冷启档到底有没有避开缓存""部分命中档到底共享了多少前缀"这些说法都能被
 * 断言钉住 —— 只靠肉眼看 TTFT 是看不出真假的。
 */

/** 服务端接受的 prompt tokens 上限；超过就按 llama.cpp / vLLM 的口吻拒绝。 */
let maxPromptTokens = Number.POSITIVE_INFINITY;
/** 假服务端的地址；指向不可达端口就能造出"服务没起"的整轮失败。 */
let providerBaseUrl = "";
/** 假服务端收到的每个请求（测 prompt 形态用）。 */
type SeenRequest = { prompt: string; stream: boolean; promptTokens: number; cacheTokens: number };
let seen: SeenRequest[] = [];

/** 前缀缓存：留着最近几段见过的 prompt，按最长公共前缀算可复用的 tokens。 */
let cachedPrompts: string[] = [];

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

/** 与真实服务端一致的 4 字符/token 折算。 */
const tokensOf = (text: string) => Math.ceil(text.length / 4);

const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
    const body = (await req.json()) as {
      messages: { content?: string }[];
      max_tokens?: number;
      stream?: boolean;
    };
    const prompt = body.messages[0]?.content ?? "";
    const promptTokens = tokensOf(prompt);
    // 命中判定：与缓存里任一段的最长公共前缀（真实引擎也是这么算的，只是按块/槽位）
    const reuseChars = cachedPrompts.reduce((best, p) => Math.max(best, commonPrefixLength(prompt, p)), 0);
    const cacheTokens = Math.floor(reuseChars / 4);
    cachedPrompts = [prompt, ...cachedPrompts].slice(0, 8);
    seen.push({ prompt, stream: body.stream === true, promptTokens, cacheTokens });

    if (promptTokens > maxPromptTokens) {
      return new Response(
        JSON.stringify({ error: { message: `The request exceeds the available context size (${maxPromptTokens})` } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    if (!body.stream) {
      return Response.json({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: promptTokens, completion_tokens: 1 },
      });
    }
    const gen = body.max_tokens ?? 8;
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}\n\n`,
      `data: ${JSON.stringify({
        choices: [],
        usage: { prompt_tokens: promptTokens, completion_tokens: gen },
        // llama.cpp 的末块形状
        timings: { prompt_n: promptTokens - cacheTokens, cache_n: cacheTokens, predicted_n: gen },
      })}\n\n`,
      "data: [DONE]\n\n",
    ];
    return new Response(chunks.join(""), { headers: { "Content-Type": "text/event-stream" } });
  },
});
providerBaseUrl = `http://127.0.0.1:${server.port}`;

export const FAKE_PROVIDER = {
  id: "bench-test",
  name: "测试厂商",
  vendor: "测试",
  models: [{ id: "test-model", type: "chat" as const }],
  enabled: true,
  videoApi: "" as const,
  musicApi: "" as const,
  createdAt: 0,
  updatedAt: 0,
  apiKey: "sk-test",
};

// 服务商行来自 cloud_providers 表：这里只替换查询，其余导出保持真实实现
// （见 test-mocks.ts —— 手写替身漏导出会在 import 阶段炸掉别的文件）。
await mockModulePartial<typeof import("./cloud-providers")>("./cloud-providers", {
  getCloudProviderInfo: (id: string) =>
    id === FAKE_PROVIDER.id ? { ...FAKE_PROVIDER, baseUrl: providerBaseUrl } : null,
});

const { startBenchmark, getBenchmarkRun, requestTimeoutMs, isContextOverflowError, isTimeoutError } = await import(
  "./benchmark"
);

afterAll(() => {
  server.stop(true);
});

beforeAll(() => {
  maxPromptTokens = Number.POSITIVE_INFINITY;
  providerBaseUrl = `http://127.0.0.1:${server.port}`;
});

async function runToCompletion(params: Parameters<typeof startBenchmark>[0]) {
  seen = [];
  cachedPrompts = [];
  const started = startBenchmark(params);
  if ("error" in started) throw new Error(started.error);
  const deadline = Date.now() + 30_000;
  for (;;) {
    const state = getBenchmarkRun(started.runId);
    if (state && state.status !== "running") return state;
    if (Date.now() > deadline) throw new Error("benchmark run did not finish in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 测量请求（流式）里的 prompt。 */
const measuredPrompts = () => seen.filter((s) => s.stream).map((s) => s.prompt);
/** 预热请求（非流式）里的 prompt。 */
const warmupPrompts = () => seen.filter((s) => !s.stream).map((s) => s.prompt);
/** 冷启档的唯一标记在最前面；部分命中档的标记在尾巴的开头（共享前缀之后）。 */
const isCold = (p: string) => /^cold[01]-/.test(p);
const tailStart = (p: string) => p.length - Math.floor(p.length * 0.1);
const isPartial = (p: string) => /^partial[01]-/.test(p.slice(tailStart(p)));
const isWarm = (p: string) => !isCold(p) && !isPartial(p);

describe("超时预算", () => {
  test("小档位保持老版本的 10 分钟下限，大档位随时长放大（1M 档不会一上来就超时）", () => {
    expect(requestTimeoutMs(1024, 128)).toBe(600_000);
    expect(requestTimeoutMs(32768, 128)).toBeGreaterThan(600_000);
    expect(requestTimeoutMs(131072, 128)).toBeGreaterThan(requestTimeoutMs(65536, 128));
    // 但也不能不封顶：卡死的服务端要能收场
    expect(requestTimeoutMs(1 << 20, 8192)).toBeLessThanOrEqual(3 * 3600_000);
  });
});

describe("失败原因归类", () => {
  test("认得各家的超窗文案", () => {
    expect(isContextOverflowError("The request exceeds the available context size (8192)")).toBe(true);
    expect(isContextOverflowError("This model's maximum context length is 32768 tokens")).toBe(true);
    expect(isContextOverflowError('{"code":"context_length_exceeded"}')).toBe(true);
    expect(isContextOverflowError("Internal Server Error")).toBe(false);
  });

  test("超时与其它错误分开", () => {
    expect(isTimeoutError("timeout")).toBe(true);
    expect(isTimeoutError("The operation timed out")).toBe(true);
    expect(isTimeoutError("The request exceeds the available context size")).toBe(false);
  });
});

describe("档位扫描", () => {
  test("正常扫描：每档都是一行，成功率与 summary 都有值", async () => {
    maxPromptTokens = Number.POSITIVE_INFINITY;
    const state = await runToCompletion({
      model: "test-model",
      providerId: FAKE_PROVIDER.id,
      contexts: [1024, 4096, 1024], // 乱序 + 重复：规范化后应当是两档
      cacheModes: ["warm"],
      genLength: 32,
      batchSize: 1,
    });

    expect(state.status).toBe("done");
    expect(state.rows.map((r) => r.contextLength)).toEqual([1024, 4096]);
    for (const row of state.rows) {
      expect(row.ok).toBe(1);
      expect(row.fails).toBe(0);
      // prompt tokens 取自测量请求的 usage：与目标档位一致，不算截断
      expect(row.promptTokens).toBe(row.contextLength);
      expect(row.truncated).toBeUndefined();
      expect(row.tps).toBeGreaterThan(0);
      expect(row.cache).toBe("warm");
    }
    expect(state.summary?.avgTps).toBeGreaterThan(0);
    expect(state.summary?.basis).toBe("warm");
    expect(state.stopped).toBeUndefined();
  });

  test("超窗档位：记录失败与原因，跳过更大的档位与同档其它场景，前面测出来的数据保留", async () => {
    maxPromptTokens = 12_288;
    const state = await runToCompletion({
      model: "test-model",
      providerId: FAKE_PROVIDER.id,
      // 16384 之后还有两档：它们必然同样被拒，不该再跑（1M 一档要几十分钟）
      contexts: [1024, 16384, 65536, BENCHMARK_MAX_CONTEXT],
      genLength: 32,
      batchSize: 1,
    });

    expect(state.status).toBe("done");
    // 1024 跑了三种场景；16384 上第一道（冷启）就被拒，同档的另外两种与更大的档位全跳过
    expect(state.rows.map((r) => `${r.contextLength}/${r.cache}`)).toEqual([
      "1024/cold",
      "1024/partial",
      "1024/warm",
      "16384/cold",
    ]);
    const failed = state.rows[3]!;
    expect(failed.ok).toBe(0);
    expect(failed.error).toContain("exceeds the available context size");
    expect(state.stopped).toEqual({ reason: "context-overflow", contextLength: 16384 });
    expect(state.summary?.stopped?.reason).toBe("context-overflow");
    // 失败档位不摊进平均，且平均只取冷启（唯一没被缓存粉饰的那种工况）
    expect(state.summary?.basis).toBe("cold");
    expect(state.summary?.avgTps).toBe(state.rows[0]!.tps);
    maxPromptTokens = Number.POSITIVE_INFINITY;
  });

  test("服务不可达：第一档就失败时整轮判错，不留下五个必然失败的档位", async () => {
    providerBaseUrl = "http://127.0.0.1:1";
    const state = await runToCompletion({
      model: "test-model",
      providerId: FAKE_PROVIDER.id,
      contexts: [1024, 4096],
      genLength: 32,
      batchSize: 1,
    });
    providerBaseUrl = `http://127.0.0.1:${server.port}`;

    expect(state.status).toBe("error");
    expect(state.error).toBeTruthy();
    expect(state.summary?.avgTps).toBe(0);
  });

  test("档位下限 128：RPC 传来 0 或负数也不会变成空 prompt", async () => {
    const state = await runToCompletion({
      model: "test-model",
      providerId: FAKE_PROVIDER.id,
      contexts: [0, 8],
      cacheModes: ["warm"],
      genLength: 32,
      batchSize: 1,
    });
    expect(state.rows.map((r) => r.contextLength)).toEqual([BENCHMARK_MIN_CONTEXT]);
  });
});

describe("缓存场景", () => {
  const ctx = 4096;
  const promptLength = ctx * 4;

  /** 一个档位跑三种场景（显式指定，用于验证形态）。 */
  async function runThreeModes(batchSize = 1) {
    return runToCompletion({
      model: "test-model",
      providerId: FAKE_PROVIDER.id,
      contexts: [ctx],
      cacheModes: ["cold", "partial", "warm"],
      genLength: 32,
      batchSize,
    });
  }

  test("默认三种场景都测，每个档位出三行（冷启 → 部分命中 → 完全命中）", async () => {
    // 不传 cacheModes：走默认值
    const state = await runToCompletion({
      model: "test-model",
      providerId: FAKE_PROVIDER.id,
      contexts: [ctx],
      genLength: 32,
      batchSize: 1,
    });
    expect(state.rows.map((r) => r.cache)).toEqual(["cold", "partial", "warm"]);
    // 三行的 prompt 长度一致：对比的才是同一档位下的缓存差异
    expect([...new Set(measuredPrompts().map((p) => p.length))]).toEqual([promptLength]);
  });

  test("冷启档从第 1 个 token 就分叉：与正文/与彼此都没有可复用的前缀", async () => {
    await runThreeModes();
    const cold = measuredPrompts().filter(isCold);
    const warm = measuredPrompts().filter(isWarm);
    expect(cold).toHaveLength(1);
    expect(warm).toHaveLength(1);
    // 与正文（完全命中档的内容）几乎无公共前缀 —— 前缀缓存是按最长公共前缀命中的，
    // 标记放结尾会变成"整段可复用"，那就不是冷启了
    expect(commonPrefixLength(cold[0]!, warm[0]!)).toBeLessThan(64);
  });

  test("部分命中档：共享 90% 前缀，只有尾巴是新的（多轮对话的形态）", async () => {
    await runThreeModes();
    const partial = measuredPrompts().find(isPartial)!;
    const warm = measuredPrompts().find(isWarm)!;
    const sharedPrefix = tailStart(partial);
    expect(warm.slice(0, sharedPrefix)).toBe(partial.slice(0, sharedPrefix));
    // 尾巴必须真的不一样，否则就成了"完全命中"而不是"部分命中"
    expect(warm.slice(sharedPrefix)).not.toBe(partial.slice(sharedPrefix));
  });

  test("完全命中档：测量请求与预热请求逐字相同（命中前提）", async () => {
    await runThreeModes();
    const warm = measuredPrompts().find(isWarm)!;
    expect(warmupPrompts()).toContain(warm);
  });

  test("并发批次里每个请求的前缀各不相同：同批的第 2 个请求不该蹭到第 1 个的缓存", async () => {
    await runThreeModes(2);
    const cold = measuredPrompts().filter(isCold);
    const partial = measuredPrompts().filter(isPartial);
    expect(cold).toHaveLength(2);
    expect(partial).toHaveLength(2);
    expect(new Set(cold.map((p) => p.slice(0, 64))).size).toBe(2);
    expect(new Set(partial.map((p) => p.slice(tailStart(p), tailStart(p) + 64))).size).toBe(2);
    // 同批的 partial 仍然共享正文前缀（缓存收益照拿，只是尾巴不同）
    const shared = tailStart(partial[0]!);
    expect(partial[1]!.slice(0, shared)).toBe(partial[0]!.slice(0, shared));
  });

  test("缓存预言机证实三种形态：冷启 0 复用、部分命中大半复用、完全命中整段复用", async () => {
    const state = await runThreeModes();
    const rowOf = (cache: string) => state.rows.find((r) => r.cache === cache)!;
    // 服务端（假服务端按最长公共前缀算）报的 cache_n 就是"到底命中没有"的权威答案
    expect(rowOf("cold").cacheReusedTokens ?? 0).toBeLessThan(64);
    expect(rowOf("partial").cacheReusedTokens ?? 0).toBeGreaterThan(ctx * 0.8);
    expect(rowOf("warm").cacheReusedTokens ?? 0).toBeGreaterThan(ctx * 0.95);
  });

  test("只勾一种场景时只跑一种（跑 1M 时没人想白等三遍）", async () => {
    const state = await runToCompletion({
      model: "test-model",
      providerId: FAKE_PROVIDER.id,
      contexts: [1024, 4096],
      cacheModes: ["cold"],
      genLength: 32,
      batchSize: 1,
    });
    expect(state.rows.map((r) => `${r.contextLength}/${r.cache}`)).toEqual(["1024/cold", "4096/cold"]);
    expect(state.summary?.basis).toBe("cold");
    // 冷启档不该出现"与测量请求相同的预热"：那会把冷启变成命中
    for (const p of measuredPrompts().filter(isCold)) expect(warmupPrompts()).not.toContain(p);
    expect(state.progress.total).toBe(2);
  });

  test("进度按 档位 × 场景 计数", async () => {
    const state = await runThreeModes();
    expect(state.progress.total).toBe(3);
    expect(state.progress.done).toBe(3);
  });
});
