import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * 轻量提示气泡。
 *
 * 没用应用里那套 Radix Tooltip：工作台几乎每个按钮都挂着提示，而这里要的是
 * 「立刻出现、不参与焦点顺序、不被父级 overflow 裁掉」。气泡 portal 到 body
 * 之后脱离了 `.pi-agent` 子树，所以要补一层 `.pi-scope` 才拿得到 --ds-* token。
 */
export function PiTip({
  label,
  children,
  side = "top",
  className,
}: {
  label?: string | null;
  children: ReactNode;
  side?: "top" | "bottom";
  className?: string;
}) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);

  const show = useCallback(() => {
    const el = hostRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPoint({
      x: rect.left + rect.width / 2,
      y: side === "top" ? rect.top - 6 : rect.bottom + 6,
    });
  }, [side]);

  // 容器滚动 / 窗口尺寸变化后原来的坐标就不对了：直接收起，等下一次 hover。
  useEffect(() => {
    if (!point) return;
    const hide = () => setPoint(null);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [point]);

  const tip = label ? label : null;

  return (
    <span
      ref={hostRef}
      className={className ? `pi-tip-host ${className}` : "pi-tip-host"}
      onMouseEnter={tip ? show : undefined}
      onMouseLeave={tip ? () => setPoint(null) : undefined}
      onFocusCapture={tip ? show : undefined}
      onBlurCapture={tip ? () => setPoint(null) : undefined}
    >
      {children}
      {tip && point
        ? createPortal(
            <span className="pi-scope">
              <span className="pi-tip" data-side={side} style={{ left: point.x, top: point.y }}>
                {tip}
              </span>
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
