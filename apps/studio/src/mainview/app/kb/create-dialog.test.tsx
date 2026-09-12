import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 「新建知识库」弹窗的回归测试。
 *
 * 曾经的线上白屏：弹窗里的两个下拉各有一个 `SelectItem value=""`（「不使用」），
 * 而 Radix 的 Select 在**关闭**状态下也会把 children 渲染进一个游离的
 * DocumentFragment（为了收集候选项文本），于是 `SelectItem` 一渲染就抛
 * "must have a value prop that is not an empty string"。这个弹窗在侧栏那份实例
 * 位于路由级 ErrorBoundary 之外，抛错直接把整棵树卸载 → 整个窗口白屏。
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

// RPC 层依赖 Electrobun webview，测试里换成固定实现。
const calls = { embedding: 0, rerank: 0 };
mock.module("@lib/rpc", () => ({
  rpcClient: {
    kbEmbeddingModels: async () => {
      calls.embedding += 1;
      return { models: ["bge-m3"] };
    },
    kbRerankModels: async () => {
      calls.rerank += 1;
      return { models: ["bge-reranker-v2-m3"] };
    },
    kbCreate: async () => ({ kb: { id: 1 } }),
  },
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { KbCreateDialog } = await import("./index");
const { useKbStore } = await import("@stores/kb");
const { translate } = await import("../../../shared/i18n");

const zh = (key: string, params?: Record<string, string>) => translate("zh", key, params);

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

/** 打开弹窗并渲染；返回渲染期间的未捕获错误与页面文本。 */
async function renderCreateDialog(): Promise<{ errors: unknown[]; text: string }> {
  const errors: unknown[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container, {
    onUncaughtError: (error) => errors.push(error),
    onRecoverableError: (error) => errors.push(error),
  });
  useKbStore.getState().setCreateOpen(true);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(KbCreateDialog)));
  });
  const text = document.body.textContent ?? "";
  await act(async () => {
    root.unmount();
  });
  container.remove();
  useKbStore.getState().setCreateOpen(false);
  return { errors, text };
}

test("新建知识库弹窗打开时不会崩（空选值不能用空字符串）", async () => {
  const { errors, text } = await renderCreateDialog();
  const radixError = errors.find((e) =>
    String(e instanceof Error ? e.message : e).includes("empty string"),
  );
  expect(radixError).toBeUndefined();
  expect(errors).toEqual([]);
  // 弹窗内容真的渲染出来了，且默认「不使用」占位在
  expect(text).toContain(zh("kb.create.title"));
  expect(text).toContain(zh("kb.create.embedding"));
  expect(text).toContain(zh("kb.create.notUse"));
  expect(text).not.toContain("kb.create.");
});

test("打开弹窗就拉嵌入 / 重排模型候选（候选项渲染进 Radix 游离 fragment，不进 DOM）", async () => {
  calls.embedding = 0;
  calls.rerank = 0;
  const { errors, text } = await renderCreateDialog();
  expect(errors).toEqual([]);
  expect(calls.embedding).toBeGreaterThan(0);
  expect(calls.rerank).toBeGreaterThan(0);
  // 当前值是空串 → 触发器显示哨兵对应的「不使用」，而不是把哨兵漏出来
  expect(text).toContain(zh("kb.create.notUse"));
  expect(text).not.toContain("__none__");
});
