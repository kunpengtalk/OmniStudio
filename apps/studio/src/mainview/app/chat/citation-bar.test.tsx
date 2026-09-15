import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * CitationBar（聊天引用胶囊）回归测试。
 *
 * 锁定三件事：
 *   1. 图片引用（chunkId 有值）→ 胶囊内缩略图，点击开 KbImageViewer Dialog（full 档请求）；
 *   2. 文本 / 音视频引用 → 无缩略图、零 kbChunkMedia 请求；
 *   3. 旧引用（modality=image 但缺 chunkId，历史消息）→ 零请求，模态图标照旧。
 */

// happy-dom 提供真实 DOM（Radix 的 Dialog / Portal 需要），afterAll 还原全局。
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

/** kbChunkMedia 收到的参数（缩略图无 size；查看器 size="full"）。 */
const chunkMediaCalls: Array<{ chunkId: number; size?: string }> = [];

mock.module("@lib/rpc", () => ({
  rpcClient: {
    kbChunkMedia: async (params: { chunkId: number; size?: string }) => {
      chunkMediaCalls.push(params);
      const url =
        params.size === "full"
          ? "data:image/jpeg;base64,full"
          : "data:image/jpeg;base64,thumb";
      return {
        dataUrl: url,
        modality: "image",
        fileName: "pic.jpg",
        mediaPath: "/tmp/kb-media/pic.jpg",
        text: "OCR 文本",
      };
    },
    openPath: async () => ({ ok: true }),
  },
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("@ui/tooltip");
const { translate } = await import("../../../shared/i18n");
const { CitationBar } = await import("./citation-bar");

const zh = (key: string) => translate("zh", key);

/** 引用夹具类型从组件 props 推导，避免额外 import。 */
type Citation = Parameters<typeof CitationBar>[0]["citations"][number];

/** 默认引用夹具（与 shared/knowledge.ts KbCitation 同形）。 */
function citationFixture(overrides: Partial<Citation> = {}): Citation {
  return {
    n: 1,
    kbId: 1,
    kbName: "Test KB",
    docId: 7,
    docName: "pic.jpg",
    seq: 2,
    chunkId: 11,
    modality: null,
    snippet: "片段预览",
    ...overrides,
  };
}

beforeEach(() => {
  chunkMediaCalls.length = 0;
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

/** 挂载一条引用胶囊列表（每个用例独立 QueryClient，缓存不跨用例泄漏）。 */
async function mountBar(citations: Citation[]) {
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
        createElement(TooltipProvider, null, createElement(CitationBar, { citations })),
      ),
    );
  });
  await flush();
  return {
    errors,
    container,
    text: document.body.textContent ?? "",
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

test("图片引用：胶囊内缩略图，点击开查看器 Dialog（full 档请求）", async () => {
  const view = await mountBar([citationFixture({ modality: "image", chunkId: 11 })]);
  expect(view.errors).toEqual([]);
  // 胶囊其余部分（编号 / docName / #seq）照常渲染
  expect(view.text).toContain("[1]");
  expect(view.text).toContain("pic.jpg");
  expect(view.text).toContain("#2");
  // 24px 缩略图已渲染（默认档 kbChunkMedia，无 size 参数）
  const img = view.container.querySelector('img[src^="data:image/"]');
  expect(img).not.toBeNull();
  expect(img!.getAttribute("src")).toBe("data:image/jpeg;base64,thumb");
  expect(chunkMediaCalls).toEqual([{ chunkId: 11 }]);

  // 点击缩略图 → KbImageViewer Dialog：标题「查看图片」+ full 档大图请求
  const thumb = img!.closest("button");
  expect(thumb).not.toBeNull();
  await act(async () => {
    thumb!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.body.textContent).toContain(zh("kb.viewer.title"));
  expect(chunkMediaCalls).toEqual([{ chunkId: 11 }, { chunkId: 11, size: "full" }]);
  // 查看器渲染 full 档大图
  expect(document.querySelector('img[src="data:image/jpeg;base64,full"]')).not.toBeNull();
  await view.unmount();
});

test("文本 / 音视频引用：无缩略图、零 kbChunkMedia 请求", async () => {
  const view = await mountBar([
    citationFixture({ n: 1, seq: 1, docName: "notes.md", modality: null, chunkId: undefined }),
    citationFixture({ n: 2, seq: 2, docName: "song.mp3", modality: "audio", chunkId: 21 }),
    citationFixture({ n: 3, seq: 3, docName: "clip.mp4", modality: "video", chunkId: 22 }),
  ]);
  expect(view.errors).toEqual([]);
  expect(view.container.querySelector("img")).toBeNull();
  expect(chunkMediaCalls).toEqual([]);
  await view.unmount();
});

test("旧引用（modality=image 缺 chunkId）：零请求，图标照旧", async () => {
  const view = await mountBar([citationFixture({ modality: "image", chunkId: undefined })]);
  expect(view.errors).toEqual([]);
  expect(chunkMediaCalls).toEqual([]);
  expect(view.container.querySelector("img")).toBeNull();
  // 胶囊照常渲染
  expect(view.text).toContain("[1]");
  expect(view.text).toContain("pic.jpg");
  expect(view.text).toContain("#2");
  await view.unmount();
});
