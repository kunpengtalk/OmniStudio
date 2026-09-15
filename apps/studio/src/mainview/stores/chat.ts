import { create } from "zustand";
import type { Conversation, ChatMessage, ChatStats } from "../../bun/chat";
import { tokenParts, tokensFromParts } from "../../shared/token-estimate";
import type { KbCitation } from "../../shared/knowledge";

/**
 * 流式过程中的实时进度（按助手消息 id 索引）。
 *
 * 收尾统计要等 `chatStats` 推送，而"现在有多快"是用户边等边想看的：
 * 这里按增量累计字符数，界面按当前时刻换算速度，生成中就能显示。
 * 计数用**累计字符**而不是每个增量各自取整 —— 后者会把总数抬高一大截
 * （每个增量向上取整一次，一秒几十次）。
 */
export type LiveTurnStats = {
  /** 本轮请求发出的时刻（首 token 耗时的起点）。 */
  startedAt: number;
  /** 首个增量到达的时刻；还没有任何输出时为 null。 */
  firstTokenAt: number | null;
  /** 正文累计字符（CJK / 其他分开记，口径同 shared/token-estimate）。 */
  contentCjk: number;
  contentOther: number;
  /** 思考过程累计字符。 */
  reasoningCjk: number;
  reasoningOther: number;
};

/** 实时估算的输出 tokens（正文 + 思考，口径与收尾统计一致）。 */
export function liveOutputTokens(live: LiveTurnStats): number {
  return (
    tokensFromParts({ cjk: live.contentCjk, other: live.contentOther }) +
    tokensFromParts({ cjk: live.reasoningCjk, other: live.reasoningOther })
  );
}

/** 实时生成速度（tok/s）：只算首 token 之后的窗口，与收尾统计同一口径。 */
export function liveTokensPerSec(live: LiveTurnStats, now: number = Date.now()): number {
  if (live.firstTokenAt == null) return 0;
  const windowMs = Math.max(1, now - live.firstTokenAt);
  return Math.round((liveOutputTokens(live) / (windowMs / 1000)) * 10) / 10;
}

interface ChatState {
  conversations: Conversation[];
  activeConversationId: number | null;
  activeMessages: ChatMessage[];
  streaming: boolean;
  /** 会话内本次运行生成的 token 统计，按消息 id 索引（重新生成/翻译后旧 id 失效被清理）。 */
  messageStats: Record<number, ChatStats>;
  /** 正在生成的消息的实时进度（收尾后清掉，交给 messageStats）。 */
  liveStats: Record<number, LiveTurnStats>;
  /** 本轮请求发出的时刻：`setStreaming(true)` 记下，用来算首 token 耗时。 */
  runStartedAt: number | null;
  /**
   * 每个会话最近一次的上下文占用（Agent 回合结束的实测值）。
   * 输入框上方的占用条读它；打开旧会话时没有这个值，占用条会退回到 RPC 的估算。
   */
  contextUsage: Record<number, NonNullable<ChatStats["context"]>>;
  /** 提示词库「去试试」带过来的草稿，ChatWindow 挂载时读入输入框。 */
  pendingPrompt: string | null;
  setPendingPrompt: (prompt: string | null) => void;
  setConversations: (conversations: Conversation[]) => void;
  setActiveConversation: (id: number | null) => void;
  setActiveMessages: (messages: ChatMessage[]) => void;
  /**
   * 服务端消息合并进当前列表（打开会话 / 回合结束后重取时用）。
   * 与 setActiveMessages 的区别：不丢本地独有的消息，也不用服务端那份更短的
   * 内容覆盖正在流式的正文 —— 流式期间的一次重取不会再把正文抹成空白。
   */
  mergeServerMessages: (messages: ChatMessage[]) => void;
  setStreaming: (streaming: boolean) => void;
  setMessageStats: (conversationId: number, messageId: number, stats: ChatStats) => void;
  /**
   * 后端刚建好本轮助手消息的行（回合开跑、还没有任何输出）→ 立刻插进消息流。
   *
   * 首 token 之前隔着建会话 / 起推理服务 / 模型加载 / 长提示词预填充 / 检索，
   * 几秒到几十秒都可能；此前界面要等第一个增量才建得出这条消息，那段时间屏幕上
   * 只有用户刚发出去的那个气泡 —— 看起来就是程序挂了。这一行插进来之后，
   * 对话页的「生成中…」与 Agent 页的「处理中 · N 秒」立刻有了落点。
   * 只认当前会话：后台会话的行等打开时由服务端整份取回。
   */
  beginAssistantMessage: (conversationId: number, messageId: number) => void;
  appendChunk: (
    conversationId: number,
    messageId: number,
    delta: string,
    kind?: "reasoning" | "content",
  ) => void;
  finalizeMessage: (
    conversationId: number,
    messageId: number,
    content: string,
    reasoning?: string,
    citations?: KbCitation[],
  ) => void;
  /** 删除单条消息（并清理它的统计）。 */
  removeMessage: (conversationId: number, messageId: number) => void;
  /** 重新生成：回退到目标消息之前（删除目标消息及之后的本地消息与统计）。 */
  rewindMessages: (conversationId: number, messageId: number) => void;
  upsertConversation: (conversation: Conversation) => void;
  removeConversation: (id: number) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  activeConversationId: null,
  activeMessages: [],
  streaming: false,
  messageStats: {},
  liveStats: {},
  runStartedAt: null,
  contextUsage: {},
  pendingPrompt: null,

