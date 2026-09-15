import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

import type { ModelPurpose, ServedModelInfo, ServedModelStatus } from "../../../shared/served-models";

/**
 * 默认模型面板「向量嵌入」卡片的回归测试（②-1 渲染与写入、②-9 空 base 陷阱）。
 *
 * 全局默认嵌入配置只在**写入时**生效（新建 KB 预填、KB 设置页启用按钮），对既有 KB
 * 没有追溯效果 —— 卡片必须把这两点讲出来，并且写入的就是 bun 侧唯一读取点读的那三个键。
 * 这里锁住：
 *   1. 卡片渲染出模型选择器 + 地址 / 密钥输入 + 默认语义说明；没有可用后端时给空态引导；
 *   2. 地址 / 密钥失焦即保存，写的是 EMBEDDING_BASE / EMBEDDING_API_KEY；
 *   3. 从运行中的嵌入实例选模型而地址为空时，保存的补丁带上该实例地址（9b：不落空 base）。
 */

// happy-dom 提供真实 DOM（Radix 的 Select / Tooltip 需要），afterAll 还原全局。
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

/** 当前用例的设置表（getSettings 读它，updateSettings 写它）。 */
let settings: Record<string, string> = {};
/** 当前用例的 served 快照（列表顺序 = 主进程注册表遍历序）。 */
let served: ServedModelInfo[] = [];
const writes: Record<string, string>[] = [];

function instance(id: string, port: number, purpose: ModelPurpose, status: ServedModelStatus): ServedModelInfo {
  return {
    id,
    modelRef: id,
    label: id,
    engine: "llama.cpp",
    port,
    endpoint: `http://127.0.0.1:${port}/v1`,
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
    getSettings: async () => ({ configured: true, settings, platform: "darwin" }),
    updateSettings: async (params: { settings: Record<string, string> }) => {
      writes.push(params.settings);
      Object.assign(settings, params.settings);
      return { ok: true };
    },
    listServedModels: async () => ({ models: served, activeId: null }),
    kbEmbeddingModels: async () => ({
      local: ["bge-m3"],
      remote: ["cloud-embed"],
      service: { base: "http://127.0.0.1:18912", kind: "local" },
      relaxed: false,
    }),
  },
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { EmbeddingModelCard, embeddingDefaultsPatch } = await import("./default-models-panel");
const { TooltipProvider } = await import("@ui/tooltip");
const { useServedStore } = await import("@stores/served");
const { translate } = await import("../../../shared/i18n");

const zh = (key: string) => translate("zh", key);

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

beforeEach(() => {
  settings = {};
  served = [];
  writes.length = 0;
  useServedStore.setState({ models: [], activeId: null, logs: {} });
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderCard() {
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
        createElement(TooltipProvider, null, createElement(EmbeddingModelCard)),
      ),
    );
  });
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

/** React 跟踪 input.value：必须走原生 setter，否则 onChange 认为值没变。 */
function typeInto(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!;
  setValue.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function field(container: HTMLElement, label: string): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  expect(el).not.toBeNull();
  return el!;
}

test("卡片渲染：模型选择器 + 地址 / 密钥输入 + 默认语义说明（②-1）", async () => {
  served = [];
  const view = await renderCard();
  expect(view.errors).toEqual([]);

  expect(view.text).toContain(zh("defaults.embedding"));
  expect(view.text).toContain(zh("defaults.embeddingDesc"));
  expect(view.text).toContain(zh("defaults.embeddingNote"));
  expect(view.text).toContain(zh("defaults.embeddingExistingKb"));
  // 没有全局默认 → 选择器显示「不使用」
  expect(view.text).toContain(zh("kb.create.notUse"));

  expect(field(view.container, zh("defaults.embeddingBase"))).not.toBeNull();
  expect(view.container.querySelector('input[type="password"]')).not.toBeNull();
  // 没有运行实例、也没填地址 → 空态引导（与 KB 选择器同源文案）
  expect(view.text).toContain(zh("kb.settings.noEmbeddingServer"));
  // 没有把 i18n key 原样漏到界面上
  expect(view.text).not.toContain("defaults.embedding");
  await view.unmount();
});

test("有运行中的嵌入实例时不再提示空态", async () => {
  served = [instance("embed", 18912, "embedding", "running")];
  const view = await renderCard();
  expect(view.errors).toEqual([]);
  expect(view.text).not.toContain(zh("kb.settings.noEmbeddingServer"));
  await view.unmount();
});

