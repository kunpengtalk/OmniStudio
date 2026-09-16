import { afterAll, expect, mock, test } from "bun:test";
import type { ChatMessage } from "../../bun/chat";
import { Window } from "happy-dom";

/**
 * 「服务端消息 → 会话 store」同步规则的回归测试。
 *
 * 已发生的问题：对话页把「切会话清流式态」和「按服务端数据整体替换消息」写进了同一个
 * effect，依赖里带着 `convQuery.data`。于是**任何一次重取**（窗口重新聚焦、invalidate、
 * 后台刷新）都会：正在流式的助手正文被服务端那份还没落库的空内容覆盖 + 输入框解锁。
 * 同一个 store 的合并函数 `mergeServerMessages` 当时只有 Agent 页在用。
 *
 * 这里钉住两件事：
 *   1. 同一会话内数据变化 → 只合并，本地已累积的流式正文保留；
 *   2. 切会话 → 运行态清零（否则新会话会显示"正在生成"）。
 */

const dom = new Window({ url: "http://localhost/" });
const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "location",
  "history",
  "HTMLElement",
  "Element",
  "Node",
  "Text",
  "DocumentFragment",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "ResizeObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "getComputedStyle",
] as const;
const savedGlobals = new Map<string, unknown>();
for (const key of DOM_GLOBALS) {
  const value = (dom as unknown as Record<string, unknown>)[key];
  if (value === undefined) continue;
  savedGlobals.set(key, (globalThis as unknown as Record<string, unknown>)[key]);
  (globalThis as unknown as Record<string, unknown>)[key] = value;
}

mock.module("@lib/rpc", () => ({ rpcClient: {} }));

const { useServerMessageSync } = await import("./use-server-message-sync");
const { useChatStore } = await import("@stores/chat");
const { createRoot } = await import("react-dom/client");
// act() 需要这个开关，否则 React 会打印"环境未配置 act"并退回非批处理路径。
(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");

/** 用真实组件渲染这个 hook：改 props 触发 effect，跟页面上发生的事一致。 */
function Probe({
  conversationId,
  data,
}: {
  conversationId: number | null;
  data?: { messages: ChatMessage[] };
}) {
  useServerMessageSync(conversationId, data);
  return null;
}

/**
 * 渲染并**等 effect 跑完**。
 *
 * 这里用 `act()` 而不是固定 sleep：全量并行跑时（每个测试文件一个进程，机器被占满）
 * 固定 20ms 偶尔不够 —— 表现为"同一会话内重取"那条用例随机红。act() 会把这次渲染
 * 产生的被动 effect 同步刷完，断言看到的状态就是页面上会有的状态。
 */
async function mount(initial: { conversationId: number | null; data?: { messages: ChatMessage[] } }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Probe {...initial} />);
  });
  return {
    rerender: async (next: { conversationId: number | null; data?: { messages: any[] } }) => {
      await act(async () => {
        root.render(<Probe {...next} />);
      });
    },
    cleanup: () => act(() => root.unmount()),
  };
}

const user = (id: number, content: string): ChatMessage => ({
  id,
  conversationId: 7,
  role: "user",
  content,
  createdAt: 0,
});
const assistant = (id: number, content: string): ChatMessage => ({
  id,
  conversationId: 7,
  role: "assistant",
  content,
  createdAt: 0,
});

test("同一会话内重取：只合并，流式正文不被服务端那份空内容抹掉", async () => {
  useChatStore.getState().setActiveConversation(7);
  // 先挂载（挂载 = 进入这个会话，本来就该清一次运行态），再开始流式 —— 顺序要和页面上一致：
  // 用户是先在页面上点发送（setStreaming(true)），重取发生在这之后。
  const view = await mount({ conversationId: 7, data: { messages: [user(1, "帮我写个落地页")] } });
  useChatStore.getState().setStreaming(true);
  useChatStore.getState().setActiveMessages([user(1, "帮我写个落地页"), assistant(2, "正在写的第一段")]);

  // 模拟窗口重新聚焦触发的重取：数据是**新对象**，但内容还是那份半截的（助手那条还没落库）
  await view.rerender({ conversationId: 7, data: { messages: [user(1, "帮我写个落地页")] } });
  expect(useChatStore.getState().activeMessages.map((m) => m.content)).toEqual([
    "帮我写个落地页",
    "正在写的第一段",
  ]);
  // 重取不该把运行态改掉：清运行态只属于「切会话」，不属于「数据变了」
  expect(useChatStore.getState().streaming).toBe(true);

  view.cleanup();
});

test("切会话：运行态清零", async () => {
  useChatStore.getState().setActiveConversation(7);
  const view = await mount({ conversationId: 7 });
  useChatStore.getState().setStreaming(true);
  expect(useChatStore.getState().streaming).toBe(true);

  await view.rerender({ conversationId: 8 });
  expect(useChatStore.getState().streaming).toBe(false);

  view.cleanup();
});

test("服务端已收录的助手消息比本地长：以服务端为准", async () => {
  useChatStore.getState().setActiveConversation(9);
  useChatStore.getState().setActiveMessages([user(1, "问题"), assistant(2, "半截")]);

  const view = await mount({ conversationId: 9, data: { messages: [user(1, "问题"), assistant(2, "半截加上后文")] } });
  expect(useChatStore.getState().activeMessages[1]!.content).toBe("半截加上后文");

  view.cleanup();
});

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
});
