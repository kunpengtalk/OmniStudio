/**
 * 画布「添加节点」菜单：常驻搜索框（打开即可打字过滤，回车建第一个命中项）；
 * 创作节点（文本 / 图片 / 视频 / 音乐 / 音频）与导入资源（上传 / 素材库）。
 * 出现在双击位置或顶部工具栏 + 号处。
 *
 * 菜单里不放「正在开发」一类的禁用占位 —— 没有对应功能的项留着只会让用户点
 * 个寂寞（早期版本放过的占位已整体移除）。「素材库」是**真入口**：打开集中了
 * 所有生成记录（生图 / 生视频 / 生音乐 / 语音）的库，点一条就插回画布。
 */
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  SearchIcon,
  XIcon,
  TypeIcon,
  ImageIcon,
  ClapperboardIcon,
  MusicIcon,
  AudioWaveformIcon,
  UploadCloudIcon,
  FolderIcon,
} from "lucide-react";

import { cn } from "@/mainview/lib/utils";
import type { CanvasNodeKind } from "@/shared/canvas";
import { useT } from "@stores/ui-lang";

export type CreateMenuAction = {
  id: string;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
};

export function CanvasCreateMenu({
  position,
  onCreateNode,
  onUpload,
  onOpenLibrary,
  onClose,
}: {
  position: { screenX: number; screenY: number };
  onCreateNode: (kind: CanvasNodeKind) => void;
  onUpload: () => void;
  onOpenLibrary: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState({ dx: 0, dy: 0 });

  /**
   * 贴着窗口下沿打开时菜单后半截会被切掉（「导入资源 → 上传 / 素材库」直接看不见），
   * 所以在挂载后量一次真实尺寸，把整块平移到可视区内（下方放不下就往上收，
   * 左右同理）。量完才定位于用户看到的位置，避免先闪一下再挪。
   */
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const pad = 8;
    const rect = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    let dx = 0;
    let dy = 0;
    if (rect.bottom > vh - pad) dy = -(rect.bottom - (vh - pad));
    if (rect.top + dy < pad) dy = pad - rect.top;
    if (rect.right > vw - pad) dx = -(rect.right - (vw - pad));
    if (rect.left + dx < pad) dx = pad - rect.left;
    setOffset({ dx, dy });
  }, [position.screenX, position.screenY]);

  const items = useMemo(() => {
    const nodeItems: CreateMenuAction[] = [
      { id: "text", label: t("canvas.node.text"), icon: <TypeIcon className="size-4" />, onClick: () => onCreateNode("text") },
      { id: "image", label: t("canvas.node.image"), icon: <ImageIcon className="size-4" />, onClick: () => onCreateNode("image") },
      { id: "video", label: t("canvas.node.video"), icon: <ClapperboardIcon className="size-4" />, onClick: () => onCreateNode("video") },
      { id: "music", label: t("canvas.node.music"), icon: <MusicIcon className="size-4" />, onClick: () => onCreateNode("music") },
      { id: "audio", label: t("canvas.node.audio"), icon: <AudioWaveformIcon className="size-4" />, onClick: () => onCreateNode("audio") },
    ];
    const importItems: CreateMenuAction[] = [
      { id: "upload", label: t("canvas.menu.upload"), icon: <UploadCloudIcon className="size-4" />, onClick: onUpload },
      { id: "library", label: t("canvas.library.title"), icon: <FolderIcon className="size-4" />, onClick: onOpenLibrary },
    ];
    return { nodeItems, importItems };
  }, [t, onCreateNode, onUpload, onOpenLibrary]);

  const normalized = query.trim().toLocaleLowerCase();
  const visible = (list: CreateMenuAction[]) =>
    normalized ? list.filter((item) => item.label.toLocaleLowerCase().includes(normalized)) : list;
  const nodeItems = visible(items.nodeItems);
  const importItems = visible(items.importItems);
  const nothing = nodeItems.length === 0 && importItems.length === 0;

  return (
    <>
      <div className="fixed inset-0 z-30" onPointerDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        ref={panelRef}
        className="absolute z-40 w-72 overflow-hidden rounded-xl border bg-popover shadow-xl"
        style={{ left: position.screenX, top: position.screenY, transform: `translate(${offset.dx}px, ${offset.dy}px)` }}
        data-canvas-no-zoom
      >
        <header className="flex h-10 items-center gap-2 border-b px-3">
          <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                if (query) setQuery("");
                else onClose();
              }
              if (e.key === "Enter") {
                const first = [...nodeItems, ...importItems][0];
                if (first) {
                  first.onClick();
                  onClose();
                }
              }
            }}
            placeholder={t("canvas.menu.search")}
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
          />
          {query ? (
            <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setQuery("")}>
              <XIcon className="size-3.5" />
            </button>
          ) : null}
        </header>

        <div className="max-h-80 overflow-y-auto p-1.5">
          {nothing ? (
            <div className="px-2 py-4 text-center text-xs text-muted-foreground">{t("canvas.menu.noMatch")}</div>
          ) : null}

          {nodeItems.length > 0 ? <MenuSection label={t("canvas.menu.section.nodes")} /> : null}
          {nodeItems.map((item) => (
            <MenuRow key={item.id} item={item} onRun={() => { item.onClick(); onClose(); }} />
          ))}

          {importItems.length > 0 ? (
            <MenuSection label={t("canvas.menu.section.import")} className="mt-1.5" />
          ) : null}
          {importItems.map((item) => (
            <MenuRow key={item.id} item={item} onRun={() => { item.onClick(); onClose(); }} />
          ))}
        </div>
      </div>
    </>
  );
}

function MenuSection({ label, className }: { label: string; className?: string }) {
  return <div className={cn("px-2 pb-1 pt-2 text-[10px] font-medium text-muted-foreground", className)}>{label}</div>;
}

function MenuRow({ item, onRun }: { item: CreateMenuAction; onRun: () => void }) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-xs transition-colors hover:bg-muted"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={onRun}
    >
      <span className="grid size-6 shrink-0 place-items-center rounded-md border bg-muted/50">{item.icon}</span>
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
    </button>
  );
}
