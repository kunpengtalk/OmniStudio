/**
 * 无限画布主屏。
 *
 * 表面布局：顶部一条工具栏收齐全部界面元素 —— 左：画布标题；中：添加 /
 * 选择 / 框选 / 撤销 / 重做；右：素材库 / 快捷键 / 缩放。其余空间全留给画布。
 * - 滚轮在光标处缩放（触板双指平移、Ctrl+滚轮强制缩放、范围 0.1–2）；
 * - 背景拖拽按当前工具平移或框选，双击空白打开创建菜单（常驻搜索与导入资源）；
 * - 节点右上角端口拖出连线，连线把上游变成下游生成的上下文。
 *
 * 文档加载与防抖保存在这里做：store 是唯一作者，rev 变更后 800ms 落库。
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  BoxSelectIcon,
  KeyboardIcon,
  MaximizeIcon,
  MousePointer2Icon,
  PlusIcon,
  Redo2Icon,
  Trash2Icon,
  Undo2Icon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";

import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { cn } from "@/mainview/lib/utils";
import {
  CANVAS_DEFAULT_VIEWPORT,
  CANVAS_SCALE_MAX,
  CANVAS_SCALE_MIN,
  type CanvasNodeKind,
} from "@/shared/canvas";
import { rpcClient } from "@lib/rpc";
import { useT } from "@stores/ui-lang";
import { useCanvasStore } from "./canvas-store";
import { CanvasCreateMenu } from "./create-menu";
import { LibraryModal, LibraryButton } from "./library-modal";
import { CanvasEmptyHint } from "./node-panel";
import { CanvasNodeView } from "./node";
import { eventInsideDom } from "./pointer-guard";

const clampScale = (k: number) => Math.min(Math.max(k, CANVAS_SCALE_MIN), CANVAS_SCALE_MAX);

type CreateMenuState = { screenX: number; screenY: number; worldX: number; worldY: number } | null;

type ConnectSession = { fromId: string; cursor: { x: number; y: number } } | null;

type CanvasTool = "pan" | "box";

type DragMode =
  | { type: "pan"; startX: number; startY: number; originX: number; originY: number }
  | { type: "box"; startX: number; startY: number; curX: number; curY: number; additive: boolean }
  | null;

export function CanvasScreen() {
  const t = useT();
  const queryClient = useQueryClient();
  const containerRef = useRef<HTMLDivElement>(null);
  const nodes = useCanvasStore((s) => s.nodes);
  const connections = useCanvasStore((s) => s.connections);
  const viewport = useCanvasStore((s) => s.viewport);
  const selectedConnectionId = useCanvasStore((s) => s.selectedConnectionId);
  const title = useCanvasStore((s) => s.title);
  const rev = useCanvasStore((s) => s.rev);
  const docId = useCanvasStore((s) => s.docId);
  const loading = useCanvasStore((s) => s.loading);
  const canUndo = useCanvasStore((s) => s.canUndo);
  const canRedo = useCanvasStore((s) => s.canRedo);
  const selection = useCanvasStore((s) => s.selection);

  const [tool, setTool] = useState<CanvasTool>("pan");
  const [menu, setMenu] = useState<CreateMenuState>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [connecting, setConnecting] = useState<ConnectSession>(null);
  const [drag, setDrag] = useState<DragMode>(null);
  const dragRef = useRef<DragMode>(null);
  const toolRef = useRef<CanvasTool>(tool);
  const spaceRef = useRef(false);
  const [spacePressed, setSpacePressed] = useState(false);
  const connectingRef = useRef<ConnectSession>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  toolRef.current = tool;

  // ---- 文档加载：无活动文档时取最近一份，一份都没有就建一份 -----------------
  const docs = useQuery({ queryKey: ["canvas-docs"], queryFn: () => rpcClient.canvasListDocs(undefined) });
  useEffect(() => {
    if (docId !== null || loading) return;
    const list = docs.data?.docs;
    if (!list) return;
    useCanvasStore.getState().setLoading(true);
    if (list.length === 0) {
      void rpcClient.canvasCreateDoc({ title: t("canvas.untitled") }).then((r) => {
        void queryClient.invalidateQueries({ queryKey: ["canvas-docs"] });
        useCanvasStore.getState().setDoc({ id: r.doc.id, title: r.doc.title, payload: { nodes: [], connections: [], viewport: CANVAS_DEFAULT_VIEWPORT } });
      });
      return;
    }
    void rpcClient.canvasGetDoc({ id: list[0]!.id }).then((r) => {
      if (r.doc) useCanvasStore.getState().setDoc(r.doc);
      else useCanvasStore.getState().setLoading(false);
    });
  }, [docs.data, docId, loading, t, queryClient]);

  // ---- 防抖保存：rev 变更后 800ms 整份落库（顺带刷新侧栏的节点计数） ---------
  useEffect(() => {
    if (docId === null || rev === 0) return;
    const timer = setTimeout(() => {
      const s = useCanvasStore.getState();
      void rpcClient.canvasSaveDoc({
        id: s.docId!,
        title: s.title,
        nodes: s.nodes,
        connections: s.connections,
        viewport: s.viewport,
      }).then(() => {
        void queryClient.invalidateQueries({ queryKey: ["canvas-docs"] });
      });
    }, 800);
    return () => clearTimeout(timer);
  }, [rev, docId, title, queryClient]);

  // ---- 视口工具 --------------------------------------------------------------
  const screenToWorld = useCallback(
    (clientX: number, clientY: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      const vp = useCanvasStore.getState().viewport;
      const mx = clientX - (rect?.left ?? 0);
      const my = clientY - (rect?.top ?? 0);
      return { x: (mx - vp.x) / vp.k, y: (my - vp.y) / vp.k };
    },
    [],
  );

  const zoomAt = useCallback((clientX: number, clientY: number, factor: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    const vp = useCanvasStore.getState().viewport;
    const mx = clientX - (rect?.left ?? 0);
    const my = clientY - (rect?.top ?? 0);
    const k2 = clampScale(vp.k * factor);
    useCanvasStore.getState().setViewport({
      x: mx - ((mx - vp.x) / vp.k) * k2,
      y: my - ((my - vp.y) / vp.k) * k2,
      k: k2,
    });
  }, []);

  const zoomCenter = useCallback(
    (factor: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      zoomAt((rect?.left ?? 0) + (rect?.width ?? 0) / 2, (rect?.top ?? 0) + (rect?.height ?? 0) / 2, factor);
    },
    [zoomAt],
  );

  const fitView = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const s = useCanvasStore.getState();
    if (s.nodes.length === 0) {
      s.setViewport(CANVAS_DEFAULT_VIEWPORT);
      return;
    }
    const minX = Math.min(...s.nodes.map((n) => n.x));
    const minY = Math.min(...s.nodes.map((n) => n.y));
    const maxX = Math.max(...s.nodes.map((n) => n.x + n.width));
    const maxY = Math.max(...s.nodes.map((n) => n.y + n.height));
    const pad = 80;
    const k = clampScale(Math.min((rect.width - pad * 2) / (maxX - minX), (rect.height - pad * 2) / (maxY - minY), 1.5));
    s.setViewport({
      x: (rect.width - (maxX - minX) * k) / 2 - minX * k,
      y: (rect.height - (maxY - minY) * k) / 2 - minY * k,
      k,
    });
  }, []);

  /** 在视口中心附近建节点（工具坞 / 菜单走不到具体位置时用）。 */
  const viewportCenterWorld = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    const vp = useCanvasStore.getState().viewport;
    if (!rect) return { x: -vp.x / vp.k, y: -vp.y / vp.k };
    return {
      x: (rect.width / 2 - vp.x) / vp.k - 180,
      y: (rect.height / 2 - vp.y) / vp.k - 140,
    };
  }, []);

  // ---- 滚轮：鼠标滚轮 / Ctrl 缩放，触板平移 ---------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (event: WheelEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-canvas-no-zoom],[data-radix-popper-content-wrapper]")) return;
      event.preventDefault();
      const isPinch = event.ctrlKey || event.metaKey;
      const deltaY = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      const deltaX = event.deltaMode === 1 ? event.deltaX * 16 : event.deltaX;
      const looksLikeMouseWheel = event.deltaMode !== 0 || Math.abs(deltaY) >= 80;
      const vp = useCanvasStore.getState().viewport;
      if (!isPinch && !looksLikeMouseWheel) {
        // 触板双指滚动 = 平移
        useCanvasStore.getState().setViewport({ x: vp.x - deltaX, y: vp.y - deltaY, k: vp.k });
        return;
      }
      // zoomAt 内部自己换算容器相对坐标，传原始 client 坐标即可。
      zoomAt(event.clientX, event.clientY, Math.pow(1.1, -deltaY / 72));
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // ---- 快捷键：空格平移 / 删除 / 撤销重做 / Esc -------------------------------
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        const el = event.target instanceof Element ? event.target : null;
        if (el?.closest("input,textarea,select,[contenteditable='true']")) return;
        spaceRef.current = true;
        setSpacePressed(true);
        return;
      }
      if (event.key === "Escape") {
        setMenu(null);
        setShortcutsOpen(false);
        useCanvasStore.getState().select([]);
        useCanvasStore.getState().selectConnection(null);
        return;
      }
      const inEditable = event.target instanceof Element && Boolean(event.target.closest("input,textarea,select,[contenteditable='true']"));
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z" && !inEditable) {
        event.preventDefault();
        if (event.shiftKey) useCanvasStore.getState().redo();
        else useCanvasStore.getState().undo();
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && !event.metaKey && !event.ctrlKey && !inEditable) {
        const s = useCanvasStore.getState();
        if (s.selectedConnectionId) {
          s.removeConnection(s.selectedConnectionId);
        } else if (s.selection.length > 0) {
          s.removeNodes(s.selection);
        }
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      spaceRef.current = false;
      setSpacePressed(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  // ---- 连线：端口按下后跟随指针，松开落到目标节点 ----------------------------
  const onPortPointerDown = useCallback(
    (nodeId: string, event: ReactPointerEvent<HTMLDivElement>) => {
      const world = screenToWorld(event.clientX, event.clientY);
      const session = { fromId: nodeId, cursor: world };
      connectingRef.current = session;
      setConnecting(session);
    },
    [screenToWorld],
  );

  useEffect(() => {
    if (!connecting) return;
    const onMove = (event: PointerEvent) => {
      const world = screenToWorld(event.clientX, event.clientY);
      const session = { fromId: connectingRef.current!.fromId, cursor: world };
      connectingRef.current = session;
      setConnecting(session);
    };
    const onUp = (event: PointerEvent) => {
      const fromId = connectingRef.current?.fromId;
      connectingRef.current = null;
      setConnecting(null);
      if (!fromId) return;
      const el = document.elementFromPoint(event.clientX, event.clientY);
      const target = el?.closest("[data-node-id]")?.getAttribute("data-node-id");
      if (target && target !== fromId) {
        useCanvasStore.getState().addConnection(fromId, target);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [connecting, screenToWorld]);

  // ---- 背景指针：平移 / 框选（按当前工具；move/up 挂 window 防会话卡死） ------
  const onBackgroundPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button === 2) return;
    const target = event.target;
    // Portal 浮层（模型下拉等）的 React 事件会沿组件树冒泡到这里：目标不在画布
    // 自己的 DOM 里就放行，绝不 setPointerCapture（否则浮层收不到 pointerup）。
    if (!eventInsideDom(containerRef.current, target)) return;
    const el = target instanceof Element ? target : null;
    // 节点 / 连线 / 浮层自己处理指针，背景只认空白处
    if (el?.closest("[data-node-id],[data-connection-id],[data-canvas-no-zoom],[data-radix-popper-content-wrapper]")) return;
    setMenu(null);
    setShortcutsOpen(false);
    dragRef.current = null; // 防御：上一个会话若没收到 up，先丢弃
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const wantBox = toolRef.current === "box" || event.shiftKey;
    const session: DragMode = wantBox
      ? { type: "box", startX: event.clientX, startY: event.clientY, curX: event.clientX, curY: event.clientY, additive: event.shiftKey }
      : { type: "pan", startX: event.clientX, startY: event.clientY, originX: viewport.x, originY: viewport.y };
    dragRef.current = session;
    setDrag(session);
    // 平移起手顺手清空选择（框选的追加语义由 additive 决定，不清）
    if (session.type === "pan") useCanvasStore.getState().select([]);
  };

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const session = dragRef.current;
      if (!session) return;
      const vp = useCanvasStore.getState().viewport;
      if (session.type === "pan") {
        useCanvasStore.getState().setViewport({
          x: session.originX + (event.clientX - session.startX),
          y: session.originY + (event.clientY - session.startY),
          k: vp.k,
        });
        return;
      }
      const next: DragMode = { ...session, curX: event.clientX, curY: event.clientY };
      dragRef.current = next;
      setDrag(next);
      // 实时框选命中（世界坐标求交）
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const ax = Math.min(session.startX, next.curX) - rect.left;
      const bx = Math.max(session.startX, next.curX) - rect.left;
      const ay = Math.min(session.startY, next.curY) - rect.top;
      const by = Math.max(session.startY, next.curY) - rect.top;
      const worldA = { x: (ax - vp.x) / vp.k, y: (ay - vp.y) / vp.k };
      const worldB = { x: (bx - vp.x) / vp.k, y: (by - vp.y) / vp.k };
      const hit = useCanvasStore
        .getState()
        .nodes.filter((n) => n.x < worldB.x && n.x + n.width > worldA.x && n.y < worldB.y && n.y + n.height > worldA.y)
        .map((n) => n.id);
      useCanvasStore.getState().select(hit, session.additive);
    };
    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      setDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", onUp);
    };
  }, []);

  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    // 同 startDrag：Portal 浮层里的双击不该当成"双击空白建节点"。
    if (!eventInsideDom(containerRef.current, target)) return;
    const el = target instanceof Element ? target : null;
    if (el?.closest("[data-node-id],[data-connection-id],[data-canvas-no-zoom]")) return;
    const world = screenToWorld(event.clientX, event.clientY);
    const rect = containerRef.current?.getBoundingClientRect();
    setMenu({ screenX: event.clientX - (rect?.left ?? 0) + 8, screenY: event.clientY - (rect?.top ?? 0) + 8, worldX: world.x, worldY: world.y });
  };

  // ---- 建节点：自动编号（"图片 #2"） ------------------------------
  const createAt = useCallback(
    (kind: CanvasNodeKind, worldX: number, worldY: number) => {
      const s = useCanvasStore.getState();
      const label = t(`canvas.node.${kind}`);
      const n = s.nodes.filter((x) => x.kind === kind).length + 1;
      s.addNode(kind, Math.round(worldX), Math.round(worldY), t("canvas.nodeTitle", { name: label, n: String(n) }));
      setMenu(null);
    },
    [t],
  );

  const openMenuFromBar = useCallback(() => {
    setShortcutsOpen(false);
    const rect = containerRef.current?.getBoundingClientRect();
    const world = viewportCenterWorld();
    setMenu({
      // 底部工具栏（居中）上方弹出；create-menu 挂载后自带贴边防裁剪兜底。
      screenX: rect ? rect.width / 2 - 144 : 120,
      screenY: 0,
      worldX: world.x,
      worldY: world.y,
    });
  }, [viewportCenterWorld]);

  // ---- 上传：本地图片 → images/canvas/ ref → 图片节点 -------------------------
  const onUploadPick = useCallback(async () => {
    setMenu(null);
    fileInputRef.current?.click();
  }, []);

  const onFileChosen = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      }).catch(() => null);
      if (!dataUrl) return;
      const r = await rpcClient.canvasImportImage({ dataUrl, name: file.name });
      if (!r.ref) {
        // 主进程已把原因写进 app.log（canvas.image.imported / 校验失败只回错误串）
        console.warn(t("canvas.upload.failed"), r.error);
        return;
      }
      const s = useCanvasStore.getState();
      const world = viewportCenterWorld();
      const n = s.nodes.filter((x) => x.kind === "image").length + 1;
      const id = s.addNode("image", Math.round(world.x), Math.round(world.y), t("canvas.nodeTitle", { name: t("canvas.node.image"), n: String(n) }));
      const patch: { resultRef: string; status: "success"; title?: string } = { resultRef: r.ref, status: "success" };
      if (file.name.trim()) patch.title = file.name.slice(0, 60);
      s.updateNode(id, patch);
    },
    [t, viewportCenterWorld],
  );

  const boxRect = drag?.type === "box" ? drag : null;

  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={(e) => void onFileChosen(e)}
      />

      {/* 画布容器 */}
      <div
        ref={containerRef}
        data-canvas-viewport
        className={cn(
          "absolute inset-0 touch-none select-none",
          spacePressed || drag?.type === "pan" ? "cursor-grabbing" : tool === "box" ? "cursor-crosshair" : "cursor-grab",
        )}
        style={{
          backgroundImage: "radial-gradient(circle, hsl(var(--border) / 0.9) 1px, transparent 1px)",
          backgroundSize: `${24 * viewport.k}px ${24 * viewport.k}px`,
          backgroundPosition: `${viewport.x}px ${viewport.y}px`,
        }}
        onPointerDown={onBackgroundPointerDown}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* 连线层（世界坐标） */}
        <svg className="pointer-events-none absolute inset-0 overflow-visible">
          <g transform={`translate(${viewport.x},${viewport.y}) scale(${viewport.k})`}>
            {connections.map((c) => {
              const from = nodes.find((n) => n.id === c.fromId);
              const to = nodes.find((n) => n.id === c.toId);
              if (!from || !to) return null;
              const x1 = from.x + from.width;
              const y1 = from.y + from.height / 2;
              const x2 = to.x;
              const y2 = to.y + to.height / 2;
              const dx = Math.max(40, Math.abs(x2 - x1) / 2);
              const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
              const active = selectedConnectionId === c.id;
              return (
                <g key={c.id}>
                  <path
                    d={d}
                    fill="none"
                    className={cn("pointer-events-auto cursor-pointer stroke-border", active ? "stroke-primary" : "hover:stroke-primary/60")}
                    strokeWidth={active ? 2.5 : 1.8}
                    data-connection-id={c.id}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      useCanvasStore.getState().selectConnection(c.id);
                    }}
                  />
                  <circle cx={x2} cy={y2} r={3} className="fill-primary/70" />
                </g>
              );
            })}
            {connecting ? (
              <path
                d={connectionPreviewPath(nodes, connecting)}
                fill="none"
                className="stroke-primary/70"
                strokeWidth={1.8}
                strokeDasharray="6 4"
              />
            ) : null}
          </g>
        </svg>

        {/* 节点层（世界坐标） */}
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})` }}
        >
          {nodes.map((node) => (
            <CanvasNodeView key={node.id} node={node} scale={viewport.k} onPortPointerDown={onPortPointerDown} />
          ))}
        </div>

        {/* 框选矩形（屏幕坐标） */}
        {boxRect && containerRef.current ? (
          <div
            className="pointer-events-none absolute border border-primary/60 bg-primary/10"
            style={{
              left: Math.min(boxRect.startX, boxRect.curX) - (containerRef.current.getBoundingClientRect().left ?? 0),
              top: Math.min(boxRect.startY, boxRect.curY) - (containerRef.current.getBoundingClientRect().top ?? 0),
              width: Math.abs(boxRect.curX - boxRect.startX),
              height: Math.abs(boxRect.curY - boxRect.startY),
            }}
          />
        ) : null}
      </div>

      <CanvasEmptyHint visible={nodes.length === 0 && !loading} />

      {/* 左上角：画布标题 */}
      <div className="absolute left-3 top-3 z-20" data-canvas-no-zoom>
        <div className="flex h-9 items-center gap-1.5 rounded-lg border bg-background/90 px-2 shadow-sm backdrop-blur">
          <Input
            value={title}
            onChange={(e) => useCanvasStore.getState().setTitle(e.target.value)}
            className="h-7 w-44 border-0 bg-transparent px-0 text-sm font-medium shadow-none focus-visible:ring-0"
            placeholder={t("canvas.untitled")}
          />
        </div>
      </div>

      {/* 右上角：素材库入口 */}
      <div className="absolute right-3 top-3 z-20" data-canvas-no-zoom>
        <LibraryButton variant="pill" onOpen={() => setLibraryOpen(true)} />
      </div>

      {/* 底部居中工具栏：添加 / 选择 / 框选 / 撤销重做 / 快捷键 / 缩放 */}
      <div
        className="absolute bottom-3 left-1/2 z-20 flex h-11 -translate-x-1/2 items-center gap-0.5 rounded-xl border bg-background/95 p-1 shadow-lg backdrop-blur"
        data-canvas-no-zoom
      >
        <button
          type="button"
          aria-label={t("canvas.addNode")}
          className="mr-0.5 grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground transition-transform hover:scale-105"
          onClick={() => (menu ? setMenu(null) : openMenuFromBar())}
        >
          <PlusIcon className="size-4" />
        </button>
        <BarToggle active={tool === "pan"} label={t("canvas.tool.select")} onClick={() => setTool("pan")}>
          <MousePointer2Icon className="size-4" />
        </BarToggle>
        <BarToggle active={tool === "box"} label={t("canvas.tool.boxSelect")} onClick={() => setTool("box")}>
          <BoxSelectIcon className="size-4" />
        </BarToggle>
        <BarDivider />
        <BarToggle active={false} disabled={!canUndo} label={t("canvas.undo")} onClick={() => useCanvasStore.getState().undo()}>
          <Undo2Icon className="size-4" />
        </BarToggle>
        <BarToggle active={false} disabled={!canRedo} label={t("canvas.redo")} onClick={() => useCanvasStore.getState().redo()}>
          <Redo2Icon className="size-4" />
        </BarToggle>
        <BarDivider />
        {/* 删除选中：无选中时禁用；有节点或多选即删，选中连线则删连线 */}
        <BarToggle
          active={false}
          disabled={selection.length === 0 && !selectedConnectionId}
          label={t("canvas.deleteSelection")}
          onClick={() => {
            const s = useCanvasStore.getState();
            if (selection.length > 0) s.removeNodes(selection);
            else if (selectedConnectionId) s.removeConnection(selectedConnectionId);
          }}
        >
          <Trash2Icon className="size-4" />
        </BarToggle>
        <BarDivider />
        <BarToggle active={shortcutsOpen} label={t("canvas.shortcuts")} onClick={() => setShortcutsOpen((v) => !v)}>
          <KeyboardIcon className="size-4" />
        </BarToggle>
        <BarDivider />
        <Button size="icon" variant="ghost" className="size-7" aria-label={t("canvas.zoom.out")} onClick={() => zoomCenter(1 / 1.2)}>
          <ZoomOutIcon className="size-4" />
        </Button>
        <button
          type="button"
          className="min-w-12 rounded px-1 text-center text-xs tabular-nums text-muted-foreground hover:text-foreground"
          onClick={() => {
            const rect = containerRef.current?.getBoundingClientRect();
            if (rect) zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, CANVAS_DEFAULT_VIEWPORT.k / viewport.k);
          }}
        >
          {Math.round(viewport.k * 100)}%
        </button>
        <Button size="icon" variant="ghost" className="size-7" aria-label={t("canvas.zoom.in")} onClick={() => zoomCenter(1.2)}>
          <ZoomInIcon className="size-4" />
        </Button>
        <Button size="icon" variant="ghost" className="size-7" aria-label={t("canvas.zoom.fit")} onClick={fitView}>
          <MaximizeIcon className="size-4" />
        </Button>
      </div>

      {/* 快捷键速查 */}
      {shortcutsOpen ? (
        <div
          className="absolute right-3 bottom-16 z-30 w-72 rounded-xl border bg-popover p-3 shadow-xl"
          data-canvas-no-zoom
        >
          <h3 className="mb-2 text-xs font-semibold">{t("canvas.shortcut.title")}</h3>
          {[
            "canvas.shortcut.doubleClick",
            "canvas.shortcut.portDrag",
            "canvas.shortcut.spaceDrag",
            "canvas.shortcut.shiftDrag",
            "canvas.shortcut.wheel",
            "canvas.shortcut.delete",
            "canvas.shortcut.undo",
          ].map((key) => (
            <div key={key} className="py-0.5 text-[11px] leading-relaxed text-muted-foreground">
              {t(key)}
            </div>
          ))}
        </div>
      ) : null}

      {/* 创建菜单（双击位置 / 底部工具栏） */}
      {menu ? (
        <CanvasCreateMenu
          position={{ screenX: menu.screenX, screenY: menu.screenY }}
          onCreateNode={(kind) => createAt(kind, menu.worldX, menu.worldY)}
          onUpload={onUploadPick}
          onOpenLibrary={() => setLibraryOpen(true)}
          onClose={() => setMenu(null)}
        />
      ) : null}

      <LibraryModal open={libraryOpen} onOpenChange={setLibraryOpen} />
    </div>
  );
}

function BarDivider() {
  return <div className="mx-1 h-5 w-px bg-border" />;
}

function BarToggle({
  active,
  disabled,
  label,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      className={cn(
        "grid size-9 place-items-center rounded-xl transition-colors",
        disabled ? "text-muted-foreground/40" : active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function connectionPreviewPath(
  nodes: ReturnType<typeof useCanvasStore.getState>["nodes"],
  connecting: NonNullable<ConnectSession>,
): string {
  const from = nodes.find((n) => n.id === connecting.fromId);
  if (!from) return "";
  const x1 = from.x + from.width;
  const y1 = from.y + from.height / 2;
  const x2 = connecting.cursor.x;
  const y2 = connecting.cursor.y;
  const dx = Math.max(40, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}
