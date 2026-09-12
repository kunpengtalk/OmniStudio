import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DownloadCloudIcon,
  PauseIcon,
  PlayIcon,
  XIcon,
  Trash2Icon,
  CheckCircle2Icon,
  Loader2Icon,
  ClockIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { ScrollArea } from "@ui/scroll-area";
import { useModelDownloadStore } from "@stores/model-download";
import { useT } from "@stores/ui-lang";
import { SourceBadge } from "./source-badge";
import type { DownloadTask } from "../../bun/download-manager";
import { cn } from "@/mainview/lib/utils";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

const STATUS_STYLES: Record<DownloadTask["status"], string> = {
  queued: "bg-muted-foreground/15 text-muted-foreground",
  downloading: "bg-blue-500/15 text-blue-500",
  paused: "bg-amber-500/15 text-amber-500",
  completed: "bg-emerald-500/15 text-emerald-500",
  failed: "bg-destructive/15 text-destructive",
  canceled: "bg-muted-foreground/15 text-muted-foreground",
};

function TaskRow({ task }: { task: DownloadTask }) {
  const t = useT();
  const queryClient = useQueryClient();

  const pause = useMutation({
    mutationFn: () => rpcClient.pauseModelDownload({ id: task.id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["model-downloads"] }),
  });
  const resume = useMutation({
    mutationFn: () => rpcClient.resumeModelDownload({ id: task.id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["model-downloads"] }),
  });
  const cancel = useMutation({
    mutationFn: () => rpcClient.cancelModelDownload({ id: task.id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["model-downloads"] }),
  });
  const remove = useMutation({
    mutationFn: () => rpcClient.removeDownload({ id: task.id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["model-downloads"] }),
  });

  const busy = pause.isPending || resume.isPending || cancel.isPending || remove.isPending;
  const showProgress =
    task.status === "downloading" ||
    task.status === "paused" ||
    task.status === "queued" ||
    task.status === "failed";
  const done = task.status === "completed";

  return (
    <div className="rounded-lg border px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{task.fileName}</p>
          <div className="mt-0.5 flex items-center gap-1.5">
            {/* 每个任务都能看出字节是从哪个站拉下来的 */}
            <SourceBadge source={task.source} />
            <span className="truncate font-mono text-[10px] text-muted-foreground/70">
              {task.repo}
            </span>
          </div>
          <p className="mt-0.5 text-[10px] text-muted-foreground tabular-nums">
            {formatBytes(task.received)}
            {task.total ? ` / ${formatBytes(task.total)}` : ""}
            {task.speed ? ` · ${formatBytes(task.speed)}/s` : ""}
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
            STATUS_STYLES[task.status],
          )}
        >
          {t(`downloads.status.${task.status}`)}
        </span>
      </div>

      {showProgress && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-200",
              task.status === "failed" ? "bg-destructive" : "bg-primary",
            )}
            style={{ width: `${task.percent ?? 0}%` }}
          />
        </div>
      )}
      {task.status === "failed" && task.error && (
        <p className="mt-1 truncate text-[10px] text-destructive">{task.error}</p>
      )}

      <div className="mt-2 flex items-center justify-end gap-1">
        {task.status === "downloading" && (
          <Button variant="outline" size="icon-sm" tooltip={t("downloads.pause")} disabled={busy} onClick={() => pause.mutate()}>
            <PauseIcon className="size-3.5" />
          </Button>
        )}
        {(task.status === "paused" || task.status === "failed") && (
          <Button variant="outline" size="icon-sm" tooltip={t("downloads.resume")} disabled={busy} onClick={() => resume.mutate()}>
            {task.status === "failed" ? <ClockIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
          </Button>
        )}
        {!done && (task.status === "downloading" || task.status === "paused" || task.status === "queued") && (
          <Button variant="outline" size="icon-sm" tooltip={t("downloads.cancel")} disabled={busy} onClick={() => cancel.mutate()}>
            <XIcon className="size-3.5" />
          </Button>
        )}
        {(done || task.status === "failed" || task.status === "canceled") && (
          <Button variant="outline" size="icon-sm" tooltip={t("common.delete")} disabled={busy} onClick={() => remove.mutate()}>
            <Trash2Icon className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

export function DownloadsButton() {
  const t = useT();
  const tasks = useModelDownloadStore((s) => s.tasks);
  const setTasks = useModelDownloadStore((s) => s.setTasks);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  // Load task list once on mount (broadcasts keep it fresh afterwards).
  useEffect(() => {
    void rpcClient.listDownloads().then((r) => setTasks(r.tasks));
  }, [setTasks]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const active = tasks.filter((t) =>
    t.status === "downloading" || t.status === "queued" || t.status === "paused" || t.status === "failed",
  ).length;
  const completed = tasks.filter((t) => t.status === "completed").length;

  const clearCompleted = () => {
    const done = tasks.filter((t) => t.status === "completed");
    for (const task of done) {
      void rpcClient.removeDownload({ id: task.id }).then(() => {
        queryClient.invalidateQueries({ queryKey: ["model-downloads"] });
      });
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <Button
        variant="ghost"
        size="icon-sm"
        tooltip={t("downloads.title")}
        onClick={() => setOpen((v) => !v)}
      >
        {active > 0 ? (
          <Loader2Icon className="size-4 animate-spin" />
        ) : (
          <DownloadCloudIcon className="size-4" />
        )}
        {active > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-primary text-[9px] font-semibold text-primary-foreground">
            {active > 9 ? "9+" : active}
          </span>
        )}
      </Button>

      {open && (
        <div className="absolute top-full right-0 z-50 mt-2 flex w-80 flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-xs font-medium">
              {t("downloads.title")}
              {tasks.length > 0 && (
                <span className="ml-1.5 text-muted-foreground">({tasks.length})</span>
              )}
            </span>
            {completed > 0 && (
              <Button variant="ghost" size="sm" className="h-6 text-[11px]" onClick={clearCompleted}>
                <Trash2Icon data-icon="inline-start" className="size-3" />
                {t("downloads.clearDone")}
              </Button>
            )}
          </div>
          <ScrollArea className="max-h-80">
            <div className="flex flex-col gap-2 p-2">
              {tasks.length === 0 ? (
                <div className="flex flex-col items-center gap-1.5 py-10 text-center">
                  <DownloadCloudIcon className="size-6 text-muted-foreground/40" />
                  <p className="text-xs text-muted-foreground">{t("downloads.empty")}</p>
                </div>
              ) : (
                tasks.map((task) => <TaskRow key={task.id} task={task} />)
              )}
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  );
}
