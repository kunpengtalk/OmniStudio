import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 回归：画布节点里选模型必须真的写进 store，且下拉里的按下不能被当成"按在节点上"。
 *
 * 真实故障（2026-09）：Radix 下拉的选项渲染到 body，但 React 事件沿组件树冒泡到
 * 节点框的 startDrag；选项是 div[role=option]，躲不过 button/input 的忽略判断，
 * 于是节点开始拖拽并 setPointerCapture 抢走指针 —— 浏览器里 Radix 只认 item 自己的
 * pointerup（pointerType=mouse）提交选择，指针被抢走之后这一下永远收不到，表现就是
 * "点了没反应、列表也不关"，数据库里 nodes JSON 的 model 一直是 null。
 *
 * happy-dom 不会真的重定向被捕获的指针，所以这里锁两件事：
 *   1. 选择链路本身通（onValueChange → choiceKey 回显 → store 落值）；
 *   2. 下拉交互不算"按节点"（selection 不被改成该节点）—— 守卫失效时这条会红。
 */
const dom = new Window({ url: "http://localhost/" });
const DOM_GLOBALS = [
  "window", "document", "navigator", "location", "history", "localStorage",
  "HTMLElement", "HTMLDivElement", "HTMLButtonElement", "HTMLInputElement",
  "Element", "Node", "Text", "DocumentFragment", "SVGElement", "DOMRect",
  "CustomElementRegistry", "Event", "CustomEvent", "MouseEvent", "PointerEvent",
  "KeyboardEvent", "FocusEvent", "InputEvent", "MutationObserver", "ResizeObserver",
  "NodeFilter", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle", "matchMedia",
] as const;
const savedGlobals = new Map<string, unknown>();
for (const key of DOM_GLOBALS) {
  const value = (dom as unknown as Record<string, unknown>)[key];
  if (value === undefined) continue;
  savedGlobals.set(key, (globalThis as unknown as Record<string, unknown>)[key]);
  (globalThis as unknown as Record<string, unknown>)[key] = value;
}
(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** 引擎扫到的本地 MLX 生图权重（画布图片节点的"本地"候选）。 */
mock.module("@lib/rpc", () => ({
  rpcClient: {
    cloudProviderList: async () => ({ providers: [], activeId: null }),
    listImageGenModels: async (p?: { backend?: string }) =>
      p?.backend === "comfyui" ? { models: [] } : { models: ["qwen-image-2.1"] },
    getImageGenConfig: async () => ({ config: { backend: "mlx", providerId: "", apiBase: "", apiKey: "", model: "", comfyBase: "" } }),
    listChatModels: async () => ({ models: [] }),
    getVideoGenConfig: async () => ({ config: { comfyBase: "" } }),
    listTTSHttpVoices: async () => ({ voices: [] }),
    canvasRunText: async () => ({ ok: true }),
    canvasStopText: async () => ({ ok: true }),
  },
  isRemoteClient: () => false,
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { CanvasNodeView } = await import("./node");
const { useCanvasStore } = await import("./canvas-store");
const { choiceKey } = await import("./model-select");

const NODE_ID = "n-test";

beforeAll(() => {
  useCanvasStore.getState().setDoc({
    id: 1,
    title: "测试画布",
    payload: {
      nodes: [
        {
          id: NODE_ID,
          kind: "image",
          title: "图片节点 1",
          x: 0,
          y: 0,
          width: 360,
          height: 400,
          prompt: "",
          status: "idle",
        },
      ],
      connections: [],
      viewport: { x: 0, y: 0, k: 1 },
    },
  });
});

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

/** 一拍给查询解析 / 渲染落地。 */
const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

test("图片节点：下拉里选本地 MLX 模型 → store 落值，且这次按下不算按节点", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  const node = useCanvasStore.getState().nodes[0]!;

  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(CanvasNodeView, { node, scale: 1, onPortPointerDown: () => {} }),
      ),
    );
  });
  await settle();

  // 选择前：没有选中态（下拉交互不该把它改掉）。
  useCanvasStore.getState().select([]);

  const trigger = container.querySelector('[data-slot="select-trigger"]');
  expect(trigger).not.toBeNull();
  await act(async () => {
    (trigger as unknown as HTMLElement).click();
  });
  await settle();

  const option = [...document.querySelectorAll('[role="option"]')].find(
    (el) => (el.textContent ?? "").trim() === "qwen-image-2.1",
  ) as unknown as HTMLElement | undefined;
  expect(option).toBeDefined();

  await act(async () => {
    // 模拟真实点击：先 pointerdown（React 树冒泡会到节点框），再 click。
    option!.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true, button: 0 }) as unknown as Event);
    option!.click();
  });
  await settle();

  const after = useCanvasStore.getState();
  // 1) 模型真的写进了 store（回显键与选项键一致，见 choiceKey）。
  // 本地 MLX 候选带着 backend 标记 —— 执行链路就是按它分派到 MLX 后端的。
  expect(after.nodes[0]!.model).toEqual({ source: "local", backend: "mlx", model: "qwen-image-2.1" });
  expect(choiceKey(after.nodes[0]!.model)).toBe("local::qwen-image-2.1");
  // 2) 触发器不再是"占位"态（Radix 选中后会摘掉 data-placeholder：
  //    happy-dom 里 ItemText 的 portal 回显拿不到文本，占位态是否还在才是可靠信号）。
  expect(trigger!.getAttribute("data-placeholder")).toBeNull();
  // 3) 下拉里的按下没有被当成"按在节点上"（守卫失效时 startDrag 会把该节点选上）。
  expect(after.selection).toEqual([]);

  await act(async () => {
    root.unmount();
  });
  container.remove();
});
