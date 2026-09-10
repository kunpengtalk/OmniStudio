import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpIcon,
  BotIcon,
  BrainIcon,
  ChevronDownIcon,
  Loader2Icon,
  ImagePlusIcon,
  PaperclipIcon,
  GlobeIcon,
  FileTextIcon,
  XIcon,
  RefreshCwIcon,
  AlertTriangleIcon,
  CopyIcon,
  CheckIcon,
  RotateCcwIcon,
  LanguagesIcon,
  Trash2Icon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Textarea } from "@ui/textarea";
import type { ChatMessage } from "../../bun/chat";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@ui/select";
import { useChatStore } from "@stores/chat";
import { useAppStore } from "@stores/app";
import { useT } from "@stores/ui-lang";
import { useServerStore } from "@stores/server";
import { Markdown } from "@components/markdown";
import { persistedErrorMessage, serverErrorHint } from "@/mainview/lib/server-error";
import { cn } from "@/mainview/lib/utils";
import { chatImageUrl } from "../../shared/server-info";

function MessageImages({ images }: { images: string[] }) {
  if (images.length === 0) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {images.map((ref) => (
        <img
          key={ref}
          src={chatImageUrl(ref)}
          alt=""
          className="max-h-44 max-w-full rounded-lg object-contain"
        />
      ))}
    </div>
  );
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** 消息下方的操作栏：吞吐统计 + 复制 / 重新生成 / 翻译 / 删除。 */
function MessageActionBar({
  message,
  isStreamingMessage,
}: {
  message: ChatMessage;
  isStreamingMessage: boolean;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const streaming = useChatStore((s) => s.streaming);
  const stats = useChatStore((s) => s.messageStats[message.id]);
  const [copied, setCopied] = useState(false);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["conversations"] });
    queryClient.invalidateQueries({ queryKey: ["conversation", message.conversationId] });
  };

  const deleteMutation = useMutation({
    mutationFn: () =>
      rpcClient.deleteMessage({
        conversationId: message.conversationId,
        messageId: message.id,
      }),
    onSuccess: () => {
      useChatStore.getState().removeMessage(message.conversationId, message.id);
      invalidate();
    },
  });

  const regenerateMutation = useMutation({
    // 后端会流式写回新消息；先本地回退到这条之前，避免旧内容残留。
    onMutate: () => {
      useChatStore.getState().rewindMessages(message.conversationId, message.id);
      useChatStore.getState().setStreaming(true);
    },
    mutationFn: () =>
      rpcClient.regenerateMessage({
        conversationId: message.conversationId,
        messageId: message.id,
      }),
    onSuccess: invalidate,
    onError: () => {
      useChatStore.getState().setStreaming(false);
      invalidate();
    },
  });

  const translateMutation = useMutation({
    onMutate: () => useChatStore.getState().setStreaming(true),
    mutationFn: () =>
      rpcClient.translateMessage({
        conversationId: message.conversationId,
        messageId: message.id,
        targetLang: "zh-CN",
      }),
    onSuccess: invalidate,
    onError: () => {
      useChatStore.getState().setStreaming(false);
      invalidate();
    },
  });

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — ignore
    }
  };

  // 实时统计优先；刷新页面后只有持久化的 token 数，速度无法复现。
  const speedLabel = stats
    ? `${stats.tokensPerSec.toFixed(1)} tok/s · ${formatTokens(stats.tokens)} tokens`
    : message.tokens != null
      ? `${formatTokens(message.tokens)} tokens`
      : null;

  const disabled = streaming;

  const iconBtn = (tooltip: string, onClick: () => void, icon: ReactNode, extraDisabled = false) => (
    <Button
      variant="ghost"
      size="icon-sm"
      tooltip={tooltip}
      onClick={onClick}
      disabled={disabled || extraDisabled}
      className="size-6 text-muted-foreground/80 hover:text-foreground"
    >
      {icon}
    </Button>
  );

  return (
    <div
      className={cn(
        "mt-1.5 flex items-center gap-0.5",
        message.role === "user" && "justify-end",
      )}
    >
      {message.role === "assistant" && speedLabel && (
        <span className="mr-1.5 text-[10px] tabular-nums text-muted-foreground/70">
          {speedLabel}
        </span>
      )}
      {iconBtn(
        copied ? t("chat.copied") : t("chat.copy"),
        handleCopy,
        copied ? <CheckIcon className="size-3.5 text-emerald-500" /> : <CopyIcon className="size-3.5" />,
        !message.content,
      )}
      {message.role === "assistant" &&
        iconBtn(
          t("chat.regenerate"),
          () => regenerateMutation.mutate(),
          regenerateMutation.isPending ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <RotateCcwIcon className="size-3.5" />
          ),
          isStreamingMessage,
        )}
      {iconBtn(
        t("chat.translate"),
        () => translateMutation.mutate(),
        translateMutation.isPending ? (
          <Loader2Icon className="size-3.5 animate-spin" />
        ) : (
          <LanguagesIcon className="size-3.5" />
        ),
        !message.content,
      )}
      {iconBtn(
        t("chat.delete"),
        () => deleteMutation.mutate(),
        <Trash2Icon className="size-3.5" />,
        isStreamingMessage,
      )}
    </div>
  );
}

