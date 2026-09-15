/**
 * 用量账本：把每一次上游 LLM 请求记成一行，并按天 / 模型 / 厂商 / 渠道聚合出来。
 *
 * 为什么要单独一张表，而不是从 `messages.stats` 汇总：
 * 1. **网关转发的调用根本没有本地消息** —— 外部 agent（Claude Code / Codex / Pi…）
 *    打进来一次就发一次请求，之前的代码连日志都不留；
 * 2. 应用内 Agent 一次回答跨多步，`messages.stats` 只存整个回合的合计，
 *    想看「哪一步花了多少」只能靠这里按步记的流水；
 * 3. 生图 / 视频 / OCR / 翻译这些入口各有自己的记录表，字段口径不一，
 *    要放在一张统计页里对比就得先归一到同一种形状。
 *
 * 记录失败绝不能影响主流程（统计是附加价值，不是业务），所以 `recordUsageEvent`
 * 自己吞掉异常 —— 但只吞一次：库写不进去属于真问题，进程内报一次足以被
 * `omi logs` 看到，不必每条调用都刷一遍。
 */
import { eq, sql } from "drizzle-orm";

import { db } from "./db";
import { cloudProviders, usageRecords } from "./db/schema";
import { getSetting } from "./db/settings";
import { logEvent } from "./app-log";
import { ENGINE_SHORT_NAMES } from "../shared/engines";
import type { InferenceEngine } from "../shared/modelscope";
import {
  ACTIVITY_DAYS,
  USAGE_CHANNELS,
  type UsageBreakdownRow,
  type UsageChannel,
  type UsageDayBucket,
  type UsageRecordInput,
  type UsageStats,
  type UsageSummary,
  type UsageTrendSeries,
  type UsageUpstream,
} from "../shared/usage";

/** 模型 / 厂商名缺失时的占位（界面上原样显示，两种语言都读得通）。 */
const UNKNOWN = "—";

/** 趋势图最多画几条模型线，其余并成「其他」—— 线再多就看不清谁是谁了。 */
const TREND_SERIES_MAX = 6;

// ---------------------------------------------------------------------------
// 记录
// ---------------------------------------------------------------------------

/**
 * 本地时区下的 YYYY-MM-DD。
 * 不用 `toISOString()` —— 那是 UTC，东八区的凌晨会被算到前一天，
 * 热力图与「今日」都会错位一天。
 */
export function localDay(ts: number = Date.now()): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 把 YYYY-MM-DD 往前推 n 天（按本地日期算，跨夏令时也不会差一天）。 */
export function shiftDay(day: string, deltaDays: number): string {
  const [y = 1970, m = 1, d = 1] = day.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + deltaDays);
  return localDay(date.getTime());
}

let loggedWriteFailure = false;

/**
 * 记一行用量。
 *
 * 调用方负责决定「这次调用值不值得记」：token 全 0 的空回合（比如被中断、
 * 报错的那一步）不该占一行，否则请求次数会被失败重试撑大；而生图 / 生视频
 * 这类本来就没有 token 的渠道，每次成功调用都该记（token 为 0，只计次数）。
 */
export function recordUsageEvent(input: UsageRecordInput): void {
  const requests = Math.max(0, Math.round(input.requests ?? 1));
  if (requests <= 0) return;
  const inputTokens = nonNegative(input.inputTokens);
  const outputTokens = nonNegative(input.outputTokens);

  try {
    db.insert(usageRecords)
      .values({
        createdAt: Date.now(),
        day: localDay(),
        channel: input.channel,
        upstream: input.upstream,
        provider: (input.provider || "").trim() || UNKNOWN,
        model: (input.model || "").trim() || UNKNOWN,
        inputTokens,
        outputTokens,
        cachedTokens: nonNegative(input.cachedTokens),
        reasoningTokens: nonNegative(input.reasoningTokens),
        requests,
        estimated: input.estimated ? 1 : 0,
      })
      .run();
  } catch (e) {
    // 统计写不进去不是业务错误：报一次就够（见文件头注释）。
    if (loggedWriteFailure) return;
    loggedWriteFailure = true;
    logEvent({
      level: "warn",
      source: "usage",
      event: "usage.record.failed",
      message: e instanceof Error ? e.message : String(e),
      detail: { channel: input.channel, model: input.model, provider: input.provider },
    });
  }
}

