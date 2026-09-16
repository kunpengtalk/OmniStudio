import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 「数据源」页的回归测试（多模态直嵌 UI 部分）。
 *
 * 锁定三件事：
 *   1. 「添加文件」文件选择器的 accept 列表含音视频扩展名 —— 与 bun 侧目录导入
 *      白名单（KB_FOLDER_FILE_RE）同一来源 shared/knowledge.ts，改名单必须两边一起改，
 *      这里钉住 UI 侧不回退；
 *   2. 分块弹窗里的媒体直嵌块：图片懒加载缩略图（kbChunkMedia）、音视频图标+文件名
 *      （零请求）；纯媒体块正文为空不渲染空段落；
 *   3. 媒体块点击：图片块打开查看器（KbImageViewer），音视频仍用 openPath 打开原文件；
 *      文档行内缩略图（firstImageChunkId 非空）点击也打开查看器。
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

/** openFileDialog 收到的 allowedFileTypes（accept 断言用）。 */
const openFileDialogCalls: Array<{ allowedFileTypes?: string }> = [];
/** kbChunkMedia 收到的 chunkId（音视频块不应发起请求）。 */
const chunkMediaCalls: number[] = [];
/** openPath 收到的 path（点击媒体块打开原文件）。 */
const openPathCalls: string[] = [];
/** 当前用例的分块列表（kbChunks 返回它）。 */
let chunksFixture: Array<Record<string, unknown>> = [];
/** 当前用例的文档列表（null = 默认单文档 docFixture()）。 */
let docsFixture: Array<Record<string, unknown>> | null = null;
/** 当前用例的缩略图桩：null = 直接成功返回；可设为永不落定的挂起（loading 态用例）。 */
let chunkMediaStub: (() => unknown) | null = null;

