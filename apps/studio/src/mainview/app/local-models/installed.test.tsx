import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 「已安装模型」删除按钮的界面回归（issue #18）：
 *
 * 以前点一下垃圾桶图标就直接删文件 —— 而列表里既有应用自己下载的模型，也有从用户
 * **自己添加的目录**里扫出来的模型（报告者正是把 LM Studio 的目录加进来之后发现权重
 * 文件不见了）。所以这里钉三件事：一次点击不许直接删、对话框要写清删的是哪个文件、
 * 「你自己目录里的文件」必须明确警告不可恢复。
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
const { TooltipProvider } = await import("@ui/tooltip");

/** 删除调用记录：断言「一次点击不许直接删」靠它。 */
const deleted: string[] = [];

const EXTERNAL_MODEL = {
  repo: "Casual-Autopsy/snowflake-arctic-embed-l-v2.0-gguf",
  fileName: "snowflake-arctic-embed-l-v2.0-q8_0.gguf",
  path: "E:\\GGUF\\Casual-Autopsy\\snowflake-arctic-embed-l-v2.0-gguf\\snowflake-arctic-embed-l-v2.0-q8_0.gguf",
  size: 634554752,
  isActive: false,
  isChatModel: false,
  category: "embedding" as const,
  favorite: false,
  origin: "external" as const,
  isDir: false,
  kind: "gguf" as const,
  runtimeTarget: "E:\\GGUF\\Casual-Autopsy\\snowflake-arctic-embed-l-v2.0-gguf\\snowflake-arctic-embed-l-v2.0-q8_0.gguf",
};

mock.module("@lib/rpc", () => ({
  rpcClient: {
    listInstalledModels: async () => ({ models: [EXTERNAL_MODEL] }),
    deleteLocalModel: async ({ path }: { path: string }) => {
      deleted.push(path);
      return { ok: true, freed: 1 };
    },
    getSettings: async () => ({ settings: {} }),
    showInExplorer: async () => ({ ok: true }),
  },
}));

const { InstalledModels } = await import("./installed");

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

async function renderInstalled() {
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
          createElement(InstalledModels, { engine: "llama.cpp" as const, allEngines: true }),
        ),
      ),
    );
  });
  await settle();
  return container;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// 对话框内容渲染在 Radix 的 portal 里（挂在 document.body 上，不在 container 内），
// 所以查找与文案断言都对着 body 做。
const rowDeleteButton = () =>
  document.body.querySelector('button[aria-label="删除"]') as HTMLButtonElement | null;
const dialogDeleteButton = () =>
  Array.from(document.body.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === "删除") as
    | HTMLButtonElement
    | undefined;
const cancelButton = () =>
  Array.from(document.body.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes("取消")) as
    | HTMLButtonElement
    | undefined;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container = null;
  deleted.length = 0;
});

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
});

test("点垃圾桶不会立刻删文件：先弹出对话框，写清文件、路径，并警告这是用户自己目录里的文件", async () => {
  await renderInstalled();
  const trash = rowDeleteButton();
  expect(trash).toBeTruthy();

  await act(async () => {
    trash!.click();
  });
  await settle();

  expect(deleted).toEqual([]); // 还没删
  expect(document.body.textContent).toContain("删除这个模型文件？");
  expect(document.body.textContent).toContain(EXTERNAL_MODEL.fileName);
  expect(document.body.textContent).toContain(EXTERNAL_MODEL.path);
  expect(document.body.textContent).toContain("删除会直接从磁盘移除");
});

test("对话框里点「取消」什么都不删", async () => {
  await renderInstalled();
  await act(async () => {
    rowDeleteButton()!.click();
  });
  await settle();

  await act(async () => {
    cancelButton()!.click();
  });
  await settle();

  expect(deleted).toEqual([]);
});

test("确认后才真的删，并且删的就是这一条路径", async () => {
  await renderInstalled();
  await act(async () => {
    rowDeleteButton()!.click();
  });
  await settle();

  await act(async () => {
    dialogDeleteButton()!.click();
  });
  await settle();

  expect(deleted).toEqual([EXTERNAL_MODEL.path]);
});
