import { create } from "zustand";
import type { AgentEventRow, AgentMode, AgentSessionView } from "../../bun/agent";
import type { PendingPermission, PendingQuestion } from "../../bun/agent-interactions";
import type { TodoItem } from "../../bun/agent-todos";
import type { AgentGoal } from "../../bun/agent-goals";
import type { ArtifactItem } from "../../bun/agent-artifacts";

type PermissionReply = "once" | "session" | "workspace" | "deny";

/**
 * 后端说"这一轮没在跑"时要等多久才认。
 *
 * 点发送 → 后端登记运行态之间隔着一次 IPC 与建会话（首次运行还要起 agent），
 * 这段时间里后端那份状态仍是"没在跑"。没有宽限窗口的话，正在走的秒数与
 * 停止按钮会在刚发出的一瞬间被清掉，看起来像"卡住后自己停了"。
 */
const RUNNING_CONFIRM_GRACE_MS = 3000;

/**
 * Agent 主区域里的子视图（侧栏底部的「自动化 / 插件」切换，不是一级菜单）。
 *
 * 只剩两个入口是有意的：搜索并进了顶栏的 ⌘K 面板（同一个全文搜索，两个入口没必要），
 * Skills 与应用侧栏的「技能管理」是同一份内容，留在 Agent 里只会让人怀疑两处不一致。
 */
export type AgentSubView = "chat" | "automations" | "plugins";

/**
 * 右侧面板正在预览的对象：产出物（按 id）或工作区文件（相对路径）。
 * HTML 走本地回环文件服务当网页加载，所以预览只需要一个目标描述。
 */
export type AgentPreviewTarget =
  | { source: "artifact"; artifactId: number }
  | { source: "workspace"; path: string; name: string; rootId: string };

/**
 * 右侧面板的页签（对齐参考实现的「打开标签页」）：
 * 产出物 / 审查 / 文件 / 终端 / 浏览器是常驻功能页，产出物与工作区文件各占一个预览页签。
 */
export type AgentPanelTab =
  | { kind: "artifacts" }
  | { kind: "review" }
  | { kind: "files" }
  | { kind: "terminal" }
  | { kind: "browser"; url: string }
  | { kind: "artifact"; artifactId: number }
  | { kind: "workspace-file"; path: string; name: string; rootId: string };

/** 页签身份：同一种预览打开两次就聚焦到已有那个，而不是开一堆重复页签。 */
export function panelTabKey(tab: AgentPanelTab): string {
  switch (tab.kind) {
    case "browser":
      return `browser:${tab.url}`;
    case "artifact":
      return `artifact:${tab.artifactId}`;
    case "workspace-file":
      return `workspace-file:${tab.path}`;
    default:
      return tab.kind;
  }
}

/** 常驻功能页（会持久化到本机；预览页签不持久化）。 */
const PERSISTED_TABS = ["artifacts", "review", "files", "terminal", "browser"] as const;
const PANEL_TABS_KEY = "omni.agent.panelTabs";

function loadPanelTabs(): AgentPanelTab[] {
  try {
    const raw = window.localStorage.getItem(PANEL_TABS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!Array.isArray(parsed)) return [{ kind: "artifacts" }];
    const tabs = parsed
      .filter((kind): kind is (typeof PERSISTED_TABS)[number] =>
        typeof kind === "string" && (PERSISTED_TABS as readonly string[]).includes(kind),
      )
      .map((kind) => (kind === "browser" ? { kind, url: "" } : { kind })) as AgentPanelTab[];
    return tabs.length > 0 ? tabs : [{ kind: "artifacts" }];
  } catch {
    return [{ kind: "artifacts" }];
  }
}

function savePanelTabs(tabs: AgentPanelTab[]): void {
  try {
    const kinds = tabs.map((tab) => tab.kind).filter((kind) => (PERSISTED_TABS as readonly string[]).includes(kind));
    window.localStorage.setItem(PANEL_TABS_KEY, JSON.stringify(kinds));
  } catch {
    // 存不下就只在本次会话里生效
  }
}

