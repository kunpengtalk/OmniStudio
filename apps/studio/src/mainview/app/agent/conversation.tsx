// Agent 会话视图：消息时间轴 + 输入区。
//
// 这一层只做「取数据 + 排版」：会话上下文（事件 / 待办 / 产出物 / 目标 / 方案 /
// 快照）在这里一次性取回并写进 store，下面各组件从 store 读，避免每个子组件
// 各自打一遍 RPC。
import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircuitBoardIcon, Loader2Icon, MessageSquarePlusIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { useChatStore } from "@stores/chat";
import { useAgentStore } from "@stores/agent";
import { useT } from "@stores/ui-lang";
import { useServerMessageSync } from "@hooks/use-server-message-sync";
import { AgentComposer } from "./composer";
import { AgentAssistantMessage, AgentUserMessage } from "./message";
import { artifactsByMessage as groupArtifactsByMessage, lastAssistantMessageId } from "./artifact-meta";
import type { ArtifactItem } from "../../../bun/agent-artifacts";

/** 会话当前是否运行中（后端推来 / 查来的运行态，见下面的 runStateQuery）。 */
export function useAgentRunning() {
  const running = useAgentStore((s) => s.running);
  const streaming = useChatStore((s) => s.streaming);
  return running || streaming;
}

