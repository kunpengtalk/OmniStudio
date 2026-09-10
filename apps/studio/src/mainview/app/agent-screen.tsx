import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpIcon,
  BotIcon,
  BrainIcon,
  ChevronDownIcon,
  CircuitBoardIcon,
  FolderOpenIcon,
  FolderIcon,
  Loader2Icon,
  SquareIcon,
  WrenchIcon,
  PlusIcon,
  FileTextIcon,
  XIcon,
  CopyIcon,
  CheckIcon,
  RotateCcwIcon,
  Trash2Icon,
  AlertTriangleIcon,
  TerminalIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Textarea } from "@ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui/select";
import { ModelPicker } from "@components/model-picker";
import { Markdown } from "@components/markdown";
import { useChatStore } from "@stores/chat";
import { useAgentStore } from "@stores/agent";
import { useAppStore } from "@stores/app";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import type { AgentEventRow, AgentMode } from "../../bun/agent";

const MODES: AgentMode[] = ["agent", "plan", "goal"];

type Attachment = { ref: string; url: string };
type FileAttachment = { name: string; content: string };

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];
const TEXT_EXTS =
  "txt,md,markdown,json,csv,tsv,log,xml,yml,yaml,html,htm,js,jsx,ts,tsx,mjs,cjs,css,scss,less,py,rb,rs,go,java,kt,swift,c,h,cpp,hpp,cs,php,sh,bash,zsh,toml,ini,cfg,conf,sql,vue,svelte,graphql,proto";

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** 单条工具调用：工具名 + 入参 + 输出（默认折叠输出）。 */
function ToolCallCard({ start, end }: { start: AgentEventRow; end?: AgentEventRow }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const pending = !end;
  const failed = end?.isError === 1;
  const output = end?.output ?? "";

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border text-xs",
        failed
          ? "border-destructive/30 bg-destructive/5"
          : "bg-muted/30",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] transition-colors hover:text-foreground"
      >
        {pending ? (
          <Loader2Icon className="size-3 shrink-0 animate-spin" />
        ) : failed ? (
          <AlertTriangleIcon className="size-3 shrink-0 text-destructive" />
        ) : (
          <WrenchIcon className="size-3 shrink-0" />
        )}
        <span className="font-medium">{start.toolName}</span>
        <span className="truncate text-muted-foreground/70">{start.output}</span>
        <ChevronDownIcon
          className={cn("ml-auto size-3.5 shrink-0 transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <div className="space-y-1.5 border-t bg-background/40 px-3 py-2">
          {start.args && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all text-[10px] text-muted-foreground">
              {start.args}
            </pre>
          )}
          {output ? (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-[10px]">
              {output}
            </pre>
          ) : (
            !pending && <span className="text-[10px] text-muted-foreground">{t("agent.noOutput")}</span>
          )}
        </div>
      )}
    </div>
  );
}

/** 一次运行里的「正在做什么」提示条（状态 / 错误事件）。 */
function StatusLine({ event }: { event: AgentEventRow }) {
  const isError = event.kind === "error" || event.isError === 1;
  return (
    <div
      className={cn(
        "flex items-start gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px]",
        isError ? "bg-destructive/10 text-destructive" : "bg-muted/40 text-muted-foreground",
      )}
    >
      {isError ? (
        <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
      ) : (
        <TerminalIcon className="mt-0.5 size-3 shrink-0" />
      )}
      <span className="min-w-0 break-words">{event.output}</span>
    </div>
  );
}

function ReasoningBlock({ reasoning, streaming }: { reasoning: string; streaming: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(streaming);
  const wasStreaming = useRef(streaming);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (wasStreaming.current && !streaming) setOpen(false);
    wasStreaming.current = streaming;
  }, [streaming]);

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

