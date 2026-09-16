import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BrainIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  NotebookPenIcon,
  FilesIcon,
  GitBranchIcon,
  Loader2Icon,
  RotateCcwIcon,
  Trash2Icon,
  Undo2Icon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Markdown } from "@components/markdown";
import { usePiContextMenu, actionMenuItems, type MessageActionItem } from "@components/pi-menu";
import { MessageTokenStats, formatDuration, useTokenStatsView } from "@components/token-stats";
import { noteDraftFromMessage } from "@/mainview/lib/note-draft";
import { useChatStore } from "@stores/chat";
import { useAgentStore } from "@stores/agent";
import { useT } from "@stores/ui-lang";
import { AgentEventTimeline } from "./timeline";
import { flushedTextChars } from "./timeline-model";
import { RevertTurnDialog } from "./revert-dialog";
import { ARTIFACT_KIND_LABEL, artifactIcon, formatSize } from "./artifact-meta";
import type { ArtifactItem } from "../../../bun/agent-artifacts";
import type { AgentEventRow } from "../../../bun/agent";
import type { ChatMessage } from "../../../bun/chat";

/**
 * 思考行：一行「思考 · 持续了 N 秒」，点开看思考原文。
 * 时长在本地按流式的起止时刻计（历史消息没有计时，只显示「思考」）。
 *
 * 跑动中额外缀一段前言（截断到 80 字）：那是"它正在想什么"的唯一线索，
 * 静默十几秒时能证明它没卡死。**跑完就不缀**了 —— 一行「思考 · 持续了 37 秒」
 * 是这行的常规形态，把那句话留在这里只会让每一条思考行都拖一条尾巴。
 */
