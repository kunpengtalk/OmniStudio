import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 侧栏「项目段」的回归测试。
 *
 * 已发生的问题：这一段只能折叠展开 —— 点/选一个文件夹之后，右侧还停在上一个项目的
 * 会话上，看起来像"点了没反应"；想"在这个文件夹里干活"也没有入口（新建任务建的会话
 * 挂在全局默认目录下）。这里钉住四件事：
 *   1. 点文件夹标题 → 切到该项目里最近动过的会话；
 *   2. 点箭头只折叠，不切会话（一个按钮不能既进组又折叠）；
 *   3. 项目行尾的 ＋ → 在那个工作区里新建会话；
 *   4. 「打开工作区」→ 文件夹里已有会话就进去，没有就当场在里面建一个；
 *   5. 一个项目都没有时，段落与入口仍在 —— 否则新用户永远打不开第一个文件夹。
 *
 * 后来又补了两条：每段列表默认只露 5 条（多的收在「查看更多」后面），且一律新的在
 * 最上面。这两件事是一体的 —— 上限收的是排在后面的那些，顺序反了收起来的就是最新
 * 的会话，界面上还看不出来。会话行的**点击区**（整行都可点）在 styles/agent-pi.test.ts
 * 里钉，那里量不了真机布局，只能钉 CSS 声明。
 */

