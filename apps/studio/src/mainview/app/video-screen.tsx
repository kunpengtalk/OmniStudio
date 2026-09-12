import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  SparklesIcon,
  Loader2Icon,
  EraserIcon,
  DownloadIcon,
  TrashIcon,
  ClapperboardIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  HistoryIcon,
  FilmIcon,
  ImagePlusIcon,
  XIcon,
  BanIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { ScrollArea } from "@ui/scroll-area";
import { Spinner } from "@ui/spinner";
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
import { Badge } from "@ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@ui/collapsible";
import { Switch } from "@ui/switch";
import { useT } from "@stores/ui-lang";
import { MediaSourceBadge, MediaSourceFilter } from "@components/media-source-badge";
import { useVideoStore } from "@stores/video";
import type { VideoGenBackend, VideoRecordRow } from "../../bun/video-gen";
import type { MediaSource } from "../../bun/db/schema";
import { cn } from "@/mainview/lib/utils";

// ---------------------------------------------------------------------------
// 常量（与 bun/video-gen.ts 保持同步的本地镜像，主进程值不打进前端包）
// ---------------------------------------------------------------------------

const RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"];

const COMFY_SIZES: Record<string, { width: number; height: number }> = {
  "16:9": { width: 832, height: 480 },
  "9:16": { width: 480, height: 832 },
  "1:1": { width: 640, height: 640 },
  "4:3": { width: 704, height: 528 },
  "3:4": { width: 528, height: 704 },
};

const DURATION_RANGE: Record<VideoGenBackend, { min: number; max: number }> = {
  minimax: { min: 4, max: 15 },
  seedance: { min: 3, max: 12 },
  comfyui: { min: 3, max: 15 },
};

const RESOLUTIONS: Record<"minimax" | "seedance", string[]> = {
  minimax: ["480P", "768P", "2K"],
  seedance: ["480p", "720p", "1080p"],
};

/** 云端任务轮询间隔（应用重启后列表里的 processing 记录会继续轮询）。 */
const POLL_INTERVAL_MS = 5000;

const BACKEND_ITEMS: { key: VideoGenBackend; label: string }[] = [
  { key: "comfyui", label: "video.backend.comfyui" },
  { key: "minimax", label: "video.backend.minimax" },
  { key: "seedance", label: "video.backend.seedance" },
];

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ResultError({ error }: { error?: string }) {
  if (!error) return null;
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
      {error}
    </div>
  );
}

function downloadVideo(url: string, record: VideoRecordRow) {
  const ext = url.split("?")[0]!.split(".").pop() || "mp4";
  void rpcClient.saveImageToDownloads({
    url,
    filename: `video-${record.id}-${Date.now()}.${ext}`,
  });
}

