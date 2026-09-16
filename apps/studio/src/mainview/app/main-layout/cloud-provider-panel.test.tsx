import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 模型云服务面板的回归测试：分类标签的样式统一 + 「获取模型列表」的挑选流程。
 *
 * 之前这几件事都被改过：
 *   1. 分类标签一色一类（蓝/青/紫/琥珀…），一行下来像调色板 —— 现在一套中性样式，
 *      靠小图标区分，颜色只留给状态；
 *   2. 「获取模型列表」直接把服务商返回的上百个模型全写进配置 —— 现在只弹框列出来，
 *      用户逐个「+」添加，弹框里能看到哪些已经加过；
 *   3. 拉不到清单时打开空弹框、把上游报错原文（`获取失败：密钥无效或没有权限（HTTP 401）`）
 *      挂在清单区 —— 密钥过期是配置状态，不是页面错误：现在不弹框，只在模型卡片里
 *      留一行中性结论，原文交给 logs/app.log。
 *   4. 模型列用「max-w-0 + 省略号」压宽度，一列 `stepaudio-3-asr-max` / `stepaudio-2.5-asr`
 *      全成了 `stepaudi…` —— 模型 id 是唯一标识，现在任何情况下都完整显示（换行不截断）。
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

// 已配置的两个模型：一个对话（带别名，用来盯住「别名不许把 id 挤掉」）、一个嵌入。
const HAVE = ["Qwen/Qwen3-8B", "BAAI/bge-m3"];
const HAVE_ROWS = [{ id: HAVE[0]!, name: "Qwen3 8B · 别名" }, { id: HAVE[1]! }];
// 服务商 /v1/models 返回的清单（含上面两个 + 三个还没加的）。
const REMOTE = [
  "Qwen/Qwen3-8B",
  "BAAI/bge-m3",
  "BAAI/bge-reranker-v2-m3",
  "FunAudioLLM/CosyVoice2-0.5B",
  "deepseek-ai/DeepSeek-V3",
];

const updates: { id: string; models?: { id: string }[] }[] = [];
/** 「设为默认模型」下发的参数：必须带 providerId，见对应用例。 */
const selectCalls: { type: string; value: string; providerId?: string }[] = [];

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
          models: HAVE_ROWS,
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
    selectChatModel: async (params: { type: string; value: string; providerId?: string }) => {
      selectCalls.push(params);
      return { ok: true };
    },
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

  // 十个 tab 一个不少，计数对得上号：生图 / 生视频 / 其它 / 失效 是 0 也照常列出。
  // 筛选条上用的是两字短名（图标 + 短名 + 计数），完整分类名放在 title 里。
  const chips = [...document.body.querySelectorAll<HTMLElement>("button[aria-pressed]")];
  const expected: [string, number][] = [
    ["models.catShort.all", 5],
    ["models.catShort.chat", 2],
    ["models.catShort.embedding", 1],
    ["models.catShort.rerank", 1],
    ["models.catShort.tts", 1],
    ["models.catShort.asr", 0],
    ["models.catShort.image", 0],
    ["models.catShort.video", 0],
    ["models.catShort.other", 0],
    ["cloud.tabStale", 0],
  ];
  for (const [key, count] of expected) {
    const chip = chips.find((b) => b.textContent?.trim() === `${zh(key)}${count}`);
    expect(chip).toBeDefined();
  }
  // 分类颗带图标（全部 / 失效 是筛选口径，没有图标）
  expect(chips.find((b) => b.textContent?.includes(zh("models.catShort.embedding")))!.querySelector("svg")).not.toBeNull();
  // 完整分类名没有丢，作为悬浮提示留在短名上
  expect(chips.map((b) => b.getAttribute("title"))).toContain(
    `${zh("models.cat.embedding")} · 1`,
  );
  expect(chips.map((b) => b.getAttribute("title"))).toContain(`${zh("cloud.tabStale")} · 0`);
  // 之前贴完整分类名时一行排不下，横向滚动条就是这么来的：筛选条必须是换行排版
  const row = chips[0]!.parentElement!;
  expect(row.className).toContain("flex-wrap");
  expect(row.className).not.toContain("overflow-x");

  await view.unmount();
});

test("拉取失败不弹框、也不把上游报错写在页面上", async () => {
  remoteResult = { ok: false, models: [], error: "密钥无效或没有权限（HTTP 401）" };
  try {
    const view = await renderPanel();
    await openPicker(view.container);

    // 弹框不打开：空清单里挂一句 401，用户看不出该改什么，只会以为页面坏了
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    // 上游报错原文一个字都不上面（原文归 logs/app.log 的 cloud-provider.models.failed）
    expect(view.text).not.toContain("HTTP 401");
    expect(view.text).not.toContain("密钥无效或没有权限");
    // 只留一行结论，与「检查」同一套文案，且是中性的（红字留给真正的错误状态）
    const line = [...view.container.querySelectorAll("p")].find((p) =>
      p.textContent?.includes(zh("cloud.checkFail")),
    );
    expect(line).toBeDefined();
    expect(line!.className).toContain("text-muted-foreground");
    expect(line!.className).not.toContain("text-destructive");
    expect(updates.length).toBe(0);

    await view.unmount();
  } finally {
    remoteResult = { ok: true, models: REMOTE };
  }
});

