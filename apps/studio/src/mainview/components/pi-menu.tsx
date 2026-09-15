import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "@lib/utils";

/**
 * 工作台样式的菜单项。
 *
 * `danger` 只影响配色（删除这类破坏性动作），禁用项照常显示 —— 菜单里留一个灰掉的
 * 「重新生成」比整条不出现更清楚：用户看得到"这里本来能做什么"。
 */
export type PiMenuItem =
  | {
      type: "item";
      key: string;
      label: string;
      icon?: ReactNode;
      onSelect: () => void;
      disabled?: boolean;
      danger?: boolean;
    }
  | { type: "separator"; key: string };

/** 距视口边缘留白：贴着边也不让菜单被裁掉。 */
const MARGIN = 8;

/** 一条「对消息做什么」：操作条与右键菜单共用的最小形状。 */
export type MessageActionItem = {
  key: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** 破坏性动作（删除）：菜单里 hover 才变红。 */
  danger?: boolean;
};

/** 动作清单 → 菜单项；破坏性动作前自动隔一道，免得和上面的动作混在一起。 */
export function actionMenuItems(actions: MessageActionItem[]): PiMenuItem[] {
  const items: PiMenuItem[] = [];
  for (const action of actions) {
    if (action.danger && items.length > 0) items.push({ type: "separator", key: "sep" });
    items.push({
      type: "item",
      key: action.key,
      label: action.label,
      icon: action.icon,
      onSelect: action.onSelect,
      disabled: action.disabled,
      danger: action.danger,
    });
  }
  return items;
}

/**
 * 右键菜单（`.pi-menu`）。
 *
 * 与 `pi-tip` 同一个来路：浮层必须 portal 到 body，否则会被消息流 / 侧栏的 overflow
 * 裁掉；portal 之后脱离了 `.pi-agent` 子树，所以要补一层 `.pi-scope` 才拿得到
 * `--ds-*` token（见 `styles/agent-pi.css` 顶部关于 `.pi-scope` 的说明）。
 *
 * 用法是 hook 而不是包装组件：消息行本身就是 flex 子项，外面再包一层 div 会改变
 * 布局（宽度、gap 全变）。hook 只交出 `onContextMenu` 和要挂的节点。
 */
export function usePiContextMenu(items: PiMenuItem[]) {
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const hasItems = items.length > 0;

  const close = useCallback(() => {
    setPoint(null);
    setSize(null);
  }, []);

  const onContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      if (!hasItems) return;
      // 拦掉 WebKit 自己的「重新载入 / 检查元素」，否则两个菜单会叠在一起。
      event.preventDefault();
      event.stopPropagation();
      setSize(null);
      setPoint({ x: event.clientX, y: event.clientY });
    },
    [hasItems],
  );

  // 尺寸量出来才能把贴边的菜单翻到指针另一侧：点最右边那条消息时，
  // 菜单默认向右下展开会有一半在屏幕外。
  useLayoutEffect(() => {
    if (!point || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    setSize((prev) =>
      prev && prev.w === rect.width && prev.h === rect.height
        ? prev
        : { w: rect.width, h: rect.height },
    );
  }, [point]);

  useEffect(() => {
    if (!point) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onPointerDown = (event: PointerEvent) => {
      // 点在菜单自己身上是选项点击（click 随后才到），其余任何位置都算关掉。
      if (menuRef.current && event.target instanceof Node && menuRef.current.contains(event.target)) {
        return;
      }
      close();
    };
    // 滚动 / 缩放之后原来的坐标就不对了：直接收起，而不是让菜单飘在原地。
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [point, close]);

  const flipX =
    point && size ? point.x + size.w + MARGIN > window.innerWidth : false;
  const flipY =
    point && size ? point.y + size.h + MARGIN > window.innerHeight : false;
  const left = point ? (flipX ? Math.max(MARGIN, point.x - size!.w) : point.x) : 0;
  const top = point ? (flipY ? Math.max(MARGIN, point.y - size!.h) : point.y) : 0;

  const node =
    point && hasItems
      ? createPortal(
          <span className="pi-scope">
            <div
              ref={menuRef}
              role="menu"
              data-slot="pi-context-menu"
              // z-index 在类里是 40（相对工作台内部定位的菜单够用），右键菜单是
              // 贴着鼠标的浮层，要压过输入区那一层，所以这里给得更高。
              style={{ position: "fixed", left, top, zIndex: 60 }}
              className={cn("pi-menu")}
            >
              {items.map((item) =>
                item.type === "separator" ? (
                  <div key={item.key} className="pi-menu-sep" role="separator" />
                ) : (
                  <button
                    key={item.key}
                    type="button"
                    role="menuitem"
                    className={cn("pi-menu-item", item.danger && "danger")}
                    disabled={item.disabled}
                    onClick={() => {
                      close();
                      item.onSelect();
                    }}
                  >
                    {item.icon}
                    <span className="pi-menu-item-label">{item.label}</span>
                  </button>
                ),
              )}
            </div>
          </span>,
          document.body,
        )
      : null;

  return { onContextMenu, node, close };
}
