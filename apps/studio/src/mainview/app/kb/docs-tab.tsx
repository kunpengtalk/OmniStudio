import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AudioLinesIcon,
  FileIcon,
  FolderOpenIcon,
  GlobeIcon,
  ImageIcon,
  LayersIcon,
  ListIcon,
  Loader2Icon,
  NotebookPenIcon,
  PlusIcon,
  PlayIcon,
  RefreshCwIcon,
  SparklesIcon,
  Trash2Icon,
  VideoIcon,
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
import { KB_TEXT_EXT, KB_IMAGE_EXT, KB_AUDIO_EXT, KB_VIDEO_EXT } from "@/shared/knowledge";
import { cn } from "@/mainview/lib/utils";
import { KbImageViewer } from "@/mainview/components/kb-image-viewer";
import type { KbView, KbDocView, KbChunkView } from "@/bun/knowledge";
import type { KbModality } from "@/shared/knowledge";

/** 数据源类型图标（配色统一 muted，与全局侧栏的图标语言一致）。 */
const KIND_STYLES: Record<KbDocView["kind"], { icon: typeof FileIcon; cls: string }> = {
  file: { icon: FileIcon, cls: "bg-muted text-muted-foreground" },
  note: { icon: NotebookPenIcon, cls: "bg-muted text-muted-foreground" },
  web: { icon: GlobeIcon, cls: "bg-muted text-muted-foreground" },
};

/** 媒体直嵌块标识（分块视图 / 召回页 / 聊天引用同语言）。 */
const MEDIA_META: Record<KbModality, { icon: typeof FileIcon; labelKey: string }> = {
  image: { icon: ImageIcon, labelKey: "kb.docs.mediaChunk.image" },
  audio: { icon: AudioLinesIcon, labelKey: "kb.docs.mediaChunk.audio" },
  video: { icon: VideoIcon, labelKey: "kb.docs.mediaChunk.video" },
};

/** 恶意/损坏数据里 modality 是未知串时的通用回退（防 undefined 解构崩 React 树）。 */
const MEDIA_FALLBACK = { icon: FileIcon, labelKey: "kb.docs.mediaChunk.unknown" };

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

/**
 * 媒体直嵌块展示：图片懒加载缩略图（kbChunkMedia 的 JPEG data URL，长 staleTime 缓存）；
 * 音视频不调 RPC，直接类型图标 + 文件名。图片拉取失败 / 文件缺失回退同款图标。
 * 点击：图片块打开查看器（KbImageViewer，full 档大图，「用系统程序打开」由查看器底部
 * 按钮承担）；音视频维持 openPath 打开原文件。
 */
function MediaChunkBlock({
  chunk,
  docName,
  onOpenImage,
}: {
  chunk: KbChunkView;
  docName: string;
  /** 图片块点击回调（查看器由调用方状态受控）；音视频不走它。 */
  onOpenImage: (chunkId: number) => void;
}) {
  const t = useT();
  const isImage = chunk.modality === "image";
  const mediaQuery = useQuery({
    // 缩略图基本不变（媒体文件不会被就地改写，重建时 chunk id 会换），缓存期拉长。
    queryKey: ["kb-chunk-media", chunk.id],
    queryFn: () => rpcClient.kbChunkMedia({ chunkId: chunk.id }),
    // 只有图片块才发请求；音视频 dataUrl 恒为 null，图标+文件名零请求。
    enabled: isImage,
    staleTime: 10 * 60_000,
  });
  const meta = MEDIA_META[chunk.modality as KbModality] ?? MEDIA_FALLBACK;
  const Icon = meta.icon;
  // 只在「请求已落定但拿不到图」时才算失败：首载 pending 期间 data 还是 undefined，
  // 不能把 loading 态误判成失败而闪「缩略图加载失败」。
  const failed = isImage && (mediaQuery.isError || (mediaQuery.isSuccess && mediaQuery.data?.dataUrl == null));
  const name = mediaQuery.data?.fileName || docName;
  return (
    <button
      type="button"
      className="mt-1.5 flex w-fit max-w-full items-center gap-2.5 rounded-lg border bg-muted/30 px-2 py-1.5 text-left transition-colors hover:border-primary/40"
      title={isImage ? t("kb.viewer.title") : t("kb.docs.mediaChunk.openOriginal")}
      aria-label={isImage ? t("kb.viewer.title") : t("kb.docs.mediaChunk.openOriginal")}
      onClick={() => {
        // 图片块→查看器（「用系统程序打开」由查看器底部按钮承担）；音视频→openPath。
        if (isImage) {
          onOpenImage(chunk.id);
          return;
        }
        if (chunk.mediaPath) void rpcClient.openPath({ path: chunk.mediaPath! });
      }}
    >
      {isImage ? (
        mediaQuery.data?.dataUrl ? (
          <img
            src={mediaQuery.data.dataUrl}
            alt={name}
            loading="lazy"
            className="size-14 rounded-md object-cover"
          />
        ) : (
          <span className="flex size-14 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground">
            {mediaQuery.isFetching ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <ImageIcon className="size-5" />
            )}
          </span>
        )
      ) : (
        <span className="flex size-14 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground">
          <Icon className="size-5" />
        </span>
      )}
      <span className="min-w-0 flex flex-col">
        <span className="truncate text-xs font-medium">{name}</span>
        <span className="text-[10px] leading-4 text-muted-foreground">
          {t(meta.labelKey)}
          {failed ? ` · ${t("kb.docs.mediaChunk.loadFailed")}` : ""}
        </span>
      </span>
    </button>
  );
}

