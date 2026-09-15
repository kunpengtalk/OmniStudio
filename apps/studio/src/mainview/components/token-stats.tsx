import { useState } from "react";
import {
  ChevronDownIcon,
  SparklesIcon,
} from "lucide-react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@ui/collapsible";
import { Popover, PopoverContent, PopoverTrigger } from "@ui/popover";
import { useChatStore, liveOutputTokens, liveTokensPerSec } from "@stores/chat";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import { tokensFromParts } from "../../shared/token-estimate";
import type { ChatMessage } from "../../bun/chat";
import type { MessageStats, TokenStatsSource } from "../../bun/chat-stats";

/**
 * 消息底部的用量胶囊 + 详情卡片。
 *
 * 为什么值得有个卡片：底部那一行只能放「总量 + 速度」，而排查"为什么这么慢"
 * 需要拆开看 —— 首 token 耗时（预填充 / 排队）、生成速度（解码）、端到端吞吐
 * （含工具执行与网络）是三个不同的瓶颈。卡片把这些分开列，并标明哪些数字是
 * 服务端实测、哪些是本地估算。
 *
 * 生成中也能点开：那时显示的是实时估算值（输入 token 还没有实测值，留空），
 * 生成结束由 chatStats 推来的实测值接管。
 */
export type TokenStatsView = {
  inputTokens?: number;
  /** 输出（生成）tokens。 */
  outputTokens: number;
  /** 胶囊上显示的总量：输入 + 输出。 */
  totalTokens: number;
  /** 生成窗口吞吐（首 token 之后的解码速度）。 */
  tokensPerSec: number;
  endToEndTokensPerSec?: number;
  ttftMs?: number;
  elapsedMs: number;
  generationMs?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  source?: TokenStatsSource;
  model?: string;
  provider?: string;
  steps?: number;
  toolCalls?: number;
  /** 正在生成：数字是实时估算的。 */
  live: boolean;
};

/** 千分位分组：卡片要能一眼读出量级，`1.0k` 那种缩写在这个场景反而看不准。 */
export function formatTokenCount(n: number): string {
  return Math.max(0, Math.round(n)).toLocaleString("en-US");
}

/**
 * 速度：固定一位小数。后端算出来的也是这个精度，这里不再二次取整 ——
 * 卡片上「177.7 Token/秒」和底下一行必须是同一个数。
 */
export function formatRate(n: number): string {
  return Math.max(0, n).toFixed(1);
}

