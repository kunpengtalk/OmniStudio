import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FileIcon,
  FolderOpenIcon,
  GlobeIcon,
  LayersIcon,
  ListIcon,
  Loader2Icon,
  NotebookPenIcon,
  PlusIcon,
  PlayIcon,
  RefreshCwIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Badge } from "@ui/badge";
import { Button } from "@ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ui/dialog";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import { Textarea } from "@ui/textarea";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import type { KbView, KbDocView } from "@/bun/knowledge";

/** 数据源类型图标（配色统一 muted，与全局侧栏的图标语言一致）。 */
const KIND_STYLES: Record<KbDocView["kind"], { icon: typeof FileIcon; cls: string }> = {
  file: { icon: FileIcon, cls: "bg-muted text-muted-foreground" },
  note: { icon: NotebookPenIcon, cls: "bg-muted text-muted-foreground" },
  web: { icon: GlobeIcon, cls: "bg-muted text-muted-foreground" },
};

const BUSY_STATUSES = new Set(["pending", "parsing", "chunking", "embedding"]);

function DocStatusBadge({ status }: { status: KbDocView["status"] }) {
  const t = useT();
  if (BUSY_STATUSES.has(status)) {
    return (
      <Badge variant="secondary" className="h-5 gap-1 px-1.5 text-[10px] text-blue-600 dark:text-blue-400">
        <Loader2Icon className="size-3 animate-spin" />
        {t(`kb.status.${status}`)}
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <Badge variant="destructive" className="h-5 px-1.5 text-[10px]">
        {t("kb.status.failed")}
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="h-5 gap-1 px-1.5 text-[10px] text-emerald-600 dark:text-emerald-400">
      {t("kb.status.ready")}
    </Badge>
  );
}

function formatBytes(n: number | null): string | null {
  if (n == null) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 分块查看弹窗：序号 / 字符数 / 是否已向量化 / 内容预览。 */
function ChunksDialog({ doc, onClose }: { doc: KbDocView | null; onClose: () => void }) {
  const t = useT();
  const { data, isLoading } = useQuery({
    queryKey: ["kb-chunks", doc?.id],
    queryFn: () => rpcClient.kbChunks({ docId: doc!.id }),
    enabled: doc != null,
  });

  return (
    <Dialog open={doc != null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[80vh] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="truncate pr-6">{t("kb.chunks.title")}</DialogTitle>
          <DialogDescription className="truncate">{doc?.name}</DialogDescription>
        </DialogHeader>
        <div className="-mx-1 max-h-[55vh] overflow-y-auto px-1">
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (data?.chunks ?? []).length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">{t("kb.chunks.empty")}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {data!.chunks.map((c) => (
                <div key={c.id} className="rounded-lg border px-3 py-2">
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span className="font-mono">#{c.seq}</span>
                    <span className="tabular-nums">
                      {c.charCount} {t("kb.chunks.chars")}
                    </span>
                    <span
                      className={cn(
                        "ml-auto flex items-center gap-1",
                        c.embedded ? "text-emerald-600 dark:text-emerald-400" : "",
                      )}
                    >
                      {c.embedded ? t("kb.chunks.embedded") : t("kb.chunks.notEmbedded")}
                    </span>
                  </div>
                  {c.headingPath && (
                    <p className="mt-0.5 truncate text-[10px] text-muted-foreground" title={c.headingPath}>
                      {c.headingPath}
                    </p>
                  )}
                  <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs leading-5">{c.content}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 一行数据源：类型图标 + 名称状态 + 向量进度 + 元信息 + 悬浮操作。 */
function DocRow({
  doc,
  embeddingEnabled,
  onChunks,
  onReingest,
  onRetry,
  onDelete,
  busy,
}: {
  doc: KbDocView;
  embeddingEnabled: boolean;
  onChunks: () => void;
  onReingest: () => void;
  onRetry: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const t = useT();
  const style = KIND_STYLES[doc.kind] ?? KIND_STYLES.file!;
  const Icon = style.icon;
  const embeddedPct = doc.chunkCount > 0 ? Math.round((doc.embeddedCount / doc.chunkCount) * 100) : 0;

  return (
    <div className="group/doc flex items-start gap-3 rounded-xl border bg-card px-3 py-2.5 transition-colors hover:border-foreground/15">
      <span className={cn("mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg", style.cls)}>
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs font-medium">{doc.name}</span>
          <DocStatusBadge status={doc.status} />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
          <span className="tabular-nums">
            {t("kb.docs.chunkCounts", { embedded: String(doc.embeddedCount), total: String(doc.chunkCount) })}
          </span>
          {embeddingEnabled && doc.chunkCount > 0 && (
            <span className="h-1 w-20 overflow-hidden rounded-full bg-muted">
              <span
                className={cn(
                  "block h-full rounded-full transition-all",
                  embeddedPct >= 100 ? "bg-emerald-500" : "bg-primary",
                )}
                style={{ width: `${Math.max(3, embeddedPct)}%` }}
              />
            </span>
          )}
          {doc.charCount != null && (
            <span className="tabular-nums">{t("kb.docs.charCount", { count: String(doc.charCount) })}</span>
          )}
          {doc.sizeBytes != null && <span className="tabular-nums">{formatBytes(doc.sizeBytes)}</span>}
          <span className="tabular-nums">
            {new Date(doc.updatedAt ?? doc.createdAt ?? Date.now()).toLocaleString([], {
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </div>
        {doc.error && (
          <p className="mt-1.5 line-clamp-2 rounded-md bg-destructive/10 px-2 py-1 text-[10px] leading-4 text-destructive">
            {doc.error}
          </p>
        )}
        {doc.job?.state === "queued" && doc.job.attempts > 0 && (
          <p className="mt-1.5 text-[10px] leading-4 text-amber-600 dark:text-amber-400">
            {t("kb.docs.retryHint", { n: String(doc.job.attempts), max: String(doc.job.maxAttempts) })}
          </p>
        )}
        {doc.job?.state === "failed" && (
          <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">{t("kb.docs.retryExhausted")}</p>
        )}
      </div>
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/doc:opacity-100">
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6 text-muted-foreground/80 hover:text-foreground"
          tooltip={t("kb.docs.viewChunks")}
          onClick={onChunks}
          disabled={doc.chunkCount === 0}
        >
          <ListIcon className="size-3.5" />
        </Button>
        {doc.status === "failed" && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-6 text-muted-foreground/80 hover:text-foreground"
            tooltip={t("kb.docs.retry")}
            onClick={onRetry}
            disabled={busy}
          >
            <PlayIcon className="size-3.5" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6 text-muted-foreground/80 hover:text-foreground"
          tooltip={t("kb.docs.reingest")}
          onClick={onReingest}
          disabled={busy || BUSY_STATUSES.has(doc.status)}
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6 text-muted-foreground/80 hover:text-destructive"
          tooltip={t("common.delete")}
          onClick={onDelete}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </span>
    </div>
  );
}

/** 空状态的四块数据源入口：点击即触发对应导入。 */
function SourceTiles({
  onFiles,
  onFolder,
  onNote,
  onWeb,
  disabled,
}: {
  onFiles: () => void;
  onFolder: () => void;
  onNote: () => void;
  onWeb: () => void;
  disabled: boolean;
}) {
  const t = useT();
  const tiles = [
    { icon: FileIcon, title: t("kb.docs.addFile"), desc: t("kb.docs.tileFileDesc"), onClick: onFiles },
    { icon: FolderOpenIcon, title: t("kb.docs.addFolder"), desc: t("kb.docs.tileFolderDesc"), onClick: onFolder },
    { icon: NotebookPenIcon, title: t("kb.docs.addNote"), desc: t("kb.docs.tileNoteDesc"), onClick: onNote },
    { icon: GlobeIcon, title: t("kb.docs.addWeb"), desc: t("kb.docs.tileWebDesc"), onClick: onWeb },
  ];
  return (
    <div className="grid w-full max-w-2xl grid-cols-2 gap-3 xl:grid-cols-4">
      {tiles.map((tile) => (
        <button
          key={tile.title}
          type="button"
          disabled={disabled}
          onClick={tile.onClick}
          className="group/tile flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-5 text-center transition-colors hover:border-primary/40 hover:bg-primary/5 disabled:opacity-50"
        >
          <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <tile.icon className="size-5" />
          </span>
          <span className="text-xs font-medium">{tile.title}</span>
          <span className="text-[10px] leading-4 text-muted-foreground">{tile.desc}</span>
        </button>
      ))}
    </div>
  );
}

export function KbDocsTab({ kb }: { kb: KbView }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [noteOpen, setNoteOpen] = useState(false);
  const [webOpen, setWebOpen] = useState(false);
  const [noteTitle, setNoteTitle] = useState("");
  const [noteContent, setNoteContent] = useState("");
  const [webUrl, setWebUrl] = useState("");
  const [chunksDoc, setChunksDoc] = useState<KbDocView | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<KbDocView | null>(null);

  const docsQuery = useQuery({
    queryKey: ["kb-docs", kb.id],
    queryFn: () => rpcClient.kbDocList({ kbId: kb.id }),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["kb-docs", kb.id] });
    queryClient.invalidateQueries({ queryKey: ["kb-list"] });
  };

  const addFilesMutation = useMutation({
    mutationFn: async () => {
      const { paths } = await rpcClient.openFileDialog({
        allowedFileTypes:
          "txt,md,markdown,json,csv,tsv,log,xml,yml,yaml,html,htm,pdf,png,jpg,jpeg,webp,tiff,bmp,heic,heif",
      });
      if (paths.length === 0) return;
      await rpcClient.kbAddFiles({ kbId: kb.id, paths });
    },
    onSuccess: invalidate,
  });

  const addFolderMutation = useMutation({
    mutationFn: async () => {
      const { paths } = await rpcClient.openFileDialog({
        canChooseFiles: false,
        canChooseDirectory: true,
        allowsMultipleSelection: false,
      });
      const dir = paths[0];
      if (!dir) return;
      await rpcClient.kbAddFolder({ kbId: kb.id, path: dir });
    },
    onSuccess: invalidate,
  });

  const addNoteMutation = useMutation({
    mutationFn: () => rpcClient.kbAddNote({ kbId: kb.id, title: noteTitle, content: noteContent }),
    onSuccess: () => {
      invalidate();
      setNoteOpen(false);
      setNoteTitle("");
      setNoteContent("");
    },
  });

  const addWebMutation = useMutation({
    mutationFn: () => rpcClient.kbAddWeb({ kbId: kb.id, url: webUrl }),
    onSuccess: () => {
      invalidate();
      setWebOpen(false);
      setWebUrl("");
    },
  });

  const reingestMutation = useMutation({
    mutationFn: (id: number) => rpcClient.kbDocReingest({ id }),
    onSuccess: invalidate,
  });

  const retryMutation = useMutation({
    mutationFn: (id: number) => rpcClient.kbDocRetry({ id }),
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => rpcClient.kbDocDelete({ id }),
    onSuccess: () => {
      invalidate();
      setConfirmDelete(null);
    },
  });

  const embedMutation = useMutation({
    mutationFn: () => rpcClient.kbEmbedMissing({ kbId: kb.id }),
    onSuccess: invalidate,
  });

  const docs = docsQuery.data?.docs ?? [];
  const missingVectors = docs.reduce((s, d) => s + Math.max(0, d.chunkCount - d.embeddedCount), 0);

  const tilesProps = {
    onFiles: () => addFilesMutation.mutate(),
    onFolder: () => addFolderMutation.mutate(),
    onNote: () => setNoteOpen(true),
    onWeb: () => setWebOpen(true),
    disabled: addFilesMutation.isPending || addFolderMutation.isPending,
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 工具条（有数据时显示；空状态用大入口卡片） */}
      {docs.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-6 py-3">
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2.5 text-xs"
            onClick={tilesProps.onFiles}
            disabled={addFilesMutation.isPending}
          >
            {addFilesMutation.isPending ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <PlusIcon className="size-3.5" />
            )}
            {t("kb.docs.addFile")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2.5 text-xs"
            onClick={tilesProps.onFolder}
            disabled={addFolderMutation.isPending}
          >
            {addFolderMutation.isPending ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <FolderOpenIcon className="size-3.5" />
            )}
            {t("kb.docs.addFolder")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2.5 text-xs"
            onClick={() => setNoteOpen(true)}
          >
            <NotebookPenIcon className="size-3.5" />
            {t("kb.docs.addNote")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2.5 text-xs"
            onClick={() => setWebOpen(true)}
          >
            <GlobeIcon className="size-3.5" />
            {t("kb.docs.addWeb")}
          </Button>
          {kb.embeddingModel && (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto h-7 gap-1.5 px-2.5 text-xs"
              onClick={() => embedMutation.mutate()}
              disabled={embedMutation.isPending || missingVectors === 0}
              tooltip={
                missingVectors > 0
                  ? t("kb.docs.embedMissingHint", { count: String(missingVectors) })
                  : t("kb.docs.embedNone")
              }
            >
              {embedMutation.isPending ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <SparklesIcon className="size-3.5" />
              )}
              {t("kb.docs.embedMissing")}
            </Button>
          )}
        </div>
      )}

      {/* 列表 / 空状态 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        {docsQuery.isLoading ? (
          <div className="flex justify-center py-10">
            <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : docs.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-5 py-14">
            <div className="flex flex-col items-center gap-1.5 text-center">
              <div className="flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                <LayersIcon className="size-5" />
              </div>
              <p className="text-sm font-medium">{t("kb.docs.empty")}</p>
              <p className="max-w-md text-xs leading-5 text-muted-foreground">{t("kb.docs.emptyHint")}</p>
            </div>
            <SourceTiles {...tilesProps} />
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {docs.map((d) => (
              <DocRow
                key={d.id}
                doc={d}
                embeddingEnabled={!!kb.embeddingModel}
                busy={reingestMutation.isPending}
                onChunks={() => setChunksDoc(d)}
                onReingest={() => reingestMutation.mutate(d.id)}
                onRetry={() => retryMutation.mutate(d.id)}
                onDelete={() => setConfirmDelete(d)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 添加笔记 */}
      <Dialog open={noteOpen} onOpenChange={setNoteOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("kb.docs.addNote")}</DialogTitle>
            <DialogDescription>{t("kb.note.desc")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-1">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="kb-note-title">{t("kb.note.title")}</Label>
              <Input
                id="kb-note-title"
                value={noteTitle}
                onChange={(e) => setNoteTitle(e.target.value)}
                placeholder={t("kb.note.titlePlaceholder")}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="kb-note-content">{t("kb.note.content")}</Label>
              <Textarea
                id="kb-note-content"
                value={noteContent}
                onChange={(e) => setNoteContent(e.target.value)}
                placeholder={t("kb.note.contentPlaceholder")}
                rows={8}
                className="resize-none font-mono text-xs"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setNoteOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              disabled={!noteContent.trim() || addNoteMutation.isPending}
              onClick={() => addNoteMutation.mutate()}
            >
              {addNoteMutation.isPending && <Loader2Icon className="size-3.5 animate-spin" />}
              {t("common.add")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 添加网页 */}
      <Dialog open={webOpen} onOpenChange={setWebOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("kb.docs.addWeb")}</DialogTitle>
            <DialogDescription>{t("kb.web.desc")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5 py-1">
            <Label htmlFor="kb-web-url">URL</Label>
            <Input
              id="kb-web-url"
              value={webUrl}
              onChange={(e) => setWebUrl(e.target.value)}
              placeholder="https://example.com/article"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setWebOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              disabled={!/^https?:\/\//i.test(webUrl.trim()) || addWebMutation.isPending}
              onClick={() => addWebMutation.mutate()}
            >
              {addWebMutation.isPending && <Loader2Icon className="size-3.5 animate-spin" />}
              {t("common.add")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <Dialog open={confirmDelete != null} onOpenChange={(next) => !next && setConfirmDelete(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("kb.docs.deleteTitle")}</DialogTitle>
            <DialogDescription>
              {t("kb.docs.deleteBody")}{" "}
              <span className="font-medium text-foreground">「{confirmDelete?.name}」</span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmDelete(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={deleteMutation.isPending}
              onClick={() => confirmDelete && deleteMutation.mutate(confirmDelete.id)}
            >
              {deleteMutation.isPending ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <Trash2Icon className="size-3.5" />
              )}
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ChunksDialog doc={chunksDoc} onClose={() => setChunksDoc(null)} />
    </div>
  );
}