function ReasoningRow({ reasoning, streaming }: { reasoning: string; streaming: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [seconds, setSeconds] = useState<number | null>(null);
  const startedAt = useRef<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (streaming) {
      if (startedAt.current == null) startedAt.current = Date.now();
      return;
    }
    if (startedAt.current != null) {
      setSeconds(Math.max(1, Math.round((Date.now() - startedAt.current) / 1000)));
      startedAt.current = null;
    }
  }, [streaming]);

  // 思考中展开时跟着滚到底，用户能看到它在想什么。
  useEffect(() => {
    if (!open || !streaming) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [reasoning, open, streaming]);

  const label = streaming
    ? t("agent.thinking.streaming")
    : seconds != null
      ? t("agent.thinking.duration", { seconds: String(seconds) })
      : t("agent.thinking");

  return (
    <div className="think-block">
      <button type="button" className="think-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <ChevronRightIcon size={12} className={`pi-caret${open ? " open" : ""}`} aria-hidden />
        {streaming ? <span className="tool-spinner" aria-hidden /> : <BrainIcon size={12} aria-hidden />}
        <span>{label}</span>
        {streaming && reasoning ? (
          <span className="tool-row-summary" style={{ maxWidth: 320 }}>
            {reasoning.replace(/\s+/g, " ").slice(0, 80)}
          </span>
        ) : null}
      </button>
      {open ? (
        <div ref={bodyRef} className="think-body" style={{ maxHeight: 256, overflowY: "auto" }}>
          {reasoning}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 每秒重渲染一次（只在 active 时挂计时器）。
 *
 * 秒数必须在"没有任何新事件"的静默期里继续走：等模型决定下一步、工具正在跑、
 * 首 token 还没出来 —— 这几段正是界面上最容易看着像卡死的时候。
 */
function useTicker(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

/**
 * 这一轮的状态行（**最上面一行**，不进时间轴）：跑动中是「处理中 · N 秒」，
 * 跑完换成实测耗时 + 工具调用次数（与右下角用量胶囊同一份数据）。
 *
 * 秒数每秒都在走 —— 界面完全静止的那几秒（等模型决定下一步、工具正在执行、首 token
 * 还没出来）没人分得清"它在想"和"它卡死了"，这一行加上时间轴末尾的转圈行就是
 * 唯一的证据。参考实现里 "已处理 · N 秒" 也在消息最上方，位置与此一致。
 */
function AgentRunStatus({
  active,
  elapsedMs,
  toolCount,
  /** 还没有任何可见输出：给一行占位。 */
  waiting,
}: {
  active: boolean;
  elapsedMs?: number;
  toolCount: number;
  waiting: boolean;
}) {
  const t = useT();
  const label =
    elapsedMs != null
      ? t(active ? "chat.working.duration" : "chat.worked", { duration: formatDuration(t, elapsedMs) })
      : active
        ? t("agent.working")
        : t("agent.trace");
  return (
    <div className="run-status" title={waiting ? t("agent.working") : undefined}>
      {active ? <span className="tool-spinner" aria-hidden /> : null}
      <span className="tool-group-label">{label}</span>
      {toolCount > 0 ? (
        <span className="tool-group-count">{t("agent.trace.tools", { count: String(toolCount) })}</span>
      ) : null}
    </div>
  );
}

/** 本条消息产出的文件（点一下在右侧面板里预览；HTML 直接当网页渲染）。 */
function ArtifactCard({ artifact, onOpen }: { artifact: ArtifactItem; onOpen: (artifact: ArtifactItem) => void }) {
  const size = formatSize(artifact.size);
  return (
    <button type="button" className="artifact-card" title={artifact.path} onClick={() => onOpen(artifact)}>
      <span style={{ flex: "none", color: "var(--ds-text-muted)" }}>{artifactIcon(artifact.kind)}</span>
      <span className="artifact-card-name">{artifact.title}</span>
      <span className="artifact-card-kind">
        {ARTIFACT_KIND_LABEL[artifact.kind] ?? artifact.kind}
        {size ? ` · ${size}` : ""}
      </span>
    </button>
  );
}

/**
 * 消息底部的产出物区：卡片 + 「查看所有产物」。
 *
 * 卡片是"这一轮产出了什么"的答案，点开直接在右侧面板预览；那一行入口对应参考实现里的
 * 「查看所有产物（N）》」—— 会话里积了几轮的产物时，用户不必去右上角找面板开关。
 * 卡片一个都没有、但会话确实有产物（比如产物属于别的消息）时，只留那一行入口。
 */
function ArtifactSection({
  artifacts,
  total,
  onOpen,
  onOpenAll,
}: {
  artifacts: ArtifactItem[];
  /** 这个会话的产物总数（0 = 连入口都不显示）。 */
  total: number;
  onOpen: (artifact: ArtifactItem) => void;
  onOpenAll: () => void;
}) {
  const t = useT();
  // 没有卡片、也不知道总数（非最后一条助手消息）就整块不渲染。
  if (artifacts.length === 0 && total === 0) return null;
  return (
    <div className="artifact-section">
      {artifacts.length > 0 ? (
        <div className="artifact-cards">
          {artifacts.map((artifact) => (
            <ArtifactCard key={artifact.id} artifact={artifact} onOpen={onOpen} />
          ))}
        </div>
      ) : null}
      {total > 0 ? (
        <button type="button" className="artifact-more" onClick={onOpenAll}>
          <FilesIcon size={12} aria-hidden />
          <span>{t("agent.artifacts.all", { count: String(total) })}</span>
          <ChevronRightIcon size={12} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

/** 一条消息能做的事：hover 操作条与右键菜单读同一份，两处各写一遍必然走样。 */
type MessageAction = MessageActionItem & { icon: ReactNode; disabled: boolean };

/** 复制正文：两个入口共用这份「已复制」状态（图标在上面停 1.5 秒）。 */
function useCopyMessage(content: string) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用：忽略，不打断阅读。
    }
  }, [content]);
  return { copied, copy };
}

/**
 * 这条消息的动作清单。用户消息只有「复制 / 删除」（与聊天页一致），助手消息另有
 * 重新生成 / 分叉 / 撤销本轮 —— 界面上的两个入口（操作条、右键菜单）都从这里取。
 */
function useMessageActions({
  message,
  conversationId,
  isStreamingMessage,
  snapshot,
}: {
  message: ChatMessage;
  conversationId: number;
  isStreamingMessage: boolean;
  /** 这条助手消息所属回合的快照（没有快照 = 界面不显示「撤销本轮」）。 */
  snapshot?: { id: string; label: string };
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const streaming = useChatStore((s) => s.streaming);
  const { copied, copy } = useCopyMessage(message.content);
  const [revertOpen, setRevertOpen] = useState(false);
  const [noteSaved, setNoteSaved] = useState(false);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["conversations"] });
    queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
    queryClient.invalidateQueries({ queryKey: ["agent-events", conversationId] });
    // 重新生成也会新开一轮快照，列表要跟着刷新。
    queryClient.invalidateQueries({ queryKey: ["agent-snapshots", conversationId] });
  };

  const deleteMutation = useMutation({
    mutationFn: () => rpcClient.deleteMessage({ conversationId, messageId: message.id }),
    onSuccess: () => {
      useChatStore.getState().removeMessage(conversationId, message.id);
      invalidate();
    },
  });

  const regenerateMutation = useMutation({
    onMutate: () => {
      useChatStore.getState().rewindMessages(conversationId, message.id);
      useChatStore.getState().setStreaming(true);
      useAgentStore.getState().setRunning(true);
    },
    mutationFn: () => rpcClient.regenerateAgentMessage({ conversationId, messageId: message.id }),
    onSuccess: invalidate,
    onError: () => {
      useChatStore.getState().setStreaming(false);
      useAgentStore.getState().setRunning(false);
      invalidate();
    },
  });

  const forkMutation = useMutation({
    mutationFn: () => rpcClient.forkAgentSession({ conversationId, messageId: message.id }),
    onSuccess: (data) => {
      if (!data.ok || data.conversationId == null) return;
      queryClient.invalidateQueries({ queryKey: ["agent-sessions"] });
      // 分叉完直接切过去，用户马上就能在新分支上继续。
      useAgentStore.getState().clearUnread(data.conversationId);
      useChatStore.getState().setActiveConversation(data.conversationId);
      useChatStore.getState().setActiveMessages([]);
      useChatStore.getState().setStreaming(false);
      useAgentStore.getState().clear();
    },
  });

  /** 一键存进「笔记」小应用：草稿规则与聊天页同一份（`lib/note-draft.ts`）。 */
  const handleSaveToNote = async () => {
    const draft = noteDraftFromMessage(message.content, t("notes.tagAgent"));
    if (!draft) return;
    try {
      const saved = await rpcClient.miniappNotesSave({
        title: draft.title,
        body: draft.body,
        tags: draft.tags,
        day: draft.day,
      });
      setNoteSaved(true);
      window.setTimeout(() => setNoteSaved(false), 1500);
      void rpcClient.miniappLog({
        appId: "agent",
        event: "note.saved",
        message: saved?.note ? `note #${saved.note.id}` : "saved",
        detail: { chars: draft.body.length, tag: draft.tags[0] },
      });
    } catch (e) {
      // 失败不打断阅读（按钮不亮即已说明问题），但必须留下线索：
      // 这是"点了没反应"里最难查的一类 —— 用户以为存进去了，其实没有。
      void rpcClient.miniappLog({
        appId: "agent",
        event: "note.save_failed",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const isAssistant = message.role === "assistant";
  // 生成中一律不可点：删到一半的消息、重新生成正在跑的那条都没有意义。
  const busy = streaming || isStreamingMessage;
  const actions: MessageAction[] = [
    {
      key: "copy",
      label: copied ? t("chat.copied") : t("chat.copy"),
      icon: copied ? (
        <CheckIcon size={14} style={{ color: "var(--ds-success)" }} />
      ) : (
        <CopyIcon size={14} />
      ),
      onSelect: () => void copy(),
      disabled: streaming || !message.content,
    },
    ...(isAssistant
      ? [
          {
            key: "save-to-note",
            label: noteSaved ? t("chat.savedToNote") : t("chat.saveToNote"),
            icon: noteSaved ? (
              <CheckIcon size={14} style={{ color: "var(--ds-success)" }} />
            ) : (
              <NotebookPenIcon size={14} />
            ),
            onSelect: () => void handleSaveToNote(),
            disabled: busy || !message.content,
          },
          {
            key: "regenerate",
            label: t("chat.regenerate"),
            icon: regenerateMutation.isPending ? (
              <Loader2Icon size={14} className="animate-spin" />
            ) : (
              <RotateCcwIcon size={14} />
            ),
            onSelect: () => regenerateMutation.mutate(),
            disabled: busy,
          },
          {
            key: "fork",
            label: t("chat.fork"),
            icon: forkMutation.isPending ? (
              <Loader2Icon size={14} className="animate-spin" />
            ) : (
              <GitBranchIcon size={14} />
            ),
            onSelect: () => forkMutation.mutate(),
            disabled: busy,
          },
        ]
      : []),
    ...(isAssistant && snapshot
      ? [
          {
            key: "revert",
            label: t("agent.revert.action"),
            icon: <Undo2Icon size={14} />,
            onSelect: () => setRevertOpen(true),
            disabled: busy,
          },
        ]
      : []),
    {
      key: "delete",
      label: t("chat.delete"),
      icon: <Trash2Icon size={14} />,
      onSelect: () => deleteMutation.mutate(),
      disabled: busy,
      danger: true,
    },
  ];

  // 「撤销本轮」要先预览再执行：确认弹窗在这里构造，由调用方渲染一次（操作条里）。
  const revertDialog =
    isAssistant && snapshot ? (
      <RevertTurnDialog
        open={revertOpen}
        onOpenChange={setRevertOpen}
        snapshotId={snapshot.id}
        label={snapshot.label}
        onReverted={() => {
          // 工作区文件变了：会话、产出物、文件树都要重新取。
          queryClient.invalidateQueries({ queryKey: ["agent-artifacts", conversationId] });
          queryClient.invalidateQueries({ queryKey: ["agent-workspace-files"] });
        }}
      />
    ) : null;

  return { actions, revertDialog };
}

/** 操作条：复制 / 重新生成 / 分叉 / 撤销本轮 / 删除 + 用量胶囊（动作与右键菜单同源）。 */
function MessageActionBar({
  actions,
  message,
  conversationId,
  isStreamingMessage,
  revertDialog,
}: {
  actions: MessageAction[];
  message: ChatMessage;
  conversationId: number;
  isStreamingMessage: boolean;
  /** 「撤销本轮」的确认弹窗（每操作条渲染一次 —— Radix 弹窗不能挂两份）。 */
  revertDialog?: ReactNode;
}) {
  return (
    <div className="msg-actions">
      {actions.map((item) => (
        <button
          key={item.key}
          type="button"
          className={`msg-action icon${item.danger ? " danger" : ""}`}
          title={item.label}
          aria-label={item.label}
          disabled={item.disabled}
          onClick={item.onSelect}
        >
          {item.icon}
        </button>
      ))}
      {/* 用量胶囊贴右边：左边是"对消息做什么"，它是"这次花了多少"，两者分开看更清楚。 */}
      <MessageTokenStats
        message={message}
        conversationId={conversationId}
        streaming={isStreamingMessage}
        className="ml-auto mr-1"
      />
      {revertDialog}
    </div>
  );
}

/** 消息元信息：模型名 + 时间。参考实现里助手消息没有头像，身份靠这一行小胶囊承载。 */
function MessageMeta({ model, createdAt }: { model?: string; createdAt: number }) {
  const time = useMemo(
    () => new Date(createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
    [createdAt],
  );
  return (
    <div className="msg-meta">
      {model ? <span className="msg-chip model">{model}</span> : null}
      <span>{time}</span>
    </div>
  );
}

/** 用户消息：右侧实心气泡（右下角收一个小角），正文原样保留换行。 */
export function AgentUserMessage({
  message,
  conversationId,
}: {
  message: ChatMessage;
  conversationId: number;
}) {
  const images = message.images ?? [];
  // 用户消息没有 hover 操作条，动作只从右键菜单进（复制 / 删除）。
  const { actions } = useMessageActions({ message, conversationId, isStreamingMessage: false });
  const menu = usePiContextMenu(actionMenuItems(actions));
  return (
    <div className="msg-row user" onContextMenu={menu.onContextMenu}>
      <div className="msg-col">
        {images.length > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "flex-end" }}>
            {images.map((src) => (
              <img
                key={src}
                src={src}
                alt=""
                style={{ maxHeight: 160, maxWidth: 220, borderRadius: 12, objectFit: "cover" }}
              />
            ))}
          </div>
        ) : null}
        {message.content ? <div className="msg-bubble-user">{message.content}</div> : null}
        <MessageMeta createdAt={message.createdAt} />
      </div>
      {menu.node}
    </div>
  );
}

/**
 * 助手消息：一条连续的回答 —— 上面是执行轨迹（思考 / 工具调用）与正文，
 * 正文不套气泡（内容自己承担分层），下面挂产出物与操作条。
 */
export function AgentAssistantMessage({
  message,
  conversationId,
  conversationModel,
  events,
  artifacts,
  artifactTotal = 0,
  streaming,
  snapshot,
  onOpenArtifact,
  onOpenArtifacts,
}: {
  message: ChatMessage;
  conversationId: number;
  /** 会话当前模型：历史消息没有统计时，元信息行仍能标出它当时用的模型。 */
  conversationModel?: string;
  events: AgentEventRow[];
  artifacts: ArtifactItem[];
  /** 会话产物总数：「查看所有产物（N）」用它（0 = 不显示入口）。 */
  artifactTotal?: number;
  streaming: boolean;
  /** 本回合的开工快照：有它才给「撤销本轮」。 */
  snapshot?: { id: string; label: string };
  onOpenArtifact: (artifact: ArtifactItem) => void;
  /** 打开右侧的产出物页签（「查看所有产物」）。 */
  onOpenArtifacts?: () => void;
}) {
  const t = useT();
  const hasTrace = events.length > 0 || Boolean(message.reasoning);
  const waiting = streaming && !message.content && !message.reasoning && events.length === 0;
  // 这一轮的实测耗时（生成中是实时值）—— 轨迹行与用量胶囊读同一份数据。
  const view = useTokenStatsView(message, streaming);
  /**
   * 这一轮的起点（绝对时刻）：轨迹行的秒数在跑动中按它现算。
   *
   * 只读实时统计是不够的 —— 那个只有"本窗口看着它开跑"时才有：刷新窗口、
   * 切走再切回、后台起的运行都拿不到，秒数就会退化成一句没有数字的「处理中」。
   * 退而求其次用本轮第一条轨迹事件，再不行用消息自身的时间，够秒表用了。
   */
  const liveStartedAt = useChatStore((s) => (streaming ? s.liveStats[message.id]?.startedAt : undefined));
  const runStartAt = liveStartedAt ?? events[0]?.createdAt ?? (streaming ? message.createdAt : undefined);
  // 操作条与右键菜单是同一批动作的两个入口（清单在 useMessageActions 里）。
  const { actions, revertDialog } = useMessageActions({
    message,
    conversationId,
    isStreamingMessage: streaming,
    snapshot,
  });
  const menu = usePiContextMenu(actionMenuItems(actions));

  const active = streaming || waiting;
  const now = useTicker(active);
  // 跑动中按起点现算（每秒重渲染一次），跑完用实测值（与用量胶囊同源）。
  const elapsedMs = active && runStartAt != null ? Math.max(0, now - runStartAt) : view?.elapsedMs;
  const toolCount = useMemo(
    () => events.filter((event) => event.kind === "tool_start").length,
    [events],
  );

  /**
   * 说到一半的那一段正文（还没落成 `text` 事件的部分）。
   *
   * 事件里已经有"这一步说了什么"（跑完最后一段也补了一条），所以整条正文减去
   * 已落成事件的前缀就是**正在流出的这一段** —— 它跟在时间轴末尾，等这一步的工具
   * 开始执行时被冲进时间轴（位置不变，从"尾巴"变成"时间轴上的一段"）。
   * 老消息没有 `text` 事件 → 前缀是 0 → 整条正文照旧渲染（与改动前一致）。
   */
  const tail = message.content.slice(flushedTextChars(events));

  /**
   * 有工具正在跑时它自己那行在转圈，底部就不再加一条 —— 同一时刻两个转圈是噪音。
   * 剩下两种情况（模型在思考 / 没有任何输出）都补一条"还在干活"，让时间轴末尾
   * 始终有个在动的东西：静默几秒时它是"没卡死"的唯一证据。
   */
  const toolRunning = useMemo(() => {
    let openTools = 0;
    for (const event of events) {
      if (event.kind === "tool_start") openTools += 1;
      else if (event.kind === "tool_end") openTools = Math.max(0, openTools - 1);
    }
    return openTools > 0;
  }, [events]);

  // 等太久还没有第一个 token：多半是推理服务那边没出字，而不是界面卡了。
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!waiting) {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), 20_000);
    return () => window.clearTimeout(timer);
  }, [waiting]);

  return (
    <div className="msg-row assistant" onContextMenu={menu.onContextMenu}>
      <div className="msg-col agent">
        <MessageMeta model={view?.model ?? conversationModel} createdAt={message.createdAt} />

        {hasTrace || waiting ? (
          <AgentRunStatus
            active={active}
            elapsedMs={elapsedMs}
            toolCount={toolCount}
            waiting={waiting}
          />
        ) : null}

        <div className="msg-timeline">
          {message.reasoning ? (
            <ReasoningRow reasoning={message.reasoning} streaming={streaming && !message.content} />
          ) : null}
          {/*
            * 时间轴：模型说的话与工具调用按发生顺序混排（顺序来自 `text` 事件，
            * 见 agent.ts 的 flushStepText）。这一段是"过程"，可读性交给正文。
            */}
          <AgentEventTimeline events={events} live={streaming} />
          {tail ? (
            <div className="msg-bubble-agent prose-pi selectable">
              <Markdown content={tail} />
            </div>
          ) : null}
          {active && (!toolRunning || waiting) ? (
            <div className="timeline-detail">
              <div className="working-indicator" style={{ paddingLeft: 0 }}>
                <span className="working-mark" aria-hidden>
                  <i />
                  <i />
                  <i />
                </span>
                <span>{t("agent.working")}</span>
              </div>
            </div>
          ) : null}
          {slow ? (
            <div className="timeline-detail">
              <div className="tool-note" style={{ color: "var(--ds-warning)", marginTop: 4 }}>
                {t("agent.working.slow")}
              </div>
            </div>
          ) : null}
        </div>

        {artifacts.length > 0 || artifactTotal > 0 ? (
          <ArtifactSection
            artifacts={artifacts}
            total={artifactTotal}
            onOpen={onOpenArtifact}
            onOpenAll={() => onOpenArtifacts?.()}
          />
        ) : null}

        <MessageActionBar
          actions={actions}
          message={message}
          conversationId={conversationId}
          isStreamingMessage={streaming}
          revertDialog={revertDialog}
        />
      </div>
      {menu.node}
    </div>
  );
}
