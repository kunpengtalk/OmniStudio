import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  SearchIcon,
  ChevronRightIcon,
  Loader2Icon,
  XCircleIcon,
  DownloadIcon,
  StoreIcon,
  Link2Icon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { ScrollArea } from "@ui/scroll-area";
import { Spinner } from "@ui/spinner";
import { useModelDetailStore } from "@stores/model-detail";
import { useRouter } from "@stores/router";
import { useT } from "@stores/ui-lang";
import {
  MODEL_CATEGORIES,
  classifyModel,
  matchCategory,
  repoFormatHint,
  type ModelCategory,
  type ModelScopeModel,
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

const CAT_BADGE_CLASSES: Record<string, string> = {
  chat: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400",
  tts: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400",
  asr: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400",
  image: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400",
  other: "bg-muted text-muted-foreground",
};

function SearchResultRow({ model }: { model: ModelScopeModel }) {
  const t = useT();
  const setSource = useModelDetailStore((s) => s.setSource);
  const setRoute = useRouter((s) => s.setRoute);

  const cat = classifyModel(model);
  const formatHint = repoFormatHint(model.id);

  const openDetail = () => {
    setSource({ kind: "search", model });
    setRoute({ path: "model-detail" });
  };

  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors hover:border-muted-foreground/40"
      onClick={openDetail}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{model.name || model.id}</span>
          <span
            className={cn(
              "inline-flex h-5 items-center rounded-full px-1.5 text-[10px] font-medium",
              CAT_BADGE_CLASSES[cat],
            )}
          >
            {t(`models.cat.${cat}`)}
          </span>
          {formatHint === "gguf" && (
            <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-blue-100 px-1.5 text-[10px] font-medium text-blue-700 dark:bg-blue-900/40 dark:text-blue-400">
              {t("models.format.gguf")}
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/70">
          {model.id}
        </p>
        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>{model.downloads} downloads</span>
          {model.params > 0 && <span>· {formatParams(model.params)} params</span>}
          {model.license && <span>· {model.license}</span>}
          <span>· {formatBytes(model.fileSize)} total</span>
        </div>
      </div>
      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        {t("models.viewDetail")}
        <ChevronRightIcon className="size-4" />
      </span>
    </button>
  );
}

/** 在线模型市场：在 ModelScope / HuggingFace 搜索模型并下载（详情页提供文件下载）。 */
export function MarketScreen() {
  const t = useT();
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [activeCategory, setActiveCategory] = useState<ModelCategory | "all">("all");

  const searchQuery = useQuery({
    queryKey: ["modelscope-search", submitted],
    queryFn: () => rpcClient.searchModelScope({ query: submitted, page: 1 }),
    enabled: submitted.trim().length > 0,
  });

  const handleSearch = () => {
    setSubmitted(query.trim());
  };

  const filteredResults = (searchQuery.data?.models ?? []).filter((m) =>
    matchCategory(m, activeCategory),
  );

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 pb-30 pt-2">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Link2Icon className="size-5" />
            {t("market.title")}
          </h2>
          <p className="text-xs text-muted-foreground">{t("market.subtitle")}</p>
        </div>

        {/* Search */}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 opacity-50" />
            <Input
              placeholder={t("models.searchPlaceholder")}
              className="pl-8"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            />
          </div>
          <Button onClick={handleSearch} disabled={!query.trim()}>
            {searchQuery.isFetching ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <SearchIcon data-icon="inline-start" />
            )}
            {t("models.search")}
          </Button>
        </div>

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
            <h3 className="text-xs font-medium text-muted-foreground">
              {t("models.results")}: "{submitted}"
              {activeCategory !== "all" && (
                <span className="ml-2 inline-flex h-5 items-center rounded-full bg-primary/10 px-1.5 text-[10px] text-primary">
                  {t(`models.cat.${activeCategory}`)}
                </span>
              )}
            </h3>
            {searchQuery.isLoading ? (
              <div className="flex justify-center py-10">
                <Spinner className="size-5" />
              </div>
            ) : searchQuery.isError ? (
              <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
                <XCircleIcon className="size-4" />
                {t("models.searchFailed")}: {String(searchQuery.error)}
              </div>
            ) : filteredResults.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">
                {t("models.noResults")}
              </p>
            ) : (
              filteredResults.map((m) => <SearchResultRow key={m.id} model={m} />)
            )}
          </div>
        )}

        {!submitted && (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center">
            <StoreIcon className="size-8 text-muted-foreground/40" />
            <p className="max-w-sm text-xs leading-5 text-muted-foreground">
              {t("models.searchPlaceholder")}
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
