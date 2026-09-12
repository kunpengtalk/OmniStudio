import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpIcon,
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
  CheckIcon,
  PanelRightIcon,
  ShieldCheckIcon,
  MessageSquarePlusIcon,
  SendIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Textarea } from "@ui/textarea";
import { ModelPicker } from "@components/model-picker";
import { AgentSessionSidebar } from "./agent/session-sidebar";
import { AgentTodoPanel } from "./agent/todo-panel";
import { AgentQueuePanel } from "./agent/queue-panel";
import { AgentRightPanel } from "./agent/right-panel";
import { AgentAssistantMessage, AgentUserMessage } from "./agent/message";
import {
  ComposerSuggestions,
  SLASH_COMMANDS,
  type SlashCommandId,
} from "./agent/composer-suggestions";
import {
  AgentAutomationsView,
  AgentPluginsView,
  AgentSearchView,
  AgentSkillsView,
} from "./agent/agent-views";
import { useChatStore } from "@stores/chat";
import { useAgentStore } from "@stores/agent";
import { useAppStore } from "@stores/app";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import type { ArtifactItem } from "../../bun/agent-artifacts";
import type { AgentMode } from "../../bun/agent";

const MODES: AgentMode[] = ["agent", "plan", "goal"];

type Attachment = { ref: string; url: string };
type FileAttachment = { name: string; content: string };

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];
const TEXT_EXTS =
  "txt,md,markdown,json,csv,tsv,log,xml,yml,yaml,html,htm,js,jsx,ts,tsx,mjs,cjs,css,scss,less,py,rb,rs,go,java,kt,swift,c,h,cpp,hpp,cs,php,sh,bash,zsh,toml,ini,cfg,conf,sql,vue,svelte,graphql,proto";

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

  /**
   * 选中工作区：写到当前会话（会话级工作区，同一份会话列表可以横跨多个项目）。
   * 空路径 = 恢复跟随全局设置。
   */
  const applyWorkspace = useMutation({
    mutationFn: async (path: string) => {
      // 选中「默认工作区」= 跟随全局设置（写 null），而不是把当时的默认路径钉在这个会话上：
      // 否则以后改全局默认，老会话不会跟着走。
      const followsGlobal = !path || path === defaultWorkspace;
      const result = await rpcClient.setAgentSessionWorkspace({
        conversationId,
        workspace: followsGlobal ? null : path,
      });
      useAgentStore.getState().setWorkspace(result.workspace);
      useAgentStore.getState().setWorkspaceIsDefault(followsGlobal);
      queryClient.invalidateQueries({ queryKey: ["agent-sessions"] });
      queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
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

  // 打开会话时恢复上下文：待办清单、产出物、以及还挂着等的授权 / 提问。
  const interactionsQuery = useQuery({
    queryKey: ["agent-interactions", conversationId],
    queryFn: () => rpcClient.listAgentInteractions({ conversationId }),
  });
  const todosQuery = useQuery({
    queryKey: ["agent-todos", conversationId],
    queryFn: () => rpcClient.listAgentTodos({ conversationId }),
  });
  const artifactsQuery = useQuery({
    queryKey: ["agent-artifacts", conversationId],
    queryFn: () => rpcClient.listAgentArtifacts({ conversationId }),
  });

  useEffect(() => {
    const store = useAgentStore.getState();
    if (interactionsQuery.data) {
      store.setPermissions(interactionsQuery.data.permissions);
      store.setQuestions(interactionsQuery.data.questions);
    }
    if (todosQuery.data) store.setTodos(todosQuery.data.todos);
    if (artifactsQuery.data) store.setArtifacts(artifactsQuery.data.artifacts);
  }, [interactionsQuery.data, todosQuery.data, artifactsQuery.data]);

  // 会话自己的工作区（没设过就跟随全局）。
  useEffect(() => {
    const sessionWorkspace = convQuery.data?.conversation?.workspace ?? "";
    if (sessionWorkspace) {
      useAgentStore.getState().setWorkspace(sessionWorkspace);
      useAgentStore.getState().setWorkspaceIsDefault(false);
    }
  }, [convQuery.data]);

  // 切换会话：清掉上一个会话的运行态。
  useEffect(() => {
    useChatStore.getState().setStreaming(false);
    useAgentStore.getState().setRunning(false);
  }, [conversationId]);

  // 服务端消息合并（不是整体替换）：正在流式的正文不会被服务端那份空内容覆盖。
  useEffect(() => {
    if (convQuery.data) useChatStore.getState().mergeServerMessages(convQuery.data.messages);
  }, [convQuery.data]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [
    activeMessages.length,
    activeMessages[activeMessages.length - 1]?.content,
    activeMessages[activeMessages.length - 1]?.reasoning,
    events.length,
  ]);

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

  /** 执行输入框里的斜杠命令（选完就清空输入，命令本身不发给模型）。 */
  const runSlashCommand = (id: SlashCommandId) => {
    setInput("");
    requestAnimationFrame(autoResize);
    if (id === "new") {
      useChatStore.getState().setActiveConversation(null);
      return;
    }
    if (id === "tools") {
      setShowTools((v) => !v);
      return;
    }
    if (id === "clear") {
      useAgentStore.getState().clear();
      return;
    }
    if (id === "help") {
      setShowTools(true);
      return;
    }
    modeMutation.mutate(id);
  };

  /** 选中 @ 提及的文件：把 @fragment 换成相对路径（带引号，方便直接读）。 */
  const insertMention = (path: string) => {
    setInput((prev) => prev.replace(/@([^\s@]*)$/, `@"${path}" `));
    requestAnimationFrame(autoResize);
  };

  /** 运行中继续发消息：默认排队，Cmd/Ctrl+Enter 立即插话。 */
  const queueMutation = useMutation({
    mutationFn: (mode: "steer" | "queue") =>
      rpcClient.followUpAgentMessage({ conversationId, content: input.trim(), mode }),
    onSuccess: (_data, mode) => {
      setInput("");
      requestAnimationFrame(autoResize);
      queryClient.invalidateQueries({ queryKey: ["agent-queue", conversationId] });
      if (mode === "steer") queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
    },
  });

  const handleSend = (mode: "send" | "queue" | "steer" = "send") => {
    const content = input.trim();
    const images = attachments.map((a) => a.ref);
    const files = fileAttachments;
    if (!content && images.length === 0 && files.length === 0) return;
    // 运行中：不打断当前回合，按选择排队或插话。
    if (running || streaming) {
      if (!content) return;
      queueMutation.mutate(mode === "steer" ? "steer" : "queue");
      return;
    }
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

  /** 事件按所属消息预分组：原来在 messages.map 里逐个 filter 事件，消息一多就是 O(n×m)。 */
  const eventsByMessage = useMemo(() => {
    const map = new Map<number, typeof events>();
    for (const event of events) {
      if (event.messageId == null) continue;
      const bucket = map.get(event.messageId);
      if (bucket) bucket.push(event);
      else map.set(event.messageId, [event]);
    }
    return map;
  }, [events]);

  /** 产出物按所属消息预分组（消息里的文件卡片 + 「打开」进右侧预览）。 */
  const artifacts = useAgentStore((s) => s.artifacts);
  const artifactsByMessage = useMemo(() => {
    const map = new Map<number, ArtifactItem[]>();
    for (const artifact of artifacts) {
      if (artifact.messageId == null) continue;
      const bucket = map.get(artifact.messageId);
      if (bucket) bucket.push(artifact);
      else map.set(artifact.messageId, [artifact]);
    }
    return map;
  }, [artifacts]);

  const openArtifact = (artifact: ArtifactItem) => {
    useAgentStore.getState().setPreview({ source: "artifact", artifactId: artifact.id });
  };

  const hasMessages = activeMessages.length > 0;
  const canSend =
    (input.trim().length > 0 || attachments.length > 0 || fileAttachments.length > 0) &&
    !running &&
    !streaming;

  const sessionTitle = convQuery.data?.conversation?.title ?? t("agent.title");
  const panelOpen = useAgentStore((s) => s.panelOpen);
  const permissions = useAgentStore((s) => s.permissions);
  const questions = useAgentStore((s) => s.questions);
  const waitingCount = permissions.length + questions.length;

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {/* 会话头部：标题 / 工作区 / 待办进度 / 面板开关（对齐 OpenWork 的 session header） */}
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <span className="min-w-0 max-w-64 truncate text-xs font-medium">{sessionTitle}</span>
        <span className="hidden min-w-0 items-center gap-1 text-[10px] text-muted-foreground sm:flex">
          <FolderIcon className="size-3" />
          <span className="max-w-40 truncate">{workspaceLabel(workspace)}</span>
        </span>
        {waitingCount > 0 && (
          <span className="flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-400">
            <ShieldCheckIcon className="size-3" />
            {t("agent.waitingApproval")}
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn("text-muted-foreground", panelOpen && "bg-muted text-foreground")}
            tooltip={t("agent.panel.toggle")}
            onClick={() => useAgentStore.getState().setPanelOpen(!panelOpen)}
          >
            <PanelRightIcon className="size-4" />
          </Button>
        </div>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-6">
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

              if (m.role === "user") {
                return <AgentUserMessage key={m.id} message={m} />;
              }

              return (
                <AgentAssistantMessage
                  key={m.id}
                  message={m}
                  conversationId={conversationId}
                  events={eventsByMessage.get(m.id) ?? []}
                  artifacts={artifactsByMessage.get(m.id) ?? []}
                  streaming={isStreamingMessage}
                  onOpenArtifact={openArtifact}
                />
              );
            })
          )}
        </div>
      </div>

      <div className="shrink-0 border-t bg-gradient-to-t from-muted/40 to-transparent p-4">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
          <AgentQueuePanel conversationId={conversationId} />
          <AgentTodoPanel />
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

            <div className="relative">
              <ComposerSuggestions
                input={input}
                workspace={workspace}
                onPickCommand={runSlashCommand}
                onPickFile={insertMention}
              />
            <Textarea
              ref={textareaRef}
              placeholder={running ? t("agent.queue.placeholder") : t("agent.inputPlaceholder")}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                autoResize();
              }}
              onKeyDown={(e) => {
                // 补全面板打开时，回车先给"选中命令"用（这里只在输入是纯命令时触发）。
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  // 运行中时 Cmd/Ctrl+Enter = 立即插话，单独 Enter = 排队等本轮结束。
                  if (running || streaming) {
                    handleSend(e.metaKey || e.ctrlKey ? "steer" : "queue");
                    return;
                  }
                  const slash = /^\/([a-z]+)\s*$/i.exec(input);
                  if (slash) {
                    const match = SLASH_COMMANDS.find(
                      (command) => command.command === slash[1]!.toLowerCase(),
                    );
                    if (match) {
                      runSlashCommand(match.id);
                      return;
                    }
                  }
                  handleSend();
                }
              }}
              className="max-h-56 min-h-16 resize-none border-none bg-transparent px-4 pt-3.5 text-[0.9rem] shadow-none focus-visible:ring-0 dark:bg-transparent"
              rows={2}
            />
            </div>

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
                  <>
                    <Button
                      variant="outline"
                      size="icon-lg"
                      className="shrink-0 rounded-full"
                      tooltip={t("agent.queue.send")}
                      onClick={() => handleSend("queue")}
                      disabled={!input.trim() || queueMutation.isPending}
                    >
                      <SendIcon className="size-3.5" />
                    </Button>
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
                  </>
                ) : (
                  <Button
                    variant="default"
                    size="icon-lg"
                    className="shrink-0 rounded-full"
                    tooltip={`${t("agent.send")} · ${t("chat.enterHint")}`}
                    onClick={() => handleSend()}
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
  void activeApp;

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

  // 侧栏「搜索 / 自动化 / 插件 / Skills」把主区域切换成对应视图，对话本身让位。
  const subView = useAgentStore((s) => s.subView);

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {/* 左：新建任务 + 四个入口 + 会话列表（置顶 / 归档 / 工作区分组） */}
      <AgentSessionSidebar activeConversationId={activeConversationId} />
      {subView === "search" ? (
        <AgentSearchView />
      ) : subView === "automations" ? (
        <AgentAutomationsView />
      ) : subView === "plugins" ? (
        <AgentPluginsView />
      ) : subView === "skills" ? (
        <AgentSkillsView />
      ) : activeConversationId ? (
        <>
          <AgentMessages conversationId={activeConversationId} />
          {/* 右：多页签面板（产出物 / 审查 / 文件 / 终端 / 浏览器 + 预览） */}
          <AgentRightPanel conversationId={activeConversationId} />
        </>
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
              <Button
                variant="secondary"
                size="sm"
                className="mt-1 gap-1.5 text-xs"
                onClick={() => createMutation.mutate()}
              >
                <MessageSquarePlusIcon className="size-3.5" />
                {t("agent.session.new")}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
