import { create } from "zustand";
import type { Conversation, ChatMessage, ChatStats } from "../../bun/chat";
import type { KbCitation } from "../../shared/knowledge";

interface ChatState {
  conversations: Conversation[];
  activeConversationId: number | null;
  activeMessages: ChatMessage[];
  streaming: boolean;
  /** 会话内本次运行生成的 token 统计，按消息 id 索引（重新生成/翻译后旧 id 失效被清理）。 */
  messageStats: Record<number, ChatStats>;
  /** 提示词库「去试试」带过来的草稿，ChatWindow 挂载时读入输入框。 */
  pendingPrompt: string | null;
  setPendingPrompt: (prompt: string | null) => void;
  setConversations: (conversations: Conversation[]) => void;
  setActiveConversation: (id: number | null) => void;
  setActiveMessages: (messages: ChatMessage[]) => void;
  setStreaming: (streaming: boolean) => void;
  setMessageStats: (conversationId: number, messageId: number, stats: ChatStats) => void;
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
    })),
  setStreaming: (streaming) => set({ streaming }),

  setMessageStats: (conversationId, messageId, stats) => {
    if (conversationId !== get().activeConversationId) return;
    set((state) => ({ messageStats: { ...state.messageStats, [messageId]: stats } }));
  },

  appendChunk: (conversationId, messageId, delta, kind = "content") => {
    if (conversationId !== get().activeConversationId) return;
    set((state) => {
      const last = state.activeMessages[state.activeMessages.length - 1];
      if (last?.id === messageId) {
        return {
          activeMessages: [
            ...state.activeMessages.slice(0, -1),
            kind === "reasoning"
              ? { ...last, reasoning: (last.reasoning ?? "") + delta }
              : { ...last, content: last.content + delta },
          ],
        };
      }
      return {
        activeMessages: [
          ...state.activeMessages,
          {
            id: messageId,
            conversationId,
            role: "assistant" as const,
            content: kind === "reasoning" ? "" : delta,
            reasoning: kind === "reasoning" ? delta : undefined,
            createdAt: Date.now(),
          },
        ],
      };
    });
  },

  finalizeMessage: (conversationId, messageId, content, reasoning, citations) => {
    if (conversationId !== get().activeConversationId) return;
    set((state) => {
      const exists = state.activeMessages.some((m) => m.id === messageId);
      const messages = exists
        ? state.activeMessages.map((m) =>
            m.id === messageId
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
      return { activeMessages: messages, streaming: false };
    });
  },

  removeMessage: (conversationId, messageId) => {
    if (conversationId !== get().activeConversationId) return;
    set((state) => {
      const messageStats = { ...state.messageStats };
      delete messageStats[messageId];
      return {
        activeMessages: state.activeMessages.filter((m) => m.id !== messageId),
        messageStats,
      };
    });
  },

  rewindMessages: (conversationId, messageId) => {
    if (conversationId !== get().activeConversationId) return;
    set((state) => {
      const messageStats = Object.fromEntries(
        Object.entries(state.messageStats).filter(([id]) => Number(id) < messageId),
      );
      return {
        activeMessages: state.activeMessages.filter((m) => m.id < messageId),
        messageStats,
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
    }));
  },
}));
