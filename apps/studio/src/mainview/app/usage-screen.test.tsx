import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 使用统计页的渲染。
 *
 * 这一页的数字全是 `getUsageStats` 算好的，界面只负责画 —— 所以这里钉的是
 * **画出来的东西对不对**：单位换算（中文按万 / 亿）、渠道名走 i18n（模板 key
 * 拼错会原样显示成 `usage.channels.xxx`）、空库时不画一堆 0、切区间会重新取数。
 * 图表本身是手写 SVG，形状不对很难靠断言描述，交给肉眼；这里只要它不崩。
 *
 * happy-dom 提供真实 DOM，afterAll 还原全局。
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

/** 每次 getUsageStats 的入参，用来确认切区间真的重新取数。 */
const statsCalls: (number | undefined)[] = [];

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const TODAY = day(0);

/** 一份形状与主进程一致的最小数据：两个模型、两个厂商、三个渠道。 */
function statsFixture() {
  const days = [day(-2), day(-1), day(0)];
  return {
    generatedAt: Date.now(),
    rangeDays: 30,
    summary: {
      inputTokens: 300_000_000,
      outputTokens: 138_000_000,
      tokens: 438_000_000,
      requests: 1234,
      todayTokens: 1_200_000,
      todayRequests: 12,
      peakDay: { day: day(-1), inputTokens: 0, outputTokens: 0, tokens: 10_600_000, cachedTokens: 0, reasoningTokens: 0, requests: 40 },
      activeDays: 9,
      currentStreak: 3,
      longestStreak: 8,
      firstDay: day(-30),
      modelCount: 2,
      providerCount: 2,
      estimatedShare: 0,
    },
    range: { days, tokens: 438_000_000, requests: 1234 },
    activity: [
      { day: TODAY, inputTokens: 0, outputTokens: 0, tokens: 0, cachedTokens: 0, reasoningTokens: 0, requests: 0 },
      { day: day(-1), inputTokens: 0, outputTokens: 0, tokens: 10_600_000, cachedTokens: 0, reasoningTokens: 0, requests: 40 },
    ],
    trend: {
      days,
      series: [
        { key: "deepseek-v4.1", label: "deepseek-v4.1", values: [0, 30_000_000, 4_000_000], tokens: 34_000_000 },
        { key: "qwen3", label: "qwen3", values: [1_000_000, 2_000_000, 500_000], tokens: 3_500_000 },
      ],
      other: null,
    },
    models: [
      { key: "deepseek-v4.1", label: "deepseek-v4.1", inputTokens: 0, outputTokens: 0, tokens: 300_000_000, cachedTokens: 0, requests: 900, share: 0.73, lastUsedAt: Date.now() },
      { key: "qwen3", label: "qwen3", inputTokens: 0, outputTokens: 0, tokens: 100_000_000, cachedTokens: 0, requests: 300, share: 0.27, lastUsedAt: Date.now(), detail: "llama.cpp · 云端厂商" },
    ],
    providers: [
      { key: "DeepSeek", label: "DeepSeek", inputTokens: 0, outputTokens: 0, tokens: 300_000_000, cachedTokens: 0, requests: 900, share: 0.73, lastUsedAt: Date.now(), detail: "1" },
      { key: "llama.cpp", label: "llama.cpp", inputTokens: 0, outputTokens: 0, tokens: 100_000_000, cachedTokens: 0, requests: 300, share: 0.27, lastUsedAt: Date.now(), detail: "1" },
    ],
    channels: [
      { key: "gateway", label: "gateway", inputTokens: 0, outputTokens: 0, tokens: 200_000_000, cachedTokens: 0, requests: 800, share: 0.5, lastUsedAt: Date.now() },
      { key: "chat", label: "chat", inputTokens: 0, outputTokens: 0, tokens: 150_000_000, cachedTokens: 0, requests: 400, share: 0.375, lastUsedAt: Date.now() },
      { key: "image", label: "image", inputTokens: 0, outputTokens: 0, tokens: 0, cachedTokens: 0, requests: 34, share: 0, lastUsedAt: Date.now() },
    ],
  };
}

/** 空库形状：全 0，没有峰值日，分组表为空。 */
function emptyFixture() {
  return {
    ...statsFixture(),
    summary: {
      inputTokens: 0,
      outputTokens: 0,
      tokens: 0,
      requests: 0,
      todayTokens: 0,
      todayRequests: 0,
      peakDay: null,
      activeDays: 0,
      currentStreak: 0,
      longestStreak: 0,
      firstDay: null,
      modelCount: 0,
      providerCount: 0,
      estimatedShare: 0,
    },
    range: { days: [TODAY], tokens: 0, requests: 0 },
    activity: [],
    trend: { days: [TODAY], series: [], other: null },
    models: [],
    providers: [],
    channels: [],
  };
}

let response: unknown = statsFixture();

mock.module("@lib/rpc", () => ({
  rpcClient: {
    getUsageStats: async (params?: { rangeDays?: number }) => {
      statsCalls.push(params?.rangeDays);
      return response;
    },
  },
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { UsageScreen } = await import("./usage-screen");
const { translate } = await import("../../shared/i18n");

const zh = (key: string) => translate("zh", key);

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
    root.render(createElement(QueryClientProvider, { client }, createElement(UsageScreen)));
  });
  // 一拍给查询解析，一拍给渲染。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    text: container.textContent ?? "",
    container,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

const clickByText = async (container: HTMLElement, label: string) => {
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  );
  expect(button).not.toBeUndefined();
  await act(async () => {
    (button as unknown as HTMLElement).click();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

test("概要数字按中文单位显示，并拆出输入 / 输出", async () => {
  response = statsFixture();
  const { text, cleanup } = await renderScreen();
  expect(text).toContain("4.4 亿"); // 438,000,000
  expect(text).toContain(zh("usage.summary.total"));
  expect(text).toContain(zh("usage.summary.requests"));
  expect(text).toContain("1,234");
  expect(text).toContain("120 万"); // 今日 1,200,000
  await cleanup();
});

test("模型与厂商分组都画出来，占比带百分号", async () => {
  response = statsFixture();
  const { text, cleanup } = await renderScreen();
  expect(text).toContain("deepseek-v4.1");
  expect(text).toContain("qwen3");
  expect(text).toContain("73%");
  expect(text).toContain("DeepSeek");
  expect(text).toContain("llama.cpp");
  await cleanup();
});

test("渠道名走 i18n，不会把 key 原样画出来", async () => {
  response = statsFixture();
  const { text, cleanup } = await renderScreen();
  expect(text).toContain(zh("usage.channels.gateway"));
  expect(text).toContain(zh("usage.channels.chat"));
  expect(text).toContain(zh("usage.channels.image"));
  expect(text).not.toContain("usage.channels.");
  await cleanup();
});

test("默认取近 30 日；点「近 7 日」重新按 7 天取数", async () => {
  response = statsFixture();
  statsCalls.length = 0;
  const { container, cleanup } = await renderScreen();
  expect(statsCalls).toEqual([30]);
  await clickByText(container, zh("usage.range.7"));
  expect(statsCalls).toEqual([30, 7]);
  await cleanup();
});

test("一行记录都没有时给出说明，而不是画一堆 0", async () => {
  response = emptyFixture();
  const { text, cleanup } = await renderScreen();
  expect(text).toContain(zh("usage.empty.title"));
  expect(text).toContain(zh("usage.empty.desc"));
  expect(text).not.toContain(zh("usage.summary.total"));
  await cleanup();
});