mock.module("@lib/rpc", () => ({
  rpcClient: {
    kbDocList: async () => ({ docs: docsFixture ?? [docFixture()] }),
    openFileDialog: async (params: { allowedFileTypes?: string }) => {
      openFileDialogCalls.push(params);
      return { paths: [] as string[] };
    },
    kbAddFiles: async () => ({ docs: [] }),
    kbAddFolder: async () => ({ docs: [] }),
    kbAddNote: async () => ({ doc: {} }),
    kbAddWeb: async () => ({ doc: {} }),
    kbDocReingest: async () => ({ ok: true }),
    kbDocRetry: async () => ({ ok: true }),
    kbDocDelete: async () => ({ ok: true }),
    kbEmbedMissing: async () => ({ ok: true, embedded: 3 }),
    kbChunks: async () => ({ chunks: chunksFixture }),
    kbChunkMedia: async (params: { chunkId: number; size?: "thumb" | "full" }) => {
      chunkMediaCalls.push(params.chunkId);
      if (chunkMediaStub) return await chunkMediaStub();
      // KbChunkMediaView 全字段：mediaPath/text 供查看器「用系统程序打开」与 OCR 展示。
      return {
        dataUrl: "data:image/jpeg;base64,thumb",
        modality: "image",
        fileName: "pic.jpg",
        mediaPath: "/tmp/kb-media/pic.jpg",
        text: "OCR 文本",
      };
    },
    openPath: async (params: { path: string }) => {
      openPathCalls.push(params.path);
      return { ok: true };
    },
  },
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { KbDocsTab } = await import("./docs-tab");
const { TooltipProvider } = await import("@ui/tooltip");
const { translate } = await import("../../../shared/i18n");
const { useServedStore } = await import("@stores/served");

const zh = (key: string, params?: Record<string, string>) => translate("zh", key, params);

type KbFixture = Parameters<typeof KbDocsTab>[0]["kb"];

/** 默认知识库夹具（与 settings-tab.test 同形；KbDocsTab 只用 id / embeddingModel）。 */
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
    chunkCount: 3,
    embeddedCount: 3,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

/** 默认数据源：一个已就绪的文件文档（overrides 可改 firstImageChunkId 等字段）。 */
function docFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    kbId: 1,
    name: "song.mp3",
    kind: "file",
    sourcePath: "/tmp/kb-media/song.mp3",
    url: null,
    sizeBytes: 1234,
    charCount: null,
    chunkCount: 3,
    embeddedCount: 3,
    status: "ready",
    error: null,
    contentHash: "h",
    indexedAt: null,
    createdAt: null,
    updatedAt: null,
    job: null,
    firstImageChunkId: null,
    ...overrides,
  };
}

beforeEach(() => {
  openFileDialogCalls.length = 0;
  chunkMediaCalls.length = 0;
  openPathCalls.length = 0;
  chunksFixture = [];
  docsFixture = null;
  chunkMediaStub = null;
  // store 是模块级单例：清掉上一个用例的快照。
  useServedStore.setState({ models: [], activeId: null, logs: {} });
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

/** 挂载一页数据源列表（文档行含悬浮操作按钮组）。 */
async function mountDocs() {
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
        createElement(TooltipProvider, null, createElement(KbDocsTab, { kb: kbFixture() })),
      ),
    );
  });
  await flush();
  return {
    errors,
    container,
    text: document.body.textContent ?? "",
    /** 打开指定文档的分块弹窗（每行第一个悬浮按钮 = 查看分块）。 */
    openChunks: async () => {
      const btn = container.querySelector("span.opacity-0 button");
      if (!btn) throw new Error("找不到「查看分块」按钮");
      await act(async () => {
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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

test("添加文件的 accept 列表含音视频扩展名（与 bun 目录导入白名单同源）", async () => {
  const view = await mountDocs();
  expect(view.errors).toEqual([]);
  const addFile = [...view.container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(zh("kb.docs.addFile")),
  );
  expect(addFile).toBeDefined();
  await act(async () => {
    addFile!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
  expect(openFileDialogCalls.length).toBe(1);
  const exts = (openFileDialogCalls[0]!.allowedFileTypes ?? "").split(",");
  for (const ext of ["mp3", "wav", "m4a", "mp4", "mov", "mkv", "webm"]) {
    expect(exts).toContain(ext);
  }
  // 既有名单没缩水
  for (const ext of ["txt", "md", "pdf", "png", "jpg"]) {
    expect(exts).toContain(ext);
  }
  await view.unmount();
});

test("分块弹窗：音视频图标+文件名零请求，图片拉缩略图，点击 openPath 打开原文件", async () => {
  chunksFixture = [
    {
      id: 11,
      seq: 1,
      charCount: 0,
      embedded: true,
      content: "",
      headingPath: null,
      charStart: null,
      charEnd: null,
      modality: "audio",
      mediaPath: "/tmp/kb-media/song.mp3",
      mediaIndex: 0,
    },
    {
      id: 12,
      seq: 2,
      charCount: 6,
      embedded: true,
      content: "OCR 文本",
      headingPath: null,
      charStart: null,
      charEnd: null,
      modality: "image",
      mediaPath: "/tmp/kb-media/pic.jpg",
      mediaIndex: 0,
    },
    {
      id: 13,
      seq: 3,
      charCount: 5,
      embedded: false,
      content: "纯文本块",
      headingPath: "H1",
      charStart: 0,
      charEnd: 5,
      modality: null,
      mediaPath: null,
      mediaIndex: null,
    },
  ];
  const view = await mountDocs();
  expect(view.errors).toEqual([]);
  await view.openChunks();

  // 音频块：类型标签 + 文件名（docName 兜底），且没为它发 kbChunkMedia
  expect(document.body.textContent).toContain(zh("kb.docs.mediaChunk.audio"));
  expect(document.body.textContent).toContain("song.mp3");
  // 图片块：缩略图 img 已渲染（fileName 来自 kbChunkMedia）
  const img = document.querySelector('img[src^="data:image/"]');
  expect(img).not.toBeNull();
  expect(img!.getAttribute("src")).toBe("data:image/jpeg;base64,thumb");
  expect(document.body.textContent).toContain("pic.jpg");
  // 文本块不受影响
  expect(document.body.textContent).toContain("纯文本块");
  // 音视频块（id 11）不发媒体请求；只有图片块（id 12）发一次
  expect(chunkMediaCalls).toEqual([12]);

  // 音频块点击 → 仍用 openPath 打开原文件（行为不变）
  const mediaButtons = [...document.querySelectorAll("button")].filter(
    (b) => b.getAttribute("title") === zh("kb.docs.mediaChunk.openOriginal"),
  );
  expect(mediaButtons.length).toBe(1);
  await act(async () => {
    mediaButtons[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(openPathCalls).toEqual(["/tmp/kb-media/song.mp3"]);

  // 图片块点击 → 打开查看器 Dialog（不再直接 openPath）
  const imageButton = document.querySelector(`button[aria-label="${zh("kb.viewer.title")}"]`);
  expect(imageButton).not.toBeNull();
  await act(async () => {
    imageButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
  // 查看器打开：标题与「用系统程序打开」入口出现（系统打开由弹窗内按钮承担）
  expect(document.body.textContent).toContain(zh("kb.viewer.title"));
  const openExternal = [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(zh("kb.viewer.openExternal")),
  );
  expect(openExternal).toBeDefined();
  await act(async () => {
    openExternal!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
  // 查看器内「用系统程序打开」→ openPath 原文件
  expect(openPathCalls).toEqual(["/tmp/kb-media/song.mp3", "/tmp/kb-media/pic.jpg"]);
  await view.unmount();
});

test("纯媒体块正文为空时不渲染空段落（合法空文本契约在 UI 可见）", async () => {
  chunksFixture = [
    {
      id: 21,
      seq: 1,
      charCount: 0,
      embedded: true,
      content: "",
      headingPath: null,
      charStart: null,
      charEnd: null,
      modality: "video",
      mediaPath: "/tmp/kb-media/clip.mp4",
      mediaIndex: 0,
    },
  ];
  const view = await mountDocs();
  expect(view.errors).toEqual([]);
  await view.openChunks();
  expect(document.body.textContent).toContain(zh("kb.docs.mediaChunk.video"));
  // 正文为空 → 内容段落不渲染（只剩媒体块按钮与头部行）
  expect(chunkMediaCalls).toEqual([]);
  await view.unmount();
});

test("未知 modality（恶意/损坏数据）渲染不崩：回退通用图标+「媒体」标签", async () => {
  chunksFixture = [
    {
      id: 31,
      seq: 1,
      charCount: 0,
      embedded: true,
      content: "",
      headingPath: null,
      charStart: null,
      charEnd: null,
      modality: "hologram", // 不在 KbModality 三值内（损坏数据），组件必须兜底
      mediaPath: "/tmp/kb-media/room.holo",
      mediaIndex: 0,
    },
  ];
  const view = await mountDocs();
  expect(view.errors).toEqual([]);
  await view.openChunks();
  // 回退项生效：通用标签渲染，组件树没崩
  expect(view.errors).toEqual([]);
  expect(document.body.textContent).toContain(zh("kb.docs.mediaChunk.unknown"));
  // 未知模态 ≠ image → 不发缩略图请求（与音视频同路径）；文件名走 docName 兜底
  const mediaButtons = [...document.querySelectorAll("button")].filter(
    (b) => b.getAttribute("title") === zh("kb.docs.mediaChunk.openOriginal"),
  );
  expect(mediaButtons.length).toBe(1);
  expect(mediaButtons[0]!.textContent).toContain(zh("kb.docs.mediaChunk.unknown"));
  expect(mediaButtons[0]!.textContent).toContain("song.mp3");
  expect(chunkMediaCalls).toEqual([]);
  await view.unmount();
});

test("文档行缩略图：firstImageChunkId 非空渲染缩略图，点击打开查看器", async () => {
  docsFixture = [docFixture({ firstImageChunkId: 12 })];
  const view = await mountDocs();
  expect(view.errors).toEqual([]);
  // thumb 档请求只发一次（与分块弹窗 MediaChunkBlock 同 queryKey 共享缓存）
  expect(chunkMediaCalls).toEqual([12]);
  const thumb = view.container.querySelector(`button[aria-label="${zh("kb.viewer.title")}"]`);
  expect(thumb).not.toBeNull();
  expect(thumb!.querySelector("img")).not.toBeNull();
  // 点击缩略图 → 查看器打开（容器层单实例，portaled 到 body）
  await act(async () => {
    thumb!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
  expect(document.body.textContent).toContain(zh("kb.viewer.title"));
  expect(document.body.textContent).toContain(zh("kb.viewer.openExternal"));
  await view.unmount();
});

test("非图片文档行无缩略图请求与缩略图按钮（enabled 门控 + 行为不变）", async () => {
  docsFixture = [
    docFixture(),
    docFixture({ id: 8, name: "notes.txt", firstImageChunkId: 12 }),
  ];
  const view = await mountDocs();
  expect(view.errors).toEqual([]);
  // 只有 firstImageChunkId 非空的 doc 8 发一次请求；无图片块的 doc 7 零请求
  expect(chunkMediaCalls).toEqual([12]);
  // 缩略图按钮只有 doc 8 有；doc 7 保留类型图标位
  const thumbs = view.container.querySelectorAll(`button[aria-label="${zh("kb.viewer.title")}"]`);
  expect(thumbs.length).toBe(1);
  const iconSpans = view.container.querySelectorAll("span.size-9");
  expect(iconSpans.length).toBe(1);
  await view.unmount();
});

test("缩略图 loading 态不闪「加载失败」（pending ≠ failed）", async () => {
  chunksFixture = [
    {
      id: 41,
      seq: 1,
      charCount: 0,
      embedded: true,
      content: "",
      headingPath: null,
      charStart: null,
      charEnd: null,
      modality: "image",
      mediaPath: "/tmp/kb-media/pic.jpg",
      mediaIndex: 0,
    },
  ];
  // 缩略图请求挂起（永不落定）：组件停在 pending，spinner 占位。
  chunkMediaStub = () => new Promise(() => {});
  const view = await mountDocs();
  expect(view.errors).toEqual([]);
  await view.openChunks();
  // 首载 pending 期间绝不能出现错误文案（M2 回归钉）
  expect(document.body.textContent).not.toContain(zh("kb.docs.mediaChunk.loadFailed"));
  expect(view.errors).toEqual([]);
  await view.unmount();
});
