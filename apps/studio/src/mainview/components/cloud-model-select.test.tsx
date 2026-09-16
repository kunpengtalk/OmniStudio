import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

import type { CloudProviderInfo } from "../../shared/cloud-providers";

// Radix 的 Select 走 Portal，静态渲染拿不到 —— 这个文件用 happy-dom 提供真实 DOM
// （与 media-setup-dialog.test.tsx 同一套做法），afterAll 还原，避免影响其它测试文件。
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

/** 「已启动的有生图模型」「已启动但只有对话模型」「没启动但有生图模型」三种厂商。 */
const PROVIDERS: CloudProviderInfo[] = [
  {
    id: "img",
    name: "有生图模型",
    vendor: "测试",
    baseUrl: "https://img.example/v1",
    apiKey: "sk-1",
    models: [{ id: "flux-dev" }, { id: "gpt-image-1", type: "image" }, { id: "qwen-max", type: "chat" }],
    enabled: true,
    videoApi: "",
    musicApi: "",
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "chat-only",
    name: "只有对话模型",
    vendor: "测试",
    baseUrl: "https://chat.example/v1",
    apiKey: "sk-2",
    models: [{ id: "qwen3-8b", type: "chat" }],
    enabled: true,
    videoApi: "",
    musicApi: "",
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "off",
    name: "没启动",
    vendor: "测试",
    baseUrl: "https://off.example/v1",
    apiKey: "sk-3",
    models: [{ id: "sdxl", type: "image" }],
    enabled: false,
    videoApi: "",
    musicApi: "",
    createdAt: 0,
    updatedAt: 0,
  },
];

mock.module("@lib/rpc", () => ({
  rpcClient: {
    cloudProviderList: async () => ({ providers: PROVIDERS, activeId: null }),
  },
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { CloudModelSelect } = await import("./cloud-model-select");
const { translate } = await import("../../shared/i18n");

const zh = (key: string) => translate("zh", key);

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

async function renderPicker(kind: "image" | "tts", providerId = "", model = "") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  // staleTime: Infinity + 预塞缓存：断言不依赖 react-query 的请求周期，也不受
  // 同进程里其它测试文件 mock 掉 @lib/rpc（bun 的 mock.module 会跨文件泄漏）影响。
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  client.setQueryData(["cloud-providers"], { providers: PROVIDERS, activeId: null });
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(CloudModelSelect, { kind, providerId, model, onChange: () => {} }),
      ),
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  const text = document.body.textContent ?? "";
  await act(async () => {
    root.unmount();
  });
  container.remove();
  return text;
}

test("已启动且有生图模型的厂商：不进空态（选择器可用）", async () => {
  const text = await renderPicker("image");
  expect(text).toContain(zh("cloud.pick.vendor"));
  expect(text).toContain(zh("cloud.pick.model"));
  // 有候选厂商 → 不需要「去设置配置云厂商」的空态引导。
  expect(text).not.toContain(zh("cloud.pick.configure"));
});

test("用途对不上（只配了对话模型的厂商）：按空态处理，引导去设置", async () => {
  const text = await renderPicker("tts");
  expect(text).toContain(zh("cloud.pick.configure"));
});

test("选中的厂商照常显示（即使它已停用 / 没有该用途的模型）", async () => {
  const text = await renderPicker("image", "off", "sdxl");
  expect(text).toContain("没启动");
  expect(text).toContain("sdxl");
});
