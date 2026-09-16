import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 视频在途任务轮询的回归测试。
 *
 * 已发生的问题：轮询挂在生成页的 `refetchInterval` 上，而切到「历史」会把生成页卸载
 * —— 在途任务于是冻结在「生成中」，连 30 分钟的超时兜底都不会推进。修法是把轮询提到
 * `VideoScreen`（两个视图之外）。这里钉住 hook 本身的行为：有在途任务才问上游；
 * "挂在哪个组件上"由 `app/video/index.tsx` 的调用点保证。
 */

const dom = new Window({ url: "http://localhost/" });
const DOM_GLOBALS = ["window", "document", "navigator", "location", "HTMLElement", "Element", "Node", "Text"] as const;
const savedGlobals = new Map<string, unknown>();
for (const key of DOM_GLOBALS) {
  const value = (dom as unknown as Record<string, unknown>)[key];
  if (value === undefined) continue;
  savedGlobals.set(key, (globalThis as unknown as Record<string, unknown>)[key]);
  (globalThis as unknown as Record<string, unknown>)[key] = value;
}

const pollCalls: number[][] = [];
let records: { id: number; status: string }[] = [];

mock.module("@lib/rpc", () => ({
  rpcClient: {
    listVideoRecords: async () => ({ records }),
    pollVideoRecords: async ({ ids }: { ids: number[] }) => {
      pollCalls.push(ids);
      return { records: [] };
    },
  },
}));

const { useVideoRecordsPolling } = await import("./use-video-polling");
const { createRoot } = await import("react-dom/client");
// act() 需要这个开关，否则 React 会打印"环境未配置 act"并退回非批处理路径。
(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

function Probe() {
  useVideoRecordsPolling();
  return null;
}

/** 渲染 hook，并让在飞的查询跑完（查询链上全是 async，act 之后还要让出几个宏任务）。 */
async function renderProbe() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Parameters<typeof createRoot>[0]);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Probe)));
  });
  // 让查询的 promise 链推进（bounded：最多 200ms）。放在 act 里：数据到达会触发
  // 组件状态更新，露在 act 外面 React 会一直打印"未包裹 act"的警告。
  await act(async () => {
    await settle();
  });
  return {
    cleanup: () => act(() => root.unmount()),
  };
}

async function settle(ms = 200): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
}

afterAll(async () => {
  // 等 React 的调度回调排空再拆 DOM 全局：卸载后仍有回调在跑，
  // 这时把 window 撤掉会让它在 `window.event` 上炸出一堆噪音。
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
});

test("有在途任务：按这些 id 问上游", async () => {
  records = [
    { id: 7, status: "processing" },
    { id: 8, status: "done" },
  ];
  pollCalls.length = 0;
  const { cleanup } = await renderProbe();
  expect(pollCalls).toEqual([[7]]);
  cleanup();
});

test("没有在途任务：不问上游", async () => {
  records = [{ id: 9, status: "done" }];
  pollCalls.length = 0;
  const { cleanup } = await renderProbe();
  expect(pollCalls).toEqual([]);
  cleanup();
});