function nonNegative(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

// ---------------------------------------------------------------------------
// 厂商 / 模型名解析
// ---------------------------------------------------------------------------

/** 本地引擎展示名（llama.cpp / vLLM / SGLang / MLX…）。 */
export function localUsageProvider(): string {
  const engine = (getSetting("INFERENCE_ENGINE") || "llama.cpp") as InferenceEngine;
  return ENGINE_SHORT_NAMES[engine] ?? engine;
}

/**
 * 云端厂商展示名：当前激活厂商的名字。
 *
 * **直接查表而不是 import `cloud-providers`**：那个模块在测试里常被部分 mock
 * （只补几个用到的函数），一旦它进了本模块的依赖图，任何一个这样的 mock 都会让
 * 「模块新增了一个导出」这类改动在**本模块**上炸成 "Export not found"，而报错
 * 现场离真正的原因很远。表结构与设置键是稳定契约，读它的代价可以忽略。
 *
 * 不走 `getChatProviderLabel()` 的另一个原因：那个函数按 SERVER_MODE 判断，
 * 而网关的云端分支与当前模式无关（本地模式下的外部 agent 一样可能被路由到云端）。
 * 取不到厂商名（配置被删）时退回地址主机名 —— 总比统一写成「云端」有用，
 * 至少能把几家里的哪一家认出来。
 */
export function cloudUsageProvider(): string {
  try {
    const id = (getSetting("CLOUD_PROVIDER") || "").trim();
    if (id) {
      const row = db
        .select({ name: cloudProviders.name })
        .from(cloudProviders)
        .where(eq(cloudProviders.id, id))
        .get();
      if (row?.name) return row.name;
    }
  } catch {
    // 厂商表读不出来（迁移未跑完等）时继续往下退
  }
  const base = (getSetting("VLLM_API_BASE") || "").trim();
  if (base) {
    try {
      return new URL(base).host;
    } catch {
      // 地址是半截字符串（用户还在编辑）—— 原样返回也比「云端」具体
      return base.replace(/^https?:\/\//, "").split("/")[0] || UNKNOWN;
    }
  }
  return UNKNOWN;
}

/** 某个上游对应的厂商展示名。 */
export function providerLabelFor(upstream: UsageUpstream): string {
  return upstream === "local" ? localUsageProvider() : cloudUsageProvider();
}

/** 当前模式对应的上游。 */
export function currentUpstream(): UsageUpstream {
  return getSetting("SERVER_MODE") === "local" ? "local" : "cloud";
}

/** pi-ai 的 `Usage` 形状（Agent 每一步 / 压缩摘要拿到的就是它）。 */
export type PiUsage = {
  input?: number;
  output?: number;
  /** 命中缓存的输入，是 `input` 的子集。 */
  cacheRead?: number;
  /** 思考 tokens，是 `output` 的子集。 */
  reasoning?: number;
};

/**
 * 记录一次模型调用，厂商 / 上游按当前配置推断。
 *
 * pi-ai 的 `input` / `output` 才是计费口径，`cacheRead` 与 `reasoning` 分别是它们
 * 的**子集** —— 只按前两者累计，后两者单独存字段、界面上当"其中"展示，
 * 重复加进去会虚高。
 *
 * 一个 token 都没走的一步不记：被中断 / 报错的那一步重试几次就会把「调用次数」
 * 撑得比实际大，而它确实没消耗算力。
 */
export function recordTokenUsage(input: {
  channel: UsageChannel;
  model: string;
  usage?: PiUsage | null;
}): void {
  const inputTokens = input.usage?.input ?? 0;
  const outputTokens = input.usage?.output ?? 0;
  if (inputTokens === 0 && outputTokens === 0) return;
  const upstream = currentUpstream();
  recordUsageEvent({
    channel: input.channel,
    upstream,
    provider: providerLabelFor(upstream),
    model: input.model,
    inputTokens,
    outputTokens,
    cachedTokens: input.usage?.cacheRead,
    reasoningTokens: input.usage?.reasoning,
  });
}

// ---------------------------------------------------------------------------
// 聚合
// ---------------------------------------------------------------------------

type DayRow = {
  day: string;
  input: number;
  output: number;
  cached: number;
  reasoning: number;
  requests: number;
};

type ModelProviderRow = {
  model: string;
  provider: string;
  input: number;
  output: number;
  cached: number;
  requests: number;
  last_used: number | null;
};

type ChannelRow = {
  channel: string;
  input: number;
  output: number;
  cached: number;
  requests: number;
};

type TrendRow = { day: string; model: string; tokens: number };

/** 空库时那张 `select sum(...)` 会回一行全 NULL，统一成 0 的空概要。 */
const EMPTY_TOTALS = {
  input: 0,
  output: 0,
  requests: 0,
  records: 0,
  estimated: 0,
  models: 0,
  providers: 0,
};

/**
 * 读统计。
 *
 * 概要（累计 / 峰值 / 连击）永远是**全量**口径 —— 参考图里「累计 Token 数」
 * 不该因为切了「近 7 日」就变小；区间只作用于趋势与下面几张分组表。
 */
export function getUsageStats(rangeDays = 30): UsageStats {
  const now = Date.now();
  const today = localDay(now);
  const days = rangeDaysFor(rangeDays, today).days;
  const rangeStart = days[0];

  const dayRows = db.all<DayRow>(
    sql`select day,
               cast(coalesce(sum(input_tokens), 0) as integer) as input,
               cast(coalesce(sum(output_tokens), 0) as integer) as output,
               cast(coalesce(sum(cached_tokens), 0) as integer) as cached,
               cast(coalesce(sum(reasoning_tokens), 0) as integer) as reasoning,
               cast(coalesce(sum(requests), 0) as integer) as requests
          from usage_records
         group by day
         order by day`,
  );

  type TotalsRow = {
    input: number;
    output: number;
    requests: number;
    records: number;
    estimated: number;
    models: number;
    providers: number;
  };
  const totals = db.all<TotalsRow>(
    sql`select cast(coalesce(sum(input_tokens), 0) as integer) as input,
               cast(coalesce(sum(output_tokens), 0) as integer) as output,
               cast(coalesce(sum(requests), 0) as integer) as requests,
               count(*) as records,
               cast(coalesce(sum(estimated), 0) as integer) as estimated,
               count(distinct model) as models,
               count(distinct provider) as providers
          from usage_records`,
  )[0];

  const modelRows = db.all<ModelProviderRow>(
    sql`select model, provider,
               cast(coalesce(sum(input_tokens), 0) as integer) as input,
               cast(coalesce(sum(output_tokens), 0) as integer) as output,
               cast(coalesce(sum(cached_tokens), 0) as integer) as cached,
               cast(coalesce(sum(requests), 0) as integer) as requests,
               max(created_at) as last_used
          from usage_records
         where day >= ${rangeStart}
         group by model, provider`,
  );

  const channelRows = db.all<ChannelRow>(
    sql`select channel,
               cast(coalesce(sum(input_tokens), 0) as integer) as input,
               cast(coalesce(sum(output_tokens), 0) as integer) as output,
               cast(coalesce(sum(cached_tokens), 0) as integer) as cached,
               cast(coalesce(sum(requests), 0) as integer) as requests
          from usage_records
         where day >= ${rangeStart}
         group by channel`,
  );

  const trendRows = db.all<TrendRow>(
    sql`select day, model,
               cast(coalesce(sum(input_tokens + output_tokens), 0) as integer) as tokens
          from usage_records
         where day >= ${rangeStart}
         group by day, model`,
  );

  const activity = dayRows.map(toDayBucket);

  return {
    generatedAt: now,
    rangeDays: days.length,
    summary: buildSummary(totals ?? EMPTY_TOTALS, dayRows, activity, today),
    range: {
      days,
      tokens: modelRows.reduce((sum, r) => sum + r.input + r.output, 0),
      requests: channelRows.reduce((sum, r) => sum + r.requests, 0),
    },
    activity: activity.slice(-ACTIVITY_DAYS),
    trend: buildTrend(days, trendRows),
    models: buildModelRows(modelRows),
    providers: buildProviderRows(modelRows),
    channels: buildChannelRows(channelRows),
  };
}

/** 区间的每一天（含今天），以及首日。 */
function rangeDaysFor(rangeDays: number, today: string): { days: string[] } {
  // 前端传 0 / 负数 / NaN 时不要静默变成"30 天"：夹到边界值，画出来的区间与
  // 请求的天数才对得上（也免得"近 0 日"看起来像没生效）。
  const count = Number.isFinite(rangeDays) ? Math.min(Math.max(Math.round(rangeDays), 1), 400) : 30;
  const days: string[] = [];
  for (let i = count - 1; i >= 0; i--) days.push(shiftDay(today, -i));
  return { days };
}

function toDayBucket(row: DayRow): UsageDayBucket {
  return {
    day: row.day,
    inputTokens: row.input,
    outputTokens: row.output,
    tokens: row.input + row.output,
    cachedTokens: row.cached,
    reasoningTokens: row.reasoning,
    requests: row.requests,
  };
}

function buildSummary(
  totals: {
    input: number;
    output: number;
    requests: number;
    records: number;
    estimated: number;
    models: number;
    providers: number;
  },
  dayRows: DayRow[],
  activity: UsageDayBucket[],
  today: string,
): UsageSummary {
  const peak = activity.reduce<UsageDayBucket | null>(
    (best, bucket) => (!best || bucket.tokens > best.tokens ? bucket : best),
    null,
  );
  const activeDays = dayRows.map((r) => r.day);
  const todayBucket = activity.find((b) => b.day === today);

  return {
    inputTokens: totals?.input ?? 0,
    outputTokens: totals?.output ?? 0,
    tokens: (totals?.input ?? 0) + (totals?.output ?? 0),
    requests: totals?.requests ?? 0,
    todayTokens: todayBucket?.tokens ?? 0,
    todayRequests: todayBucket?.requests ?? 0,
    peakDay: peak && peak.tokens > 0 ? peak : null,
    activeDays: activeDays.length,
    currentStreak: currentStreak(activeDays, today),
    longestStreak: longestStreak(activeDays),
    firstDay: activeDays[0] ?? null,
    modelCount: totals?.models ?? 0,
    providerCount: totals?.providers ?? 0,
    estimatedShare: totals && totals.records > 0 ? totals.estimated / totals.records : 0,
  };
}

/**
 * 当前连续天数：今天有记录就从今天数，今天还没有就从昨天数
 * （早上打开一看连击断了会很泄气 —— 而且今天确实还没结束）。
 */
function currentStreak(days: string[], today: string): number {
  if (days.length === 0) return 0;
  const set = new Set(days);
  let cursor = set.has(today) ? today : shiftDay(today, -1);
  let streak = 0;
  while (set.has(cursor)) {
    streak += 1;
    cursor = shiftDay(cursor, -1);
  }
  return streak;
}

function longestStreak(days: string[]): number {
  if (days.length === 0) return 0;
  const sorted = [...new Set(days)].sort();
  let best = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1] as string;
    run = sorted[i] === shiftDay(prev, 1) ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}

/** 按模型合并（同一模型可能来自多个厂商，detail 里列清楚）。 */
function buildModelRows(rows: ModelProviderRow[]): UsageBreakdownRow[] {
  const byModel = new Map<string, { row: UsageBreakdownRow; providers: Map<string, number> }>();
  for (const r of rows) {
    const tokens = r.input + r.output;
    const entry = byModel.get(r.model) ?? {
      row: {
        key: r.model,
        label: r.model,
        inputTokens: 0,
        outputTokens: 0,
        tokens: 0,
        cachedTokens: 0,
        requests: 0,
        share: 0,
        lastUsedAt: 0,
      },
      providers: new Map<string, number>(),
    };
    entry.row.inputTokens += r.input;
    entry.row.outputTokens += r.output;
    entry.row.tokens += tokens;
    entry.row.cachedTokens += r.cached;
    entry.row.requests += r.requests;
    entry.row.lastUsedAt = Math.max(entry.row.lastUsedAt, r.last_used ?? 0);
    entry.providers.set(r.provider, (entry.providers.get(r.provider) ?? 0) + tokens);
    byModel.set(r.model, entry);
  }

  const out = [...byModel.values()].map(({ row, providers }) => {
    const names = [...providers.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
    return {
      ...row,
      // 多个厂商跑过同一个模型名时才补这一行说明 —— 单一来源时纯属噪音。
      ...(names.length > 1 ? { detail: names.slice(0, 3).join(" · ") } : {}),
    };
  });
  return withShares(out);
}

function buildProviderRows(rows: ModelProviderRow[]): UsageBreakdownRow[] {
  const byProvider = new Map<string, UsageBreakdownRow & { models: Set<string> }>();
  for (const r of rows) {
    const entry = byProvider.get(r.provider) ?? {
      key: r.provider,
      label: r.provider,
      inputTokens: 0,
      outputTokens: 0,
      tokens: 0,
      cachedTokens: 0,
      requests: 0,
      share: 0,
      lastUsedAt: 0,
      models: new Set<string>(),
    };
    entry.inputTokens += r.input;
    entry.outputTokens += r.output;
    entry.tokens += r.input + r.output;
    entry.cachedTokens += r.cached;
    entry.requests += r.requests;
    entry.lastUsedAt = Math.max(entry.lastUsedAt, r.last_used ?? 0);
    if (r.model !== UNKNOWN) entry.models.add(r.model);
    byProvider.set(r.provider, entry);
  }

  const out = [...byProvider.values()].map(({ models, ...row }) => ({
    ...row,
    // 厂商行的副标题是"用了它家几个模型"，比列模型名更能一眼看出用量结构。
    ...(models.size > 0 ? { detail: String(models.size) } : {}),
  }));
  return withShares(out);
}

function buildChannelRows(rows: ChannelRow[]): UsageBreakdownRow[] {
  // 没有记录的渠道也要出现（显示为 0），否则用户会以为这个入口根本没被统计。
  const byChannel = new Map<string, UsageBreakdownRow>();
  for (const channel of USAGE_CHANNELS) {
    byChannel.set(channel, {
      key: channel,
      label: channel,
      inputTokens: 0,
      outputTokens: 0,
      tokens: 0,
      cachedTokens: 0,
      requests: 0,
      share: 0,
      lastUsedAt: 0,
    });
  }
  for (const r of rows) {
    const entry = byChannel.get(r.channel) ?? {
      key: r.channel,
      label: r.channel,
      inputTokens: 0,
      outputTokens: 0,
      tokens: 0,
      cachedTokens: 0,
      requests: 0,
      share: 0,
      lastUsedAt: 0,
    };
    entry.inputTokens += r.input;
    entry.outputTokens += r.output;
    entry.tokens += r.input + r.output;
    entry.cachedTokens += r.cached;
    entry.requests += r.requests;
    byChannel.set(r.channel, entry);
  }
  // 渠道按**调用次数**算占比：生图 / 生视频没有 token，用 token 当分母的话它们永远
  // 显示 0%，而「这个入口到底被用了多少次」正是这一栏要回答的。
  return withShares([...byChannel.values()], "requests");
}

/**
 * 算占比并排序。
 *
 * 默认按 token（模型 / 厂商两栏的主口径）；整个区间一个 token 都没有时退回按请求数，
 * 否则只生过图的用户会看到一列 0% 而以为统计坏了。
 */
function withShares(rows: UsageBreakdownRow[], by: "tokens" | "requests" = "tokens"): UsageBreakdownRow[] {
  const byTokens = rows.reduce((sum, r) => sum + r.tokens, 0);
  const unit = by === "tokens" && byTokens > 0 ? "tokens" : "requests";
  const base = rows.reduce((sum, r) => sum + (unit === "tokens" ? r.tokens : r.requests), 0);
  return rows
    .map((r) => ({
      ...r,
      share: base > 0 ? (unit === "tokens" ? r.tokens : r.requests) / base : 0,
    }))
    .sort((a, b) => b.tokens - a.tokens || b.requests - a.requests || a.label.localeCompare(b.label));
}

/**
 * 每日趋势：按模型取区间内 top N 画线，其余并成「其他」。
 * 用总量排序而不是「最近出现」—— 一条只在最后两天冒头的线更该被看见。
 */
function buildTrend(
  days: string[],
  rows: TrendRow[],
): { days: string[]; series: UsageTrendSeries[]; other: UsageTrendSeries | null } {
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.model, (totals.get(r.model) ?? 0) + r.tokens);
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, TREND_SERIES_MAX).map(([model]) => model);

  const index = new Map(days.map((day, i) => [day, i]));
  const series: UsageTrendSeries[] = top.map((model) => ({
    key: model,
    label: model,
    values: days.map(() => 0),
    tokens: totals.get(model) ?? 0,
  }));
  const byModel = new Map(series.map((s) => [s.key, s]));
  const otherValues = days.map(() => 0);
  let otherTokens = 0;

  for (const r of rows) {
    const at = index.get(r.day);
    if (at == null) continue; // 区间外的历史日（趋势只画区间）
    const target = byModel.get(r.model);
    if (target) target.values[at] = (target.values[at] ?? 0) + r.tokens;
    else {
      otherValues[at] = (otherValues[at] ?? 0) + r.tokens;
      otherTokens += r.tokens;
    }
  }

  return {
    days,
    series,
    other: otherTokens > 0
      ? { key: "__other", label: "other", values: otherValues, tokens: otherTokens }
      : null,
  };
}
