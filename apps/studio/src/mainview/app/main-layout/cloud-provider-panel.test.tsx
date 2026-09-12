import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 模型云服务面板的回归测试：分类标签的样式统一 + 「获取模型列表」的挑选流程。
 *
 * 之前两件事都被改过：
 *   1. 分类标签一色一类（蓝/青/紫/琥珀…），一行下来像调色板 —— 现在一套中性样式，
 *      靠小图标区分，颜色只留给状态；
 *   2. 「获取模型列表」直接把服务商返回的上百个模型全写进配置 —— 现在只弹框列出来，
 *      用户逐个「+」添加，弹框里能看到哪些已经加过。
 */

// happy-dom 提供真实 DOM（Radix 的 Dialog 需要），afterAll 还原全局。
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

// 已配置的两个模型：一个对话、一个嵌入。
const HAVE = ["Qwen/Qwen3-8B", "BAAI/bge-m3"];
// 服务商 /v1/models 返回的清单（含上面两个 + 三个还没加的）。
const REMOTE = [
  "Qwen/Qwen3-8B",
  "BAAI/bge-m3",
  "BAAI/bge-reranker-v2-m3",
  "FunAudioLLM/CosyVoice2-0.5B",
  "deepseek-ai/DeepSeek-V3",
];

const updates: { id: string; models?: { id: string }[] }[] = [];

/** 让单个用例能改「拉取模型列表」的返回（成功 / 失败两种路径都要能跑到）。 */
let remoteResult: { ok: boolean; models: string[]; error?: string } = { ok: true, models: REMOTE };

