import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronUpIcon,
  CornerDownLeftIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  Loader2Icon,
  PlusIcon,
  SendHorizontalIcon,
  SquareIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { isRemoteClient } from "@lib/remote";
import { parseWorkspaceRecents, withRecentWorkspace, workspaceLabel } from "@lib/workspace";
import { useChatStore } from "@stores/chat";
import { useAgentStore } from "@stores/agent";
import { useT } from "@stores/ui-lang";
import { PiTip } from "./pi-tip";
import { activateNewSession } from "./new-session";
import { ContextInspector, ModeChip, ModelThinkingPicker, PermissionChip, useApprovalMode } from "./composer-controls";
import {
  ComposerSuggestions,
  SLASH_COMMANDS,
  type SlashCommandId,
} from "./composer-suggestions";
import { AgentQueuePanel } from "./queue-panel";
import { AgentPlanCard } from "./plan-card";
import { AgentGoalPanel } from "./goal-panel";
import { AgentTodoPanel } from "./todo-panel";
import { SessionStatusPanel } from "./session-status-panel";
import type { AgentMode } from "../../../bun/agent";

type Attachment = { ref: string; url: string };
type FileAttachment = { name: string; content: string };

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];
const TEXT_EXTS =
  "txt,md,markdown,json,csv,tsv,log,xml,yml,yaml,html,htm,js,jsx,ts,tsx,mjs,cjs,css,scss,less,py,rb,rs,go,java,kt,swift,c,h,cpp,hpp,cs,php,sh,bash,zsh,toml,ini,cfg,conf,sql,vue,svelte,graphql,proto";

/**
 * 工作区选择：输入框左上角外侧的 chip，点开向上弹面板（搜索 + 最近 + 打开文件夹）。
 *
 * **换工作区 = 换会话**：工作区是会话级属性（`conversations.workspace`），一条会话里
 * 前半程在 A 目录、后半程在 B 目录，历史里读过的文件与改过的路径会串起来，模型接着
 * 那些内容干活就会乱。所以这里不"改挂"当前会话，而是在目标目录里开一条新会话并切过去，
 * 原会话留在原来的工作区；只有当前会话还是空白（一条消息都没有）时才就地改挂 ——
 * 那种情况下没有历史可串，也就没理由再攒下一条"新任务"。
 *
 * 打开文件夹的对话框也走同一条路：选完目录 = 在那里面开一条新会话。
 */
