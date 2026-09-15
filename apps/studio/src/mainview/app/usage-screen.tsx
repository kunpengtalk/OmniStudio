import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ActivityIcon, RefreshCwIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Spinner } from "@ui/spinner";
import { useT, useUILang } from "@stores/ui-lang";
import { cn } from "@lib/utils";
import { SettingsSection } from "./main-layout/setting-ui";
import {
  ACTIVITY_DAYS,
  USAGE_RANGES,
  type UsageBreakdownRow,
  type UsageDayBucket,
  type UsageStats,
} from "@/shared/usage";

/**
 * 设置 → 数据 → 使用统计。
 *
 * 账本本身在主进程（`bun/usage.ts`）：每一次上游调用一行，覆盖对话 / Agent /
 * 网关 / 生图 / 生视频 / OCR / 翻译。这一页只负责把它画出来，不做二次加工 ——
 * 唯一的计算是按天补齐网格（热力图需要连续的日子，而账本里只存在有记录的那几天）。
 *
 * 图表全部手写 SVG，与概览页的 Sparkline 同一套路（归一化 viewBox + Tailwind 类名
 * 上色）：引一个图表库只为四个图，构建体积和主题适配都不划算。
 */

/** 曲线配色：亮暗两套主题下都能区分（蓝绿紫是第一梯队，与概览页一致）。 */
const SERIES_COLORS = ["#3b82f6", "#22c55e", "#a855f7", "#f59e0b", "#14b8a6", "#ec4899"];

/**
 * 热力图色阶（0 → 4）。**必须是字面量**：类名会被 Tailwind 的扫描器按源码文本收集，
 * 拼出来的 `fill-${x}` 一条 CSS 都生成不出来，格子会全变成默认黑色。
 */
const HEAT_FILLS = [
  "fill-muted",
  "fill-primary/25",
  "fill-primary/45",
  "fill-primary/70",
  "fill-primary",
] as const;

/** 一天一格的尺寸（viewBox 单位，整体等比缩放，所以与屏幕像素无关）。 */
const HEAT_CELL = 11;
const HEAT_STEP = 14;

/** 紧凑计数：中文按万 / 亿，英文按 K / M / B —— 用逗号读十位数没人读得下去。 */
function formatCompact(value: number, zh: boolean): string {
  const n = Math.max(0, Math.round(value));
  if (zh) {
    if (n >= 100_000_000) return `${trimZero(n / 100_000_000)} 亿`;
    if (n >= 10_000) return `${trimZero(n / 10_000)} 万`;
    return n.toLocaleString("zh-CN");
  }
  if (n >= 1_000_000_000) return `${trimZero(n / 1_000_000_000)}B`;
  if (n >= 1_000_000) return `${trimZero(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trimZero(n / 1_000)}K`;
  return n.toLocaleString("en-US");
}