/** 时长：<1s 用毫秒，<1min 用秒，再长用分 —— 各取最直观的一档。 */
export function formatDuration(t: (key: string, params?: Record<string, string>) => string, ms: number): string {
  const value = Math.max(0, ms);
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} ${t("tokenStats.unit.second")}`;
  return `${(value / 60_000).toFixed(1)} ${t("tokenStats.unit.minute")}`;
}

function formatStamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.getFullYear() === new Date().getFullYear()
    ? stamp
    : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function sourceLabelKey(source: TokenStatsSource | undefined): string {
  if (source === "usage") return "tokenStats.source.usage";
  if (source === "estimate") return "tokenStats.source.estimate";
  return "tokenStats.source.mixed";
}

/**
 * 消息 → 展示用统计：优先收尾实测，其次生成中的实时估算，最后是持久化的历史值
 * （刷新会话后速度仍在），都没有就退回老消息里的 tokens 字段。
 */
export function useTokenStatsView(
  message: Pick<ChatMessage, "id" | "tokens" | "stats">,
  streaming: boolean,
): TokenStatsView | null {
  const live = useChatStore((s) => (streaming ? s.liveStats[message.id] : undefined));
  const finished = useChatStore((s) => s.messageStats[message.id]);

  if (live) {
    const outputTokens = liveOutputTokens(live);
    const elapsedMs = Math.max(1, Date.now() - live.startedAt);
    return {
      outputTokens,
      totalTokens: outputTokens,
      tokensPerSec: liveTokensPerSec(live),
      ttftMs: live.firstTokenAt == null ? undefined : live.firstTokenAt - live.startedAt,
      elapsedMs,
      reasoningTokens: tokensFromParts({
        cjk: live.reasoningCjk,
        other: live.reasoningOther,
      }),
      live: true,
    };
  }

  const stats: MessageStats | null = finished ?? message.stats ?? null;
  if (stats) {
    const inputTokens = stats.inputTokens;
    return {
      ...stats,
      inputTokens,
      outputTokens: stats.outputTokens ?? stats.tokens,
      totalTokens: (inputTokens ?? 0) + (stats.outputTokens ?? stats.tokens),
      live: false,
    };
  }

  // 老消息：只留了输出 tokens，速度和耗时当时没存 —— 卡片里就只显示这一格。
  if (message.tokens != null) {
    return {
      outputTokens: message.tokens,
      totalTokens: message.tokens,
      tokensPerSec: 0,
      elapsedMs: 0,
      live: false,
    };
  }
  return null;
}

/**
 * 一格统计值：标签在上、数值在下。
 *
 * 数值与单位允许换行（单位掉到第二行）—— 「1,234.5 Token/秒」这种长值在窄格里
 * 宁可折行，也不能被裁掉半截（中文界面下单位比 tok/s 长得多）。
 */
function Tile({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-muted/50 px-2 py-1.5">
      <div className="truncate text-[10px] text-muted-foreground">{label}</div>
      <div className="flex flex-wrap items-baseline gap-x-1">
        <span className="text-[13px] font-semibold tabular-nums">{value}</span>
        {unit && <span className="text-[10px] text-muted-foreground">{unit}</span>}
      </div>
    </div>
  );
}

/** 标签 / 数值成对的一行（卡片下半部分的两列网格）。 */
function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[10px] text-muted-foreground">{label}</div>
      <div className="truncate text-[11px] tabular-nums">{value}</div>
    </div>
  );
}

/** 详情卡片本体：导出出来便于单测直接静态渲染，不必真的点开浮层。 */
export function TokenStatsCard({
  view,
  createdAt,
  context,
}: {
  view: TokenStatsView;
  createdAt?: number;
  /** 会话最近一次的上下文占用（有就显示在「更多信息」里）。 */
  context?: { percent: number; usedTokens: number; windowTokens: number } | null;
}) {
  const t = useT();
  const [detailOpen, setDetailOpen] = useState(false);
  const tpsUnit = t("tokenStats.unit.tps");
  const outputUnit = t("tokenStats.unit.tokens");

  const uncached =
    view.inputTokens != null && view.cachedTokens != null
      ? Math.max(0, view.inputTokens - view.cachedTokens)
      : undefined;

  const cells: { label: string; value: string }[] = [];
  if (view.ttftMs != null) {
    cells.push({ label: t("tokenStats.ttft"), value: formatDuration(t, view.ttftMs) });
  }
  if (view.endToEndTokensPerSec != null) {
    cells.push({
      label: t("tokenStats.e2eTps"),
      value: `${formatRate(view.endToEndTokensPerSec)} ${tpsUnit}`,
    });
  }
  if (view.elapsedMs > 0) {
    cells.push({ label: t("tokenStats.elapsed"), value: formatDuration(t, view.elapsedMs) });
  }
  if (view.generationMs != null && view.generationMs > 0) {
    cells.push({ label: t("tokenStats.decode"), value: formatDuration(t, view.generationMs) });
  }
  if (view.reasoningTokens != null && view.reasoningTokens > 0) {
    cells.push({
      label: t("tokenStats.reasoning"),
      value: formatTokenCount(view.reasoningTokens),
    });
  }
  if (view.cachedTokens != null && view.cachedTokens > 0) {
    cells.push({ label: t("tokenStats.cached"), value: formatTokenCount(view.cachedTokens) });
  }
  if (uncached != null) {
    cells.push({ label: t("tokenStats.uncached"), value: formatTokenCount(uncached) });
  }
  if (view.steps != null && view.steps > 0) {
    cells.push({ label: t("tokenStats.steps"), value: String(view.steps) });
  }
  if (view.toolCalls != null && view.toolCalls > 0) {
    cells.push({ label: t("tokenStats.toolCalls"), value: String(view.toolCalls) });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <SparklesIcon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold">
            {view.model ?? t("tokenStats.model.unknown")}
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            {view.provider && <span className="truncate">{view.provider}</span>}
            {view.live && (
              <span className="flex items-center gap-1 font-medium text-primary">
                <span className="size-1.5 animate-pulse rounded-full bg-primary" />
                {t("tokenStats.generating")}
              </span>
            )}
          </div>
        </div>
        {createdAt != null && (
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            {formatStamp(createdAt)}
          </span>
        )}
      </div>

      <div className="grid grid-cols-3 gap-1.5">
        <Tile
          label={t("tokenStats.input")}
          value={view.inputTokens == null ? "—" : formatTokenCount(view.inputTokens)}
          unit={view.inputTokens == null ? undefined : outputUnit}
        />
        <Tile
          label={t("tokenStats.output")}
          value={formatTokenCount(view.outputTokens)}
          unit={outputUnit}
        />
        <Tile label={t("tokenStats.speed")} value={formatRate(view.tokensPerSec)} unit={tpsUnit} />
      </div>

      {cells.length > 0 && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-2">
          {cells.map((cell) => (
            <StatCell key={cell.label} label={cell.label} value={cell.value} />
          ))}
        </div>
      )}

      <Collapsible open={detailOpen} onOpenChange={setDetailOpen}>
        <CollapsibleTrigger className="flex w-full items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground">
          {t("tokenStats.more")}
          <ChevronDownIcon className={cn("size-3 transition-transform", detailOpen && "rotate-180")} />
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-1 pt-2">
          {view.live && (
            <p className="text-[10px] leading-4 text-muted-foreground">
              {t("tokenStats.liveNote")}
            </p>
          )}
          <div className="flex items-center justify-between gap-2 text-[10px]">
            <span className="text-muted-foreground">{t("tokenStats.source")}</span>
            <span>{t(sourceLabelKey(view.source))}</span>
          </div>
          {view.source !== "usage" && !view.live && (
            <p className="text-[10px] leading-4 text-muted-foreground">
              {t("tokenStats.source.hint")}
            </p>
          )}
          {view.model && (
            <div className="flex items-center justify-between gap-2 text-[10px]">
              <span className="text-muted-foreground">{t("tokenStats.model")}</span>
              <span className="truncate font-mono">{view.model}</span>
            </div>
          )}
          {context && (
            <div className="flex items-center justify-between gap-2 text-[10px]">
              <span className="text-muted-foreground">{t("tokenStats.context")}</span>
              <span className="tabular-nums">
                {t("tokenStats.context.value", {
                  percent: String(context.percent),
                  used: formatTokenCount(context.usedTokens),
                  window: formatTokenCount(context.windowTokens),
                })}
              </span>
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/**
 * 消息底部的用量胶囊：`1,012 Tokens · 177.7 Token/秒`，点开是详情卡片。
 * 没有统计（老消息 / 还没出字）时不渲染任何东西。
 */
export function MessageTokenStats({
  message,
  conversationId,
  streaming,
  className,
}: {
  message: Pick<ChatMessage, "id" | "tokens" | "stats" | "createdAt">;
  conversationId: number;
  streaming: boolean;
  className?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const context = useChatStore((s) => s.contextUsage[conversationId]);
  const view = useTokenStatsView(message, streaming);

  if (!view) return null;

  const showRate = !view.live || view.tokensPerSec > 0;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={t("tokenStats.openHint")}
          aria-label={t("tokenStats.openHint")}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground/70 transition-colors hover:bg-muted/60 hover:text-foreground",
            open && "bg-muted/60 text-foreground",
            className,
          )}
        >
          {view.live && <span className="size-1.5 animate-pulse rounded-full bg-primary" />}
          <span>{t("tokenStats.tokens", { count: formatTokenCount(view.totalTokens) })}</span>
          {showRate && (
            <>
              <span className="text-muted-foreground/40">·</span>
              <span>{t("tokenStats.tps", { value: formatRate(view.tokensPerSec) })}</span>
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[22rem] max-w-[calc(100vw-2rem)]">
        <TokenStatsCard
          view={view}
          createdAt={message.createdAt}
          context={context ?? null}
        />
      </PopoverContent>
    </Popover>
  );
}
