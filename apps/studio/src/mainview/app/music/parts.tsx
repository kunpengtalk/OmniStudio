import { useEffect, useState } from "react";
import {
  Loader2Icon,
  TrashIcon,
  ChevronRightIcon,
  HistoryIcon,
  MusicIcon,
  BanIcon,
  PauseIcon,
} from "lucide-react";
import { AudioDownloadButton, audioFileName } from "@components/audio-download";
import { Button } from "@ui/button";
import { Badge } from "@ui/badge";
import { useT } from "@stores/ui-lang";
import { MediaSourceBadge } from "@components/media-source-badge";
import { useMusicStore } from "@stores/music";
import type { MusicRecordRow } from "../../../bun/music-gen";
import { cn } from "@/mainview/lib/utils";

/** 任务类型 → i18n 标签键。三档与 StepFun 的 task 取值一一对应。 */
export const TASK_LABELS: Record<"text_to_music" | "music_cover" | "vocal_to_music", string> = {
  text_to_music: "music.task.song",
  music_cover: "music.task.cover",
  vocal_to_music: "music.task.vocal",
};

/**
 * 后端档位。`local` 是**预留位**：设置面与记录字段都已就位，但引擎还没接
 * （见 bun/music-gen.ts 的 submitLocal），所以界面上明确标出来，不让人以为能直接用。
 */
export const BACKEND_ITEMS: {
  key: "cloud" | "local";
  label: string;
  reserved?: boolean;
}[] = [
  { key: "cloud", label: "music.backend.cloud" },
  { key: "local", label: "music.backend.local", reserved: true },
];

/** 输出格式档位：换厂商等于换协议，档位互不认（StepFun 五种 / MiniMax 三种）。 */
export const FORMATS: Record<"stepfun" | "minimax", readonly string[]> = {
  stepfun: ["mp3", "wav", "flac", "opus", "pcm"],
  minimax: ["mp3", "wav", "pcm"],
};

export const DEFAULT_FORMAT: Record<"stepfun" | "minimax", string> = {
  stepfun: "mp3",
  minimax: "mp3",
};

/**
 * 歌词结构标签（StepFun 文档「歌词结构标签」一节）。
 *
 * 插入时**独占一行**：文档明确写了「歌词结构标签需要独占一行」，跟在正文后面
 * 会被当成歌词内容唱出来。
 */
export const LYRIC_TAGS = [
  "[Intro]",
  "[Verse 1]",
  "[Pre-Chorus]",
  "[Chorus 1]",
  "[Bridge]",
  "[Instrumental]",
  "[Hook]",
  "[Break]",
  "[Drop]",
  "[Ad-lib]",
  "[Outro]",
];

