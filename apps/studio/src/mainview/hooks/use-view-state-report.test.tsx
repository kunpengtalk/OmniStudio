import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 「用户在看什么」上报的回归测试。
 *
 * 主进程靠这份状态决定后台跑完的回合要不要发通知，所以三种变化都必须重报：
 * 切会话、切到别的应用页（对话还选着但人已经走了）、窗口失焦 / 回焦。
 * 少报任何一种，主进程手里就是一份过期状态 —— 结果要么该提醒时不提醒，要么
 * 人正盯着看也弹一条。
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

type ViewState = { conversationId?: number | null; focused?: boolean };
const calls: ViewState[] = [];

mock.module("@lib/rpc", () => ({
  rpcClient: {
    setViewState: async (params: ViewState) => {
      calls.push(params);
      return { ok: true };
    },
  },
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useAppStore } = await import("@stores/app");
const { useChatStore } = await import("@stores/chat");
const { useRouter } = await import("@stores/router");
const { useViewStateReport } = await import("./use-view-state-report");

function Host() {
  useViewStateReport();
  return createElement("div", null, "host");
}

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 最后一次上报（`Array.prototype.at` 不在本项目的 lib 目标里）。 */
function lastReport(): ViewState {
  const value = calls[calls.length - 1];
  if (!value) throw new Error("还没有任何上报");
  return value;
}

test("切会话 / 切应用页 / 窗口失焦都会重报给主进程", async () => {
  for (const el of Array.from(document.body.children)) el.remove();
  calls.length = 0;
  useAppStore.setState({ activeApp: "chat" });
  useChatStore.setState({ activeConversationId: null });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(Host, null));
  });
  // 挂载即报一次：webview 重载后主进程手里还是旧值
  expect(calls.length).toBe(1);
  expect(calls[0]).toMatchObject({ conversationId: null });

  // 选了一个会话
  await act(async () => {
    useChatStore.getState().setActiveConversation(9);
  });
  await flush();
  expect(lastReport()).toMatchObject({ conversationId: 9 });

  // 切到别的应用页：会话还选着，但人已经没在看它了
  await act(async () => {
    useAppStore.getState().setActiveApp("image");
  });
  await flush();
  expect(lastReport()).toMatchObject({ conversationId: null });

  // 回到对话页
  await act(async () => {
    useAppStore.getState().setActiveApp("chat");
  });
  await flush();
  expect(lastReport()).toMatchObject({ conversationId: 9 });

  // 走进设置页：会话还在选着，但已经不在眼前了
  await act(async () => {
    useRouter.getState().setRoute({ path: "settings", tab: "store" });
  });
  await flush();
  expect(lastReport()).toMatchObject({ conversationId: null });

  await act(async () => {
    useRouter.getState().setRoute({ path: "chat" });
  });
  await flush();
  expect(lastReport()).toMatchObject({ conversationId: 9 });

  // 窗口失焦：人切到别的应用去了
  const hasFocus = document.hasFocus;
  (document as unknown as { hasFocus: () => boolean }).hasFocus = () => false;
  try {
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    await flush();
    expect(lastReport()).toMatchObject({ focused: false });
  } finally {
    (document as unknown as { hasFocus: () => boolean }).hasFocus = hasFocus;
  }

  await act(async () => {
    root.unmount();
  });
  container.remove();
});