function MessageActionBar({
  messageId,
  conversationId,
  content,
  isStreamingMessage,
}: {
  messageId: number;
  conversationId: number;
  content: string;
  isStreamingMessage: boolean;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const streaming = useChatStore((s) => s.streaming);
  const stats = useChatStore((s) => s.messageStats[messageId]);
  const [copied, setCopied] = useState(false);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["conversations"] });
    queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
    queryClient.invalidateQueries({ queryKey: ["agent-events", conversationId] });
  };

  const deleteMutation = useMutation({
    mutationFn: () => rpcClient.deleteMessage({ conversationId, messageId }),
    onSuccess: () => {
      useChatStore.getState().removeMessage(conversationId, messageId);
      invalidate();
    },
  });

  const regenerateMutation = useMutation({
    onMutate: () => {
      useChatStore.getState().rewindMessages(conversationId, messageId);
      useChatStore.getState().setStreaming(true);
      useAgentStore.getState().setRunning(true);
    },
    mutationFn: () => rpcClient.regenerateAgentMessage({ conversationId, messageId }),
    onSuccess: invalidate,
    onError: () => {
      useChatStore.getState().setStreaming(false);
      useAgentStore.getState().setRunning(false);
      invalidate();
    },
  });

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — ignore
    }
  };

  const speedLabel = stats
    ? `${stats.tokensPerSec.toFixed(1)} tok/s · ${formatTokens(stats.tokens)} tokens`
    : null;

  const iconBtn = (tooltip: string, onClick: () => void, icon: ReactNode, extraDisabled = false) => (
    <Button
      variant="ghost"
      size="icon-sm"
      tooltip={tooltip}
      onClick={onClick}
      disabled={streaming || extraDisabled}
      className="size-6 text-muted-foreground/80 hover:text-foreground"
    >
      {icon}
    </Button>
  );

  return (
    <div className="mt-1.5 flex items-center gap-0.5">
      {speedLabel && (
        <span className="mr-1.5 text-[10px] tabular-nums text-muted-foreground/70">
          {speedLabel}
        </span>
      )}
      {iconBtn(
        copied ? t("chat.copied") : t("chat.copy"),
        handleCopy,
        copied ? <CheckIcon className="size-3.5 text-emerald-500" /> : <CopyIcon className="size-3.5" />,
        !content,
      )}
      {iconBtn(
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
        t("chat.delete"),
        () => deleteMutation.mutate(),
        <Trash2Icon className="size-3.5" />,
        isStreamingMessage,
      )}
    </div>
  );
}

/**
 * 模式切换（Agent / Plan / Goal）：放在输入框底部工具条的左侧，
 * 跟 PI-Desktop 的 Composer 一样在输入区里直接定模式，不用去别处找。
 */
function ModeSwitch({
  mode,
  onChange,
  disabled,
}: {
  mode: AgentMode;
  onChange: (mode: AgentMode) => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-0.5 rounded-full border bg-muted/50 p-0.5">
      {MODES.map((m) => (
        <button
          key={m}
          type="button"
          disabled={disabled}
          title={t(`agent.mode.${m}.hint`)}
          onClick={() => onChange(m)}
          aria-pressed={mode === m}
          className={cn(
            "rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
            mode === m
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
            disabled && "cursor-not-allowed opacity-60",
          )}
        >
          {t(`agent.mode.${m}`)}
        </button>
      ))}
    </div>
  );
}

