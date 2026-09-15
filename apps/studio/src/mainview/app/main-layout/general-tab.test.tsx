import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 设置 → 偏好 → 通用 → 代理：这张卡决定「谁走代理、谁直连」。
 *
 * 这里锁三件事：
 *   1. 四个采样（模型市场 / 云端接口 / 本地推理 / 局域网）按当前选择给出走代理还是直连，
 *      用的判定与主进程同一份（shared/proxy.ts）——界面上看到的就是真实行为；
 *   2. 自定义代理的地址在保存前就校验（socks、非法地址直接拦下并说明原因）；
 *   3. 保存只写 PROXY_ 三个键，「允许访问本地网络地址」跟着一起落库。
 *
 * happy-dom 提供真实 DOM（Radix 的 Switch / Select 需要），afterAll 还原全局。
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

/** 每次 updateSettings 的补丁，用来确认保存了哪些键。 */
const settingsPatches: Record<string, string>[] = [];
let proxyStatusCalls = 0;

mock.module("@lib/rpc", () => ({
  rpcClient: {
    getProxyStatus: async () => {
      proxyStatusCalls += 1;
      return {
        mode: "system" as const,
        url: "http://127.0.0.1:7890",
        source: "os" as const,
        allowLocalNetwork: true,
        systemUrl: "http://127.0.0.1:7890",
        pacUrl: null,
        exceptions: [],
      };
    },
    testProxy: async () => ({ ok: true, url: "http://127.0.0.1:7890", source: "custom", latencyMs: 42, status: 200 }),
    updateSettings: async ({ settings }: { settings: Record<string, string> }) => {
      settingsPatches.push(settings);
      return { ok: true };
    },
  },
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { GeneralTab } = await import("./general-tab");
const { translate } = await import("../../../shared/i18n");

const zh = (key: string) => translate("zh", key);
/** i18n 里带占位符的句子在断言时只比对前缀，避免把参数也写死进测试。 */
const containsText = (haystack: string, needle: string) => haystack.includes(needle);

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

async function renderTab(initial: Record<string, string>) {
  const form = { ...initial };
  const container = document.createElement("div");
  document.body.appendChild(container);
  // 每个用例都从干净的 body 开始：上一个用例的残留 DOM 会让查询命中旧节点。
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  const updateField = (key: string, value: string) => {
    form[key] = value;
  };
  const render = async () =>
    act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(GeneralTab, { form, updateField }),
        ),
      );
    });
  await render();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    form,
    container,
    text: () => container.textContent ?? "",
    /** 采样行：`data-via-proxy` 就是实时判定结果（谁走代理、谁直连）。 */
    samples: () => [...container.querySelectorAll('[data-slot="proxy-sample"]')],
    viaProxy: () =>
      [...container.querySelectorAll('[data-slot="proxy-sample"][data-via-proxy="true"]')].length,
    saveButton: () =>
      [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "保存"),
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

test("采样按当前选择给出「走代理 / 直连」：自定义代理时云端走、本地与局域网直连", async () => {
  proxyStatusCalls = 0;
  const tab = await renderTab({ PROXY_MODE: "custom", PROXY_URL: "http://127.0.0.1:7890" });
  const text = tab.text();
  expect(containsText(text, zh("settings.proxy.sample.models"))).toBe(true);
  expect(containsText(text, zh("settings.proxy.sample.local"))).toBe(true);
  // 四行采样：云端两个「走代理」，本地与局域网两个「直连」。
  expect(tab.samples()).toHaveLength(4);
  expect(tab.viaProxy()).toBe(2);
  expect(containsText(text, "192.168.1.9:11434")).toBe(true);
  expect(proxyStatusCalls).toBeGreaterThan(0);
  await tab.cleanup();
});

test("「不使用代理」时四行采样全是直连", async () => {
  const tab = await renderTab({ PROXY_MODE: "none" });
  expect(tab.samples()).toHaveLength(4);
  expect(tab.viaProxy()).toBe(0);
  await tab.cleanup();
});

test("自定义代理：socks 地址在保存前就被拦下并说明原因", async () => {
  const tab = await renderTab({ PROXY_MODE: "custom", PROXY_URL: "socks5://127.0.0.1:1080" });
  expect(containsText(tab.text(), "不支持 socks")).toBe(true);
  expect(tab.saveButton()?.disabled).toBe(true);
  await tab.cleanup();
});

test("保存写 PROXY_ 三个键，开关一起落库", async () => {
  settingsPatches.length = 0;
  const tab = await renderTab({
    PROXY_MODE: "custom",
    PROXY_URL: "127.0.0.1:7890",
    PROXY_ALLOW_LOCAL_NETWORK: "0",
  });
  await act(async () => {
    tab.saveButton()!.click();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(settingsPatches).toEqual([
    { PROXY_MODE: "custom", PROXY_URL: "127.0.0.1:7890", PROXY_ALLOW_LOCAL_NETWORK: "0" },
  ]);
  await tab.cleanup();
});

test("「允许访问本地网络地址」关掉后，局域网采样改走代理", async () => {
  const tab = await renderTab({
    PROXY_MODE: "custom",
    PROXY_URL: "http://127.0.0.1:7890",
    PROXY_ALLOW_LOCAL_NETWORK: "0",
  });
  // 云端两个 + 局域网一个 = 3 行走代理，只有本地推理服务直连。
  expect(tab.viaProxy()).toBe(3);
  await tab.cleanup();
});
