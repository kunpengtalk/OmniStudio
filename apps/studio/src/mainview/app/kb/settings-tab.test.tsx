import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

import type { ModelPurpose, ServedModelInfo, ServedModelStatus } from "../../../shared/served-models";

/**
 * 知识库设置页的回归测试。
 *
 * 之前这一页让用户手填「模型 ID + 接口地址 + API Key」——本地推理服务明明不需要密钥，
 * 也要面对一堆密钥字段；数值参数还挤在一行里溢出卡片（召回条数跑到卡片外面）。
 * 这里把几件事钉住：
 *   1. 默认（没自定义地址）不出现密钥输入，服务行说明本地服务无需 Key；
 *   2. 模型是「从候选里选」，当前值不在候选里也照样显示；
 *   3. 已自定义地址的知识库自动展开高级区，密钥/地址可改；
 *   4. 三个数值参数在同一网格里（不再横向溢出）；
 *   5. 空配置库的「启用向量检索」：写入全局默认三字段**并且**真的按入重嵌（②-4）；
 *      后端不可解析 / 没有全局默认时按钮禁用并给出下一步（②-11）。
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

const updates: { id?: number; patch: Record<string, unknown> }[] = [];
/** 「启用向量检索」是否真的按入重嵌（不是只写配置 / 只清空向量）。 */
const embedMissingCalls: { kbId: number }[] = [];
/** 当前用例的设置表（getSettings 读它：全局默认嵌入三键 + 后端判据）。 */
let settingsMap: Record<string, string> = {};
/** 当前用例的 served 快照（有无运行中的嵌入实例）。 */
let servedModels: ServedModelInfo[] = [];

function instance(port: number, purpose: ModelPurpose, status: ServedModelStatus): ServedModelInfo {
  return {
    id: `i-${port}`,
    modelRef: "bge-m3",
    label: "bge-m3",
    engine: "llama.cpp",
    port,
    endpoint: `http://127.0.0.1:${port}/v1`,
    servedName: "bge-m3",
    purpose,
    status,
    usesDefaultPort: false,
    isActive: false,
    isDir: false,
  };
}

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
    kbUpdate: async (params: { id: number; patch: Record<string, unknown> }) => {
      updates.push(params);
      return { kb: {}, embeddingsReset: false };
    },
    kbTestEmbedding: async () => ({ ok: true, dim: 1024 }),
    kbTestRerank: async () => ({ ok: true }),
    kbDelete: async () => ({ ok: true }),
    getSettings: async () => ({ configured: true, settings: settingsMap, platform: "darwin" }),
    listServedModels: async () => ({ models: servedModels, activeId: null }),
    kbEmbedMissing: async (params: { kbId: number }) => {
      embedMissingCalls.push(params);
      return { ok: true, embedded: 12 };
    },
    cloudProviderList: async () => ({
      providers: [
        {
          id: "p1",
          name: "云端一号",
          enabled: true,
          baseUrl: "https://cloud.example.com/v1",
          apiKey: "",
          models: [{ id: "cloud-embed", type: "embedding" }],
        },
      ],
    }),
  },
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { KbSettingsTab } = await import("./settings-tab");
const { TooltipProvider } = await import("@ui/tooltip");
const { translate } = await import("../../../shared/i18n");
const { useServedStore } = await import("@stores/served");

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
    embeddingProviderId: "",
    embeddingDim: 1024,
    rerankModel: "",
    rerankBase: "",
    rerankApiKey: "",
    rerankProviderId: "",
    chunkSize: 800,
    chunkOverlap: 120,
    topK: 6,
    minScore: 0,
    expandNeighbors: true,
    mcpExposed: false,
    embedImage: false,
    embedAudio: false,
    embedVideo: false,
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

