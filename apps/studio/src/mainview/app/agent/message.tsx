import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  GitBranchIcon,
  Loader2Icon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Markdown } from "@components/markdown";
import { useChatStore } from "@stores/chat";
import { useAgentStore } from "@stores/agent";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import { AgentEventTimeline } from "./timeline";
import { ARTIFACT_KIND_LABEL, artifactIcon, formatSize } from "./artifact-meta";
import type { ArtifactItem } from "../../../bun/agent-artifacts";
import type { AgentEventRow } from "../../../bun/agent";
import type { ChatMessage } from "../../../bun/chat";

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * 思考行：一行「思考 · 持续了 N 秒」，点开看思考原文。
 * 时长在本地按流式的起止时刻计（历史消息没有计时，只显示「思考」）。
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
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "group flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left transition-colors hover:bg-muted/70",
          open && "bg-muted/50",
        )}
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          {streaming ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <BrainIcon className="size-3.5" />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {label}
          {!open && reasoning && (
            <span className="ml-2 text-muted-foreground/60">{reasoning.replace(/\s+/g, " ").slice(0, 60)}</span>
          )}
        </span>
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/50 transition-transform",
            open ? "rotate-180" : "opacity-0 group-hover:opacity-100",
          )}
        />
      </button>
      {open && (
        <div
          ref={bodyRef}
          className="mb-1 ml-3 max-h-64 overflow-y-auto border-l border-border/60 px-3 py-1 text-[11px] leading-5 whitespace-pre-wrap text-muted-foreground"
        >
          {reasoning}
        </div>
      )}
    </div>
  );
}

/**
 * 运行中、还没有任何可见输出时的占位行（一行灰字，不再留空白气泡）。
 * 等太久还没有第一个 token 时补一句提示：「没回复」多半是推理服务那边没出字，
 * 而不是界面的问题（本地模型未下载完 / 服务没起来时就是这样）。
 */
function WorkingRow({ label, hint }: { label: string; hint: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 20_000);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="flex flex-col gap-0.5 px-2 py-1 text-xs text-muted-foreground">
      <span className="flex items-center gap-2">
        <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
        {label}
      </span>
      {slow && <span className="pl-6 text-[11px] text-amber-600 dark:text-amber-400">{hint}</span>}
    </div>
  );
}

/** 本条消息产出的文件（点「打开」在右侧面板里预览；HTML 直接当网页渲染）。 */
function ArtifactCard({
  artifact,
  onOpen,
}: {
  artifact: ArtifactItem;
  onOpen: (artifact: ArtifactItem) => void;
}) {
  const t = useT();
  const size = formatSize(artifact.size);
  return (
    <div className="flex items-center gap-2.5 rounded-xl border bg-card px-3 py-2">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
        {artifactIcon(artifact.kind)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium" title={artifact.path}>
          {artifact.title}
        </span>
        <span className="block text-[10px] text-muted-foreground">
          {ARTIFACT_KIND_LABEL[artifact.kind] ?? artifact.kind}
          {size ? ` · ${size}` : ""}
        </span>
      </span>
      <Button
        variant="secondary"
        size="sm"
        className="h-7 shrink-0 gap-1 px-2.5 text-[11px]"
        onClick={() => onOpen(artifact)}
      >
        {t("agent.artifact.open")}
      </Button>
    </div>
  );
}

/** 消息操作条：复制 / 重新生成 / 分叉 / 删除 + 速度与时间。 */
function MessageActionBar({
  message,
  conversationId,
  isStreamingMessage,
}: {
  message: ChatMessage;
  conversationId: number;
  isStreamingMessage: boolean;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const streaming = useChatStore((s) => s.streaming);
  const stats = useChatStore((s) => s.messageStats[message.id]);
  const [copied, setCopied] = useState(false);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["conversations"] });
    queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
    queryClient.invalidateQueries({ queryKey: ["agent-events", conversationId] });
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

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — ignore
    }
  };

  const speed = stats
    ? `${formatTokens(stats.tokens)} tokens · ${stats.tokensPerSec.toFixed(1)} tok/s`
    : null;

  const iconBtn = (tooltip: string, onClick: () => void, icon: ReactNode, extraDisabled = false) => (
    <Button
      variant="ghost"
      size="icon-sm"
      tooltip={tooltip}
      onClick={onClick}
      disabled={streaming || extraDisabled}
      className="size-6 text-muted-foreground/70 hover:text-foreground"
    >
      {icon}
    </Button>
  );

  return (
    <div className="mt-1 flex items-center gap-0.5">
      {iconBtn(
        copied ? t("chat.copied") : t("chat.copy"),
        handleCopy,
        copied ? <CheckIcon className="size-3.5 text-emerald-500" /> : <CopyIcon className="size-3.5" />,
        !message.content,
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
        t("chat.fork"),
        () => forkMutation.mutate(),
        forkMutation.isPending ? (
          <Loader2Icon className="size-3.5 animate-spin" />
        ) : (
          <GitBranchIcon className="size-3.5" />
        ),
        isStreamingMessage,
      )}
      {iconBtn(
        t("chat.delete"),
        () => deleteMutation.mutate(),
        <Trash2Icon className="size-3.5" />,
        isStreamingMessage,
      )}
      <span className="ml-1.5 text-[10px] tabular-nums text-muted-foreground/60">
        {[speed, message.createdAt ? formatTime(message.createdAt) : null].filter(Boolean).join(" · ")}
      </span>
    </div>
  );
}

/** 用户消息：右侧浅色气泡（正文原样保留换行）。 */
export function AgentUserMessage({ message }: { message: ChatMessage }) {
  return (
    <div className="flex flex-col items-end">
      <div className="max-w-[80%] rounded-2xl rounded-br-md border bg-muted/60 px-3.5 py-2 text-sm whitespace-pre-wrap">
        {message.content}
      </div>
    </div>
  );
}

/**
 * 助手消息：一条连续的回答 —— 上面是执行轨迹（思考 / 工具调用）与正文，
 * 正文就是正文，不再套一层气泡边框；下面挂产出物卡片与操作条。
 */
export function AgentAssistantMessage({
  message,
  conversationId,
  events,
  artifacts,
  streaming,
  onOpenArtifact,
}: {
  message: ChatMessage;
  conversationId: number;
  events: AgentEventRow[];
  artifacts: ArtifactItem[];
  streaming: boolean;
  onOpenArtifact: (artifact: ArtifactItem) => void;
}) {
  const t = useT();
  const hasTrace = events.length > 0 || Boolean(message.reasoning);
  const waiting = streaming && !message.content && !message.reasoning && events.length === 0;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {(hasTrace || waiting) && (
        <div className="flex min-w-0 flex-col gap-0.5 rounded-xl bg-muted/40 p-1">
          {message.reasoning ? (
            <ReasoningRow reasoning={message.reasoning} streaming={streaming && !message.content} />
          ) : null}
          <AgentEventTimeline events={events} />
          {waiting && <WorkingRow label={t("agent.working")} hint={t("agent.working.slow")} />}
        </div>
      )}

      {message.content ? (
        <div className="min-w-0 text-sm leading-6">
          <Markdown content={message.content} />
        </div>
      ) : null}

      {artifacts.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {artifacts.map((artifact) => (
            <ArtifactCard key={artifact.id} artifact={artifact} onOpen={onOpenArtifact} />
          ))}
        </div>
      )}

      <MessageActionBar
        message={message}
        conversationId={conversationId}
        isStreamingMessage={streaming}
      />
    </div>
  );
}

