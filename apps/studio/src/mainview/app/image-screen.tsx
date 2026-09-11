import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  SparklesIcon,
  Loader2Icon,
  EraserIcon,
  ShuffleIcon,
  DownloadIcon,
  DownloadCloudIcon,
  TrashIcon,
  ImageIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleIcon,
  CpuIcon,
  HistoryIcon,
  LayersIcon,
  PaletteIcon,
  Wand2Icon,
  ImagePlusIcon,
  XIcon,
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
import { useT } from "@stores/ui-lang";
import { useImageStore } from "@stores/image";
import { useMlxInstallStore } from "@stores/mlx-install";
import { useMlxModelDownloadStore } from "@stores/mlx-model-download";
import type { ImageGenBackend, ImageRecordRow } from "../../bun/image-gen";
import type { MlxModelInfo, MlxGenStatus } from "../../bun/mlx-gen";
import { cn } from "@/mainview/lib/utils";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const RATIOS: { label: string; w: number; h: number }[] = [
  { label: "16:9", w: 1024, h: 576 },
  { label: "3:2", w: 1152, h: 768 },
  { label: "4:3", w: 1024, h: 768 },
  { label: "1:1", w: 1024, h: 1024 },
  { label: "3:4", w: 768, h: 1024 },
  { label: "2:3", w: 768, h: 1152 },
  { label: "9:16", w: 576, h: 1024 },
];

const RANDOM_PROMPTS = [
  "一只在星空下奔跑的机械狼，赛博朋克风格，霓虹光效，电影感构图，细节丰富",
  "清晨薄雾中的江南水乡，乌篷船划过平静的河面，水墨画风格，柔和的晨光",
  "a cozy bookshop cafe on a rainy evening, warm golden light, cinematic, highly detailed",
  "悬浮在云海之上的天空之城，宫崎骏动画风格，吉卜力色彩，恢弘远景",
  "an astronaut floating above a coral reef planet, surreal dreamscape, vibrant colors",
  "极简主义产品摄影：磨砂玻璃香水瓶置于大理石台面，柔和的侧逆光，高级质感",
];

