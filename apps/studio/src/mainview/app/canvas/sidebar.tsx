/**
 * 无限画布侧栏：画布文档列表（新建 / 打开 / 重命名 / 删除）。
 *
 * 打开文档 = 拉整份载荷写进 canvas store（store 是画布状态的唯一作者），
 * 保存由画布页防抖完成 —— 侧栏只负责"哪张画布在编辑"。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { CheckIcon, PencilIcon, PlusIcon, TrashIcon, WaypointsIcon, XIcon } from "lucide-react";

import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { cn } from "@lib/utils";
import { rpcClient } from "@lib/rpc";
import { useCanvasStore } from "./canvas-store";
import { useT } from "@stores/ui-lang";

export function CanvasSidebar() {
  const t = useT();
  const queryClient = useQueryClient();
  const [renaming, setRenaming] = useState<number | null>(null);
  const [renameText, setRenameText] = useState("");
  const docId = useCanvasStore((s) => s.docId);

  const docs = useQuery({ queryKey: ["canvas-docs"], queryFn: () => rpcClient.canvasListDocs(undefined) });

  const createDoc = useMutation({
    mutationFn: () => rpcClient.canvasCreateDoc({ title: t("canvas.untitled") }),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ["canvas-docs"] });
      useCanvasStore.getState().setDoc({
        id: r.doc.id,
        title: r.doc.title,
        payload: { nodes: [], connections: [], viewport: { x: 0, y: 0, k: 1 } },
      });
    },
  });

  const deleteDoc = useMutation({
    mutationFn: (id: number) => rpcClient.canvasDeleteDoc({ id }),
    onSuccess: (_r, id) => {
      queryClient.invalidateQueries({ queryKey: ["canvas-docs"] });
      // 被删的是当前画布：卸载它，主屏的加载 effect 会自动补上最近一份。
      if (useCanvasStore.getState().docId === id) useCanvasStore.getState().clearDoc();
    },
  });

  const openDoc = async (id: number) => {
    if (id === useCanvasStore.getState().docId) return;
    useCanvasStore.getState().setLoading(true);
    const r = await rpcClient.canvasGetDoc({ id });
    if (r.doc) useCanvasStore.getState().setDoc(r.doc);
    else useCanvasStore.getState().setLoading(false);
  };

  const commitRename = async (id: number) => {
    const title = renameText.trim() || t("canvas.untitled");
    setRenaming(null);
    await rpcClient.canvasSaveDoc({ id, title });
    if (useCanvasStore.getState().docId === id) useCanvasStore.getState().setTitle(title);
    void queryClient.invalidateQueries({ queryKey: ["canvas-docs"] });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">{t("canvas.docsTitle")}</span>
        <Button size="icon" variant="ghost" className="size-6" aria-label={t("canvas.newDoc")} onClick={() => createDoc.mutate()}>
          <PlusIcon className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {(docs.data?.docs ?? []).map((doc) => (
          <div
            key={doc.id}
            className={cn(
              "group mb-0.5 flex items-center gap-1.5 rounded-lg px-2 py-2 text-xs transition-colors",
              doc.id === docId ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {renaming === doc.id ? (
              <>
                <Input
                  autoFocus
                  value={renameText}
                  onChange={(e) => setRenameText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void commitRename(doc.id);
                    if (e.key === "Escape") setRenaming(null);
                  }}
                  className="h-6 min-w-0 flex-1 px-1.5 text-xs"
                />
                <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => void commitRename(doc.id)}>
                  <CheckIcon className="size-3.5" />
                </button>
                <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setRenaming(null)}>
                  <XIcon className="size-3.5" />
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  onClick={() => void openDoc(doc.id)}
                >
                  <WaypointsIcon className="size-3.5 shrink-0 opacity-70" />
                  <span className="min-w-0 flex-1 truncate">{doc.title || t("canvas.untitled")}</span>
                  <span className="shrink-0 text-[10px] opacity-60">{doc.nodeCount}</span>
                </button>
                <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    type="button"
                    aria-label={t("canvas.rename")}
                    className="grid size-5 place-items-center rounded hover:text-foreground"
                    onClick={() => {
                      setRenaming(doc.id);
                      setRenameText(doc.title);
                    }}
                  >
                    <PencilIcon className="size-3" />
                  </button>
                  <button
                    type="button"
                    aria-label={t("canvas.delete")}
                    className="grid size-5 place-items-center rounded hover:text-destructive"
                    onClick={() => {
                      if (window.confirm(t("canvas.deleteConfirm"))) deleteDoc.mutate(doc.id);
                    }}
                  >
                    <TrashIcon className="size-3" />
                  </button>
                </span>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
