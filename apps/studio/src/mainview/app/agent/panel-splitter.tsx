import { useRef, useState } from "react";

import { PANEL_DEFAULT_WIDTH, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH } from "@stores/agent";

/** 正文最少留出的宽度：面板拖得再宽也要能看见对话。 */
const MIN_CONVERSATION_WIDTH = 420;

/**
 * 面板分隔条：拖动改右侧面板宽度（往左拖 = 面板变宽），双击回到默认宽度。
 *
 * 拖拽期间在 window 上监听指针事件 —— 面板里是 iframe（HTML 预览）时，
 * 指针滑到 iframe 上，元素自身的 pointermove 会收不到。
 */
export function PanelSplitter({ width, onWidth }: { width: number; onWidth: (width: number) => void }) {
  const [dragging, setDragging] = useState(false);
  const startX = useRef(0);
  const startWidth = useRef(width);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    startX.current = event.clientX;
    startWidth.current = width;
    setDragging(true);
    // 分隔条的父元素就是面板自己：用它左侧的可用空间算面板最多能占多宽。
    const host = event.currentTarget.parentElement;
    const containerWidth = host?.parentElement?.clientWidth ?? 0;
    const maxWidth =
      containerWidth > 0
        ? Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, containerWidth - MIN_CONVERSATION_WIDTH))
        : PANEL_MAX_WIDTH;
    const clamp = (next: number) => Math.min(Math.max(next, PANEL_MIN_WIDTH), maxWidth);

    const move = (e: PointerEvent) => {
      // 分隔条在面板左侧：指针往左（clientX 变小）→ 面板变宽。
      onWidth(clamp(startWidth.current + (startX.current - e.clientX)));
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="调整右侧面板宽度"
      data-resizing={dragging ? "true" : "false"}
      onPointerDown={onPointerDown}
      onDoubleClick={() => onWidth(PANEL_DEFAULT_WIDTH)}
      className="wp-resize"
    />
  );
}
