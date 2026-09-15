import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 输入框的斜杠命令：敲了命令之后到底有没有落到该落的地方。
 *
 * 已发生的问题（用户报「命令执行了但没生效」）：
 *   1. 只有回车那条路认斜杠命令，敲完 `/goal` 去点发送按钮 = 把 "/goal" 当消息发给模型；
 *   2. 命令名的字符集是 `[a-z]`，连字符进不来 —— `/omni-doctor` 既不在补全面板里出现，
 *      敲完整条也只是被当成普通消息发出去；
 *   3. 不认识的 `/xxx` 没有任何反馈，静默变成一条发给模型的消息。
 *
 * 这里钉住现在成立的行为：命令命中就执行（切模式写 AGENT_MODE、/init 与 /omni-doctor
 * 把预置提示词发出去），不命中的仍然按消息发（不吞用户的话）。
 */

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
  "HTMLTextAreaElement",
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
const calls: { method: string; params: unknown }[] = [];

mock.module("@lib/rpc", () => {
  const handler: ProxyHandler<Record<string, unknown>> = {
    get: (_target, prop: string) => async (params: unknown) => {
      calls.push({ method: prop, params });
      if (prop === "getSettings") return { settings: {} };
      if (prop === "getAgentWorkspace") return { workspace: "/tmp/ws" };
      if (prop === "getConversation") {
        return { conversation: { id: CONVERSATION_ID, title: "t", app: "agent" }, messages: [] };
      }
      if (prop === "sendAgentMessage") return { ok: true };
      if (prop === "listChatModels") return { models: [] };
      if (prop === "listWorkspaceFiles") return { nodes: [] };
      if (prop === "getAgentPermissions") return { mode: "auto" };
      return {};
    },
  };
  return { rpcClient: new Proxy({}, handler) };
});

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { AgentComposer } = await import("./composer");
const { useAgentStore } = await import("@stores/agent");
const { useChatStore } = await import("@stores/chat");
const { translate } = await import("../../../shared/i18n");

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

afterEach(() => {
  for (const el of Array.from(document.body.children)) el.remove();
  calls.length = 0;
});

/** 写值必须走原生 setter，否则 React 的 value tracker 看不见这次输入。 */
async function type(input: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pressEnter(input: HTMLTextAreaElement) {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function clickSend(container: HTMLElement) {
  const sendBtn = container.querySelector<HTMLButtonElement>("button.send-btn");
  if (!sendBtn) throw new Error("发送按钮没渲染出来");
  await act(async () => {
    sendBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount() {
  useChatStore.getState().setActiveConversation(CONVERSATION_ID);
  useChatStore.getState().setActiveMessages([]);
  useChatStore.getState().setStreaming(false);
  useAgentStore.getState().setMode("agent");
  useAgentStore.getState().setRunning(false);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(AgentComposer, { conversationId: CONVERSATION_ID, mode: "agent" }),
      ),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const input = container.querySelector<HTMLTextAreaElement>("textarea.composer-input");
  if (!input) throw new Error("输入框没渲染出来");
  return {
    container,
    input,
    unmount: async () => act(async () => root.unmount()),
  };
}

const sentContents = () =>
  calls
    .filter((call) => call.method === "sendAgentMessage")
    .map((call) => (call.params as { content?: string }).content ?? "");
const settingsWrites = () =>
  calls.filter((call) => call.method === "updateSettings").map((call) => call.params);
const zh = (key: string) => translate("zh", key);

test("在补全面板里输入 omni-do 能看到 /omni-doctor", async () => {
  const { container, input, unmount } = await mount();
  await type(input, "/omni-do");
  const items = [...container.querySelectorAll<HTMLButtonElement>(".composer-ac-item")].map(
    (el) => el.textContent ?? "",
  );
  expect(items.some((text) => text.includes("/omni-doctor"))).toBe(true);
  await unmount();
});

test("/omni-doctor 回车：把排障任务书发给模型（技能正文由模型 read_skill 取）", async () => {
  const { input, unmount } = await mount();
  await type(input, "/omni-doctor");
  await pressEnter(input);
  expect(sentContents()).toEqual([zh("agent.slash.doctor.prompt")]);
  await unmount();
});

test("/omni-doctor 带现象：现象原样带进任务书，不让用户再打一遍", async () => {
  const { input, unmount } = await mount();
  await type(input, "/omni-doctor 生图一直失败");
  await pressEnter(input);
  const content = sentContents()[0] ?? "";
  expect(content.startsWith(zh("agent.slash.doctor.prompt"))).toBe(true);
  expect(content).toContain("生图一直失败");
  await unmount();
});

test("点发送按钮跑 /omni-doctor：走的是命令，不是把命令当消息发出去", async () => {
  const { container, input, unmount } = await mount();
  await type(input, "/omni-doctor");
  await clickSend(container);
  expect(sentContents()).toEqual([zh("agent.slash.doctor.prompt")]);
  await unmount();
});

test("/goal 回车切模式", async () => {
  const { input, unmount } = await mount();
  await type(input, "/goal");
  await pressEnter(input);
  expect(settingsWrites()).toContainEqual({ settings: { AGENT_MODE: "goal" } });
  expect(useAgentStore.getState().mode).toBe("goal");
  await unmount();
});

test('/goal 点发送按钮同样切模式（旧行为会把 "/goal" 当消息发给模型）', async () => {
  const { container, input, unmount } = await mount();
  await type(input, "/goal");
  await clickSend(container);
  expect(settingsWrites()).toContainEqual({ settings: { AGENT_MODE: "goal" } });
  expect(sentContents()).toEqual([]);
  await unmount();
});

test("命令后面带参数但没声明 takesArgs：当成普通消息发出去，不静默吞话", async () => {
  const { input, unmount } = await mount();
  await type(input, "/goal 开始干活");
  await pressEnter(input);
  expect(sentContents()).toEqual(["/goal 开始干活"]);
  expect(settingsWrites()).toEqual([]);
  await unmount();
});

test("/init 回车把预置提示词发出去", async () => {
  const { input, unmount } = await mount();
  await type(input, "/init");
  await pressEnter(input);
  expect(sentContents()).toEqual([zh("agent.slash.init.prompt")]);
  await unmount();
});
