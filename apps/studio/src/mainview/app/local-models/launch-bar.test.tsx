import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 「本地模型」启动条的界面回归（issue #8）：
 * 引擎没装时报错下面必须给出**一键安装**，不能只留一句 `brew install llama.cpp`。
 * 这类机器通常已经有本地模型、不会再走引导页，界面上的安装入口只剩这一处。
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

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { engineInstallSupport } = await import("../../../shared/engines");
const { TooltipProvider } = await import("@ui/tooltip");

/** 点「启动服务器」时后端返回什么 —— 用例按需覆盖，覆盖后自己还原。 */
let startServer: () => Promise<unknown> = async () => {
  throw new Error("llama-server not found on PATH");
};
const engineMissingStart = startServer;

mock.module("@lib/rpc", () => ({
  rpcClient: {
    getSettings: async () => ({
      settings: { LOCAL_MODEL_PATH: "/models/Ornith-1.5-35B-Q4_K_M.gguf" },
    }),
    setActiveModel: async () => ({ ok: true }),
    startServedModel: () => startServer(),
    restartServedModel: () => startServer(),
    getSetupEnvironment: async () => ({
      platform: "darwin",
      arch: "arm64",
      // 安装能力用真实判定（平台相关），别手写一份会漂的
      installSupport: {
        "llama.cpp": engineInstallSupport("llama.cpp", "darwin", "arm64"),
        vllm: engineInstallSupport("vllm", "darwin", "arm64"),
        sglang: engineInstallSupport("sglang", "darwin", "arm64"),
        mlx: engineInstallSupport("mlx", "darwin", "arm64"),
      },
      installedVersions: { "llama.cpp": null, vllm: null, sglang: null, mlx: null },
      installing: null,
      llama: { found: false },
      vllm: { found: false },
      sglang: { found: false },
      mlx: { found: false },
    }),
    // 失败卡片上的「诊断信息」要读引擎版本与实例日志（issue #16）。
    listLocalEngines: async () => ({
      engines: [
        {
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
        },
      ],
      busy: null,
    }),
    getServedModelLogs: async () => ({
      logs: [
        "0.00.100.200 I srv  llama_server: loading model",
        "0.00.200.300 E srv  llama_model_load: error loading model: unknown model architecture: 'bert'",
        "0.00.202.000 E srv  llama_server: exiting due to model loading error",
      ].join("\n"),
    }),
  },
}));

const { LaunchBar } = await import("./launch-bar");
type InstalledModel = Parameters<typeof LaunchBar>[0]["installedModels"][number];

const MODEL: InstalledModel = {
  repo: "AtomicChat/Ornith-1.5-35B-A3B",
  fileName: "Ornith-1.5-35B-Q4_K_M.gguf",
  path: "/models/Ornith-1.5-35B-Q4_K_M.gguf",
  size: 2.3e10,
  isActive: true,
  isChatModel: true,
  category: "chat",
  favorite: false,
  origin: "external",
  isDir: false,
  kind: "gguf",
  runtimeTarget: "/models/Ornith-1.5-35B-Q4_K_M.gguf",
};

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

async function renderBar() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // 用全局 document（测试顶部已经把 happy-dom 的挂上去），其它界面用例同样写法。
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
          createElement(LaunchBar, { installedModels: [MODEL], engine: "llama.cpp" as const }),
        ),
      ),
    );
  });
  return container;
}

/** 让 react-query 的 promise 结算 + 补一次渲染。 */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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
  startServer = engineMissingStart;
});

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
});

test("引擎没装：报错下面给一键安装（而不是只让用户去 brew）", async () => {
  const view = await renderBar();
  await settle();

  const launch = buttonByText("启动服务器");
  expect(launch).toBeTruthy();
  await act(async () => {
    launch!.click();
  });
  await settle();

  // 报错本身照旧显示
  expect(view.textContent).toContain("推理引擎未安装");
  // 关键：界面里有能点的安装入口，而不是只有一行 brew 命令
  expect(view.textContent).toContain("一键安装");
  expect(view.textContent).toContain("brew install llama.cpp");
});

/** 按钮文字精确匹配（「控制台」与「打开控制台」互相包含，不能用 includes 找）。 */
function buttonByExactText(text: string): HTMLButtonElement | undefined {
  return Array.from(container!.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === text,
  ) as HTMLButtonElement | undefined;
}

test("启动失败：把引擎版本 / 模型字节数 / 日志首条 error 摆在报错下面（issue #16）", async () => {
  startServer = async () => {
    throw new Error("llama_server: exiting due to model loading error");
  };
  // 真实的失败路径：主进程把失败的实例留在列表里（status=error，日志尾巴还在），
  // 界面据此取到实例 id 才能读到那份日志。
  const { useServedStore } = await import("@stores/served");
  // 快照是 store 直写（真实运行时来自主进程推送）：包在 act 里，否则 React 报未包裹的更新。
  await act(async () => {
    useServedStore.getState().setSnapshot({
      models: [
        {
          id: "srv-1",
          modelRef: MODEL.runtimeTarget,
          label: "Ornith-1.5-35B",
          engine: "llama.cpp",
          port: 18080,
          endpoint: "http://127.0.0.1:18080/v1",
          servedName: "Ornith-1.5-35B",
          purpose: "chat",
          isDir: false,
          status: "error",
          error: "llama_server: exiting due to model loading error",
          usesDefaultPort: true,
          isActive: true,
        },
      ],
      activeId: "srv-1",
    });
  });
  try {
    const view = await renderBar();
    await settle();

    await act(async () => {
      buttonByText("启动服务器")!.click();
    });
    // 两次 settle：先让 mutation 落成报错，再让诊断块那两次查询（引擎行 / 实例日志）结算 ——
    // react-query 的 promise 链比一个 tick 长，少一次就会在断言之后更新状态（act 警告）。
    await settle();
    await settle();

    // 引擎构建版本：模型加载失败的头号嫌疑（旧构建认不出模型元数据）
    expect(view.textContent).toContain("b10976");
    // 模型文件的精确字节数：和官方对一下就知道下载有没有缺一段
    expect(view.textContent).toContain("Ornith-1.5-35B-Q4_K_M.gguf");
    expect(view.textContent).toContain("23,000,000,000");
    // 诊断块里给的是日志**第一条** error —— 末尾那句 `exiting due to model loading error`
    // 只是结论，报错本身已经写了，再重复一遍没有信息量。
    const diag = Array.from(view.querySelectorAll("div")).find((el) =>
      (el.textContent ?? "").startsWith("诊断信息"),
    );
    expect(diag).toBeTruthy();
    expect(diag!.textContent).toContain("unknown model architecture");
    expect(diag!.textContent).not.toContain("exiting due to model loading error");
    // 失败时实例可能还没建起来（status 仍是 stopped），控制台入口不能正好消失
    expect(buttonByExactText("控制台")).toBeTruthy();
    expect(buttonByText("打开控制台")).toBeTruthy();
  } finally {
    await act(async () => {
      useServedStore.getState().setSnapshot({ models: [], activeId: null });
    });
  }
});

test("别的启动失败（不是引擎缺失）不挂安装按钮", async () => {
  startServer = async () => {
    throw new Error("no model configured");
  };
  const view = await renderBar();
  await settle();

  const launch = buttonByText("启动服务器");
  expect(launch).toBeTruthy();
  await act(async () => {
    launch!.click();
  });
  await settle();

  expect(view.textContent).toContain("no model configured");
  expect(view.textContent).not.toContain("一键安装");
});
