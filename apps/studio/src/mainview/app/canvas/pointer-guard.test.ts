import { beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

import { eventInsideDom } from "./pointer-guard";

/**
 * 回归：画布手势必须放行 Portal 里的事件。
 *
 * 背景（真实故障）：Radix 下拉的选项渲染到 body，React 事件却沿组件树冒泡到
 * 节点框；节点若把它当成拖拽起点并 setPointerCapture，下拉就再也收不到
 * pointerup，模型选择静默失效。这条测试锁住"目标不在自己的 DOM 里 → 放行"。
 */
beforeAll(() => {
  const dom = new Window({ url: "http://localhost/" });
  for (const key of ["window", "document", "Node", "HTMLElement", "Element"] as const) {
    (globalThis as Record<string, unknown>)[key] = (dom as unknown as Record<string, unknown>)[key];
  }
});

describe("eventInsideDom", () => {
  test("自己的后代 → true（按钮、输入框、面板都算）", () => {
    const node = document.createElement("div");
    const panel = document.createElement("div");
    const textarea = document.createElement("textarea");
    panel.appendChild(textarea);
    node.appendChild(panel);
    expect(eventInsideDom(node, node)).toBe(true);
    expect(eventInsideDom(node, panel)).toBe(true);
    expect(eventInsideDom(node, textarea)).toBe(true);
  });

  test("Portal 里渲染的元素（挂到 body、不在节点 DOM 里）→ false", () => {
    const node = document.createElement("div");
    const portalContent = document.createElement("div");
    // Radix 的 SelectContent 就是这样挂在 body 上的：React 树上是节点的后代，
    // DOM 上不是 —— 手势必须放行，否则会抢走指针让选择失效。
    document.body.appendChild(portalContent);
    const option = document.createElement("div");
    option.setAttribute("role", "option");
    portalContent.appendChild(option);
    expect(eventInsideDom(node, portalContent)).toBe(false);
    expect(eventInsideDom(node, option)).toBe(false);
  });

  test("兄弟节点 / 另一棵子树 → false", () => {
    const node = document.createElement("div");
    const sibling = document.createElement("div");
    document.body.append(node, sibling);
    expect(eventInsideDom(node, sibling)).toBe(false);
  });

  test("非 Node 目标（window / null）→ false，不抛错", () => {
    const node = document.createElement("div");
    expect(eventInsideDom(node, null)).toBe(false);
    expect(eventInsideDom(node, window)).toBe(false);
    expect(eventInsideDom(null, node)).toBe(false);
  });
});
