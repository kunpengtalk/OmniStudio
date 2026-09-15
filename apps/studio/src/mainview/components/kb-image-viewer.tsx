import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon, FileIcon, ImageIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { cn } from "@lib/utils";
import { Button } from "@ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@ui/dialog";
import { Spinner } from "@ui/spinner";
import { useT } from "@stores/ui-lang";

/** 缩放档位范围：滚轮 / 单击切档 / 复位共用同一 clamp。 */
const MIN_SCALE = 0.5;
const MAX_SCALE = 4;

/**
 * 单击切档的延迟窗（ms）：浏览器对双击派发 click → click → dblclick 三连事件，
 * 单击若立即执行 1x↔2x 切换，双击复空前会先闪一下放大态。延迟 250ms 等第二下
 * 落进来，onDoubleClick 再取消挂起的单击即可消除闪烁。
 */
const CLICK_DELAY_MS = 250;

/** 视图变换：transform = translate(x, y) scale(scale)，origin 固定 0 0（光标锚定靠平移补偿，见 zoomAt）。 */
type View = { scale: number; x: number; y: number };

const REST_VIEW: View = { scale: 1, x: 0, y: 0 };

function clampScale(v: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, v));
}

/**
 * 共享图片查看器：知识库图片分块的大图预览（full 档 2048px）。
 *
 * 交互：滚轮以光标为锚点缩放（0.5–4）、单击 1x↔2x 切档、双击复位、放大后拖拽平移。
 * 降级：取图失败 / dataUrl 为空（文件缺失、音视频等）回退「图标 + 文件名」；
 * 底部信息条展示文件名、OCR 文本（若有）和「用系统程序打开」入口（openPath）。
 */
