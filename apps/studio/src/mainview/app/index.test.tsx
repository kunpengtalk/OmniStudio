import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 引导页的**放行**：点了「跳过 / 完成」之后必须进主界面，不能等设置读回来。
 *
 * 这条路径正是"进不去系统"的那个现场：设置表里有外机密文时 `getSettings` 会报错，
 * 外层拿不到 data，于是永远判成"没配置好" → 恒久停在引导页（点跳过也没用）。
 * 设置读取侧现在不会抛了（见 bun/secrets.test.ts），这里再钉住界面这一层的兜底。
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

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

/** getSettings 报错（就像设置表里有解不开的密文那样）。 */
let settingsError: Error | null = new Error("getSettings 失败");
/** 读得回来时，主进程说配置好了没有。 */
let configured = false;
const updateSettingsCalls: Record<string, string>[] = [];

mock.module("@lib/rpc", () => ({
  rpcClient: {
    getSettings: async () => {
      if (settingsError) throw settingsError;
      return { configured, settings: {}, platform: "darwin" };
    },
    getUpdateState: async () => ({}),
    updateSettings: async ({ settings }: { settings: Record<string, string> }) => {
      updateSettingsCalls.push(settings);
      return { ok: true };
    },
    getSetupEnvironment: async () => ({
      platform: "darwin",
      arch: "arm64",
      appleSilicon: true,
      hasNvidiaGpu: false,
      installSupport: {},
      installedVersions: {},
      installing: null,
      llama: { found: true },
      vllm: { found: false },
      sglang: { found: false },
      mlx: { found: false },
      omlx: { found: false },
    }),
    listInstalledModels: async () => ({ models: [] }),
    listDownloads: async () => ({ tasks: [] }),
    writeAppLog: async () => ({ ok: true }),
  },
}));

// 主界面是另一棵树（真实的会拉起一堆页面与查询）：这里只验「有没有被放行到它」。
mock.module("./main-layout", () => ({
  MainLayout: () => createElement("div", { "data-testid": "main-layout" }, "MAIN"),
}));

const { App } = await import("./index");

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderApp() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(App)));
  });
  await settle();
  await settle();
  return {
    text: () => document.body.textContent ?? "",
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

test("读设置报错时先落到引导页；点「跳过」就进主界面（不再被卡住）", async () => {
  settingsError = new Error("getSettings 失败");
  updateSettingsCalls.length = 0;
  const view = await renderApp();

  expect(view.text()).toContain("Skip — enter the app");
  expect(view.text()).not.toContain("MAIN");

  const skip = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === "Skip — enter the app",
  )!;
  await act(async () => {
    skip.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await settle();

  expect(updateSettingsCalls).toEqual([{ SETUP_COMPLETE: "1" }]);
  expect(view.text()).toContain("MAIN"); // 放行成功：即便设置读回来仍在报错
  await view.cleanup();
  document.body.innerHTML = "";
});

test("设置读得回来且已配置好：直接是主界面，不经过引导页", async () => {
  settingsError = null;
  configured = true;
  const view = await renderApp();

  expect(view.text()).toContain("MAIN");
  expect(view.text()).not.toContain("Skip — enter the app");
  await view.cleanup();
  document.body.innerHTML = "";

  configured = false;
  settingsError = new Error("getSettings 失败");
});