/** 路径展示名：取最后一段目录名。 */
function workspaceLabel(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/**
 * 工作区选择器：做成输入框左上角外侧的 chip，点开向上弹出面板
 * （搜索 + 最近使用 + 打开文件夹），交互对齐主流 Agent 工作台。
 */
function WorkspacePicker({
  workspace,
  isDefault,
  defaultWorkspace,
  onChange,
}: {
  workspace: string;
  isDefault: boolean;
  defaultWorkspace: string;
  onChange: (path: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [browsing, setBrowsing] = useState(false);

  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });

  const recents = useMemo(() => {
    try {
      const parsed = JSON.parse(settingsData?.settings?.AGENT_WORKSPACES ?? "[]");
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  }, [settingsData]);

  const keyword = query.trim().toLowerCase();
  const visible = recents.filter(
    (p) => !keyword || workspaceLabel(p).toLowerCase().includes(keyword) || p.toLowerCase().includes(keyword),
  );

  const select = async (path: string) => {
    const next = [path, ...recents.filter((p) => p !== path)].slice(0, 8);
    await rpcClient.updateSettings({
      settings: { AGENT_WORKSPACE: path, AGENT_WORKSPACES: JSON.stringify(next) },
    });
    onChange(path);
    setOpen(false);
    setQuery("");
  };

  const openFolder = async () => {
    setBrowsing(true);
    try {
      const { path } = await rpcClient.openDirectoryDialog(undefined);
      if (path) await select(path);
    } finally {
      setBrowsing(false);
    }
  };

  return (
    <div className="relative">
      {open && <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-full border bg-card px-2.5 py-1 text-xs text-foreground shadow-sm transition-colors hover:bg-muted"
      >
        <XIcon className="size-3 text-muted-foreground/60" />
        <span className="max-w-40 truncate">
          {workspace ? workspaceLabel(workspace) : t("agent.noWorkspace")}
        </span>
        {isDefault && (
          <span className="rounded-sm bg-muted px-1 text-[9px] leading-4 text-muted-foreground">
            {t("agent.defaultBadge")}
          </span>
        )}
        <ChevronDownIcon className="size-3 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-2 w-80 overflow-hidden rounded-xl border bg-popover shadow-lg">
          <div className="border-b p-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("agent.searchWorkspace")}
              autoFocus
              className="h-8 border-none bg-transparent text-xs shadow-none focus-visible:ring-0"
            />
          </div>

          <div className="max-h-64 overflow-y-auto p-1">
            <button
              type="button"
              onClick={() => select(defaultWorkspace)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted"
            >
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">
                {defaultWorkspace ? workspaceLabel(defaultWorkspace) : t("agent.defaultWorkspace")}
                <span className="ml-1.5 text-[10px] text-muted-foreground/70">
                  {t("agent.defaultBadge")}
                </span>
              </span>
              {isDefault && <CheckIcon className="size-3.5 shrink-0 text-primary" />}
            </button>

            {visible.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => select(p)}
                title={p}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted"
              >
                <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{workspaceLabel(p)}</span>
                {!isDefault && p === workspace && (
                  <CheckIcon className="size-3.5 shrink-0 text-primary" />
                )}
              </button>
            ))}

            {visible.length === 0 && (
              <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                {t("agent.noRecentWorkspace")}
              </p>
            )}
          </div>

          <div className="border-t p-1">
            <button
              type="button"
              onClick={openFolder}
              disabled={browsing}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted disabled:opacity-60"
            >
              {browsing ? (
                <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
              ) : (
                <FolderOpenIcon className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              {t("agent.openFolder")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 可用工具清单：展开在输入框上方，收起时不占地方。 */
function ToolsPanel({ tools }: { tools: { name: string; label: string; description: string }[] }) {
  const t = useT();
  return (
    <div className="grid gap-1.5 rounded-2xl border bg-muted/30 p-2 md:grid-cols-2">
      {tools.map((tool) => (
        <div key={tool.name} className="rounded-lg border bg-background/60 px-2.5 py-1.5">
          <p className="text-xs font-medium">{tool.label}</p>
          <p className="text-[10px] leading-4 text-muted-foreground">{tool.description}</p>
        </div>
      ))}
      {tools.length === 0 && (
        <p className="px-1 py-2 text-center text-xs text-muted-foreground">{t("agent.noTools")}</p>
      )}
    </div>
  );
}

function AgentMessages({ conversationId }: { conversationId: number }) {
  const t = useT();
  const queryClient = useQueryClient();
  const activeMessages = useChatStore((s) => s.activeMessages);
  const streaming = useChatStore((s) => s.streaming);
  const events = useAgentStore((s) => s.events);
  const running = useAgentStore((s) => s.running);
  const mode = useAgentStore((s) => s.mode);
  const workspace = useAgentStore((s) => s.workspace);
  const workspaceIsDefault = useAgentStore((s) => s.workspaceIsDefault);

  const [input, setInput] = useState("");
  const [showTools, setShowTools] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [fileAttachments, setFileAttachments] = useState<FileAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const toolsQuery = useQuery({
    queryKey: ["agent-tools", mode],
    queryFn: () => rpcClient.listAgentTools({ mode }),
  });
  const tools = toolsQuery.data?.tools ?? [];

  // 默认工作区（~/.omnistudio/workspace），供选择面板展示。
  const defaultWorkspaceQuery = useQuery({
    queryKey: ["agent-workspace"],
    queryFn: () => rpcClient.getAgentWorkspace(undefined),
  });
  const defaultWorkspace = defaultWorkspaceQuery.data?.workspace ?? "";

  /** 选中工作区：写设置 + 同步 store。 */
  const applyWorkspace = useMutation({
    mutationFn: async (path: string) => {
      await rpcClient.updateSettings({ settings: { AGENT_WORKSPACE: path } });
      useAgentStore.getState().setWorkspace(path);
      useAgentStore.getState().setWorkspaceIsDefault(!path);
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  // 先登记当前会话，后到的 agentEvent 才会被 appendEvent 接收。
  useEffect(() => {
    useAgentStore.getState().setConversationId(conversationId);
  }, [conversationId]);

  const convQuery = useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: () => rpcClient.getConversation({ id: conversationId }),
  });

  const eventsQuery = useQuery({
    queryKey: ["agent-events", conversationId],
    queryFn: () => rpcClient.listAgentEvents({ conversationId }),
  });

  useEffect(() => {
    if (eventsQuery.data) useAgentStore.getState().setEvents(eventsQuery.data.events);
  }, [eventsQuery.data]);

  useEffect(() => {
    useChatStore.getState().setStreaming(false);
    useAgentStore.getState().setRunning(false);
    if (convQuery.data) useChatStore.getState().setActiveMessages(convQuery.data.messages);
  }, [conversationId, convQuery.data]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [
    activeMessages.length,
    activeMessages[activeMessages.length - 1]?.content,
    activeMessages[activeMessages.length - 1]?.reasoning,
    events.length,
  ]);

  const workspaceMutation = useMutation({
    mutationFn: async () => {
      const { path } = await rpcClient.openDirectoryDialog(undefined);
      if (!path) return null;
      await rpcClient.updateSettings({ settings: { AGENT_WORKSPACE: path } });
      useAgentStore.getState().setWorkspace(path);
      useAgentStore.getState().setWorkspaceIsDefault(false);
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      return path;
    },
  });

  /** 恢复默认工作区：清空设置里的自定义路径即可。 */
  const resetWorkspaceMutation = useMutation({
    mutationFn: async () => {
      await rpcClient.updateSettings({ settings: { AGENT_WORKSPACE: "" } });
      const { workspace } = await rpcClient.getAgentWorkspace(undefined);
      useAgentStore.getState().setWorkspace(workspace);
      useAgentStore.getState().setWorkspaceIsDefault(true);
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["agent-workspace"] });
    },
  });

  const modeMutation = useMutation({
    mutationFn: async (next: AgentMode) => {
      useAgentStore.getState().setMode(next);
      await rpcClient.updateSettings({ settings: { AGENT_MODE: next } });
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["agent-tools", next] });
    },
  });

  const sendMutation = useMutation({
    mutationFn: ({
      content,
      files,
      imagePaths,
    }: {
      content: string;
      files?: FileAttachment[];
      imagePaths?: string[];
    }) =>
      rpcClient.sendAgentMessage({
        conversationId,
        content,
        mode,
        workspace: workspace || undefined,
        files,
        imagePaths,
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
      // 后端直接返回失败（没模型 / 服务器没起来…）时不会走 chatDone，需要自己收尾。
      if (data && !data.ok) {
        useChatStore.getState().setStreaming(false);
        useAgentStore.getState().setRunning(false);
        useChatStore.getState().finalizeMessage(
          conversationId,
          Date.now(),
          `⚠️ ${data.error ?? t("agent.failed")}`,
        );
      }
    },
    onError: (err: unknown) => {
      useChatStore.getState().setStreaming(false);
      useAgentStore.getState().setRunning(false);
      useChatStore.getState().finalizeMessage(
        conversationId,
        Date.now(),
        `⚠️ ${err instanceof Error ? err.message : String(err)}`,
      );
    },
  });

  const stopMutation = useMutation({
    mutationFn: () => rpcClient.stopAgentRun({ conversationId }),
    onSuccess: () => {
      useAgentStore.getState().setRunning(false);
      useChatStore.getState().setStreaming(false);
    },
  });

  const autoResize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  };

  /** “+” 上传：按扩展名拆成图片与文本文件，分别走已有的暂存接口。 */
  const attachMutation = useMutation({
    mutationFn: async () => {
      const { paths } = await rpcClient.openFileDialog({
        allowedFileTypes: [...IMAGE_EXTS, ...TEXT_EXTS.split(",")].join(","),
      });
      if (paths.length === 0) return;

      const imagePaths = paths.filter((p) =>
        IMAGE_EXTS.includes(p.split(".").pop()?.toLowerCase() ?? ""),
      );
      const otherPaths = paths.filter((p) => !imagePaths.includes(p));

      if (imagePaths.length > 0) {
        const { images } = await rpcClient.stageChatImages({ conversationId, paths: imagePaths });
        setAttachments((prev) => [...prev, ...images]);
      }
      if (otherPaths.length > 0) {
        const { files } = await rpcClient.stageChatFiles({ conversationId, paths: otherPaths });
        setFileAttachments((prev) => {
          const known = new Set(prev.map((f) => f.name));
          return [...prev, ...files.filter((f) => !known.has(f.name))];
        });
      }
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

  const handleSend = () => {
    const content = input.trim();
    const images = attachments.map((a) => a.ref);
    const files = fileAttachments;
    if (!content && images.length === 0 && files.length === 0) return;
    if (running || streaming) return;
    setInput("");
    setAttachments([]);
    setFileAttachments([]);
    requestAnimationFrame(autoResize);
    const now = Date.now();
    useChatStore.getState().setActiveMessages([
      ...activeMessages,
      { id: now, conversationId, role: "user", content, images, createdAt: now },
    ]);
    useChatStore.getState().setStreaming(true);
    useAgentStore.getState().setRunning(true);
    sendMutation.mutate({ content, files, imagePaths: images });
  };

  /** 按 messageId 归组工具事件：tool_start 与随后的 tool_end 配对成一张卡片。 */
  const grouped = useMemo(() => {
    const map = new Map<number, { cards: { start: AgentEventRow; end?: AgentEventRow }[]; status: AgentEventRow[] }>();
    for (const event of events) {
      if (event.messageId == null) continue;
      const bucket = map.get(event.messageId) ?? { cards: [], status: [] };
      if (event.kind === "tool_start") {
        bucket.cards.push({ start: event });
      } else if (event.kind === "tool_end") {
        const last = bucket.cards[bucket.cards.length - 1];
        if (last && !last.end && last.start.toolName === event.toolName) last.end = event;
        else bucket.cards.push({ start: event, end: event });
      } else {
        bucket.status.push(event);
      }
      map.set(event.messageId, bucket);
    }
    return map;
  }, [events]);

  const hasMessages = activeMessages.length > 0;
  const canSend =
    (input.trim().length > 0 || attachments.length > 0 || fileAttachments.length > 0) &&
    !running &&
    !streaming;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-6">
          {!hasMessages ? (
            <div className="flex flex-col items-center justify-center gap-2 py-20 text-center">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <CircuitBoardIcon className="size-6" />
              </div>
              <p className="text-sm font-medium">{t("agent.startTitle")}</p>
              <p className="max-w-md text-xs text-muted-foreground">{t("agent.startHint")}</p>
            </div>
          ) : (
            activeMessages.map((m, index) => {
              const isLast = index === activeMessages.length - 1;
              const isStreamingMessage = (streaming || running) && isLast && m.role === "assistant";
              const bucket = grouped.get(m.id);

              if (m.role === "user") {
                return (
                  <div key={m.id} className="flex flex-col items-end">
                    <div className="max-w-[75%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-primary-foreground whitespace-pre-wrap">
                      {m.content}
                    </div>
                  </div>
                );
              }

              return (
                <div key={m.id} className="flex flex-col items-start">
                  <div className="flex w-full gap-3">
                    <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
                      <BotIcon className="size-4 text-muted-foreground" />
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      {bucket?.cards.map((card) => (
                        <ToolCallCard key={card.start.id} start={card.start} end={card.end} />
                      ))}
                      {bucket?.status.map((event) => (
                        <StatusLine key={event.id} event={event} />
                      ))}
                      {m.reasoning ? (
                        <ReasoningBlock reasoning={m.reasoning} streaming={isStreamingMessage} />
                      ) : null}
                      <div className="rounded-2xl rounded-tl-md border bg-card px-4 py-2.5">
                        {m.content ? (
                          <Markdown content={m.content} />
                        ) : isStreamingMessage ? (
                          <div className="flex items-center gap-2 py-1 text-sm text-muted-foreground">
                            <Loader2Icon className="size-3.5 animate-spin" />
                            {t("agent.working")}
                          </div>
                        ) : null}
                      </div>
                      <MessageActionBar
                        messageId={m.id}
                        conversationId={conversationId}
                        content={m.content}
                        isStreamingMessage={isStreamingMessage}
                      />
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="shrink-0 border-t bg-gradient-to-t from-muted/40 to-transparent p-4">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
          {showTools && <ToolsPanel tools={tools} />}

          {/* 工作区：输入框左上角外侧，点击向上弹出选择面板 */}
          <div className="flex items-center gap-2 px-1">
            <WorkspacePicker
              workspace={workspace}
              isDefault={workspaceIsDefault}
              defaultWorkspace={defaultWorkspace}
              onChange={(path) => applyWorkspace.mutate(path)}
            />
          </div>

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
              placeholder={t("agent.inputPlaceholder")}
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

            {/* 左下角：+ 上传 / 模式 / 工具；右下角：模型 + 发送/停止 */}
            <div className="flex items-center gap-1 px-2.5 pb-2.5">
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                tooltip={t("agent.attach")}
                onClick={() => attachMutation.mutate()}
                disabled={running || streaming || attachMutation.isPending}
              >
                {attachMutation.isPending ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <PlusIcon className="size-4" />
                )}
              </Button>
              <ModeSwitch
                mode={mode}
                disabled={running || streaming}
                onChange={(next) => modeMutation.mutate(next)}
              />
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs text-muted-foreground"
                aria-pressed={showTools}
                tooltip={t("agent.tools")}
                onClick={() => setShowTools((v) => !v)}
              >
                <WrenchIcon className="size-3.5" />
                <span className="tabular-nums">{tools.length}</span>
                <ChevronDownIcon
                  className={cn("size-3 transition-transform", showTools && "rotate-180")}
                />
              </Button>

              <div className="ml-auto flex min-w-0 items-center gap-1.5">
                <ModelPicker disabled={running || streaming} />
                {running ? (
                  <Button
                    variant="secondary"
                    size="icon-lg"
                    className="shrink-0 rounded-full"
                    tooltip={t("agent.stop")}
                    onClick={() => stopMutation.mutate()}
                    disabled={stopMutation.isPending}
                  >
                    <SquareIcon className="size-3.5" />
                  </Button>
                ) : (
                  <Button
                    variant="default"
                    size="icon-lg"
                    className="shrink-0 rounded-full"
                    tooltip={`${t("agent.send")} · ${t("chat.enterHint")}`}
                    onClick={handleSend}
                    disabled={!canSend || sendMutation.isPending}
                  >
                    {sendMutation.isPending ? (
                      <Loader2Icon className="size-4 animate-spin" />
                    ) : (
                      <ArrowUpIcon className="size-4" />
                    )}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AgentWindow() {
  const t = useT();
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const activeApp = useAppStore((s) => s.activeApp);
  const queryClient = useQueryClient();

  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });

  // 未指定工作区时向后端要默认的（~/.omnistudio/workspace，不存在会自动创建）。
  const defaultWorkspaceQuery = useQuery({
    queryKey: ["agent-workspace"],
    queryFn: () => rpcClient.getAgentWorkspace(undefined),
  });

  // 模式 / 工作区持久化在设置里，首次进入时同步到 store。
  useEffect(() => {
    const settings = settingsData?.settings;
    if (!settings) return;
    const nextMode = settings.AGENT_MODE as AgentMode;
    if (MODES.includes(nextMode)) useAgentStore.getState().setMode(nextMode);
    const configured = (settings.AGENT_WORKSPACE ?? "").trim();
    useAgentStore.getState().setWorkspace(
      configured || defaultWorkspaceQuery.data?.workspace || "",
    );
    useAgentStore.getState().setWorkspaceIsDefault(!configured);
  }, [settingsData, defaultWorkspaceQuery.data]);

  const createMutation = useMutation({
    mutationFn: () => rpcClient.createConversation({ app: activeApp }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      useChatStore.getState().upsertConversation(data.conversation);
      useChatStore.getState().setActiveConversation(data.conversation.id);
      useChatStore.getState().setActiveMessages([]);
      useChatStore.getState().setStreaming(false);
      useAgentStore.getState().setEvents([]);
    },
  });

  const conversationsQuery = useQuery({
    queryKey: ["conversations", activeApp],
    queryFn: () => rpcClient.listConversations({ app: activeApp }),
  });

  // 与对话一致：优先复用一个空会话，避免反复进入累积空白 session。
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
        <AgentMessages conversationId={activeConversationId} />
      ) : (
        <div className="flex flex-1 items-center justify-center">
          {createMutation.isPending ? (
            <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
          ) : (
            <div className="flex flex-col items-center gap-2 text-center">
              <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <CircuitBoardIcon className="size-7" />
              </div>
              <p className="text-sm font-medium">{t("agent.placeholder")}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