export function WorkspacePicker({ conversationId }: { conversationId: number }) {
  const t = useT();
  const queryClient = useQueryClient();
  const workspace = useAgentStore((s) => s.workspace);
  const isDefault = useAgentStore((s) => s.workspaceIsDefault);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [browsing, setBrowsing] = useState(false);

  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  const defaultWorkspaceQuery = useQuery({
    queryKey: ["agent-workspace"],
    queryFn: () => rpcClient.getAgentWorkspace(undefined),
  });
  const defaultWorkspace = defaultWorkspaceQuery.data?.workspace ?? "";

  // 当前会话聊过没有：与 AgentConversation 共用同一份查询（同 key，不会多打一次 RPC）。
  const convQuery = useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: () => rpcClient.getConversation({ id: conversationId }),
  });
  // 没取回来时按"有内容"处理：宁可多开一条会话，也不要把可能是别人的历史搬过去。
  const currentEmpty = convQuery.data ? (convQuery.data.messages?.length ?? 0) === 0 : false;

  const recents = useMemo(
    () => parseWorkspaceRecents(settingsData?.settings?.AGENT_WORKSPACES),
    [settingsData],
  );

  const keyword = query.trim().toLowerCase();
  const visible = recents.filter(
    (p) => !keyword || workspaceLabel(p).toLowerCase().includes(keyword) || p.toLowerCase().includes(keyword),
  );

  /** 记住最近工作区：与侧栏的「打开工作区」共用一份设置，两边互相看得见。 */
  const rememberWorkspace = async (path: string) => {
    const next = withRecentWorkspace(recents, path);
    await rpcClient.updateSettings({ settings: { AGENT_WORKSPACES: JSON.stringify(next) } });
  };

  const applyMutation = useMutation({
    mutationFn: async (path: string) => {
      // 选「默认工作区」= 跟随全局设置（写 null），而不是把当时的默认路径钉死：
      // 否则以后改全局默认，这个老会话不会跟着走。
      const followsGlobal = !path || path === defaultWorkspace;
      const target = followsGlobal ? null : path;
      // 已经在这个工作区里了：关掉菜单即可，既不新建也不改动。
      if (followsGlobal ? isDefault : path === workspace) return { kind: "unchanged" } as const;

      if (target) await rememberWorkspace(target);

      if (!currentEmpty) {
        const { session } = await rpcClient.createAgentSession(target ? { workspace: target } : {});
        return { kind: "new-session", session } as const;
      }
      const result = await rpcClient.setAgentSessionWorkspace({ conversationId, workspace: target });
      return { kind: "rebound", workspace: result.workspace, followsGlobal } as const;
    },
    onSuccess: (result) => {
      if (result.kind === "new-session") {
        activateNewSession(queryClient, result.session, defaultWorkspace);
      } else if (result.kind === "rebound") {
        useAgentStore.getState().setWorkspace(result.workspace);
        useAgentStore.getState().setWorkspaceIsDefault(result.followsGlobal);
        queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
        queryClient.invalidateQueries({ queryKey: ["agent-sessions"] });
      }
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      setOpen(false);
      setQuery("");
    },
  });

  const openFolder = async () => {
    setBrowsing(true);
    try {
      const { path } = await rpcClient.openDirectoryDialog(undefined);
      if (path) applyMutation.mutate(path);
    } finally {
      setBrowsing(false);
    }
  };

  return (
    <div className="composer-workspace" style={{ position: "relative" }}>
      <button
        type="button"
        className="composer-ws-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        title={workspace}
        onClick={() => setOpen((v) => !v)}
      >
        <FolderIcon size={12} aria-hidden />
        <span className="composer-ws-name">
          {workspace ? workspaceLabel(workspace) : t("agent.noWorkspace")}
        </span>
        {isDefault ? <span className="composer-ws-badge">{t("agent.defaultBadge")}</span> : null}
        <ChevronUpIcon size={12} aria-hidden />
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="pi-menu"
            style={{ left: 0, bottom: "calc(100% + 6px)", width: "min(320px, calc(100vw - 24px))" }}
          >
            <label className="pi-menu-search">
              <FolderIcon size={13} aria-hidden />
              <input
                autoFocus
                value={query}
                placeholder={t("agent.searchWorkspace")}
                aria-label={t("agent.searchWorkspace")}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="pi-menu-scroll" style={{ maxHeight: 256 }}>
              <button
                type="button"
                className={`pi-menu-item${isDefault ? " active" : ""}`}
                onClick={() => applyMutation.mutate(defaultWorkspace)}
              >
                <FolderIcon size={14} aria-hidden style={{ flex: "none" }} />
                <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {defaultWorkspace ? workspaceLabel(defaultWorkspace) : t("agent.defaultWorkspace")}
                  <span className="composer-ws-badge" style={{ marginLeft: 6 }}>
                    {t("agent.defaultBadge")}
                  </span>
                </span>
                {isDefault ? <CheckIcon size={13} className="pi-menu-check" /> : null}
              </button>

              {visible.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`pi-menu-item${!isDefault && p === workspace ? " active" : ""}`}
                  title={p}
                  onClick={() => applyMutation.mutate(p)}
                >
                  <FolderIcon size={14} aria-hidden style={{ flex: "none" }} />
                  <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {workspaceLabel(p)}
                  </span>
                  {!isDefault && p === workspace ? <CheckIcon size={13} className="pi-menu-check" /> : null}
                </button>
              ))}

              {visible.length === 0 ? (
                <p className="pi-menu-empty">{t("agent.noRecentWorkspace")}</p>
              ) : null}
            </div>
            <div className="pi-menu-sep" />
            {/* 「浏览…」要开宿主机的目录选择框：网页端没有这条通道，只留上面那份工作区列表。 */}
            {!isRemoteClient() && (
              <button type="button" className="pi-menu-item" disabled={browsing} onClick={() => void openFolder()}>
                {browsing ? (
                  <Loader2Icon size={14} className="animate-spin" aria-hidden style={{ flex: "none" }} />
                ) : (
                  <FolderOpenIcon size={14} aria-hidden style={{ flex: "none" }} />
                )}
                {t("agent.openFolder")}
              </button>
            )}
            {/* 换目录 = 开新会话，这条不写出来就会被当成"把当前会话搬过去" */}
            <p className="pi-menu-heading">{t("agent.workspaceSwitchHint")}</p>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** 可用工具清单：展开在输入框上方，收起时不占地方。 */
