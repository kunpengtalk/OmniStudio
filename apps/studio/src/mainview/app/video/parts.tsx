import { useEffect, useState } from "react";
import { Loader2Icon, DownloadIcon, TrashIcon, ChevronRightIcon, HistoryIcon, FilmIcon, BanIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Badge } from "@ui/badge";
import { useT } from "@stores/ui-lang";
import { MediaSourceBadge } from "@components/media-source-badge";
import { useVideoStore } from "@stores/video";
import type { VideoGenBackend, VideoRecordRow } from "../../../bun/video-gen";
import { cn } from "@/mainview/lib/utils";

export const RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"];

export const COMFY_SIZES: Record<string, { width: number; height: number }> = {
  "16:9": { width: 832, height: 480 },
  "9:16": { width: 480, height: 832 },
  "1:1": { width: 640, height: 640 },
  "4:3": { width: 704, height: 528 },
  "3:4": { width: 528, height: 704 },
};

/** 时长范围按接口协议给：云端厂商在设置里选了 MiniMax / Seedance 协议。 */
export const DURATION_RANGE: Record<"minimax" | "seedance" | "comfyui", { min: number; max: number }> = {
  minimax: { min: 6, max: 10 },
  seedance: { min: 3, max: 12 },
  comfyui: { min: 3, max: 15 },
};

/**
 * 有固定档位的协议用按钮选、不给滑块：MiniMax 的 Hailuo 系只认 6 / 10 秒，
 * 滑块停在 7、8、9 秒就是等着上游回参数错误（视频那边也会再收敛一次）。
 */
export const DURATION_OPTIONS: Partial<Record<"minimax" | "seedance" | "comfyui", number[]>> = {
  minimax: [6, 10],
};

/** 把时长收敛到该协议合法的档位：有固定档位取最近的（等距取长的那档），没有就按 range 夹。 */
export function snapDuration(
  protocol: "minimax" | "seedance" | "comfyui",
  seconds: number,
): number {
  const options = DURATION_OPTIONS[protocol];
  if (options?.length) {
    return options.reduce(
      (best, cur) => (Math.abs(cur - seconds) <= Math.abs(best - seconds) ? cur : best),
      options[0]!,
    );
  }
  const range = DURATION_RANGE[protocol];
  return Math.min(Math.max(Math.round(seconds), range.min), range.max);
}

export const RESOLUTIONS: Record<"minimax" | "seedance", string[]> = {
  minimax: ["768P", "1080P", "720P"],
  seedance: ["480p", "720p", "1080p"],
};

/** 换协议时的默认分辨率（各家档位互不认，切过去要落到一个合法值）。 */
export const DEFAULT_RESOLUTION: Record<"minimax" | "seedance", string> = {
  minimax: "768P",
  seedance: "720p",
};

/** 已用时长：一分钟内给秒，超过给 m:ss —— 长任务盯着看的是"跑了多久了"。 */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** 跑得久了给一句安抚：上游排队 / 生成时间长是常态，别让人以为卡死了。 */
const SLOW_HINT_AFTER_SEC = 180;

export const BACKEND_ITEMS: { key: VideoGenBackend; label: string }[] = [
  { key: "cloud", label: "video.backend.cloud" },
  { key: "comfyui", label: "video.backend.comfyui" },
];

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function downloadVideo(url: string, record: VideoRecordRow) {
  const ext = url.split("?")[0]!.split(".").pop() || "mp4";
  void rpcClient.saveImageToDownloads({
    url,
    filename: `video-${record.id}-${Date.now()}.${ext}`,
  });
}

/** 视频缩略图：preload=metadata + #t=0.1 让 webkit 渲染首帧。 */
export function VideoThumb({ record, className }: { record: VideoRecordRow; className?: string }) {
  if (record.videoUrl) {
    return (
      <video
        src={`${record.videoUrl}#t=0.1`}
        muted
        preload="metadata"
        className={cn("bg-muted object-cover", className)}
      />
    );
  }
  return (
    <span className={cn("flex items-center justify-center bg-muted", className)}>
      <FilmIcon className="size-4 text-muted-foreground" />
    </span>
  );
}