// happy-dom 提供真实 DOM（组件要用 document / MouseEvent），afterAll 还原全局。
const dom = new Window({ url: "http://localhost/" });
const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "location",
  "history",
  "localStorage",
  "HTMLElement",
  "HTMLDivElement",
  "HTMLButtonElement",
  "HTMLInputElement",
  "Element",
  "Node",
  "Text",
  "DocumentFragment",
  "SVGElement",
  "DOMRect",
  "CustomElementRegistry",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
  "FocusEvent",
  "InputEvent",
  "MutationObserver",
  "ResizeObserver",
  "NodeFilter",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "getComputedStyle",
  "matchMedia",
] as const;
const savedGlobals = new Map<string, unknown>();
for (const key of DOM_GLOBALS) {
  const value = (dom as unknown as Record<string, unknown>)[key];
  if (value === undefined) continue;
  savedGlobals.set(key, (globalThis as unknown as Record<string, unknown>)[key]);
  (globalThis as unknown as Record<string, unknown>)[key] = value;
}
(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let sessionsFixture: unknown[] = [];
let dialogPath = "";
const createdInWorkspace: (string | undefined)[] = [];
const recentsWrites: string[] = [];

mock.module("@lib/rpc", () => ({
  rpcClient: {
    listAgentSessions: async () => ({ sessions: sessionsFixture }),
    getSettings: async () => ({ settings: {} }),
    updateSettings: async (params: { settings: { AGENT_WORKSPACES?: string } }) => {
      if (params.settings.AGENT_WORKSPACES) recentsWrites.push(params.settings.AGENT_WORKSPACES);
      return { ok: true };
    },
    openDirectoryDialog: async () => ({ path: dialogPath }),
    createAgentSession: async (params: { workspace?: string }) => {
      createdInWorkspace.push(params?.workspace);
      return { session: { id: 99, title: "新任务" } };
    },
    setAgentSessionPinned: async () => ({ ok: true }),
    setAgentSessionArchived: async () => ({ ok: true }),
    renameAgentSession: async () => ({ ok: true }),
    deleteConversation: async () => ({ ok: true }),
  },
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { AgentSessionSidebar } = await import("./session-sidebar");
const { useAgentStore } = await import("@stores/agent");
const { useChatStore } = await import("@stores/chat");
const { translate } = await import("../../../shared/i18n");

const zh = (key: string) => translate("zh", key);
const OPEN_WORKSPACE = zh("agent.sidebar.addProject");
const NEW_IN_PROJECT = zh("agent.sidebar.newInProject");

type SidebarSession = {
  id: number;
  title: string;
  workspace: string;
  sessionWorkspace: string | null;
  archived: boolean;
  pinned: boolean;
  running: boolean;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  preview: string;
  todo: { completed: number; total: number };
  needsAttention: boolean;
};

function session(overrides: Partial<SidebarSession> & { id: number }): SidebarSession {
  return {
    title: `任务 ${overrides.id}`,
    workspace: "/Users/me/workspace",
    sessionWorkspace: null,
    archived: false,
    pinned: false,
    running: false,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 1,
    preview: "",
    todo: { completed: 0, total: 0 },
    needsAttention: false,
    ...overrides,
  };
}

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

beforeEach(() => {
  createdInWorkspace.length = 0;
  recentsWrites.length = 0;
  dialogPath = "";
  useChatStore.getState().setActiveConversation(null);
});

afterEach(() => {
  for (const el of Array.from(document.body.children)) el.remove();
});

/** 点击并等一拍：点击引起的 RPC / setState 都在 act 里落定。 */
async function click(el: HTMLElement | null) {
  if (!el) throw new Error("要点的东西不在 DOM 里");
  await act(async () => {
    el.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderSidebar(sessions: SidebarSession[], activeConversationId: number | null) {
  sessionsFixture = sessions;
  useChatStore.getState().setActiveConversation(activeConversationId);
  const newTaskCalls: (string | undefined)[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(AgentSessionSidebar, {
          activeConversationId,
          collapsed: false,
          onNewTask: (workspace?: string) => newTaskCalls.push(workspace),
          onOpenSearch: () => {},
          onToggleSidebar: () => {},
        }),
      ),
    );
  });
  // 等会话列表落地
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  /** 项目行（标题是按钮的那些；「会话」「项目」两个段标题是 span）。 */
  const projectRows = () => [...container.querySelectorAll<HTMLButtonElement>("button.pi-group-title")];
  const projectName = (row: HTMLElement) => row.querySelector("span")?.textContent ?? "";
  const projectRow = (name: string) => projectRows().find((row) => projectName(row) === name) ?? null;
  const headerOf = (row: HTMLElement | null) => row?.closest(".pi-group-header") as HTMLElement | null;
  /** 某个项目的分组外壳：头（.pi-group-header）与身子（.pi-group-body）都挂在它下面。 */
  const wrapperOf = (row: HTMLElement | null) => headerOf(row)?.parentElement ?? null;
  const bodyOf = (name: string) =>
    wrapperOf(projectRow(name))?.querySelector<HTMLElement>(".pi-group-body") ?? null;
  const requireBodyOf = (name: string) => {
    const body = bodyOf(name);
    if (!body) throw new Error(`项目 ${name} 不在 DOM 里`);
    return body;
  };
  /** 一段列表里渲染出来的会话标题（按渲染顺序）。 */
  const titlesIn = (root: ParentNode) =>
    [...root.querySelectorAll<HTMLElement>(".pi-thread-title")].map((el) => el.textContent ?? "");

  return {
    container,
    newTaskCalls,
    projectNames: () => projectRows().map(projectName),
    projectRow,
    /** 「会话」段渲染出来的标题。 */
    titles: () => titlesIn(container),
    projectTitles: (name: string) => titlesIn(requireBodyOf(name)),
    /** 段尾的「查看更多」；一段最多 5 条，没超出就没有这个按钮。 */
    moreButton: (root: ParentNode = container) =>
      root.querySelector<HTMLButtonElement>(".pi-list-more"),
    moreInProject: (name: string) => requireBodyOf(name).querySelector<HTMLButtonElement>(".pi-list-more"),
    async toggleMore(root: ParentNode = container) {
      await click(root.querySelector<HTMLButtonElement>(".pi-list-more"));
    },
    async toggleMoreInProject(name: string) {
      await click(requireBodyOf(name).querySelector<HTMLButtonElement>(".pi-list-more"));
    },
    async enterProject(name: string) {
      await click(projectRow(name));
    },
    async toggleProject(name: string) {
      await click(headerOf(projectRow(name))?.querySelector<HTMLButtonElement>(".pi-caret-btn") ?? null);
    },
    async newSessionInProject(name: string) {
      await click(headerOf(projectRow(name))?.querySelector<HTMLButtonElement>(".pi-group-action") ?? null);
    },
    async openWorkspace() {
      await click(container.querySelector<HTMLButtonElement>(`button[aria-label="${OPEN_WORKSPACE}"]`));
    },
    groupCollapsed(name: string) {
      return bodyOf(name)?.getAttribute("aria-hidden") === "true";
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function view() {
  return {
    active: useChatStore.getState().activeConversationId,
    subView: useAgentStore.getState().subView,
  };
}

const WORKSPACES = [
  session({ id: 1, sessionWorkspace: "/repo/alpha", workspace: "/repo/alpha", updatedAt: 100 }),
  session({ id: 2, sessionWorkspace: "/repo/alpha", workspace: "/repo/alpha", updatedAt: 300 }),
  session({ id: 3, sessionWorkspace: "/repo/beta", workspace: "/repo/beta", updatedAt: 200 }),
  session({ id: 4, updatedAt: 400 }),
];

test("点文件夹标题进项目：切到里面最近动过的会话", async () => {
  // 当前停在「会话」段那条（id 4），项目里最近动过的是 alpha 的 id 2
  const sidebar = await renderSidebar(WORKSPACES, 4);
  expect(sidebar.projectNames()).toEqual(["alpha", "beta"]);

  await sidebar.enterProject("alpha");
  expect(view().active).toBe(2);
  await sidebar.enterProject("beta");
  expect(view().active).toBe(3);

  await sidebar.unmount();
});

test("点箭头只折叠，不动右侧会话", async () => {
  const sidebar = await renderSidebar(WORKSPACES, 4);

  await sidebar.toggleProject("alpha");
  expect(sidebar.groupCollapsed("alpha")).toBe(true);
  expect(view().active).toBe(4);

  // 再点一次展开，仍然没换会话
  await sidebar.toggleProject("alpha");
  expect(sidebar.groupCollapsed("alpha")).toBe(false);
  expect(view().active).toBe(4);

  await sidebar.unmount();
});

test("在项目里正在看的会话不会被自己那一下点击顶掉", async () => {
  const sidebar = await renderSidebar(WORKSPACES, 3);
  await sidebar.enterProject("beta");
  // beta 里只有 id 3，点标题不该把它换成别的会话
  expect(view().active).toBe(3);
  await sidebar.unmount();
});

test("项目行尾的 ＋ 在那个工作区里新建会话", async () => {
  const sidebar = await renderSidebar(WORKSPACES, 4);
  await sidebar.newSessionInProject("beta");
  expect(sidebar.newTaskCalls).toEqual(["/repo/beta"]);
  await sidebar.unmount();
});

test("打开工作区：文件夹里已有会话就进去，没有就当场建一个", async () => {
  const sidebar = await renderSidebar(WORKSPACES, 4);

  dialogPath = "/repo/beta";
  await sidebar.openWorkspace();
  expect(view().active).toBe(3);
  expect(sidebar.newTaskCalls).toEqual([]);
  // 打开过的文件夹要出现在输入框那个选择器的"最近"里
  expect(recentsWrites.some((raw) => raw.includes("/repo/beta"))).toBe(true);

  dialogPath = "/repo/gamma";
  await sidebar.openWorkspace();
  expect(sidebar.newTaskCalls).toEqual(["/repo/gamma"]);

  await sidebar.unmount();
});

test("取消选择文件夹：什么都不发生", async () => {
  const sidebar = await renderSidebar(WORKSPACES, 4);
  dialogPath = "";
  await sidebar.openWorkspace();
  expect(view().active).toBe(4);
  expect(sidebar.newTaskCalls).toEqual([]);
  await sidebar.unmount();
});

test("一个项目都没有时，项目段与「打开工作区」入口仍在", async () => {
  const sidebar = await renderSidebar([session({ id: 4, updatedAt: 400 })], 4);
  const text = sidebar.container.textContent ?? "";
  expect(sidebar.projectNames()).toEqual([]);
  expect(text).toContain(zh("agent.sidebar.projectsSection"));
  expect(text).toContain(zh("agent.sidebar.emptyProjects"));
  expect(sidebar.container.querySelector(`button[aria-label="${OPEN_WORKSPACE}"]`)).not.toBeNull();
  expect(text).not.toContain("agent.sidebar.");
  await sidebar.unmount();
});

test("会话行点击照旧：切会话并回到对话视图", async () => {
  const sidebar = await renderSidebar(WORKSPACES, 4);
  await act(async () => {
    useAgentStore.getState().setSubView("plugins");
  });
  await click(sidebar.container.querySelector<HTMLButtonElement>(".pi-thread"));
  expect(view().active).toBe(4);
  expect(view().subView).toBe("chat");
  await sidebar.unmount();
});

test("顶部「新任务」不带工作区（由 AgentWindow 按当前项目决定），更不要把点击事件传下去", async () => {
  const sidebar = await renderSidebar(WORKSPACES, 4);
  await click(sidebar.container.querySelector<HTMLButtonElement>(`.pi-side-action[aria-label="${zh("agent.session.new")}"]`));
  expect(sidebar.newTaskCalls).toEqual([undefined]);
  await sidebar.unmount();
});

test("每行的新建按钮有可读的无障碍名字（只有一个 ＋ 图标）", async () => {
  const sidebar = await renderSidebar(WORKSPACES, 4);
  const buttons = sidebar.container.querySelectorAll(`button[aria-label="${NEW_IN_PROJECT}"]`);
  expect(buttons.length).toBe(2);
  await sidebar.unmount();
});

/*
 * 列表长度与顺序。这两件事是一体的：列表默认只露 5 条，所以必须**新的在最上面**
 * —— 顺序反了，被收起来的就是最新那批，而这种错在界面上看不出来。
 */

test("会话段默认只露 5 条，点「查看更多」才给全，再点收起", async () => {
  const many = Array.from({ length: 8 }, (_, i) => session({ id: i + 1, updatedAt: 900 - i * 10 }));
  const sidebar = await renderSidebar(many, null);

  expect(sidebar.titles()).toEqual(["任务 1", "任务 2", "任务 3", "任务 4", "任务 5"]);
  expect(sidebar.moreButton()?.textContent).toBe(
    translate("zh", "agent.sidebar.showMore", { count: "3" }),
  );

  await sidebar.toggleMore();
  expect(sidebar.titles()).toHaveLength(8);
  expect(sidebar.titles()[7]).toBe("任务 8");
  expect(sidebar.moreButton()?.textContent).toBe(zh("agent.sidebar.showLess"));

  await sidebar.toggleMore();
  expect(sidebar.titles()).toHaveLength(5);

  await sidebar.unmount();
});

test("每个项目各算各的 5 条：展开一个不影响另一个", async () => {
  const alpha = Array.from({ length: 7 }, (_, i) =>
    session({
      id: 100 + i,
      sessionWorkspace: "/repo/alpha",
      workspace: "/repo/alpha",
      updatedAt: 700 - i * 10,
    }),
  );
  const beta = [
    session({ id: 200, sessionWorkspace: "/repo/beta", workspace: "/repo/beta", updatedAt: 100 }),
  ];
  const sidebar = await renderSidebar([...alpha, ...beta], null);

  expect(sidebar.projectTitles("alpha")).toEqual([
    "任务 100",
    "任务 101",
    "任务 102",
    "任务 103",
    "任务 104",
  ]);
  // 只有一条的段不该冒出「查看更多」
  expect(sidebar.moreInProject("beta")).toBeNull();

  await sidebar.toggleMoreInProject("alpha");
  expect(sidebar.projectTitles("alpha")).toHaveLength(7);
  expect(sidebar.projectTitles("beta")).toEqual(["任务 200"]);

  await sidebar.unmount();
});

test("列表按最近更新倒序渲染，即使数据回来是旧→新", async () => {
  const ascending = [1, 2, 3].map((i) => session({ id: i, updatedAt: i * 100 }));
  const sidebar = await renderSidebar(ascending, null);
  expect(sidebar.titles()).toEqual(["任务 3", "任务 2", "任务 1"]);
  await sidebar.unmount();
});

test("项目按组内最近活动排：在哪个项目里动过，它就排到最前", async () => {
  const before = await renderSidebar(
    [
      session({ id: 1, sessionWorkspace: "/repo/alpha", workspace: "/repo/alpha", updatedAt: 100 }),
      session({ id: 2, sessionWorkspace: "/repo/beta", workspace: "/repo/beta", updatedAt: 300 }),
    ],
    null,
  );
  expect(before.projectNames()).toEqual(["beta", "alpha"]);
  await before.unmount();

  // alpha 里刚发过消息 / 刚新建会话（updatedAt 最大）→ alpha 排到最前
  const after = await renderSidebar(
    [
      session({ id: 1, sessionWorkspace: "/repo/alpha", workspace: "/repo/alpha", updatedAt: 400 }),
      session({ id: 3, sessionWorkspace: "/repo/alpha", workspace: "/repo/alpha", updatedAt: 900 }),
      session({ id: 2, sessionWorkspace: "/repo/beta", workspace: "/repo/beta", updatedAt: 300 }),
    ],
    null,
  );
  expect(after.projectNames()).toEqual(["alpha", "beta"]);
  expect(after.projectTitles("alpha")).toEqual(["任务 3", "任务 1"]);
  await after.unmount();
});
