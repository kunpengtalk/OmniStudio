import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 基准测试页的模型名：**界面里不出现路径**。
 *
 * MLX 的请求 id 是绝对路径（mlx_lm.server 只认它），设置里的 `CHAT_MODEL` /
 * `LOCAL_MODEL_PATH` 因此常常存着一串 `/Users/…`；历史记录也可能存着老数据。
 * 选择器默认值、结果表头、侧栏记录都必须显示模型名（= 模型库里的下载名 /
 * 网关的服务名），路径只留给后端换算请求 id。
 *
 * happy-dom 提供真实 DOM（Radix 的 Select 需要），afterAll 还原全局。
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

const MODEL_PATH = "/Users/me/lmstudio/models/abenzerps/Apodex-1.1-mini-MLX-4bit";
const MODEL_NAME = "Apodex-1.1-mini-MLX-4bit";

const CLOUD_PROVIDER = {
  id: "p1",
  name: "测试厂商",
  vendor: "测试",
  baseUrl: "https://api.example/v1",
  apiKey: "sk-1",
  models: [
    { id: "qwen3-8b", type: "chat" },
    { id: "flux-dev", type: "image" },
  ],
  enabled: true,
  videoApi: "",
  createdAt: 0,
  updatedAt: 0,
};

mock.module("@lib/rpc", () => ({
  rpcClient: {
    getSettings: async () => ({
      settings: {
        SERVER_MODE: "local",
        // MLX 的请求 id 与激活路径都是绝对路径 —— 界面必须自己收敛成模型名。
        CHAT_MODEL: MODEL_PATH,
        LOCAL_MODEL_PATH: MODEL_PATH,
        LOCAL_MODEL_NAME: MODEL_NAME,
      },
    }),
    listInstalledModels: async () => ({
      models: [
        {
          repo: "abenzerps/Apodex-1.1-mini-MLX-4bit",
          fileName: MODEL_NAME,
          path: MODEL_PATH,
          runtimeTarget: MODEL_PATH,
          size: 1,
          isActive: true,
          isChatModel: true,
          category: "chat",
          favorite: false,
          origin: "external",
          isDir: true,
          kind: "safetensors",
        },
      ],
    }),
    cloudProviderList: async () => ({ providers: [CLOUD_PROVIDER], activeId: null }),
    listBenchmarkRecords: async () => ({
      records: [
        {
          id: 7,
          kind: "speed",
          model: MODEL_PATH,
          serverMode: "local",
          engine: "mlx",
          params: null,
          rows: [],
          summary: null,
          status: "done",
          durationMs: 1000,
          error: null,
          createdAt: Date.now(),
        },
      ],
    }),
    getEvalSuites: async () => ({ suites: [] }),
  },
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { BenchmarkScreen } = await import("./benchmark-screen");

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

async function renderScreen() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(QueryClientProvider, { client }, createElement(BenchmarkScreen)),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    container,
    text: () => container.textContent ?? "",
    modelTrigger: () => container.querySelector("#benchModel"),
    /** 展开某个下拉（Radix 的触发键：ArrowDown / Enter / Space 都会打开）。 */
    openSelect: async (id: string) => {
      const trigger = container.querySelector(id);
      if (!trigger) throw new Error(`找不到下拉 ${id}`);
      await act(async () => {
        trigger.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
        );
      });
      await act(async () => {
        await Promise.resolve();
      });
    },
    options: () => [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent ?? ""),
    cloudTrigger: () => container.querySelector("#benchCloudModel"),
    /** 切到「云端 API」：模型那一段应当变成「先选厂商、再选模型」。 */
    switchToCloud: async () => {
      const tab = [...container.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "云端 API",
      );
      if (!tab) throw new Error("找不到「云端 API」切换按钮");
      await act(async () => {
        tab.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      await act(async () => {
        await Promise.resolve();
      });
    },
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

test("评测页的模型名不出现路径：选择器默认值 / 表头 / 历史记录都用模型名", async () => {
  const screen = await renderScreen();
  try {
    // 模型是下拉选择：默认值是模型名（模型库里的下载名），不是 CHAT_MODEL 里那串路径。
    expect(screen.modelTrigger()?.textContent).toContain(MODEL_NAME);
    // 结果表头（老记录里的路径型 model）同样收敛成模型名。
    expect(screen.text()).toContain(MODEL_NAME);
    expect(screen.text()).not.toContain("/Users/");
  } finally {
    await screen.cleanup();
  }
});

test("本地模型是下拉：展开后列出的都是模型名，没有路径", async () => {
  const screen = await renderScreen();
  try {
    await screen.openSelect("#benchModel");
    const options = screen.options();
    expect(options.length).toBeGreaterThan(0);
    expect(options.some((o) => o.includes(MODEL_NAME))).toBe(true);
    expect(options.some((o) => o.includes("/Users/"))).toBe(false);
  } finally {
    await screen.cleanup();
  }
});

test("切到云端 API：模型那一段跟着换成该厂商的模型下拉", async () => {
  const screen = await renderScreen();
  try {
    await screen.switchToCloud();
    // 厂商下拉（服务商）+ 模型下拉：模型只列这个厂商的**对话**模型（生图模型不进来）。
    expect(screen.cloudTrigger()?.textContent).toContain("qwen3-8b");
    expect(screen.text()).toContain("测试厂商");
    await screen.openSelect("#benchCloudModel");
    expect(screen.options().join(" ")).toContain("qwen3-8b");
    expect(screen.options().join(" ")).not.toContain("flux-dev");
    // 本地那一段的下拉消失，不会两套选择器同时摆着。
    expect(screen.modelTrigger()).toBeNull();
  } finally {
    await screen.cleanup();
  }
});