/** 右侧产出物面板的宽度范围与默认值（拖动分隔条调整，本机记住）。 */
export const PANEL_MIN_WIDTH = 300;
export const PANEL_MAX_WIDTH = 1600;
export const PANEL_DEFAULT_WIDTH = 340;
const PANEL_WIDTH_KEY = "omni.agent.panelWidth";

function loadPanelWidth(): number {
  try {
    const raw = window.localStorage.getItem(PANEL_WIDTH_KEY);
    const value = Number(raw);
    if (Number.isFinite(value) && value >= PANEL_MIN_WIDTH && value <= PANEL_MAX_WIDTH) {
      return Math.round(value);
    }
  } catch {
    // 隐私模式 / 无 localStorage：用默认宽度
  }
  return PANEL_DEFAULT_WIDTH;
}

type AgentState = {
  /** 当前会话的 Agent 运行轨迹（工具调用 / 状态 / 错误）。 */
  events: AgentEventRow[];
  /** Agent 是否正在运行（区别于 chat store 的 streaming：一次运行含多轮工具循环）。 */
  running: boolean;
  /**
   * `running` 最近一次置 true 的时刻。
   * 刚点发送的那几十毫秒里请求还在路上，后端的运行集合尚未登记 —— 此时若把
   * 后端那份"没在跑"当真，按钮和进度行会闪一下再回来，所以留一个确认宽限窗口。
   */
  runningSince: number | null;
  /** 后端已经确认过"这一轮在跑"（收到过 running = true），宽限窗口随之失效。 */
  runningConfirmed: boolean;
  /** 当前会话 id，用于忽略其它会话推送过来的事件。 */
  conversationId: number | null;
  mode: AgentMode;
  workspace: string;
  /** 当前工作区是否用的默认目录（~/.omnistudio/workspace）。 */
  workspaceIsDefault: boolean;
  /** 会话列表（侧栏）。 */
  sessions: AgentSessionView[];
  /** 待办清单（输入框上方的进度面板）。 */
  todos: TodoItem[];
  /** 当前目标（Goal 模式；没有目标时为 null）。 */
  goal: (AgentGoal & { maxContinuations: number }) | null;
  /** 当前方案（Plan 模式；方案正文不进 store，避免每次渲染携带一大段文本）。 */
  plan: { approvedAt: number | null; chars: number } | null;
  /** 会话产出物（右侧面板）。 */
  artifacts: ArtifactItem[];
  /** 挂起的工具授权请求（弹窗）；一次只显示最早的那个。 */
  permissions: PendingPermission[];
  /** 挂起的 ask_user 提问（弹窗）。 */
  questions: PendingQuestion[];
  /** 右侧产出物面板是否展开。 */
  panelOpen: boolean;
  /** 右侧面板宽度（px）。 */
  panelWidth: number;
  /** 右侧面板正在预览的对象（为空 = 显示列表）。 */
  preview: AgentPreviewTarget | null;
  /** 右侧面板打开的页签与当前页签。 */
  panelTabs: AgentPanelTab[];
  activeTabIndex: number;
  /** 「+」页签选择器是否展开。 */
  addMenuOpen: boolean;
  /** 后台跑完、用户还没看过的会话（侧栏显示未读点）。 */
  unread: number[];
  /** 当前子视图；chat = 正常对话。 */
  subView: AgentSubView;
  /**
   * ⌘K 会话搜索是否打开。放在 store 而不是某个组件的 state 里，是因为它有两个
   * 触发点（顶部搜索按钮、全局快捷键），而快捷键监听挂在会话层、按钮在顶栏。
   */
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
  setEvents: (events: AgentEventRow[]) => void;
  setConversationId: (id: number | null) => void;
  setRunning: (running: boolean) => void;
  /**
   * 后端推来 / 查到的运行态（**权威**）。与 setRunning 的区别有两点：
   * 1. 只认当前会话 —— 后台会话的推送不能改写这一刻界面上显示的状态；
   * 2. 说"没在跑"时留一个宽限窗口，避免把刚发出、还没登记的那一轮误判成结束。
   */
  setRunningFor: (conversationId: number, running: boolean) => void;
  setMode: (mode: AgentMode) => void;
  setWorkspace: (workspace: string) => void;
  setWorkspaceIsDefault: (isDefault: boolean) => void;
  /**
   * `/model` 切换失败的提示（成功时置空）。只放内存：它是一次操作的反馈，
   * 不是会话状态 —— 真正的"当前模型"由设置里的 CHAT_MODEL / VLLM_MODEL_NAME 决定。
   */
  modelNotice: string | null;
  setModelNotice: (notice: string | null) => void;
  /** `/compact` 的一次性反馈（裁了多少 / 为什么没裁）。与模型提示同理，只放内存。 */
  compactNotice: string | null;
  setCompactNotice: (notice: string | null) => void;
  setSessions: (sessions: AgentSessionView[]) => void;
  setTodos: (todos: TodoItem[]) => void;
  setGoal: (goal: (AgentGoal & { maxContinuations: number }) | null) => void;
  setPlan: (plan: { approvedAt: number | null; chars: number } | null) => void;
  setArtifacts: (artifacts: ArtifactItem[]) => void;
  setPermissions: (permissions: PendingPermission[]) => void;
  setQuestions: (questions: PendingQuestion[]) => void;
  upsertPermission: (permission: PendingPermission) => void;
  settlePermission: (id: string) => void;
  upsertQuestion: (question: PendingQuestion) => void;
  settleQuestion: (id: string) => void;
  appendArtifact: (artifact: ArtifactItem) => void;
  setPanelOpen: (open: boolean) => void;
  setPanelWidth: (width: number) => void;
  setPreview: (preview: AgentPreviewTarget | null) => void;
  /** 打开（或聚焦）一个页签；预览类页签同目标只保留一个。 */
  openPanelTab: (tab: AgentPanelTab) => void;
  setAddMenuOpen: (open: boolean) => void;
  closePanelTab: (index: number) => void;
  setActiveTabIndex: (index: number) => void;
  /** 常驻功能页当前是否已经打开（"+" 选择器里打勾用）。 */
  hasPanelTab: (kind: AgentPanelTab["kind"]) => boolean;
  /** 关掉所有预览页签（切会话 / 关闭预览时用）。 */
  closePreviewTabs: () => void;
  setSubView: (view: AgentSubView) => void;
  markUnread: (conversationId: number) => void;
  clearUnread: (conversationId: number) => void;
  appendEvent: (event: AgentEventRow) => void;
  /**
   * 轨迹**增量**合并（按 id 去重、按 id 排序）。
   *
   * 与 `appendEvent`（推送单条）分开是因为两者的来源可靠性不同：推送会丢
   * （窗口被系统节流 / webview 刷新过），追平用的是库里的事实。跑动中界面定期
   * 按 `afterId` 取一次新事件，用这里并进列表 —— 重复到达的那几条不会渲染两遍。
   */
  mergeEvents: (events: AgentEventRow[]) => void;
  clear: () => void;
};