test("选了云服务商：不再出现地址/密钥输入，服务行指向该厂商，保存带上 providerId", async () => {
  updates.length = 0;
  const view = await renderSettings(
    kbFixture({ embeddingProviderId: "p1", embeddingModel: "cloud-embed" }),
  );
  expect(view.errors).toEqual([]);
  // 有了云服务商就不该再让用户填地址 / 密钥
  expect(view.container.querySelectorAll('input[type="password"]').length).toBe(0);
  expect(view.container.querySelector("#kb-embedding-provider")).not.toBeNull();
  expect(view.text).not.toContain("kb.settings.");

  // 先把表单改脏，保存按钮才会启用
  const nameInput = view.container.querySelector<HTMLInputElement>("#kb-settings-name");
  const setValue = Object.getOwnPropertyDescriptor(
    dom.HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setValue.call(nameInput, "Test 2");
    nameInput!.dispatchEvent(new Event("input", { bubbles: true }));
  });

  const save = [...view.container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(zh("common.save")),
  );
  expect(save).toBeDefined();
  await act(async () => {
    save!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(updates.length).toBe(1);
  expect(updates[0]!.patch.embeddingProviderId).toBe("p1");
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

// ---------------------------------------------------------------------------
// 模态能力三布尔（KbView 快照进表单；保存透传 kbUpdate patch）
// ---------------------------------------------------------------------------

test("模态能力勾选：初始值来自库行，保存透传进 kbUpdate patch", async () => {
  updates.length = 0;
  // 页面上唯一的 checkbox input 就是三个模态复选框（Switch 是 button[role=switch]）
  const view = await renderSettings(kbFixture({ embedAudio: true }));
  expect(view.errors).toEqual([]);
  const boxes = view.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  expect(boxes.length).toBe(3);
  const [image, audio, video] = boxes;
  expect(image!.checked).toBe(false);
  expect(audio!.checked).toBe(true);
  expect(video!.checked).toBe(false);

  // 勾上「图片」再保存 → patch 带三布尔（未动的保持库行值）
  await act(async () => {
    image!.click();
  });
  const save = [...view.container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(zh("common.save")),
  );
  expect(save).toBeDefined();
  await act(async () => {
    save!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(updates.length).toBe(1);
  expect(updates[0]!.patch.embedImage).toBe(true);
  expect(updates[0]!.patch.embedAudio).toBe(true);
  expect(updates[0]!.patch.embedVideo).toBe(false);
  await view.unmount();
});

// ---------------------------------------------------------------------------
// 「启用向量检索」（②-4 写入三字段 + 真重嵌；②-11 后端不可解析时禁用）
// ---------------------------------------------------------------------------

beforeEach(() => {
  updates.length = 0;
  embedMissingCalls.length = 0;
  settingsMap = {};
  servedModels = [];
  // store 是模块级单例：清掉上一个用例的快照，避免残留实例被当成「运行中」。
  useServedStore.setState({ models: [], activeId: null, logs: {} });
});

/** 找到「启用向量检索」按钮（标题与描述共享文案，按钮才含这个字样）。 */
function enableButton(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(zh("kb.settings.enableEmbedding")),
  );
  expect(button).toBeDefined();
  return button as HTMLButtonElement;
}

test("空配置库点「启用向量检索」：写入全局默认三字段并真的按入重嵌（②-4）", async () => {
  settingsMap = {
    EMBEDDING_MODEL: "bge-m3",
    EMBEDDING_BASE: "http://127.0.0.1:18912/v1",
    EMBEDDING_API_KEY: "sk-global",
  };
  const view = await renderSettings(kbFixture({ embeddingModel: "", embeddingDim: null }));
  expect(view.errors).toEqual([]);

  const button = enableButton(view.container);
  expect(button.disabled).toBe(false);

  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(updates.length).toBe(1);
  expect(updates[0]!.id).toBe(1);
  expect(updates[0]!.patch).toEqual({
    embeddingModel: "bge-m3",
    embeddingBase: "http://127.0.0.1:18912/v1",
    embeddingApiKey: "sk-global",
  });
  // 真的按入重嵌，不是只写配置（只改配置 / 只清空向量都算验收恒真）
  expect(embedMissingCalls).toEqual([{ kbId: 1 }]);
  await view.unmount();
});

test("有运行实例但全局地址留空 → 点击时快照预填实例地址（按钮路径的空 base 陷阱防护）", async () => {
  settingsMap = { EMBEDDING_MODEL: "bge-m3", EMBEDDING_BASE: "", EMBEDDING_API_KEY: "" };
  servedModels = [instance(18912, "embedding", "running")];
  const view = await renderSettings(kbFixture({ embeddingModel: "", embeddingDim: null }));
  expect(view.errors).toEqual([]);

  const button = enableButton(view.container);
  expect(button.disabled).toBe(false);

  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(updates.length).toBe(1);
  // 全局 base 为空但有 running 实例 → 快照进库行的 base 预填该实例地址：
  // 否则实例一停，该库的解析会落回聊天活动端口（「列得出调不通」）。
  expect(updates[0]!.patch.embeddingBase).toBe("http://127.0.0.1:18912/v1");
  expect(embedMissingCalls).toEqual([{ kbId: 1 }]);
  await view.unmount();
});

test("后端不可解析（无运行实例且无全局地址）→ 按钮禁用并提示（②-11）", async () => {
  settingsMap = { EMBEDDING_MODEL: "bge-m3", EMBEDDING_BASE: "" };
  servedModels = [];
  const view = await renderSettings(kbFixture({ embeddingModel: "", embeddingDim: null }));
  expect(view.errors).toEqual([]);

  const button = enableButton(view.container);
  expect(button.disabled).toBe(true);
  expect(view.text).toContain(zh("kb.settings.enableEmbeddingNoBackend"));

  // 禁用按钮点了也不该发任何请求
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(updates.length).toBe(0);
  expect(embedMissingCalls.length).toBe(0);
  await view.unmount();
});

test("有运行中的嵌入实例（地址留空）→ 后端判据通过，按钮可用（9c）", async () => {  settingsMap = { EMBEDDING_MODEL: "bge-m3", EMBEDDING_BASE: "" };
  servedModels = [instance(18912, "embedding", "running")];
  const view = await renderSettings(kbFixture({ embeddingModel: "", embeddingDim: null }));
  expect(view.errors).toEqual([]);
  expect(enableButton(view.container).disabled).toBe(false);
  await view.unmount();
});

test("没有全局默认模型 → 按钮禁用并指路「默认模型」面板（②-11 前置）", async () => {
  settingsMap = { EMBEDDING_MODEL: "", EMBEDDING_BASE: "" };
  servedModels = [];
  const view = await renderSettings(kbFixture({ embeddingModel: "", embeddingDim: null }));
  expect(view.errors).toEqual([]);

  const button = enableButton(view.container);
  expect(button.disabled).toBe(true);
  expect(view.text).toContain(zh("kb.settings.enableEmbeddingNoGlobal"));
  await view.unmount();
});

test("已有模型的库不出现「启用向量检索」入口（它们用表单改配置）", async () => {
  settingsMap = {
    EMBEDDING_MODEL: "bge-m3",
    EMBEDDING_BASE: "http://127.0.0.1:18912/v1",
    EMBEDDING_API_KEY: "sk-global",
  };
  const view = await renderSettings(kbFixture());
  expect(view.errors).toEqual([]);
  // 页面文案（嵌入说明）里本来就含「启用向量检索」字样，这里断言的是**按钮**不存在
  const button = [...view.container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(zh("kb.settings.enableEmbedding")),
  );
  expect(button).toBeUndefined();
  await view.unmount();
});