  setPendingPrompt: (prompt) => set({ pendingPrompt: prompt }),
  setConversations: (conversations) => set({ conversations }),
  setActiveConversation: (id) => set({ activeConversationId: id }),
  setActiveMessages: (messages) =>
    set((state) => ({
      activeMessages: messages,
      // 只保留仍被当前消息引用的统计，切换会话后自动清理陈旧 id。
      messageStats: Object.fromEntries(
        Object.entries(state.messageStats).filter(
          ([id]) => id !== "prototype" && messages.some((m) => String(m.id) === id),
        ),
      ),
      liveStats: Object.fromEntries(
        Object.entries(state.liveStats).filter(([id]) => messages.some((m) => String(m.id) === id)),
      ),
    })),
  setStreaming: (streaming) =>
    set({
      streaming,
      // 新的轮次开始：记下发出时刻（首 token 耗时的起点）；结束就清掉实时进度。
      runStartedAt: streaming ? Date.now() : null,
      ...(streaming ? {} : { liveStats: {} }),
    }),

  mergeServerMessages: (messages) =>
    set((state) => {
      const serverIds = new Set(messages.map((m) => m.id));
      // 服务端已经收录的同内容用户消息：本地乐观插入的那条（id 是时间戳）要丢掉，
      // 否则界面上会出现两条一样的用户消息。
      const isDuplicatedByServer = (m: ChatMessage) =>
        m.role === "user" && messages.some((s) => s.role === "user" && s.content === m.content);

      const reconcile = (server: ChatMessage): ChatMessage => {
        const local = state.activeMessages.find((m) => m.id === server.id);
        if (!local) return server;
        // 服务端这份更短 = 这条还在流式（正文尚未落库）：保留本地已累积的部分。
        const content = local.content.length > server.content.length ? local.content : server.content;
        const reasoning =
          (local.reasoning?.length ?? 0) > (server.reasoning?.length ?? 0)
            ? local.reasoning
            : server.reasoning;
        if (content === server.content && reasoning === server.reasoning) return server;
        return { ...server, content, reasoning };
      };

      const merged: ChatMessage[] = [];
      for (const server of messages) {
        // 本地独有、且排在它前面的消息（乐观插入的用户消息）按原位插回来。
        const localIndex = state.activeMessages.findIndex((m) => m.id === server.id);
        if (localIndex >= 0) {
          for (const candidate of state.activeMessages.slice(0, localIndex)) {
            if (serverIds.has(candidate.id) || merged.some((m) => m.id === candidate.id)) continue;
            if (isDuplicatedByServer(candidate)) continue;
            merged.push(candidate);
          }
        }
        merged.push(reconcile(server));
      }
      // 服务端列表之后才有的本地消息（刚发出去、还没被服务端返回的）。
      for (const candidate of state.activeMessages) {
        if (serverIds.has(candidate.id) || merged.some((m) => m.id === candidate.id)) continue;
        if (isDuplicatedByServer(candidate)) continue;
        merged.push(candidate);
      }

      return {
        activeMessages: merged,
        // 只保留仍被当前消息引用的统计，切换会话后自动清理陈旧 id。
        messageStats: Object.fromEntries(
          Object.entries(state.messageStats).filter(
            ([id]) => id !== "prototype" && merged.some((m) => String(m.id) === id),
          ),
        ),
        liveStats: Object.fromEntries(
          Object.entries(state.liveStats).filter(([id]) => merged.some((m) => String(m.id) === id)),
        ),
      };
    }),

  setMessageStats: (conversationId, messageId, stats) => {
    if (conversationId !== get().activeConversationId) return;
    set((state) => ({
      messageStats: { ...state.messageStats, [messageId]: stats },
      // Agent 回合会带回上下文占用：留在会话上，切走再切回也还在。
      contextUsage: stats.context
        ? { ...state.contextUsage, [conversationId]: stats.context }
        : state.contextUsage,
    }));
  },

  beginAssistantMessage: (conversationId, messageId) => {
    if (conversationId !== get().activeConversationId) return;
    set((state) => {
      // 已经在了（推送重复到达 / 第一个增量先到）就别再插一条。
      if (state.activeMessages.some((m) => m.id === messageId)) return state;
      return {
        activeMessages: [
          ...state.activeMessages,
          {
            id: messageId,
            conversationId,
            role: "assistant" as const,
            content: "",
            createdAt: Date.now(),
          },
        ],
      };
    });
  },