// ---------------------------------------------------------------------------
// 生成中的任务卡（进度 + 已用时间 + 取消）
// ---------------------------------------------------------------------------

export function VideoTaskCard({
  record,
  onDelete,
}: {
  record: VideoRecordRow;
  onDelete: (id: number) => void;
}) {
  const t = useT();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, Math.round((now - record.createdAt) / 1000));
  const pct = record.progress != null ? Math.round(record.progress * 100) : null;

  return (
    <div className="flex w-full max-w-md flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Loader2Icon className="size-4 animate-spin text-primary" />
        {t("video.task.processing")}
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {t("video.task.elapsed").replace("{time}", formatElapsed(elapsed))}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-500"
            style={pct != null ? { width: `${pct}%` } : { width: "100%", opacity: 0.35 }}
          />
        </div>
        {pct != null ? (
          <p className="text-right text-[10px] tabular-nums text-muted-foreground">{pct}%</p>
        ) : (
          // 上游不报进度（MiniMax 就不报）：别装作有进度，直说这一栏看的是等待时长
          <p className="text-[10px] text-muted-foreground">{t("video.task.noProgress")}</p>
        )}
      </div>
      <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
        {record.prompt}
      </p>
      {record.pollError ? (
        <p className="text-[11px] leading-relaxed text-amber-600/80 dark:text-amber-400/80">
          {record.pollError}
          {t("video.task.retryHint")}
        </p>
      ) : elapsed >= SLOW_HINT_AFTER_SEC ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t("video.task.slowHint")}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[10px] text-muted-foreground">{record.model}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground"
          onClick={() => onDelete(record.id)}
        >
          <BanIcon className="size-3" />
          {t("video.task.cancel")}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 失败卡
// ---------------------------------------------------------------------------

export function VideoFailedCard({
  record,
  onDelete,
}: {
  record: VideoRecordRow;
  onDelete: (id: number) => void;
}) {
  const t = useT();
  return (
    <div className="flex w-full max-w-md flex-col gap-2 rounded-xl border bg-card p-4">
      <Badge variant="destructive" className="w-fit text-[10px]">
        {t("video.error")}
      </Badge>
      <p className="line-clamp-2 text-xs leading-relaxed text-foreground/85">{record.prompt}</p>
      <p className="line-clamp-4 text-[11px] leading-relaxed text-destructive/80">
        {record.error}
      </p>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {formatTime(record.createdAt)}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground"
          onClick={() => onDelete(record.id)}
        >
          <TrashIcon className="size-3" />
          {t("common.delete")}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 播放卡（生成完成的主展示区）
// ---------------------------------------------------------------------------

export function VideoPlayerCard({
  record,
  onDelete,
}: {
  record: VideoRecordRow;
  onDelete: (id: number) => void;
}) {
  const t = useT();
  return (
    <div className="flex min-w-0 max-w-3xl flex-col gap-3">
      <div className="overflow-hidden rounded-xl border bg-black shadow-sm">
        <video
          key={record.id}
          src={record.videoUrl!}
          controls
          playsInline
          className="max-h-[68vh] w-full bg-black"
        />
      </div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p
            className="line-clamp-2 text-xs leading-relaxed text-foreground/85"
            title={record.prompt ?? undefined}
          >
            {record.prompt}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] tabular-nums text-muted-foreground">
            {record.model && <span className="truncate">{record.model}</span>}
            {record.duration ? <span>{record.duration}s</span> : null}
            {record.ratio ? <span>{record.ratio}</span> : null}
            {record.resolution ? <span>{record.resolution}</span> : null}
            <span>{formatTime(record.createdAt)}</span>
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            variant="outline"
            size="sm"
            className="gap-1 text-[11px]"
            onClick={() => downloadVideo(record.videoUrl!, record)}
          >
            <DownloadIcon className="size-3.5" />
            {t("video.result.download")}
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            tooltip={t("video.result.delete")}
            className="text-muted-foreground hover:text-destructive"
            onClick={() => onDelete(record.id)}
          >
            <TrashIcon className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 最近成功生成的视频条（结果区底部）+ 更多入口
// ---------------------------------------------------------------------------

export const RECENT_COUNT = 6;

export function RecentStrip({
  records,
  onOpenHistory,
}: {
  records: VideoRecordRow[];
  onOpenHistory: () => void;
}) {
  const t = useT();
  const setFocusRecordId = useVideoStore((s) => s.setFocusRecordId);
  const recent = records.filter((r) => r.status === "done" && r.videoUrl).slice(0, RECENT_COUNT);
  if (recent.length === 0) return null;
  return (
    <div className="flex shrink-0 items-center gap-3 border-t bg-card/40 px-6 py-3">
      <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <HistoryIcon className="size-3.5" />
        {t("video.recent.title")}
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
        {recent.map((r) => (
          <button
            key={r.id}
            type="button"
            title={r.prompt ?? undefined}
            onClick={() => setFocusRecordId(r.id)}
            className="aspect-video h-14 shrink-0 overflow-hidden rounded-lg border transition hover:border-primary/60 hover:ring-2 hover:ring-primary/30"
          >
            <VideoThumb record={r} className="size-full" />
          </button>
        ))}
      </div>
      <Button
        variant="outline"
        size="sm"
        className="h-7 shrink-0 gap-1 text-[11px]"
        onClick={onOpenHistory}
      >
        {t("video.recent.more")}
        <ChevronRightIcon className="size-3.5" />
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 全部历史页：所有生成过的视频
// ---------------------------------------------------------------------------

export function HistoryCard({
  record,
  onOpen,
  onDelete,
}: {
  record: VideoRecordRow;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  return (
    <div className="group flex flex-col gap-2">
      <div className="relative aspect-video overflow-hidden rounded-xl border bg-muted/40">
        <button type="button" className="size-full" title={record.prompt ?? undefined} onClick={onOpen}>
          <VideoThumb record={record} className="size-full" />
        </button>
        <span className="pointer-events-none absolute left-2 top-2 rounded-md bg-black/55 px-1.5 py-0.5 text-[9px] font-medium text-white">
          {record.duration ? `${record.duration}s` : ""}
          {record.ratio ? ` · ${record.ratio}` : ""}
        </span>
        <div className="absolute top-2 right-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <Button
            variant="secondary"
            size="icon-sm"
            tooltip={t("video.result.download")}
            onClick={() => downloadVideo(record.videoUrl!, record)}
            className="bg-black/50 text-white hover:bg-black/70"
          >
            <DownloadIcon className="size-3.5" />
          </Button>
          <Button
            variant="secondary"
            size="icon-sm"
            tooltip={t("video.result.delete")}
            onClick={onDelete}
            className="bg-black/50 text-white hover:bg-black/70"
          >
            <TrashIcon className="size-3.5" />
          </Button>
        </div>
      </div>
      <p
        className="line-clamp-2 min-h-8 text-[11px] leading-snug text-foreground/85"
        title={record.prompt ?? undefined}
      >
        {record.prompt || t("video.error")}
      </p>
      <p className="-mt-1 flex items-center gap-1 text-[10px] tabular-nums text-muted-foreground">
        <span className="truncate">{formatTime(record.createdAt)}</span>
        {record.model && (
          <>
            <span className="shrink-0">·</span>
            <span className="truncate">{record.model}</span>
          </>
        )}
        <MediaSourceBadge source={record.source} className="ml-auto" />
      </p>
    </div>
  );
}