function ToolsPanel() {
  const t = useT();
  const mode = useAgentStore((s) => s.mode);
  const { data } = useQuery({
    queryKey: ["agent-tools", mode],
    queryFn: () => rpcClient.listAgentTools({ mode }),
  });
  const tools = data?.tools ?? [];
  return (
    <div className="composer-panel">
      <div className="composer-panel-title">
        <WrenchIcon size={13} aria-hidden />
        {t("agent.tools")}
        <span className="tool-group-count">{tools.length}</span>
      </div>
      <div style={{ display: "grid", gap: 2, marginTop: 6 }}>
        {tools.map((tool) => (
          <div key={tool.name} className="composer-panel-row">
            <span className="composer-panel-name" title={tool.label}>
              {tool.label}
            </span>
            <span className="composer-panel-desc" title={tool.description}>
              {tool.description}
            </span>
          </div>
        ))}
        {tools.length === 0 ? <p className="pi-menu-empty">{t("agent.noTools")}</p> : null}
      </div>
    </div>
  );
}

/**
 * Agent 输入区。
 *
 * 结构对齐参考实现：一个圆角大面板（无描边、靠投影抬起），上半是输入框、下半是
 * 工具条；工具条左边是「加附件 / 目标模式 / 工具授权」，右边是「上下文占用 /
 * 模型与推理等级 / 发送」。所有会改「这一轮怎么跑」的开关都在这里，用户不必为了
 * 换授权模式去翻设置页。
 */
