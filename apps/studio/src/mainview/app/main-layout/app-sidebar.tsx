import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  MicIcon,
  ImageIcon,
  ScanTextIcon,
  SettingsIcon,
  SearchIcon,
  PlusIcon,
  Loader2Icon,
  AudioLinesIcon,
  Wand2Icon,
  Trash2Icon,
  PinIcon,
  PinOffIcon,
  SparklesIcon,
  Maximize2Icon,
  LayersIcon,
  LanguagesIcon,
  ClipboardListIcon,
  ImageIcon as ImagePromptIcon,
  BotIcon,
  FilmIcon,
  LayoutListIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { AudioDownloadButton, audioFileName } from "@components/audio-download";
import type { DocumentStatus } from "@lib/constants";
import { Badge } from "@ui/badge";
import { ScrollArea } from "@ui/scroll-area";
import { Skeleton } from "@ui/skeleton";
import { Spinner } from "@ui/spinner";
import {
  Sidebar as SidebarRoot,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarInput,
  SidebarGroupLabel,
} from "@ui/sidebar";
import { Label } from "@ui/label";
import { useRouter } from "@stores/router";
import { useAppStore, type AppId } from "@stores/app";
import { useChatStore } from "@stores/chat";
import { useVoiceStore, type VoiceTab } from "@stores/voice";
import { useImageStore } from "@stores/image";
import { useT } from "@stores/ui-lang";
import { useTranslateStore } from "@stores/translate";
import { usePromptStore } from "@stores/prompt";
import type { PromptKind } from "@/bun/prompt-library";
import type { TranslationRecordRow } from "@/bun/translate";
import { translationLangShort } from "@/shared/translate";
import { Button } from "@ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ui/dialog";
import { cn } from "@/mainview/lib/utils";

const PAGE_SIZE = 30;
const RING_SIZE = 14;
const RING_STROKE = 2;

function DocStatusDot({
  status,
  processedPages,
  totalPages,
}: {
  status: DocumentStatus;
  processedPages?: number | undefined;
  totalPages?: number | undefined;
}) {
  if (status === "processing" && totalPages && totalPages > 0) {
    const progress = (processedPages ?? 0) / totalPages;
    const r = (RING_SIZE - RING_STROKE) / 2;
    const circumference = 2 * Math.PI * r;
    const offset = circumference * (1 - progress);

    return (
      <svg
        width={RING_SIZE}
        height={RING_SIZE}
        className="size-3.5! shrink-0 -rotate-90"
        viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      >
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={RING_STROKE}
          className="text-muted-foreground/30"
        />
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={RING_STROKE}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className="text-blue-500 transition-[stroke-dashoffset] duration-300"
        />
      </svg>
    );
  }

  if (status === "processing") {
    return <Spinner className="size-3.5! shrink-0 text-muted-foreground" />;
  }

  const color =
    status === "completed"
      ? "bg-emerald-500"
      : status === "failed"
        ? "bg-red-500"
        : "bg-muted-foreground/50";

  return <span className={`size-2 shrink-0 rounded-full ${color}`} />;
}

