import { existsSync, readdirSync, rmSync, statSync } from "fs";
import path from "path";
import { downloadFile, downloadHuggingFaceFile, modelDestPath, type DownloadProgress } from "./modelscope";
import { setModelCategory } from "./model-store";
import { getSetting, updateSettings } from "./db/settings";
import type { ModelCategory } from "../shared/modelscope";

export type DownloadStatus = "queued" | "downloading" | "paused" | "completed" | "failed" | "canceled";

/** 下载源：ModelScope（默认）或 HuggingFace 镜像（audio.cpp GGUF 等）。 */
export type DownloadSource = "modelscope" | "huggingface";

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
};

const MAX_CONCURRENT = 2;
const EMIT_THROTTLE_MS = 300;
const PERSIST_THROTTLE_MS = 1000;
const TASKS_SETTINGS_KEY = "MODEL_DOWNLOADS";

/**
 * Runs model downloads with a small concurrent queue. Downloads run detached
 * from any RPC request, so multi-GB transfers survive longer than request
 * timeouts. Partial files (and resume via Range / per-part chunks) are kept on
 * pause, and the task list is persisted to settings so interrupted downloads
 * survive an app restart and resume automatically.
 */
export class DownloadManager {
  private tasks = new Map<string, DownloadTask>();
  private aborts = new Map<string, AbortController>();
  private queue: string[] = [];
  private running = 0;
  private lastEmit = 0;
  private lastPersist = 0;
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
        if (t.status === "completed" || t.status === "canceled") {
          this.tasks.set(t.id, t);
          continue;
        }
        // 失败/中断后只要磁盘上还有部分数据就继续下载;完全没有则标记失败
        // 由用户手动重试(点下载按钮会重新开始)。
        if (this.hasPartialData(t)) {
          this.tasks.set(t.id, { ...t, status: "queued", error: undefined, speed: 0 });
          this.queue.push(t.id);
        } else {
          this.tasks.set(t.id, {
            ...t,
            status: "failed",
            error: t.error ?? "下载中断,部分文件缺失,请重新下载",
            speed: 0,
          });
        }
      }
    } catch {
      // corrupted/old payload — start fresh
    }
    this.pump();
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

  start(repo: string, fileName: string, category?: ModelCategory, source: DownloadSource = "modelscope"): DownloadTask {
    const existing = [...this.tasks.values()].find(
      (t) =>
        t.repo === repo &&
        t.fileName === fileName &&
        t.status !== "completed" &&
        t.status !== "canceled",
    );
    if (existing) return existing;

    const task: DownloadTask = {
      id: crypto.randomUUID(),
      repo,
      fileName,
      category,
      source,
      status: "queued",
      received: 0,
      total: null,
      percent: null,
      speed: 0,
      createdAt: Date.now(),
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
    this.emit(true);
    this.pump();
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
    this.queue.push(id);
    this.emit(true);
    this.pump();
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
      rmSync(p, { force: true });
      const dir = path.dirname(p);
      const base = path.basename(p);
      for (const n of readdirSync(dir)) {
        if (n.startsWith(`${base}.part`)) rmSync(path.join(dir, n), { force: true });
      }
    } catch {
      // ignore
    }
  }

  private pump() {
    while (this.running < MAX_CONCURRENT && this.queue.length > 0) {
      const id = this.queue.shift()!;
      const task = this.tasks.get(id);
      if (!task || task.status === "canceled") continue;
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

    try {
      const dl = task.source === "huggingface" ? downloadHuggingFaceFile : downloadFile;
      await dl(
        task.repo,
        task.fileName,
        (p) => {
          task.received = p.received;
          task.total = p.total;
          task.percent = p.percent;
          const now = Date.now();
          if (now - lastTime >= 1000) {
            task.speed = Math.max(0, (p.received - lastBytes) / ((now - lastTime) / 1000));
            lastTime = now;
            lastBytes = p.received;
          }
          for (const cb of this.progressListeners) {
            cb({ repo: task.repo, fileName: task.fileName, progress: p });
          }
          this.emit(false);
        },
        ac.signal,
      );

      task.status = "completed";
      task.percent = 100;
      task.speed = 0;
      if (task.category) setModelCategory(task.repo, task.fileName, task.category);
      this.emit(true);
    } catch (e) {
      if (ac.signal.aborted) {
        // pause() flips task.status to "paused" before aborting; re-read it from the
        // map since the compiler cannot see that mutation from the control flow.
        if ((task.status as DownloadStatus) !== "paused") task.status = "canceled";
      } else {
        task.status = "failed";
        task.error = e instanceof Error ? e.message : String(e);
      }
      task.speed = 0;
      this.emit(true);
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
