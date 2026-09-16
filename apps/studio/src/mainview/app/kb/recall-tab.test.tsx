import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 「召回测试」页的回归测试（多模态直嵌 UI 部分）。
 *
 * 锁定一件事：命中块 modality 是未知串（恶意/损坏数据）时渲染不崩 ——
 * MediaBadge 回退通用图标+「媒体」标签，而不是 undefined 解构抛 TypeError 卸载整棵树。
 */

// happy-dom 提供真实 DOM，afterAll 还原全局。
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

/** kbRecall 返回的命中列表（当前用例）。 */
let hitsFixture: Array<Record<string, unknown>> = [];

mock.module("@lib/rpc", () => ({
  rpcClient: {
    kbRecall: async () => ({ hits: hitsFixture, notes: [] }),
  },
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { KbRecallTab } = await import("./recall-tab");
const { translate } = await import("../../../shared/i18n");

const zh = (key: string, params?: Record<string, string>) => translate("zh", key, params);

type KbFixture = Parameters<typeof KbRecallTab>[0]["kb"];

/** 知识库夹具（KbRecallTab 只用 kb.id）。 */
function kbFixture(overrides: Partial<KbFixture> = {}): KbFixture {
  return {
    id: 1,
    name: "Test",
    description: null,
    embeddingModel: "BAAI/bge-m3",
    embeddingBase: "",
    embeddingApiKey: "",
    embeddingProviderId: "",
    rerankProviderId: "",
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
    embedImage: false,
    embedAudio: false,
    embedVideo: false,
    docCount: 1,
    chunkCount: 2,
    embeddedCount: 2,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  hitsFixture = [];
});

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

/** 等内存异步链落定（桩全是内存 Promise，几轮宏任务足够）。 */
async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** 挂载召回测试页并跑一次查询（命中列表落进 hits state）。 */
async function mountRecall() {
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
      createElement(QueryClientProvider, { client }, createElement(KbRecallTab, { kb: kbFixture() })),
    );
  });
  await flush();
  return {
    errors,
    container,
    text: container.textContent ?? "",
    /** 填查询词并点「测试」，等结果渲染。 */
    runQuery: async (query: string) => {
      const input = container.querySelector("input");
      if (!input) throw new Error("找不到查询输入框");
      // React 会跟踪 input.value：必须先走原生 setter，否则 onChange 认为值没变。
      const setValue = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!;
      await act(async () => {
        setValue.call(input, query);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const run = [...container.querySelectorAll("button")].find((b) =>
        b.textContent?.includes(zh("kb.recall.run")),
      );
      if (!run) throw new Error("找不到「测试」按钮");
      await act(async () => {
        run.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flush();
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** 一条命中（modality 可注入任意串，测损坏数据兜底）。 */
function hitFixture(overrides: Record<string, unknown> = {}) {
  return {
    kbId: 1,
    kbName: "Test",
    docId: 7,
    docName: "song.mp3",
    chunkId: 11,
    seq: 1,
    content: "音频内容 OCR/转写文本",
    charCount: 12,
    score: 0.83,
    method: "keyword",
    keywordScore: 0.5,
    vectorScore: null,
    modality: null,
    ...overrides,
  };
}

test("命中块 modality 未知串 → 渲染不崩，回退「媒体」标签；正常命中不受影响", async () => {
  hitsFixture = [
    hitFixture(),
    hitFixture({
      docName: "room.holo",
      chunkId: 12,
      seq: 2,
      content: "", // 纯媒体块合法空正文（m3 守卫：不渲染空段落、不崩）
      modality: "hologram", // 损坏数据：不在 KbModality 三值内
    }),
  ];
  const view = await mountRecall();
  expect(view.errors).toEqual([]);
  await view.runQuery("音频");
  // 组件树没崩
  expect(view.errors).toEqual([]);
  // 未知模态命中走回退标签「媒体」；正常文本命中照常渲染（读实时 DOM，非挂载快照）
  const text = view.container.textContent ?? "";
  expect(text).toContain(zh("kb.docs.mediaChunk.unknown"));
  expect(text).toContain("room.holo");
  expect(text).toContain("song.mp3");
  await view.unmount();
});