export function KbImageViewer({
  chunkId,
  open,
  onClose,
}: {
  chunkId: number | null;
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const mediaQuery = useQuery({
    // full 档大图基本不变（媒体文件不会被就地改写，重建时 chunk id 会换），缓存拉长。
    queryKey: ["kb-chunk-media-full", chunkId],
    queryFn: () => rpcClient.kbChunkMedia({ chunkId: chunkId!, size: "full" }),
    enabled: open && chunkId != null,
    staleTime: 10 * 60_000,
    gcTime: 5 * 60_000,
  });
  const media = mediaQuery.data;

  const [view, setView] = useState<View>(REST_VIEW);
  /** 滚轮 handler 是原生监听（不随 React 重渲染重建），靠镜像 ref 读最新变换。 */
  const viewRef = useRef(view);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  /** 拖拽中的手势状态；moved 跨过 pointerup 供 onClick 判定「这次 click 是拖拽尾声」。 */
  const gestureRef = useRef({
    dragging: false,
    moved: false,
    startX: 0,
    startY: 0,
    baseX: 0,
    baseY: 0,
  });
  /** 挂起中的单击切档定时器（双击 / 关闭 / 换图时取消）。 */
  const pendingClickRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyView = useCallback((next: View) => {
    viewRef.current = next;
    setView(next);
  }, []);

  /** 清掉挂起的单击并复位变换（关闭 / 换 chunkId / 双击共用）。 */
  const resetGesture = useCallback(() => {
    if (pendingClickRef.current != null) {
      clearTimeout(pendingClickRef.current);
      pendingClickRef.current = null;
    }
    gestureRef.current.dragging = false;
    applyView(REST_VIEW);
  }, [applyView]);

  // 关闭或换图时复位：否则下张图会带着上一张的缩放/平移打开。
  useEffect(() => {
    if (!open) resetGesture();
  }, [open, chunkId, resetGesture]);

  // 组件卸载兜底：挂起的定时器不能再触发 applyView。
  useEffect(() => {
    return () => {
      if (pendingClickRef.current != null) clearTimeout(pendingClickRef.current);
    };
  }, []);

  const hasImage = media?.dataUrl != null;

  /**
   * 滚轮缩放。为什么必须原生 addEventListener：React 17+ 在根节点上对 wheel
   * 统一挂的是 passive 监听，JSX onWheel 里的 preventDefault() 会被浏览器忽略
   * （控制台还会警告），弹窗底下页面跟着滚。原生监听 + { passive: false } 才能
   * 真正吃掉默认滚动。
   */
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !open || !hasImage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      // 光标在容器内的位置 = 要钉住的内容点 p
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const cur = viewRef.current;
      const nextScale = clampScale(cur.scale * Math.exp(-e.deltaY * 0.0015));
      // origin 0 0 下内容点 p 渲染在 t + p·s；要它缩放后仍在原位：t' = t + p·(s − s')
      applyView({
        scale: nextScale,
        x: cur.x + px * (cur.scale - nextScale),
        y: cur.y + py * (cur.scale - nextScale),
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [open, hasImage, applyView]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (viewRef.current.scale <= 1) return;
    // 不冒泡进 Radix Dialog：Dialog 对外的指针交互（如 overlay 关闭判定）不该被放大态的拖拽误触。
    e.stopPropagation();
    gestureRef.current = {
      dragging: true,
      moved: false,
      startX: e.clientX,
      startY: e.clientY,
      baseX: viewRef.current.x,
      baseY: viewRef.current.y,
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g.dragging) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    // 位移超过阈值才算「拖过」：把 pointerup 后紧跟的 click 与纯单击区分开。
    if (Math.abs(dx) + Math.abs(dy) > 3) g.moved = true;
    applyView({ scale: viewRef.current.scale, x: g.baseX + dx, y: g.baseY + dy });
  };

  const endDrag = () => {
    gestureRef.current.dragging = false;
  };

  const onClick = () => {
    // 拖拽结束的 click 不切档，否则松手瞬间会莫名放大/复位。
    if (gestureRef.current.moved) {
      gestureRef.current.moved = false;
      return;
    }
    // 已有挂起的单击说明第二下已落（双击前奏），不再重复排程，等 onDoubleClick 取消。
    if (pendingClickRef.current != null) return;
    pendingClickRef.current = setTimeout(() => {
      pendingClickRef.current = null;
      const el = viewportRef.current;
      if (!el) return;
      const cur = viewRef.current;
      if (cur.scale > 1) {
        applyView(REST_VIEW);
        return;
      }
      // 切到 2x：以容器中心为锚（p = 中心），复用 t' = t + p·(s − s')
      const rect = el.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      applyView({
        scale: 2,
        x: cur.x + cx * (cur.scale - 2),
        y: cur.y + cy * (cur.scale - 2),
      });
    }, CLICK_DELAY_MS);
  };

  const onDoubleClick = () => {
    // 取消挂起的单击再复位：这是「双击不复位前先跳 2x」闪烁的另一半解法。
    resetGesture();
  };

  // 降级判式：只在「请求已落定但拿不到图」时算失败。首载 pending 期间 data 还是
  // undefined，直接套 data?.dataUrl == null 会把加载态误判成失败而闪兜底 UI。
  const failed =
    mediaQuery.isError || (mediaQuery.isSuccess && mediaQuery.data?.dataUrl == null);
  const name = media?.fileName ?? "";

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex max-h-[85vh] max-w-4xl flex-col gap-3">
        <DialogHeader>
          <DialogTitle className="truncate pr-6">{t("kb.viewer.title")}</DialogTitle>
          <DialogDescription>{t("kb.viewer.zoomHint")}</DialogDescription>
        </DialogHeader>
        {chunkId == null ? null : (
          <div
            ref={viewportRef}
            className={cn(
              "relative flex h-[60vh] min-h-64 select-none items-center justify-center overflow-hidden rounded-lg border bg-muted/40",
              view.scale > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in",
            )}
            // touch-none：pointermove 平移期间不让浏览器接管触摸手势，否则拖拽会被滚动打断。
            style={{ touchAction: "none" }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onPointerLeave={endDrag}
            onClick={onClick}
            onDoubleClick={onDoubleClick}
          >
            {failed ? (
              // 兜底视觉对齐 docs-tab MediaChunkBlock：图标 + 文件名居中。
              <div className="flex flex-col items-center gap-2 text-muted-foreground">
                {mediaQuery.isError ? <FileIcon className="size-8" /> : <ImageIcon className="size-8" />}
                <span className="max-w-64 truncate text-xs">{name}</span>
              </div>
            ) : media?.dataUrl ? (
              <img
                src={media.dataUrl}
                alt={name}
                // draggable=false：原生图片拖拽会和指针平移抢事件。
                draggable={false}
                className="max-h-full max-w-full object-contain"
                style={{
                  transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
                  // 拖拽要跟手，其余操作（滚轮/切档/复位）保留过渡动画。
                  transition: gestureRef.current.dragging ? "none" : "transform 150ms ease-out",
                }}
              />
            ) : (
              <Spinner className="size-6 text-muted-foreground" />
            )}
          </div>
        )}
        <div className="flex flex-col gap-2 border-t pt-3">
          {media?.text ? (
            // OCR 文本只在非空时渲染：空串会顶出一个空白滚动区。
            <p className="max-h-24 overflow-y-auto text-xs whitespace-pre-wrap text-muted-foreground">
              {media.text}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
              {name}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={media?.mediaPath == null}
              onClick={() => {
                if (media?.mediaPath) void rpcClient.openPath({ path: media.mediaPath });
              }}
            >
              <ExternalLinkIcon />
              {t("kb.viewer.openExternal")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