/** 一位小数，但整数不显示 `.0`（"43.8 亿" 好看，"44.0 亿" 啰嗦）。 */
function trimZero(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatExact(value: number): string {
  return Math.round(value).toLocaleString();
}

/** `YYYY-MM-DD` → 本地化的短日期。直接用字符串拆，避免时区把日期挪一天。 */
function formatDay(day: string, zh: boolean): string {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return zh ? `${m}月${d}日` : `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function formatDayLong(day: string, zh: boolean): string {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return zh ? `${y}年${m}月${d}日` : `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 把 `YYYY-MM-DD` 当作本地日期解析（`new Date("2026-09-14")` 会按 UTC 算）。 */
function dayToDate(day: string): Date {
  const [y = 1970, m = 1, d = 1] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function UsageScreen() {
  const t = useT();
  // 紧凑计数按语言换单位（中文万 / 亿，英文 K / M / B），所以这一页要拿到语言本身。
  const zh = useUILang((s) => s.lang) === "zh";
  const [rangeDays, setRangeDays] = useState<number>(30);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["usage-stats", rangeDays],
    queryFn: (): Promise<UsageStats> => rpcClient.getUsageStats({ rangeDays }),
  });

  const summary = data?.summary;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-6 py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold tracking-tight">{t("settings.usage.title")}</h2>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            {t("usage.badge")}
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          disabled={isFetching}
          onClick={() => void refetch()}
        >
          {isFetching ? (
            <Spinner className="size-3" />
          ) : (
            <RefreshCwIcon className="size-3" />
          )}
          {t("usage.refresh")}
        </Button>
      </div>

      {isLoading && !data ? (
        <div className="flex items-center justify-center py-24">
          <Spinner className="size-5" />
        </div>
      ) : !summary || (summary.tokens === 0 && summary.requests === 0) ? (
        // 只生过图 / 视频的用户 token 是 0 但确实有调用 —— 那不算"没有记录"。
        // 一行记录都没有时，与其画一堆 0，不如说清楚"从什么时候开始记"。
        <div className="flex flex-col items-center gap-2 rounded-xl border bg-card py-20 text-center">
          <ActivityIcon className="size-6 text-muted-foreground" />
          <p className="text-sm font-medium">{t("usage.empty.title")}</p>
          <p className="max-w-md text-xs text-muted-foreground">{t("usage.empty.desc")}</p>
        </div>
      ) : (
        <>
          <SummaryTiles stats={data} zh={zh} />
          <SettingsSection title={t("usage.activity.title")}>
            <ActivityHeatmap activity={data.activity} zh={zh} />
          </SettingsSection>

          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">{t("usage.range.title")}</span>
            <div className="flex gap-2">
              {USAGE_RANGES.map((days) => (
                <Button
                  key={days}
                  variant={rangeDays === days ? "default" : "outline"}
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setRangeDays(days)}
                >
                  {t(`usage.range.${days}`)}
                </Button>
              ))}
            </div>
          </div>

          <SettingsSection title={t("usage.trend.title")}>
            <TrendChart stats={data} zh={zh} />
          </SettingsSection>

          <SettingsSection title={t("usage.models.title")}>
            <ModelBreakdown rows={data.models} tokens={data.range.tokens} zh={zh} />
          </SettingsSection>

          <div className="grid gap-4 lg:grid-cols-2">
            <SettingsSection title={t("usage.providers.title")}>
              <BreakdownBars rows={data.providers} zh={zh} detailKind="models" />
            </SettingsSection>
            <SettingsSection title={t("usage.channels.title")}>
              <BreakdownBars rows={data.channels} zh={zh} detailKind="channel" />
            </SettingsSection>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 概要数字
// ---------------------------------------------------------------------------

function SummaryTiles({ stats, zh }: { stats: UsageStats; zh: boolean }) {
  const t = useT();
  const s = stats.summary;
  const tiles: { label: string; value: string; hint?: string }[] = [
    {
      label: t("usage.summary.total"),
      value: formatCompact(s.tokens, zh),
      hint: t("usage.summary.io", {
        input: formatCompact(s.inputTokens, zh),
        output: formatCompact(s.outputTokens, zh),
      }),
    },
    {
      label: t("usage.summary.requests"),
      value: formatExact(s.requests),
      hint:
        s.estimatedShare > 0
          ? t("usage.summary.estimated", { pct: String(Math.round(s.estimatedShare * 100)) })
          : t("usage.summary.measured"),
    },
    {
      label: t("usage.summary.today"),
      value: formatCompact(s.todayTokens, zh),
      hint: t("usage.summary.calls", { n: formatExact(s.todayRequests) }),
    },
    {
      label: t("usage.summary.peak"),
      value: s.peakDay ? formatCompact(s.peakDay.tokens, zh) : "—",
      hint: s.peakDay ? formatDay(s.peakDay.day, zh) : undefined,
    },
    {
      label: t("usage.summary.currentStreak"),
      value: t("usage.summary.days", { n: String(s.currentStreak) }),
      hint: t("usage.summary.activeDays", { n: String(s.activeDays) }),
    },
    {
      label: t("usage.summary.longestStreak"),
      value: t("usage.summary.days", { n: String(s.longestStreak) }),
      hint: t("usage.summary.models", { models: String(s.modelCount), providers: String(s.providerCount) }),
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-3 lg:grid-cols-6">
      {tiles.map((tile) => (
        <div key={tile.label} className="flex flex-col gap-0.5 bg-card px-4 py-3">
          <span className="text-xs text-muted-foreground">{tile.label}</span>
          <span className="text-lg font-semibold tabular-nums">{tile.value}</span>
          <span className="truncate text-[11px] text-muted-foreground" title={tile.hint}>
            {tile.hint ?? "\u00a0"}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 活动热力图
// ---------------------------------------------------------------------------

/** 近一年每天一格（53 列 × 7 行）。列是周，行是星期 —— 与 GitHub 的读法一致。 */
function ActivityHeatmap({ activity, zh }: { activity: UsageDayBucket[]; zh: boolean }) {
  const t = useT();
  const [hover, setHover] = useState<{ x: number; y: number; day: string } | null>(null);

  const byDay = useMemo(() => new Map(activity.map((b) => [b.day, b])), [activity]);

  const model = useMemo(() => {
    // 网格必须铺满整年：账本里只有"有记录的那几天"，日期要自己推。
    const today = new Date();
    const cells: { day: string; level: number; bucket: UsageDayBucket | null }[] = [];
    const start = new Date(today);
    start.setDate(start.getDate() - (ACTIVITY_DAYS - 1));
    // 首列对齐到周日（网格第一行固定是周日）。
    start.setDate(start.getDate() - start.getDay());

    const levels = heatLevels(activity);
    // 用「距起始日的天数」当循环变量：直接比较两个 Date 会被 lint 当成改不动的循环条件，
    // 而按毫秒累加在夏令时切换那天又会差一小时（本地日期可能重复或跳过）。
    const spanDays = Math.round((today.getTime() - start.getTime()) / 86_400_000);
    for (let i = 0; i <= spanDays; i++) {
      const cursor = new Date(start.getTime());
      cursor.setDate(cursor.getDate() + i);
      const day = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`;
      const bucket = byDay.get(day) ?? null;
      cells.push({
        day,
        bucket,
        level: bucket ? levels(bucket.tokens) : 0,
      });
    }

    const weeks: (typeof cells)[] = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    return {
      weeks,
      monthLabels: monthLabels(weeks, zh),
      width: Math.max(1, weeks.length) * HEAT_STEP - (HEAT_STEP - HEAT_CELL),
      height: 7 * HEAT_STEP - (HEAT_STEP - HEAT_CELL),
    };
  }, [activity, byDay, zh]);

  const showTip = (el: Element, day: string) => {
    const box = el.getBoundingClientRect();
    const host = (el.closest("[data-heatmap]") as HTMLElement | null) ?? null;
    const hostBox = host?.getBoundingClientRect();
    setHover({
      day,
      x: box.left - (hostBox?.left ?? 0) + box.width / 2,
      y: box.top - (hostBox?.top ?? 0) - 6,
    });
  };

  return (
    <div data-heatmap className="relative p-4">
      <div className="flex flex-col gap-1">
        {/* 月份刻度：按"这个月有几周"分配宽度，与下面网格的自然伸缩对齐 —— 用固定像素
            列宽的话窄窗口里刻度会跑到网格外面去。 */}
        <div className="flex pl-7 text-[10px] text-muted-foreground">
          {model.monthLabels.map((m, i) => (
            <span key={i} className="min-w-0 shrink basis-0 whitespace-nowrap" style={{ flexGrow: m.weeks }}>
              {m.label}
            </span>
          ))}
        </div>
        <div className="flex gap-1.5">
          <div className="flex w-[22px] shrink-0 flex-col justify-between py-[1px] text-[10px] leading-none text-muted-foreground">
            {/* 只标隔行，挤在一起反而看不清 */}
            <span>{t("usage.activity.day.1")}</span>
            <span>{t("usage.activity.day.3")}</span>
            <span>{t("usage.activity.day.5")}</span>
          </div>
          {/* 网格用 SVG：一年 53 列在窄窗口里必然放不下，viewBox 让它整体等比缩放，
              不会把父容器撑出横向滚动条。 */}
          <svg
            viewBox={`0 0 ${model.width} ${model.height}`}
            preserveAspectRatio="xMinYMin meet"
            className="min-w-0 flex-1"
            role="img"
          >
            {model.weeks.map((week, wi) =>
              week.map((cell, di) => (
                <rect
                  key={`${wi}-${di}`}
                  x={wi * HEAT_STEP}
                  y={di * HEAT_STEP}
                  width={HEAT_CELL}
                  height={HEAT_CELL}
                  rx={2}
                  className={cn("transition-colors", HEAT_FILLS[cell.level])}
                  onMouseEnter={(e) => showTip(e.currentTarget, cell.day)}
                  onMouseLeave={() => setHover(null)}
                />
              )),
            )}
          </svg>
        </div>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pl-7">
          <span className="text-[10px] text-muted-foreground">{t("usage.activity.hint")}</span>
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <span>{t("usage.activity.less")}</span>
            {/* 图例与网格共用一套色阶：改成 HTML 方块就得维护第二份类名，早晚会对不上。 */}
            {HEAT_FILLS.map((fill) => (
              <svg key={fill} viewBox="0 0 10 10" className="size-[10px]">
                <rect width="10" height="10" rx="2" className={fill} />
              </svg>
            ))}
            <span>{t("usage.activity.more")}</span>
          </div>
        </div>
      </div>

      {hover && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-md border bg-popover px-2 py-1 text-[11px] whitespace-nowrap shadow-md"
          style={{ left: hover.x, top: hover.y, transform: "translate(-50%, -100%)" }}
        >
          <div className="font-medium">{formatDayLong(hover.day, zh)}</div>
          <div className="text-muted-foreground">
            {t("usage.activity.tip", {
              tokens: formatCompact(byDay.get(hover.day)?.tokens ?? 0, zh),
              calls: formatExact(byDay.get(hover.day)?.requests ?? 0),
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** 四档色阶：按非零日期的四分位切，而不是按最大值均分 —— 用量波动大的时候后者全是浅色。 */
function heatLevels(activity: UsageDayBucket[]): (tokens: number) => number {
  const values = activity
    .map((b) => b.tokens)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  if (values.length === 0) return () => 0;
  const at = (q: number) => values[Math.min(values.length - 1, Math.floor(values.length * q))] as number;
  const [q1, q2, q3] = [at(0.25), at(0.5), at(0.75)];
  return (tokens) => {
    if (tokens <= 0) return 0;
    if (tokens <= q1) return 1;
    if (tokens <= q2) return 2;
    if (tokens <= q3) return 3;
    return 4;
  };
}

/**
 * 每列顶部要显示的月份：一列只会在月份变化时打一次标签。
 * 返回的 `weeks` 是"这个月跨了几周" —— 刻度行按它分配宽度，才能和网格缩放后对齐。
 */
function monthLabels(weeks: { day: string }[][], zh: boolean): { label: string; weeks: number }[] {
  const out: { label: string; weeks: number }[] = [];
  let last = -1;
  for (const week of weeks) {
    const first = week[0];
    if (!first) continue;
    const month = Number(first.day.split("-")[1]);
    if (month === last) {
      out[out.length - 1]!.weeks += 1;
      continue;
    }
    last = month;
    out.push({
      label: zh ? `${month}月` : dayToDate(first.day).toLocaleString("en-US", { month: "short" }),
      weeks: 1,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 每日趋势
// ---------------------------------------------------------------------------

/** 每日折线：按模型分色，鼠标悬停看当天各模型的明细。 */
function TrendChart({ stats, zh }: { stats: UsageStats; zh: boolean }) {
  const t = useT();
  const [active, setActive] = useState<number | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);

  const series = useMemo(() => {
    const list = stats.trend.series.map((s, i) => ({
      ...s,
      color: SERIES_COLORS[i % SERIES_COLORS.length] as string,
    }));
    if (stats.trend.other) {
      list.push({
        ...stats.trend.other,
        label: t("usage.trend.other"),
        color: SERIES_COLORS[SERIES_COLORS.length - 1] as string,
      });
    }
    return list;
  }, [stats.trend, t]);

  const days = stats.trend.days;
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const hasData = series.some((s) => s.tokens > 0);

  // 图表坐标系：viewBox 100×40 的归一化网格，横向由 CSS 拉伸（preserveAspectRatio=none）；
  // Y 轴刻度画在 SVG 外面，所以图内不留边距。
  const W = 100;
  const H = 40;

  const xAt = (i: number) => (days.length <= 1 ? W : (i / (days.length - 1)) * W);
  const yAt = (v: number) => H - (v / max) * (H - 4) - 2;

  const xTicks = useMemo(() => pickTicks(days.length), [days.length]);

  if (!hasData) {
    return <p className="px-4 py-10 text-center text-xs text-muted-foreground">{t("usage.trend.empty")}</p>;
  }

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const host = hostRef.current;
    if (!host || days.length === 0) return;
    const box = host.getBoundingClientRect();
    const ratio = (e.clientX - box.left) / box.width;
    const idx = Math.round(ratio * (days.length - 1));
    setActive(Math.max(0, Math.min(days.length - 1, idx)));
  };

  return (
    <div className="px-4 pt-3 pb-4">
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1">
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 text-[11px]">
            <span className="size-2 rounded-full" style={{ backgroundColor: s.color }} />
            <span className="text-muted-foreground">{s.label}</span>
          </span>
        ))}
      </div>

      {/* items-start + 固定高度：Y 轴刻度列必须与折线区一样高（默认 stretch 会把它拉到
          包含下面那行日期，于是 "0" 与横轴日期挤在同一行上）。 */}
      <div className="flex items-start gap-2">
        <div className="flex h-44 w-12 shrink-0 flex-col justify-between py-0.5 text-right text-[10px] tabular-nums text-muted-foreground">
          <span>{formatCompact(max, zh)}</span>
          <span>{formatCompact(max / 2, zh)}</span>
          <span>0</span>
        </div>
        <div
          ref={hostRef}
          className="relative min-w-0 flex-1"
          onMouseMove={onMove}
          onMouseLeave={() => setActive(null)}
        >
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="h-44 w-full"
          >
            {[0, 0.5, 1].map((r) => (
              <line
                key={r}
                x1={0}
                x2={W}
                y1={yAt(max * r)}
                y2={yAt(max * r)}
                className="stroke-border"
                strokeWidth={0.5}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {series.map((s) => (
              <polyline
                key={s.key}
                points={s.values.map((v, i) => `${xAt(i)},${yAt(v)}`).join(" ")}
                fill="none"
                stroke={s.color}
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
            {active != null && (
              <line
                x1={xAt(active)}
                x2={xAt(active)}
                y1={0}
                y2={H}
                className="stroke-foreground/30"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>

          {/* 悬停读数：用 HTML 而不是 SVG 文本，省得被 preserveAspectRatio 拉变形。 */}
          <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
            {xTicks.map((i) => (
              <span key={i}>{formatDay(days[i] ?? "", zh)}</span>
            ))}
          </div>

          {active != null && (
            <div
              className="pointer-events-none absolute top-1 z-10 rounded-md border bg-popover px-2 py-1 text-[11px] shadow-md"
              style={{
                left: `${(active / Math.max(1, days.length - 1)) * 100}%`,
                transform: active > days.length / 2 ? "translateX(-105%)" : "translateX(5%)",
              }}
            >
              <div className="mb-0.5 font-medium">{formatDayLong(days[active] ?? "", zh)}</div>
              {series
                .filter((s) => (s.values[active] ?? 0) > 0)
                .map((s) => (
                  <div key={s.key} className="flex items-center gap-1.5">
                    <span className="size-1.5 rounded-full" style={{ backgroundColor: s.color }} />
                    <span className="text-muted-foreground">{s.label}</span>
                    <span className="ml-auto tabular-nums">{formatExact(s.values[active] ?? 0)}</span>
                  </div>
                ))}
              {(series.reduce((sum, s) => sum + (s.values[active] ?? 0), 0) === 0) && (
                <div className="text-muted-foreground">{t("usage.trend.none")}</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** 抽 2–6 个横轴刻度（首尾必取），天数多的时候不至于糊成一片。 */
function pickTicks(count: number): number[] {
  if (count <= 1) return [0];
  const target = Math.min(6, count);
  const step = (count - 1) / (target - 1);
  const out: number[] = [];
  for (let i = 0; i < target; i++) out.push(Math.round(i * step));
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// 模型环形图
// ---------------------------------------------------------------------------

function ModelBreakdown({ rows, tokens, zh }: { rows: UsageBreakdownRow[]; tokens: number; zh: boolean }) {
  const t = useT();
  const shown = rows.slice(0, 6);
  const rest = rows.slice(6);
  const restTokens = rest.reduce((sum, r) => sum + r.tokens, 0);

  if (rows.length === 0) {
    return <p className="px-4 py-10 text-center text-xs text-muted-foreground">{t("usage.models.empty")}</p>;
  }

  // 环形图用 stroke-dasharray 画弧：每段弧长 = 占比 × 周长，偏移量累加。
  const R = 62;
  const CIRC = 2 * Math.PI * R;
  const total = Math.max(1, rows.reduce((sum, r) => sum + r.tokens, 0));
  let offset = 0;

  return (
    <div className="flex flex-col items-center gap-6 p-6 sm:flex-row sm:items-center">
      <div className="relative size-40 shrink-0">
        <svg viewBox="0 0 160 160" className="size-40 -rotate-90">
          <circle cx="80" cy="80" r={R} fill="none" strokeWidth="20" className="stroke-muted" />
          {shown.map((row, i) => {
            const share = row.tokens / total;
            const dash = share * CIRC;
            const el = (
              <circle
                key={row.key}
                cx="80"
                cy="80"
                r={R}
                fill="none"
                strokeWidth="20"
                stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                strokeDasharray={`${dash} ${CIRC - dash}`}
                strokeDashoffset={-offset}
              />
            );
            offset += dash;
            return el;
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-base font-semibold tabular-nums">{formatCompact(tokens, zh)}</span>
          <span className="text-[10px] text-muted-foreground">{t("usage.unit.tokens")}</span>
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2 self-stretch">
        {shown.map((row, i) => (
          <div key={row.key} className="flex items-center gap-2 border-b pb-2 last:border-b-0">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: SERIES_COLORS[i % SERIES_COLORS.length] }}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs" title={row.label}>
                {row.label}
              </div>
              <div className="truncate text-[11px] text-muted-foreground">
                {t("usage.unit.tokensCount", { n: formatExact(row.tokens) })}
                {row.detail ? ` · ${row.detail}` : ""}
              </div>
            </div>
            <span className="shrink-0 text-xs tabular-nums">{formatShare(row.share)}</span>
          </div>
        ))}
        {restTokens > 0 && (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="size-2 shrink-0 rounded-full bg-muted-foreground/40" />
            {t("usage.models.rest", { n: String(rest.length) })}
            <span className="ml-auto tabular-nums">
              {t("usage.unit.tokensCount", { n: formatExact(restTokens) })}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function formatShare(share: number): string {
  const pct = share * 100;
  if (pct > 0 && pct < 0.1) return "<0.1%";
  return `${pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// 厂商 / 渠道分栏
// ---------------------------------------------------------------------------

function BreakdownBars({
  rows,
  zh,
  detailKind,
}: {
  rows: UsageBreakdownRow[];
  zh: boolean;
  /** 副标题的含义：厂商行是"用了几个模型"，渠道行是入口说明（走 i18n）。 */
  detailKind: "models" | "channel";
}) {
  const t = useT();
  const visible = rows.filter((r) => r.tokens > 0 || r.requests > 0);
  if (visible.length === 0) {
    return <p className="px-4 py-8 text-center text-xs text-muted-foreground">{t("usage.breakdown.empty")}</p>;
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      {visible.map((row, i) => (
        <div key={row.key} className="flex flex-col gap-1">
          {/* 右上角的百分比紧挨着它的分母：渠道按调用次数、厂商按 token，
              两者摆在不同位置才不会被读成同一个口径。 */}
          <div className="flex items-baseline gap-2">
            <span className="truncate text-xs" title={row.label}>
              {detailKind === "channel" ? t(`usage.channels.${row.key}`) : row.label}
            </span>
            <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {detailKind === "channel"
                ? t("usage.unit.calls", { n: formatExact(row.requests) })
                : t("usage.unit.tokensCount", { n: formatCompact(row.tokens, zh) })}
            </span>
            <span className="w-12 shrink-0 text-right text-[11px] tabular-nums">
              {formatShare(row.share)}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max(row.share * 100, row.share > 0 ? 1.5 : 0)}%`,
                backgroundColor: SERIES_COLORS[i % SERIES_COLORS.length],
              }}
            />
          </div>
          <span className="truncate text-[10px] text-muted-foreground">
            {detailKind === "channel"
              ? `${t(`usage.channels.${row.key}.desc`)} · ${t("usage.unit.tokensCount", { n: formatCompact(row.tokens, zh) })}`
              : `${row.detail ? t("usage.providers.models", { n: row.detail }) : ""} · ${t("usage.unit.calls", { n: formatExact(row.requests) })}`}
          </span>
        </div>
      ))}
    </div>
  );
}
