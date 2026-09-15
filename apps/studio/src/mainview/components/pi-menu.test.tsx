import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * 右键菜单（pi-menu）的回归测试。
 *
 * 三件事必须成立，否则消息上挂的右键菜单就是摆设或残留物：
 *   1. 右键弹得出、点选项能执行并收起；
 *   2. Esc 与点菜单外面能收起（菜单 portal 在 body 上，不会随消息重渲染消失）；
 *   3. 贴着视口右边/下边时翻到指针另一侧 —— 否则点最右边那条消息，菜单有一半在屏幕外。
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

afterAll(() => {
  for (const [key, value] of savedGlobals) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { usePiContextMenu, actionMenuItems } = await import("./pi-menu");

const MENU_WIDTH = 72;
const MENU_HEIGHT = 96;

async function render(actions: { label: string; disabled?: boolean; danger?: boolean }[]) {
  const calls: string[] = [];
  // 走真实路径（actionMenuItems 才是插入分隔符、翻译 danger 的那一层）
  const items = actionMenuItems(
    actions.map((a) => ({
      key: a.label,
      label: a.label,
      onSelect: () => calls.push(a.label),
      disabled: a.disabled,
      danger: a.danger,
    })),
  );

  function Host() {
    const menu = usePiContextMenu(items);
    return createElement(
      "div",
      { onContextMenu: menu.onContextMenu, "data-testid": "host" },
      "消息正文",
      menu.node,
    );
  }

  // 上一条用例断言失败会跳过 unmount，弹框（portal）留在 body 里会污染下一条
  for (const el of Array.from(document.body.children)) el.remove();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(Host, null));
  });

  return {
    calls,
    container,
    menu(): HTMLElement | null {
      return document.body.querySelector<HTMLElement>('[role="menu"]');
    },
    async openAt(x: number, y: number) {
      const host = container.querySelector<HTMLElement>('[data-testid="host"]')!;
      await act(async () => {
        host.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: x, clientY: y }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** happy-dom 不做布局，尺寸要自己喂：菜单的翻转分支靠它才有意义。 */
function stubMenuSize() {
  const proto = dom.window.Element.prototype as unknown as {
    getBoundingClientRect: () => DOMRect;
  };
  const original = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: Element) {
    if (this.getAttribute("role") === "menu") {
      return {
        width: MENU_WIDTH,
        height: MENU_HEIGHT,
        top: 0,
        left: 0,
        right: MENU_WIDTH,
        bottom: MENU_HEIGHT,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    }
    return original.call(this);
  };
  return () => {
    proto.getBoundingClientRect = original;
  };
}

test("右键弹出菜单：列出动作，点一项执行并收起", async () => {
  const restore = stubMenuSize();
  const view = await render([{ label: "复制" }, { label: "删除这条消息", danger: true }]);
  try {
    expect(view.menu()).toBeNull();
    await view.openAt(40, 40);

    const menu = view.menu()!;
    expect(menu).not.toBeNull();
    // portal 到 body 才不会被消息流的 overflow 裁掉；外面那层 .pi-scope 是 --ds-* token 的来源
    expect(view.container.contains(menu)).toBe(false);
    expect(menu.closest(".pi-scope")).not.toBeNull();
    expect(menu.classList.contains("pi-menu")).toBe(true);
    // 破坏性动作前面隔一道
    expect(menu.querySelectorAll('[role="separator"]').length).toBe(1);

    const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')];
    expect(buttons.map((b) => b.textContent)).toEqual(["复制", "删除这条消息"]);
    expect(buttons[1]!.className).toContain("danger");

    await act(async () => {
      buttons[0]!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(view.calls).toEqual(["复制"]);
    expect(view.menu()).toBeNull();

    await view.unmount();
  } finally {
    restore();
  }
});

test("禁用的动作照常列出但点不动", async () => {
  const restore = stubMenuSize();
  const view = await render([{ label: "重新生成", disabled: true }]);
  try {
    await view.openAt(40, 40);
    const button = view.menu()!.querySelector<HTMLButtonElement>('button[role="menuitem"]')!;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("重新生成");
    await act(async () => {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(view.calls).toEqual([]);
    // 点禁用项不算"点了外面"：菜单还开着，用户能看到它为什么不能点
    expect(view.menu()).not.toBeNull();
    await view.unmount();
  } finally {
    restore();
  }
});

test("Esc 与点菜单外面都会收起", async () => {
  const restore = stubMenuSize();
  const view = await render([{ label: "复制" }]);
  try {
    await view.openAt(40, 40);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(view.menu()).toBeNull();

    await view.openAt(40, 40);
    expect(view.menu()).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(view.menu()).toBeNull();

    await view.unmount();
  } finally {
    restore();
  }
});

test("贴到视口右下角时翻到指针另一侧", async () => {
  const restore = stubMenuSize();
  const view = await render([{ label: "复制" }]);
  try {
    const edgeX = window.innerWidth - 4;
    const edgeY = window.innerHeight - 4;
    await view.openAt(edgeX, edgeY);

    const menu = view.menu()!;
    // 默认向右下展开会有一半在屏幕外：这里必须变成"出现在指针左侧 / 上方"
    expect(menu.style.left).toBe(`${edgeX - MENU_WIDTH}px`);
    expect(menu.style.top).toBe(`${edgeY - MENU_HEIGHT}px`);
    await view.unmount();
  } finally {
    restore();
  }
});

test("没有动作时不接管右键（不拦 WebKit 自己的菜单）", async () => {
  const view = await render([]);
  try {
    await view.openAt(40, 40);
    expect(view.menu()).toBeNull();
    await view.unmount();
  } finally {
    // 没有菜单也就没有 portal 残留
  }
});