function OcrRecordList() {
  const { route, setRoute } = useRouter();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const sentinelRef = useRef<HTMLDivElement>(null);
  const t = useT();

  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timeout);
  }, [search]);

  const { data, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage } = useInfiniteQuery({
    queryKey: ["documents", debouncedSearch],
    queryFn: async ({ pageParam = 0 }) => {
      return rpcClient.getDocuments({
        limit: PAGE_SIZE,
        offset: pageParam as number,
        search: debouncedSearch || "",
      });
    },
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.documents.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
    initialPageParam: 0,
  });

  const docs = data?.pages.flatMap((p) => p.documents) ?? [];
  const total = data?.pages[0]?.total ?? 0;

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

  return (
    <SidebarGroup className="min-h-0 flex-1 gap-1">
      <SidebarGroupLabel>
        <span className="flex items-center gap-1.5">
          <ScanTextIcon className="size-3.5" />
          {t("apps.ocr")}
        </span>
        <Badge variant="secondary" className="ml-auto h-5 shrink-0 px-1.5 text-[10px]">
          {total}
        </Badge>
      </SidebarGroupLabel>

      <SidebarGroupContent className="relative">
        <Label htmlFor="ocr-search" className="sr-only">
          {t("nav.search")}
        </Label>
        <SidebarInput
          id="ocr-search"
          placeholder={t("nav.search")}
          className="h-7 pl-8 text-xs"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 opacity-50 select-none" />
      </SidebarGroupContent>

      <ScrollArea className="min-h-0 flex-1">
        <SidebarMenu className="gap-0.5">
          {isLoading ? (
            Array.from({ length: 3 }).map((_, i) => (
              <SidebarMenuItem key={i}>
                <div className="flex flex-col gap-1 rounded-md p-2">
                  <Skeleton className="h-3.5 w-3/4" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </SidebarMenuItem>
            ))
          ) : docs.length === 0 ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              {debouncedSearch ? t("models.noResults") : t("ocr.noDocs")}
            </div>
          ) : (
            <>
              {docs.map((doc) => {
                const isActive = route.path === "document" && route.id === doc.id;
                return (
                  <SidebarMenuItem key={doc.id}>
                    <SidebarMenuButton
                      isActive={isActive}
                      onClick={() => setRoute({ path: "document", id: doc.id })}
                      tooltip={doc.name}
                    >
                      <span className="min-w-0 flex-1 truncate text-xs font-medium">
                        {doc.name}
                      </span>
                      <DocStatusDot
                        status={doc.status as DocumentStatus}
                        processedPages={doc.processedPages ?? undefined}
                        totalPages={doc.totalPages ?? undefined}
                      />
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
              <div ref={sentinelRef} className="h-1" />
              {isFetchingNextPage && (
                <div className="flex justify-center py-1.5">
                  <Spinner className="size-3.5" />
                </div>
              )}
            </>
          )}
        </SidebarMenu>
      </ScrollArea>
    </SidebarGroup>
  );
}

const VOICE_TAB_ICONS: Record<VoiceTab, React.ReactNode> = {
  tts: <AudioLinesIcon className="size-4" />,
  asr: <MicIcon className="size-4" />,
  clone: <Wand2Icon className="size-4" />,
};

function VoiceAudio({ url }: { url: string }) {
  const t = useT();
  const [err, setErr] = useState(false);
  if (err) {
    // 音频文件不存在了(旧记录清理/目录被删),给出明确提示而非死播放器。
    return (
      <p className="rounded bg-muted/60 px-2 py-1 text-[10px] text-muted-foreground">
        {t("voice.records.missing")}
      </p>
    );
  }
  return <audio controls src={url} preload="none" className="h-7 w-full" onError={() => setErr(true)} />;
}

function VoiceRecordList() {
  const t = useT();
  const { tab } = useVoiceStore();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["voice-records", tab],
    queryFn: () => rpcClient.listVoiceRecords({ kind: tab }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => rpcClient.deleteVoiceRecord({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["voice-records"] }),
  });

  const records = data?.records ?? [];

  return (
    <SidebarGroup className="min-h-0 flex-1">
      <SidebarGroupLabel>
        <span className="flex items-center gap-1.5">
          {VOICE_TAB_ICONS[tab]}
          {t(`voice.tab.${tab}`)}
        </span>
        <SidebarMenuBadge>
          <Badge variant="secondary" className="h-5 text-[10px]">
            {records.length}
          </Badge>
        </SidebarMenuBadge>
      </SidebarGroupLabel>

      <ScrollArea className="min-h-0 flex-1">
        <SidebarMenu className="gap-1">
          {isLoading ? (
            <div className="flex justify-center py-6">
              <Spinner className="size-3.5" />
            </div>
          ) : records.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">
              {t("voice.records.empty")}
            </div>
          ) : (
            records.map((r) => (
              <SidebarMenuItem key={r.id} className="px-1">
                <div className="flex w-full flex-col gap-1 rounded-md border px-2 py-1.5">
                  <div className="flex items-center gap-1.5">
                    {r.status === "failed" ? (
                      <Badge variant="destructive" className="text-[10px]">
                        {t("voice.failed")}
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="gap-1 text-[10px]">
                        {VOICE_TAB_ICONS[r.kind]}
                        {t(`voice.records.${r.kind}`)}
                      </Badge>
                    )}
                    {r.voice && (
                      <span className="truncate font-mono text-[10px] text-muted-foreground">
                        {r.voice}
                      </span>
                    )}
                    <span className="ml-auto text-[10px] text-muted-foreground/70 tabular-nums">
                      {new Date(r.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  {r.text && (
                    <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                      {r.text}
                    </p>
                  )}
                  {r.audioUrl && (
                    <div className="flex items-center gap-1">
                      <VoiceAudio url={r.audioUrl} />
                      <AudioDownloadButton
                        url={r.audioUrl}
                        filename={audioFileName(r.audioUrl, r.model || r.voice || r.kind)}
                      />
                    </div>
                  )}
                  {!r.audioUrl && r.error && (
                    <p className="line-clamp-2 text-[10px] text-destructive">{r.error}</p>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    tooltip={t("voice.records.delete")}
                    className="ml-auto h-6 w-6"
                    disabled={deleteMutation.isPending}
                    onClick={() => deleteMutation.mutate(r.id)}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
              </SidebarMenuItem>
            ))
          )}
        </SidebarMenu>
      </ScrollArea>
    </SidebarGroup>
  );
}

function ConversationRecordList({ app }: { app: AppId }) {
  const queryClient = useQueryClient();
  const t = useT();
  const conversations = useChatStore((s) => s.conversations);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedSearch(search), 200);
    return () => clearTimeout(timeout);
  }, [search]);

  const listQuery = useQuery({
    queryKey: ["conversations", app],
    queryFn: () => rpcClient.listConversations({ app }),
  });

  useEffect(() => {
    if (listQuery.data) {
      useChatStore.getState().setConversations(listQuery.data.conversations);
    }
  }, [listQuery.data]);

  const createMutation = useMutation({
    mutationFn: () => rpcClient.createConversation({ app }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      useChatStore.getState().upsertConversation(data.conversation);
      useChatStore.getState().setActiveConversation(data.conversation.id);
      useChatStore.getState().setActiveMessages([]);
    },
  });

  const pinMutation = useMutation({
    mutationFn: (id: number) => rpcClient.togglePinConversation({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["conversations", app] }),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: number) => rpcClient.deleteConversation({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["conversations", app] }),
  });

  const needle = debouncedSearch.trim().toLowerCase();
  const filtered = needle
    ? conversations.filter((c) => c.title.toLowerCase().includes(needle))
    : conversations;

  const confirmDelete = confirmDeleteId != null
    ? conversations.find((c) => c.id === confirmDeleteId)
    : undefined;

  return (
    <SidebarGroup className="min-h-0 flex-1">
      {/* 顶部一行：标题 + 浅色数量标识 + 新建对话按钮（最右侧，后面无数字） */}
      <SidebarGroupLabel>
        <span className="flex items-center gap-1.5">
          {app === "voicecall"
            ? t("voicecall.history")
            : app === "agent"
              ? t("agent.sessions")
              : t("chat.chats")}
          <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
            {conversations.length}
          </Badge>
        </span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto h-6 shrink-0 gap-1 px-2 text-[11px]"
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending}
        >
          {createMutation.isPending ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <PlusIcon className="size-3.5" />
          )}
          {t("chat.newChat")}
        </Button>
      </SidebarGroupLabel>

      {/* 搜索框 */}
      <SidebarGroupContent className="relative">
        <Label htmlFor="conversation-search" className="sr-only">
          {t("chat.search")}
        </Label>
        <SidebarInput
          id="conversation-search"
          placeholder={t("chat.search")}
          className="pl-8 h-7 text-xs"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 opacity-50 select-none" />
      </SidebarGroupContent>

      <ScrollArea className="min-h-0 flex-1">
        <SidebarMenu className="gap-0.5">
          {listQuery.isLoading ? (
            <div className="flex justify-center py-6">
              <Spinner className="size-3.5" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">
              {needle ? t("chat.noSearchResults") : t("chat.noConversations")}
            </div>
          ) : (
            filtered.map((c) => {
              const isActive = c.id === activeConversationId;
              return (
                <SidebarMenuItem key={c.id} className="group/conversation">
                  <SidebarMenuButton
                    isActive={isActive}
                    onClick={() => useChatStore.getState().setActiveConversation(c.id)}
                    tooltip={c.title}
                  >
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">
                      {c.title}
                    </span>
                    {!!c.pinned && (
                      <PinIcon className="size-3.5 shrink-0 fill-primary text-primary/70" />
                    )}
                    <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/conversation:opacity-100">
                      <button
                        type="button"
                        disabled={pinMutation.isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          pinMutation.mutate(c.id);
                        }}
                        title={c.pinned ? t("chat.unpin") : t("chat.pin")}
                        className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-primary"
                      >
                        {c.pinned ? (
                          <PinOffIcon className="size-3.5" />
                        ) : (
                          <PinIcon className="size-3.5" />
                        )}
                      </button>
                      <button
                        type="button"
                        disabled={deleteMutation.isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDeleteId(c.id);
                        }}
                        title={t("chat.deleteConversation")}
                        className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive"
                      >
                        <Trash2Icon className="size-3.5" />
                      </button>
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })
          )}
        </SidebarMenu>
      </ScrollArea>

      {confirmDelete && (
        <Dialog
          open={confirmDeleteId != null}
          onOpenChange={(open) => {
            if (!open) setConfirmDeleteId(null);
          }}
        >
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>{t("chat.deleteConversationConfirmTitle")}</DialogTitle>
              <DialogDescription>
                {t("chat.deleteConversationConfirmBody")}{" "}
                <span className="font-medium text-foreground">「{confirmDelete.title}」</span>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmDeleteId(null)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={deleteMutation.isPending}
                onClick={() => {
                  if (confirmDeleteId == null) return;
                  deleteMutation.mutate(confirmDeleteId, {
                    onSuccess: () => setConfirmDeleteId(null),
                  });
                }}
              >
                {deleteMutation.isPending ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <Trash2Icon className="size-3.5" />
                )}
                {t("common.delete")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </SidebarGroup>
  );
}