/** 视频缩略图：preload=metadata + #t=0.1 让 webkit 渲染首帧。 */
function VideoThumb({ record, className }: { record: VideoRecordRow; className?: string }) {
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

function VideoTaskCard({
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
          {t("video.task.elapsed").replace("{sec}", String(elapsed))}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-500"
            style={pct != null ? { width: `${pct}%` } : { width: "100%", opacity: 0.35 }}
          />
        </div>
        {pct != null && (
          <p className="text-right text-[10px] tabular-nums text-muted-foreground">{pct}%</p>
        )}
      </div>
      <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
        {record.prompt}
      </p>
      {record.pollError && (
        <p className="text-[11px] leading-relaxed text-amber-600/80 dark:text-amber-400/80">
          {record.pollError}
          {t("video.task.retryHint")}
        </p>
      )}
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

function VideoFailedCard({
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

function VideoPlayerCard({
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

const RECENT_COUNT = 6;

function RecentStrip({
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

function HistoryCard({
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

function HistoryScreen() {
  const t = useT();
  const { setView, setFocusRecordId } = useVideoStore();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["video-records"],
    queryFn: () => rpcClient.listVideoRecords(undefined),
  });
  const [toDelete, setToDelete] = useState<VideoRecordRow | null>(null);
  const [source, setSource] = useState<MediaSource | "all">("all");
  const del = useMutation({
    mutationFn: (id: number) => rpcClient.deleteVideoRecord({ id }),
    onSuccess: () => {
      setToDelete(null);
      queryClient.invalidateQueries({ queryKey: ["video-records"] });
    },
  });
  const records = (data?.records ?? [])
    .filter((r) => r.status === "done" && r.videoUrl)
    .filter((r) => source === "all" || r.source === source);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2.5 border-b px-5 py-3">
        <Button
          variant="ghost"
          size="icon-sm"
          tooltip={t("common.back")}
          onClick={() => setView("generate")}
        >
          <ChevronLeftIcon className="size-4" />
        </Button>
        <h1 className="text-sm font-semibold">{t("video.history.title")}</h1>
        <Badge variant="secondary" className="h-5 text-[10px]">
          {records.length}
        </Badge>
        <MediaSourceFilter value={source} onChange={setSource} className="ml-auto" />
      </div>

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="size-4" />
        </div>
      ) : records.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <div className="flex size-20 items-center justify-center rounded-2xl bg-primary/15">
            <ClapperboardIcon className="size-9 text-primary" />
          </div>
          <p className="text-lg font-medium">{t("video.history.empty")}</p>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="grid grid-cols-2 gap-x-5 gap-y-6 p-5 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {records.map((r) => (
              <HistoryCard
                key={r.id}
                record={r}
                onOpen={() => {
                  setView("generate");
                  setFocusRecordId(r.id);
                }}
                onDelete={() => setToDelete(r)}
              />
            ))}
          </div>
        </ScrollArea>
      )}

      <Dialog open={!!toDelete} onOpenChange={(open) => !open && setToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("video.history.deleteTitle")}</DialogTitle>
            <DialogDescription>{t("video.history.deleteDesc")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setToDelete(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={del.isPending}
              onClick={() => toDelete && del.mutate(toDelete.id)}
            >
              {del.isPending ? (
                <Loader2Icon data-icon="inline-start" className="animate-spin" />
              ) : (
                <TrashIcon data-icon="inline-start" />
              )}
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 视频 Tab：左 340px 配置栏 + 右结果区
// ---------------------------------------------------------------------------

function GenerateTab() {
  const t = useT();
  const queryClient = useQueryClient();
  const focusRecordId = useVideoStore((s) => s.focusRecordId);
  const setFocusRecordId = useVideoStore((s) => s.setFocusRecordId);
  const setView = useVideoStore((s) => s.setView);

  const [prompt, setPrompt] = useState("");
  const [negative, setNegative] = useState("");
  const [ratioIdx, setRatioIdx] = useState(0); // 16:9
  const [duration, setDuration] = useState(5);
  const [resolution, setResolution] = useState("768P");
  const [steps, setSteps] = useState(20);
  const [cfg, setCfg] = useState(5);
  const [seed, setSeed] = useState("");
  const [watermark, setWatermark] = useState(false);
  const [firstFrame, setFirstFrame] = useState<{ ref: string; url: string }>();

  // 提示词库「去试试」带入的草稿：挂载时预填提示词框。
  const pendingPrompt = useVideoStore((s) => s.pendingPrompt);
  useEffect(() => {
    if (!pendingPrompt) return;
    setPrompt(pendingPrompt);
    useVideoStore.getState().setPendingPrompt(null);
  }, [pendingPrompt]);

  // ---------- 后端配置 ----------
  const [backend, setBackend] = useState<VideoGenBackend>("minimax");
  const [minimaxBase, setMinimaxBase] = useState("");
  const [minimaxKey, setMinimaxKey] = useState("");
  const [minimaxModel, setMinimaxModel] = useState("");
  const [seedanceBase, setSeedanceBase] = useState("");
  const [seedanceKey, setSeedanceKey] = useState("");
  const [seedanceModel, setSeedanceModel] = useState("");
  const [comfyBase, setComfyBase] = useState("");
  const [comfyCkpt, setComfyCkpt] = useState("");
  const [comfyClip, setComfyClip] = useState("");
  const [comfyVae, setComfyVae] = useState("");
  const [configError, setConfigError] = useState<string>();
  const hydrated = useRef(false);

  const { data: configData } = useQuery({
    queryKey: ["video-gen-config"],
    queryFn: () => rpcClient.getVideoGenConfig(undefined),
  });
  const config = configData?.config;

  useEffect(() => {
    if (!config || hydrated.current) return;
    hydrated.current = true;
    setBackend(config.backend);
    setMinimaxBase(config.minimaxBase);
    setMinimaxKey(config.minimaxKey);
    setMinimaxModel(config.minimaxModel);
    setSeedanceBase(config.seedanceBase);
    setSeedanceKey(config.seedanceKey);
    setSeedanceModel(config.seedanceModel);
    setComfyBase(config.comfyBase);
    setComfyCkpt(config.comfyCkpt);
    setComfyClip(config.comfyClip);
    setComfyVae(config.comfyVae);
  }, [config]);

  const switchBackend = (key: VideoGenBackend) => {
    setBackend(key);
    // 切后端时收敛时长与分辨率到该后端支持的档位。
    const range = DURATION_RANGE[key];
    setDuration((d) => Math.min(Math.max(d, range.min), range.max));
    if (key === "minimax" && !RESOLUTIONS.minimax.includes(resolution)) setResolution("768P");
    if (key === "seedance" && !RESOLUTIONS.seedance.includes(resolution)) setResolution("720p");
    void rpcClient.saveVideoGenConfig({ backend: key });
  };

  const saveConfig = useMutation({
    mutationFn: () =>
      rpcClient.saveVideoGenConfig({
        backend,
        minimaxBase: minimaxBase.trim(),
        minimaxKey: minimaxKey.trim(),
        minimaxModel: minimaxModel.trim(),
        seedanceBase: seedanceBase.trim(),
        seedanceKey: seedanceKey.trim(),
        seedanceModel: seedanceModel.trim(),
        comfyBase: comfyBase.trim(),
        comfyCkpt: comfyCkpt.trim(),
        comfyClip: comfyClip.trim(),
        comfyVae: comfyVae.trim(),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["video-gen-config"] }),
  });

  const configured =
    backend === "comfyui"
      ? !!comfyBase.trim()
      : backend === "minimax"
        ? !!minimaxBase.trim()
        : !!seedanceBase.trim() && !!seedanceKey.trim();

  const fetchModels = useMutation({
    mutationFn: () =>
      rpcClient.listVideoGenModels({
        backend,
        base:
          backend === "comfyui"
            ? comfyBase.trim()
            : backend === "minimax"
              ? minimaxBase.trim()
              : seedanceBase.trim(),
      }),
    onSuccess: (r) => {
      if (r.error) {
        setConfigError(r.error);
        return;
      }
      setConfigError(undefined);
      // ComfyUI：未手填的模型名自动挑最像 Wan 的；云端：仅在空时填第一个预设。
      if (backend === "comfyui") {
        const pick = (list: string[], re: RegExp) => list.find((n) => re.test(n)) ?? list[0] ?? "";
        setComfyCkpt((v) => v.trim() || pick(r.checkpoints, /wan/i));
        setComfyClip((v) => v.trim() || pick(r.clips, /umt5|wan/i));
        setComfyVae((v) => v.trim() || pick(r.vaes, /wan/i));
      } else if (backend === "minimax") {
        setMinimaxModel((v) => v.trim() || (r.models[0] ?? ""));
      } else {
        setSeedanceModel((v) => v.trim() || (r.models[0] ?? ""));
      }
    },
    onError: (e) => setConfigError(String(e)),
  });

  const { data: modelsData } = useQuery({
    queryKey: ["video-gen-models", backend],
    queryFn: () => rpcClient.listVideoGenModels({ backend }),
    enabled: configured,
  });
  const cloudModels = modelsData?.models ?? [];
  const comfyCheckpoints = modelsData?.checkpoints ?? [];
  const comfyClips = modelsData?.clips ?? [];
  const comfyVaes = modelsData?.vaes ?? [];

  // ---------- 首帧图（图生视频，仅云端后端） ----------
  const pickFirstFrame = useMutation({
    mutationFn: async () => {
      const { paths } = await rpcClient.openFileDialog({
        allowedFileTypes: "png,jpg,jpeg,webp",
      });
      if (paths.length === 0) return undefined;
      const { files } = await rpcClient.stageEditImage({ paths });
      return files[0];
    },
    onSuccess: (file) => {
      if (file) setFirstFrame(file);
    },
    onError: (e) => setConfigError(String(e)),
  });

  // ---------- 记录与轮询 ----------
  const { data: recordsData } = useQuery({
    queryKey: ["video-records"],
    queryFn: () => rpcClient.listVideoRecords(undefined),
  });
  const records = recordsData?.records ?? [];
  const processingIds = records
    .filter((r) => r.status === "processing")
    .map((r) => r.id)
    .join(",");

  const { data: pollData } = useQuery({
    queryKey: ["video-poll", processingIds],
    queryFn: () =>
      rpcClient.pollVideoRecords({
        ids: processingIds.split(",").filter(Boolean).map(Number),
      }),
    enabled: processingIds.length > 0,
    refetchInterval: POLL_INTERVAL_MS,
  });
  useEffect(() => {
    if (!pollData) return;
    queryClient.invalidateQueries({ queryKey: ["video-records"] });
  }, [pollData, queryClient]);

  const del = useMutation({
    mutationFn: (id: number) => rpcClient.deleteVideoRecord({ id }),
    onSuccess: (_r, id) => {
      queryClient.invalidateQueries({ queryKey: ["video-records"] });
      if (focusRecordId === id) setFocusRecordId(null);
    },
  });

  // ---------- 生成 ----------
  const generate = useMutation({
    mutationFn: () => {
      const parsedSeed = Number.parseInt(seed, 10);
      const ratio = RATIOS[ratioIdx]!;
      const isCloud = backend !== "comfyui";
      return rpcClient.submitVideoGeneration({
        prompt,
        negativePrompt: backend === "comfyui" ? negative.trim() || undefined : undefined,
        duration,
        ratio,
        resolution: isCloud ? resolution : undefined,
        steps: backend === "comfyui" ? steps : undefined,
        cfg: backend === "comfyui" ? cfg : undefined,
        seed: Number.isFinite(parsedSeed) && parsedSeed > 0 ? parsedSeed : undefined,
        model: backend === "minimax"
          ? minimaxModel.trim() || undefined
          : backend === "seedance"
            ? seedanceModel.trim() || undefined
            : undefined,
        firstFrameRef: isCloud ? firstFrame?.ref : undefined,
        watermark: isCloud ? watermark : undefined,
        // 把页面上的实时配置一并带上，后端优先使用它们并落盘。
        config: {
          backend,
          minimaxBase: minimaxBase.trim(),
          minimaxKey: minimaxKey.trim(),
          minimaxModel: minimaxModel.trim(),
          seedanceBase: seedanceBase.trim(),
          seedanceKey: seedanceKey.trim(),
          seedanceModel: seedanceModel.trim(),
          comfyBase: comfyBase.trim(),
          comfyCkpt: comfyCkpt.trim(),
          comfyClip: comfyClip.trim(),
          comfyVae: comfyVae.trim(),
        },
      });
    },
    onSuccess: (r) => {
      if (r.error || !r.record) {
        setConfigError(r.error ?? "提交生成任务失败");
        return;
      }
      setConfigError(undefined);
      setFocusRecordId(r.record.id);
      queryClient.invalidateQueries({ queryKey: ["video-records"] });
    },
    onError: (e) => setConfigError(String(e)),
  });

  const canGenerate = !!prompt.trim() && !generate.isPending && configured;

  const range = DURATION_RANGE[backend];
  const clampedDuration = Math.min(Math.max(duration, range.min), range.max);
  const ratio = RATIOS[ratioIdx]!;
  const comfySize = COMFY_SIZES[ratio] ?? COMFY_SIZES["16:9"]!;
  // 展示的记录：聚焦的记录，否则最新一条。
  const display = records.find((r) => r.id === focusRecordId) ?? records[0];

  return (
    <div className="flex h-full min-h-0">
      {/* 中间：参数面板 */}
      <aside className="w-[340px] shrink-0 overflow-y-auto border-r p-4">
        <div className="flex flex-col gap-5">
          {/* 后端切换 */}
          <div>
            <Label className="mb-1.5 block text-xs">{t("video.backend")}</Label>
            <div className="flex overflow-hidden rounded-lg border">
              {BACKEND_ITEMS.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => switchBackend(key)}
                  className={cn(
                    "flex-1 px-3 py-1.5 text-xs transition-colors",
                    backend === key
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {t(label)}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              {t(
                backend === "comfyui"
                  ? "video.backend.comfyuiDesc"
                  : backend === "minimax"
                    ? "video.backend.minimaxDesc"
                    : "video.backend.seedanceDesc",
              )}
            </p>
          </div>

          {/* 服务配置 */}
          <div className="flex flex-col gap-2.5 rounded-lg border bg-card p-3">
            {backend === "comfyui" ? (
              <>
                <div>
                  <Label htmlFor="video-comfy-base" className="mb-1 block text-xs">
                    {t("video.config.comfyBase")}
                  </Label>
                  <Input
                    id="video-comfy-base"
                    placeholder="http://127.0.0.1:8188"
                    value={comfyBase}
                    onChange={(e) => setComfyBase(e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
                <div>
                  <Label htmlFor="video-comfy-ckpt" className="mb-1 block text-xs">
                    {t("video.config.checkpoint")}
                  </Label>
                  <Input
                    id="video-comfy-ckpt"
                    list="video-comfy-ckpt-list"
                    placeholder="wan2.1_t2v_1.3b_fp16.safetensors"
                    value={comfyCkpt}
                    onChange={(e) => setComfyCkpt(e.target.value)}
                    className="h-8 text-xs"
                  />
                  {comfyCheckpoints.length > 0 && (
                    <datalist id="video-comfy-ckpt-list">
                      {comfyCheckpoints.map((m) => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label htmlFor="video-comfy-clip" className="mb-1 block text-xs">
                      {t("video.config.clip")}
                    </Label>
                    <Input
                      id="video-comfy-clip"
                      list="video-comfy-clip-list"
                      placeholder="umt5_xxl…"
                      value={comfyClip}
                      onChange={(e) => setComfyClip(e.target.value)}
                      className="h-8 text-xs"
                    />
                    {comfyClips.length > 0 && (
                      <datalist id="video-comfy-clip-list">
                        {comfyClips.map((m) => (
                          <option key={m} value={m} />
                        ))}
                      </datalist>
                    )}
                  </div>
                  <div>
                    <Label htmlFor="video-comfy-vae" className="mb-1 block text-xs">
                      {t("video.config.vae")}
                    </Label>
                    <Input
                      id="video-comfy-vae"
                      list="video-comfy-vae-list"
                      placeholder="wan_2.1_vae.safetensors"
                      value={comfyVae}
                      onChange={(e) => setComfyVae(e.target.value)}
                      className="h-8 text-xs"
                    />
                    {comfyVaes.length > 0 && (
                      <datalist id="video-comfy-vae-list">
                        {comfyVaes.map((m) => (
                          <option key={m} value={m} />
                        ))}
                      </datalist>
                    )}
                  </div>
                </div>
              </>
            ) : backend === "minimax" ? (
              <>
                <div>
                  <Label htmlFor="video-minimax-base" className="mb-1 block text-xs">
                    {t("video.config.base")}
                  </Label>
                  <Input
                    id="video-minimax-base"
                    placeholder="https://api.minimaxi.com"
                    value={minimaxBase}
                    onChange={(e) => setMinimaxBase(e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
                <div>
                  <Label htmlFor="video-minimax-key" className="mb-1 block text-xs">
                    {t("video.config.apiKey")}
                  </Label>
                  <Input
                    id="video-minimax-key"
                    type="password"
                    placeholder="eyJ… / Bearer Token"
                    value={minimaxKey}
                    onChange={(e) => setMinimaxKey(e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
                <div>
                  <Label htmlFor="video-minimax-model" className="mb-1 block text-xs">
                    {t("video.config.model")}
                  </Label>
                  <Input
                    id="video-minimax-model"
                    list="video-minimax-model-list"
                    placeholder="MiniMax-H3"
                    value={minimaxModel}
                    onChange={(e) => setMinimaxModel(e.target.value)}
                    className="h-8 text-xs"
                  />
                  {cloudModels.length > 0 && (
                    <datalist id="video-minimax-model-list">
                      {cloudModels.map((m) => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
                  )}
                </div>
              </>
            ) : (
              <>
                <div>
                  <Label htmlFor="video-seedance-base" className="mb-1 block text-xs">
                    {t("video.config.base")}
                  </Label>
                  <Input
                    id="video-seedance-base"
                    placeholder="https://ark.cn-beijing.volces.com/api/v3"
                    value={seedanceBase}
                    onChange={(e) => setSeedanceBase(e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
                <div>
                  <Label htmlFor="video-seedance-key" className="mb-1 block text-xs">
                    {t("video.config.apiKey")}
                  </Label>
                  <Input
                    id="video-seedance-key"
                    type="password"
                    placeholder="ARK_API_KEY"
                    value={seedanceKey}
                    onChange={(e) => setSeedanceKey(e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
                <div>
                  <Label htmlFor="video-seedance-model" className="mb-1 block text-xs">
                    {t("video.config.model")}
                  </Label>
                  <Input
                    id="video-seedance-model"
                    list="video-seedance-model-list"
                    placeholder="doubao-seedance-1-0-lite-t2v-250428"
                    value={seedanceModel}
                    onChange={(e) => setSeedanceModel(e.target.value)}
                    className="h-8 text-xs"
                  />
                  {cloudModels.length > 0 && (
                    <datalist id="video-seedance-model-list">
                      {cloudModels.map((m) => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
                  )}
                </div>
              </>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => saveConfig.mutate()} disabled={saveConfig.isPending}>
                {saveConfig.isPending ? (
                  <Loader2Icon data-icon="inline-start" className="animate-spin" />
                ) : null}
                {t("video.config.save")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => fetchModels.mutate()}
                disabled={fetchModels.isPending || !configured}
              >
                {fetchModels.isPending ? (
                  <Loader2Icon data-icon="inline-start" className="animate-spin" />
                ) : null}
                {backend === "comfyui" ? t("video.config.fetchModels") : t("video.config.presetModels")}
              </Button>
              {configured && (
                <Badge variant="secondary" className="gap-1 text-[10px]">
                  <span className="size-2 rounded-full bg-emerald-500" />
                  {t("video.config.configured")}
                </Badge>
              )}
            </div>
            {configError && <ResultError error={configError} />}
          </div>

          {/* 提示词 */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <Label htmlFor="video-prompt" className="text-xs">
                {t("video.prompt")}
              </Label>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground"
                onClick={() => setPrompt("")}
              >
                <EraserIcon className="size-3" />
                {t("video.prompt.clear")}
              </Button>
            </div>
            <Textarea
              id="video-prompt"
              rows={6}
              placeholder={t("video.promptPlaceholder")}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="resize-none text-xs"
            />
          </div>

          {/* 首帧图（图生视频，仅云端后端） */}
          {backend !== "comfyui" &&
            (firstFrame ? (
              <div className="flex items-center gap-3 rounded-lg border bg-card p-2.5">
                <img
                  src={firstFrame.url}
                  alt="first frame"
                  className="size-14 shrink-0 rounded-md border object-cover"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium">{t("video.firstFrame")}</p>
                  <p className="text-[10px] leading-relaxed text-muted-foreground">
                    {t("video.firstFrame.hint")}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  tooltip={t("video.firstFrame.remove")}
                  onClick={() => setFirstFrame(undefined)}
                >
                  <XIcon className="size-3.5" />
                </Button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => pickFirstFrame.mutate()}
                className="flex items-center gap-2 rounded-lg border border-dashed bg-card/50 px-3 py-2.5 text-xs text-muted-foreground transition-colors hover:border-muted-foreground/50 hover:text-foreground"
              >
                {pickFirstFrame.isPending ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <ImagePlusIcon className="size-3.5" />
                )}
                {t("video.firstFrame.choose")}
                <span className="text-[10px]">（{t("video.firstFrame.optional")}）</span>
              </button>
            ))}

          {/* 参数 */}
          <div className="flex flex-col gap-3 rounded-lg border bg-card p-3">
            <p className="text-xs font-medium">{t("video.params")}</p>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <Label className="text-[11px] text-muted-foreground">
                  {t("video.params.duration")}
                </Label>
                <span className="text-[11px] tabular-nums text-foreground">
                  {clampedDuration}s
                </span>
              </div>
              <input
                type="range"
                min={range.min}
                max={range.max}
                step={1}
                value={clampedDuration}
                onChange={(e) => setDuration(Number(e.target.value))}
                className="w-full accent-primary"
              />
              <p className="mt-1 text-[10px] text-muted-foreground tabular-nums">
                {t("video.params.durationRange")
                  .replace("{min}", String(range.min))
                  .replace("{max}", String(range.max))}
                {backend === "comfyui" && ` · ${t("video.params.fps16")}`}
              </p>
            </div>

            <div>
              <Label className="mb-1.5 block text-[11px] text-muted-foreground">
                {t("video.params.ratio")}
              </Label>
              <div className="flex flex-wrap gap-1.5">
                {RATIOS.map((r, i) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRatioIdx(i)}
                    className={cn(
                      "rounded-md border px-2 py-1 text-[11px] tabular-nums transition-colors",
                      ratioIdx === i
                        ? "border-primary bg-primary/10 text-primary"
                        : "text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
                    )}
                  >
                    {r}
                  </button>
                ))}
              </div>
              {backend === "comfyui" && (
                <p className="mt-1.5 text-[10px] text-muted-foreground tabular-nums">
                  {comfySize.width}×{comfySize.height}
                </p>
              )}
            </div>

            {backend !== "comfyui" && (
              <div>
                <Label className="mb-1 block text-[11px] text-muted-foreground">
                  {t("video.params.resolution")}
                </Label>
                <Select value={resolution} onValueChange={setResolution}>
                  <SelectTrigger className="h-8 w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RESOLUTIONS[backend === "minimax" ? "minimax" : "seedance"].map((r) => (
                      <SelectItem key={r} value={r} className="text-xs">
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* 高级选项 */}
            <Collapsible>
              <CollapsibleTrigger className="group flex w-full items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground">
                <ChevronDownIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
                {t("video.params.advanced")}
              </CollapsibleTrigger>
              <CollapsibleContent className="flex flex-col gap-3 pt-3">
                {backend === "comfyui" ? (
                  <>
                    <div>
                      <Label htmlFor="video-negative" className="mb-1 block text-[11px] text-muted-foreground">
                        {t("video.params.negative")}
                      </Label>
                      <Textarea
                        id="video-negative"
                        rows={2}
                        placeholder={t("video.params.negativePlaceholder")}
                        value={negative}
                        onChange={(e) => setNegative(e.target.value)}
                        className="resize-none text-xs"
                      />
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <Label htmlFor="video-steps" className="mb-1 block text-[11px] text-muted-foreground">
                          {t("video.params.steps")}
                        </Label>
                        <Input
                          id="video-steps"
                          type="number"
                          min={1}
                          max={100}
                          value={steps}
                          onChange={(e) => setSteps(Math.max(1, Math.min(100, Number(e.target.value) || 20)))}
                          className="h-8 text-xs tabular-nums"
                        />
                      </div>
                      <div>
                        <Label htmlFor="video-cfg" className="mb-1 block text-[11px] text-muted-foreground">
                          {t("video.params.cfg")}
                        </Label>
                        <Input
                          id="video-cfg"
                          type="number"
                          min={1}
                          max={20}
                          step={0.5}
                          value={cfg}
                          onChange={(e) => setCfg(Math.max(1, Math.min(20, Number(e.target.value) || 5)))}
                          className="h-8 text-xs tabular-nums"
                        />
                      </div>
                      <div>
                        <Label htmlFor="video-seed" className="mb-1 block text-[11px] text-muted-foreground">
                          {t("video.params.seed")}
                        </Label>
                        <Input
                          id="video-seed"
                          type="number"
                          min={-1}
                          placeholder="-1"
                          value={seed}
                          onChange={(e) => setSeed(e.target.value)}
                          className="h-8 text-xs tabular-nums"
                        />
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor="video-watermark" className="text-[11px] text-muted-foreground">
                        {t("video.params.watermark")}
                      </Label>
                      <Switch
                        id="video-watermark"
                        checked={watermark}
                        onCheckedChange={setWatermark}
                      />
                    </div>
                    {backend === "seedance" && (
                      <div>
                        <Label htmlFor="video-seed" className="mb-1 block text-[11px] text-muted-foreground">
                          {t("video.params.seed")}
                        </Label>
                        <Input
                          id="video-seed"
                          type="number"
                          min={-1}
                          placeholder="-1"
                          value={seed}
                          onChange={(e) => setSeed(e.target.value)}
                          className="h-8 text-xs tabular-nums"
                        />
                      </div>
                    )}
                  </div>
                )}
              </CollapsibleContent>
            </Collapsible>
          </div>

          <Button size="lg" onClick={() => generate.mutate()} disabled={!canGenerate} className="w-full">
            {generate.isPending ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <SparklesIcon data-icon="inline-start" />
            )}
            {generate.isPending ? t("video.submitting") : t("video.generate")}
          </Button>
          {backend === "comfyui" && !configured && (
            <p className="text-center text-[10px] text-amber-600/80 dark:text-amber-400/80">
              {t("video.comfyNeedBase")}
            </p>
          )}
        </div>
      </aside>

      {/* 右侧：结果区 */}
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {focusRecordId != null && display && (
          <Button
            variant="ghost"
            size="sm"
            className="absolute right-5 top-5 z-20 h-7 gap-1 text-[11px] text-muted-foreground"
            onClick={() => setFocusRecordId(null)}
          >
            <XIcon className="size-3.5" />
            {t("common.cancel")}
          </Button>
        )}

        <div className="flex min-h-0 flex-1 items-center justify-center p-8">
          {!display ? (
            <div className="flex flex-col items-center justify-center gap-3 text-center">
              <div className="flex size-20 items-center justify-center rounded-2xl bg-primary/15">
                <ClapperboardIcon className="size-9 text-primary" />
              </div>
              <p className="text-lg font-medium">{t("video.result.empty")}</p>
              <p className="max-w-xs text-sm text-muted-foreground">
                {t("video.result.emptyHint")}
              </p>
            </div>
          ) : display.status === "processing" ? (
            <VideoTaskCard record={display} onDelete={(id) => del.mutate(id)} />
          ) : display.status === "failed" ? (
            <VideoFailedCard record={display} onDelete={(id) => del.mutate(id)} />
          ) : (
            <VideoPlayerCard record={display} onDelete={(id) => del.mutate(id)} />
          )}
        </div>

        {/* 底部：最近成功生成的视频 + 更多（全部历史） */}
        <RecentStrip records={records} onOpenHistory={() => setView("history")} />
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export function VideoScreen() {
  const view = useVideoStore((s) => s.view);
  if (view === "history") return <HistoryScreen />;
  return <GenerateTab />;
}
