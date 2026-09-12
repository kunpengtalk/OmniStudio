import { existsSync, readdirSync, statSync } from "fs";
import path from "path";
import { downloadFile, downloadHuggingFaceFile, modelDestPath, removePartialFiles } from "./modelscope";
import { concurrentFileLimit, type DownloadProgress } from "./downloader";
import { setModelMeta } from "./model-store";
import { getSetting, updateSettings } from "./db/settings";
import type { ModelCategory, ModelSource } from "../shared/modelscope";

export type DownloadStatus = "queued" | "downloading" | "paused" | "completed" | "failed" | "canceled";

/** 下载源：ModelScope（默认）或 HuggingFace（优先走 hf-mirror 镜像）。 */
export type DownloadSource = ModelSource;

export type DownloadTask = {
  id: string;
  repo: string;
  fileName: string;
  category?: ModelCategory;
  source: DownloadSource;
  status: DownloadStatus;
  received: number;
  total: number | null;
  percent: number | null;
  speed: number; // bytes / second
  error?: string;
  createdAt: number;
  /** 市场列表给的字节数；排队用它排序（小文件先下），也为 null 时按未知处理。 */
  size?: number | null;
  /** 入队序号：显式点击的任务是负值（插队），批量任务按体积升序排。 */
  order: number;
  /** 已经自动重试过多少轮（失败信息里展示）。 */
  retries?: number;
};

const EMIT_THROTTLE_MS = 300;
const PERSIST_THROTTLE_MS = 1000;
/** 进度事件广播节流（webview 每条进度都会写 store 并重渲染）。 */
const PROGRESS_EMIT_MS = 400;
const TASKS_SETTINGS_KEY = "MODEL_DOWNLOADS";
/** 文件级自动重试轮数（分片级的重试在内核里）。 */
const FILE_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 3_000;

/**
 * Runs model downloads with a small concurrent queue. Downloads run detached
 * from any RPC request, so multi-GB transfers survive longer than request
 * timeouts. Partial files (and resume via Range / per-part chunks) are kept on
 * pause, and the task list is persisted to settings so interrupted downloads
 * survive an app restart and resume automatically.
 *
 * 队列按「小文件优先」出队：多分片的 safetensors 仓库里 config / tokenizer /
 * index 这些几 KB 的文件先下完，模型目录几百毫秒内就具备可读性，大权重最后下。
 */
export class DownloadManager {
  private tasks = new Map<string, DownloadTask>();
  private aborts = new Map<string, AbortController>();
  private queue: string[] = [];
  private running = 0;
  private lastEmit = 0;
  private lastPersist = 0;
  private batchSeq = 0;
  /** pump 已经排进微任务（同一批 start 只调一次）。 */
  private pumpScheduled = false;
  private listeners = new Set<() => void>();
  private progressListeners = new Set<
    (p: { repo: string; fileName: string; progress: DownloadProgress }) => void
  >();

  constructor() {
    this.loadPersisted();
  }

  /** 从 settings 恢复上次的任务,未完成的且磁盘上有部分数据 → 自动续传。 */
  private loadPersisted() {
    try {
      const raw = getSetting(TASKS_SETTINGS_KEY) || "[]";
      const list = JSON.parse(raw) as DownloadTask[];
      if (!Array.isArray(list)) return;
      for (const t of list) {
        if (
          !t ||
          typeof t.id !== "string" ||
          typeof t.repo !== "string" ||
          typeof t.fileName !== "string"
        ) {
          continue;
        }
        // 老版本持久化的任务没有 order/size 字段，按缺省值补上。
        const task: DownloadTask = {
          ...t,
          order: Number.isFinite(t.order) ? t.order : this.nextOrder(),
          size: Number.isFinite(t.size) ? t.size : (t.total ?? null),
        };
        if (task.status === "completed" || task.status === "canceled") {
          this.tasks.set(task.id, task);
          continue;
        }
        // 失败/中断后只要磁盘上还有部分数据就继续下载;完全没有则标记失败
        // 由用户手动重试(点下载按钮会重新开始)。
        if (this.hasPartialData(task)) {
          this.tasks.set(task.id, { ...task, status: "queued", error: undefined, speed: 0 });
          this.queue.push(task.id);
        } else {
          this.tasks.set(task.id, {
            ...task,
            status: "failed",
            error: task.error ?? "下载中断,部分文件缺失,请重新下载",
            speed: 0,
          });
        }
      }
    } catch {
      // corrupted/old payload — start fresh
    }
    // 重启后也按小文件优先恢复，别让上次排在队首的大文件继续压着。
    this.sortQueue();
    this.schedulePump();
  }

  /** 磁盘上是否已有该任务的部分数据(最终文件或 .part 分片)。 */
  private hasPartialData(task: DownloadTask): boolean {
    const p = modelDestPath(task.repo, task.fileName);
    if (!p) return false;
    try {
      if (existsSync(p) && statSync(p).size > 0) return true;
      const dir = path.dirname(p);
      const base = path.basename(p);
      return readdirSync(dir).some(
        (n) => n.startsWith(`${base}.part`) && statSync(path.join(dir, n)).size > 0,
      );
    } catch {
      return false;
    }
  }

