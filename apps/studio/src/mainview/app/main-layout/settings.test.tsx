import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 设置导航的回归测试。
 *
 * 两件事：
 *   1. 「偏好 → 通用」这一页在加进代理设置时**整页被删过一次**，页里的设置没跟着丢
 *      （更新通道 / 自动检查更新在「关于」页，启动时自动拉起推理服务搬到了服务器概览页）。
 *      现在它回来了 —— 承载代理设置 —— 这里锁住导航条目与点进去能渲染出代理卡；
 *   2. 概览页上那条自启动开关仍能改到设置。
 *
 * happy-dom 提供真实 DOM（Radix 的 Switch 需要），afterAll 还原全局。
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

/** 每次 updateSettings 的补丁，用来确认开关真的写到了 AUTO_START_SERVER。 */
const settingsPatches: Record<string, string>[] = [];

mock.module("@lib/rpc", () => ({
  rpcClient: {
    getSettings: async () => ({ settings: {} }),
    getServerStats: async () => ({
      sessionStartedAt: Date.now(),
      serverStartedAt: 0,
      prefillTokens: 0,
      generationTokens: 0,
      requests: 0,
      prefillTokensPerSec: 0,
      generationTokensPerSec: 0,
      activeModels: [],
      system: {
        loadAvg: [0, 0, 0],
        totalMem: 16e9,
        freeMem: 8e9,
        disk: { total: 1e12, free: 5e11 },
      },
      modelsSize: 0,
    }),
    getServerStatus: async () => ({ status: "stopped" as const }),
    listServedModels: async () => ({ models: [] }),
    updateSettings: async ({ settings }: { settings: Record<string, string> }) => {
      settingsPatches.push(settings);
      return { settings: {} };
    },
    getProxyStatus: async () => ({
      mode: "system" as const,
      url: "",
      source: "none" as const,
      allowLocalNetwork: true,
      systemUrl: "",
      pacUrl: null,
      exceptions: [],
    }),
    testProxy: async () => ({ ok: true, url: "", source: "none" }),
  },
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { SettingsScreen } = await import("./settings");
const { translate } = await import("../../../shared/i18n");

const zh = (key: string) => translate("zh", key);

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

async function renderSettings() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(SettingsScreen)));
  });
  // 一拍给查询解析，一拍给渲染。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    text: document.body.textContent ?? "",
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

test("设置导航就是这一份：通用（代理）在偏好分组里，没有「性能」「记忆」这类重复入口", async () => {
  const { text, cleanup } = await renderSettings();
  const nav = document.querySelector("nav[aria-label]");
  expect(nav).not.toBeNull();
  const labels = [...nav!.querySelectorAll("button")].map((b) => b.textContent?.trim());
  expect(labels).toEqual([
    "概览",
    "模型云服务",
    "默认模型",
    "本地模型",
    "模型库",
    "在线模型市场",
    "网关",
    "集成",
    "联网检索",
    "MCP",
    "Agent 权限",
    "Agent 能力",
    "命令行",
    "通用",
    "外观",
    "关于我们",
    "使用统计",
    "控制台",
    "备份与恢复",
  ]);
  // 删掉的页面没有留下把 i18n key 原样渲染出来的残留。
  expect(text).not.toContain("settings.prefs.");
  await cleanup();
});

test("点「通用」进得去代理卡：模式、本地网络开关、采样都在", async () => {
  const { cleanup } = await renderSettings();
  const nav = document.querySelector("nav[aria-label]");
  const general = [...nav!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "通用");
  expect(general).not.toBeUndefined();
  await act(async () => {
    (general as unknown as HTMLElement).click();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const text = document.body.textContent ?? "";
  expect(text).toContain(zh("settings.proxy.title"));
  expect(text).toContain(zh("settings.proxy.allowLocalNetwork"));
  expect(document.querySelectorAll('[data-slot="proxy-sample"]')).toHaveLength(4);
  await cleanup();
});

test("自启动开关落在概览页：默认开启，关掉后写入 AUTO_START_SERVER=0", async () => {
  const { text, cleanup } = await renderSettings();
  expect(text).toContain(zh("settings.autoStart"));

  const toggle = document.querySelector('[data-slot="switch"]');
  expect(toggle).not.toBeNull();
  expect(toggle!.getAttribute("aria-checked")).toBe("true"); // 未设置过 = 默认 "1"

  settingsPatches.length = 0;
  await act(async () => {
    (toggle as unknown as HTMLElement).click();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(settingsPatches).toEqual([{ AUTO_START_SERVER: "0" }]);
  await cleanup();
});

test("原「性能」页的参数在本地模型页都有入口（删页面不丢设置）", async () => {
  const { PARAM_FIELDS, PIPELINE_FIELDS } = await import("../local-models-screen");
  const keys = new Set([
    ...Object.values(PARAM_FIELDS).flat().map((f) => f.key),
    ...PIPELINE_FIELDS.map((f) => f.key),
    // KV 缓存只留一个控件，改 K 时同时写 V（旧「性能」页是两个下拉）。
    "SERVER_CACHE_TYPE_V",
  ]);
  for (const key of [
    "SERVER_CTX_SIZE",
    "SERVER_GPU_LAYERS",
    "SERVER_PARALLEL",
    "SERVER_BATCH_SIZE",
    "SERVER_UBATCH_SIZE",
    "SERVER_CACHE_TYPE_K",
    "MAX_VLLM_RETRIES",
    "MAX_VLLM_FAILURE_RETRIES",
    "PAGE_CONCURRENCY",
  ]) {
    expect({ key, listed: keys.has(key) }).toEqual({ key, listed: true });
  }
});
