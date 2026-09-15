import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 输入框上的工作区选择器：换目录 = 换会话。
 *
 * 已发生的问题：选另一个文件夹时这里只把**当前会话**改挂过去（`setAgentSessionWorkspace`），
 * 右侧看不出任何变化（还是那条会话），而它已经带着 A 目录的历史跑到 B 目录去了 ——
 * 工作区是会话级属性，一条会话里前后半程跨两个目录，历史里读过的文件与改过的路径会串起来。
 *
 * 现在钉住四条：
 *   1. 会话已聊过 + 换另一个文件夹 → 在目标目录里开新会话并切过去，当前会话不动；
 *   2. 会话已聊过 + 换「默认工作区」→ 同样开新会话（只是那条会话跟随全局）；
 *   3. 还是空白的新会话 → 就地改挂（没有历史可串，也不必攒下一条"新任务"）；
 *   4. 选的正是当前所在的工作区 → 什么都不做。
 */

// happy-dom 提供真实 DOM，afterAll 还原全局。
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

const CONVERSATION_ID = 7;
const DEFAULT_WORKSPACE = "/Users/me/workspace";
const ALPHA = "/repo/alpha";
const BETA = "/repo/beta";
const GAMMA = "/repo/gamma";
const NEW_SESSION_ID = 99;

let messageCount = 3;
let dialogPath = "";
const created: { workspace?: string }[] = [];
const rebound: { conversationId: number; workspace: string | null }[] = [];
const settingsWrites: Record<string, unknown>[] = [];

