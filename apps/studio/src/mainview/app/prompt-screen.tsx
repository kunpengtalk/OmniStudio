import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
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
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Input } from "@ui/input";
import { Button } from "@ui/button";
import { Spinner } from "@ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@ui/dialog";
import { ScrollArea } from "@ui/scroll-area";
import { Badge } from "@ui/badge";
import { useT } from "@stores/ui-lang";
import { usePromptStore } from "@stores/prompt";
import { useAppStore } from "@stores/app";
import { useChatStore } from "@stores/chat";
import { useImageStore } from "@stores/image";
import type { PromptKind, PromptRow } from "../../bun/prompt-library";
import { cn } from "@/mainview/lib/utils";

// ---------------------------------------------------------------------------
// 三种提示词类型（与侧边栏菜单一致）
// ---------------------------------------------------------------------------

const KINDS: { kind: PromptKind; icon: React.ReactNode; labelKey: string }[] = [
  { kind: "image", icon: <ImageIcon className="size-4" />, labelKey: "prompt.kind.image" },
  { kind: "llm", icon: <BotIcon className="size-4" />, labelKey: "prompt.kind.llm" },
  { kind: "video", icon: <FilmIcon className="size-4" />, labelKey: "prompt.kind.video" },
];

/** 来源筛选 chips（image / video 有题库来源；llm 无）。 */
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

/** 「去试试」：生图提示词 → 图片应用；大模型提示词 → 对话；视频提示词 → 仅复制。 */
function usePromptNow(item: PromptRow) {
  const prompt = item.prompt || "";
  if (item.kind === "video") {
    void navigator.clipboard.writeText(prompt);
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

/** 回退到仓库内置素材（随 vite public/ 打进 webview）的相对路径。 */
function bundledMediaUrl(u: string | null): string | null {
  if (!u) return null;
  const i = u.indexOf("/prompt-library/");
  return i >= 0 ? u.slice(i + 1) : null;
}

/** 图片/封面：依次尝试 服务端地址（远程/本地）→ 内置素材 → 渐变占位。 */
function PromptMedia({ item, className }: { item: PromptRow; className?: string }) {
  const [stage, setStage] = useState<0 | 1 | 2>(0);
  const src = stage === 0 ? item.image : stage === 1 ? bundledMediaUrl(item.image) : null;
  const hasMedia = !!src;
  const ratio = item.ratio || "1 / 1";
  return (
    <div
      className={cn("relative w-full overflow-hidden bg-muted/60", className)}
      style={{ aspectRatio: ratio }}
    >
      {hasMedia ? (
        <img
          src={src!}
          alt={item.name}
          loading="lazy"
          decoding="async"
          onError={() => setStage((s) => (s < 2 ? ((s + 1) as 0 | 1 | 2) : s))}
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
// 卡片
// ---------------------------------------------------------------------------

function PromptCard({ item, onOpen }: { item: PromptRow; onOpen: () => void }) {
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
        </div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// 详情浮层（左右切换 + 复制 / 去试试）
// ---------------------------------------------------------------------------

function PromptDetailDialog({
  items,
  index,
  onClose,
  onStep,
}: {
  items: PromptRow[];
  index: number;
  onClose: () => void;
  onStep: (delta: number) => void;
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
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 主界面
// ---------------------------------------------------------------------------

export function PromptScreen() {
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

  // 滚动到底部自动加载更多
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
          fetchNextPage();
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // 详情浮层：在当前已加载列表内左右切换
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const closeViewer = () => setViewerIndex(null);
  const step = (delta: number) => {
    setViewerIndex((i) =>
      i == null || items.length === 0 ? i : (i + delta + items.length) % items.length,
    );
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (viewerIndex == null) return;
      if (e.key === "Escape") closeViewer();
      else if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewerIndex]);
  // 过滤条件变化后关闭浮层
  useEffect(() => {
    setViewerIndex(null);
  }, [kind, category, source, debouncedSearch]);

  const { data: catsData } = useQuery({
    queryKey: ["prompt-categories", kind],
    queryFn: () => rpcClient.listPromptCategories({ kind }),
  });
  const activeCatIntro =
    category === "all" ? undefined : catsData?.categories.find((c) => c.name === category)?.intro;

  const kindCount = stats?.counts[kind];
  const activeKind = KINDS.find((k) => k.kind === kind) ?? KINDS[0]!;
  const sourceFilters = SOURCE_FILTERS[kind] ?? [];
  const chip = (active: boolean) =>
    cn(
      "shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
      active
        ? "bg-primary text-primary-foreground"
        : "border text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground",
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 工具栏：标题 + 副标题 + 来源/搜索 */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5">
        <div className="flex items-center gap-1.5">
          <ClipboardListIcon className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold">{t("prompt.title")}</span>
          <span className="text-xs text-muted-foreground">
            {t(`prompt.kind.${kind}`)}
            {kindCount ? ` · ${total > 0 ? `${items.length} / ${total}` : kindCount}` : ""}
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
                {activeKind.icon}
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
                  <PromptCard key={item.id} item={item} onOpen={() => setViewerIndex(i)} />
                ))}
              </div>
              <div ref={sentinelRef} className="h-4" />
              {isFetchingNextPage && (
                <div className="flex justify-center py-3">
                  <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
                </div>
              )}
            </>
          )}
        </div>
      </ScrollArea>

      {viewerIndex != null && items[viewerIndex] && (
        <PromptDetailDialog items={items} index={viewerIndex} onClose={closeViewer} onStep={step} />
      )}
    </div>
  );
}
