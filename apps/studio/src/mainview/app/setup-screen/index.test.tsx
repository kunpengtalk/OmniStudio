import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 引导页外壳的两条**阻塞性**回归：
 *   1. 「跳过 / 完成」必须无条件生效 —— 写 SETUP_COMPLETE 失败（或读设置那条路本身在
 *      报错）时也得放进主界面，并把失败记进统一日志；
 *   2. 这一页必须能滚动 —— `body` 是 overflow:hidden，用 min-h-screen + 自适应高度的话
 *      页面只会比窗口更高、被 body 裁掉，且没有任何滚动条，模型列表一长，下面的
 *      「下一步」「跳过」就永远够不着。
 *
 * getSetupEnvironment 是假的（界面这一层不该依赖跑测试的机器，真实探测见 bun/hardware.test.ts）。
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

const setupEnv = {
  platform: "darwin",
  arch: "arm64",
  appleSilicon: true,
  hasNvidiaGpu: false,
  hardware: undefined,
  installSupport: {},
  installedVersions: {},
  installing: null,
  llama: { found: true, path: "/opt/homebrew/bin/llama-server" },
  vllm: { found: false },
  sglang: { found: false },
  mlx: { found: false },
  omlx: { found: false },
};

/** 让 updateSettings 失败（模拟写库失败 / 主进程在报错）。 */
let updateSettingsFails = false;
const updateSettingsCalls: Record<string, string>[] = [];
const clientLogs: { event: string; message: string }[] = [];

mock.module("@lib/rpc", () => ({
  rpcClient: {
    getSetupEnvironment: async () => setupEnv,
    listInstalledModels: async () => ({ models: [] }),
    listDownloads: async () => ({ tasks: [] }),
    listModelFiles: async () => ({ files: [] }),
    startServer: async () => ({ ok: true }),
    updateSettings: async ({ settings }: { settings: Record<string, string> }) => {
      updateSettingsCalls.push(settings);
      if (updateSettingsFails) throw new Error("主进程不可用");
      return { ok: true };
    },
    writeAppLog: async (entry: { event: string; message: string }) => {
      clientLogs.push({ event: entry.event, message: entry.message });
      return { ok: true };
    },
  },
}));

const { SetupScreen } = await import("./index");

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

// 断言先失败时 cleanup 不会执行：不清一遍的话上一棵树的 DOM 会留在 body 里。
afterEach(() => {
  document.body.innerHTML = "";
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderScreen() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let completed = 0;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(SetupScreen, { onComplete: () => (completed += 1) }),
      ),
    );
  });
  await settle();
  return {
    completed: () => completed,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function clickSkip() {
  const button = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === "Skip — enter the app",
  );
  if (!button) throw new Error("找不到「跳过」按钮");
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test("跳过：写下 SETUP_COMPLETE 并进入应用", async () => {
  updateSettingsFails = false;
  updateSettingsCalls.length = 0;
  const view = await renderScreen();

  await clickSkip();
  await settle();

  expect(updateSettingsCalls).toEqual([{ SETUP_COMPLETE: "1" }]);
  expect(view.completed()).toBe(1);
  await view.cleanup();
});

test("跳过是无条件的：写设置失败也照样进应用，并把失败记进日志", async () => {
  updateSettingsFails = true;
  clientLogs.length = 0;
  const view = await renderScreen();

  await clickSkip();
  await settle();

  // 写失败不能把人按在引导页上（引导页必须能绕过去）
  expect(view.completed()).toBe(1);
  expect(clientLogs.map((l) => l.event)).toContain("setup.complete_failed");
  await view.cleanup();
  updateSettingsFails = false;
});

test("页面能滚动：滚动容器高度锁在视口上（不是 min-h-screen 的自适应高度）", async () => {
  const view = await renderScreen();

  const scroller = document.querySelector<HTMLElement>(".overflow-y-auto")!;
  expect(scroller).not.toBeNull();
  // body 是 overflow:hidden —— 没有受限高度的 overflow-y-auto 不会产生滚动条，
  // 超出视口的部分（下一步 / 跳过）就是不可达的。
  expect(scroller.className).toContain("h-full");
  expect(scroller.className).not.toContain("min-h-screen");
  await view.cleanup();
});
