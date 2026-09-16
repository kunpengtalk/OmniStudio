import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

import type { CloudProviderInfo } from "../../shared/cloud-providers";

/**
 * 云端通话配置引导的回归测试。
 *
 * 这里锁住的是一个真实崩溃：引导面板在 `.find()` 的回调里读 `providerId`，而那个
 * `useState` 声明写在下面几行 —— 只要厂商列表非空，整个面板就抛
 * `ReferenceError: Cannot access 'providerId' before initialization`，
 * 「通话 → 云端模式」整页打不开。当时的测试套件没有任何用例渲染这个面板。
 *
 * happy-dom 提供真实 DOM（Radix 的 Select 需要），afterAll 还原全局。
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

/** 百炼（DashScope）+ 一个自建中转：引导里前者要排前面。 */
const PROVIDERS: CloudProviderInfo[] = [
  {
    id: "relay",
    name: "自建中转",
    vendor: "测试",
    baseUrl: "https://relay.example/v1",
    apiKey: "sk-relay",
    models: [{ id: "qwen-audio-3.0-realtime-plus" }],
    enabled: true,
    videoApi: "",
    musicApi: "",
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "bailian",
    name: "百炼",
    vendor: "阿里云",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: "sk-bailian",
    models: [{ id: "qwen-audio-3.0-realtime-plus" }],
    enabled: true,
    videoApi: "",
    musicApi: "",
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "off",
    name: "没启动的厂商",
    vendor: "测试",
    baseUrl: "https://off.example/v1",
    apiKey: "sk-off",
    models: [{ id: "qwen-audio-3.0-realtime-plus" }],
    enabled: false,
    videoApi: "",
    musicApi: "",
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "stepfun",
    name: "阶跃星辰",
    vendor: "StepFun",
    baseUrl: "https://api.stepfun.com/v1",
    apiKey: "sk-step",
    models: [{ id: "stepaudio-3-realtime-preview", type: "other" }],
    enabled: true,
    videoApi: "",
    musicApi: "",
    createdAt: 0,
    updatedAt: 0,
  },
];

mock.module("@lib/rpc", () => ({
  rpcClient: {
    cloudProviderList: async () => ({ providers: PROVIDERS, activeId: null }),
    voicecallGetProviderConfig: async () => ({
      config: {
        providerId: "",
        apiKey: "",
        baseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
        model: "qwen-audio-3.0-realtime-plus",
        voice: "longanqian",
      },
    }),
  },
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { CloudSetupGuide } = await import("./voice-call-screen");

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

async function renderGuide() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(CloudSetupGuide, { configured: false }),
      ),
    );
  });
  // 一拍给查询解析，一拍给渲染。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

test("厂商列表非空时引导面板能渲染（曾经的崩溃条件）", async () => {
  const { cleanup } = await renderGuide();
  // 崩在渲染里的话这里根本到不了；顺带确认查询结果真的进了面板。
  expect(document.body.textContent ?? "").not.toBe("");
  await cleanup();
});

test("只列已启用的厂商，认得出的实时厂商排在最前", async () => {
  const { cleanup } = await renderGuide();
  const trigger = document.querySelector('[data-slot="select-trigger"]');
  expect(trigger).not.toBeNull();
  // 展开下拉，读出可选项的顺序。
  await act(async () => {
    (trigger as unknown as HTMLElement).click();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const items = [...document.querySelectorAll('[role="option"]')].map((el) =>
    (el.textContent ?? "").trim(),
  );
  // 百炼与阶跃是认得出的实时厂商（地址能推出实时端点），排在建了实时中转的那家前面。
  expect(items).toEqual(["百炼", "阶跃星辰", "自建中转"]);
  expect(items).not.toContain("没启动的厂商");
  await cleanup();
});

test("换厂商时模型与音色一起跟着换（阶跃的模型名和音色名百炼那边都不存在）", async () => {
  const { cleanup } = await renderGuide();
  const trigger = document.querySelector('[data-slot="select-trigger"]');
  await act(async () => {
    (trigger as unknown as HTMLElement).click();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const option = [...document.querySelectorAll('[role="option"]')].find(
    (el) => (el.textContent ?? "").trim() === "阶跃星辰",
  ) as unknown as HTMLElement | undefined;
  expect(option).toBeDefined();
  await act(async () => {
    // Radix 的选项靠 pointerdown 选中（happy-dom 的 PointerEvent 与 DOM 类型对不上，故断言）。
    option!.dispatchEvent(
      new dom.PointerEvent("pointerdown", { bubbles: true, button: 0 }) as unknown as Event,
    );
    option!.click();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  // 模型：换成实时端点后，下拉里应能选到该厂商的实时模型；
  // 音色：输入框里已填上阶跃的默认音色（把 longanqian 发过去只会被上游拒掉）。
  const inputs = [...document.querySelectorAll("input")].map((el) => el.value);
  expect(inputs).toContain("linjiajiejie");
  const text = document.body.textContent ?? "";
  expect(text).toContain("stepaudio-3-realtime-preview");
  await cleanup();
});