  /** 任务列表写入 settings,重启后可按文件续传。 */
  private persistTasks(force: boolean) {
    if (!force) {
      const now = Date.now();
      if (now - this.lastPersist < PERSIST_THROTTLE_MS) return;
      this.lastPersist = now;
    }
    try {
      updateSettings({ [TASKS_SETTINGS_KEY]: JSON.stringify([...this.tasks.values()]) });
    } catch {
      // ignore
    }
  }

  onTasksChanged(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onProgress(
    cb: (p: { repo: string; fileName: string; progress: DownloadProgress }) => void,
  ): () => void {
    this.progressListeners.add(cb);
    return () => this.progressListeners.delete(cb);
  }

  list(): DownloadTask[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 批量入队的序号：显式点击用负值插队，其余按体积升序。 */
  private nextOrder(): number {
    this.batchSeq += 1;
    return this.batchSeq;
  }

  /**
   * 出队排序键：显式点击的任务（order < 0）永远最先，多个显式任务里「后点的先下」；
   * 批量任务按体积升序 —— 小文件先下完，模型目录（config / tokenizer）先具备
   * 可读性，大权重排最后；未知体积的排在同类末尾。
   */
  private queueRank(task: DownloadTask): [number, number] {
    if (task.order < 0) return [0, -task.createdAt];
    return [1, task.size ?? Number.MAX_SAFE_INTEGER];
  }

  private sortQueue() {
    const byId = this.tasks;
    this.queue.sort((a, b) => {
      const ta = byId.get(a);
      const tb = byId.get(b);
      if (!ta) return 1;
      if (!tb) return -1;
      const ra = this.queueRank(ta);
      const rb = this.queueRank(tb);
      return ra[0] - rb[0] || ra[1] - rb[1] || ta.createdAt - tb.createdAt;
    });
  }

  /**
   * 排队入口。`size` 是市场列表给的字节数；给了就能按体积排序，没给（老调用、
   * CLI、控制套接字）按未知处理排在已知大小的后面。
   * `explicit` 为 true（用户单独点了这个文件）时插队，不参与体积排序。
   */
  start(
    repo: string,
    fileName: string,
    category?: ModelCategory,
    source: DownloadSource = "modelscope",
    opts: { size?: number | null; explicit?: boolean } = {},
  ): DownloadTask {
    const existing = [...this.tasks.values()].find(
      (t) =>
        t.repo === repo &&
        t.fileName === fileName &&
        t.status !== "completed" &&
        t.status !== "canceled",
    );
    if (existing) {
      // 已经在下/排队/失败的任务：把新拿到的大小信息补上，队列会重排。
      if (opts.size != null && existing.size !== opts.size) {
        existing.size = opts.size;
        this.sortQueue();
        this.emit(true);
      }
      return existing;
    }

    const size = opts.size != null && Number.isFinite(opts.size) && opts.size > 0 ? opts.size : null;
    const task: DownloadTask = {
      id: crypto.randomUUID(),
      repo,
      fileName,
      category,
      source,
      status: "queued",
      received: 0,
      total: size,
      percent: null,
      speed: 0,
      createdAt: Date.now(),
      size,
      order: opts.explicit ? -1 : this.nextOrder(),
    };
    // 落盘路径不合法（含 ../ 或绝对路径）时直接标记失败，避免进队列后覆盖数据目录外的文件。
    if (!modelDestPath(repo, fileName)) {
      task.status = "failed";
      task.error = `非法的下载路径：${fileName}`;
      this.tasks.set(task.id, task);
      this.emit(true);
      return task;
    }
    this.tasks.set(task.id, task);
    this.queue.push(task.id);
    this.sortQueue();
    this.emit(true);
    this.schedulePump();
    return task;
  }

  pause(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.status !== "downloading") return false;
    task.status = "paused";
    this.aborts.get(id)?.abort();
    this.emit(true);
    return true;
  }

  resume(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || (task.status !== "paused" && task.status !== "failed")) return false;
    task.status = "queued";
    task.error = undefined;
    task.retries = 0;
    // 手动恢复 = 用户明确要这个文件，插队优先。
    task.order = -1;
    this.queue.push(id);
    this.sortQueue();
    this.emit(true);
    this.schedulePump();
    return true;
  }

  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.status !== "completed") {
      task.status = "canceled";
      this.aborts.get(id)?.abort();
      this.removePartial(task);
    }
    this.emit(true);
    return true;
  }

  remove(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    this.aborts.get(id)?.abort();
    this.queue = this.queue.filter((q) => q !== id);
    this.tasks.delete(id);
    if (task.status !== "completed") this.removePartial(task);
    this.emit(true);
    return true;
  }

  private removePartial(task: DownloadTask) {
    // 路径必须做穿越校验：任务的 repo/fileName 来自 RPC 与控制套接字，
    // 未校验的 `../` 会让"取消下载"变成删除数据目录外的任意文件。
    const p = modelDestPath(task.repo, task.fileName);
    if (!p) return;
    try {
      removePartialFiles(p);
    } catch {
      // ignore
    }
  }

  /**
   * 推迟到微任务再出队。
   *
   * 「下载整个仓库」是在一个循环里连续 start() 的，而 `pump()` 一旦同步执行，
   * 队首两个会被立刻拉走 —— 排在后面刚入队的 config / tokenizer 就再也插不到
   * 前面，小文件优先形同虚设。等同步批次跑完、队列排过序再出队，顺序才是对的。
   */
  private schedulePump() {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private pump() {
    const limit = concurrentFileLimit();
    while (this.running < limit && this.queue.length > 0) {
      const id = this.queue.shift()!;
      const task = this.tasks.get(id);
      if (!task || task.status === "canceled" || task.status === "completed") continue;
      this.running += 1;
      void this.run(task);
    }
  }

  private async run(task: DownloadTask) {
    task.status = "downloading";
    task.error = undefined;
    this.emit(true);

    const ac = new AbortController();
    this.aborts.set(task.id, ac);

    let lastTime = Date.now();
    let lastBytes = task.received;
    let lastProgressEmit = 0;

    try {
      const dl = task.source === "huggingface" ? downloadHuggingFaceFile : downloadFile;
      const result = await dl(task.repo, task.fileName, {
        total: task.size ?? task.total ?? undefined,
        signal: ac.signal,
        onProgress: (p) => {
          task.received = p.received;
          task.total = p.total ?? task.total;
          // 探测到的真实大小回填，便于市场列表与排队显示。
          if (task.size == null && p.total != null) task.size = p.total;
          task.percent = p.percent;
          const now = Date.now();
          if (now - lastTime >= 1000) {
            task.speed = Math.max(0, (p.received - lastBytes) / ((now - lastTime) / 1000));
            lastTime = now;
            lastBytes = p.received;
          }
          // 并行分片下载时底层回调很密，这里再节流一次：webview 侧每条进度都会
          // 触发一次 store 写入 + 重渲染，400ms 足够流畅（任务状态字段始终最新）。
          if (now - lastProgressEmit >= PROGRESS_EMIT_MS) {
            lastProgressEmit = now;
            for (const cb of this.progressListeners) {
              cb({ repo: task.repo, fileName: task.fileName, progress: p });
            }
          }
          this.emit(false);
        },
      });

      task.status = "completed";
      task.percent = 100;
      task.received = result.size;
      task.total = result.size;
      task.speed = 0;
      task.retries = 0;
      // 落盘后把分类和来源平台一起写进仓库元数据，本地模型列表才能显示"从哪儿下的"。
      setModelMeta(task.repo, { category: task.category, source: task.source });
      this.emit(true);
    } catch (e) {
      task.speed = 0;
      if (ac.signal.aborted) {
        // pause() flips task.status to "paused" before aborting; re-read it from the
        // map since the compiler cannot see that mutation from the control flow.
        if ((task.status as DownloadStatus) !== "paused") task.status = "canceled";
        this.emit(true);
      } else {
        const message = e instanceof Error ? e.message : String(e);
        const used = task.retries ?? 0;
        // 先把状态字段写完再广播，避免订阅者看到「次数已加、错误还是上一轮」的中间态。
        if (used + 1 >= FILE_ATTEMPTS) {
          // 重试用尽：保留最终错误，用户点「继续」还能从断点接着下。
          task.status = "failed";
          task.error = message;
          task.speed = 0;
          this.emit(true);
        } else {
          task.retries = used + 1;
          task.status = "queued";
          task.error = `${message}（将自动重试）`;
          task.speed = 0;
          this.emit(true);
          // 退避之后再放回队列：出队路径会立刻捞队列里的任务（pump 在 run 的
          // finally 里），先 push 会把退避变成空操作 —— 之前就是瞬时重试。
          setTimeout(
            () => {
              const current = this.tasks.get(task.id);
              if (!current || current.status !== "queued") return;
              this.queue.push(task.id);
              this.sortQueue();
              this.schedulePump();
            },
            RETRY_BACKOFF_MS * task.retries,
          );
        }
      }
    } finally {
      this.aborts.delete(task.id);
      this.running -= 1;
      this.pump();
    }
  }

  private emit(force: boolean) {
    const now = Date.now();
    if (!force && now - this.lastEmit < EMIT_THROTTLE_MS) return;
    this.lastEmit = now;
    for (const cb of this.listeners) cb();
    // 状态变化立即持久化,进度更新节流持久化,保证中断后能恢复。
    this.persistTasks(force);
  }
}

export const downloadManager = new DownloadManager();
