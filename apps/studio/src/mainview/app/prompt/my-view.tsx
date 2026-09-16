import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon, ClipboardListIcon, PlusIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Spinner } from "@ui/spinner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@ui/dialog";
import { ScrollArea } from "@ui/scroll-area";
import { useT } from "@stores/ui-lang";
import { usePromptStore } from "@stores/prompt";
import { KINDS, PAGE_SIZE } from "./constants";
import { PromptCard, InfiniteSentinel, SearchBox } from "./parts";
import type { PromptRow } from "../../../bun/prompt-library";
import type { UserPromptView } from "../../../bun/user-prompt";

export function MyView({
  onOpenViewer,
}: {
  onOpenViewer: (items: PromptRow[], index: number) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const { kind, category, search, setSearch, openCreate, setTab } = usePromptStore();

  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const [deleteTarget, setDeleteTarget] = useState<UserPromptView | null>(null);
  const [deleteError, setDeleteError] = useState<string>();

  const { data: stats } = useQuery({
    queryKey: ["my-prompt-stats"],
    queryFn: () => rpcClient.getMyPromptStats(),
  });

  const { data, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage } = useInfiniteQuery({
    queryKey: ["my-prompts", kind, category, debouncedSearch],
    queryFn: async ({ pageParam = 0 }) => {
      return rpcClient.listMyPrompts({
        kind,
        category: category === "all" ? undefined : category,
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

  const deleteMutation = useMutation({
    mutationFn: (id: number) => rpcClient.deleteMyPrompt({ id }),
    onSuccess: (r) => {
      // 记录不存在时后端现在会如实回 ok:false（此前恒 true，删了个寂寞也当成功）。
      if (r.ok === false) setDeleteError(r.error ?? t("prompt.deleteFailed"));
      else setDeleteError(undefined);
      setDeleteTarget(null);
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["my-prompts"] }),
        queryClient.invalidateQueries({ queryKey: ["my-prompt-categories"] }),
        queryClient.invalidateQueries({ queryKey: ["my-prompt-stats"] }),
        queryClient.invalidateQueries({ queryKey: ["my-prompt-keys"] }),
      ]);
    },
  });

  return (
    <>
      {/* 工具栏：标题 + 新建 + 搜索 */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5">
        <div className="flex items-center gap-1.5">
          <ClipboardListIcon className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold">{t("prompt.mine")}</span>
          <span className="text-xs text-muted-foreground">
            {t(`prompt.kind.${kind}`)}
            {total > 0 ? ` · ${items.length} / ${total}` : stats ? ` · ${stats.counts[kind]}` : ""}
          </span>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button size="sm" onClick={() => openCreate(kind)}>
            <PlusIcon data-icon="inline-start" className="size-3.5" />
            {t("prompt.new")}
          </Button>
          <SearchBox value={search} onChange={setSearch} placeholder={t("prompt.search")} />
        </div>
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
              <p className="text-sm font-medium text-foreground">{t("prompt.mine.empty.title")}</p>
              <p className="max-w-xs text-xs text-muted-foreground">
                {debouncedSearch ? t("prompt.empty.search") : t("prompt.mine.empty.desc")}
              </p>
              {!debouncedSearch && (
                <div className="mt-1 flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => openCreate(kind)}>
                    <PlusIcon data-icon="inline-start" className="size-3.5" />
                    {t("prompt.mine.empty.create")}
                  </Button>
                  <Button size="sm" onClick={() => setTab("plaza")}>
                    {t("prompt.mine.empty.goPlaza")}
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="columns-1 gap-4 sm:columns-2 xl:columns-3 2xl:columns-4">
                {items.map((item, i) => (
                  <PromptCard
                    key={`mine-${item.id}`}
                    item={item}
                    onOpen={() => onOpenViewer(items, i)}
                    extraActions={
                      <>
                        <Button
                          size="icon-sm"
                          variant="outline"
                          tooltip={t("prompt.edit")}
                          onClick={() => usePromptStore.getState().openEdit(item)}
                        >
                          <PencilIcon className="size-3.5" />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="outline"
                          tooltip={t("prompt.delete")}
                          onClick={() => setDeleteTarget(item)}
                        >
                          <Trash2Icon className="size-3.5 text-destructive" />
                        </Button>
                      </>
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

      {/* 删除失败：此前后端恒回 ok:true，界面没有任何反馈通道 */}
      {deleteError && (
        <p className="shrink-0 px-4 pb-2 text-[11px] text-destructive">{deleteError}</p>
      )}

      {/* 删除确认 */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("prompt.deleteConfirm.title")}</DialogTitle>
            <DialogDescription>{t("prompt.deleteConfirm.desc")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteTarget(null)}>
              {t("prompt.cancel")}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
            >
              {deleteMutation.isPending ? (
                <Loader2Icon data-icon="inline-start" className="size-3.5 animate-spin" />
              ) : (
                <Trash2Icon data-icon="inline-start" className="size-3.5" />
              )}
              {t("prompt.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// 新建 / 编辑表单（由侧边栏「新建」或我的卡片「编辑」触发）
// ---------------------------------------------------------------------------
