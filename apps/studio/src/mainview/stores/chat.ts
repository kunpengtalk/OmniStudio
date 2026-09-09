import { create } from "zustand";
import type { Conversation, ChatMessage } from "../../bun/chat";

interface ChatState {
  conversations: Conversation[];
  activeConversationId: number | null;
  activeMessages: ChatMessage[];
  streaming: boolean;
  setConversations: (conversations: Conversation[]) => void;
  setActiveConversation: (id: number | null) => void;
  setActiveMessages: (messages: ChatMessage[]) => void;
  setStreaming: (streaming: boolean) => void;
  appendChunk: (conversationId: number, messageId: number, delta: string) => void;
  finalizeMessage: (
    conversationId: number,
    messageId: number,
    content: string,
  ) => void;
  upsertConversation: (conversation: Conversation) => void;
  removeConversation: (id: number) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  activeConversationId: null,
  activeMessages: [],
  streaming: false,

  setConversations: (conversations) => set({ conversations }),
  setActiveConversation: (id) => set({ activeConversationId: id }),
  setActiveMessages: (messages) => set({ activeMessages: messages }),
  setStreaming: (streaming) => set({ streaming }),

  appendChunk: (conversationId, messageId, delta) => {
    if (conversationId !== get().activeConversationId) return;
    set((state) => {
      const last = state.activeMessages[state.activeMessages.length - 1];
      if (last?.id === messageId) {
        return {
          activeMessages: [
            ...state.activeMessages.slice(0, -1),
            { ...last, content: last.content + delta },
          ],
        };
      }
      return {
        activeMessages: [
          ...state.activeMessages,
          { id: messageId, conversationId, role: "assistant" as const, content: delta, createdAt: Date.now() },
        ],
      };
    });
  },

  finalizeMessage: (conversationId, messageId, content) => {
    if (conversationId !== get().activeConversationId) return;
    set((state) => {
      const exists = state.activeMessages.some((m) => m.id === messageId);
      if (exists) {
        return {
          activeMessages: state.activeMessages.map((m) =>
            m.id === messageId ? { ...m, content } : m,
          ),
          streaming: false,
        };
      }
      return {
        activeMessages: [
          ...state.activeMessages,
          { id: messageId, conversationId, role: "assistant" as const, content, createdAt: Date.now() },
        ],
        streaming: false,
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
    }));
  },
}));