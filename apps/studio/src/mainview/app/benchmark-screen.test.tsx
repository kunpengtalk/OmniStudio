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

/** 缓存场景 chip 的标签（与 i18n 里的 benchmark.cache.* 一致）。 */
const CACHE_LABELS = ["冷启（不命中）", "部分命中", "完全命中"];

/** 界面提交给主进程的测速参数（断言"勾了 1M 真的会传 1M"）。 */
const startCalls: {
  contexts?: number[];
  cacheModes?: string[];
  genLength?: number;
  batchSize?: number;
}[] = [];

/** 导出的报告（断言"点一下真的把整份报告交出去了"）。 */
const exportCalls: { filename: string; html: string }[] = [];

/** 一份跑过三种缓存场景的历史记录：界面据此渲染"缓存命中对比"。 */
const CACHE_RECORD_ROWS = [
  {
    contextLength: 8192,
    promptTokens: 8192,
    batchSize: 1,
    ttftMs: 800,
    tpotMs: 12,
    tps: 20,
    aggTps: 20,
    prefillTps: 10240,
    tokens: 128,
    totalMs: 6000,
    ok: 1,
    fails: 0,
    cache: "cold",
  },
  {
    contextLength: 8192,
    promptTokens: 8192,
    batchSize: 1,
    ttftMs: 200,
    tpotMs: 10,
    tps: 40,
    aggTps: 40,
    prefillTps: 40960,
    tokens: 128,
    totalMs: 3000,
    ok: 1,
    fails: 0,
    cache: "partial",
  },
  {
    contextLength: 8192,
    promptTokens: 8192,
    batchSize: 1,
    ttftMs: 80,
    tpotMs: 10,
    tps: 60,
    aggTps: 60,
    prefillTps: 102400,
    tokens: 128,
    totalMs: 2000,
    ok: 1,
    fails: 0,
    cache: "warm",
    cacheReusedTokens: 8000,
  },
];

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
  musicApi: "",
  createdAt: 0,
  updatedAt: 0,
};

/** 完全命中却没有变快：服务端压根没吃到前缀缓存，界面要给出诊断。 */
const NO_CACHE_GAIN_ROWS = [
  { ...CACHE_RECORD_ROWS[0]! },
  { ...CACHE_RECORD_ROWS[2]!, ttftMs: 780, cacheReusedTokens: undefined },
];

/** 历史记录里的 rows / summary（默认空，用例按需替换）。 */
let recordRows: unknown[] = [];
let recordSummary: Record<string, unknown> | null = null;