mock.module("@lib/rpc", () => ({
  rpcClient: {
    cloudProviderList: async () => ({
      providers: [
        {
          id: "siliconflow",
          name: "SiliconFlow",
          vendor: "硅基流动",
          baseUrl: "https://api.siliconflow.cn/v1",
          apiKey: "sk-test",
          models: HAVE.map((id) => ({ id })),
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      activeId: null,
    }),
    getSettings: async () => ({ settings: { SERVER_MODE: "remote", VLLM_MODEL_NAME: "" } }),
    listRemoteModels: async () => remoteResult,
    cloudProviderUpdate: async (params: { id: string; models?: { id: string }[] }) => {
      updates.push(params);
      return { ok: true };
    },
    checkConnection: async () => ({ connected: true }),
    selectChatModel: async () => ({ ok: true }),
    openGatewayDocs: async () => ({ ok: true }),
  },
}));

// Logo 是 webview 的静态资源，测试里不需要真的把 PNG 读进来。
mock.module("./provider-logos", () => ({ PROVIDER_LOGOS: {}, MONO_LOGO_PATHS: {} }));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { CloudProviderPanel } = await import("./cloud-provider-panel");
const { TooltipProvider } = await import("@ui/tooltip");
const { translate } = await import("../../../shared/i18n");

const zh = (key: string) => translate("zh", key);

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

async function renderPanel() {
  // 断言失败会跳过用例末尾的 unmount，弹框（Radix portal）会留在 body 里污染下一个用例
  for (const el of Array.from(document.body.children)) el.remove();
  const errors: unknown[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container, {
    onUncaughtError: (error) => errors.push(error),
    onRecoverableError: (error) => errors.push(error),
  });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TooltipProvider, null, createElement(CloudProviderPanel, null)),
      ),
    );
  });
  // 等服务商 / 设置查询落地
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    errors,
    container,
    get text() {
      return document.body.textContent ?? "";
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** 点标题栏里的「获取模型列表」，等弹框内容渲染出来。 */
async function openPicker(container: HTMLElement) {
  const button = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(zh("cloud.fetchModels")),
  );
  expect(button).toBeDefined();
  await act(async () => {
    button!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function rowOf(id: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-remote-model="${id}"]`);
}

test("分类标签一套中性样式，靠图标区分，不再一色一类", async () => {
  const view = await renderPanel();
  expect(view.errors).toEqual([]);
  const chips = [...view.container.querySelectorAll<HTMLElement>("[data-model-category]")];
  expect(chips.length).toBe(2);
  // 分类不同（对话 / 嵌入），但样式完全一致
  expect(new Set(chips.map((c) => c.getAttribute("data-model-category"))).size).toBe(2);
  expect(new Set(chips.map((c) => c.className)).size).toBe(1);
  const cls = chips[0]!.className;
  expect(cls).toContain("bg-muted");
  expect(cls).toContain("text-muted-foreground");
  // 旧的多彩配色不该再出现
  for (const color of ["bg-blue-100", "bg-cyan-100", "bg-indigo-100", "bg-amber-100"]) {
    expect(cls).not.toContain(color);
  }
  // 图标带在每个标签里（shape 区分分类）
  expect(chips[0]!.querySelector("svg")).not.toBeNull();
  await view.unmount();
});

test("获取模型列表只弹框列出来，不会把模型全加回来", async () => {
  updates.length = 0;
  const view = await renderPanel();
  await openPicker(view.container);

  // 弹框列出服务商清单（含没加过的那些），已有条目保留原名
  expect(view.text).toContain(zh("cloud.pickTitle"));
  for (const id of REMOTE) expect(rowOf(id)).not.toBeNull();
  // 分组按 id 前缀切开
  expect(view.text).toContain("FunAudioLLM");
  // 关键：拿到清单不等于写库 —— 一条都不该自动加
  expect(updates.length).toBe(0);

  // 已经加过的显示「已添加」且没有「+」按钮
  const have = rowOf(HAVE[0]!)!;
  expect(have.textContent).toContain(zh("cloud.pickAdded"));
  expect(have.querySelector("button")).toBeNull();
  // 没加过的行有「+」
  expect(rowOf(REMOTE[3]!)!.querySelector("button")).not.toBeNull();

  await view.unmount();
});

test("分类条是固定的：云端一个都没有的那些分类也照常列出（计数 0）", async () => {
  remoteResult = { ok: true, models: REMOTE };
  const view = await renderPanel();
  await openPicker(view.container);

  // 十个 tab 一个不少，计数对得上号：生图 / 生视频 / 其它 / 失效 是 0 也照常列出
  const tabTexts = [...document.body.querySelectorAll("button")].map(
    (b) => b.textContent?.trim() ?? "",
  );
  const expected: [string, number][] = [
    ["models.cat.all", 5],
    ["models.cat.chat", 2],
    ["models.cat.embedding", 1],
    ["models.cat.rerank", 1],
    ["models.cat.tts", 1],
    ["models.cat.asr", 0],
    ["models.cat.image", 0],
    ["models.cat.video", 0],
    ["models.cat.other", 0],
    ["cloud.tabStale", 0],
  ];
  for (const [key, count] of expected) {
    expect(tabTexts).toContain(`${zh(key)}${count}`);
  }

  await view.unmount();
});

test("拉取失败也只是清单空：页面照旧、分类条还在，并给重试", async () => {
  remoteResult = { ok: false, models: [], error: "请求失败：HTTP 401" };
  try {
    const view = await renderPanel();
    await openPicker(view.container);

    // 标题 / 分类条 / 搜索都在，不是一个独占整屏的错误页
    expect(view.text).toContain(zh("cloud.pickTitle"));
    expect(view.text).toContain(zh("models.cat.embedding"));
    expect(rowOf(REMOTE[0]!)).toBeNull();
    // 错误原因和「重试」写在清单区域里
    expect(view.text).toContain("请求失败：HTTP 401");
    const retry = [...document.body.querySelectorAll("button")].find((b) =>
      b.textContent?.includes(zh("common.retry")),
    );
    expect(retry).toBeDefined();
    expect(updates.length).toBe(0);

    await view.unmount();
  } finally {
    remoteResult = { ok: true, models: REMOTE };
  }
});

test("逐个添加：点「+」只把那个模型加进去，已有条目不丢", async () => {
  updates.length = 0;
  const view = await renderPanel();
  await openPicker(view.container);

  const add = rowOf("FunAudioLLM/CosyVoice2-0.5B")!.querySelector<HTMLButtonElement>("button");
  expect(add).not.toBeNull();
  await act(async () => {
    add!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(updates.length).toBe(1);
  expect(updates[0]!.id).toBe("siliconflow");
  expect(updates[0]!.models?.map((m) => m.id)).toEqual([...HAVE, "FunAudioLLM/CosyVoice2-0.5B"]);

  await view.unmount();
});
