import type { DownloadTask } from "../../bun/download-manager";

/**
 * 下载面板与市场文件行的展示计算：排队位置、剩余时间、聚合速度/剩余量。
 *
 * 都放在渲染期按当前 tasks 现算 —— 任务列表本来就会通过 downloadsChanged
 * 推送刷新，不必为「排队第几位」再引一条状态。
 */

/** 字节数的展示形式（GB / MB / KB）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

const ACTIVE: ReadonlySet<DownloadTask["status"]> = new Set([
  "downloading",
  "queued",
  "paused",
  "failed",
]);

export function isActiveTask(task: DownloadTask): boolean {
  return ACTIVE.has(task.status);
}

/** 剩余时间的人类可读形式（如「约 3 分钟」）。速度或总量未知时返回 null。 */
export function formatEta(
  remainingBytes: number,
  speed: number,
  t: (key: string, params?: Record<string, string>) => string,
): string | null {
  if (!(remainingBytes > 0) || !(speed > 0)) return null;
  const seconds = Math.round(remainingBytes / speed);
  // 用 if 而不是三元链：三元在混排不同参数时很容易读错优先级
  // （这里踩过一次 —— 「3 小时」被渲染成「3 分钟」）。
  if (seconds < 60) {
    return t("downloads.etaSeconds", { n: String(Math.max(1, seconds)) });
  }
  if (seconds < 3600) {
    return t("downloads.etaMinutes", { n: String(Math.round(seconds / 60)) });
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return t("downloads.etaHours", { n: String(hours), m: String(minutes) });
}

/** 单个任务的剩余时间（速度与总量都已知时）。 */
export function taskEta(
  task: DownloadTask,
  t: (key: string, params?: Record<string, string>) => string,
): string | null {
  if (task.status !== "downloading") return null;
  const total = task.total ?? task.size ?? null;
  if (total == null) return null;
  return formatEta(Math.max(0, total - task.received), task.speed, t);
}

/**
 * 该任务在队列里的位置（1 起）。只对「等待中」有意义：
 * 正在下载/已暂停/已结束都返回 null。
 */
export function queuePositionOf(task: DownloadTask, tasks: readonly DownloadTask[]): number | null {
  if (task.status !== "queued") return null;
  const waiting = tasks
    .filter((t) => t.status === "queued")
    // 与后端出队顺序保持一致：插队的（order < 0）在前，其余按体积升序。
    .sort((a, b) => {
      const ra = a.order < 0 ? [0, -a.createdAt] : [1, a.size ?? Number.MAX_SAFE_INTEGER];
      const rb = b.order < 0 ? [0, -b.createdAt] : [1, b.size ?? Number.MAX_SAFE_INTEGER];
      return ra[0]! - rb[0]! || ra[1]! - rb[1]! || a.createdAt - b.createdAt;
    });
  const index = waiting.findIndex((t) => t.id === task.id);
  return index >= 0 ? index + 1 : null;
}

export type DownloadSummary = {
  /** 正在传输的字节/秒合计。 */
  speed: number;
  /** 已下字节合计（活跃任务）。 */
  received: number;
  /** 需要下载的字节合计（只有已知总量计入）。 */
  total: number;
  /** 还差多少字节（总数未知的任务不计入）。 */
  remainingBytes: number;
  /** 已完成比例（0-100），至少一个任务的 total 已知才有值。 */
  percent: number | null;
  activeCount: number;
};

/** 聚合统计：面板头部显示「合计 1.2/4.5 GB · 12 MB/s · 约 3 分钟」。 */
export function summarizeDownloads(tasks: readonly DownloadTask[]): DownloadSummary {
  let speed = 0;
  let remainingBytes = 0;
  let received = 0;
  let total = 0;
  let activeCount = 0;
  let anyTotal = false;

  for (const task of tasks) {
    if (!isActiveTask(task)) continue;
    activeCount += 1;
    speed += task.speed;
    received += task.received;
    const taskTotal = task.total ?? task.size ?? null;
    if (taskTotal != null && taskTotal > 0) {
      anyTotal = true;
      total += taskTotal;
      remainingBytes += Math.max(0, taskTotal - task.received);
    }
  }

  return {
    speed,
    received,
    total,
    remainingBytes,
    percent: anyTotal && total > 0 ? Math.floor((received / total) * 100) : null,
    activeCount,
  };
}