mock.module("@lib/rpc", () => ({
  rpcClient: {
    getSettings: async () => ({
      settings: {
        SERVER_MODE: "local",
        // MLX 的请求 id 与激活路径都是绝对路径 —— 界面必须自己收敛成模型名。
        CHAT_MODEL: MODEL_PATH,
        LOCAL_MODEL_PATH: MODEL_PATH,
        LOCAL_MODEL_NAME: MODEL_NAME,
        // llama.cpp 的单请求窗口：并发 1 时就是 SERVER_CTX_SIZE（默认勾到 32k，会超窗）
        SERVER_CTX_SIZE: "8192",
        SERVER_PARALLEL: "1",
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
      total: 1,
      // 列表只回元数据（rows/summary 为空），正文本着 getBenchmarkRecord 单条拉取。
      records: [{ ...mockRecord(), rows: null, summary: null }],
    }),
    getBenchmarkRecord: async () => ({ record: mockRecord() }),
    getEvalSuites: async () => ({ suites: [] }),
    startBenchmark: async (params: unknown) => {
      startCalls.push(params as { contexts?: number[]; cacheModes?: string[]; genLength?: number; batchSize?: number });
      return { runId: "run-test" };
    },
    getBenchmarkRun: async () => ({ run: null }),
    cancelBenchmark: async () => ({ ok: true }),
    exportBenchmarkReport: async (params: { filename: string; html: string }) => {
      exportCalls.push(params);
      return { ok: true, path: `/Users/me/Downloads/${params.filename}` };
    },
    showInExplorer: async () => ({ ok: true }),
  },
}));

function mockRecord() {
  return {
    id: 7,
    kind: "speed" as const,
    model: MODEL_PATH,
    serverMode: "local" as const,
    engine: "mlx" as const,
    params: null,
    rows: recordRows,
    summary: recordSummary,
    status: "done" as const,
    durationMs: 1000,
    error: null,
    createdAt: Date.now(),
  };
}

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { BenchmarkScreen } = await import("./benchmark");

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
  // 历史记录现在是「先取元数据、再按需取正文」两跳：多刷一轮让详情查询落地。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  /** chip 样式（圆角 + 选中态）相同，只能按标签挑。 */
  const chipLabels = (match: (label: string) => boolean, selectedOnly = false) =>
    [...container.querySelectorAll("button.rounded-full")]
      .filter((b) => !selectedOnly || b.className.includes("bg-primary/10"))
      .map((b) => b.textContent?.trim() ?? "")
      .filter(match);
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
    /**
     * 上下文档位 chip 与缓存场景 chip 是同一套样式（圆角 + 选中态），
     * 按标签形状分开：档位是数字（1k / 32k / 1M），缓存场景是中文词。
     */
    chips: () => chipLabels((l) => /^[\d.]+[kM]?$/.test(l)),
    selectedChips: () => chipLabels((l) => /^[\d.]+[kM]?$/.test(l), true),
    cacheChips: () => chipLabels((l) => CACHE_LABELS.includes(l)),
    selectedCacheChips: () => chipLabels((l) => CACHE_LABELS.includes(l), true),
    clickChip: async (label: string) => {
      const chip = [...container.querySelectorAll("button.rounded-full")].find(
        (b) => b.textContent?.trim() === label,
      );
      if (!chip) throw new Error(`找不到档位 ${label}`);
      await act(async () => {
        chip.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      await act(async () => {
        await Promise.resolve();
      });
    },
    /** 往自定义档位输入框里填值（React 的 onChange 认原生 setter + input 事件） */
    fillCustom: async (text: string) => {
      const input = container.querySelector("#benchCtxCustom") as HTMLInputElement | null;
      if (!input) throw new Error("找不到自定义档位输入框");
      const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")?.set;
      await act(async () => {
        setter?.call(input, text);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        await Promise.resolve();
      });
    },
    clickByText: async (label: string) => {
      const button = [...container.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === label,
      );
      if (!button) throw new Error(`找不到按钮「${label}」`);
      await act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      await act(async () => {
        await Promise.resolve();
      });
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

test("档位 chip 一路到 1M，默认只勾到 32k", async () => {
  const screen = await renderScreen();
  try {
    const chips = screen.chips();
    // 1M（百万级窗口）必须可选；中间档位按倍增补齐
    for (const label of ["1k", "32k", "64k", "128k", "256k", "512k", "1M"]) {
      expect(chips).toContain(label);
    }
    // 默认不勾大档位：1M 一档在本地机器上要跑几十分钟，不能是"点开就跑"的默认值
    expect(screen.selectedChips()).toEqual(["1k", "4k", "8k", "16k", "32k"]);
  } finally {
    await screen.cleanup();
  }
});

test("勾上 1M 再开始测试：请求里的档位带 1048576", async () => {
  const screen = await renderScreen();
  try {
    await screen.clickChip("1M");
    expect(screen.selectedChips()).toContain("1M");
    startCalls.length = 0;
    await screen.clickByText("开始测试");
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]!.contexts).toContain(1048576);
    // 勾选是叠加而不是替换：默认那几档还在
    expect(startCalls[0]!.contexts).toContain(32768);
  } finally {
    await screen.cleanup();
  }
});

test("自定义档位：200k 能加进来并被选中，超过 1M 只给提示不添加", async () => {
  const screen = await renderScreen();
  try {
    await screen.fillCustom("200k");
    await screen.clickByText("添加");
    // k 按二进制算：200k = 204800 tokens
    expect(screen.chips()).toContain("200k");
    expect(screen.selectedChips()).toContain("200k");

    // 超出上限（1M）不静默夹紧：提示范围，不把用户填的 2m 悄悄改成 1M
    await screen.fillCustom("2m");
    await screen.clickByText("添加");
    expect(screen.chips()).not.toContain("2M");
    expect(screen.text()).toContain("档位范围");

    // 认不出来的输入同样只提示
    await screen.fillCustom("abc");
    await screen.clickByText("添加");
    expect(screen.text()).toContain("可带 k / m 后缀");
  } finally {
    await screen.cleanup();
  }
});

test("所选档位超出推理服务器窗口时给出超窗提示", async () => {
  const screen = await renderScreen();
  try {
    // 假设置里 SERVER_CTX_SIZE=8192、并发 1：默认勾到的 16k / 32k 两档会被服务端拒绝
    expect(screen.text()).toContain("推理服务器单请求窗口约 8k");
    expect(screen.text()).toContain("2 档超窗");

    // 取消掉超窗的两档就不再报警告，改回普通范围提示
    await screen.clickChip("16k");
    await screen.clickChip("32k");
    expect(screen.text()).not.toContain("档超窗");
    expect(screen.text()).toContain("可测 128 ~ 1M tokens");
  } finally {
    await screen.cleanup();
  }
});

test("缓存场景默认三种都勾，开始测试时把场景一起传下去", async () => {
  const screen = await renderScreen();
  try {
    expect(screen.cacheChips()).toEqual(CACHE_LABELS);
    expect(screen.selectedCacheChips()).toEqual(CACHE_LABELS);
    // 至少留一种：三种都点掉也只是把最后一种留下，不会出现"一个都没勾"
    for (const label of CACHE_LABELS) await screen.clickChip(label);
    expect(screen.selectedCacheChips()).toEqual(["完全命中"]);

    startCalls.length = 0;
    await screen.clickByText("开始测试");
    expect(startCalls[0]!.cacheModes).toEqual(["warm"]);
  } finally {
    recordRows = [];
    await screen.cleanup();
  }
});

test("缓存命中对比：冷启 → 部分命中 → 完全命中 的倍数与服务端自报的复用比例", async () => {
  recordRows = CACHE_RECORD_ROWS;
  recordSummary = {
    avgTps: 20,
    peakTps: 60,
    avgTtftMs: 800,
    bestTtftMs: 800,
    peakAggTps: 60,
    peakPrefillTps: 102400,
    totalTokens: 384,
    basis: "cold",
  };
  const screen = await renderScreen();
  try {
    expect(screen.text()).toContain("缓存命中对比");
    // 800ms → 200ms（×4）→ 80ms（×10）
    expect(screen.text()).toContain("×4");
    expect(screen.text()).toContain("×10");
    // llama.cpp 的 timings.cache_n：8000 / 8192 = 98%
    expect(screen.text()).toContain("服务端复用 98% 输入");
    // 汇总说的是哪一种工况
    expect(screen.text()).toContain("平均 / 最佳取自「冷启（不命中）」");
    // 明细表里每行标出场景，三行不再互相顶掉（key 按 档位+场景）
    expect(screen.text()).toContain("部分命中");
  } finally {
    recordRows = [];
    recordSummary = null;
    await screen.cleanup();
  }
});

test("完全命中却没变快：界面直接点名「没吃到前缀缓存」", async () => {
  recordRows = NO_CACHE_GAIN_ROWS;
  const screen = await renderScreen();
  try {
    expect(screen.text()).toContain("服务端没吃到前缀缓存");
  } finally {
    recordRows = [];
    await screen.cleanup();
  }
});

test("右上角「导出 HTML」：把当前这份报告整份交给主进程落盘，并回报位置", async () => {
  recordRows = CACHE_RECORD_ROWS;
  recordSummary = {
    avgTps: 20,
    peakTps: 60,
    avgTtftMs: 800,
    bestTtftMs: 800,
    peakAggTps: 60,
    peakPrefillTps: 102400,
    totalTokens: 384,
    basis: "cold",
  };
  const screen = await renderScreen();
  try {
    exportCalls.length = 0;
    await screen.clickByText("导出 HTML");
    // 导出是异步的（要等主进程写盘回来才显示落点）：多刷一轮微任务。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(exportCalls).toHaveLength(1);
    const call = exportCalls[0]!;
    expect(call.filename).toMatch(/^omni-benchmark-.+\.html$/);
    // 报告是完整文档：模型名、明细表、缓存对比都在里面
    expect(call.html.startsWith("<!doctype html>")).toBe(true);
    expect(call.html).toContain(MODEL_NAME);
    expect(call.html).toContain("缓存命中对比");
    expect(call.html).toContain("冷启（不命中）");
    // 落盘位置要说出来，否则用户不知道文件去哪了
    expect(screen.text()).toContain("已导出到");
    expect(screen.text()).toContain("Downloads");
  } finally {
    recordRows = [];
    recordSummary = null;
    await screen.cleanup();
  }
});