export function AgentComposer({
  conversationId,
  mode,
}: {
  conversationId: number;
  mode: AgentMode;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const activeMessages = useChatStore((s) => s.activeMessages);
  const streaming = useChatStore((s) => s.streaming);
  const running = useAgentStore((s) => s.running);
  const workspace = useAgentStore((s) => s.workspace);
  const compactNotice = useAgentStore((s) => s.compactNotice);
  const modelNotice = useAgentStore((s) => s.modelNotice);
  const { mode: approvalMode } = useApprovalMode();

  const [input, setInput] = useState("");
  const [showTools, setShowTools] = useState(false);
  const [showStatus, setShowStatus] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [fileAttachments, setFileAttachments] = useState<FileAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const autoResize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  };

  const busy = running || streaming;
  const canSend =
    (input.trim().length > 0 || attachments.length > 0 || fileAttachments.length > 0) && !busy;

  const compactMutation = useMutation({
    mutationFn: () => rpcClient.compactAgentConversation({ conversationId }),
    onSuccess: (data) => {
      useAgentStore.getState().setCompactNotice(
        data.dropped > 0
          ? t("agent.compact.done", {
              dropped: String(data.dropped),
              before: String(data.tokensBefore),
              after: String(data.tokensAfter),
            })
          : (data.reason ?? t("agent.compact.none")),
      );
      queryClient.invalidateQueries({ queryKey: ["agent-context-usage", conversationId] });
      queryClient.invalidateQueries({ queryKey: ["agent-events", conversationId] });
    },
    onError: (error: unknown) => useAgentStore.getState().setCompactNotice(String(error)),
  });

  /**
   * `/model` 选中后的切换：与工具条上的模型选择器走**同一条** RPC，
   * 所以「本地 / 云端 + 厂商」的解析规则完全一致。
   */
  const switchModelMutation = useMutation({
    mutationFn: (option: { type: "local" | "api"; value: string; providerId?: string }) =>
      rpcClient.selectChatModel(option),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["chat-models"] });
      useAgentStore
        .getState()
        .setModelNotice(data && !data.ok ? (data.error ?? t("chat.modelSwitchFailed")) : null);
    },
    onError: (error: unknown) => useAgentStore.getState().setModelNotice(String(error)),
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
      // 本轮的开工快照是刚建的：取回来，「撤销本轮」才会出现在这条消息上。
      queryClient.invalidateQueries({ queryKey: ["agent-snapshots", conversationId] });
      // 后端直接返回失败（没模型 / 服务器没起来…）：这些路径后端也会推一条带 error 的
      // chatDone，所以这里用**幂等**的兜底 —— 已经有落点就不再补，否则界面上会出现
      // 两个内容相同的 ⚠️ 气泡。
      if (data && !data.ok) {
        useChatStore.getState().setStreaming(false);
        useAgentStore.getState().setRunning(false);
        useChatStore
          .getState()
          .finalizeTurnIfPending(conversationId, `⚠️ ${data.error ?? t("agent.failed")}`);
      }
    },
    onError: (error: unknown) => {
      useChatStore.getState().setStreaming(false);
      useAgentStore.getState().setRunning(false);
      useChatStore
        .getState()
        .finalizeTurnIfPending(
          conversationId,
          `⚠️ ${error instanceof Error ? error.message : String(error)}`,
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

  /** 「+」上传：按扩展名拆成图片与文本文件，分别走已有的暂存接口。 */
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
      // 清理失败不影响发送：图已经不在待发列表里了。
    }
  };

  /** 运行中继续发消息：默认排队，Cmd/Ctrl+Enter 立即插话。 */
  const queueMutation = useMutation({
    mutationFn: (queueMode: "steer" | "queue") =>
      rpcClient.followUpAgentMessage({ conversationId, content: input.trim(), mode: queueMode }),
    onSuccess: (_data, queueMode) => {
      setInput("");
      requestAnimationFrame(autoResize);
      queryClient.invalidateQueries({ queryKey: ["agent-queue", conversationId] });
      if (queueMode === "steer") {
        queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
      }
    },
  });

  /** `override` 给斜杠命令用（例如 /init 直接把预置提示词发出去，不经过输入框）。 */
  const handleSend = (sendMode: "send" | "queue" | "steer" = "send", override?: string) => {
    const content = (override ?? input).trim();
    const images = attachments.map((a) => a.ref);
    const files = fileAttachments;
    if (!content && images.length === 0 && files.length === 0) return;

    // 运行中：不打断当前回合，按选择排队或插话。
    if (busy) {
      if (!content) return;
      queueMutation.mutate(sendMode === "steer" ? "steer" : "queue");
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

  /** 选中 @ 提及的文件：把 @fragment 换成相对路径（带引号，方便直接读）。 */
  const insertMention = (path: string) => {
    setInput((prev) => prev.replace(/@([^\s@]*)$/, `@"${path}" `));
    requestAnimationFrame(autoResize);
  };

  /** 执行输入框里的斜杠命令（选完就清空输入，命令本身不发给模型）。 */
  const runSlashCommand = (id: SlashCommandId, args?: string) => {
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
    if (id === "init") {
      // 对齐 Codex 的 /init：让它先摸清项目，再落一份 AGENTS.md（下一轮起自动注入系统提示）。
      handleSend("send", t("agent.slash.init.prompt"));
      return;
    }
    if (id === "doctor") {
      // 排障技能的入口：技能正文由模型自己 read_skill 取（渐进披露），这里只给任务书；
      // 命令后面的那段话是用户描述的现象，原样带下去，别让他再打一遍。
      const prompt = t("agent.slash.doctor.prompt");
      handleSend("send", args ? `${prompt}\n\n${t("agent.slash.doctor.symptom")}${args}` : prompt);
      return;
    }
    if (id === "compact") {
      compactMutation.mutate();
      return;
    }
    if (id === "status") {
      setShowStatus((v) => !v);
      return;
    }
    if (id === "model") {
      // 走到这里说明补全面板已经关掉了（手敲命令后按了 Esc）：把输入补成 `/model ` 再弹一次。
      setInput("/model ");
      requestAnimationFrame(autoResize);
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

  /**
   * 输入正好是一条斜杠命令时执行它，返回是否命中。
   *
   * 回车与发送按钮**共用**这一条判定：只给回车接斜杠分支的话，敲完 `/goal` 去点发送
   * 按钮就变成把 "/goal" 当消息发给模型了 —— 用户看到的就是"命令执行了但没生效"。
   *
   * 命令名允许连字符（`/omni-doctor`）；带参数的形式只有声明了 `takesArgs` 的命令才吃，
   * 其余（如 `/goal 开始干活`）仍然按普通消息发出去，不静默吞话。
   */
  const runSlashIfExact = (text: string): boolean => {
    const parsed = /^\/([a-z0-9-]+)(?:\s+(.*))?$/i.exec(text.trim());
    if (!parsed) return false;
    const match = SLASH_COMMANDS.find((command) => command.command === parsed[1]!.toLowerCase());
    if (!match) return false;
    const args = parsed[2]?.trim();
    if (args && !match.takesArgs) return false;
    runSlashCommand(match.id, args || undefined);
    return true;
  };

  // 补全面板打开时回车归它用，这里只处理「输入正好是纯命令」的情况。
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    if (busy) {
      handleSend(event.metaKey || event.ctrlKey ? "steer" : "queue");
      return;
    }
    if (runSlashIfExact(input)) return;
    handleSend();
  };

  useEffect(() => {
    autoResize();
  }, [input]);

  /**
   * 把输入区（含它上面的待办 / 方案 / 目标面板）的实测高度写回 `--pi-dock-h`。
   *
   * 消息流底部要按这个值留白，否则最后一条消息会被输入区盖住 —— 而这个高度是变的：
   * 待办面板一出现就能多出近百像素。用常量顶替必然在某一种组合下露馅。
   */
  const stackRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stackRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const publish = () => {
      const host = el.closest(".pi-main");
      if (!host) return;
      (host as HTMLElement).style.setProperty("--pi-dock-h", `${Math.round(el.offsetHeight)}px`);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    return () => {
      observer.disconnect();
      (el.closest(".pi-main") as HTMLElement | null)?.style.removeProperty("--pi-dock-h");
    };
  }, []);

  return (
    <div className="composer-dock">
      <div className="composer-stack" ref={stackRef}>
        {/* 卡片区单独成一个滚动容器：卡片总高封顶，输入框和消息流才不会被顶出屏幕。 */}
        <div className="composer-stack-panels">
          <AgentQueuePanel conversationId={conversationId} />
          {/* 方案批准摆最上面：它是要用户先做决定的事，别的都是进度展示。 */}
          <AgentPlanCard conversationId={conversationId} />
          <AgentGoalPanel conversationId={conversationId} />
          <AgentTodoPanel />
          {showTools ? <ToolsPanel /> : null}
          {showStatus ? (
            <div className="composer-panel">
              <SessionStatusPanel conversationId={conversationId} />
            </div>
          ) : null}

          {(compactNotice || modelNotice) && (
            <div className="composer-panel" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {modelNotice ? (
                <>
                  <AlertTriangleIcon size={13} aria-hidden style={{ color: "var(--ds-error)", flex: "none" }} />
                  <span style={{ color: "var(--ds-error)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {modelNotice}
                  </span>
                </>
              ) : (
                <span style={{ color: "var(--ds-text-muted)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {compactNotice}
                </span>
              )}
            </div>
          )}
        </div>

        <WorkspacePicker conversationId={conversationId} />

        <div className="composer-shell">
          {attachments.length > 0 || fileAttachments.length > 0 ? (
            <div className="composer-chips">
              {attachments.map((attachment) => (
                <div key={attachment.ref} className="composer-chip composer-chip-img">
                  <img src={attachment.url} alt="" />
                  <button
                    type="button"
                    className="composer-chip-x"
                    title={t("chat.removeAttachment")}
                    onClick={() => void removeAttachment(attachment)}
                  >
                    <XIcon size={11} aria-hidden />
                  </button>
                </div>
              ))}
              {fileAttachments.map((file) => (
                <div key={file.name} className="composer-chip">
                  <FileTextIcon size={13} aria-hidden style={{ flex: "none", color: "var(--ds-text-muted)" }} />
                  <span className="composer-chip-name">{file.name}</span>
                  <button
                    type="button"
                    className="composer-chip-x"
                    title={t("chat.removeAttachment")}
                    onClick={() => setFileAttachments((prev) => prev.filter((x) => x.name !== file.name))}
                  >
                    <XIcon size={11} aria-hidden />
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          <div className="composer-input-wrap">
            <ComposerSuggestions
              input={input}
              workspace={workspace}
              onPickCommand={runSlashCommand}
              onPickModel={(option) => {
                setInput("");
                requestAnimationFrame(autoResize);
                if (option.isActive) return; // 已经是当前模型：回车 = 不换
                switchModelMutation.mutate({
                  type: option.type,
                  value: option.value,
                  providerId: option.providerId,
                });
              }}
              onPickFile={insertMention}
            />
            <textarea
              ref={textareaRef}
              rows={2}
              className="composer-input"
              value={input}
              placeholder={busy ? t("agent.queue.placeholder") : t("agent.inputPlaceholder")}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={onKeyDown}
            />
          </div>

          <div className="composer-toolbar">
            <div className="composer-left">
              <PiTip label={t("agent.attach")}>
                <button
                  type="button"
                  className="pi-icon-btn"
                  disabled={busy || attachMutation.isPending}
                  onClick={() => attachMutation.mutate()}
                >
                  {attachMutation.isPending ? (
                    <Loader2Icon size={15} className="animate-spin" aria-hidden />
                  ) : (
                    <PlusIcon size={15} aria-hidden />
                  )}
                </button>
              </PiTip>

              <ModeChip mode={mode} disabled={busy} />

              <PermissionChip mode={approvalMode} disabled={busy} />

              <PiTip label={t("agent.tools")}>
                <button
                  type="button"
                  className={`pi-icon-btn${showTools ? " active" : ""}`}
                  aria-pressed={showTools}
                  onClick={() => setShowTools((v) => !v)}
                >
                  <WrenchIcon size={14} aria-hidden />
                </button>
              </PiTip>
            </div>

            <div className="composer-right">
              <ContextInspector conversationId={conversationId} />
              <ModelThinkingPicker disabled={busy} />
              {busy && !input.trim() ? (
                <PiTip label={t("agent.stop")}>
                  <button
                    type="button"
                    className="stop-btn"
                    disabled={stopMutation.isPending}
                    onClick={() => stopMutation.mutate()}
                  >
                    <SquareIcon size={13} aria-hidden />
                  </button>
                </PiTip>
              ) : (
                <PiTip label={busy ? t("agent.queue.send") : t("agent.send")}>
                  <button
                    type="button"
                    className="send-btn"
                    disabled={!canSend || sendMutation.isPending || queueMutation.isPending}
                    onClick={() => {
                      if (!busy && runSlashIfExact(input)) return;
                      handleSend(busy ? "queue" : "send");
                    }}
                  >
                    {sendMutation.isPending ? (
                      <Loader2Icon size={14} className="animate-spin" aria-hidden />
                    ) : busy ? (
                      <CornerDownLeftIcon size={14} aria-hidden />
                    ) : (
                      <SendHorizontalIcon size={14} aria-hidden />
                    )}
                  </button>
                </PiTip>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
