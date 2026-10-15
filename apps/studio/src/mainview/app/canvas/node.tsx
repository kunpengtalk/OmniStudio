/**
 * 画布节点框：标题栏（拖拽 / 状态）、可编辑标题、右缘输出端口（连线起点）、
 * 右下角拉伸把手、删除按钮；内容区是 NodePanel。
 *
 * 交互：标题栏按住拖动（多选整体动），Shift 点按追加选择，端口按下开始连线
 * （跟随指针的虚线由画布层画），角上拉伸改尺寸。
 * 提示词输入框 / 下拉 / 按钮不吃拖拽 —— target 命中交互元素时直接放行。
 */
import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import { XIcon } from "lucide-react";

import { cn } from "@/mainview/lib/utils";
import { CANVAS_NODE_DEFAULTS, type CanvasNodeData } from "@/shared/canvas";
import { useCanvasStore } from "./canvas-store";
import { NodePanel, nodeKindIcon } from "./node-panel";
import { eventInsideDom } from "./pointer-guard";
import { useT } from "@stores/ui-lang";

type DragSession = {
  startX: number;
  startY: number;
  origins: Map<string, { x: number; y: number }>;
  moved: boolean;
} | null;

type ResizeSession = {
  startX: number;
  startY: number;
  originW: number;
  originH: number;
} | null;

const STATUS_DOT: Record<CanvasNodeData["status"], string> = {
  idle: "bg-muted-foreground/30",
  loading: "bg-blue-500 animate-pulse",
  success: "bg-emerald-500",
  error: "bg-destructive",
};

export function CanvasNodeView({
  node,
  onPortPointerDown,
  scale,
}: {
  node: CanvasNodeData;
  /** 端口按下：画布层接管后续指针事件，画跟随线并落点建连。 */
  onPortPointerDown: (nodeId: string, event: ReactPointerEvent<HTMLDivElement>) => void;
  scale: number;
}) {
  const t = useT();
  const selection = useCanvasStore((s) => s.selection);
  const select = useCanvasStore((s) => s.select);
  const updateNode = useCanvasStore((s) => s.updateNode);
  const updateNodeTransient = useCanvasStore((s) => s.updateNodeTransient);
  const removeNodes = useCanvasStore((s) => s.removeNodes);
  const selected = selection.includes(node.id);
  const dragRef = useRef<DragSession>(null);
  const resizeRef = useRef<ResizeSession>(null);
  const Icon = nodeKindIcon(node.kind);
  const min = CANVAS_NODE_DEFAULTS[node.kind].min;

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target;
    // 下拉/弹层走 Portal 渲染到 body，但 React 事件仍沿**组件树**冒泡到这里；
    // 少这道判断就会把"点选项"当成拖节点并抢走指针，Radix 再也收不到 pointerup
    // ——模型选择静默失效。详见 pointer-guard.ts。
    if (!eventInsideDom(event.currentTarget, target)) return;
    if (target instanceof Element && target.closest("input,textarea,select,button,[data-no-drag]")) return;
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const store = useCanvasStore.getState();
    const nextSelection = store.selection.includes(node.id) ? store.selection : [node.id];
    if (!store.selection.includes(node.id)) select([node.id], event.shiftKey);
    // 一次拖拽手势只记一条历史（移动结束才真正改坐标，undo 回到手势前）
    store.markHistory(true);
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      origins: new Map(
        store.nodes
          .filter((n) => nextSelection.includes(n.id))
          .map((n) => [n.id, { x: n.x, y: n.y }]),
      ),
      moved: false,
    };
  };

  const onDragMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const session = dragRef.current;
    if (!session) return;
    const dx = (event.clientX - session.startX) / scale;
    const dy = (event.clientY - session.startY) / scale;
    if (!session.moved && Math.abs(dx) < 2 / scale && Math.abs(dy) < 2 / scale) return;
    session.moved = true;
    const store = useCanvasStore.getState();
    for (const [id, origin] of session.origins) {
      const patch = { x: Math.round(origin.x + dx), y: Math.round(origin.y + dy) };
      store.updateNodeTransient(id, patch);
    }
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (!eventInsideDom(event.currentTarget, event.target)) return;
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    useCanvasStore.getState().markHistory(true);
    resizeRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originW: node.width,
      originH: node.height,
    };
  };

  const onResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const session = resizeRef.current;
    if (!session) return;
    updateNodeTransient(node.id, {
      width: Math.max(min.width, Math.round(session.originW + (event.clientX - session.startX) / scale)),
      height: Math.max(min.height, Math.round(session.originH + (event.clientY - session.startY) / scale)),
    });
  };

  const endResize = () => {
    resizeRef.current = null;
  };

  return (
    <div
      data-node-id={node.id}
      className={cn(
        "absolute flex flex-col overflow-hidden rounded-xl border bg-background shadow-sm transition-shadow",
        selected ? "border-primary ring-1 ring-primary/50 shadow-md" : "border-border hover:shadow-md",
      )}
      style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
      onPointerDown={startDrag}
      onPointerMove={onDragMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div className="flex h-8 shrink-0 cursor-grab items-center gap-1.5 border-b bg-muted/40 px-2 active:cursor-grabbing">
        <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[node.status])} />
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          value={node.title}
          onChange={(e) => updateNode(node.id, { title: e.target.value })}
          className="min-w-0 flex-1 truncate bg-transparent text-xs font-medium outline-none"
          data-no-drag
        />
        <button
          type="button"
          aria-label={t("canvas.delete")}
          className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 hover:opacity-100 focus:opacity-100"
          data-no-drag
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => removeNodes([node.id])}
        >
          <XIcon className="size-3.5" />
        </button>
      </div>

      <NodePanel node={node} />

      {/* 输出端口：从这里按住拖到目标节点建立连线（上游 → 下游） */}
      <div
        data-port={node.id}
        title=""
        className="absolute -right-1.5 top-1/2 z-10 size-3 -translate-y-1/2 cursor-crosshair rounded-full border-2 border-background bg-muted-foreground/60 transition-colors hover:bg-primary"
        onPointerDown={(event) => {
          event.stopPropagation();
          onPortPointerDown(node.id, event);
        }}
      />

      {/* 拉伸把手 */}
      <div
        className="absolute bottom-0 right-0 z-10 size-3 cursor-nwse-resize"
        onPointerDown={startResize}
        onPointerMove={onResizeMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
      />
    </div>
  );
}
