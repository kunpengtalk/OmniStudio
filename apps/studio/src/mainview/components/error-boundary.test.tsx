import { afterAll, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { Window } from "happy-dom";

// ---------------------------------------------------------------------------
// 错误边界：路由页面抛异常时用户看到什么、以及**怎么恢复**。
//
// 已发生的问题：整页白屏 —— 一个 screen 在渲染里抛出去，React 卸载整棵树，
// 用户既看不到原因也没有出路。这个边界补上两件事：
//   1. 显示错误页（文案 + 原因 + 可展开的技术详情）；
//   2. 真的能恢复 —— 「返回」既清掉错误状态又切到模型页，不是只做个样子。
// 还有一件看不见但必须有的：抛错要落进统一日志（打包应用里白屏只有用户看得到，
// 事后排查全靠这一条记录）。
// ---------------------------------------------------------------------------

const dom = new Window({ url: "http://localhost/" });
const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "location",
  "history",
  "HTMLElement",
  "HTMLDivElement",
  "HTMLButtonElement",
  "Element",
  "Node",
  "Text",
  "DocumentFragment",
  "SVGElement",
  "CustomEvent",
  "Event",
  "MouseEvent",
  "PointerEvent",
  "ResizeObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "getComputedStyle",
] as const;
const savedGlobals = new Map<string, unknown>();
for (const key of DOM_GLOBALS) {
  const value = (dom as unknown as Record<string, unknown>)[key];
  if (value === undefined) continue;
  savedGlobals.set(key, (globalThis as unknown as Record<string, unknown>)[key]);
  (globalThis as unknown as Record<string, unknown>)[key] = value;
}

// 先桩 RPC：`@lib/rpc` 的真实模块在 import 期就 new Electroview（连 WebSocket），
// 而 app-log 也 import 它 —— 顺序反了就会在加载阶段直接炸，跟被测行为无关。
mock.module("@lib/rpc", () => ({
  rpcClient: {
    getSettings: async () => ({ configured: true, settings: { UI_LANG: "zh" } }),
  },
}));

/** 落日志的调用（`reportClientError`），断言抛错必须留下持久记录。 */
const reported: { event: string; message: string }[] = [];
const realAppLog = await import("../lib/app-log");
mock.module("../lib/app-log", () => ({
  ...realAppLog,
  reportClientError: (event: string, error: unknown) => {
    reported.push({ event, message: error instanceof Error ? error.message : String(error) });
  },
}));

const { ErrorBoundary } = await import("./error-boundary");
const { useRouter } = await import("@stores/router");

function Boom({ message = "boom" }: { message?: string }): ReactNode {
  throw new Error(message);
}

/** 挂载一棵树并等 React 把 effect / 微任务跑完。 */
async function mount(node: React.ReactNode) {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(node);
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { container, root };
}

test("子组件抛错：显示错误页与原因，并把异常写进统一日志", async () => {
  reported.length = 0;
  const { container, root } = await mount(
    <ErrorBoundary>
      <Boom message="渲染炸了" />
    </ErrorBoundary>,
  );

  const text = container.textContent ?? "";
  expect(text).toContain("界面出现异常");
  expect(text).toContain("渲染炸了");
  expect(text).toContain("技术详情"); // 堆栈默认折叠，但入口要在
  expect(reported.length).toBe(1);
  expect(reported[0]!.event).toBe("client.render_error");
  expect(reported[0]!.message).toBe("渲染炸了");

  root.unmount();
});

test("「返回模型页」既清掉错误状态又切路由 —— 不是停在错误页", async () => {
  const { container, root } = await mount(
    <ErrorBoundary>
      <Boom />
    </ErrorBoundary>,
  );
  expect(container.textContent).toContain("界面出现异常");

  const back = [...container.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("返回模型页"),
  );
  expect(back).toBeTruthy();
  back!.click();
  await new Promise((resolve) => setTimeout(resolve, 50));

  // 状态清空 → 边界重新渲染 children（这里 children 仍会抛，但路由已经切走）
  expect(useRouter.getState().route).toEqual({ path: "settings", tab: "store" });

  root.unmount();
});

test("正常子树原样渲染，不引入任何包裹痕迹", async () => {
  const { container, root } = await mount(
    <ErrorBoundary>
      <span>一切正常</span>
    </ErrorBoundary>,
  );
  expect(container.textContent).toBe("一切正常");
  expect(container.textContent).not.toContain("界面出现异常");
  root.unmount();
});

afterAll(async () => {
  // React 的调度器读的是 globals 里的 window：先把它排队的活干完再还原全局，
  // 否则那批任务在还原之后执行，炸在 `window.event` 上（报错现场与用例毫无关系）。
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
});
