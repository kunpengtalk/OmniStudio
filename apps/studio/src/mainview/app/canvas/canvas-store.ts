/**
 * 无限画布的状态（zustand）。
 *
 * 画布是"编辑器型"界面：节点 / 连线 / 视口全程高频变动，不能走 TanStack Query
 * 的逐记录缓存（与聊天流式走 store 同一个理由）。整份载荷按 rev 变更计数由
 * 画布页防抖保存（canvasSaveDoc），主进程只做校验落库（bun/canvas.ts）。
 *
 * 文本生成的流式增量（canvasTextChunk 推送）直接写进这里 —— 推送在 webview
 * 加载早期就可能到达（生成中途刷新页面），所以 applyTextChunk 对未知节点
 * 幂等跳过，不崩、不重建幽灵节点。
 */
import { create } from "zustand";

import {
  CANVAS_DEFAULT_VIEWPORT,
  CANVAS_NODE_DEFAULTS,
  type CanvasConnectionData,
  type CanvasDocPayload,
  type CanvasNodeData,
  type CanvasNodeKind,
  type CanvasNodeStatus,
  type CanvasTextChunkEvent,
  type CanvasViewport,
} from "@/shared/canvas";

function uid(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

type CanvasState = {
  docId: number | null;
  title: string;
  nodes: CanvasNodeData[];
  connections: CanvasConnectionData[];
  viewport: CanvasViewport;
  /** 选中的节点 id（数组以支持多选拖动 / 批量删除）。 */
  selection: string[];
  selectedConnectionId: string | null;
  /** 载荷版本号：任何变更 +1，画布页据此防抖保存。 */
  rev: number;
  loading: boolean;
  /** 撤销栈 / 重做栈（只含节点与连线；视口与选择不进历史）。 */
  canUndo: boolean;
  canRedo: boolean;

  setDoc: (doc: { id: number; title: string; payload: CanvasDocPayload }) => void;
  clearDoc: () => void;
  setLoading: (loading: boolean) => void;
  setTitle: (title: string) => void;

  /** 在一次成批变更前快照当前节点 / 连线（拖拽起手 force，其余按时间窗节流）。 */
  markHistory: (force?: boolean) => void;
  undo: () => void;
  redo: () => void;

  addNode: (kind: CanvasNodeKind, x: number, y: number, title: string) => string;
  /** 面板编辑用：按时间窗节流记历史。 */
  updateNode: (id: string, patch: Partial<CanvasNodeData>) => void;
  /** 拖拽 / 缩放手势内部用：手势本身已记过历史，逐帧更新不再记。 */
  updateNodeTransient: (id: string, patch: Partial<CanvasNodeData>) => void;
  setNodeStatus: (id: string, status: CanvasNodeStatus, error?: string) => void;
  removeNodes: (ids: string[]) => void;

  addConnection: (fromId: string, toId: string) => void;
  removeConnection: (id: string) => void;

  select: (ids: string[], additive?: boolean) => void;
  selectConnection: (id: string | null) => void;

  setViewport: (viewport: CanvasViewport) => void;

  applyTextChunk: (event: CanvasTextChunkEvent) => void;
};

type HistorySnapshot = { nodes: CanvasNodeData[]; connections: CanvasConnectionData[] };

const HISTORY_LIMIT = 50;
const HISTORY_THROTTLE_MS = 600;

const bump = (state: CanvasState) => ({ rev: state.rev + 1 });

export const useCanvasStore = create<CanvasState>((set, get) => {
  /** 模块级历史栈：不进 React 渲染路径，canUndo/canRedo 作为派生布尔暴露。 */
  let past: HistorySnapshot[] = [];
  let future: HistorySnapshot[] = [];
  let lastMarkAt = 0;

  const snapshot = (): HistorySnapshot => {
    const s = get();
    return { nodes: s.nodes, connections: s.connections };
  };
  const setHistoryFlags = () => set({ canUndo: past.length > 0, canRedo: future.length > 0 });

  return {
    docId: null,
    title: "",
    nodes: [],
    connections: [],
    viewport: CANVAS_DEFAULT_VIEWPORT,
    selection: [],
    selectedConnectionId: null,
    rev: 0,
    loading: false,
    canUndo: false,
    canRedo: false,

  setDoc: ({ id, title, payload }) =>
    set((state) => ({
      docId: id,
      title,
      // 刷新 / 切换文档后残留的 loading 不会恢复（流是进程内会话），复位成 idle
      // 让用户直接重新生成，而不是看着一个永远转圈的节点。
      nodes: payload.nodes.map((n) => (n.status === "loading" ? { ...n, status: "idle" as const } : n)),
      connections: payload.connections,
      viewport: payload.viewport ?? CANVAS_DEFAULT_VIEWPORT,
      selection: [],
      selectedConnectionId: null,
      rev: state.rev + 1,
      loading: false,
    })),
  setLoading: (loading) => set({ loading }),
  /** 卸载当前文档（docId=null）：主屏的加载 effect 会自动补上最近一份。 */
  clearDoc: () => {
    past = [];
    future = [];
    setHistoryFlags();
    set((state) => ({
      docId: null,
      title: "",
      nodes: [],
      connections: [],
      viewport: CANVAS_DEFAULT_VIEWPORT,
      selection: [],
      selectedConnectionId: null,
      rev: state.rev + 1,
      loading: false,
    }));
  },
  setTitle: (title) => set((state) => ({ title, ...bump(state) })),

  markHistory: (force) => {
    const now = Date.now();
    if (!force && now - lastMarkAt < HISTORY_THROTTLE_MS) return;
    lastMarkAt = now;
    past = [...past.slice(-(HISTORY_LIMIT - 1)), snapshot()];
    future = [];
    setHistoryFlags();
  },

  undo: () => {
    const prev = past[past.length - 1];
    if (!prev) return;
    past = past.slice(0, -1);
    future = [...future, snapshot()];
    lastMarkAt = 0;
    set((state) => ({
      nodes: prev.nodes,
      connections: prev.connections,
      selection: [],
      selectedConnectionId: null,
      ...bump(state),
    }));
    setHistoryFlags();
  },

  redo: () => {
    const next = future[future.length - 1];
    if (!next) return;
    future = future.slice(0, -1);
    past = [...past, snapshot()];
    lastMarkAt = 0;
    set((state) => ({
      nodes: next.nodes,
      connections: next.connections,
      selection: [],
      selectedConnectionId: null,
      ...bump(state),
    }));
    setHistoryFlags();
  },

  addNode: (kind, x, y, title) => {
    const id = uid("n");
    const size = CANVAS_NODE_DEFAULTS[kind];
    get().markHistory(true);
    set((state) => ({
      nodes: [
        ...state.nodes,
        {
          id,
          kind,
          title,
          x,
          y,
          width: size.width,
          height: size.height,
          prompt: "",
          status: "idle" as CanvasNodeStatus,
          updatedAt: Date.now(),
        },
      ],
      selection: [id],
      selectedConnectionId: null,
      ...bump(state),
    }));
    return id;
  },

  updateNode: (id, patch) => {
    get().markHistory();
    set((state) => ({
      nodes: state.nodes.map((n) => (n.id === id ? { ...n, ...patch, updatedAt: Date.now() } : n)),
      ...bump(state),
    }));
  },

  updateNodeTransient: (id, patch) =>
    set((state) => ({
      nodes: state.nodes.map((n) => (n.id === id ? { ...n, ...patch, updatedAt: Date.now() } : n)),
      ...bump(state),
    })),

  setNodeStatus: (id, status, error) =>
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id
          ? {
              ...n,
              status,
              error: error ?? (status === "error" ? n.error : undefined),
              updatedAt: Date.now(),
            }
          : n,
      ),
      ...bump(state),
    })),

  removeNodes: (ids) => {
    get().markHistory(true);
    set((state) => {
      const dead = new Set(ids);
      return {
        nodes: state.nodes.filter((n) => !dead.has(n.id)),
        // 连线随端点删除：悬空连线既画不出来，也会在保存时被主进程过滤掉。
        connections: state.connections.filter((c) => !dead.has(c.fromId) && !dead.has(c.toId)),
        selection: state.selection.filter((id) => !dead.has(id)),
        selectedConnectionId: null,
        ...bump(state),
      };
    });
  },

  addConnection: (fromId, toId) => {
    get().markHistory(true);
    set((state) => {
      if (fromId === toId) return state;
      const exists = state.connections.some((c) => c.fromId === fromId && c.toId === toId);
      if (exists) return state;
      return {
        connections: [...state.connections, { id: uid("c"), fromId, toId }],
        ...bump(state),
      };
    });
  },

  removeConnection: (id) => {
    get().markHistory(true);
    set((state) => ({
      connections: state.connections.filter((c) => c.id !== id),
      selectedConnectionId: null,
      ...bump(state),
    }));
  },

  select: (ids, additive) =>
    set((state) => ({
      selection: additive ? Array.from(new Set([...state.selection, ...ids])) : ids,
      selectedConnectionId: null,
    })),

  selectConnection: (id) => set({ selection: [], selectedConnectionId: id }),

  setViewport: (viewport) => set((state) => ({ viewport, ...bump(state) })),

  applyTextChunk: (event) =>
    set((state) => {
      const node = state.nodes.find((n) => n.id === event.nodeId);
      if (!node) return state;
      const resultText = (node.resultText ?? "") + event.delta;
      return {
        nodes: state.nodes.map((n) =>
          n.id === event.nodeId
            ? {
                ...n,
                resultText,
                status: event.done ? (event.error ? ("error" as const) : ("success" as const)) : ("loading" as const),
                error: event.error,
                recordId: undefined,
                updatedAt: Date.now(),
              }
            : n,
        ),
        ...bump(state),
      };
    }),
  };
});

/** 上游节点（连线指向 nodeId 的那些）。生成执行与连线绘制共用。 */
export function upstreamNodesOf(nodes: CanvasNodeData[], connections: CanvasConnectionData[], nodeId: string): CanvasNodeData[] {
  const ids = new Set(connections.filter((c) => c.toId === nodeId).map((c) => c.fromId));
  return nodes.filter((n) => ids.has(n.id));
}
