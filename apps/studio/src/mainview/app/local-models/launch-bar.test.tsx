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

/** 选中模型时后端收到了哪个路径（下拉检索用例断言用）。 */
const activeCalls: string[] = [];

mock.module("@lib/rpc", () => ({
  rpcClient: {
    getSettings: async () => ({
      settings: { LOCAL_MODEL_PATH: "/models/Ornith-1.5-35B-Q4_K_M.gguf" },
    }),
    setActiveModel: async (args: { path: string }) => {
      activeCalls.push(args.path);
      return { ok: true };
    },
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
        omlx: engineInstallSupport("omlx", "darwin", "arm64"),
      },
      installedVersions: { "llama.cpp": null, vllm: null, sglang: null, mlx: null, omlx: null },
      installing: null,
      llama: { found: false },
      vllm: { found: false },
      sglang: { found: false },
      mlx: { found: false },
      omlx: { found: false },
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

async function renderBar(models: InstalledModel[] = [MODEL]) {
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
          createElement(LaunchBar, { installedModels: models, engine: "llama.cpp" as const }),
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

/** 下拉是 portal 到 document.body 的，不在 container 里。 */
function inPopover<T extends Element>(selector: string): T[] {
  return Array.from(document.querySelectorAll<T>(selector)).filter(
    (el) => !container!.contains(el),
  );
}

/** 受控 input：React 监听的是 input 事件，直接改 .value 不触发 onChange，得走原生 setter。 */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    (globalThis as unknown as { HTMLInputElement: typeof HTMLInputElement }).HTMLInputElement
      .prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container = null;
  startServer = engineMissingStart;
  activeCalls.length = 0;
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

/** 本机模型多了以后，下拉必须能搜：输入即筛，选中即设为当前模型。 */
const SECOND: InstalledModel = {
  ...MODEL,
  repo: "Qwen/Qwen3.8-27B-4bit-MTP-MLX",
  fileName: "Qwen3.8-27B-4bit-MTP-MLX.safetensors",
  path: "/models/Qwen3.8-27B-4bit-MTP-MLX.safetensors",
  runtimeTarget: "/models/Qwen3.8-27B-4bit-MTP-MLX.safetensors",
  kind: "safetensors",
  isActive: false,
  isChatModel: false,
};

test("模型下拉支持检索：输入即筛，点结果切换模型", async () => {
  await renderBar([MODEL, SECOND]);
  await settle();

  const trigger = buttonByText("Ornith-1.5-35B-Q4_K_M.gguf");
  expect(trigger).toBeTruthy();
  await act(async () => {
    trigger!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  // 搜索框在浮层顶部（打开即聚焦，直接打字就能筛），两个模型都在列表里
  const search = inPopover<HTMLInputElement>("input")[0];
  expect(search).toBeTruthy();
  expect(search!.placeholder).toContain("搜索模型名");
  expect(document.activeElement).toBe(search!);
  expect(inPopover('[role="option"]').length).toBe(2);

  // 输入即筛：只剩名字命中的那一个
  await act(async () => {
    typeInto(search!, "qwen3.8 4bit");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const options = inPopover<HTMLElement>('[role="option"]');
  expect(options.length).toBe(1);
  expect(options[0]!.textContent).toContain("Qwen3.8-27B-4bit-MTP-MLX");

  // 选中 → 设为当前模型（下拉关闭）
  await act(async () => {
    options[0]!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(activeCalls).toEqual(["/models/Qwen3.8-27B-4bit-MTP-MLX.safetensors"]);
  expect(inPopover('[role="option"]').length).toBe(0);
});

test("下拉打开时当前模型置顶且高亮在它身上：↓ 一次就是下一个", async () => {
  // 传入顺序故意把当前模型放在后面，验证"置顶 + 高亮"是真的成立而不是碰巧
  await renderBar([SECOND, MODEL]);
  await settle();
  const trigger = buttonByText("Ornith-1.5-35B-Q4_K_M.gguf");
  await act(async () => {
    trigger!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const options = inPopover<HTMLElement>('[role="option"]');
  expect(options[0]!.textContent).toContain("Ornith-1.5-35B-Q4_K_M.gguf");
  expect(options[0]!.getAttribute("aria-selected")).toBe("true");

  // 键盘：↓ 移到第二条（另一个模型），回车即选中
  const search = inPopover<HTMLInputElement>("input")[0]!;
  await act(async () => {
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(activeCalls).toEqual([SECOND.path]);
});

test("搜不到时给「没有匹配的模型」，不会误报成「还没有下载任何模型」", async () => {
  await renderBar([MODEL, SECOND]);
  await settle();
  const trigger = buttonByText("Ornith-1.5-35B-Q4_K_M.gguf");
  await act(async () => {
    trigger!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const search = inPopover<HTMLInputElement>("input")[0]!;
  await act(async () => {
    typeInto(search, "llama-3");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(inPopover('[role="option"]').length).toBe(0);
  expect(document.body.textContent).toContain("没有匹配的模型");
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