/** 分块查看弹窗：序号 / 字符数 / 是否已向量化 / 内容预览。 */
function ChunksDialog({ doc, onClose }: { doc: KbDocView | null; onClose: () => void }) {
  const t = useT();
  // 弹窗层本地查看器状态：媒体块图片点击 → 查看器（音视频维持 openPath）。
  // ChunksDialog 常驻不卸载，关闭时必须复位，否则下次打开会闪现上一文档残留的查看器。
  const [viewerChunkId, setViewerChunkId] = useState<number | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["kb-chunks", doc?.id],
    queryFn: () => rpcClient.kbChunks({ docId: doc!.id }),
    enabled: doc != null,
  });

  return (
    <>
      <Dialog
        open={doc != null}
        onOpenChange={(next) => {
          if (!next) {
            setViewerChunkId(null);
            onClose();
          }
        }}
      >
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
                    {/* 媒体直嵌块：缩略图/图标替代正文位；OCR 文本非空才补一行预览（纯媒体块合法为空）。 */}
                    {c.modality ? (
                      <>
                        <MediaChunkBlock chunk={c} docName={doc?.name ?? ""} onOpenImage={setViewerChunkId} />
                        {c.content && (
                          <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs leading-5">{c.content}</p>
                        )}
                      </>
                    ) : (
                      <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs leading-5">{c.content}</p>
                    )}
                  </div>
                ))}
                {(data?.total ?? 0) > (data?.chunks.length ?? 0) && (
                  <p className="pt-1 text-center text-[10px] text-muted-foreground">
                    {t("kb.chunks.truncated", {
                      shown: String(data?.chunks.length ?? 0),
                      total: String(data?.total ?? 0),
                    })}
                  </p>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
      <KbImageViewer chunkId={viewerChunkId} open={viewerChunkId != null} onClose={() => setViewerChunkId(null)} />
    </>
  );
}

