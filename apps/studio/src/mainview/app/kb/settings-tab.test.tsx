import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 知识库设置页的回归测试。
 *
 * 之前这一页让用户手填「模型 ID + 接口地址 + API Key」——本地推理服务明明不需要密钥，
 * 也要面对一堆密钥字段；数值参数还挤在一行里溢出卡片（召回条数跑到卡片外面）。
 * 这里把三件事钉住：
 *   1. 默认（没自定义地址）不出现密钥输入，服务行说明本地服务无需 Key；
 *   2. 模型是「从候选里选」，当前值不在候选里也照样显示；
 *   3. 已自定义地址的知识库自动展开高级区，密钥/地址可改；
 *   4. 三个数值参数在同一网格里（不再横向溢出）。
 */

// happy-dom 提供真实 DOM（Radix 的 Select / Collapsible 需要），afterAll 还原全局。
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

const KNOWN_EMBED = "bge-m3";
const KNOWN_RERANK = "bge-reranker-v2-m3";
const LOCAL_BASE = "http://127.0.0.1:8123";

const updates: { patch: Record<string, unknown> }[] = [];
mock.module("@lib/rpc", () => ({
  rpcClient: {
    kbEmbeddingModels: async () => ({
      local: [KNOWN_EMBED],
      remote: [],
      service: { base: LOCAL_BASE, kind: "local" },
      relaxed: false,
    }),
    kbRerankModels: async () => ({
      local: [KNOWN_RERANK],
      remote: [],
      service: { base: LOCAL_BASE, kind: "local" },
      relaxed: false,
    }),
    kbUpdate: async (params: { patch: Record<string, unknown> }) => {
      updates.push(params);
      return { kb: {}, embeddingsReset: false };
    },
    kbTestEmbedding: async () => ({ ok: true, dim: 1024 }),
    kbTestRerank: async () => ({ ok: true }),
    kbDelete: async () => ({ ok: true }),
  },
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { KbSettingsTab } = await import("./settings-tab");
const { TooltipProvider } = await import("@ui/tooltip");
const { translate } = await import("../../../shared/i18n");

const zh = (key: string, params?: Record<string, string>) => translate("zh", key, params);

type KbFixture = Parameters<typeof KbSettingsTab>[0]["kb"];

/** 默认知识库：本地推理服务的模型（值是云端风格的 id，不在候选列表里）。 */
function kbFixture(overrides: Partial<KbFixture> = {}): KbFixture {
  return {
    id: 1,
    name: "Test",
    description: null,
    embeddingModel: "BAAI/bge-m3",
    embeddingBase: "",
    embeddingApiKey: "",
    embeddingDim: 1024,
    rerankModel: "",
    rerankBase: "",
    rerankApiKey: "",
    chunkSize: 800,
    chunkOverlap: 120,
    topK: 6,
    minScore: 0,
    expandNeighbors: true,
    mcpExposed: false,
    docCount: 1,
    chunkCount: 50,
    embeddedCount: 50,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

async function renderSettings(kb: KbFixture) {
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
        createElement(TooltipProvider, null, createElement(KbSettingsTab, { kb })),
      ),
    );
  });
  // 等候选模型查询落地（服务行 / 分组标题依赖它）
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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

test("默认不出现密钥输入：模型从候选里选，服务行说明本地服务无需 Key", async () => {
  const view = await renderSettings(kbFixture());
  expect(view.errors).toEqual([]);
  // 没有密钥字段（高级区收起）
  expect(view.container.querySelectorAll('input[type="password"]').length).toBe(0);
  // 当前值不在候选列表里也显示出来，不会被清空
  expect(view.text).toContain("BAAI/bge-m3");
  // 服务行说清会用哪个服务、要不要密钥
  expect(view.text).toContain(zh("kb.settings.serviceLocal"));
  expect(view.text).toContain(LOCAL_BASE);
  expect(view.text).toContain(zh("kb.settings.serviceNoKey"));
  // 没有把 i18n key 原样漏到界面上
  expect(view.text).not.toContain("kb.settings.");
  await view.unmount();
});

test("已自定义地址 / 密钥的知识库：高级区自动展开且值可编辑", async () => {
  const view = await renderSettings(
    kbFixture({ embeddingBase: "https://api.example.com/v1", embeddingApiKey: "sk-test" }),
  );
  expect(view.errors).toEqual([]);
  const secret = view.container.querySelector<HTMLInputElement>('input[type="password"]');
  expect(secret?.value).toBe("sk-test");
  expect(view.text).toContain(zh("kb.settings.advancedOn"));
  await view.unmount();
});

test("切片与检索三个参数在同一网格里（不再横向溢出卡片）", async () => {
  const view = await renderSettings(kbFixture());
  const chunkSize = view.container.querySelector("#kb-chunk-size");
  const chunkOverlap = view.container.querySelector("#kb-chunk-overlap");
  const topK = view.container.querySelector("#kb-top-k");
  expect(chunkSize).not.toBeNull();
  expect(chunkOverlap).not.toBeNull();
  expect(topK).not.toBeNull();
  const grid = chunkSize!.parentElement?.parentElement;
  expect(grid?.className).toContain("grid");
  expect(grid).toBe(chunkOverlap!.parentElement?.parentElement);
  expect(grid).toBe(topK!.parentElement?.parentElement);
  await view.unmount();
});

test("改名称后保存把补丁发给 kbUpdate", async () => {
  updates.length = 0;
  const view = await renderSettings(kbFixture());
  const nameInput = view.container.querySelector<HTMLInputElement>("#kb-settings-name");
  expect(nameInput).not.toBeNull();
  // React 会跟踪 input.value：必须先走原生 setter，否则 onChange 认为值没变。
  const setValue = Object.getOwnPropertyDescriptor(
    dom.HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setValue.call(nameInput, "Test 2");
    // 全局 Event 已被换成 happy-dom 的实现（类型上仍按 DOM 的 Event 走）
    nameInput!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const save = [...view.container.querySelectorAll("button")].find(
    (b) => b.textContent?.includes(zh("common.save")),
  );
  expect(save).toBeDefined();
  await act(async () => {
    save!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(updates.length).toBe(1);
  expect(updates[0]!.patch.name).toBe("Test 2");
  // 没填自定义地址 → 地址/key 保持空，走本地推理服务
  expect(updates[0]!.patch.embeddingBase).toBe("");
  expect(updates[0]!.patch.embeddingModel).toBe("BAAI/bge-m3");
  await view.unmount();
});
