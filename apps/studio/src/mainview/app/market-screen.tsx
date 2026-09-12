import { useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  SearchIcon,
  ChevronRightIcon,
  Loader2Icon,
  XCircleIcon,
  DownloadIcon,
  StoreIcon,
  Link2Icon,
  InfoIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { SourceBadge } from "@components/source-badge";
import { ModelCategoryBadge, ModelFormatBadge } from "@components/model-category-badge";
import { useEngine } from "@lib/use-engine";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { ScrollArea } from "@ui/scroll-area";
import { useModelDetailStore, type ModelDetailSource } from "@stores/model-detail";
import { useMarketStore, type MarketFormatFilter } from "@stores/market";
import { useRouter } from "@stores/router";
import { useT } from "@stores/ui-lang";
import {
  MODEL_CATEGORIES,
  MODEL_FORMATS,
  MODEL_SOURCES,
  MODEL_SOURCE_META,
  classifyModel,
  engineSearchFormat,
  matchCategory,
  type MarketModel,
  type ModelCategory,
  type SearchFormat,
} from "@/shared/modelscope";
import { cn } from "@/mainview/lib/utils";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

function formatParams(params: number): string {
  if (!params) return "";
  if (params >= 1e9) return `${(params / 1e9).toFixed(1)}B`;
  if (params >= 1e6) return `${(params / 1e6).toFixed(0)}M`;
  return String(params);
}

function formatCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function SearchResultRow({
  model,
  onOpenDetail,
}: {
  model: MarketModel;
  onOpenDetail?: (source: ModelDetailSource) => void;
}) {
  const t = useT();
  const setSource = useModelDetailStore((s) => s.setSource);
  const setRoute = useRouter((s) => s.setRoute);

  const cat = classifyModel(model);

  const openDetail = () => {
    const source = { kind: "search", model } as const;
    setSource(source);
    if (onOpenDetail) onOpenDetail(source);
    else setRoute({ path: "model-detail" });
  };

  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors hover:border-muted-foreground/40"
      onClick={openDetail}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{model.name || model.id}</span>
          <SourceBadge source={model.source} />
          <ModelCategoryBadge category={cat} label={t(`models.cat.${cat}`)} />
          {model.formats.map((f) => (
            <ModelFormatBadge key={f} kind={f} label={t(`models.format.${f}`)} />
          ))}
        </div>
        <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/70">
          {model.id}
        </p>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <span>{formatCount(model.downloads)} downloads</span>
          {model.params > 0 && <span>· {formatParams(model.params)} params</span>}
          {model.license && <span>· {model.license}</span>}
          {model.fileSize > 0 ? (
            <span>· {formatBytes(model.fileSize)} total</span>
          ) : model.fileCount > 0 ? (
            <span>· {t("market.fileCount", { count: String(model.fileCount) })}</span>
          ) : null}
        </div>
      </div>
      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        {t("models.viewDetail")}
        <ChevronRightIcon className="size-4" />
      </span>
    </button>
  );
}