/**
 * 可折叠的思考过程区块：流式阶段展开并跟随滚动，思考结束自动折叠，
 * 点标题可随时重新展开查看。
 */
function ReasoningBlock({ reasoning, streaming }: { reasoning: string; streaming: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(streaming);
  const wasStreaming = useRef(streaming);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 流式 → 结束 时自动折叠。
  useEffect(() => {
    if (wasStreaming.current && !streaming) setOpen(false);
    wasStreaming.current = streaming;
  }, [streaming]);

  // 展开且流式中时，思考内容跟随滚动。
  useEffect(() => {
    if (!open || !streaming) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [reasoning, open, streaming]);

  return (
    <div className="overflow-hidden rounded-xl border bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        {streaming ? (
          <Loader2Icon className="size-3 shrink-0 animate-spin" />
        ) : (
          <BrainIcon className="size-3 shrink-0" />
        )}
        <span className="font-medium">{streaming ? t("chat.thinking") : t("chat.reasoning")}</span>
        <ChevronDownIcon
          className={cn("ml-auto size-3.5 shrink-0 transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <div
          ref={bodyRef}
          className="max-h-48 overflow-y-auto whitespace-pre-wrap border-t bg-background/40 px-3 py-2 text-xs leading-5 text-muted-foreground"
        >
          {reasoning}
        </div>
      )}
    </div>
  );
}

function MessageBubble({
  message,
  isStreamingMessage,
}: {
  message: ChatMessage;
  isStreamingMessage: boolean;
}) {
  const t = useT();
  const { role, content, images, reasoning } = message;
  // 后端把启动失败持久化为 "⚠️ <raw error>"，这里补一行本地化的可操作提示。
  const rawError = role === "assistant" ? persistedErrorMessage(content) : null;
  const errorHint = rawError !== null ? serverErrorHint(t, rawError) : null;

  return (
    <div
      className={cn(
        "flex flex-col",
        role === "user" ? "items-end" : "items-start",
      )}
    >
      {role === "user" ? (
        <div className="max-w-[75%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-primary-foreground whitespace-pre-wrap">
          <MessageImages images={images ?? []} />
          {content}
        </div>
      ) : (
        <div className="flex gap-3">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
            <BotIcon className="size-4 text-muted-foreground" />
          </div>
          <div className="flex min-w-0 max-w-[85%] flex-1 flex-col gap-1.5">
            {reasoning ? (
              <ReasoningBlock reasoning={reasoning} streaming={isStreamingMessage} />
            ) : null}
            <div className="rounded-2xl rounded-tl-md border bg-card px-4 py-2.5">
              {content ? (
                <Markdown content={content} />
              ) : isStreamingMessage ? (
                <div className="flex items-center gap-2 py-1 text-sm text-muted-foreground">
                  <Loader2Icon className="size-3.5 animate-spin" />
                  {t("chat.generating")}
                </div>
              ) : null}
              {errorHint && (
              <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 break-words">{errorHint}</span>
              </p>
            )}
            </div>
          </div>
        </div>
      )}
      <MessageActionBar message={message} isStreamingMessage={isStreamingMessage} />
    </div>
  );
}

type Attachment = { ref: string; url: string };
type FileAttachment = { name: string; content: string };

