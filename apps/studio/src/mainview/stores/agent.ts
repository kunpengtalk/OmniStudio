import { create } from "zustand";
import type { AgentEventRow, AgentMode } from "../../bun/agent";

type AgentState = {
  /** 当前会话的 Agent 运行轨迹（工具调用 / 状态 / 错误）。 */
  events: AgentEventRow[];
  /** Agent 是否正在运行（区别于 chat store 的 streaming：一次运行含多轮工具循环）。 */
  running: boolean;
  /** 当前会话 id，用于忽略其它会话推送过来的事件。 */
  conversationId: number | null;
  mode: AgentMode;
  workspace: string;
  /** 当前工作区是否用的默认目录（~/.omnistudio/workspace）。 */
  workspaceIsDefault: boolean;
  setEvents: (events: AgentEventRow[]) => void;
  setConversationId: (id: number | null) => void;
  setRunning: (running: boolean) => void;
  setMode: (mode: AgentMode) => void;
  setWorkspace: (workspace: string) => void;
  setWorkspaceIsDefault: (isDefault: boolean) => void;
  appendEvent: (event: AgentEventRow) => void;
  clear: () => void;
};

export const useAgentStore = create<AgentState>((set, get) => ({
  events: [],
  running: false,
  conversationId: null,
  mode: "agent",
  workspace: "",
  workspaceIsDefault: true,

  setEvents: (events) => set({ events }),
  setConversationId: (conversationId) =>
    // 只在真正切换会话时清空轨迹：进入页面时子组件可能已经先把事件塞进来了。
    set((state) =>
      state.conversationId === conversationId ? state : { conversationId, events: [] },
    ),
  setRunning: (running) => set({ running }),
  setMode: (mode) => set({ mode }),
  setWorkspace: (workspace) => set({ workspace }),
  setWorkspaceIsDefault: (workspaceIsDefault) => set({ workspaceIsDefault }),

  appendEvent: (event) => {
    // 只跟随当前打开的会话，避免后台会话的事件串进来。
    if (get().conversationId !== event.conversationId) return;
    set((state) => ({ events: [...state.events, event] }));
  },

  clear: () => set({ events: [], running: false }),
}));