/** MLX 内置模型的默认步数（恢复配置时同步 steps 用；完整目录来自 listMlxGenModels）。 */
const MLX_FALLBACKS: { id: string; defaultSteps: number }[] = [
  { id: "z-image-turbo", defaultSteps: 9 },
  { id: "flux-schnell", defaultSteps: 4 },
  { id: "flux2-klein-9b", defaultSteps: 4 },
  { id: "flux-dev", defaultSteps: 50 },
];

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatBytes(b: number): string {
  if (!b || !Number.isFinite(b) || b <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function ResultError({ error }: { error?: string }) {
  if (!error) return null;
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
      {error}
    </div>
  );
}

function downloadImage(url: string, record: ImageRecordRow) {
  void rpcClient.saveImageToDownloads({
    url,
    filename: `image-${record.id}-${Date.now()}.png`,
  });
}

// ---------------------------------------------------------------------------
// 结果卡片
// ---------------------------------------------------------------------------

function ImageCard({
  record,
  onDelete,
  highlight,
}: {
  record: ImageRecordRow;
  onDelete?: (id: number) => void;
  highlight?: boolean;
}) {
  const t = useT();
  if (record.status === "failed" || !record.imageUrl) {
    return (
      <div className="flex aspect-square flex-col justify-center gap-2 overflow-hidden rounded-xl border bg-card p-3">
        <Badge variant="destructive" className="w-fit shrink-0 text-[10px]">
          {t("image.error")}
        </Badge>
        <p className="line-clamp-3 text-[11px] text-muted-foreground">{record.prompt}</p>
        <p className="line-clamp-3 text-[11px] text-destructive/80">{record.error}</p>
      </div>
    );
  }
  return (
    <div
      className={cn(
        "group relative aspect-square overflow-hidden rounded-xl border bg-muted/40 transition-shadow",
        highlight && "ring-2 ring-primary",
      )}
    >
      <img
        src={record.imageUrl}
        alt={record.prompt ?? ""}
        className="size-full object-cover"
        loading="lazy"
      />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100">
        <p className="line-clamp-2 text-[10px] leading-tight text-white/90">{record.prompt}</p>
      </div>
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <Button
          variant="secondary"
          size="icon-sm"
          tooltip={t("image.result.download")}
          onClick={() => downloadImage(record.imageUrl!, record)}
          className="bg-black/50 text-white hover:bg-black/70"
        >
          <DownloadIcon className="size-3.5" />
        </Button>
        {onDelete && (
          <Button
            variant="secondary"
            size="icon-sm"
            tooltip={t("image.result.delete")}
            onClick={() => onDelete(record.id)}
            className="bg-black/50 text-white hover:bg-black/70"
          >
            <TrashIcon className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// 生成中动画：一只小鱼在画布上蹦蹦跳跳地“画”你的图片
// --------------------------------------------------------------------------

function GenLoading({ prompt }: { prompt: string }) {
  const t = useT();
  return (
    <div className="flex flex-col items-center gap-6">
      {/* 画布 / 水池 */}
      <div className="gen-canvas relative flex size-56 items-center justify-center overflow-hidden rounded-3xl border bg-gradient-to-b from-sky-100/70 to-sky-200/60 dark:from-sky-950/40 dark:to-indigo-950/40">
        {/* 扩散光环 */}
        <span className="gen-ring pointer-events-none absolute inset-0 rounded-3xl border-2 border-sky-400/70" />
        <span
          className="gen-ring pointer-events-none absolute inset-0 rounded-3xl border border-primary/40"
          style={{ animationDelay: "0.8s" }}
        />

        {/* 闪光星星 */}
        <SparklesIcon
          className="gen-spark pointer-events-none absolute left-7 top-7 size-5 text-primary/70"
          style={{ animationDelay: "0.2s" }}
        />
        <SparklesIcon
          className="gen-spark pointer-events-none absolute right-8 top-10 size-4 text-sky-500/80"
          style={{ animationDelay: "0.9s" }}
        />
        <SparklesIcon
          className="gen-spark pointer-events-none absolute bottom-9 left-10 size-4 text-primary/60"
          style={{ animationDelay: "1.4s" }}
        />
        <PaletteIcon
          className="gen-spark pointer-events-none absolute bottom-6 right-9 size-6 text-fuchsia-500/70"
          style={{ animationDelay: "0.5s" }}
        />

        {/* 上升气泡 */}
        <Bubble style={{ left: "22%", animationDelay: "0s" }} />
        <Bubble style={{ left: "55%", animationDelay: "0.9s" }} />
        <Bubble style={{ left: "78%", animationDelay: "1.6s" }} />

        {/* 小鱼 */}
        <div className="gen-fish absolute left-1/2 bottom-8 z-10">
          <svg
            width="108"
            height="76"
            viewBox="0 0 108 76"
            fill="none"
            className="drop-shadow-md"
          >
            <defs>
              <linearGradient id="gen-fish-grad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#38bdf8" />
                <stop offset="100%" stopColor="#6366f1" />
              </linearGradient>
            </defs>
            {/* 尾巴 */}
            <g className="gen-fish-tail">
              <path
                d="M 82 38 L 104 22 C 98 34 98 42 104 54 Z"
                fill="url(#gen-fish-grad)"
                opacity="0.85"
              />
            </g>
            {/* 身体 */}
            <g className="gen-fish-body">
              <ellipse cx="38" cy="40" rx="38" ry="27" fill="url(#gen-fish-grad)" />
              <path
                d="M 4 40 C 14 22 62 22 74 40 C 62 58 14 58 4 40 Z"
                fill="url(#gen-fish-grad)"
              />
              {/* 腮线 */}
              <path
                d="M 58 24 C 64 32 64 48 58 56"
                stroke="rgba(255,255,255,0.55)"
                strokeWidth="2.5"
                strokeLinecap="round"
                fill="none"
              />
              <path
                d="M 64 28 C 68 34 68 46 64 52"
                stroke="rgba(255,255,255,0.3)"
                strokeWidth="2"
                strokeLinecap="round"
                fill="none"
              />
              {/* 眼 */}
              <circle cx="52" cy="33" r="7" fill="white" />
              <circle cx="54.5" cy="33" r="3.6" fill="#0f172a" />
              <circle cx="55.6" cy="31.5" r="1.3" fill="white" />
              {/* 嘴 */}
              <path
                d="M 66 43 C 71 45 71 49 66 49"
                stroke="#0f172a"
                strokeWidth="2"
                strokeLinecap="round"
                fill="none"
              />
              {/* 划水鳍 */}
              <path
                d="M 40 58 C 34 65 24 67 20 60"
                stroke="rgba(255,255,255,0.55)"
                strokeWidth="2.5"
                strokeLinecap="round"
                fill="none"
              />
            </g>
          </svg>
        </div>

        {/* 底部水纹 */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-sky-300/40 to-transparent dark:from-indigo-900/50" />
      </div>

      {/* 提示文字 */}
      <div className="flex max-w-sm flex-col items-center gap-2">
        <p className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Loader2Icon className="size-4 animate-spin text-primary" />
          {t("image.generating")}
        </p>
        {prompt && (
          <p className="gen-shimmer line-clamp-2 rounded-lg px-3 py-1 text-center text-xs text-muted-foreground">
            {prompt}
          </p>
        )}
      </div>
    </div>
  );
}

function Bubble({ style }: { style: CSSProperties }) {
  return (
    <span
      className="gen-bubble pointer-events-none absolute bottom-7 size-2.5 rounded-full border border-sky-400/70 bg-white/50"
      style={style}
    />
  );
}

// ---------------------------------------------------------------------------
// 最近成功生成的图片条（结果区底部）+ 更多入口
// ---------------------------------------------------------------------------

const RECENT_COUNT = 6;

function RecentStrip({
  records,
  onOpenHistory,
}: {
  records: ImageRecordRow[];
  onOpenHistory: () => void;
}) {
  const t = useT();
  const setFocusRecordId = useImageStore((s) => s.setFocusRecordId);
  const recent = records.filter((r) => r.status === "done" && r.imageUrl).slice(0, RECENT_COUNT);
  if (recent.length === 0) return null;
  return (
    <div className="flex shrink-0 items-center gap-3 border-t bg-card/40 px-6 py-3">
      <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <HistoryIcon className="size-3.5" />
        {t("image.recent.title")}
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
        {recent.map((r) => (
          <button
            key={r.id}
            type="button"
            title={r.prompt ?? undefined}
            onClick={() => setFocusRecordId(r.id)}
            className="size-14 shrink-0 overflow-hidden rounded-lg border transition hover:border-primary/60 hover:ring-2 hover:ring-primary/30"
          >
            <img
              src={r.imageUrl!}
              alt={r.prompt ?? ""}
              loading="lazy"
              className="size-full object-cover"
            />
          </button>
        ))}
      </div>
      <Button
        variant="outline"
        size="sm"
        className="h-7 shrink-0 gap-1 text-[11px]"
        onClick={onOpenHistory}
      >
        {t("image.recent.more")}
        <ChevronRightIcon className="size-3.5" />
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 全部历史页：所有生成过的图片 + 提示词
// ---------------------------------------------------------------------------

function HistoryCard({ record, onDelete }: { record: ImageRecordRow; onDelete: () => void }) {
  const t = useT();
  return (
    <div className="group flex flex-col gap-2">
      <div className="relative aspect-square overflow-hidden rounded-xl border bg-muted/40">
        <img
          src={record.imageUrl!}
          alt={record.prompt ?? ""}
          loading="lazy"
          className="size-full object-cover"
        />
        {record.width && record.height && (
          <span className="absolute left-2 top-2 rounded-md bg-black/55 px-1.5 py-0.5 text-[9px] font-medium tabular-nums text-white">
            {record.width}×{record.height}
          </span>
        )}
        <div className="absolute top-2 right-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <Button
            variant="secondary"
            size="icon-sm"
            tooltip={t("image.result.download")}
            onClick={() => downloadImage(record.imageUrl!, record)}
            className="bg-black/50 text-white hover:bg-black/70"
          >
            <DownloadIcon className="size-3.5" />
          </Button>
          <Button
            variant="secondary"
            size="icon-sm"
            tooltip={t("image.result.delete")}
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
        {record.prompt || t("image.error")}
      </p>
      <p className="-mt-1 flex items-center gap-1 text-[10px] tabular-nums text-muted-foreground">
        <span className="truncate">{formatTime(record.createdAt)}</span>
        {record.model && (
          <>
            <span className="shrink-0">·</span>
            <span className="truncate">{record.model}</span>
          </>
        )}
      </p>
    </div>
  );
}

function HistoryScreen() {
  const t = useT();
  const setView = useImageStore((s) => s.setView);
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["image-records"],
    queryFn: () => rpcClient.listImageRecords(undefined),
  });
  const [toDelete, setToDelete] = useState<ImageRecordRow | null>(null);
  const del = useMutation({
    mutationFn: (id: number) => rpcClient.deleteImageRecord({ id }),
    onSuccess: () => {
      setToDelete(null);
      queryClient.invalidateQueries({ queryKey: ["image-records"] });
    },
  });
  const records = (data?.records ?? []).filter((r) => r.status === "done" && r.imageUrl);

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
        <h1 className="text-sm font-semibold">{t("image.history.title")}</h1>
        <Badge variant="secondary" className="h-5 text-[10px]">
          {records.length}
        </Badge>
      </div>

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="size-4" />
        </div>
      ) : records.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <div className="flex size-20 items-center justify-center rounded-2xl bg-primary/15">
            <ImageIcon className="size-9 text-primary" />
          </div>
          <p className="text-lg font-medium">{t("image.history.empty")}</p>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="grid grid-cols-2 gap-x-5 gap-y-6 p-5 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {records.map((r) => (
              <HistoryCard key={r.id} record={r} onDelete={() => setToDelete(r)} />
            ))}
          </div>
        </ScrollArea>
      )}

      <Dialog open={!!toDelete} onOpenChange={(open) => !open && setToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("image.history.deleteTitle")}</DialogTitle>
            <DialogDescription>{t("image.history.deleteDesc")}</DialogDescription>
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
// 生图 Tab
// ---------------------------------------------------------------------------

function GenerateTab() {
  const t = useT();
  const queryClient = useQueryClient();
  const focusRecordId = useImageStore((s) => s.focusRecordId);
  const setView = useImageStore((s) => s.setView);

  const [prompt, setPrompt] = useState("");
  const [negative, setNegative] = useState("");
  const [ratioIdx, setRatioIdx] = useState(3); // 1:1
  const [count, setCount] = useState(1);
  const [steps, setSteps] = useState(25);
  const [seed, setSeed] = useState("");
  const [model, setModel] = useState("");
  const [quantize, setQuantize] = useState(8); // MLX：加载时量化位数，0 = 不量化
  const [results, setResults] = useState<ImageRecordRow[]>();

  // 提示词库「去试试」带入的草稿：挂载时预填提示词框。
  const pendingPrompt = useImageStore((s) => s.pendingPrompt);
  useEffect(() => {
    if (!pendingPrompt) return;
    setPrompt(pendingPrompt);
    useImageStore.getState().setPendingPrompt(null);
  }, [pendingPrompt]);

  // ---------- 后端配置 ----------
  const [backend, setBackend] = useState<ImageGenBackend>("api");
  const [apiBase, setApiBase] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [comfyBase, setComfyBase] = useState("");
  const [configError, setConfigError] = useState<string>();
  const hydrated = useRef(false);

  const { data: configData } = useQuery({
    queryKey: ["image-gen-config"],
    queryFn: () => rpcClient.getImageGenConfig(),
  });
  const config = configData?.config;

  useEffect(() => {
    if (!config || hydrated.current) return;
    hydrated.current = true;
    setBackend(config.backend);
    setApiBase(config.apiBase);
    setApiKey(config.apiKey);
    setComfyBase(config.comfyBase);
    setModel(config.model);
    if (config.backend === "mlx") {
      const m = MLX_FALLBACKS.find((x) => x.id === config.model);
      if (m) setSteps(m.defaultSteps);
    }
  }, [config]);

  const saveConfig = useMutation({
    mutationFn: () =>
      rpcClient.saveImageGenConfig({
        backend,
        apiBase: apiBase.trim(),
        apiKey: apiKey.trim(),
        comfyBase: comfyBase.trim(),
        model: model.trim(),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["image-gen-config"] }),
  });

  const fetchModels = useMutation({
    mutationFn: () =>
      rpcClient.listImageGenModels({
        backend,
        base: backend === "comfyui" ? comfyBase.trim() : apiBase.trim(),
        apiKey: apiKey.trim(),
      }),
    onSuccess: (r) => {
      if (r.error) {
        setConfigError(r.error);
        return;
      }
      setConfigError(undefined);
      if (r.models.length > 0 && !r.models.includes(model)) setModel(r.models[0]!);
    },
    onError: (e) => setConfigError(String(e)),
  });

  const { data: modelsData } = useQuery({
    queryKey: ["image-gen-models", backend],
    queryFn: () => rpcClient.listImageGenModels({ backend }),
    enabled: backend === "comfyui" ? !!comfyBase.trim() : !!apiBase.trim(),
  });
  const models = modelsData?.models ?? [];

  // ---------- MLX 本地引擎（mflux，Apple Silicon） ----------
  const mlxLogs = useMlxInstallStore((s) => s.logs);
  const clearMlxLogs = useMlxInstallStore((s) => s.clearLogs);
  const { data: mlxStatus, refetch: refetchMlxStatus } = useQuery({
    queryKey: ["mlx-gen-status"],
    queryFn: () => rpcClient.getMlxGenStatus(),
    enabled: backend === "mlx",
    // 未安装时轮询，安装进程结束后自动变为已就绪。
    refetchInterval: (q) => (q.state.data?.engineInstalled ? false : 3000),
  });
  const { data: mlxModelsData } = useQuery({
    queryKey: ["mlx-gen-models"],
    queryFn: () => rpcClient.listMlxGenModels(),
    enabled: backend === "mlx",
  });
  const mlxModels: MlxModelInfo[] = mlxModelsData?.models ?? [];

  // ---------- MLX 模型权重下载（先下载、后生成；带进度） ----------
  const { data: mlxDownloadedData, refetch: refetchMlxDownloaded } = useQuery({
    queryKey: ["mlx-downloaded-models"],
    queryFn: () => rpcClient.getDownloadedMlxModels(),
    enabled: backend === "mlx",
    // 下载可能超过 RPC 超时（十几分钟 vs 大模型几十 GB），进度/完成消息也未必可靠，
    // 这里兜底轮询：只要有下载在进行，就每 2s 拉一次“已下载模型”，
    // 确保真正下完后 UI 能及时把“下载中”切到“已下载”标识。
    refetchInterval: (q) => {
      const dl = useMlxModelDownloadStore.getState().progress?.stage === "downloading";
      return dl ? 2000 : false;
    },
  });
  const mlxDownloaded = new Set(mlxDownloadedData?.downloaded ?? []);
  const modelProgress = useMlxModelDownloadStore((s) => s.progress);
  const downloading = modelProgress?.stage === "downloading";
  const downloadingThis =
    downloading && !!modelProgress && modelProgress.modelId === model && mlxStatus?.engineInstalled;
  const downloadMlxModelMut = useMutation({
    mutationFn: () => rpcClient.downloadMlxModel({ modelId: model }),
    onSuccess: (r) => {
      if (!r.ok) setConfigError(r.error);
      else setConfigError(undefined);
      void refetchMlxDownloaded();
    },
    onError: (e) => setConfigError(String(e)),
  });
  const installMlx = useMutation({
    mutationFn: () => rpcClient.downloadMlxGenEngine(),
    onSuccess: (r) => {
      if (!r.ok) setConfigError(r.error);
      else setConfigError(undefined);
      void refetchMlxStatus();
    },
    // RPC 超时等错误不代表安装终止：安装继续在主进程进行，状态轮询会兜底。
    onError: (e) => setConfigError(String(e)),
  });
  const logEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: "end" });
  }, [mlxLogs]);

  const pickMlxModel = (id: string) => {
    setModel(id);
    const m = mlxModels.find((x) => x.id === id);
    if (m) setSteps(m.defaultSteps);
    void rpcClient.saveImageGenConfig({ backend, model: id });
  };

  const configured =
    backend === "mlx"
      ? (mlxStatus?.engineInstalled ?? false)
      : backend === "comfyui"
        ? !!comfyBase.trim()
        : !!apiBase.trim();

  // MLX 后端：引擎就绪 + 已选模型 + 权重已下载，才允许生图。
  const mlxModelReady =
    (mlxStatus?.engineInstalled ?? false) && !!model.trim() && mlxDownloaded.has(model.trim());

  // ---------- 侧边栏聚焦的历史记录 ----------
  const { data: recordsData } = useQuery({
    queryKey: ["image-records"],
    queryFn: () => rpcClient.listImageRecords(undefined),
  });
  useEffect(() => {
    if (focusRecordId == null || !recordsData) return;
    const rec = recordsData.records.find((r) => r.id === focusRecordId);
    if (rec) setResults([rec]);
  }, [focusRecordId, recordsData]);

  // ---------- 生成 ----------
  const generate = useMutation({
    mutationFn: () => {
      const ratio = RATIOS[ratioIdx]!;
      const parsedSeed = Number.parseInt(seed, 10);
      return rpcClient.generateImage({
        prompt,
        negativePrompt: negative.trim() || undefined,
        width: ratio.w,
        height: ratio.h,
        count,
        steps,
        seed: Number.isFinite(parsedSeed) && parsedSeed >= 0 ? parsedSeed : undefined,
        model: model.trim() || undefined,
        quantize: backend === "mlx" ? quantize : undefined,
        // 把页面上的实时配置一并带上，后端优先使用它们并落盘，
        // 避免后台读到未保存的旧地址/key 而连错服务商。
        config: {
          backend,
          apiBase: apiBase.trim(),
          apiKey: apiKey.trim(),
          model: model.trim(),
          comfyBase: comfyBase.trim(),
        },
      });
    },
    onSuccess: (r) => {
      if (r.error) {
        setConfigError(r.error);
        return;
      }
      setConfigError(undefined);
      if (r.records.length > 0) setResults(r.records);
      queryClient.invalidateQueries({ queryKey: ["image-records"] });
      queryClient.invalidateQueries({ queryKey: ["image-gen-config"] });
    },
    onError: (e) => setConfigError(String(e)),
  });

  // 生图前需先下载好 MLX 模型权重（不改原有的自动下载行为）。
  const canGenerate =
    !!prompt.trim() &&
    !generate.isPending &&
    configured &&
    (backend !== "mlx" || mlxModelReady);


  const ratio = RATIOS[ratioIdx]!;
  // 右上角预览卡：取结果里最新一条（即最后生成的那张）。
  const latest = results?.[results.length - 1];

  return (
    <div className="flex h-full min-h-0">
      {/* 中间：参数面板 */}
      <aside className="w-[340px] shrink-0 overflow-y-auto border-r p-4">
        <div className="flex flex-col gap-5">
          {/* 后端切换 */}
          <div>
            <Label className="mb-1.5 block text-xs">{t("image.backend")}</Label>
            <div className="flex overflow-hidden rounded-lg border">
              {(
                [
                  { key: "api", label: "image.backend.cloud" },
                  { key: "mlx", label: "image.backend.mlx" },
                  { key: "comfyui", label: "image.backend.comfyui" },
                ] as const
              ).map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    setBackend(key);
                    void rpcClient.saveImageGenConfig({ backend: key });
                  }}
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
                backend === "api"
                  ? "image.backend.cloudDesc"
                  : backend === "mlx"
                    ? "image.backend.mlxDesc"
                    : "image.backend.comfyuiDesc",
              )}
            </p>
          </div>

          {/* 服务配置（MLX 为本地引擎卡片） */}
          {backend === "mlx" ? (
            <div className="flex flex-col gap-2.5 rounded-lg border bg-card p-3">
              <div className="flex items-center gap-2.5">
                <CpuIcon className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium">{t("image.mlx.engine")}</p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {!mlxStatus
                      ? "…"
                      : !mlxStatus.supported
                        ? t("image.mlx.unsupported")
                        : !mlxStatus.pythonFound
                          ? t("image.mlx.needPython")
                          : mlxStatus.engineInstalled
                            ? `${t("image.mlx.engineReady")}${mlxStatus.version ? ` · v${mlxStatus.version}` : ""}`
                            : t("image.mlx.engineNone")}
                  </p>
                </div>
                {mlxStatus?.supported && !mlxStatus.engineInstalled && (
                  <Button
                    size="sm"
                    disabled={!mlxStatus.pythonFound || installMlx.isPending}
                    onClick={() => {
                      clearMlxLogs();
                      installMlx.mutate();
                    }}
                  >
                    {installMlx.isPending ? (
                      <Loader2Icon data-icon="inline-start" className="animate-spin" />
                    ) : (
                      <DownloadCloudIcon data-icon="inline-start" />
                    )}
                    {installMlx.isPending
                      ? t("image.mlx.downloadingEngine")
                      : t("image.mlx.downloadEngine")}
                  </Button>
                )}
              </div>

              {(installMlx.isPending || mlxLogs.length > 0) && (
                <div className="max-h-32 overflow-y-auto rounded-md bg-muted/60 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
                  {mlxLogs.slice(-40).map((l, i) => (
                    <p key={i} className="break-all whitespace-pre-wrap">
                      {l}
                    </p>
                  ))}
                  <div ref={logEndRef} />
                </div>
              )}

              <div>
                <Label className="mb-1 block text-xs">{t("image.config.model")}</Label>
                <Select value={model} onValueChange={pickMlxModel}>
                  <SelectTrigger className="h-8 w-full text-xs">
                    <SelectValue placeholder={t("image.mlx.selectModel")} />
                  </SelectTrigger>
                  <SelectContent>
                    {mlxModels.map((m) => {
                      const downloaded = mlxDownloaded.has(m.id);
                      return (
                        <SelectItem key={m.id} value={m.id} className="text-xs">
                          <span className="flex w-full items-center justify-between gap-2">
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate">{m.label}</span>
                              {downloaded ? (
                                <Badge
                                  variant="secondary"
                                  className="h-4 shrink-0 gap-0.5 px-1 text-[9px] font-normal text-emerald-600 dark:text-emerald-400"
                                >
                                  <CircleIcon className="size-2 fill-current" />
                                  {t("image.mlx.modelDownloaded")}
                                </Badge>
                              ) : (
                                <span className="shrink-0 text-[9px] text-muted-foreground">
                                  {t("image.mlx.modelNotDownloaded")}
                                </span>
                              )}
                            </span>
                            <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                              ~{m.approxSizeGb}GB
                            </span>
                          </span>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>

                {/* 下载模型（权重） + 实时进度 */}
                {mlxStatus?.engineInstalled && (
                  <div className="mt-2 flex flex-col gap-2">
                    {downloadingThis && modelProgress ? (
                      <div className="flex flex-col gap-1 rounded-md border bg-muted/40 p-2">
                        <div className="flex items-center justify-between text-[10px] tabular-nums text-muted-foreground">
                          <span className="truncate text-primary">
                            {modelProgress.fileName
                              ? `${t("image.mlx.downloadingFile")}：${modelProgress.fileName.split("/").pop()}`
                              : t("image.mlx.downloadingModel")}
                          </span>
                          <span className="ml-2 shrink-0">{modelProgress.percent}%</span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-primary transition-[width] duration-300"
                            style={{ width: `${Math.min(100, modelProgress.percent)}%` }}
                          />
                        </div>
                        <p className="text-[9px] tabular-nums text-muted-foreground">
                          {modelProgress.filesTotal > 0
                            ? `${modelProgress.filesDone}/${modelProgress.filesTotal} 文件 · ${formatBytes(
                                modelProgress.doneBytes + modelProgress.received,
                              )} / ${formatBytes(modelProgress.allBytes)}`
                            : formatBytes(modelProgress.received)}
                        </p>
                      </div>
                    ) : mlxDownloaded.has(model.trim()) ? (
                      <Badge
                        variant="secondary"
                        className="w-fit gap-1 text-[10px] font-normal text-emerald-600 dark:text-emerald-400"
                      >
                        <CircleIcon className="size-2.5 fill-current" />
                        {t("image.mlx.modelDownloaded")}
                      </Badge>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!model.trim() || downloadMlxModelMut.isPending}
                          onClick={() => {
                            setConfigError(undefined);
                            useMlxModelDownloadStore.getState().reset();
                            downloadMlxModelMut.mutate();
                          }}
                        >
                          {downloadMlxModelMut.isPending ? (
                            <Loader2Icon data-icon="inline-start" className="animate-spin" />
                          ) : (
                            <DownloadCloudIcon data-icon="inline-start" />
                          )}
                          {downloadMlxModelMut.isPending
                            ? t("image.mlx.downloadingModel")
                            : t("image.mlx.downloadModel")}
                        </Button>
                        {model.trim() && (
                          <p className="text-[10px] leading-relaxed text-amber-600/80 dark:text-amber-400/80">
                            {t("image.mlx.modelNeedDownload")}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                )}
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {t("image.mlx.modelHint")}
                </p>
              </div>
              {configError && <ResultError error={configError} />}
            </div>
          ) : (
          <div className="flex flex-col gap-2.5 rounded-lg border bg-card p-3">
            {backend === "api" ? (
              <>
                <div>
                  <Label htmlFor="img-base" className="mb-1 block text-xs">
                    {t("image.config.base")}
                  </Label>
                  <Input
                    id="img-base"
                    placeholder="https://api.siliconflow.cn/v1"
                    value={apiBase}
                    onChange={(e) => setApiBase(e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
                <div>
                  <Label htmlFor="img-key" className="mb-1 block text-xs">
                    {t("image.config.apiKey")}
                  </Label>
                  <Input
                    id="img-key"
                    type="password"
                    placeholder="sk-…"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
              </>
            ) : (
              <div>
                <Label htmlFor="img-comfy-base" className="mb-1 block text-xs">
                  {t("image.config.comfyBase")}
                </Label>
                <Input
                  id="img-comfy-base"
                  placeholder="http://127.0.0.1:8188"
                  value={comfyBase}
                  onChange={(e) => setComfyBase(e.target.value)}
                  className="h-8 text-xs"
                />
              </div>
            )}

            <div>
              <Label htmlFor="img-model" className="mb-1 block text-xs">
                {backend === "comfyui" ? t("image.config.model") : t("image.config.modelId")}
              </Label>
              <Input
                id="img-model"
                list="image-gen-models"
                placeholder={
                  backend === "comfyui"
                    ? t("image.config.checkpointPlaceholder")
                    : t("image.config.modelPlaceholder")
                }
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="h-8 text-xs"
              />
              {models.length > 0 && (
                <datalist id="image-gen-models">
                  {models.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={() => saveConfig.mutate()}
                disabled={
                  saveConfig.isPending || (backend === "api" ? !apiBase.trim() : !comfyBase.trim())
                }
              >
                {saveConfig.isPending ? (
                  <Loader2Icon data-icon="inline-start" className="animate-spin" />
                ) : null}
                {t("image.config.save")}
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
                {t("image.config.fetchModels")}
              </Button>
              {configured && (
                <Badge variant="secondary" className="gap-1 text-[10px]">
                  <CircleIcon className="size-2.5 fill-current text-emerald-500" />
                  {t("image.config.configured")}
                </Badge>
              )}
            </div>
            {models.length > 0 && (
              <p className="text-[10px] text-muted-foreground tabular-nums">
                {models.length} {t("image.config.modelsCount")}
              </p>
            )}
            {configError && <ResultError error={configError} />}
          </div>
          )}

          {/* 提示词 */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <Label htmlFor="img-prompt" className="text-xs">
                {t("image.prompt")}
              </Label>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground"
                  onClick={() => setPrompt(RANDOM_PROMPTS[Math.floor(Math.random() * RANDOM_PROMPTS.length)]!)}
                >
                  <ShuffleIcon className="size-3" />
                  {t("image.prompt.random")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground"
                  onClick={() => setPrompt("")}
                >
                  <EraserIcon className="size-3" />
                  {t("image.prompt.clear")}
                </Button>
              </div>
            </div>
            <Textarea
              id="img-prompt"
              rows={7}
              placeholder={t("image.promptPlaceholder")}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="resize-none text-xs"
            />
          </div>

          {/* 参数 */}
          <div className="flex flex-col gap-3 rounded-lg border bg-card p-3">
            <p className="text-xs font-medium">{t("image.params")}</p>

            <div>
              <Label className="mb-1.5 block text-[11px] text-muted-foreground">
                {t("image.params.ratio")}
              </Label>
              <div className="flex flex-wrap gap-1.5">
                {RATIOS.map((r, i) => (
                  <button
                    key={r.label}
                    type="button"
                    onClick={() => setRatioIdx(i)}
                    className={cn(
                      "rounded-md border px-2 py-1 text-[11px] tabular-nums transition-colors",
                      ratioIdx === i
                        ? "border-primary bg-primary/10 text-primary"
                        : "text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
                    )}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="img-width" className="mb-1 block text-[11px] text-muted-foreground">
                  {t("image.params.width")}
                </Label>
                <Input
                  id="img-width"
                  type="number"
                  min={64}
                  max={4096}
                  step={64}
                  value={ratio.w}
                  disabled
                  className="h-8 text-xs tabular-nums"
                />
              </div>
              <div>
                <Label htmlFor="img-height" className="mb-1 block text-[11px] text-muted-foreground">
                  {t("image.params.height")}
                </Label>
                <Input
                  id="img-height"
                  type="number"
                  min={64}
                  max={4096}
                  step={64}
                  value={ratio.h}
                  disabled
                  className="h-8 text-xs tabular-nums"
                />
              </div>
            </div>

            <div>
              <Label htmlFor="img-count" className="mb-1 block text-[11px] text-muted-foreground">
                {t("image.params.count")}
              </Label>
              <Input
                id="img-count"
                type="number"
                min={1}
                max={8}
                value={count}
                onChange={(e) => setCount(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
                className="h-8 text-xs tabular-nums"
              />
            </div>

            {/* 高级选项 */}
            <Collapsible>
              <CollapsibleTrigger className="group flex w-full items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground">
                <ChevronDownIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
                {t("image.params.advanced")}
              </CollapsibleTrigger>
              <CollapsibleContent className="flex flex-col gap-3 pt-3">
                {backend === "mlx" ? (
                  <>
                    <div>
                      <Label className="mb-1 block text-[11px] text-muted-foreground">
                        {t("image.mlx.quantize")}
                      </Label>
                      <Select value={String(quantize)} onValueChange={(v) => setQuantize(Number(v))}>
                        <SelectTrigger className="h-8 w-full text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="0">{t("image.mlx.quantizeOff")}</SelectItem>
                          <SelectItem value="8">8-bit</SelectItem>
                          <SelectItem value="6">6-bit</SelectItem>
                          <SelectItem value="4">4-bit</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <p className="text-[11px] text-muted-foreground">{t("image.mlx.noNegative")}</p>
                  </>
                ) : (
                  <div>
                    <Label htmlFor="img-negative" className="mb-1 block text-[11px] text-muted-foreground">
                      {t("image.params.negative")}
                    </Label>
                    <Textarea
                      id="img-negative"
                      rows={2}
                      placeholder={t("image.params.negativePlaceholder")}
                      value={negative}
                      onChange={(e) => setNegative(e.target.value)}
                      className="resize-none text-xs"
                    />
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label htmlFor="img-steps" className="mb-1 block text-[11px] text-muted-foreground">
                      {t("image.params.steps")}
                    </Label>
                    <Input
                      id="img-steps"
                      type="number"
                      min={1}
                      max={100}
                      value={steps}
                      onChange={(e) => setSteps(Math.max(1, Math.min(100, Number(e.target.value) || 25)))}
                      className="h-8 text-xs tabular-nums"
                    />
                  </div>
                  <div>
                    <Label htmlFor="img-seed" className="mb-1 block text-[11px] text-muted-foreground">
                      {t("image.params.seed")}
                    </Label>
                    <Input
                      id="img-seed"
                      type="number"
                      min={-1}
                      placeholder="-1"
                      value={seed}
                      onChange={(e) => setSeed(e.target.value)}
                      className="h-8 text-xs tabular-nums"
                    />
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>

          <Button
            size="lg"
            onClick={() => generate.mutate()}
            disabled={!canGenerate}
            className="w-full"
          >
            {generate.isPending ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <SparklesIcon data-icon="inline-start" />
            )}
            {generate.isPending ? t("image.generating") : t("image.generate")}
          </Button>
          {backend === "mlx" && !canGenerate && !mlxModelReady && mlxStatus?.engineInstalled && (
            <p className="text-center text-[10px] text-amber-600/80 dark:text-amber-400/80">
              {t("image.mlx.modelNeedDownload")}
            </p>
          )}
        </div>
      </aside>

      {/* 右侧：结果区 */}
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* 右上角：当前结果的悬浮预览卡 */}
        {latest && latest.imageUrl && (
          <div className="absolute right-5 top-5 z-20 w-44 overflow-hidden rounded-xl border bg-card/95 shadow-lg backdrop-blur">
            <div className="relative aspect-video overflow-hidden bg-muted">
              <img src={latest.imageUrl} alt={latest.prompt ?? ""} className="size-full object-cover" />
              <span className="absolute left-1.5 top-1.5 rounded-md bg-black/55 px-1.5 py-0.5 text-[9px] font-medium text-white">
                {latest.status}
              </span>
            </div>
            <div className="space-y-1 p-2">
              <p className="line-clamp-2 text-[11px] leading-snug text-foreground">{latest.prompt}</p>
              <p className="text-[10px] tabular-nums text-muted-foreground">
                {latest.width && latest.height ? `${latest.width}×${latest.height} · ` : ""}
                {formatTime(latest.createdAt)}
              </p>
            </div>
            {focusRecordId != null && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-full rounded-none border-t text-[11px] text-muted-foreground"
                onClick={() => {
                  useImageStore.getState().setFocusRecordId(null);
                  setResults(undefined);
                }}
              >
                {t("common.cancel")}
              </Button>
            )}
          </div>
        )}

        <div className="flex min-h-0 flex-1 items-center justify-center p-8 pt-16">
          {generate.isPending ? (
            <GenLoading prompt={prompt} />
          ) : results?.length ? (
            <div className="flex min-w-0 max-w-full flex-wrap items-center justify-center gap-5">
              {results.map((r) => (
                <ImageCard key={r.id} record={r} highlight={r.id === focusRecordId} />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-3 text-center">
              <div className="flex size-20 items-center justify-center rounded-2xl bg-primary/15">
                <ImageIcon className="size-9 text-primary" />
              </div>
              <p className="text-lg font-medium">{t("image.result.empty")}</p>
              <p className="max-w-xs text-sm text-muted-foreground">{t("image.result.emptyHint")}</p>
            </div>
          )}
        </div>

        {/* 底部：最近成功生成的图片 + 更多（全部历史） */}
        <RecentStrip records={recordsData?.records ?? []} onOpenHistory={() => setView("history")} />
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI 修图 Tab：与生图页布局基本一致，差别在于需要先上传一张参考图；
// 生成时把参考图 + 修改提示词一起发给 OpenAI 兼容的 /v1/images/edits。
// ---------------------------------------------------------------------------

function EditTab() {
  const t = useT();
  const queryClient = useQueryClient();

  const [reference, setReference] = useState<{ ref: string; url: string }>();
  const [prompt, setPrompt] = useState("");
  const [negative, setNegative] = useState("");
  const [ratioIdx, setRatioIdx] = useState(3); // 1:1
  const [count, setCount] = useState(1);
  const [steps, setSteps] = useState(25);
  const [seed, setSeed] = useState("");
  const [model, setModel] = useState("");
  const [results, setResults] = useState<ImageRecordRow[]>();

  // ---------- 后端配置（与生图页共用同一套配置与落盘） ----------
  const [backend, setBackend] = useState<ImageGenBackend>("api");
  const [apiBase, setApiBase] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [comfyBase, setComfyBase] = useState("");
  const [configError, setConfigError] = useState<string>();
  const hydrated = useRef(false);

  const { data: configData } = useQuery({
    queryKey: ["image-gen-config"],
    queryFn: () => rpcClient.getImageGenConfig(),
  });
  const config = configData?.config;

  useEffect(() => {
    if (!config || hydrated.current) return;
    hydrated.current = true;
    setBackend(config.backend);
    setApiBase(config.apiBase);
    setApiKey(config.apiKey);
    setComfyBase(config.comfyBase);
    setModel(config.model);
  }, [config]);

  const saveConfig = useMutation({
    mutationFn: () =>
      rpcClient.saveImageGenConfig({
        backend,
        apiBase: apiBase.trim(),
        apiKey: apiKey.trim(),
        comfyBase: comfyBase.trim(),
        model: model.trim(),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["image-gen-config"] }),
  });

  const fetchModels = useMutation({
    mutationFn: () =>
      rpcClient.listImageGenModels({
        backend,
        base: backend === "comfyui" ? comfyBase.trim() : apiBase.trim(),
        apiKey: apiKey.trim(),
      }),
    onSuccess: (r) => {
      if (r.error) {
        setConfigError(r.error);
        return;
      }
      setConfigError(undefined);
      if (r.models.length > 0 && !r.models.includes(model)) setModel(r.models[0]!);
    },
    onError: (e) => setConfigError(String(e)),
  });

  const { data: modelsData } = useQuery({
    queryKey: ["image-gen-models", backend],
    queryFn: () => rpcClient.listImageGenModels({ backend }),
    enabled: backend === "comfyui" ? !!comfyBase.trim() : !!apiBase.trim(),
  });
  const models = modelsData?.models ?? [];

  // ---------- 参考图选择 ----------
  const pickReference = useMutation({
    mutationFn: async () => {
      const { paths } = await rpcClient.openFileDialog({
        allowedFileTypes: "png,jpg,jpeg,webp",
      });
      if (paths.length === 0) return undefined;
      const { files } = await rpcClient.stageEditImage({ paths });
      return files[0];
    },
    onSuccess: (file) => {
      if (file) setReference(file);
    },
    onError: (e) => setConfigError(String(e)),
  });

  // ---------- 以图改图 ----------
  const generate = useMutation({
    mutationFn: () => {
      const ratio = RATIOS[ratioIdx]!;
      const parsedSeed = Number.parseInt(seed, 10);
      return rpcClient.generateImage({
        prompt,
        negativePrompt: negative.trim() || undefined,
        width: ratio.w,
        height: ratio.h,
        count,
        steps,
        seed: Number.isFinite(parsedSeed) && parsedSeed >= 0 ? parsedSeed : undefined,
        model: model.trim() || undefined,
        referenceImageRef: reference?.ref,
        // 页面上的实时配置一并带上，后端优先使用它们并落盘（同生图页）。
        config: {
          backend,
          apiBase: apiBase.trim(),
          apiKey: apiKey.trim(),
          model: model.trim(),
          comfyBase: comfyBase.trim(),
        },
      });
    },
    onSuccess: (r) => {
      if (r.error) {
        setConfigError(r.error);
        return;
      }
      setConfigError(undefined);
      if (r.records.length > 0) setResults(r.records);
      queryClient.invalidateQueries({ queryKey: ["image-records"] });
      queryClient.invalidateQueries({ queryKey: ["image-gen-config"] });
    },
    onError: (e) => setConfigError(String(e)),
  });

  const { data: recordsData } = useQuery({
    queryKey: ["image-records"],
    queryFn: () => rpcClient.listImageRecords(undefined),
  });

  // 参考图修图必须：选了图 + 填了提示词 + 云端后端（MLX/ComfyUI 不支持）。
  const canGenerate =
    !!reference && !!prompt.trim() && backend === "api" && !!apiBase.trim() && !generate.isPending;
  const ratio = RATIOS[ratioIdx]!;

  return (
    <div className="flex h-full min-h-0">
      {/* 中间：参数面板 */}
      <aside className="w-[340px] shrink-0 overflow-y-auto border-r p-4">
        <div className="flex flex-col gap-5">
          {/* 后端切换（与生图页一致） */}
          <div>
            <Label className="mb-1.5 block text-xs">{t("image.backend")}</Label>
            <div className="flex overflow-hidden rounded-lg border">
              {(
                [
                  { key: "api", label: "image.backend.cloud" },
                  { key: "mlx", label: "image.backend.mlx" },
                  { key: "comfyui", label: "image.backend.comfyui" },
                ] as const
              ).map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    setBackend(key);
                    void rpcClient.saveImageGenConfig({ backend: key });
                  }}
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
          </div>

          {backend === "api" ? (
            <div className="flex flex-col gap-2.5 rounded-lg border bg-card p-3">
              <div>
                <Label htmlFor="edit-base" className="mb-1 block text-xs">
                  {t("image.config.base")}
                </Label>
                <Input
                  id="edit-base"
                  placeholder="https://api.siliconflow.cn/v1"
                  value={apiBase}
                  onChange={(e) => setApiBase(e.target.value)}
                  className="h-8 text-xs"
                />
              </div>
              <div>
                <Label htmlFor="edit-key" className="mb-1 block text-xs">
                  {t("image.config.apiKey")}
                </Label>
                <Input
                  id="edit-key"
                  type="password"
                  placeholder="sk-…"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="h-8 text-xs"
                />
              </div>
              <div>
                <Label htmlFor="edit-model" className="mb-1 block text-xs">
                  {t("image.config.modelId")}
                </Label>
                <Input
                  id="edit-model"
                  list="image-edit-models"
                  placeholder={t("image.config.modelPlaceholder")}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="h-8 text-xs"
                />
                {models.length > 0 && (
                  <datalist id="image-edit-models">
                    {models.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => saveConfig.mutate()}
                  disabled={saveConfig.isPending || !apiBase.trim()}
                >
                  {saveConfig.isPending ? (
                    <Loader2Icon data-icon="inline-start" className="animate-spin" />
                  ) : null}
                  {t("image.config.save")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => fetchModels.mutate()}
                  disabled={fetchModels.isPending || !apiBase.trim()}
                >
                  {fetchModels.isPending ? (
                    <Loader2Icon data-icon="inline-start" className="animate-spin" />
                  ) : null}
                  {t("image.config.fetchModels")}
                </Button>
                {apiBase.trim() && (
                  <Badge variant="secondary" className="gap-1 text-[10px]">
                    <CircleIcon className="size-2.5 fill-current text-emerald-500" />
                    {t("image.config.configured")}
                  </Badge>
                )}
              </div>
              {models.length > 0 && (
                <p className="text-[10px] text-muted-foreground tabular-nums">
                  {models.length} {t("image.config.modelsCount")}
                </p>
              )}
              {configError && <ResultError error={configError} />}
            </div>
          ) : (
            <div className="rounded-lg border bg-card p-3 text-[11px] leading-relaxed text-muted-foreground">
              {t("image.edit.backendNote")}
            </div>
          )}

          {/* 参考图：修图页与生图页唯一的区别 */}
          <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
            <div className="flex items-center gap-2">
              <Wand2Icon className="size-4 shrink-0 text-primary" />
              <p className="text-xs font-medium">{t("image.edit.reference")}</p>
            </div>
            {reference ? (
              <div className="flex items-center gap-3">
                <img
                  src={reference.url}
                  alt=""
                  className="size-16 shrink-0 rounded-lg border object-cover"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px] text-muted-foreground">
                    {t("image.edit.referenceReady")}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-1.5 h-7 gap-1 text-[11px]"
                    disabled={pickReference.isPending}
                    onClick={() => pickReference.mutate()}
                  >
                    <ImagePlusIcon className="size-3.5" />
                    {t("image.edit.repick")}
                  </Button>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  tooltip={t("image.edit.remove")}
                  onClick={() => setReference(undefined)}
                >
                  <XIcon className="size-4" />
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                className="h-24 w-full flex-col gap-2 border-dashed"
                disabled={pickReference.isPending}
                onClick={() => pickReference.mutate()}
              >
                {pickReference.isPending ? (
                  <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
                ) : (
                  <ImagePlusIcon className="size-5 text-muted-foreground" />
                )}
                <span className="text-xs">{t("image.edit.select")}</span>
              </Button>
            )}
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t("image.edit.hint")}
            </p>
          </div>

          {/* 修改提示词 */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <Label htmlFor="edit-prompt" className="text-xs">
                {t("image.prompt")}
              </Label>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground"
                onClick={() => setPrompt("")}
              >
                <EraserIcon className="size-3" />
                {t("image.prompt.clear")}
              </Button>
            </div>
            <Textarea
              id="edit-prompt"
              rows={7}
              placeholder={t("image.edit.promptPlaceholder")}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="resize-none text-xs"
            />
          </div>

          {/* 参数（与生图页一致） */}
          <div className="flex flex-col gap-3 rounded-lg border bg-card p-3">
            <p className="text-xs font-medium">{t("image.params")}</p>

            <div>
              <Label className="mb-1.5 block text-[11px] text-muted-foreground">
                {t("image.params.ratio")}
              </Label>
              <div className="flex flex-wrap gap-1.5">
                {RATIOS.map((r, i) => (
                  <button
                    key={r.label}
                    type="button"
                    onClick={() => setRatioIdx(i)}
                    className={cn(
                      "rounded-md border px-2 py-1 text-[11px] tabular-nums transition-colors",
                      ratioIdx === i
                        ? "border-primary bg-primary/10 text-primary"
                        : "text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
                    )}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="edit-width" className="mb-1 block text-[11px] text-muted-foreground">
                  {t("image.params.width")}
                </Label>
                <Input id="edit-width" type="number" value={ratio.w} disabled className="h-8 text-xs tabular-nums" />
              </div>
              <div>
                <Label htmlFor="edit-height" className="mb-1 block text-[11px] text-muted-foreground">
                  {t("image.params.height")}
                </Label>
                <Input id="edit-height" type="number" value={ratio.h} disabled className="h-8 text-xs tabular-nums" />
              </div>
            </div>

            <div>
              <Label htmlFor="edit-count" className="mb-1 block text-[11px] text-muted-foreground">
                {t("image.params.count")}
              </Label>
              <Input
                id="edit-count"
                type="number"
                min={1}
                max={8}
                value={count}
                onChange={(e) => setCount(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
                className="h-8 text-xs tabular-nums"
              />
            </div>

            <Collapsible>
              <CollapsibleTrigger className="group flex w-full items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground">
                <ChevronDownIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
                {t("image.params.advanced")}
              </CollapsibleTrigger>
              <CollapsibleContent className="flex flex-col gap-3 pt-3">
                <div>
                  <Label htmlFor="edit-negative" className="mb-1 block text-[11px] text-muted-foreground">
                    {t("image.params.negative")}
                  </Label>
                  <Textarea
                    id="edit-negative"
                    rows={2}
                    placeholder={t("image.params.negativePlaceholder")}
                    value={negative}
                    onChange={(e) => setNegative(e.target.value)}
                    className="resize-none text-xs"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label htmlFor="edit-steps" className="mb-1 block text-[11px] text-muted-foreground">
                      {t("image.params.steps")}
                    </Label>
                    <Input
                      id="edit-steps"
                      type="number"
                      min={1}
                      max={100}
                      value={steps}
                      onChange={(e) => setSteps(Math.max(1, Math.min(100, Number(e.target.value) || 25)))}
                      className="h-8 text-xs tabular-nums"
                    />
                  </div>
                  <div>
                    <Label htmlFor="edit-seed" className="mb-1 block text-[11px] text-muted-foreground">
                      {t("image.params.seed")}
                    </Label>
                    <Input
                      id="edit-seed"
                      type="number"
                      min={-1}
                      placeholder="-1"
                      value={seed}
                      onChange={(e) => setSeed(e.target.value)}
                      className="h-8 text-xs tabular-nums"
                    />
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>

          <Button size="lg" onClick={() => generate.mutate()} disabled={!canGenerate} className="w-full">
            {generate.isPending ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <Wand2Icon data-icon="inline-start" />
            )}
            {generate.isPending ? t("image.editing") : t("image.edit")}
          </Button>
          {!reference && backend === "api" ? (
            <p className="text-center text-[10px] text-amber-600/80 dark:text-amber-400/80">
              {t("image.edit.needReference")}
            </p>
          ) : reference && backend !== "api" ? (
            <p className="text-center text-[10px] text-amber-600/80 dark:text-amber-400/80">
              {t("image.edit.backendNote")}
            </p>
          ) : null}
        </div>
      </aside>

      {/* 右侧：结果区 */}
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* 右上角：参考图悬浮预览卡 */}
        {reference && (
          <div className="absolute right-5 top-5 z-20 w-44 overflow-hidden rounded-xl border bg-card/95 shadow-lg backdrop-blur">
            <div className="relative aspect-video overflow-hidden bg-muted">
              <img src={reference.url} alt="" className="size-full object-cover" />
              <span className="absolute left-1.5 top-1.5 rounded-md bg-black/55 px-1.5 py-0.5 text-[9px] font-medium text-white">
                {t("image.edit.reference")}
              </span>
            </div>
          </div>
        )}

        <div className="flex min-h-0 flex-1 items-center justify-center p-8 pt-16">
          {generate.isPending ? (
            <GenLoading prompt={prompt} />
          ) : results?.length ? (
            <div className="flex min-w-0 max-w-full flex-wrap items-center justify-center gap-5">
              {results.map((r) => (
                <ImageCard key={r.id} record={r} />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-3 text-center">
              <div className="flex size-20 items-center justify-center rounded-2xl bg-primary/15">
                <Wand2Icon className="size-9 text-primary" />
              </div>
              <p className="text-lg font-medium">{t("image.edit.title")}</p>
              <p className="max-w-xs text-sm text-muted-foreground">{t("image.edit.emptyHint")}</p>
            </div>
          )}
        </div>

        <RecentStrip
          records={recordsData?.records ?? []}
          onOpenHistory={() => useImageStore.getState().setView("history")}
        />
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 页面入口：按左侧边栏工具菜单切换；历史记录在左侧主侧边栏查看
// ---------------------------------------------------------------------------

export function ImageScreen() {
  const t = useT();
  const tool = useImageStore((s) => s.tool);
  const view = useImageStore((s) => s.view);

  // 「更多」进入的全部历史页（含所有图片与提示词）。
  if (view === "history") return <HistoryScreen />;

  if (tool === "batch") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <div className="flex size-20 items-center justify-center rounded-2xl bg-primary/15">
          <LayersIcon className="size-9 text-primary" />
        </div>
        <p className="text-sm text-muted-foreground">{t("image.comingSoon")}</p>
      </div>
    );
  }

  if (tool === "edit") return <EditTab />;

  return <GenerateTab />;
}
