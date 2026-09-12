import { create } from "zustand";
import type { AgentEventRow, AgentMode, AgentSessionView } from "../../bun/agent";
import type { PendingPermission, PendingQuestion } from "../../bun/agent-interactions";
import type { TodoItem } from "../../bun/agent-todos";
import type { ArtifactItem } from "../../bun/agent-artifacts";

type PermissionReply = "once" | "session" | "workspace" | "deny";

/** Agent 主区域里的子视图（侧栏「搜索 / 自动化 / 插件 / Skills」切换，不是一级菜单）。 */
export type AgentSubView = "chat" | "search" | "automations" | "plugins" | "skills";

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
  setEvents: (events: AgentEventRow[]) => void;
  setConversationId: (id: number | null) => void;
  setRunning: (running: boolean) => void;
  setMode: (mode: AgentMode) => void;
  setWorkspace: (workspace: string) => void;
  setWorkspaceIsDefault: (isDefault: boolean) => void;
  setSessions: (sessions: AgentSessionView[]) => void;
  setTodos: (todos: TodoItem[]) => void;
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
  clear: () => void;
};

export const useAgentStore = create<AgentState>((set, get) => ({
  events: [],
  running: false,
  conversationId: null,
  mode: "agent",
  workspace: "",
  workspaceIsDefault: true,
  sessions: [],
  todos: [],
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

  setEvents: (events) => set({ events }),
  setConversationId: (conversationId) =>
    // 只在真正切换会话时清空轨迹与交互：进入页面时子组件可能已经先把事件塞进来了。
    set((state) =>
      state.conversationId === conversationId
        ? state
        : {
            conversationId,
            events: [],
            todos: [],
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
  setRunning: (running) => set({ running }),
  setMode: (mode) => set({ mode }),
  setWorkspace: (workspace) => set({ workspace }),
  setWorkspaceIsDefault: (workspaceIsDefault) => set({ workspaceIsDefault }),
  setSessions: (sessions) => set({ sessions }),
  setTodos: (todos) => set({ todos }),
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

  clear: () =>
    set({
      events: [],
      running: false,
      todos: [],
      artifacts: [],
      permissions: [],
      questions: [],
    }),
}));

export type { PermissionReply };