test("填服务地址 / 密钥并失焦 → 写入对应的设置键（②-1）", async () => {
  served = [];
  const view = await renderCard();

  const base = field(view.container, zh("defaults.embeddingBase"));
  await act(async () => {
    typeInto(base, "https://api.example.com/v1");
  });
  await act(async () => {
    base.dispatchEvent(new Event("focusout", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(writes).toEqual([{ EMBEDDING_BASE: "https://api.example.com/v1" }]);

  const key = view.container.querySelector<HTMLInputElement>('input[type="password"]')!;
  await act(async () => {
    typeInto(key, "sk-test");
  });
  await act(async () => {
    key.dispatchEvent(new Event("focusout", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(writes).toEqual([
    { EMBEDDING_BASE: "https://api.example.com/v1" },
    { EMBEDDING_API_KEY: "sk-test" },
  ]);
  await view.unmount();
});

test("值没变就不发写请求（失焦不产生噪音）", async () => {
  settings = { EMBEDDING_BASE: "https://api.example.com/v1" };
  served = [];
  const view = await renderCard();
  const base = field(view.container, zh("defaults.embeddingBase"));
  expect(base.value).toBe("https://api.example.com/v1");
  await act(async () => {
    base.dispatchEvent(new Event("focusout", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(writes).toEqual([]);
  await view.unmount();
});

// ---------------------------------------------------------------------------
// 手填模型（allowCustom）：候选之外的模型名可直接回车或点「使用」项保存
// ---------------------------------------------------------------------------

/** 手填模式的搜索框（占位符区别于纯搜索模式的 chat.modelSearch）。 */
function findCustomSearch(): HTMLInputElement {
  const el = [...document.querySelectorAll("input")].find(
    (i) => i.placeholder === translate("zh", "kb.modelSelect.searchOrType"),
  );
  expect(el).toBeDefined();
  return el as HTMLInputElement;
}

const zhUseTyped = (model: string) => translate("zh", "kb.modelSelect.useTyped", { model });

/** Radix Select 触发器要求 pointerType === "mouse" 才开下拉 / 选项才认点击。 */
const mousePointer = { bubbles: true, button: 0, pointerType: "mouse" } as const;

async function openEmbedSelect(): Promise<HTMLButtonElement> {
  const trigger = document.querySelector(
    `button[aria-label="${zh("defaults.embedding")}"]`,
  ) as HTMLButtonElement | null;
  expect(trigger).not.toBeNull();
  await act(async () => {
    trigger!.dispatchEvent(new PointerEvent("pointerdown", mousePointer));
  });
  await flush();
  return trigger!;
}

test("手填模型：候选外的名字出现「使用」项，点击保存；候选内的不重复出手填项", async () => {
  served = [];
  const view = await renderCard();
  const trigger = await openEmbedSelect();

  const search = findCustomSearch();

  // 候选内的名字（bge-m3 在本地组）不出现「使用」项
  await act(async () => {
    typeInto(search, "bge-m3");
  });
  expect(
    [...document.querySelectorAll('[role="option"]')].filter((el) =>
      el.textContent?.includes(zhUseTyped("bge-m3")),
    ),
  ).toHaveLength(0);

  // 候选外的名字出现「使用「my-custom-embed」」，点击即保存
  await act(async () => {
    typeInto(search, "my-custom-embed");
  });
  const useItem = [...document.querySelectorAll('[role="option"]')].find((el) =>
    el.textContent?.includes(zhUseTyped("my-custom-embed")),
  );
  expect(useItem).toBeDefined();
  await act(async () => {
    useItem!.dispatchEvent(new PointerEvent("pointerdown", mousePointer));
    useItem!.dispatchEvent(new PointerEvent("pointerup", mousePointer));
  });
  await flush();
  await flush();

  // 手填模型不来自运行实例 → 只写 EMBEDDING_MODEL，不快照实例地址
  expect(writes).toEqual([{ EMBEDDING_MODEL: "my-custom-embed" }]);
  // 触发器回显手填值
  expect(trigger.textContent).toContain("my-custom-embed");
  await view.unmount();
});

test("手填模型：搜索框回车直接提交", async () => {
  served = [];
  const view = await renderCard();
  await openEmbedSelect();

  const search = findCustomSearch();
  await act(async () => {
    typeInto(search, "text-embed-v4");
  });
  await act(async () => {
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await flush();
  await flush();

  expect(writes).toEqual([{ EMBEDDING_MODEL: "text-embed-v4" }]);
  await view.unmount();
});

// ---------------------------------------------------------------------------
// ②-9：空 base 陷阱（规则抽成纯函数，组件里只有这一处判断）
// ---------------------------------------------------------------------------

test("②-9 从运行实例选模型且地址为空 → 补丁带上该实例地址", () => {
  expect(
    embeddingDefaultsPatch({ model: "bge-m3", base: "", fromRunningInstance: true, instancePort: 18912 }),
  ).toEqual({
    EMBEDDING_MODEL: "bge-m3",
    EMBEDDING_BASE: "http://127.0.0.1:18912/v1",
  });
});

test("已填地址时不被实例地址覆盖（用户填的优先）", () => {
  expect(
    embeddingDefaultsPatch({
      model: "bge-m3",
      base: "https://api.example.com/v1",
      fromRunningInstance: true,
      instancePort: 18912,
    }),
  ).toEqual({ EMBEDDING_MODEL: "bge-m3" });
});

test("模型来自云端候选 / 手填 → 不预填地址（没有可快照的实例）", () => {
  expect(
    embeddingDefaultsPatch({
      model: "cloud-embed",
      base: "",
      fromRunningInstance: false,
      instancePort: 18912,
    }),
  ).toEqual({ EMBEDDING_MODEL: "cloud-embed" });
});

test("清空模型（不使用）→ 只写空 model，不动地址", () => {
  expect(
    embeddingDefaultsPatch({ model: "", base: "", fromRunningInstance: false, instancePort: undefined }),
  ).toEqual({ EMBEDDING_MODEL: "" });
});