export function AgentConversation({
  conversationId,
  defaultWorkspace,
}: {
  conversationId: number;
  /** 全局默认工作区：会话没指定自己的目录时要跟到它。 */
  defaultWorkspace: string;
}) {
  const t = useT();
  const activeMessages = useChatStore((s) => s.activeMessages);
  const events = useAgentStore((s) => s.events);
  const mode = useAgentStore((s) => s.mode);
  const artifacts = useAgentStore((s) => s.artifacts);
  const scrollRef = useRef<HTMLDivElement>(null);

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

  /**
   * 运行态以后端为准。
   *
   * 前端那个"发送时置 true"的标记只在**本窗口发的**那一轮上成立：刷新窗口、切走再
   * 切回来、自动化在后台起的运行都不经过它 —— 那些情况下界面会把一个正在干活的会话
   * 显示成已经结束（不转圈、按钮变回「发送」），看着就是"不知道它还在不在干活"。
   * 所以打开会话先取一次真实状态，之后靠 agentRunState 推送跟；再按 5 秒兜底重取
   * 一次防止某条推送没送到（很便宜：后端只是查一个 Set）。
   */
  const runStateQuery = useQuery({
    queryKey: ["agent-run-state", conversationId],
    queryFn: () => rpcClient.getAgentRunState({ conversationId }),
    refetchInterval: 5000,
  });
  useEffect(() => {
    if (runStateQuery.data) {
      useAgentStore.getState().setRunningFor(conversationId, runStateQuery.data.running);
    }
  }, [runStateQuery.data, conversationId]);

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
  // 目标（Goal 模式）与方案（Plan 模式）：都是"当前会话的一件事"，按会话取一次。
  const goalQuery = useQuery({
    queryKey: ["agent-goal", conversationId],
    queryFn: () => rpcClient.getAgentGoal({ conversationId }),
  });
  const planQuery = useQuery({
    queryKey: ["agent-plan", conversationId],
    queryFn: () => rpcClient.getAgentPlan({ conversationId }),
  });

  /**
   * 回合快照（对齐 Codex 的回合安全网）：每条助手消息对应一个开工快照，
   * 有快照的消息才会出现「撤销本轮」。关掉开关 / 没有 git 时列表为空，按钮自然不显示。
   */
  const snapshotsQuery = useQuery({
    queryKey: ["agent-snapshots", conversationId],
    queryFn: () => rpcClient.listAgentSnapshots({ conversationId }),
  });
  const snapshotsByMessage = useMemo(() => {
    const map = new Map<number, { id: string; label: string }>();
    for (const snapshot of snapshotsQuery.data?.snapshots ?? []) {
      if (snapshot.messageId != null) map.set(snapshot.messageId, { id: snapshot.id, label: snapshot.label });
    }
    return map;
  }, [snapshotsQuery.data]);

  useEffect(() => {
    const store = useAgentStore.getState();
    if (interactionsQuery.data) {
      store.setPermissions(interactionsQuery.data.permissions);
      store.setQuestions(interactionsQuery.data.questions);
    }
    if (todosQuery.data) store.setTodos(todosQuery.data.todos);
    if (artifactsQuery.data) store.setArtifacts(artifactsQuery.data.artifacts);
    // 目标 / 方案：拿到之前不要用 undefined 覆盖（推送可能已经先到了）。
    if (goalQuery.data) store.setGoal(goalQuery.data.goal);
    if (planQuery.data) {
      const plan = planQuery.data.plan;
      store.setPlan(plan ? { approvedAt: plan.approvedAt, chars: plan.content.length } : null);
    }
  }, [interactionsQuery.data, todosQuery.data, artifactsQuery.data, goalQuery.data, planQuery.data]);

  // 会话自己的工作区（没设过就跟随全局）。
  const conversationWorkspace = convQuery.data?.conversation?.workspace ?? "";
  useEffect(() => {
    // 还没取回来就先不动 store：这时分不清"跟随全局"和"还没读到"。
    if (!convQuery.data) return;
    if (conversationWorkspace) {
      useAgentStore.getState().setWorkspace(conversationWorkspace);
      useAgentStore.getState().setWorkspaceIsDefault(false);
    } else {
      // 跟随全局的会话：把 store 拨回全局默认。输入框发消息时带的是 store 的工作区，
      // 留着上一个项目的路径会让这一轮跑在别人的目录里（会话列上写的却是跟随全局）。
      useAgentStore.getState().setWorkspace(defaultWorkspace);
      useAgentStore.getState().setWorkspaceIsDefault(true);
    }
  }, [convQuery.data, conversationWorkspace, defaultWorkspace]);

  // 服务端消息同步：切会话清流式态、同会话内只做合并（规则与对话页共用一份，见
  // use-server-message-sync 的文档）。运行态在 setConversationId 里一并清掉了 ——
  // 那次写入排在"按后端补齐运行态"之前，两个 effect 抢同一个字段就会互相盖，
  // 所以本 hook 必须放在 runStateQuery 的 effect 之后声明（effect 按声明顺序执行）。
  useServerMessageSync(conversationId, convQuery.data);

  // 新消息 / 新事件进来时贴到底。这里用 scrollTop 直接赋值而不是 scrollIntoView：
  // 后者会连带把外层容器也滚一下，工具条会跳。
  const lastForScroll = activeMessages[activeMessages.length - 1];
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeMessages.length, lastForScroll?.content, lastForScroll?.reasoning, events.length]);

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

  /**
   * 产出物按所属消息预分组；没有归属的（message_id 为空 / 归属的消息已经不在这一屏）
   * 由 `artifactsByMessage` 统一挂到最后一条助手消息下面 —— 规则本身是纯函数，有单测。
   */
  const artifactsByMessage = useMemo(
    () => groupArtifactsByMessage(artifacts, activeMessages),
    [artifacts, activeMessages],
  );

  /** 最后一条助手消息（产出物兜底与「查看所有产物」都挂在它下面）。 */
  const lastAssistantId = useMemo(() => lastAssistantMessageId(activeMessages), [activeMessages]);

  const openArtifact = (artifact: ArtifactItem) => {
    useAgentStore.getState().setPreview({ source: "artifact", artifactId: artifact.id });
  };

  /** 「查看所有产物」：常驻的产出物页签（已经开着就聚焦过去，不叠一堆重复页签）。 */
  const openArtifactsTab = () => {
    useAgentStore.getState().openPanelTab({ kind: "artifacts" });
  };

  const hasMessages = activeMessages.length > 0;
  const running = useAgentRunning();
  const conversationModel = convQuery.data?.conversation?.modelId ?? undefined;

  /**
   * 轨迹的兜底追平（`afterId` 增量）。
   *
   * 轨迹在界面上主要靠 `agentEvent` 推送一条条追加，而推送会丢：窗口被系统节流、
   * webview 刷新过、消息在信道里掉了 —— 库里照写不误，界面却停在丢消息的那一刻，
   * 看起来就是"执行到一半记录加不上"，而且不会再自己好（打开会话时的整份加载是唯一
   * 的补救）。所以跑动中每几秒按 id 只取新增的那几条并进列表，收尾（running 转 false）
   * 再补一次：正常情况下每次返回空数组，几乎不花钱。
   */
  useEffect(() => {
    const catchUp = async () => {
      const known = useAgentStore.getState().events;
      const afterId = known.length > 0 ? known[known.length - 1]!.id : 0;
      try {
        const data = await rpcClient.listAgentEvents({ conversationId, afterId });
        if (data.events.length > 0) useAgentStore.getState().mergeEvents(data.events);
      } catch {
        // 追平失败不影响这一屏：下一次 tick / 下一次打开会话会再对齐。
      }
    };
    if (!running) {
      void catchUp();
      return;
    }
    const timer = window.setInterval(() => void catchUp(), 4000);
    return () => window.clearInterval(timer);
  }, [running, conversationId]);

  // 只有最后一条助手消息在流式时才转圈：前面的消息早就结束了。
  const lastMessage = activeMessages[activeMessages.length - 1];

  return (
    <>
      <div ref={scrollRef} className="thread-scroll">
        <div className="thread-content">
          {!hasMessages ? (
            <div className="thread-hero">
              <span className="thread-hero-mark">
                <CircuitBoardIcon size={22} aria-hidden />
              </span>
              <p className="thread-hero-title">{t("agent.transcript.hero")}</p>
              <p className="thread-hero-hint">{t("agent.transcript.heroHint")}</p>
            </div>
          ) : (
            activeMessages.map((message) => {
              const isLast = message.id === lastMessage?.id;
              const isStreamingMessage = running && isLast && message.role === "assistant";
              const isLastAssistant = message.id === lastAssistantId;

              if (message.role === "user") {
                return (
                  <AgentUserMessage
                    key={message.id}
                    message={message}
                    conversationId={conversationId}
                  />
                );
              }

              /**
               * 这一条消息下面挂的产物：自己的 + （最后一条助手消息才有）没有归属的那些 ——
               * 合并规则在 artifact-meta 的 artifactsByMessage 里（纯函数，有单测）。
               */
              const shown = artifactsByMessage.get(message.id) ?? [];

              return (
                <AgentAssistantMessage
                  key={message.id}
                  message={message}
                  conversationId={conversationId}
                  conversationModel={conversationModel}
                  events={eventsByMessage.get(message.id) ?? []}
                  artifacts={shown}
                  artifactTotal={isLastAssistant ? artifacts.length : 0}
                  streaming={isStreamingMessage}
                  snapshot={snapshotsByMessage.get(message.id)}
                  onOpenArtifact={openArtifact}
                  onOpenArtifacts={openArtifactsTab}
                />
              );
            })
          )}
        </div>
      </div>

      <AgentComposer conversationId={conversationId} mode={mode} />
    </>
  );
}

/** 会话为空时的占位（还没建出会话时显示）。 */
export function EmptyAgent({ onCreate, pending }: { onCreate: () => void; pending: boolean }) {
  const t = useT();
  return (
    <div className="thread-scroll">
      <div className="thread-content">
        <div className="thread-hero">
          {pending ? (
            <Loader2Icon size={22} className="animate-spin" style={{ color: "var(--ds-text-muted)" }} />
          ) : (
            <>
              <span className="thread-hero-mark">
                <CircuitBoardIcon size={22} aria-hidden />
              </span>
              <p className="thread-hero-title">{t("agent.placeholder")}</p>
              <button type="button" className="composer-panel-btn primary" onClick={onCreate}>
                <MessageSquarePlusIcon size={13} aria-hidden />
                {t("agent.session.new")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
