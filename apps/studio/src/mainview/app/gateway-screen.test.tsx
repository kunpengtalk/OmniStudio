import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

import type { ModelPurpose, ServedModelInfo, ServedModelStatus } from "../../shared/served-models";

/**
 * 网关页「嵌入服务」子块的回归测试。
 *
 * 端点区原来只列网关自己的路由，用户想知道「嵌入该连哪」只能自己拼地址。现在多了
 * 两行：网关代理行（`{网关地址}/v1/embeddings`）与直连行（本机运行中的嵌入实例）。
 * 这里锁住四件事：
 *   1. 有实例时直连行给出 `http://127.0.0.1:{port}/v1/embeddings` 且可复制；
 *   2. 多个嵌入实例时取**最后一个运行中的**（与主进程 `getActiveEmbeddingPort()` 同源，
 *      停机实例不参与）——用例按 served 快照的真实遍历序构造数据；
 *   3. 无实例时直连行不消失，显示「未运行」且复制按钮禁用；
 *   4. 代理行恒在（不受实例有无影响）。
 *
 * happy-dom 提供真实 DOM（Radix 的 Tooltip / ScrollArea 需要），afterAll 还原全局。
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

/** 复制到剪贴板的内容（happy-dom 的 Clipboard 需要授权，这里换成记录器）。 */
const copied: string[] = [];
Object.defineProperty(dom.navigator.clipboard, "writeText", {
  configurable: true,
  writable: true,
  value: async (text: string) => {
    copied.push(text);
  },
});

const GATEWAY_URL = "http://127.0.0.1:10000";

/**
 * 当前用例的 served 快照。
 *
 * 顺序即主进程注册表的插入序（`entries` 是 Map，`getServedModels()` 按它迭代），
 * 也就是组件里「最后一个命中的实例胜出」那条规则看到的真实次序 —— 用例必须照这个
 * 顺序摆数据，否则 mock 顺序与真实顺序不一致时会假绿。
 */
let served: ServedModelInfo[] = [];

function instance(
  id: string,
  port: number,
  purpose: ModelPurpose,
  status: ServedModelStatus,
): ServedModelInfo {
  return {
    id,
    modelRef: id,
    label: id,
    engine: "llama.cpp",
    port,
    // 故意用 0.0.0.0：served 快照里的 endpoint 主机名来自 SERVER_HOST，
    // 直连行若照抄它就会出现一个复制出去连不上的地址。
    endpoint: `http://0.0.0.0:${port}/v1`,
    servedName: id,
    purpose,
    status,
    usesDefaultPort: false,
    isActive: false,
    isDir: false,
  };
}

mock.module("@lib/rpc", () => ({
  rpcClient: {
    getGatewayStatus: async () => ({
      status: "running",
      url: GATEWAY_URL,
      port: 10000,
      configuredPort: 10000,
    }),
    getSettings: async () => ({
      settings: {
        GATEWAY_ENABLED: "1",
        GATEWAY_PORT: "10000",
        GATEWAY_API_KEY: "",
      },
    }),
    updateSettings: async () => ({}),
    restartGateway: async () => ({ ok: true }),
    startGateway: async () => ({ ok: true }),
    stopGateway: async () => ({ ok: true }),
    openGatewayDocs: async () => ({ ok: true }),
    listServedModels: async () => ({ models: served, activeId: null }),
  },
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { GatewayScreen } = await import("./gateway-screen");
const { TooltipProvider } = await import("@ui/tooltip");
const { useServedStore } = await import("@stores/served");
const { translate } = await import("../../shared/i18n");

const zh = (key: string) => translate("zh", key);

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

beforeEach(() => {
  served = [];
  copied.length = 0;
  // store 是模块级单例：清掉上一个用例的快照，避免残留实例被当成「运行中」。
  useServedStore.setState({ models: [], activeId: null, logs: {} });
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderGateway() {
  const errors: unknown[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container, {
    onUncaughtError: (error) => errors.push(error),
    onRecoverableError: (error) => errors.push(error),
  });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TooltipProvider, null, createElement(GatewayScreen)),
      ),
    );
  });
  // 两个查询（settings / served-models）落地 + setSnapshot 触发的那次重渲染。
  await flush();
  await flush();
  return {
    errors,
    container,
    text: container.textContent ?? "",
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** 按显示文本找到那一行，返回它的复制按钮（端点是 `<code>`，父元素即整行）。 */
function copyButton(container: HTMLElement, text: string): HTMLButtonElement {
  const code = [...container.querySelectorAll("code")].find((el) => el.textContent === text);
  expect(code).toBeDefined();
  const button = code!.parentElement?.querySelector("button");
  expect(button).not.toBeNull();
  return button as HTMLButtonElement;
}

test("有 1 个运行中的嵌入实例：直连行显示该实例端口且可复制", async () => {
  served = [instance("chat", 8080, "chat", "running"), instance("embed", 8101, "embedding", "running")];
  const view = await renderGateway();
  expect(view.errors).toEqual([]);

  const url = "http://127.0.0.1:8101/v1/embeddings";
  expect(view.text).toContain(url);
  // 直连行的 host 固定 127.0.0.1，不是快照里的 0.0.0.0
  expect(view.text).not.toContain("0.0.0.0:8101");

  const button = copyButton(view.container, url);
  expect(button.disabled).toBe(false);
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(copied).toEqual([url]);
  await view.unmount();
});

test("多个嵌入实例：显示最后一个运行中的（顺序即快照遍历序）", async () => {
  served = [
    instance("chat", 8080, "chat", "running"),
    instance("embed-a", 8101, "embedding", "running"),
    instance("embed-b", 8102, "embedding", "running"),
    // 末尾这个已停机：主进程的判据是「最后一个 running」，它不参与
    instance("embed-stopped", 8103, "embedding", "stopped"),
  ];
  const view = await renderGateway();
  expect(view.errors).toEqual([]);

  expect(view.text).toContain("http://127.0.0.1:8102/v1/embeddings");
  expect(view.text).not.toContain("8101");
  expect(view.text).not.toContain("8103");
  await view.unmount();
});

test("没有嵌入实例：直连行显示「未运行」、复制禁用，行不消失", async () => {
  served = [instance("chat", 8080, "chat", "running")];
  const view = await renderGateway();
  expect(view.errors).toEqual([]);

  const offline = zh("settings.gateway.endpoints.embeddingsOffline");
  expect(view.text).toContain(offline);
  // 直连行标签仍在（行没被隐藏），引导文案给出下一步
  expect(view.text).toContain(zh("settings.gateway.endpoints.embeddingsDirect"));
  expect(view.text).toContain(zh("settings.gateway.endpoints.embeddingsHint"));

  const button = copyButton(view.container, offline);
  expect(button.disabled).toBe(true);
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(copied).toEqual([]);
  await view.unmount();
});

test("网关代理行恒在：地址为 {网关地址}/v1/embeddings，不随实例有无变化", async () => {
  served = [];
  const view = await renderGateway();
  expect(view.errors).toEqual([]);

  const proxy = `${GATEWAY_URL}/v1/embeddings`;
  expect(view.text).toContain(proxy);
  expect(copyButton(view.container, proxy).disabled).toBe(false);
  await view.unmount();
});