  appendChunk: (conversationId, messageId, delta, kind = "content") => {
    if (conversationId !== get().activeConversationId) return;
    set((state) => {
      const now = Date.now();
      const parts = tokenParts(delta);
      const previous = state.liveStats[messageId];
      const live: LiveTurnStats = previous
        ? {
            ...previous,
            firstTokenAt: previous.firstTokenAt ?? now,
            ...(kind === "reasoning"
              ? {
                  reasoningCjk: previous.reasoningCjk + parts.cjk,
                  reasoningOther: previous.reasoningOther + parts.other,
                }
              : {
                  contentCjk: previous.contentCjk + parts.cjk,
                  contentOther: previous.contentOther + parts.other,
                }),
          }
        : {
            startedAt: state.runStartedAt ?? now,
            firstTokenAt: now,
            contentCjk: kind === "reasoning" ? 0 : parts.cjk,
            contentOther: kind === "reasoning" ? 0 : parts.other,
            reasoningCjk: kind === "reasoning" ? parts.cjk : 0,
            reasoningOther: kind === "reasoning" ? parts.other : 0,
          };

      const last = state.activeMessages[state.activeMessages.length - 1];
      const activeMessages =
        last?.id === messageId
          ? [
              ...state.activeMessages.slice(0, -1),
              kind === "reasoning"
                ? { ...last, reasoning: (last.reasoning ?? "") + delta }
                : { ...last, content: last.content + delta },
            ]
          : [
              ...state.activeMessages,
              {
                id: messageId,
                conversationId,
                role: "assistant" as const,
                content: kind === "reasoning" ? "" : delta,
                reasoning: kind === "reasoning" ? delta : undefined,
                createdAt: now,
              },
            ];

      return {
        activeMessages,
        liveStats: { ...state.liveStats, [messageId]: live },
      };
    });
  },

  finalizeMessage: (conversationId, messageId, content, reasoning, citations) => {
    if (conversationId !== get().activeConversationId) return;
    set((state) => {
      /**
       * 收尾落到哪一行：正常情况下就是 `messageId` 那一行。但调用方在"还没拿到
       * 真实 id 就失败了"的路径上用时间戳兜底（RPC 抛错 / 后端直接回 ok:false），
       * 而末尾此刻常常正躺着一条开跑时插进来、一个字都还没写的助手行 —— 那就是
       * 这一轮的落点。另起一行的话，界面上会变成"一个空回复 + 一个报错回复"。
       */
      const known = state.activeMessages.some((m) => m.id === messageId);
      const last = state.activeMessages[state.activeMessages.length - 1];
      const target = !known && last?.role === "assistant" && !last.content ? last.id : messageId;
      const messages = state.activeMessages.some((m) => m.id === target)
        ? state.activeMessages.map((m) =>
            m.id === target
              ? {
                  ...m,
                  content,
                  reasoning: reasoning || m.reasoning || undefined,
                  citations: citations && citations.length > 0 ? citations : m.citations,
                }
              : m,
          )
        : [
            ...state.activeMessages,
            {
              id: messageId,
              conversationId,
              role: "assistant" as const,
              content,
              reasoning: reasoning || undefined,
              citations: citations && citations.length > 0 ? citations : undefined,
              createdAt: Date.now(),
            },
          ];
      return {
        activeMessages: messages,
        streaming: false,
        // 收尾统计已经随 chatStats 到了，实时进度留着只会跟正式数字打架。
        liveStats: Object.fromEntries(
          Object.entries(state.liveStats).filter(
            ([id]) => Number(id) !== messageId && Number(id) !== target,
          ),
        ),
      };
    });
  },

  removeMessage: (conversationId, messageId) => {
    if (conversationId !== get().activeConversationId) return;
    set((state) => {
      const messageStats = { ...state.messageStats };
      delete messageStats[messageId];
      const liveStats = { ...state.liveStats };
      delete liveStats[messageId];
      return {
        activeMessages: state.activeMessages.filter((m) => m.id !== messageId),
        messageStats,
        liveStats,
      };
    });
  },

  rewindMessages: (conversationId, messageId) => {
    if (conversationId !== get().activeConversationId) return;
    set((state) => {
      const messageStats = Object.fromEntries(
        Object.entries(state.messageStats).filter(([id]) => Number(id) < messageId),
      );
      const liveStats = Object.fromEntries(
        Object.entries(state.liveStats).filter(([id]) => Number(id) < messageId),
      );
      return {
        activeMessages: state.activeMessages.filter((m) => m.id < messageId),
        messageStats,
        liveStats,
      };
    });
  },

  upsertConversation: (conversation) => {
    set((state) => {
      const exists = state.conversations.some((c) => c.id === conversation.id);
      const conversations = exists
        ? state.conversations.map((c) => (c.id === conversation.id ? conversation : c))
        : [conversation, ...state.conversations];
      return { conversations };
    });
  },

  removeConversation: (id) => {
    set((state) => ({
      conversations: state.conversations.filter((c) => c.id !== id),
      activeConversationId:
        state.activeConversationId === id ? null : state.activeConversationId,
      activeMessages: state.activeConversationId === id ? [] : state.activeMessages,
      messageStats: state.activeConversationId === id ? {} : state.messageStats,
      liveStats: state.activeConversationId === id ? {} : state.liveStats,
    }));
  },
}));
