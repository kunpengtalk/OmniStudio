import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

import type { ModelPurpose, ServedModelInfo, ServedModelStatus } from "../../shared/served-models";

/**
 * 网关页回归测试，两个小节共用同一套 happy-dom 渲染骨架：
 *
 * 「嵌入服务」端点两行 ——
 *   1. 有实例时直连行给出 `http://127.0.0.1:{port}/v1/embeddings` 且可复制；
 *   2. 多个嵌入实例时取**最后一个运行中的**（与主进程 `getActiveEmbeddingPort()` 同源，
 *      停机实例不参与）——用例按 served 快照的真实遍历序构造数据；
 *   3. 无实例时直连行不消失，显示「未运行」且复制按钮禁用；
 *   4. 代理行恒在（不受实例有无影响）。
 *
 * 「API Key」小节 ——
 *   1. 密钥默认**掩码**展示 —— 列表里不能出现明文；
 *   2. 新建要先填名字，并且新建 / 停用 / 删除都写回主进程（不经过「保存并重启」）。
 *
 * happy-dom 提供真实 DOM（Radix 的 Tooltip / Dialog 需要），afterAll 还原全局。
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

const PLAIN_KEY = "osk-abcdefghijklmnopqrstuvwx";
const keys = [
  { id: "k1", name: "笔记本", key: PLAIN_KEY, enabled: true, createdAt: 1_700_000_000_000 },
  { id: "k2", name: "CI", key: "osk-zzzzzzzzzzzzzzzzzzzzzzzz", enabled: false, createdAt: 1_700_000_100_000 },
];
const createCalls: { name: string }[] = [];
const toggleCalls: { id: string; enabled: boolean }[] = [];
const deleteCalls: string[] = [];

mock.module("@lib/rpc", () => ({
  rpcClient: {
    getGatewayStatus: async () => ({
      enabled: true,
      status: "running" as const,
      host: "127.0.0.1",
      port: 10000,
      configuredPort: 10000,
      url: GATEWAY_URL,
      upstreamStatus: { status: "stopped" as const },
    }),
    getSettings: async () => ({
      settings: {
        GATEWAY_ENABLED: "1",
        GATEWAY_PORT: "10000",
        GATEWAY_API_KEY: "",
      },
    }),
    listGatewayKeys: async () => ({ keys }),
    createGatewayKey: async (params: { name: string }) => {
      createCalls.push(params);
      return { ok: true, key: { id: "k3", ...params, key: PLAIN_KEY, enabled: true, createdAt: Date.now() } };
    },
    setGatewayKeyEnabled: async (params: { id: string; enabled: boolean }) => {
      toggleCalls.push(params);
      return { ok: true };
    },
    deleteGatewayKey: async (params: { id: string }) => {
      deleteCalls.push(params.id);
      return { ok: true };
    },
    openGatewayDocs: async () => ({ ok: true }),
    updateSettings: async () => ({ ok: true }),
    restartGateway: async () => ({ ok: true }),
    startGateway: async () => ({ ok: true }),
    stopGateway: async () => ({ ok: true }),
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

const zh = (key: string, params?: Record<string, string>) => translate("zh", key, params);

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

/** 按文案找按钮（happy-dom 里没有 testing-library，手写一份等价的）。 */
function buttonByText(root: ParentNode, label: string): HTMLElement | undefined {
  return [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as
    | HTMLElement
    | undefined;
}

/** 图标按钮没有文字标签，按 aria-label / title 找。 */
function iconButton(root: ParentNode, label: string): HTMLElement | undefined {
  return [...root.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === label || b.getAttribute("title") === label,
  ) as HTMLElement | undefined;
}

/** Radix 弹窗挂在 document.body 的 portal 上，不在渲染容器里（关掉的那个不算）。 */
function dialogButton(label: string): HTMLElement | undefined {
  const dialog = document.querySelector('[role="dialog"]:not([data-state="closed"])');
  return dialog ? buttonByText(dialog, label) : undefined;
}

/**
 * 往受控输入框里打字。React 在元素实例上覆写了 value 的 setter 用于变更追踪，
 * 直接赋值再派发 input 事件会被它判成"没变"、不触发 onChange —— 必须走原型上的
 * 原生 setter（testing-library 内部也是这么做的）。
 */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(input) as object,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
}

