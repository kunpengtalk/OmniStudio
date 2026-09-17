import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 启动失败卡片里的「诊断信息」（issue #16 承诺的那一件事）。
 *
 * 报告者卡在「嵌入模型加载失败」上，需要两样东西才能定位：应用装的是哪个 llama.cpp
 * 构建（引擎太旧会认不出模型元数据），以及日志里**第一条 error**（最后那句
 * `exiting due to model loading error` 只是结论）。这两样原先都散在设置页里 ——
 * 报告者的原话是「日志在哪我也不知道，界面有点复杂」，所以把它们直接摆在失败卡片上。
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

/** 引擎行与实例日志：用例按需覆盖（覆盖后 afterEach 还原）。 */
let engineRow: Record<string, unknown> | null = {
  id: "llama.cpp",
  state: "managed",
  version: "b10976",
  path: "/data/engines/llamacpp/llama-server",
  managedDir: "/data/engines/llamacpp",
  sizeBytes: 1,
  running: false,
  canInstall: true,
  installNote: null,
  approxBytes: null,
  requirement: null,
  canUninstall: true,
  upgradeKind: "latest",
};
let servedLogs = "";

const defaultEngineRow = engineRow;

mock.module("@lib/rpc", () => ({
  rpcClient: {
    listLocalEngines: async () => ({ engines: engineRow ? [engineRow] : [], busy: null }),
    getServedModelLogs: async () => ({ logs: servedLogs }),
  },
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("@ui/tooltip");
const { StartFailureDetails } = await import("./start-failure-details");
const { useRouter } = await import("@stores/router");

const MODEL = { fileName: "snowflake-arctic-embed-l-v2.0-q8_0.gguf", size: 634_554_752 };

const FAILED_LOAD_LOG = [
  "0.00.100.200 I srv  llama_server: loading model",
  "0.00.200.300 E srv  llama_model_load: error loading model: unknown model architecture: 'bert'",
  "0.00.202.000 E srv  llama_server: exiting due to model loading error",
].join("\n");

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

async function renderDetails(props?: { servedId?: string }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          TooltipProvider,
          null,
          createElement(StartFailureDetails, {
            engine: "llama.cpp" as const,
            model: MODEL,
            servedId: props?.servedId ?? "srv-1",
          }),
        ),
      ),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(container!.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes(text),
  ) as HTMLButtonElement | undefined;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container = null;
  engineRow = defaultEngineRow;
  servedLogs = "";
  useRouter.setState({ route: { path: "chat" } });
});

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

test("把「引擎 + 版本」摆出来 —— 引擎构建太旧是这份模型加载失败的头号嫌疑", async () => {
  const view = await renderDetails();
  expect(view.textContent).toContain("llama.cpp");
  expect(view.textContent).toContain("b10976");
});

test("模型文件的字节数精确给出：和官方 634,554,752 对一下就知道是不是下载缺了一段", async () => {
  servedLogs = FAILED_LOAD_LOG;
  const view = await renderDetails();
  expect(view.textContent).toContain(MODEL.fileName);
  expect(view.textContent).toContain("634,554,752");
});

test("直接给日志里第一条 error（不是最后那句结论），用户不用自己去翻控制台", async () => {
  servedLogs = FAILED_LOAD_LOG;
  const view = await renderDetails();
  expect(view.textContent).toContain("unknown model architecture");
  expect(view.textContent).not.toContain("exiting due to model loading error");
});

test("日志里还没有 error 行时明说，并给一个能点进控制台的入口", async () => {
  servedLogs = "";
  const view = await renderDetails();
  expect(view.textContent).toContain("还没有 error 行");

  const consoleButton = buttonByText("打开控制台");
  expect(consoleButton).toBeTruthy();
  await act(async () => {
    consoleButton!.click();
  });
  expect(useRouter.getState().route).toEqual({ path: "settings", tab: "logs" });
});

test("不是应用装的引擎（系统 brew 那份）不硬猜版本，明说版本未知", async () => {
  engineRow = {
    ...(defaultEngineRow as Record<string, unknown>),
    state: "system",
    version: null,
    managedDir: null,
  };
  const view = await renderDetails();
  expect(view.textContent).toContain("llama.cpp");
  expect(view.textContent).toContain("版本未知");
});
