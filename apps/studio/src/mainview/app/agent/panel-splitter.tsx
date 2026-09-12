import { useRef, useState } from "react";

import { cn } from "@/mainview/lib/utils";
import { PANEL_DEFAULT_WIDTH, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH } from "@stores/agent";

/** 正文最少留出的宽度：面板拖得再宽也要能看见对话。 */
const MIN_CONVERSATION_WIDTH = 420;

/**
 * 面板分隔条：拖动改右侧面板宽度（往左拖 = 面板变宽），双击回到默认宽度。
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
    // 分隔条的父元素就是「对话 + 面板」这一行：用它算面板最多能占多宽。
    const containerWidth = event.currentTarget.parentElement?.clientWidth ?? 0;
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
      onPointerDown={onPointerDown}
      onDoubleClick={() => onWidth(PANEL_DEFAULT_WIDTH)}
      className={cn(
        "group relative z-20 w-px shrink-0 cursor-col-resize bg-border transition-colors",
        dragging ? "bg-primary" : "hover:bg-primary/60",
      )}
    >
      {/* 加宽的命中区：1px 的线太细，拖不住 */}
      <div className="absolute inset-y-0 -right-1.5 -left-1.5" />
      <div
        className={cn(
          "pointer-events-none absolute top-1/2 left-1/2 h-10 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-border transition-opacity",
          dragging ? "bg-primary opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
      />
    </div>
  );
}
