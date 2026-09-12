import { create } from "zustand";

/**
 * 侧边面板的终端会话状态。
 *
 * 输出既进 `pending`（喂给 xterm 的增量，取走即清空），也进 `buffer`（回放用）：
 * 面板切走再切回来时 xterm 会重新挂载，先用 buffer 把屏幕填回去，
 * 不会出现"终端一片空白、但后端 shell 还活着"的错位。
 */
export type TerminalSessionState = {
  id: string;
  cwd: string;
  shell: string;
  running: boolean;
  exitCode: number | null;
  /** 待写入 xterm 的增量（取走后清空）。 */
  pending: string;
  /** 最近输出（重挂载回放）。 */
  buffer: string;
};

type OutputListener = (data: string) => void;

/**
 * 输出直通：终端每秒可能刷几十次，走 React state 会让整个面板跟着重渲染
 * （xterm 自己写屏幕就够了，界面不需要因为一行日志重建）。
 * 组件挂载时订阅，把增量直接写进 xterm；store 里只留回放缓冲与状态。
 */
const outputListeners = new Map<string, Set<OutputListener>>();

type TerminalState = {
  sessions: Record<string, TerminalSessionState>;
  upsert: (session: { id: string; cwd: string; shell: string; scrollback?: string }) => void;
  appendOutput: (id: string, data: string) => void;
  takeOutput: (id: string) => string;
  /** 订阅某个会话的输出增量（返回退订函数）。 */
  subscribeOutput: (id: string, listener: OutputListener) => () => void;
  markExited: (id: string, exitCode: number) => void;
  remove: (id: string) => void;
};

const MAX_BUFFER = 200_000;

export const useTerminalStore = create<TerminalState>((set, get) => ({
  sessions: {},

  upsert: (session) =>
    set((state) => {
      const existing = state.sessions[session.id];
      return {
        sessions: {
          ...state.sessions,
          [session.id]: {
            id: session.id,
            cwd: session.cwd,
            shell: session.shell,
            running: true,
            exitCode: null,
            // 已经有会话时保留缓冲与待写增量（重复 upsert 不能把屏幕内容弄丢）。
            pending: existing?.pending ?? "",
            buffer: existing?.buffer ?? session.scrollback ?? "",
          },
        },
      };
    }),

  appendOutput: (id, data) => {
    const listeners = outputListeners.get(id);
    if (listeners && listeners.size > 0) {
      // 有组件在看：直接给它，不进 React 状态（pending 只留给没订阅的场景）。
      for (const listener of listeners) {
        try {
          listener(data);
        } catch {
          // 单个订阅者出错不影响其它订阅者
        }
      }
    }
    set((state) => {
      const existing = state.sessions[id];
      if (!existing) return state;
      const buffered = listeners && listeners.size > 0 ? existing.pending : existing.pending + data;
      return {
        sessions: {
          ...state.sessions,
          [id]: {
            ...existing,
            pending: buffered.slice(-MAX_BUFFER),
            buffer: (existing.buffer + data).slice(-MAX_BUFFER),
          },
        },
      };
    });
  },

  subscribeOutput: (id, listener) => {
    const set_ = outputListeners.get(id) ?? new Set<OutputListener>();
    set_.add(listener);
    outputListeners.set(id, set_);
    return () => {
      set_.delete(listener);
      if (set_.size === 0) outputListeners.delete(id);
    };
  },

  takeOutput: (id) => {
    const existing = get().sessions[id];
    if (!existing?.pending) return "";
    const data = existing.pending;
    set((state) => ({
      sessions: { ...state.sessions, [id]: { ...existing, pending: "" } },
    }));
    return data;
  },

  markExited: (id, exitCode) =>
    set((state) => {
      const existing = state.sessions[id];
      if (!existing) return state;
      return {
        sessions: { ...state.sessions, [id]: { ...existing, running: false, exitCode } },
      };
    }),

  remove: (id) => {
    outputListeners.delete(id);
    set((state) => {
      const sessions = { ...state.sessions };
      delete sessions[id];
      return { sessions };
    });
  },
}));