function ImageRecordList() {
  const t = useT();
  const { tool, setTool, focusRecordId, setFocusRecordId } = useImageStore();

  const { data, isLoading } = useQuery({
    queryKey: ["image-records"],
    queryFn: () => rpcClient.listImageRecords(undefined),
  });
  const records = data?.records ?? [];

  const pick = (id: number) => {
    setFocusRecordId(id);
  };

  return (
    <SidebarGroup className="min-h-0 flex-1">
      {/* 生图工具菜单：可切换（放大/批量暂未开放） */}
      <div className="grid grid-cols-3 gap-1 px-1 pb-1">
        {(
          [
            { key: "generate", icon: <SparklesIcon className="size-4" />, labelKey: "image.tab.generate", soon: false },
            { key: "upscale", icon: <Maximize2Icon className="size-4" />, labelKey: "image.tab.upscale", soon: true },
            { key: "batch", icon: <LayersIcon className="size-4" />, labelKey: "image.tab.batch", soon: true },
          ] as const
        ).map((item) => (
          <button
            key={item.key}
            type="button"
            disabled={item.soon}
            title={item.soon ? t("image.comingSoon") : undefined}
            onClick={() => {
              setTool(item.key);
              setFocusRecordId(null);
            }}
            className={cn(
              "flex flex-col items-center gap-1 rounded-lg px-1 py-2 text-[11px] transition-colors",
              item.soon && "cursor-not-allowed opacity-45",
              !item.soon && tool === item.key
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {item.icon}
            <span className="leading-none">{t(item.labelKey)}</span>
          </button>
        ))}
      </div>
      <SidebarGroupLabel>
        <ImageIcon className="size-3.5" />
        {t("image.history.title")}
        <SidebarMenuBadge>
          <Badge variant="secondary" className="h-5 text-[10px]">
            {records.length}
          </Badge>
        </SidebarMenuBadge>
      </SidebarGroupLabel>

      <ScrollArea className="min-h-0 flex-1">
        <SidebarMenu className="gap-1">
          {isLoading ? (
            <div className="flex justify-center py-6">
              <Spinner className="size-3.5" />
            </div>
          ) : records.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">
              {t("image.history.empty")}
            </div>
          ) : (
            records.map((r) => (
              <SidebarMenuItem key={r.id} className="px-1">
                <button
                  type="button"
                  onClick={() => pick(r.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md border p-1.5 text-left transition-colors",
                    focusRecordId === r.id
                      ? "border-primary/60 bg-primary/5"
                      : "hover:bg-muted/60",
                  )}
                >
                  {r.imageUrl ? (
                    <img
                      src={r.imageUrl}
                      alt=""
                      loading="lazy"
                      className="size-9 shrink-0 rounded object-cover"
                    />
                  ) : (
                    <span className="flex size-9 shrink-0 items-center justify-center rounded bg-muted">
                      <ImageIcon className="size-3.5 text-muted-foreground" />
                    </span>
                  )}
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="line-clamp-2 text-[11px] leading-snug text-foreground/80">
                      {r.prompt || t("image.error")}
                    </span>
                    <span className="text-[10px] text-muted-foreground/70 tabular-nums">
                      {new Date(r.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </span>
                </button>
              </SidebarMenuItem>
            ))
          )}
        </SidebarMenu>
      </ScrollArea>
    </SidebarGroup>
  );
}

function formatRecordTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function TranslateRecordList() {
  const t = useT();
  const queryClient = useQueryClient();
  const activeRecord = useTranslateStore((s) => s.activeRecord);
  const selectRecord = useTranslateStore((s) => s.selectRecord);
  const clearActive = useTranslateStore((s) => s.clearActive);
  const [confirmDelete, setConfirmDelete] = useState<TranslationRecordRow | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["translation-records"],
    queryFn: () => rpcClient.listTranslationRecords(undefined),
  });
  const records = data?.records ?? [];

  const deleteMutation = useMutation({
    mutationFn: (id: number) => rpcClient.deleteTranslationRecord({ id }),
    onSuccess: (_res, id) => {
      setConfirmDelete(null);
      if (activeRecord?.id === id) clearActive();
      queryClient.invalidateQueries({ queryKey: ["translation-records"] });
    },
  });

  return (
    <SidebarGroup className="min-h-0 flex-1">
      <SidebarGroupLabel>
        <span className="flex items-center gap-1.5">
          <LanguagesIcon className="size-3.5" />
          {t("translate.history.title")}
        </span>
        <SidebarMenuBadge>
          <Badge variant="secondary" className="h-5 text-[10px]">
            {records.length}
          </Badge>
        </SidebarMenuBadge>
      </SidebarGroupLabel>

      <ScrollArea className="min-h-0 flex-1">
        <SidebarMenu className="gap-1">
          {isLoading ? (
            <div className="flex justify-center py-6">
              <Spinner className="size-3.5" />
            </div>
          ) : records.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              {t("translate.history.empty")}
            </div>
          ) : (
            records.map((r) => (
              <SidebarMenuItem key={r.id} className="group/translate px-1">
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => selectRecord(r)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") selectRecord(r);
                  }}
                  className={cn(
                    "flex w-full cursor-pointer flex-col gap-1 rounded-md border p-1.5 text-left outline-none transition-colors",
                    activeRecord?.id === r.id
                      ? "border-primary/60 bg-primary/5"
                      : "hover:bg-muted/60 focus-visible:bg-muted/60",
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    <span className="shrink-0 text-[10px] font-semibold tracking-wide text-primary/70 tabular-nums">
                      {translationLangShort(r.sourceLang)} → {translationLangShort(r.targetLang)}
                    </span>
                    <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
                      {formatRecordTime(r.createdAt)}
                    </span>
                    <button
                      type="button"
                      disabled={deleteMutation.isPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDelete(r);
                      }}
                      title={t("common.delete")}
                      className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-destructive group-hover/translate:opacity-100"
                    >
                      <Trash2Icon className="size-3.5" />
                    </button>
                  </span>
                  <span
                    className="line-clamp-2 text-[11px] leading-snug text-foreground/80"
                    title={r.text}
                  >
                    {r.text}
                  </span>
                  {r.result && (
                    <span
                      className="line-clamp-1 text-[10px] leading-snug text-muted-foreground"
                      title={r.result}
                    >
                      {r.result}
                    </span>
                  )}
                </div>
              </SidebarMenuItem>
            ))
          )}
        </SidebarMenu>
      </ScrollArea>

      {confirmDelete && (
        <Dialog
          open={!!confirmDelete}
          onOpenChange={(open) => {
            if (!open) setConfirmDelete(null);
          }}
        >
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>{t("translate.history.deleteTitle")}</DialogTitle>
              <DialogDescription>{t("translate.history.deleteDesc")}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmDelete(null)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={deleteMutation.isPending}
                onClick={() => deleteMutation.mutate(confirmDelete.id)}
              >
                {deleteMutation.isPending ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <Trash2Icon className="size-3.5" />
                )}
                {t("common.delete")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </SidebarGroup>
  );
}

// ---------------------------------------------------------------------------
// 提示词库侧边栏：左侧最窄列（AppRail）之外的「菜单」列，
// 负责在生图 / 大模型 / 视频三类之间切换，并列出当前类的分类导航。
// ---------------------------------------------------------------------------

const PROMPT_KIND_TABS: {
  kind: PromptKind;
  icon: React.ReactNode;
  labelKey: string;
}[] = [
  { kind: "image", icon: <ImagePromptIcon className="size-4" />, labelKey: "prompt.kind.image" },
  { kind: "llm", icon: <BotIcon className="size-4" />, labelKey: "prompt.kind.llm" },
  { kind: "video", icon: <FilmIcon className="size-4" />, labelKey: "prompt.kind.video" },
];

function PromptSidebar() {
  const t = useT();
  const { kind, setKind, category, setCategory } = usePromptStore();

  const { data: stats } = useQuery({
    queryKey: ["prompt-stats"],
    queryFn: () => rpcClient.getPromptLibraryStats(),
  });
  const { data: catsData, isLoading } = useQuery({
    queryKey: ["prompt-categories", kind],
    queryFn: () => rpcClient.listPromptCategories({ kind }),
  });
  const categories = catsData?.categories ?? [];

  return (
    <SidebarGroup className="min-h-0 flex-1">
      <SidebarGroupLabel>
        <span className="flex items-center gap-1.5">
          <ClipboardListIcon className="size-3.5" />
          {t("prompt.title")}
        </span>
      </SidebarGroupLabel>

      {/* 三类切换菜单：生图 / 大模型 / 视频 */}
      <div className="flex flex-col gap-0.5 px-2 pb-1">
        {PROMPT_KIND_TABS.map(({ kind: k, icon, labelKey }) => {
          const active = kind === k;
          const count = stats?.counts[k] ?? 0;
          return (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={cn(
                "flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors",
                active
                  ? "bg-primary/10 font-medium text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {icon}
              <span className="flex-1 text-left">{t(labelKey)}</span>
              <Badge variant="secondary" className="h-4 px-1.5 text-[9px] tabular-nums">
                {count || "…"}
              </Badge>
            </button>
          );
        })}
      </div>

      {/* 分类导航 */}
      <SidebarGroupLabel className="mt-1">
        <span className="flex items-center gap-1.5">
          <LayoutListIcon className="size-3.5" />
          {t("prompt.categories")}
        </span>
      </SidebarGroupLabel>
      <ScrollArea className="min-h-0 flex-1">
        <SidebarMenu className="gap-0.5">
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={category === "all"}
              onClick={() => setCategory("all")}
              tooltip={t("prompt.allCategories")}
            >
              <span className="min-w-0 flex-1 truncate text-xs">{t("prompt.allCategories")}</span>
              <Badge variant="secondary" className="h-4 px-1.5 text-[9px] tabular-nums">
                {stats?.counts[kind] ?? "…"}
              </Badge>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {isLoading ? (
            <div className="flex justify-center py-4">
              <Spinner className="size-3.5" />
            </div>
          ) : (
            categories.map((c) => (
              <SidebarMenuItem key={c.name}>
                <SidebarMenuButton
                  isActive={category === c.name}
                  onClick={() => setCategory(c.name)}
                  tooltip={c.name}
                >
                  <span className="min-w-0 flex-1 truncate text-xs">{c.name}</span>
                  <Badge variant="secondary" className="h-4 px-1.5 text-[9px] tabular-nums">
                    {c.count}
                  </Badge>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))
          )}
        </SidebarMenu>
      </ScrollArea>
    </SidebarGroup>
  );
}

export function AppSidebar() {
  const t = useT();
  const { activeApp } = useAppStore();
  const { setRoute } = useRouter();

  return (
    <SidebarRoot collapsible="none" side="left" className="border-r">
      <div className="electrobun-webkit-app-region-drag h-8 w-full shrink-0" />

      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem className="px-2" onClick={() => setRoute({ path: "index" })}>
            <span className="font-semibold tracking-tight">{t("chat.aimStudio")}</span>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {activeApp === "ocr" ? (
          <OcrRecordList />
        ) : activeApp === "voice" ? (
          <VoiceRecordList />
        ) : activeApp === "image" ? (
          <ImageRecordList />
        ) : activeApp === "translate" ? (
          <TranslateRecordList />
        ) : activeApp === "prompt" ? (
          <PromptSidebar />
        ) : (
          <ConversationRecordList app={activeApp} />
        )}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip={t("nav.settings")}
              onClick={() => setRoute({ path: "settings" })}
            >
              <SettingsIcon className="size-4" />
              <span>{t("nav.settings")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </SidebarRoot>
  );
}