/** 已用时长：一分钟内给秒，超过给 m:ss —— 长任务盯着看的是"跑了多久了"。 */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** 音频时长（毫秒 → m:ss）。估算值，界面上带 ~ 前缀的地方由调用方加。 */
export function formatDuration(ms: number | null): string {
  if (!ms || ms <= 0) return "";
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** 跑得久了给一句安抚：生音乐本身要数十秒到几分钟，别让人以为卡死了。 */
const SLOW_HINT_AFTER_SEC = 180;

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 显示名：歌名优先（用户自己起的），否则退回风格描述的前半段。 */
export function displayName(record: MusicRecordRow): string {
  return record.title?.trim() || record.caption?.trim() || "";
}

/**
 * 下载用的建议文件名：歌名优先（下载下来能认出来是哪首），否则退回记录 id。
 *
 * 走 `AudioDownloadButton`（= `saveAudioToFolder`）而不是 `saveImageToDownloads`：
 * 后者是**静默**的（直接拷进「下载」目录、结果只返回一个 `{ok}` 没人看），点了等于
 * 没反应 —— 真踩过。前者弹目录选择框、转圈、存完打绿勾并把路径放进 tooltip，
 * 与语音页完全一致。
 */
function downloadName(record: MusicRecordRow): string {
  return record.title?.trim() || `music-${record.id}`;
}

/** 音频条目的图标位：生成中显示转圈，其余显示音符。 */
export function MusicThumb({ record, className }: { record: MusicRecordRow; className?: string }) {
  return (
    <span
      className={cn(
        "flex items-center justify-center rounded bg-muted",
        record.status === "failed" && "text-destructive/70",
        className,
      )}
    >
      {record.status === "processing" ? (
        <Loader2Icon className="size-3.5 animate-spin text-primary" />
      ) : (
        <MusicIcon className="size-3.5 text-muted-foreground" />
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// 生成中的任务卡（等待时长 + 取消）
// ---------------------------------------------------------------------------

export function MusicTaskCard({
  record,
  onDelete,
}: {
  record: MusicRecordRow;
  onDelete: (id: number) => void;
}) {
  const t = useT();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, Math.round((now - record.createdAt) / 1000));

  return (
    <div className="flex w-full max-w-md flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Loader2Icon className="size-4 animate-spin text-primary" />
        {t("music.task.processing")}
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {t("music.task.elapsed").replace("{time}", formatElapsed(elapsed))}
        </span>
      </div>
      {/* 两家都不报进度（StepFun 的 query 没有进度字段、MiniMax 是一次阻塞请求），
          所以不给假的进度条，直说这一栏看的是等待时长。 */}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full w-full animate-pulse rounded-full bg-primary/35" />
      </div>
      <p className="text-[10px] text-muted-foreground">{t("music.task.noProgress")}</p>
      <div className="min-w-0">
        {displayName(record) && (
          <p className="truncate text-xs font-medium text-foreground/90">{displayName(record)}</p>
        )}
        <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {record.caption}
        </p>
      </div>
      {record.pollError ? (
        <p className="text-[11px] leading-relaxed text-amber-600/80 dark:text-amber-400/80">
          {record.pollError}
          {t("music.task.retryHint")}
        </p>
      ) : elapsed >= SLOW_HINT_AFTER_SEC ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">{t("music.task.slowHint")}</p>
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
          {t("music.task.cancel")}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 失败卡
// ---------------------------------------------------------------------------

export function MusicFailedCard({
  record,
  onDelete,
}: {
  record: MusicRecordRow;
  onDelete: (id: number) => void;
}) {
  const t = useT();
  return (
    <div className="flex w-full max-w-md flex-col gap-2 rounded-xl border bg-card p-4">
      <Badge variant="destructive" className="w-fit text-[10px]">
        {t("music.error")}
      </Badge>
      {displayName(record) && (
        <p className="text-xs font-medium text-foreground/90">{displayName(record)}</p>
      )}
      <p className="line-clamp-2 text-xs leading-relaxed text-foreground/85">{record.caption}</p>
      <p className="line-clamp-5 text-[11px] leading-relaxed text-destructive/80">{record.error}</p>
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
// 播放卡（生成完成的主展示区）：播放器 + 歌词 + 元信息
// ---------------------------------------------------------------------------

export function MusicPlayerCard({
  record,
  onDelete,
}: {
  record: MusicRecordRow;
  onDelete: (id: number) => void;
}) {
  const t = useT();
  // 歌词优先显示上游改写后的那份：用户拿到的是"实际唱出来的词"，
  // 自己填的那份已经随记录存着，不必在结果区再占一块。
  const lyrics = record.rewrittenLyrics?.trim() || record.lyrics?.trim() || "";

  return (
    <div className="flex min-w-0 max-w-3xl flex-col gap-3">
      <div className="flex flex-col gap-4 rounded-xl border bg-card p-5 shadow-sm">
        <div className="flex items-start gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/12">
            <MusicIcon className="size-5 text-primary" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {displayName(record) || t("music.untitled")}
            </p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] tabular-nums text-muted-foreground">
              {record.instrumental && <span>{t("music.instrumentalShort")}</span>}
              {record.model && <span className="truncate">{record.model}</span>}
              {record.durationMs ? <span>~{formatDuration(record.durationMs)}</span> : null}
              {record.sampleRate ? <span>{Math.round(record.sampleRate / 1000)}kHz</span> : null}
              {record.responseFormat && <span>{record.responseFormat}</span>}
            </p>
          </div>
        </div>

        <audio
          key={record.id}
          src={record.audioUrl ?? undefined}
          controls
          preload="metadata"
          className="w-full"
        />

        <p className="text-[11px] leading-relaxed text-muted-foreground">{record.caption}</p>

        {lyrics && (
          <details className="rounded-lg border bg-muted/30">
            <summary className="cursor-pointer px-3 py-2 text-[11px] font-medium text-muted-foreground">
              {t("music.result.lyrics")}
            </summary>
            <pre className="max-h-64 overflow-y-auto px-3 pb-3 font-sans text-[11px] leading-relaxed whitespace-pre-wrap text-foreground/85">
              {lyrics}
            </pre>
          </details>
        )}
      </div>

      <div className="flex items-start justify-between gap-3">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] tabular-nums text-muted-foreground">
          <span>{formatTime(record.createdAt)}</span>
          {record.rewrittenCaption && (
            <span className="max-w-md truncate" title={record.rewrittenCaption}>
              {t("music.result.rewritten")}
            </span>
          )}
        </p>
        <div className="flex shrink-0 items-center gap-1">
          <AudioDownloadButton
            url={record.audioUrl!}
            filename={audioFileName(record.audioUrl!, downloadName(record))}
          />
          <Button
            variant="outline"
            size="icon-sm"
            tooltip={t("music.result.delete")}
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
// 最近成功生成（结果区底部）+ 更多入口
// ---------------------------------------------------------------------------

export const RECENT_COUNT = 6;

export function RecentStrip({
  records,
  onOpenHistory,
}: {
  records: MusicRecordRow[];
  onOpenHistory: () => void;
}) {
  const t = useT();
  const setFocusRecordId = useMusicStore((s) => s.setFocusRecordId);
  const recent = records.filter((r) => r.status === "done" && r.audioUrl).slice(0, RECENT_COUNT);
  if (recent.length === 0) return null;
  return (
    <div className="flex shrink-0 items-center gap-3 border-t bg-card/40 px-6 py-3">
      <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <HistoryIcon className="size-3.5" />
        {t("music.recent.title")}
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
        {recent.map((r) => (
          <button
            key={r.id}
            type="button"
            title={displayName(r) || undefined}
            onClick={() => setFocusRecordId(r.id)}
            className={cn(
              "flex h-14 w-32 shrink-0 items-center gap-2 rounded-lg border px-2 text-left transition",
              "hover:border-primary/60 hover:ring-2 hover:ring-primary/30",
            )}
          >
            <MusicThumb record={r} className="size-8 shrink-0" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[11px] leading-snug text-foreground/85">
                {displayName(r) || t("music.untitled")}
              </span>
              <span className="text-[9px] tabular-nums text-muted-foreground">
                {formatDuration(r.durationMs) ? `~${formatDuration(r.durationMs)}` : ""}
              </span>
            </span>
          </button>
        ))}
      </div>
      <Button
        variant="outline"
        size="sm"
        className="h-7 shrink-0 gap-1 text-[11px]"
        onClick={onOpenHistory}
      >
        {t("music.recent.more")}
        <ChevronRightIcon className="size-3.5" />
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 全部历史页
// ---------------------------------------------------------------------------

export function HistoryCard({
  record,
  onOpen,
  onDelete,
}: {
  record: MusicRecordRow;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const [playing, setPlaying] = useState(false);
  return (
    <div className="group flex flex-col gap-2">
      <div className="relative flex h-28 flex-col justify-between overflow-hidden rounded-xl border bg-muted/40 p-3">
        <div className="flex items-start gap-2">
          <MusicThumb record={record} className="size-9 shrink-0" />
          <button
            type="button"
            className="min-w-0 flex-1 text-left"
            title={record.caption ?? undefined}
            onClick={onOpen}
          >
            <span className="line-clamp-2 text-[12px] font-medium leading-snug text-foreground/90">
              {displayName(record) || t("music.untitled")}
            </span>
            <span className="mt-0.5 block text-[10px] tabular-nums text-muted-foreground">
              {[t(TASK_LABELS[record.task ?? "text_to_music"]), record.model ?? ""]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </button>
        </div>

        {record.status === "done" && record.audioUrl ? (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon-sm"
              tooltip={playing ? t("music.history.pause") : t("music.history.play")}
              onClick={() => setPlaying((v) => !v)}
            >
              {playing ? <PauseIcon className="size-3.5" /> : <MusicIcon className="size-3.5" />}
            </Button>
            {playing && (
              // 历史卡片上的试听：不占结果区，切走就停（组件卸载即停）。
              <audio autoPlay src={record.audioUrl} controls className="h-7 min-w-0 flex-1" />
            )}
          </div>
        ) : (
          <span className="text-[10px] text-muted-foreground">
            {record.status === "processing" ? t("music.status.processing") : t("music.error")}
          </span>
        )}

        <div className="absolute top-2 right-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {record.audioUrl && (
            <AudioDownloadButton
              url={record.audioUrl}
              filename={audioFileName(record.audioUrl, downloadName(record))}
              className="text-foreground"
            />
          )}
          <Button variant="secondary" size="icon-sm" tooltip={t("music.result.delete")} onClick={onDelete}>
            <TrashIcon className="size-3.5" />
          </Button>
        </div>
      </div>
      <p className="-mt-1 flex items-center gap-1 text-[10px] tabular-nums text-muted-foreground">
        <span className="truncate">{formatTime(record.createdAt)}</span>
        {record.durationMs ? (
          <>
            <span className="shrink-0">·</span>
            <span className="shrink-0">~{formatDuration(record.durationMs)}</span>
          </>
        ) : null}
        <MediaSourceBadge source={record.source} className="ml-auto" />
      </p>
    </div>
  );
}
