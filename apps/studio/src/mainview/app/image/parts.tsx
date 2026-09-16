import { CSSProperties } from "react";
import { SparklesIcon, Loader2Icon, DownloadIcon, TrashIcon, ChevronRightIcon, HistoryIcon, PaletteIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Badge } from "@ui/badge";
import { useT } from "@stores/ui-lang";
import { MediaSourceBadge } from "@components/media-source-badge";
import { useImageStore } from "@stores/image";
import type { ImageRecordRow } from "../../../bun/image-gen";
import type { UILang } from "../../../shared/i18n";
import { cn } from "@/mainview/lib/utils";

// MLX_FALLBACKS 与 isForeignModel 住在 lib/image-model（纯逻辑 + 有测试）；
// 这里再导出一次，页面继续从 "./parts" 拿也不会有第二份定义。
export { MLX_FALLBACKS, isForeignModel } from "@lib/image-model";

export const RATIOS: { label: string; w: number; h: number }[] = [
  { label: "16:9", w: 1024, h: 576 },
  { label: "3:2", w: 1152, h: 768 },
  { label: "4:3", w: 1024, h: 768 },
  { label: "1:1", w: 1024, h: 1024 },
  { label: "3:4", w: 768, h: 1024 },
  { label: "2:3", w: 768, h: 1152 },
  { label: "9:16", w: 576, h: 1024 },
];

/**
 * 「随机」按钮的示例提示词，按界面语言分组。
 *
 * 此前是一份中英混排的列表，英文界面下点「随机」有一半概率蹦出中文 ——
 * 提示词会被真的发给模型，语言不对就是实打实的效果问题。
 */
export const RANDOM_PROMPTS: Record<UILang, string[]> = {
  zh: [
    "一只在星空下奔跑的机械狼，赛博朋克风格，霓虹光效，电影感构图，细节丰富",
    "清晨薄雾中的江南水乡，乌篷船划过平静的河面，水墨画风格，柔和的晨光",
    "悬浮在云海之上的天空之城，宫崎骏动画风格，吉卜力色彩，恢弘远景",
    "极简主义产品摄影：磨砂玻璃香水瓶置于大理石台面，柔和的侧逆光，高级质感",
  ],
  en: [
    "a mechanical wolf running under a starry sky, cyberpunk style, neon glow, cinematic composition, highly detailed",
    "a cozy bookshop cafe on a rainy evening, warm golden light, cinematic, highly detailed",
    "an astronaut floating above a coral reef planet, surreal dreamscape, vibrant colors",
    "minimalist product photography: frosted glass perfume bottle on a marble surface, soft rim light",
  ],
};

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatBytes(b: number): string {
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

export function downloadImage(url: string, record: ImageRecordRow) {
  void rpcClient.saveImageToDownloads({
    url,
    filename: `image-${record.id}-${Date.now()}.png`,
  });
}

// ---------------------------------------------------------------------------
// 结果卡片
// ---------------------------------------------------------------------------

export function ImageCard({
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
  // 按图片真实比例显示（用户选了 16:9 / 9:16 就展示成 16:9 / 9:16），
  // 不再用固定正方形裁切 —— 否则竖图/横图都会被裁成正方形，看起来像比例没生效。
  // 尺寸边界：高不超过 70vh、宽不超出容器，比例由图片自身决定。
  return (
    <div
      className={cn(
        "group relative w-fit max-w-full overflow-hidden rounded-xl border bg-muted/40 transition-shadow",
        highlight && "ring-2 ring-primary",
      )}
    >
      <img
        src={record.imageUrl}
        alt={record.prompt ?? ""}
        loading="lazy"
        className="max-h-[70vh] max-w-full object-contain"
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

export function GenLoading({ prompt }: { prompt: string }) {
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

export function Bubble({ style }: { style: CSSProperties }) {
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

export const RECENT_COUNT = 6;

export function RecentStrip({
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

export function HistoryCard({ record, onDelete }: { record: ImageRecordRow; onDelete: () => void }) {
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
        <MediaSourceBadge source={record.source} className="ml-auto" />
      </p>
    </div>
  );
}

