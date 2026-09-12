import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ImageIcon,
  CopyIcon,
  CheckIcon,
  ArrowRightIcon,
  SearchIcon,
  XIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FilmIcon,
  BotIcon,
  Loader2Icon,
  ClipboardListIcon,
  PlusIcon,
  PencilIcon,
  Trash2Icon,
  BookMarkedIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Input } from "@ui/input";
import { Button } from "@ui/button";
import { Spinner } from "@ui/spinner";
import { Textarea } from "@ui/textarea";
import { Label } from "@ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@ui/dialog";
import { ScrollArea } from "@ui/scroll-area";
import { Badge } from "@ui/badge";
import { useT } from "@stores/ui-lang";
import { usePromptStore } from "@stores/prompt";
import { useAppStore } from "@stores/app";
import { useChatStore } from "@stores/chat";
import { useImageStore } from "@stores/image";
import { useVideoStore } from "@stores/video";
import type { PromptKind, PromptRow } from "../../bun/prompt-library";
import type { UserPromptView } from "../../bun/user-prompt";
import { cn } from "@/mainview/lib/utils";

// ---------------------------------------------------------------------------
// 三种提示词类型（与侧边栏菜单一致）
// ---------------------------------------------------------------------------

const KINDS: { kind: PromptKind; icon: React.ReactNode; labelKey: string }[] = [
  { kind: "image", icon: <ImageIcon className="size-4" />, labelKey: "prompt.kind.image" },
  { kind: "llm", icon: <BotIcon className="size-4" />, labelKey: "prompt.kind.llm" },
  { kind: "video", icon: <FilmIcon className="size-4" />, labelKey: "prompt.kind.video" },
];

/** 广场来源筛选 chips（image / video 有题库来源；llm 无）。 */
const SOURCE_FILTERS: Record<PromptKind, { id: string; label: string }[]> = {
  image: [
    { id: "all", label: "全部题库" },
    { id: "img2hub", label: "Image2Hub" },
    { id: "awesome", label: "GPT-Image-2" },
  ],
  video: [
    { id: "all", label: "全部来源" },
    { id: "h3cases", label: "H3 Cases" },
    { id: "atlas", label: "AtlasCloudAI" },
    { id: "xianyu", label: "MiniMax" },
    { id: "flaqai", label: "Template" },
    { id: "god", label: "God" },
  ],
  llm: [],
};

const DEFAULT_INTROS: Record<PromptKind, string> = {
  image: "复制即用的图片提示词库：Image2Hub 实拍验证的运营/APP/海报/插画/IP 场景 + awesome-gpt-image-2 高保真案例。",
  llm: "大模型提示词：vibedesign 设计与 Agent 的实战系统提示词 + 面向本地大模型工作台的常用角色提示词。",
  video: "MiniMax H3（海螺 3.0）视频提示词与案例库：完整提示词可直接复制，纯案例供参考成片。",
};

const PAGE_SIZE = 40;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function CopyButton({ text, label }: { text: string; label: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={!text}
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? (
        <CheckIcon data-icon="inline-start" className="text-emerald-500" />
      ) : (
        <CopyIcon data-icon="inline-start" />
      )}
      {copied ? t("prompt.copied") : label}
    </Button>
  );
}

/** 「去试试」：生图提示词 → 图片应用；视频提示词 → 视频应用；大模型提示词 → 对话。 */
function usePromptNow(item: PromptRow) {
  const prompt = item.prompt || "";
  if (item.kind === "video") {
    useVideoStore.getState().setView("generate");
    useVideoStore.getState().setPendingPrompt(prompt);
    useAppStore.getState().setActiveApp("video");
    return;
  }
  if (item.kind === "image") {
    useImageStore.getState().setTool("generate");
    useImageStore.getState().setPendingPrompt(prompt);
    useAppStore.getState().setActiveApp("image");
  } else {
    useChatStore.getState().setPendingPrompt(prompt);
    useAppStore.getState().setActiveApp("chat");
  }
}