async function settle() {
  await flush();
}

// ---------------------------------------------------------------------------
// 嵌入服务端点
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// API Key 小节
// ---------------------------------------------------------------------------

test("密钥默认掩码展示：列表里没有明文，点「显示」才出现", async () => {
  const view = await renderGateway();
  expect(view.errors).toEqual([]);
  const { container, text } = view;

  expect(text).toContain("笔记本");
  expect(text).toContain("osk-************");
  expect(text).not.toContain(PLAIN_KEY);

  const reveal = iconButton(container, zh("settings.gateway.keys.reveal"));
  expect(reveal).toBeDefined();
  await act(async () => {
    reveal!.click();
  });
  await settle();
  expect(container.textContent ?? "").toContain(PLAIN_KEY);
  // 只有被点开的那一把明文可见，其它行照旧掩码。
  expect(container.textContent ?? "").toContain("osk-************");

  await view.unmount();
});

test("新建密钥：不填名字不能保存，填了才把名字交给主进程", async () => {
  const view = await renderGateway();
  const { container } = view;

  const newButton = buttonByText(container, zh("settings.gateway.keys.new"));
  expect(newButton).toBeDefined();
  await act(async () => {
    newButton!.click();
  });
  await settle();

  const saveButton = dialogButton(zh("settings.gateway.keys.save"));
  expect(saveButton).toBeDefined();
  expect(saveButton!.hasAttribute("disabled")).toBe(true);

  const nameInput = document.querySelector<HTMLInputElement>("#gateway-key-name");
  expect(nameInput).not.toBeNull();
  await act(async () => {
    typeInto(nameInput!, "CI runner");
  });
  await settle();

  const enabledSave = dialogButton(zh("settings.gateway.keys.save"));
  expect(enabledSave!.hasAttribute("disabled")).toBe(false);
  await act(async () => {
    enabledSave!.click();
  });
  await settle();
  expect(createCalls).toEqual([{ name: "CI runner" }]);

  await view.unmount();
});

test("停用 / 删除直达主进程（停用最后一把要确认）", async () => {
  const view = await renderGateway();
  const { container } = view;

  // 已停用的那一把只提供「启用」，点了立即写回。
  const enable = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === zh("settings.gateway.keys.enable"),
  );
  expect(enable).toBeDefined();
  await act(async () => {
    enable!.click();
  });
  await settle();
  expect(toggleCalls).toEqual([{ id: "k2", enabled: true }]);

  // 唯一的启用 Key 点「停用」先弹确认，确认后才落库。
  const disable = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === zh("settings.gateway.keys.disable"),
  );
  expect(disable).toBeDefined();
  await act(async () => {
    disable!.click();
  });
  await settle();
  expect(document.body.textContent ?? "").toContain(
    zh("settings.gateway.keys.disableLastTitle"),
  );
  expect(toggleCalls).toHaveLength(1);

  const confirmDisable = dialogButton(zh("settings.gateway.keys.disable"));
  expect(confirmDisable).toBeDefined();
  await act(async () => {
    confirmDisable!.click();
  });
  await settle();
  expect(toggleCalls).toHaveLength(2);

  const del = iconButton(container, zh("settings.gateway.keys.delete"));
  expect(del).toBeDefined();
  await act(async () => {
    del!.click();
  });
  await settle();
  expect(document.body.textContent ?? "").toContain(zh("settings.gateway.keys.deleteTitle"));

  const deleteConfirm = dialogButton(zh("settings.gateway.keys.delete"));
  expect(deleteConfirm).toBeDefined();
  await act(async () => {
    deleteConfirm!.click();
  });
  await settle();
  expect(deleteCalls).toEqual(["k1"]);

  await view.unmount();
});