export const useAgentStore = create<AgentState>((set, get) => ({
  events: [],
  running: false,
  runningSince: null,
  runningConfirmed: false,
  conversationId: null,
  mode: "agent",
  workspace: "",
  workspaceIsDefault: true,
  sessions: [],
  todos: [],
  goal: null,
  plan: null,
  artifacts: [],
  permissions: [],
  questions: [],
  panelOpen: false,
  panelWidth: loadPanelWidth(),
  preview: null,
  panelTabs: loadPanelTabs(),
  activeTabIndex: 0,
  addMenuOpen: false,
  unread: [],
  subView: "chat",
  searchOpen: false,
  setSearchOpen: (searchOpen) => set({ searchOpen }),

  setEvents: (events) => set({ events }),
  setConversationId: (conversationId) =>
    // 只在真正切换会话时清空轨迹与交互：进入页面时子组件可能已经先把事件塞进来了。
    set((state) =>
      state.conversationId === conversationId
        ? state
        : {
            conversationId,
            events: [],
            // 运行态跟着会话走：上一个会话还在跑，不代表这个会话也在跑。
            // 清在这里（而不是页面上的一个 effect）是为了让"打开会话时按后端补齐状态"
            // 一定跑在它后面 —— 两个 effect 抢着写同一个字段，先后顺序就决定了对错。
            running: false,
            runningSince: null,
            runningConfirmed: false,
            todos: [],
            goal: null,
            plan: null,
            artifacts: [],
            permissions: [],
            questions: [],
            // 预览跟着会话走：不然切过去还停在上一个会话的产物上。
            // 常驻功能页（产出物 / 审查 / 文件 / 终端 / 浏览器）保留。
            preview: null,
            panelTabs: state.panelTabs.filter(
              (tab) => tab.kind !== "artifact" && tab.kind !== "workspace-file",
            ),
            activeTabIndex: Math.min(
              state.activeTabIndex,
              Math.max(
                0,
                state.panelTabs.filter((tab) => tab.kind !== "artifact" && tab.kind !== "workspace-file")
                  .length - 1,
              ),
            ),
          },
    ),
  setRunning: (running) =>
    set({ running, runningSince: running ? Date.now() : null, runningConfirmed: false }),

  setRunningFor: (conversationId, running) => {
    if (get().conversationId !== conversationId) return;
    if (running) {
      set((state) => ({ running: true, runningConfirmed: true, runningSince: state.runningSince ?? Date.now() }));
      return;
    }
    // 后端确认过这一轮在跑：这次说停就是真停了（短回合在宽限窗口内跑完也不会被当成"还没登记"）。
    const since = get().runningSince;
    const unconfirmed = !get().runningConfirmed && since != null && Date.now() - since < RUNNING_CONFIRM_GRACE_MS;
    if (unconfirmed) return;
    set({ running: false, runningSince: null, runningConfirmed: false });
  },
  setMode: (mode) => set({ mode }),
  setWorkspace: (workspace) => set({ workspace }),
  setWorkspaceIsDefault: (workspaceIsDefault) => set({ workspaceIsDefault }),
  modelNotice: null,
  setModelNotice: (modelNotice) => set({ modelNotice }),
  compactNotice: null,
  setCompactNotice: (compactNotice) => set({ compactNotice }),
  setSessions: (sessions) => set({ sessions }),
  setTodos: (todos) => set({ todos }),
  setGoal: (goal) => set({ goal }),
  setPlan: (plan) => set({ plan }),
  setArtifacts: (artifacts) => set({ artifacts }),
  setPermissions: (permissions) => set({ permissions }),
  setQuestions: (questions) => set({ questions }),

  upsertPermission: (permission) => {
    if (get().conversationId !== permission.conversationId) return;
    set((state) => ({
      permissions: [...state.permissions.filter((item) => item.id !== permission.id), permission].sort(
        (a, b) => a.createdAt - b.createdAt,
      ),
    }));
  },
  settlePermission: (id) =>
    set((state) => ({ permissions: state.permissions.filter((item) => item.id !== id) })),

  upsertQuestion: (question) => {
    if (get().conversationId !== question.conversationId) return;
    set((state) => ({
      questions: [...state.questions.filter((item) => item.id !== question.id), question],
    }));
  },
  settleQuestion: (id) =>
    set((state) => ({ questions: state.questions.filter((item) => item.id !== id) })),

  appendArtifact: (artifact) => {
    if (get().conversationId !== artifact.conversationId) return;
    set((state) => ({
      artifacts: [artifact, ...state.artifacts.filter((item) => item.id !== artifact.id)],
      // 有新产出时自动把面板亮出来：让用户看到 agent 到底产出了什么。
      panelOpen: true,
      // HTML 是"给人看的成果"，直接推到预览位——生成完就能看到页面，不用再点一次。
      preview:
        artifact.kind === "html" ? { source: "artifact", artifactId: artifact.id } : state.preview,
    }));
  },

  setPanelOpen: (panelOpen) => set({ panelOpen }),

  // 兼容入口：消息里的「打开」按钮与产出物自动预览都走这里，落到预览页签上。
  setPreview: (preview) => {
    if (!preview) {
      get().closePreviewTabs();
      return;
    }
    if (preview.source === "artifact") {
      get().openPanelTab({ kind: "artifact", artifactId: preview.artifactId });
    } else {
      get().openPanelTab({
        kind: "workspace-file",
        path: preview.path,
        name: preview.name,
        rootId: preview.rootId,
      });
    }
  },

  setAddMenuOpen: (addMenuOpen) => set({ addMenuOpen }),

  openPanelTab: (tab) =>
    set((state) => {
      const key = panelTabKey(tab);
      const existing = state.panelTabs.findIndex((item) => panelTabKey(item) === key);
      if (existing >= 0) return { activeTabIndex: existing, panelOpen: true };
      const panelTabs = [...state.panelTabs, tab];
      savePanelTabs(panelTabs);
      return { panelTabs, activeTabIndex: panelTabs.length - 1, panelOpen: true };
    }),

  closePanelTab: (index) =>
    set((state) => {
      const panelTabs = state.panelTabs.filter((_, i) => i !== index);
      savePanelTabs(panelTabs);
      // 关掉当前页签时焦点落到左边那个（跟浏览器一致）。
      const activeTabIndex = Math.max(0, Math.min(state.activeTabIndex > index ? state.activeTabIndex - 1 : state.activeTabIndex, Math.max(0, panelTabs.length - 1)));
      return { panelTabs, activeTabIndex };
    }),

  setActiveTabIndex: (activeTabIndex) =>
    set((state) => ({ activeTabIndex: Math.max(0, Math.min(activeTabIndex, state.panelTabs.length - 1)) })),

  hasPanelTab: (kind) => get().panelTabs.some((tab) => tab.kind === kind),

  closePreviewTabs: () =>
    set((state) => {
      const panelTabs = state.panelTabs.filter(
        (tab) => tab.kind !== "artifact" && tab.kind !== "workspace-file",
      );
      const activeTabIndex = Math.min(state.activeTabIndex, Math.max(0, panelTabs.length - 1));
      return { panelTabs, activeTabIndex, preview: null };
    }),

  setPanelWidth: (width) => {
    const next = Math.round(Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, width)));
    set({ panelWidth: next });
    try {
      window.localStorage.setItem(PANEL_WIDTH_KEY, String(next));
    } catch {
      // 存不下就只在本次会话里生效
    }
  },

  setSubView: (subView) => set({ subView }),

  markUnread: (conversationId) =>
    set((state) =>
      state.unread.includes(conversationId) ? state : { unread: [...state.unread, conversationId] },
    ),
  clearUnread: (conversationId) =>
    set((state) => ({ unread: state.unread.filter((id) => id !== conversationId) })),

  appendEvent: (event) => {
    // 只跟随当前打开的会话，避免后台会话的事件串进来。
    if (get().conversationId !== event.conversationId) return;
    set((state) => ({ events: [...state.events, event] }));
  },

  mergeEvents: (incoming) => {
    if (incoming.length === 0) return;
    set((state) => {
      // 同上：追平结果也按会话过滤（切会话那一刻在途的这次追平不能写进新会话）。
      const fresh = incoming.filter((event) => event.conversationId === state.conversationId);
      if (fresh.length === 0) return state;
      const known = new Set(state.events.map((event) => event.id));
      const added = fresh.filter((event) => !known.has(event.id));
      if (added.length === 0) return state;
      return { events: [...state.events, ...added].sort((a, b) => a.id - b.id) };
    });
  },

  clear: () =>
    set({
      events: [],
      running: false,
      runningSince: null,
      runningConfirmed: false,
      todos: [],
      goal: null,
      plan: null,
      artifacts: [],
      permissions: [],
      questions: [],
    }),
}));

export type { PermissionReply };
