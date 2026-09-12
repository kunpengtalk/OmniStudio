import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

// Radix 的 Dialog 内容走 Portal，静态渲染拿不到 —— 这个文件用 happy-dom 提供真实 DOM。
// 仓库里没装 @happy-dom/global-registrator，这里手工把 DOM 全局挂上，afterAll 还原，
// 避免影响同进程的其它测试文件。
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
// React 19 的 act() 需要这个开关，否则会打 "not configured to support act" 警告。
(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// RPC 层依赖 Electrobun webview，测试里换成固定实现。
mock.module("@lib/rpc", () => ({
  rpcClient: {
    scanMediaSetupCandidates: async () => ({ candidates: [] }),
    resolveMediaSetup: async () => ({ ok: true }),
    getMlxGenStatus: async () => ({ supported: true, engineInstalled: true }),
    getDownloadedMlxModels: async () => ({ downloaded: [] }),
    downloadMlxGenEngine: async () => ({ ok: true }),
    downloadMlxModel: async () => ({ ok: true }),
  },
}));

const { act } = await import("react");
const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { MediaSetupDialog } = await import("./media-setup-dialog");
const { useMediaSetupStore } = await import("@stores/media-setup");
const { translate } = await import("../../shared/i18n");

const zh = (key: string, params?: Record<string, string>) => translate("zh", key, params);

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

async function renderDialog() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(QueryClientProvider, { client }, createElement(MediaSetupDialog)),
    );
  });
  const text = document.body.textContent ?? "";
  await act(async () => {
    root.unmount();
  });
  container.remove();
  useMediaSetupStore.getState().setRequest(null);
  return text;
}

test("choose-model 弹窗列出扫描到的模型，并给出确认 / 取消", async () => {
  useMediaSetupStore.getState().setRequest({
    id: "req-1",
    kind: "image",
    reason: "choose-model",
    message: "生图后端已就绪，扫描到 2 个可用模型，请确认用哪个生图。",
    backend: "api",
    config: { apiBase: "http://127.0.0.1:9/v1", apiKey: "", comfyBase: "", model: "" },
    candidates: [
      { id: "flux-dev", label: "flux-dev", ready: true },
      { id: "sdxl-turbo", label: "sdxl-turbo", note: "快速出图", ready: true },
    ],
    backends: [
      { id: "api", labelKey: "image.backend.cloud", ready: true, note: "http://127.0.0.1:9/v1" },
      { id: "mlx", labelKey: "image.backend.mlx", ready: false, note: "引擎未安装" },
      { id: "comfyui", labelKey: "image.backend.comfyui", ready: false },
    ],
  });

  const text = await renderDialog();
  expect(text).toContain(zh("media.setup.image.title.choose-model"));
  expect(text).toContain("flux-dev");
  expect(text).toContain("sdxl-turbo");
  expect(text).toContain(zh("media.setup.confirm"));
  expect(text).toContain(zh("common.cancel"));
  // 三个后端都能切，且没有把 i18n key 原样漏到界面上。
  expect(text).toContain(zh("image.backend.cloud"));
  expect(text).toContain(zh("image.backend.mlx"));
  expect(text).not.toContain("media.setup.");
});

test("missing-config 弹窗给出地址输入、API Key 与扫描按钮", async () => {
  useMediaSetupStore.getState().setRequest({
    id: "req-2",
    kind: "image",
    reason: "missing-config",
    message: "生图后端是「OpenAI 兼容 API」，但还没填写服务地址（Base URL）。",
    backend: "api",
    config: { apiBase: "", apiKey: "", comfyBase: "", model: "" },
    candidates: [],
    backends: [{ id: "api", labelKey: "image.backend.cloud", ready: false, note: "未填服务地址" }],
  });

  const text = await renderDialog();
  expect(text).toContain(zh("media.setup.image.title.missing-config"));
  expect(text).toContain(zh("image.config.base"));
  expect(text).toContain(zh("image.config.apiKey"));
  expect(text).toContain(zh("media.setup.scan"));
  expect(text).toContain(zh("media.setup.waiting"));
  expect(text).not.toContain("media.setup.");
});