/** 平台切换（检索 + 下载链路一起切），显示的是一会儿真正请求的域名。 */
function SourceSwitch() {
  const t = useT();
  const source = useMarketStore((s) => s.source);
  const setSource = useMarketStore((s) => s.setSource);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">{t("market.sourceLabel")}</span>
        <div className="inline-flex rounded-lg border p-0.5">
          {MODEL_SOURCES.map((s) => {
            const meta = MODEL_SOURCE_META[s];
            const active = source === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => setSource(s)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors",
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {meta.label}
                <span
                  className={cn(
                    "font-mono text-[10px]",
                    active ? "text-primary-foreground/70" : "text-muted-foreground/60",
                  )}
                >
                  {meta.host}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground/70">{t("market.sourceHint")}</p>
    </div>
  );
}

/** 格式筛选：默认跟随当前推理引擎（引擎 → 格式的映射见 shared/engines.ts）。 */
function FormatSwitch({ engineFormat }: { engineFormat: SearchFormat }) {
  const t = useT();
  const engine = useEngine().engine;
  const format = useMarketStore((s) => s.format);
  const setFormat = useMarketStore((s) => s.setFormat);

  const options: { value: MarketFormatFilter; label: string }[] = [
    { value: "auto", label: `${t("market.format.engine")} · ${t(`models.format.${engineFormat}`)}` },
    { value: "all", label: t("models.formatFilter.all") },
  ];
  for (const f of MODEL_FORMATS) {
    options.push({ value: f.value, label: t(f.labelKey) });
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">{t("market.formatLabel")}</span>
        {options.map((o) => {
          const active = format === o.value;
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => setFormat(o.value)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs transition-colors",
                active
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      <p className="flex items-start gap-1 text-[11px] text-muted-foreground/70">
        <InfoIcon className="mt-0.5 size-3 shrink-0" />
        {format === "auto"
          ? t("market.formatAutoHint", { engine })
          : format === "all"
            ? t("market.formatAllHint")
            : t(`market.formatHint.${format}`)}
      </p>
    </div>
  );
}

/** 在线模型市场：选择平台（ModelScope / Hugging Face）检索模型并下载。 */
export function MarketScreen({
  onOpenDetail,
}: {
  onOpenDetail?: (source: ModelDetailSource) => void;
} = {}) {
  const t = useT();
  const engine = useEngine().engine;
  const source = useMarketStore((s) => s.source);
  const format = useMarketStore((s) => s.format);
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [activeCategory, setActiveCategory] = useState<ModelCategory | "all">("all");

  // "跟随引擎"解析成具体格式；"全部"不带过滤条件。
  const engineFormat = engineSearchFormat(engine);
  const requestFormat: SearchFormat | undefined =
    format === "all" ? undefined : format === "auto" ? engineFormat : format;

  const search = useInfiniteQuery({
    // 平台 / 格式进 queryKey：切换后立刻用新条件重查，缓存也按平台分开。
    queryKey: ["market-search", submitted, source, requestFormat ?? "all"],
    enabled: submitted.trim().length > 0,
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      rpcClient.searchMarketModels({
        query: submitted,
        page: pageParam,
        source,
        format: requestFormat,
      }),
    getNextPageParam: (lastPage, pages) => (lastPage.hasMore ? pages.length + 1 : undefined),
  });

  const handleSearch = () => {
    setSubmitted(query.trim());
    setActiveCategory("all");
  };

  const models = useMemo(
    () => (search.data?.pages ?? []).flatMap((p) => p.models),
    [search.data],
  );
  const filteredResults = models.filter((m) => matchCategory(m, activeCategory));
  const total = search.data?.pages?.[0]?.total ?? 0;
  const totalExact = search.data?.pages?.[0]?.totalExact ?? false;
  const sourceMeta = MODEL_SOURCE_META[source];

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 pb-30 pt-2">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Link2Icon className="size-5" />
            {t("market.title")}
          </h2>
          <p className="text-xs text-muted-foreground">{t("market.subtitle")}</p>
        </div>

        <SourceSwitch />

        {/* Search */}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 opacity-50" />
            <Input
              placeholder={t("market.searchPlaceholder", { source: sourceMeta.label })}
              className="pl-8"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            />
          </div>
          <Button onClick={handleSearch} disabled={!query.trim()}>
            {search.isFetching && !search.isFetchingNextPage ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <SearchIcon data-icon="inline-start" />
            )}
            {t("models.search")}
          </Button>
        </div>

        <FormatSwitch engineFormat={engineFormat} />

        {/* Category filter */}
        <div className="flex flex-wrap gap-1.5">
          {MODEL_CATEGORIES.map((cat) => {
            const isActive = activeCategory === cat.value;
            return (
              <button
                key={cat.value}
                type="button"
                onClick={() => setActiveCategory(cat.value)}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-xs transition-colors",
                  isActive
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
                )}
              >
                {t(cat.labelKey)}
              </button>
            );
          })}
        </div>

        {/* Search results */}
        {submitted && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                {t("market.resultsFrom", { source: sourceMeta.label, query: submitted })}
              </h3>
              <SourceBadge source={source} />
              {activeCategory !== "all" && (
                <span className="inline-flex h-5 items-center rounded-full bg-primary/10 px-1.5 text-[10px] text-primary">
                  {t(`models.cat.${activeCategory}`)}
                </span>
              )}
              {total > 0 && (
                <span className="text-[11px] text-muted-foreground/60">
                  {/* Hugging Face 不返回命中总数，只报已加载条数，别编一个总数出来 */}
                  {totalExact
                    ? t("market.totalCount", { count: String(total) })
                    : t("market.loadedCount", { count: String(models.length) })}
                </span>
              )}
            </div>
            {search.isLoading ? (
              <div className="flex flex-col gap-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-[74px] animate-pulse rounded-lg border bg-muted/30" />
                ))}
              </div>
            ) : search.isError ? (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
                <XCircleIcon className="mt-0.5 size-4 shrink-0" />
                <div className="min-w-0">
                  <p className="font-medium">
                    {t("market.searchFailedOn", { source: sourceMeta.label })}
                  </p>
                  <p className="mt-0.5 break-words opacity-80">{String(search.error)}</p>
                </div>
              </div>
            ) : filteredResults.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">
                {/* 分类筛选是本地过滤，和"平台没结果"要分开说，否则用户以为搜不到 */}
                {models.length > 0 && activeCategory !== "all"
                  ? t("market.noCategoryResults")
                  : t("models.noResults")}
              </p>
            ) : (
              <>
                {filteredResults.map((m) => (
                  <SearchResultRow key={`${m.source}:${m.id}`} model={m} onOpenDetail={onOpenDetail} />
                ))}
                {search.hasNextPage && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mx-auto mt-1"
                    disabled={search.isFetchingNextPage}
                    onClick={() => void search.fetchNextPage()}
                  >
                    {search.isFetchingNextPage && (
                      <Loader2Icon data-icon="inline-start" className="animate-spin" />
                    )}
                    {t("market.loadMore")}
                  </Button>
                )}
              </>
            )}
          </div>
        )}

        {!submitted && (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center">
            <StoreIcon className="size-8 text-muted-foreground/40" />
            <p className="max-w-sm text-xs leading-5 text-muted-foreground">
              {t("market.emptyHint", { source: sourceMeta.label, host: sourceMeta.host })}
            </p>
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
              <DownloadIcon className="size-3.5" />
              {t("models.downloadHint")}
            </p>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
