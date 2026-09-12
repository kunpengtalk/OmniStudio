import { create } from "zustand";

import type { ServedModelInfo, ServedModelsSnapshot } from "../../shared/served-models";

/**
 * 已启动模型（多实例）在前端的镜像。
 *
 * 主进程推两份消息：`servedModelsChanged`（整份列表快照）与 `servedModelLog`
 * （按实例 id 的日志增量）。日志用与服务器日志相同的节流批量写入 —— 启动时
 * 每秒几百行，逐行 setState 会把 webview 卡住。
 */
interface ServedState {
  models: ServedModelInfo[];
  activeId: string | null;
  /** 各实例的日志尾巴（控制台里每个模型一个窗口）。 */
  logs: Record<string, string>;
  setSnapshot: (snapshot: ServedModelsSnapshot) => void;
  appendLog: (id: string, text: string) => void;
  clearLog: (id: string) => void;
  setLog: (id: string, logs: string) => void;
}

const MAX_LOG_CHARS = 100_000;
const FLUSH_INTERVAL_MS = 80;

let pending = new Map<string, string[]>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flushPending() {
  flushTimer = null;
  if (pending.size === 0) return;
  const batch = pending;
  pending = new Map();
  useServedStore.getState().commitLogs(batch);
}

function scheduleFlush() {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(flushPending, FLUSH_INTERVAL_MS);
}

export const useServedStore = create<
  ServedState & { commitLogs: (batch: Map<string, string[]>) => void }
>((set) => ({
  models: [],
  activeId: null,
  logs: {},
  setSnapshot: (snapshot) =>
    set((state) => {
      // 卸载掉的实例日志一并清掉，避免下次同名实例（换个端口）看到旧日志。
      const ids = new Set(snapshot.models.map((m) => m.id));
      const logs: Record<string, string> = {};
      for (const [id, text] of Object.entries(state.logs)) {
        if (ids.has(id)) logs[id] = text;
      }
      return { models: snapshot.models, activeId: snapshot.activeId, logs };
    }),
  appendLog: (id, text) => {
    const chunks = pending.get(id);
    if (chunks) chunks.push(text);
    else pending.set(id, [text]);
    scheduleFlush();
  },
  commitLogs: (batch) =>
    set((state) => {
      const logs = { ...state.logs };
      let changed = false;
      for (const [id, chunks] of batch) {
        let next = (logs[id] ?? "") + chunks.join("");
        if (next.length > MAX_LOG_CHARS) next = next.slice(-MAX_LOG_CHARS);
        logs[id] = next;
        changed = true;
      }
      return changed ? { logs } : {};
    }),
  clearLog: (id) =>
    set((state) => {
      pending.delete(id);
      const logs = { ...state.logs };
      delete logs[id];
      return { logs };
    }),
  setLog: (id, text) =>
    set((state) => ({ logs: { ...state.logs, [id]: text } })),
}));