test("改完密钥重新拉取：上一行结论消失，弹框正常打开", async () => {
  remoteResult = { ok: false, models: [], error: "密钥无效或没有权限（HTTP 401）" };
  try {
    const view = await renderPanel();
    await openPicker(view.container);
    expect(view.text).toContain(zh("cloud.checkFail"));

    // 在密钥框里改一下（失焦即保存）→ 上一次的结论作废
    const key = view.container.querySelector<HTMLInputElement>('input[type="password"]');
    expect(key).not.toBeNull();
    await act(async () => {
      // 直接赋 .value 会被 React 的 value tracker 吞掉：走原生 setter 才会触发 onChange。
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setValue.call(key!, "sk-new");
      key!.dispatchEvent(new Event("input", { bubbles: true }));
      // React 17+ 的 onBlur 接的是 focusout（bubbles），不是 blur。
      key!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(view.text).not.toContain(zh("cloud.checkFail"));

    remoteResult = { ok: true, models: REMOTE };
    await openPicker(view.container);
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(rowOf(REMOTE[3]!)).not.toBeNull();

    await view.unmount();
  } finally {
    remoteResult = { ok: true, models: REMOTE };
  }
});

test("设为默认模型：把所属厂商一起带上", async () => {
  // 网关只往**默认厂商**发云端请求。星标按钮不带 providerId 时，面板只是把模型名记下来，
  // 地址与密钥还停在另一家 —— 用户看到的就是「应用里能选的模型，用起来说模型不存在」。
  selectCalls.length = 0;
  const view = await renderPanel();

  const star = view.container.querySelector<HTMLButtonElement>('[data-set-default="Qwen/Qwen3-8B"]');
  expect(star).not.toBeNull();
  await act(async () => {
    star!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(selectCalls).toEqual([
    { type: "api", value: "Qwen/Qwen3-8B", providerId: "siliconflow" },
  ]);

  await view.unmount();
});

test("模型列里的 id 一定完整：换行不省略，也不靠悬浮提示兜底", async () => {
  const view = await renderPanel();

  // 带别名的条目：别名一行、id 一行，id 一个字都不少
  const named = view.container.querySelector<HTMLElement>('[data-model-id="Qwen/Qwen3-8B"]');
  expect(named).not.toBeNull();
  expect(named!.textContent).toContain("Qwen/Qwen3-8B");
  // 「max-w-0 + truncate」就是上一版把 id 压成 stepaudi… 的那套写法，别回来
  expect(named!.className).not.toContain("max-w-0");
  // 这一列里不许再出现省略号 —— 别名长了也是换行
  for (const el of named!.querySelectorAll<HTMLElement>("span")) {
    expect(el.className).not.toContain("truncate");
  }
  const idLine = [...named!.querySelectorAll<HTMLElement>("span")].find(
    (s) => s.textContent === "Qwen/Qwen3-8B",
  );
  expect(idLine).toBeDefined();
  // 换行靠 overflow-wrap:anywhere：列被压窄时在 id 内部断开，而不是切掉后半截
  expect(idLine!.className).toContain("wrap-anywhere");
  expect(idLine!.className).toContain("font-mono");

  // 没有别名的条目：id 就是正文，同样完整
  const plain = view.container.querySelector<HTMLElement>('[data-model-id="BAAI/bge-m3"]');
  expect(plain!.textContent).toBe("BAAI/bge-m3");
  const plainLine = plain!.querySelector<HTMLElement>("span");
  expect(plainLine!.className).toContain("wrap-anywhere");
  expect(plainLine!.className).not.toContain("truncate");

  await view.unmount();
});

test("挑选清单里的 id 也不省略：分组前缀与行内后缀各自完整", async () => {
  const view = await renderPanel();
  await openPicker(view.container);

  // 行里只留后缀，前缀由分组行给出 —— 两截都不许截断，合起来才是完整 id
  const row = rowOf("FunAudioLLM/CosyVoice2-0.5B")!;
  const suffix = row.querySelector<HTMLElement>("span.font-mono")!;
  expect(suffix.textContent).toBe("CosyVoice2-0.5B");
  expect(suffix.className).toContain("wrap-anywhere");
  expect(suffix.className).not.toContain("truncate");

  const prefix = [...document.body.querySelectorAll<HTMLElement>("span")].find(
    (s) => s.textContent === "FunAudioLLM",
  );
  expect(prefix).toBeDefined();
  expect(prefix!.className).not.toContain("truncate");

  await view.unmount();
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