/** 图片/封面：云端直链 → 加载失败时惰性下载到本地缓存 → 渐变占位。 */
function PromptMedia({ item, className }: { item: PromptRow; className?: string }) {
  const [src, setSrc] = useState<string | null>(item.image);
  const [triedLocal, setTriedLocal] = useState(false);
  const ratio = item.ratio || "1 / 1";
  return (
    <div
      className={cn("relative w-full overflow-hidden bg-muted/60", className)}
      style={{ aspectRatio: ratio }}
    >
      {src ? (
        <img
          src={src}
          alt={item.name}
          loading="lazy"
          decoding="async"
          onError={() => {
            if (triedLocal) {
              setSrc(null);
              return;
            }
            setTriedLocal(true);
            if (item.mediaKey) {
              void rpcClient.ensurePromptMedia({ path: item.mediaKey }).then((res) => {
                setSrc(res?.url ?? null);
              });
            } else {
              setSrc(null);
            }
          }}
          className="absolute inset-0 size-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center bg-gradient-to-br from-muted via-muted/40 to-background text-muted-foreground/50">
          {item.kind === "video" ? (
            <FilmIcon className="size-7" />
          ) : (
            <ImageIcon className="size-7" />
          )}
        </div>
      )}
      {/* hover 预览提示词（与参考原型一致） */}
      <div className="absolute inset-0 flex items-end bg-transparent transition-colors duration-200 group-hover:bg-black/55">
        <p className="line-clamp-5 p-3 text-left text-[11px] leading-relaxed text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          {item.prompt || item.summary || item.name}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 卡片（广场 / 我的 共用；extraActions 为操作区尾部附加按钮）
// ---------------------------------------------------------------------------

function PromptCard({
  item,
  onOpen,
  extraActions,
}: {
  item: PromptRow;
  onOpen: () => void;
  extraActions?: React.ReactNode;
}) {
  const t = useT();
  const hasMedia = item.kind !== "llm";

  return (
    <article className="group mb-4 break-inside-avoid overflow-hidden rounded-xl border bg-card transition-shadow hover:shadow-lg">
      {hasMedia && (
        <button
          type="button"
          className="relative block w-full cursor-zoom-in"
          title={t("prompt.viewDetail")}
          onClick={onOpen}
        >
          <PromptMedia item={item} />
        </button>
      )}

      <div className="p-3.5">
        <button
          type="button"
          className="block w-full text-left"
          title={t("prompt.viewDetail")}
          onClick={onOpen}
        >
          <h3 className="truncate text-sm font-semibold text-foreground" title={item.name}>
            {item.name}
          </h3>
        </button>

        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {item.sourceKey && (
            <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
              {t("prompt.fromPlaza")}
            </Badge>
          )}
          {item.subcategory && (
            <Badge variant="secondary" className="text-[10px] font-normal">
              {item.subcategory}
            </Badge>
          )}
          {item.sourceLabel && (
            <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
              {item.sourceLabel}
            </Badge>
          )}
          {item.kind === "video" && item.mode && (
            <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
              {item.mode}
            </Badge>
          )}
        </div>

        {/* 预览：图片/视频用小结，大模型用提示词前几行 */}
        <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
          {item.kind === "llm" && item.summary ? item.summary : item.prompt}
        </p>

        <div className="mt-3 flex items-center gap-2">
          <CopyButton text={item.prompt} label={t("prompt.copy")} />
          <Button
            size="sm"
            className="flex-1"
            disabled={!item.prompt}
            onClick={() => usePromptNow(item)}
          >
            {t("prompt.useIt")}
            <ArrowRightIcon data-icon="inline-end" className="size-3.5" />
          </Button>
          {extraActions}
        </div>
      </div>
    </article>
  );
}

/** 「加入我的提示词」按钮（广场卡片 / 详情浮层用）。 */
function JoinMineButton({
  added,
  busy,
  onClick,
}: {
  added: boolean;
  busy?: boolean;
  onClick: () => void;
}) {
  const t = useT();
  return (
    <Button
      size="icon-sm"
      variant={added ? "secondary" : "outline"}
      disabled={added || busy}
      tooltip={added ? t("prompt.added") : t("prompt.addToMine")}
      onClick={onClick}
    >
      {busy ? (
        <Loader2Icon className="size-3.5 animate-spin" />
      ) : (
        <BookMarkedIcon className="size-3.5" />
      )}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// 详情浮层（左右切换 + 复制 / 去试试 / 附加操作）
// ---------------------------------------------------------------------------

function PromptDetailDialog({
  items,
  index,
  onClose,
  onStep,
  footerExtra,
}: {
  items: PromptRow[];
  index: number;
  onClose: () => void;
  onStep: (delta: number) => void;
  footerExtra?: React.ReactNode;
}) {
  const t = useT();
  const item = items[index];
  if (!item) return null;
  const hasMedia = item.kind !== "llm";

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] max-w-4xl flex-col gap-0 overflow-hidden p-0 sm:rounded-2xl">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
          {hasMedia && (
            <div className="relative flex shrink-0 items-center justify-center bg-muted/50 p-4 md:w-1/2">
              <PromptMedia item={item} className="rounded-lg border" />
              {items.length > 1 && (
                <>
                  <button
                    type="button"
                    aria-label={t("prompt.prev")}
                    onClick={() => onStep(-1)}
                    className="absolute top-1/2 left-3 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-background/90 text-foreground shadow transition-colors hover:bg-background"
                  >
                    <ChevronLeftIcon className="size-4" />
                  </button>
                  <button
                    type="button"
                    aria-label={t("prompt.next")}
                    onClick={() => onStep(1)}
                    className="absolute top-1/2 right-3 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-background/90 text-foreground shadow transition-colors hover:bg-background"
                  >
                    <ChevronRightIcon className="size-4" />
                  </button>
                </>
              )}
            </div>
          )}

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-start justify-between gap-3 border-b px-5 py-4">
              <div className="min-w-0">
                <DialogHeader>
                  <DialogTitle className="truncate text-left text-base">{item.name}</DialogTitle>
                </DialogHeader>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <Badge variant="secondary" className="text-[10px] font-normal">
                    {t(`prompt.kind.${item.kind}`)}
                  </Badge>
                  {item.subcategory && (
                    <Badge variant="secondary" className="text-[10px] font-normal">
                      {item.subcategory}
                    </Badge>
                  )}
                  {item.sourceLabel && (
                    <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
                      {item.sourceLabel}
                    </Badge>
                  )}
                  {item.sourceKey && (
                    <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
                      {t("prompt.fromPlaza")}
                    </Badge>
                  )}
                  {item.kind === "video" && (
                    <span className="text-[10px] text-muted-foreground">
                      {item.mode}
                      {item.duration ? ` · ${item.duration}s` : ""}
                      {item.ratio ? ` · ${item.ratio.replace(/\s/g, "")}` : ""}
                    </span>
                  )}
                </div>
                {item.summary && (
                  <DialogDescription className="mt-1.5 text-xs">{item.summary}</DialogDescription>
                )}
              </div>
            </div>

            <ScrollArea className="min-h-0 flex-1">
              <div className="px-5 py-4">
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
                  {item.prompt}
                </p>
              </div>
            </ScrollArea>

            <div className="flex items-center gap-2 border-t px-5 py-3.5">
              <CopyButton text={item.prompt} label={t("prompt.copyFull")} />
              <Button className="flex-1" disabled={!item.prompt} onClick={() => usePromptNow(item)}>
                {t("prompt.useIt")}
                <ArrowRightIcon data-icon="inline-end" className="size-3.5" />
              </Button>
              {footerExtra}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 提示词广场（内置精选题库）
// ---------------------------------------------------------------------------

function PlazaView({
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
  const chip = (active: boolean) =>
    cn(
      "shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
      active
        ? "bg-primary text-primary-foreground"
        : "border text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground",
    );

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
                  className={chip(source === s.id)}
                  onClick={() => setSource(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("prompt.search")}
              className="h-8 w-52 pl-8 text-xs"
            />
            {search && (
              <button
                type="button"
                aria-label={t("common.cancel")}
                onClick={() => setSearch("")}
                className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <XIcon className="size-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 分类简介 */}
      <div className="shrink-0 border-b bg-muted/30 px-4 py-2">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {activeCatIntro || DEFAULT_INTROS[kind]}
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

function MyView({
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
    onSuccess: () => {
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
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("prompt.search")}
              className="h-8 w-52 pl-8 text-xs"
            />
            {search && (
              <button
                type="button"
                aria-label={t("common.cancel")}
                onClick={() => setSearch("")}
                className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <XIcon className="size-3.5" />
              </button>
            )}
          </div>
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

function PromptEditDialog() {
  const t = useT();
  const queryClient = useQueryClient();
  const editor = usePromptStore((s) => s.editor);
  const closeEditor = usePromptStore((s) => s.closeEditor);
  const currentKind = usePromptStore((s) => s.kind);
  const isEdit = editor?.mode === "edit";

  const [kind, setKind] = useState<PromptKind>("image");
  const [category, setCategory] = useState("");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [summary, setSummary] = useState("");
  const [ratio, setRatio] = useState("");

  useEffect(() => {
    if (!editor) return;
    if (editor.mode === "edit") {
      setKind(editor.item.kind);
      setCategory(editor.item.category === "未分类" ? "" : editor.item.category);
      setName(editor.item.name);
      setPrompt(editor.item.prompt);
      setSummary(editor.item.summary ?? "");
      setRatio(editor.item.ratio ?? "");
    } else {
      setKind(editor.kind ?? currentKind);
      setCategory("");
      setName("");
      setPrompt("");
      setSummary("");
      setRatio("");
    }
  }, [editor, currentKind]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (editor?.mode === "edit") {
        return rpcClient.updateMyPrompt({
          id: editor.item.id,
          patch: { kind, category, name, prompt, summary, ratio },
        });
      }
      return rpcClient.createMyPrompt({ kind, category, name, prompt, summary, ratio });
    },
    onSuccess: () => {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["my-prompts"] }),
        queryClient.invalidateQueries({ queryKey: ["my-prompt-categories"] }),
        queryClient.invalidateQueries({ queryKey: ["my-prompt-stats"] }),
      ]);
      closeEditor();
    },
  });

  const canSave = name.trim().length > 0 && prompt.trim().length > 0;

  return (
    <Dialog open={!!editor} onOpenChange={(open) => !open && !mutation.isPending && closeEditor()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? t("prompt.edit") : t("prompt.new")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {/* 类型（大类型） */}
          <div className="flex items-center gap-3">
            <Label htmlFor="pe-kind" className="w-16 shrink-0 text-xs">
              {t("prompt.form.kind")}
            </Label>
            <div id="pe-kind" className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
              {KINDS.map((k) => (
                <button
                  key={k.kind}
                  type="button"
                  onClick={() => setKind(k.kind)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                    kind === k.kind
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {k.icon}
                  {t(k.labelKey)}
                </button>
              ))}
            </div>
          </div>

          {/* 分类（自定义） */}
          <div className="flex items-center gap-3">
            <Label htmlFor="pe-category" className="w-16 shrink-0 text-xs">
              {t("prompt.form.category")}
            </Label>
            <Input
              id="pe-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder={t("prompt.form.categoryPlaceholder")}
              className="h-8 flex-1 text-xs"
            />
          </div>

          {/* 名称 */}
          <div className="flex items-center gap-3">
            <Label htmlFor="pe-name" className="w-16 shrink-0 text-xs">
              {t("prompt.form.name")}
            </Label>
            <Input
              id="pe-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("prompt.form.namePlaceholder")}
              className="h-8 flex-1 text-xs"
            />
          </div>

          {/* 简介 */}
          <div className="flex items-center gap-3">
            <Label htmlFor="pe-summary" className="w-16 shrink-0 text-xs">
              {t("prompt.form.summary")}
            </Label>
            <Input
              id="pe-summary"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder={t("prompt.form.summaryPlaceholder")}
              className="h-8 flex-1 text-xs"
            />
          </div>

          {/* 比例（图片/视频才有） */}
          {kind !== "llm" && (
            <div className="flex items-center gap-3">
              <Label htmlFor="pe-ratio" className="w-16 shrink-0 text-xs">
                {t("prompt.form.ratio")}
              </Label>
              <Input
                id="pe-ratio"
                value={ratio}
                onChange={(e) => setRatio(e.target.value)}
                placeholder={t("prompt.form.ratioPlaceholder")}
                className="h-8 flex-1 text-xs"
              />
            </div>
          )}

          {/* 提示词 */}
          <div className="flex gap-3">
            <Label htmlFor="pe-prompt" className="w-16 shrink-0 pt-1 text-xs">
              {t("prompt.form.prompt")}
            </Label>
            <Textarea
              id="pe-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={8}
              placeholder={t("prompt.form.promptPlaceholder")}
              className="min-h-0 flex-1 resize-none text-xs"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={closeEditor} disabled={mutation.isPending}>
            {t("prompt.cancel")}
          </Button>
          <Button size="sm" onClick={() => mutation.mutate()} disabled={!canSave || mutation.isPending}>
            {mutation.isPending ? (
              <Loader2Icon data-icon="inline-start" className="size-3.5 animate-spin" />
            ) : null}
            {t("prompt.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 主界面
// ---------------------------------------------------------------------------

/** 滚动到底部自动加载更多（广场 / 我的 共用）。 */
function InfiniteSentinel({
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
          onLoadMore();
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, onLoadMore]);
  return <div ref={ref} className="h-4" />;
}

type Viewer = { kind: "plaza" | "mine"; items: PromptRow[]; index: number } | null;

export function PromptScreen() {
  const queryClient = useQueryClient();
  const { tab, setTab, setKind } = usePromptStore();

  // 「已加入我的提示词」集合 + 加入动作（卡片与详情浮层共用）
  const { data: keysData } = useQuery({
    queryKey: ["my-prompt-keys"],
    queryFn: () => rpcClient.listMyPromptSourceKeys(),
  });
  const addedKeys = useMemo(() => new Set(keysData?.keys ?? []), [keysData]);

  const joinMutation = useMutation({
    mutationFn: (sourceId: number) => rpcClient.importMyPromptFromPlaza({ sourceId }),
    onSuccess: async (res) => {
      if (!res.item) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["my-prompt-keys"] }),
        queryClient.invalidateQueries({ queryKey: ["my-prompt-stats"] }),
        queryClient.invalidateQueries({ queryKey: ["my-prompts"] }),
        queryClient.invalidateQueries({ queryKey: ["my-prompt-categories"] }),
      ]);
      setTab("mine");
      setKind(res.item.kind);
      setViewer({ kind: "mine", items: [res.item], index: 0 });
    },
  });

  const handleJoin = (item: PromptRow) => {
    if (addedKeys.has(item.key) || joinMutation.isPending) return;
    joinMutation.mutate(item.id);
  };

  const [viewer, setViewer] = useState<Viewer>(null);
  const closeViewer = () => setViewer(null);
  const openPlazaViewer = (items: PromptRow[], index: number) =>
    setViewer({ kind: "plaza", items, index });
  const openMineViewer = (items: PromptRow[], index: number) =>
    setViewer({ kind: "mine", items, index });
  const step = (delta: number) =>
    setViewer((v) =>
      v && v.items.length > 0
        ? { ...v, index: (v.index + delta + v.items.length) % v.items.length }
        : v,
    );

  // 键盘导航：Escape / ← / →
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!viewer) return;
      if (e.key === "Escape") closeViewer();
      else if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewer]);

  const viewerItem = viewer ? viewer.items[viewer.index] : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {tab === "plaza" ? (
        <PlazaView
          addedKeys={addedKeys}
          joinPending={joinMutation.isPending}
          onJoin={handleJoin}
          onOpenViewer={openPlazaViewer}
        />
      ) : (
        <MyView onOpenViewer={openMineViewer} />
      )}

      {viewer && (
        <PromptDetailDialog
          items={viewer.items}
          index={viewer.index}
          onClose={closeViewer}
          onStep={step}
          footerExtra={
            viewer.kind === "plaza" && viewerItem ? (
              <JoinMineButton
                added={addedKeys.has(viewerItem.key)}
                busy={joinMutation.isPending}
                onClick={() => handleJoin(viewerItem)}
              />
            ) : undefined
          }
        />
      )}

      <PromptEditDialog />
    </div>
  );
}