/** 一行数据源：首图缩略图/类型图标 + 名称状态 + 向量进度 + 元信息 + 悬浮操作。 */
function DocRow({
  doc,
  embeddingEnabled,
  onChunks,
  onReingest,
  onRetry,
  onDelete,
  busy,
  onOpenImage,
}: {
  doc: KbDocView;
  embeddingEnabled: boolean;
  onChunks: () => void;
  onReingest: () => void;
  onRetry: () => void;
  onDelete: () => void;
  busy: boolean;
  /** 行内缩略图点击回调（查看器由容器层单实例受控）。 */
  onOpenImage: (chunkId: number) => void;
}) {
  const t = useT();
  const style = KIND_STYLES[doc.kind] ?? KIND_STYLES.file!;
  const Icon = style.icon;
  const embeddedPct = doc.chunkCount > 0 ? Math.round((doc.embeddedCount / doc.chunkCount) * 100) : 0;

  // 行内缩略图：有图片块的文档把类型图标位换成首图缩略图（40px 圆角）。与分块弹窗
  // MediaChunkBlock 同 queryKey 共享缓存；只有图片文档发请求（enabled 门控），失败回退
  // 类型图标（pending 不算失败，不闪错误占位）。
  const thumbQuery = useQuery({
    queryKey: ["kb-chunk-media", doc.firstImageChunkId],
    queryFn: () => rpcClient.kbChunkMedia({ chunkId: doc.firstImageChunkId! }),
    enabled: doc.firstImageChunkId != null,
    staleTime: 10 * 60_000,
  });
  // 只在「请求已落定但拿不到图」时才算失败（照抄 MediaChunkBlock 判式）：pending 不算，
  // 回退类型图标，行内不显示错误文案。
  const thumbFailed = thumbQuery.isError || (thumbQuery.isSuccess && thumbQuery.data?.dataUrl == null);
  // 收窄用局部常量：onClick 闭包里 TS 不沿对象属性收窄，也避免渲染中途翻转误用 null。
  const firstImageChunkId = doc.firstImageChunkId;
  const showThumb = firstImageChunkId != null && !thumbFailed;

  return (
    <div className="group/doc flex items-start gap-3 rounded-xl border bg-card px-3 py-2.5 transition-colors hover:border-foreground/15">
      {showThumb ? (
        <button
          type="button"
          className="mt-0.5 flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted/40 transition-colors hover:border-primary/40"
          title={t("kb.viewer.title")}
          aria-label={t("kb.viewer.title")}
          onClick={(e) => {
            // 不冒泡：行内其他区域点击行为不变。
            e.stopPropagation();
            onOpenImage(firstImageChunkId);
          }}
        >
          {thumbQuery.data?.dataUrl ? (
            <img
              src={thumbQuery.data.dataUrl}
              alt={doc.name}
              loading="lazy"
              className="size-10 rounded-lg object-cover"
            />
          ) : (
            <span className="flex size-10 items-center justify-center text-muted-foreground">
              {thumbQuery.isFetching ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <ImageIcon className="size-4" />
              )}
            </span>
          )}
        </button>
      ) : (
        <span className={cn("mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg", style.cls)}>
          <Icon className="size-4" />
        </span>
      )}
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
  // 行内缩略图查看器：容器层单实例受控（所有 DocRow 缩略图共用一个 KbImageViewer）。
  const [viewerChunkId, setViewerChunkId] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<KbDocView | null>(null);
  // 导入结果 / 失败原因就地显示在工具条下方（此前 kbAddFiles 对不存在的路径直接跳过，
  // 界面毫无反应，用户以为“点了没反应”）。
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

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
      // 与 bun 侧目录导入白名单（KB_FOLDER_FILE_RE）同一来源：shared/knowledge.ts 扩展名常量。
      const accept = [...KB_TEXT_EXT, ...KB_IMAGE_EXT, ...KB_AUDIO_EXT, ...KB_VIDEO_EXT].join(",");
      const { paths } = await rpcClient.openFileDialog({ allowedFileTypes: accept });
      if (paths.length === 0) return null;
      return rpcClient.kbAddFiles({ kbId: kb.id, paths });
    },
    onSuccess: (res) => {
      invalidate();
      if (!res) return;
      setNotice(
        res.docs.length > 0
          ? { kind: "ok", text: t("kb.docs.addedCount", { count: String(res.docs.length) }) }
          : { kind: "error", text: t("kb.docs.addedNone") },
      );
    },
    onError: (e) => setNotice({ kind: "error", text: t("kb.docs.addFailed", { error: String(e) }) }),
  });

  const addFolderMutation = useMutation({
    mutationFn: async () => {
      const { paths } = await rpcClient.openFileDialog({
        canChooseFiles: false,
        canChooseDirectory: true,
        allowsMultipleSelection: false,
      });
      const dir = paths[0];
      if (!dir) return null;
      return rpcClient.kbAddFolder({ kbId: kb.id, path: dir });
    },
    onSuccess: (res) => {
      invalidate();
      if (!res) return;
      const skipped = res.skipped ?? 0;
      setNotice(
        res.docs.length === 0 && skipped === 0
          ? { kind: "error", text: t("kb.docs.addedNone") }
          : skipped > 0
            ? {
                kind: "ok",
                text: t("kb.docs.addedSkipped", {
                  added: String(res.docs.length),
                  skipped: String(skipped),
                }),
              }
            : { kind: "ok", text: t("kb.docs.addedCount", { count: String(res.docs.length) }) },
      );
    },
    onError: (e) => setNotice({ kind: "error", text: t("kb.docs.addFailed", { error: String(e) }) }),
  });

  const addNoteMutation = useMutation({
    mutationFn: () => rpcClient.kbAddNote({ kbId: kb.id, title: noteTitle, content: noteContent }),
    onSuccess: () => {
      invalidate();
      setNoteOpen(false);
      setNoteTitle("");
      setNoteContent("");
    },
    onError: (e) => setNotice({ kind: "error", text: t("kb.docs.addFailed", { error: String(e) }) }),
  });

  const addWebMutation = useMutation({
    mutationFn: () => rpcClient.kbAddWeb({ kbId: kb.id, url: webUrl }),
    onSuccess: () => {
      invalidate();
      setWebOpen(false);
      setWebUrl("");
    },
    onError: (e) => setNotice({ kind: "error", text: t("kb.docs.addFailed", { error: String(e) }) }),
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
  const totalDocs = docsQuery.data?.total ?? docs.length;
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

      {/* 导入结果 / 失败原因 / 列表截断提示 */}
      {notice ? (
        <div
          className={cn(
            "mx-6 mb-1 shrink-0 rounded-md border px-3 py-1.5 text-xs",
            notice.kind === "error"
              ? "border-destructive/30 bg-destructive/10 text-destructive"
              : "border-border bg-muted/50 text-muted-foreground",
          )}
        >
          {notice.text}
        </div>
      ) : totalDocs > docs.length ? (
        <div className="mx-6 mb-1 shrink-0 rounded-md border border-border bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
          {t("kb.docs.truncated", { shown: String(docs.length), total: String(totalDocs) })}
        </div>
      ) : null}

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
                onOpenImage={setViewerChunkId}
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

      {/* 行内缩略图的查看器：容器层单实例，受控打开，避免每行挂一个 Dialog。 */}
      <KbImageViewer chunkId={viewerChunkId} open={viewerChunkId != null} onClose={() => setViewerChunkId(null)} />
    </div>
  );
}