/** 输入框下方的模型选择器：本地已安装模型 + OpenAI 兼容 API 模型。 */
function ModelPicker() {
  const t = useT();
  const streaming = useChatStore((s) => s.streaming);
  const queryClient = useQueryClient();
  const [pendingType, setPendingType] = useState<"local" | "api" | null>(null);

  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  const modelsQuery = useQuery({
    queryKey: ["chat-models"],
    queryFn: () => rpcClient.listChatModels(),
  });

  const settings = settingsData?.settings;
  const mode = settings?.SERVER_MODE ?? "local";
  const chatModel = settings?.CHAT_MODEL ?? "";
  const apiModel = settings?.VLLM_MODEL_NAME ?? "";
  const activePath = settings?.LOCAL_MODEL_PATH ?? "";

  const options = modelsQuery.data?.models ?? [];
  const current =
    mode === "remote" ? apiModel || chatModel || "" : activePath || chatModel || "";

  const selectMutation = useMutation({
    mutationFn: (opt: { type: "local" | "api"; value: string }) =>
      rpcClient.selectChatModel(opt),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["installed-models"] });
      queryClient.invalidateQueries({ queryKey: ["chat-models"] });
      queryClient.invalidateQueries({ queryKey: ["server-status"] });
    },
    onSettled: () => setPendingType(null),
  });

  const handleChange = (value: string) => {
    const option = options.find((o) => o.value === value);
    if (!option || option.value === current) return;
    setPendingType(option.type);
    selectMutation.mutate(option);
  };

  // 下拉框内搜索：按名称 / 详情过滤本地与 API 模型。
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const keyword = query.trim().toLowerCase();
  const matches = (o: { label: string; value: string; detail?: string }) =>
    !keyword ||
    o.label.toLowerCase().includes(keyword) ||
    o.value.toLowerCase().includes(keyword) ||
    (o.detail ?? "").toLowerCase().includes(keyword);
  const closeAndReset = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };

  const localOptions = options.filter((o) => o.type === "local" && matches(o));
  const apiOptions = options.filter((o) => o.type === "api" && matches(o));
  const firstMatch = localOptions[0] ?? apiOptions[0];
  const busy = selectMutation.isPending || modelsQuery.isLoading;
  const selectError =
    selectMutation.isError
      ? String(selectMutation.error)
      : !selectMutation.isPending && selectMutation.data && !selectMutation.data.ok
        ? (selectMutation.data.error ?? t("chat.modelSwitchFailed"))
        : null;

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Select
        value={current}
        open={open}
        onOpenChange={closeAndReset}
        onValueChange={(v) => {
          handleChange(v);
          closeAndReset(false);
        }}
        disabled={busy || streaming}
      >
        <SelectTrigger size="sm" className="h-7 max-w-64 text-xs">
          <SelectValue placeholder={t("chat.modelEmpty")} />
        </SelectTrigger>
        <SelectContent className="max-w-80" position="popper" align="end" sideOffset={6}>
          {/* 搜索框：拦截键盘事件，避免被 Select 的 typeahead 抢走焦点 */}
          <div
            className="sticky top-0 z-10 bg-popover p-1.5 pb-1"
            onKeyDown={(e) => e.stopPropagation()}
          >
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && firstMatch) {
                  e.preventDefault();
                  handleChange(firstMatch.value);
                  closeAndReset(false);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  closeAndReset(false);
                }
              }}
              placeholder={t("chat.modelSearch")}
              autoFocus
              className="h-7 text-xs"
            />
          </div>
          {localOptions.length > 0 && (
            <SelectGroup>
              <SelectLabel>{t("chat.modelLocal")}</SelectLabel>
              {localOptions.map((o) => (
                <SelectItem key={`local-${o.value}`} value={o.value}>
                  <span className="truncate">{o.label}</span>
                  <span className="flex min-w-0 items-center gap-1">
                    {o.engine && (
                      <span className="rounded-sm bg-muted px-1 text-[9px] leading-4 text-muted-foreground">
                        {t(`settings.engine.${o.engine}`)}
                      </span>
                    )}
                    {o.detail && (
                      <span className="truncate text-[10px] text-muted-foreground/70">
                        {o.detail}
                      </span>
                    )}
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          {apiOptions.length > 0 && (
            <SelectGroup>
              <SelectLabel>{t("chat.modelApi")}</SelectLabel>
              {apiOptions.map((o) => (
                <SelectItem key={`api-${o.value}`} value={o.value}>
                  <span className="truncate">{o.label}</span>
                  {o.detail && (
                    <span className="truncate text-[10px] text-muted-foreground/70">
                      {o.detail}
                    </span>
                  )}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          {options.length === 0 && (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">
              {t("chat.modelEmpty")}
            </div>
          )}
          {options.length > 0 && !firstMatch && (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">
              {t("chat.modelNoMatch")}
            </div>
          )}
        </SelectContent>
      </Select>
      <Button
        variant="ghost"
        size="icon-sm"
        tooltip={t("chat.modelRefresh")}
        onClick={() => queryClient.invalidateQueries({ queryKey: ["chat-models"] })}
        disabled={modelsQuery.isFetching}
      >
        <RefreshCwIcon
          className={cn("size-3.5", modelsQuery.isFetching && "animate-spin")}
        />
      </Button>
      {selectError && (
        <span className="flex min-w-0 items-center gap-1 text-[11px] text-destructive">
          <AlertTriangleIcon className="size-3 shrink-0" />
          <span className="truncate">{selectError}</span>
        </span>
      )}
      {selectMutation.isPending && (
        <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
          <Loader2Icon className="size-3 shrink-0 animate-spin" />
          <span className="truncate">
            {pendingType === "local" ? t("chat.modelRestarting") : t("chat.modelSwitching")}
          </span>
        </span>
      )}
    </div>
  );
}

function ChatMessages({ conversationId }: { conversationId: number }) {
  const queryClient = useQueryClient();
  const t = useT();
  const activeMessages = useChatStore((s) => s.activeMessages);
  const streaming = useChatStore((s) => s.streaming);
  const serverStatus = useServerStore((s) => s.status);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [fileAttachments, setFileAttachments] = useState<FileAttachment[]>([]);
  const [webSearch, setWebSearch] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const convQuery = useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: () => rpcClient.getConversation({ id: conversationId }),
  });

  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  const isRemoteMode = settingsQuery.data?.settings?.SERVER_MODE === "remote";
  const webSearchDefault = settingsQuery.data?.settings?.WEB_SEARCH_ENABLED === "1";

  // 联网检索开关的默认值跟随设置项（仅初始化一次，之后由用户在输入框里切换）。
  const webSearchDefaultRef = useRef(false);
  if (!webSearchDefaultRef.current && settingsQuery.isSuccess) {
    webSearchDefaultRef.current = true;
    setWebSearch(webSearchDefault);
  }

  const serverStarting =
    !isRemoteMode && (serverStatus === "starting" || serverStatus === "downloading");
  const serverFailed = !isRemoteMode && serverStatus === "error";

  useEffect(() => {
    useChatStore.getState().setStreaming(false);
    if (convQuery.data) {
      useChatStore.getState().setActiveMessages(convQuery.data.messages);
    }
    setAttachments([]);
    setFileAttachments([]);
  }, [conversationId, convQuery.data]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [
    activeMessages.length,
    activeMessages[activeMessages.length - 1]?.content,
    activeMessages[activeMessages.length - 1]?.reasoning,
  ]);

  const sendMutation = useMutation({
    mutationFn: ({
      content,
      images,
      files,
      search,
    }: {
      content: string;
      images?: string[];
      files?: FileAttachment[];
      search?: boolean;
    }) =>
      rpcClient.sendChatMessage({
        conversationId,
        content,
        images,
        webSearch: search,
        files,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
    },
    onError: (err: unknown) => {
      // RPC 失败且没收到 chatDone（后端异常路径）——解除输入锁定并展示错误，避免"发了没反应"。
      useChatStore.getState().setStreaming(false);
      useChatStore.getState().finalizeMessage(
        conversationId,
        Date.now(),
        `⚠️ ${err instanceof Error ? err.message : String(err)}`,
      );
    },
  });

  const attachMutation = useMutation({
    mutationFn: async () => {
      const { paths } = await rpcClient.openFileDialog({
        allowedFileTypes: "png,jpg,jpeg,webp,gif,bmp",
      });
      if (paths.length === 0) return;
      const { images } = await rpcClient.stageChatImages({ conversationId, paths });
      setAttachments((prev) => [...prev, ...images]);
    },
  });

  const attachFileMutation = useMutation({
    mutationFn: async () => {
      const { paths } = await rpcClient.openFileDialog({
        allowedFileTypes:
          "txt,md,markdown,json,csv,tsv,log,xml,yml,yaml,html,htm,js,jsx,ts,tsx,mjs,cjs,css,scss,less,py,rb,rs,go,java,kt,swift,c,h,cpp,hpp,cs,php,sh,bash,zsh,toml,ini,cfg,conf,sql,vue,svelte,graphql,proto",
      });
      if (paths.length === 0) return;
      const { files } = await rpcClient.stageChatFiles({ conversationId, paths });
      setFileAttachments((prev) => {
        const known = new Set(prev.map((f) => f.name));
        return [...prev, ...files.filter((f) => !known.has(f.name))];
      });
    },
  });

  const removeAttachment = async (attachment: Attachment) => {
    setAttachments((prev) => prev.filter((a) => a.ref !== attachment.ref));
    try {
      await rpcClient.discardChatImage({ ref: attachment.ref });
    } catch {
      // ignore cleanup failures
    }
  };

  const autoResize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  };

  // 提示词库「去试试」带入的草稿：挂载到会话时预填输入框。
  const pendingPrompt = useChatStore((s) => s.pendingPrompt);
  useEffect(() => {
    if (!pendingPrompt) return;
    setInput(pendingPrompt);
    useChatStore.getState().setPendingPrompt(null);
    requestAnimationFrame(autoResize);
  }, [pendingPrompt]);

  const handleSend = () => {
    const content = input.trim();
    const images = attachments.map((a) => a.ref);
    const files = fileAttachments;
    if ((!content && images.length === 0 && files.length === 0) || streaming) return;
    setInput("");
    setAttachments([]);
    setFileAttachments([]);
    requestAnimationFrame(autoResize);
    const now = Date.now();
    useChatStore.getState().setActiveMessages([
      ...activeMessages,
      {
        id: now,
        conversationId,
        role: "user",
        content,
        images,
        createdAt: now,
      },
    ]);
    useChatStore.getState().setStreaming(true);
    sendMutation.mutate({ content, images, files, search: webSearch });
  };

  const hasMessages = activeMessages.length > 0;
  const canSend =
    (input.trim().length > 0 || attachments.length > 0 || fileAttachments.length > 0) &&
    !streaming;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-6">
          {!hasMessages ? (
            <div className="flex flex-col items-center justify-center gap-2 py-24 text-center">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <BotIcon className="size-6" />
              </div>
              <p className="text-sm font-medium">{t("chat.startConversation")}</p>
              <p className="text-xs text-muted-foreground">{t("chat.askAnything")}</p>
            </div>
          ) : (
            activeMessages.map((m) => (
              <MessageBubble
                key={m.id}
                message={m}
                isStreamingMessage={
                  streaming && m.id === activeMessages[activeMessages.length - 1]?.id
                }
              />
            ))
          )}
        </div>
      </div>

      <div className="shrink-0 border-t bg-gradient-to-t from-muted/40 to-transparent p-4">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
          {(serverStarting || (sendMutation.isPending && serverFailed)) && (
            <div
              className={cn(
                "flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs",
                serverFailed
                  ? "border-destructive/30 bg-destructive/10 text-destructive"
                  : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
              )}
            >
              <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
              <span className="truncate">
                {serverFailed
                  ? t("server.startFailed")
                  : serverStatus === "downloading"
                    ? t("server.startingModel")
                    : t("server.waitingForModel")}
              </span>
              {serverStarting && (
                <span className="ml-auto h-1 w-20 shrink-0 overflow-hidden rounded-full bg-amber-500/20">
                  <span className="block h-full w-1/2 animate-pulse rounded-full bg-amber-500" />
                </span>
              )}
            </div>
          )}

          {/* 大卡片式输入框：上方附件预览 + 多行输入区 + 底部工具条 */}
          <div
            className={cn(
              "flex flex-col rounded-2xl border bg-card shadow-sm transition-colors",
              "focus-within:border-primary/40 focus-within:shadow-md",
            )}
          >
            {(attachments.length > 0 || fileAttachments.length > 0) && (
              <div className="flex flex-wrap gap-2 px-3 pt-3">
                {attachments.map((a) => (
                  <div key={a.ref} className="group relative">
                    <img
                      src={a.url}
                      alt=""
                      className="h-16 w-16 rounded-lg border object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => removeAttachment(a)}
                      className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground opacity-0 transition-opacity group-hover:opacity-100"
                      title={t("chat.removeAttachment")}
                    >
                      <XIcon className="size-3" />
                    </button>
                  </div>
                ))}
                {fileAttachments.map((f) => (
                  <div
                    key={f.name}
                    className="group relative flex max-w-52 items-center gap-1.5 rounded-lg border bg-muted/50 px-2 py-1.5"
                  >
                    <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate text-xs">{f.name}</span>
                    <button
                      type="button"
                      onClick={() =>
                        setFileAttachments((prev) => prev.filter((x) => x.name !== f.name))
                      }
                      className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground opacity-0 transition-opacity group-hover:opacity-100"
                      title={t("chat.removeAttachment")}
                    >
                      <XIcon className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <Textarea
              ref={textareaRef}
              placeholder={t("chat.inputPlaceholder")}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                autoResize();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              className="max-h-56 min-h-16 resize-none border-none bg-transparent px-4 pt-3.5 text-[0.9rem] shadow-none focus-visible:ring-0 dark:bg-transparent"
              rows={2}
            />

            <div className="flex items-center gap-0.5 px-2.5 pb-2.5">
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                tooltip={t("chat.attachFile")}
                onClick={() => attachFileMutation.mutate()}
                disabled={streaming || attachFileMutation.isPending}
              >
                {attachFileMutation.isPending ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <PaperclipIcon className="size-4" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                tooltip={t("chat.attachImage")}
                onClick={() => attachMutation.mutate()}
                disabled={streaming || attachMutation.isPending}
              >
                {attachMutation.isPending ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <ImagePlusIcon className="size-4" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-pressed={webSearch}
                className={cn(
                  webSearch
                    ? "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
                    : "text-muted-foreground",
                )}
                tooltip={webSearch ? t("chat.webSearchOn") : t("chat.webSearchOff")}
                onClick={() => setWebSearch((v) => !v)}
                disabled={streaming}
              >
                <GlobeIcon className="size-4" />
              </Button>

              <div className="ml-auto flex min-w-0 items-center gap-1.5">
                <ModelPicker />
                <Button
                  variant="default"
                  size="icon-lg"
                  className="shrink-0 rounded-full"
                  tooltip={`${t("chat.send")} · ${t("chat.enterHint")}`}
                  onClick={handleSend}
                  disabled={!canSend || sendMutation.isPending}
                >
                  {sendMutation.isPending ? (
                    <Loader2Icon className="size-4 animate-spin" />
                  ) : (
                    <ArrowUpIcon className="size-4" />
                  )}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ChatWindow() {
  const t = useT();
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const activeApp = useAppStore((s) => s.activeApp);
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: () => rpcClient.createConversation({ app: activeApp }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      useChatStore.getState().upsertConversation(data.conversation);
      useChatStore.getState().setActiveConversation(data.conversation.id);
      useChatStore.getState().setActiveMessages([]);
      useChatStore.getState().setStreaming(false);
    },
  });

  const conversationsQuery = useQuery({
    queryKey: ["conversations", activeApp],
    queryFn: () => rpcClient.listConversations({ app: activeApp }),
  });

  // 进入对话时：优先打开一个已有的“空会话”（没有消息的），仅在没有空会话时才新建。
  // 避免反复进入对话页积累一大堆空白 session。
  useEffect(() => {
    if (activeConversationId != null) return;
    if (conversationsQuery.isLoading && !conversationsQuery.data) return;
    const empty = conversationsQuery.data?.conversations?.find(
      (c) => (c.messageCount ?? 0) === 0,
    );
    if (empty) {
      useChatStore.getState().setActiveConversation(empty.id);
      useChatStore.getState().setActiveMessages([]);
      useChatStore.getState().setStreaming(false);
    } else if (!createMutation.isPending) {
      createMutation.mutate();
    }
  }, [
    activeConversationId,
    activeApp,
    conversationsQuery,
    conversationsQuery.isLoading,
    createMutation.isPending,
  ]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {activeConversationId ? (
        <ChatMessages conversationId={activeConversationId} />
      ) : (
        <div className="flex flex-1 items-center justify-center">
          {createMutation.isPending ? (
            <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
          ) : (
            <div className="flex flex-col items-center gap-2 text-center">
              <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <BotIcon className="size-7" />
              </div>
              <p className="text-sm font-medium">{t("chat.placeholder.new")}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
