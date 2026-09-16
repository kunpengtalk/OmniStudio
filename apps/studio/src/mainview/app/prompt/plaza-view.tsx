import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Loader2Icon, ClipboardListIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Spinner } from "@ui/spinner";
import { ScrollArea } from "@ui/scroll-area";
import { useT, useTOptional } from "@stores/ui-lang";
import { usePromptStore } from "@stores/prompt";
import { chipClass } from "@components/filter-chip";
import { SOURCE_FILTERS, DEFAULT_INTROS, KINDS, PAGE_SIZE } from "./constants";
import { PromptCard, JoinMineButton, InfiniteSentinel, SearchBox } from "./parts";
import type { PromptRow } from "../../../bun/prompt-library";

export function PlazaView({
  addedKeys,
  joinPending,
  onJoin,
  onOpenViewer,
}: {
  addedKeys: Set<string>;
  joinPending: boolean;
  onJoin: (item: PromptRow) => void;
  onOpenViewer: (items: PromptRow[], index: number) => void;
}) {
  const t = useT();
  const tOptional = useTOptional();
  const { kind, category, source, search, setSource, setSearch } = usePromptStore();

  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data: stats } = useQuery({
    queryKey: ["prompt-stats"],
    queryFn: () => rpcClient.getPromptLibraryStats(),
  });

  const { data, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage } = useInfiniteQuery({
    queryKey: ["prompts", kind, category, source, debouncedSearch],
    queryFn: async ({ pageParam = 0 }) => {
      return rpcClient.listPrompts({
        kind,
        category: category === "all" ? undefined : category,
        source: source === "all" ? undefined : source,
        search: debouncedSearch || undefined,
        limit: PAGE_SIZE,
        offset: pageParam * PAGE_SIZE,
      });
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.items.length, 0);
      return loaded < lastPage.total ? allPages.length : undefined;
    },
  });

  const items = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);
  const total = data?.pages[0]?.total ?? 0;

  const { data: catsData } = useQuery({
    queryKey: ["prompt-categories", kind],
    queryFn: () => rpcClient.listPromptCategories({ kind }),
  });
  const activeCatIntro =
    category === "all" ? undefined : catsData?.categories.find((c) => c.name === category)?.intro;

  const sourceFilters = SOURCE_FILTERS[kind] ?? [];

  return (
    <>
      {/* 工具栏：标题 + 来源/搜索 */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5">
        <div className="flex items-center gap-1.5">
          <ClipboardListIcon className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold">{t("prompt.plaza")}</span>
          <span className="text-xs text-muted-foreground">
            {t(`prompt.kind.${kind}`)}
            {total > 0 ? ` · ${items.length} / ${total}` : stats ? ` · ${stats.counts[kind]}` : ""}
          </span>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {sourceFilters.length > 0 && (
            <div className="flex items-center gap-1">
              {sourceFilters.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={chipClass(source === s.id)}
                  onClick={() => setSource(s.id)}
                >
                  {s.labelKey ? tOptional(s.labelKey, s.label) : s.label}
                </button>
              ))}
            </div>
          )}
          <SearchBox value={search} onChange={setSearch} placeholder={t("prompt.search")} />
        </div>
      </div>

      {/* 分类简介 */}
      <div className="shrink-0 border-b bg-muted/30 px-4 py-2">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {activeCatIntro || tOptional(DEFAULT_INTROS[kind].key, DEFAULT_INTROS[kind].fallback)}
        </p>
      </div>

      {/* 卡片瀑布流 */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-4">
          {isLoading ? (
            <div className="flex justify-center py-16">
              <Spinner className="size-5" />
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
              <div className="flex size-16 items-center justify-center rounded-2xl bg-primary/10">
                {KINDS.find((k) => k.kind === kind)?.icon}
              </div>
              <p className="text-sm font-medium text-foreground">{t("prompt.empty.title")}</p>
              <p className="max-w-xs text-xs text-muted-foreground">
                {debouncedSearch ? t("prompt.empty.search") : t("prompt.empty.desc")}
              </p>
            </div>
          ) : (
            <>
              <div className="columns-1 gap-4 sm:columns-2 xl:columns-3 2xl:columns-4">
                {items.map((item, i) => (
                  <PromptCard
                    key={`plaza-${item.id}`}
                    item={item}
                    onOpen={() => onOpenViewer(items, i)}
                    extraActions={
                      <JoinMineButton
                        added={addedKeys.has(item.key)}
                        busy={joinPending}
                        onClick={() => onJoin(item)}
                      />
                    }
                  />
                ))}
              </div>
              <InfiniteSentinel
                hasNextPage={hasNextPage}
                isFetchingNextPage={isFetchingNextPage}
                onLoadMore={fetchNextPage}
              />
              {isFetchingNextPage && (
                <div className="flex justify-center py-3">
                  <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
                </div>
              )}
            </>
          )}
        </div>
      </ScrollArea>
    </>
  );
}

// ---------------------------------------------------------------------------
// 我的提示词（用户自建 + 从广场加入）
// ---------------------------------------------------------------------------
