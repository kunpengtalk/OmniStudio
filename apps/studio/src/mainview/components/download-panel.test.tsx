import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

// 下载面板的下拉列表要为「下载记录」负责：整份历史都必须渲染出来，并且落在
// 一个真正能滚动的容器里。曾经的问题是容器只有 max-h、滚动区没有确定高度，
// Radix 视口被内容撑开后被根的 overflow 裁掉 —— 14 条记录只看得见 2 条，
// 也没法下拉。这个文件锁住结构，避免再退化。
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
  "HTMLSpanElement",
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

type Task = {
  id: string;
  repo: string;
  fileName: string;
  source: "modelscope" | "huggingface";
  status: "queued" | "downloading" | "paused" | "completed" | "failed" | "canceled";
  received: number;
  total: number | null;
  percent: number | null;
  speed: number;
  error?: string;
  createdAt: number;
};

const REPO = "mlx-community/MiniCPM5-2B-mlx-4Bit";
const fileNames = [
  "tokenizer.json",
  "configuration.json",
  "generation_config.json",
  "tokenizer_config.json",
  "config.json",
  "chat_template.jinja",
  "model.safetensors.index.json",
  "model.safetensors",
  "special_tokens_map.json",
  "vocab.json",
  "merges.txt",
  "tokenizer.model",
  "added_tokens.json",
  "preprocessor_config.json",
];
// 最新的是两条失败任务（面板排序把它们放在最前面），其余是已完成的历史。
// 失败任务里有一条和最早的历史同名（tokenizer.json）—— 监控页面上就是这种
// 重名重下的情况，列表必须按任务渲染而不是按文件名去重。
const tasks: Task[] = [
  {
    id: "t-failed-new",
    repo: REPO,
    fileName: "tokenizer.json",
    source: "modelscope",
    status: "failed",
    received: 0,
    total: null,
    percent: 0,
    speed: 0,
    error: "Download failed: 500",
    createdAt: 200,
  },
  {
    id: "t-failed-old",
    repo: REPO,
    fileName: "configuration.json",
    source: "modelscope",
    status: "failed",
    received: 0,
    total: null,
    percent: 0,
    speed: 0,
    error: "Download failed: 500",
    createdAt: 199,
  },
  ...fileNames
    .slice(2)
    .map((fileName, i) => ({
      id: `t-done-${i}`,
      repo: REPO,
      fileName,
      source: "modelscope" as const,
      status: "completed" as const,
      received: 1024,
      total: 1024,
      percent: 100,
      speed: 0,
      createdAt: 100 - i,
    })),
];

const listDownloadsCalls: number[] = [];
mock.module("@lib/rpc", () => ({
  rpcClient: {
    listDownloads: async () => {
      listDownloadsCalls.push(Date.now());
      return { tasks };
    },
    removeDownload: async () => ({ ok: true }),
    pauseModelDownload: async () => ({ ok: true }),
    resumeModelDownload: async () => ({ ok: true }),
    cancelModelDownload: async () => ({ ok: true }),
  },
}));

const { act } = await import("react");
const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("./ui/tooltip");
const { DownloadsButton } = await import("./download-panel");
const { useModelDownloadStore } = await import("@stores/model-download");
const { translate } = await import("../../shared/i18n");

const zh = (key: string, params?: Record<string, string>) => translate("zh", key, params);

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

function textOf(node: Element): string {
  return (node.textContent ?? "").replace(/\s+/g, " ");
}

/** 渲染面板、点开下载按钮，拿到下拉容器。 */
async function openPanel() {
  useModelDownloadStore.getState().setTasks([]);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TooltipProvider, null, createElement(DownloadsButton)),
      ),
    );
    // 等 listDownloads 的 promise 落地，任务列表进 store。
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  // 面板里初始只有一个按钮：下载管理触发器（tooltip 只走 Radix，不落 aria-label）。
  const trigger = container.querySelector("button") as unknown as HTMLElement;
  expect(trigger).not.toBeNull();
  await act(async () => {
    trigger.click();
  });

  return {
    container,
    popover: () => {
      // 结构定位：下拉容器是滚动区的父节点（不依赖标题层级，之前用标题的
      // parentElement 链定位，改一次表头就找不到了）。
      const scrollArea = document.querySelector("[data-slot='scroll-area']");
      expect(scrollArea).not.toBeNull();
      const popover = scrollArea!.parentElement as unknown as HTMLElement;
      expect(popover.className).toContain("w-80");
      return popover;
    },
    close: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

test("下载记录整份渲染：14 条任务都在列表里，不只最近几条", async () => {
  const panel = await openPanel();
  try {
    expect(listDownloadsCalls.length).toBeGreaterThan(0);
    const popover = panel.popover();
    const text = textOf(popover as unknown as Element);
    for (const fileName of fileNames) {
      expect(text).toContain(fileName);
    }
    // 面板标题上的计数与任务总数一致。
    expect(text).toContain(`(${tasks.length})`);
    // Radix 滚动视口存在，且列表挂在它下面。
    const viewport = popover.querySelector("[data-radix-scroll-area-viewport]");
    expect(viewport).not.toBeNull();
    expect(textOf(viewport as unknown as Element)).toContain("preprocessor_config.json");
  } finally {
    await panel.close();
  }
});

test("列表容器高度有上限且滚动区拿到确定高度：视口才能出现滚动条", async () => {
  const panel = await openPanel();
  try {
    const popover = panel.popover();
    const popoverClass = popover.className;
    // 祖先盒子（flex 列 + 上限高度）必须先约束住自己，列表才有确定的可用高度。
    expect(popoverClass).toContain("flex-col");
    expect(popoverClass).toContain("h-[min(");

    const scrollArea = popover.querySelector("[data-slot='scroll-area']") as HTMLElement;
    expect(scrollArea).not.toBeNull();
    // Radix 视口是 height:100%，只有滚动区自己带确定高度（或祖先确定高度 + 自身
    // max-h）时才会解析成滚动高度；实测只给祖先 max-h 时视口被内容撑开、被裁掉。
    expect(scrollArea.className).toContain("h-[min(");
    expect(scrollArea.className).toContain("min-h-0");
    expect(scrollArea.className).not.toContain("max-h-");

    const viewport = popover.querySelector("[data-slot='scroll-area-viewport']") as HTMLElement;
    expect(viewport.className).toContain("min-h-0");
  } finally {
    await panel.close();
  }
});

test("正在下的排在最前、历史按时间倒序跟在后面", async () => {
  const panel = await openPanel();
  try {
    const text = textOf(panel.popover() as unknown as Element);
    const firstFailed = text.indexOf("tokenizer.json");
    const secondFailed = text.indexOf("configuration.json");
    const history = text.indexOf("generation_config.json");
    expect(firstFailed).toBeGreaterThan(-1);
    expect(firstFailed).toBeLessThan(secondFailed);
    expect(secondFailed).toBeLessThan(history);
  } finally {
    await panel.close();
  }
});