mock.module("@lib/rpc", () => ({
  rpcClient: {
    getSettings: async () => ({
      settings: { AGENT_WORKSPACES: JSON.stringify([ALPHA, BETA]) },
    }),
    updateSettings: async (params: { settings: Record<string, unknown> }) => {
      settingsWrites.push(params.settings);
      return { ok: true };
    },
    getAgentWorkspace: async () => ({ workspace: DEFAULT_WORKSPACE, isDefault: false }),
    getConversation: async () => ({
      conversation: { id: CONVERSATION_ID, title: "任务", app: "agent", workspace: null },
      messages: Array.from({ length: messageCount }, (_, i) => ({ id: i + 1, role: "user", content: "x" })),
    }),
    createAgentSession: async (params: { workspace?: string }) => {
      created.push(params ?? {});
      return {
        session: {
          id: NEW_SESSION_ID,
          title: "新任务",
          workspace: params?.workspace ?? DEFAULT_WORKSPACE,
          sessionWorkspace: params?.workspace ?? null,
          createdAt: 1,
          updatedAt: 1,
        },
      };
    },
    setAgentSessionWorkspace: async (params: { conversationId: number; workspace: string | null }) => {
      rebound.push(params);
      return { ok: true, workspace: params.workspace ?? DEFAULT_WORKSPACE };
    },
    openDirectoryDialog: async () => ({ path: dialogPath }),
  },
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { WorkspacePicker } = await import("./composer");
const { useAgentStore } = await import("@stores/agent");
const { useChatStore } = await import("@stores/chat");
const { translate } = await import("../../../shared/i18n");

const zh = (key: string) => translate("zh", key);

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

beforeEach(() => {
  created.length = 0;
  rebound.length = 0;
  settingsWrites.length = 0;
  dialogPath = "";
  messageCount = 3;
  useChatStore.getState().setActiveConversation(CONVERSATION_ID);
});

afterEach(() => {
  for (const el of Array.from(document.body.children)) el.remove();
});

async function click(el: HTMLElement | null | undefined) {
  if (!el) throw new Error("要点的东西不在 DOM 里");
  await act(async () => {
    el.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 当前会话的工作区状态（输入框上写的就是它）。 */
async function renderPicker(workspace: string, isDefault = false) {
  useAgentStore.getState().setWorkspace(workspace);
  useAgentStore.getState().setWorkspaceIsDefault(isDefault);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(WorkspacePicker, { conversationId: CONVERSATION_ID }),
      ),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const menuItems = () => [...container.querySelectorAll<HTMLButtonElement>(".pi-menu-scroll .pi-menu-item")];
  const openMenu = () => click(container.querySelector<HTMLButtonElement>(".composer-ws-chip"));

  return {
    container,
    openMenu,
    /** 「默认工作区」永远是清单第一条。 */
    async pickDefault() {
      await click(menuItems()[0]);
    },
    async pickRecent(path: string) {
      await click(container.querySelector<HTMLButtonElement>(`.pi-menu-scroll button[title="${path}"]`));
    },
    async pickOpenFolder() {
      await click(
        [...container.querySelectorAll<HTMLButtonElement>(".pi-menu .pi-menu-item")].find((item) =>
          item.textContent?.includes(zh("agent.openFolder")),
        ),
      );
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

test("会话已聊过：换另一个文件夹 → 在新目录里开新会话并切过去", async () => {
  const picker = await renderPicker(ALPHA);
  await picker.openMenu();
  await picker.pickRecent(BETA);

  expect(created).toEqual([{ workspace: BETA }]);
  expect(rebound).toEqual([]);
  // 右侧切到新会话，输入框的工作区跟着新会话走（发消息时带的就是它）
  expect(useChatStore.getState().activeConversationId).toBe(NEW_SESSION_ID);
  expect(useAgentStore.getState().workspace).toBe(BETA);
  expect(useAgentStore.getState().workspaceIsDefault).toBe(false);
  // 打开过的文件夹要进「最近」
  expect(settingsWrites.some((s) => String(s.AGENT_WORKSPACES).includes(BETA))).toBe(true);

  await picker.unmount();
});

test("会话已聊过：换成「默认工作区」也开新会话（那条会话跟随全局）", async () => {
  const picker = await renderPicker(BETA);
  await picker.openMenu();
  await picker.pickDefault();

  expect(created).toEqual([{}]);
  expect(rebound).toEqual([]);
  expect(useChatStore.getState().activeConversationId).toBe(NEW_SESSION_ID);
  // 跟随全局的会话：工作区拨回默认目录，不把 BETA 带过去
  expect(useAgentStore.getState().workspace).toBe(DEFAULT_WORKSPACE);
  expect(useAgentStore.getState().workspaceIsDefault).toBe(true);

  await picker.unmount();
});

test("「打开文件夹…」走同一条路：选完目录就是在那儿开新会话", async () => {
  const picker = await renderPicker(ALPHA, false);
  messageCount = 3;
  dialogPath = GAMMA;
  await picker.openMenu();
  await picker.pickOpenFolder();

  expect(created).toEqual([{ workspace: GAMMA }]);
  expect(rebound).toEqual([]);
  expect(useChatStore.getState().activeConversationId).toBe(NEW_SESSION_ID);

  await picker.unmount();
});

test("空白会话：就地改挂，不再攒一条空白会话", async () => {
  messageCount = 0;
  const picker = await renderPicker(DEFAULT_WORKSPACE, true);
  await picker.openMenu();
  await picker.pickRecent(BETA);

  expect(created).toEqual([]);
  expect(rebound).toEqual([{ conversationId: CONVERSATION_ID, workspace: BETA }]);
  // 还是同一条会话，工作区改成 BETA
  expect(useChatStore.getState().activeConversationId).toBe(CONVERSATION_ID);
  expect(useAgentStore.getState().workspace).toBe(BETA);

  await picker.unmount();
});

test("选的正是当前所在的工作区：什么都不做，只是收起菜单", async () => {
  const picker = await renderPicker(BETA);
  await picker.openMenu();
  await picker.pickRecent(BETA);

  expect(created).toEqual([]);
  expect(rebound).toEqual([]);
  expect(settingsWrites).toEqual([]);
  expect(picker.container.querySelector(".pi-menu")).toBeNull();

  await picker.unmount();
});

test("菜单里写清语义：换工作区会开新会话（不出现 i18n key 原文）", async () => {
  const picker = await renderPicker(ALPHA);
  await picker.openMenu();
  const text = picker.container.textContent ?? "";
  expect(text).toContain(zh("agent.workspaceSwitchHint"));
  expect(text).not.toContain("agent.workspace");
  await picker.unmount();
});
