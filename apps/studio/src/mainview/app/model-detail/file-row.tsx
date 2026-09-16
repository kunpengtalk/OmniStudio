import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DownloadIcon, CheckCircle2Icon, Loader2Icon, PauseIcon, PlayIcon, RotateCcwIcon, AlertTriangleIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Badge } from "@ui/badge";
import { useModelDownloadStore } from "@stores/model-download";
import { useT } from "@stores/ui-lang";
import { MODEL_SOURCE_META, engineSupports, fileBaseName, type MarketFile, type ModelSource } from "../../../shared/modelscope";
import { SourceBadge } from "@components/source-badge";
import { ModelFormatBadge } from "@components/model-category-badge";
import { installedFileNames } from "@/mainview/lib/installed-models";
import { queuePositionOf, taskEta } from "@lib/download-view";
import { formatBytes } from "./parts";

export function FileRow({
  file,
  repo,
  source,
  category,
  engine,
}: {
  file: MarketFile;
  repo: string;
  /** 列文件与下载走同一个平台：这里的来源就是下载来源。 */
  source: ModelSource;
  category: import("../../../shared/modelscope").ModelCategory;
  engine: import("../../../shared/modelscope").InferenceEngine;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const tasks = useModelDownloadStore((s) => s.tasks);
  const installedModels = useQuery({
    queryKey: ["installed-models"],
    queryFn: () => rpcClient.listInstalledModels(),
  });

  // 已安装列表存的是文件名，仓库里的文件可能是 `BF16/xxx.gguf` 这样的子目录路径；
  // 整仓库条目（一个仓库一条记录）的成员文件在 `files` 里，由 installedFileNames 摊平。
  const installedPaths = installedFileNames(installedModels.data?.models ?? []);
  const isInstalledHere = installedPaths.has(fileBaseName(file.name));
  const task = tasks.find((t) => t.repo === repo && t.fileName === file.name && t.status !== "canceled");
  const eta = task ? taskEta(task, t) : null;
  const etaSuffix = eta ? ` · ${eta}` : "";
  const position = task ? queuePositionOf(task, tasks) : null;
  const queuedAhead = position != null ? Math.max(0, position - 1) : null;

  const startMutation = useMutation({
    mutationFn: () =>
      rpcClient.startModelDownload({
        repo,
        fileName: file.name,
        category,
        source,
        // 用户单独点的这一个：带上体积用于排队，并显式插队（不排在批量小文件后面）。
        size: file.size,
        explicit: true,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["model-downloads"] }),
  });
  const pauseMutation = useMutation({
    mutationFn: () => rpcClient.pauseModelDownload({ id: task!.id }),
  });
  const resumeMutation = useMutation({
    mutationFn: () => rpcClient.resumeModelDownload({ id: task!.id }),
  });

  const active = task?.status === "downloading" || task?.status === "queued";

  return (
    <div className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate font-mono text-xs">{file.name}</p>
          <ModelFormatBadge
            kind={file.kind}
            label={
              file.kind === "gguf"
                ? t("models.format.gguf")
                : file.kind === "safetensors"
                  ? t("models.format.safetensors")
                  : t("models.format.other")
            }
            className="h-4 px-1 text-[9px]"
          />
          {!engineSupports(engine, file.kind) && (
            <span className="inline-flex h-4 shrink-0 items-center gap-0.5 rounded bg-amber-100 px-1 text-[9px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
              <AlertTriangleIcon className="size-2.5" />
              {t("models.incompatible")}
            </span>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">
          {formatBytes(file.size)}
          {task?.speed ? ` · ${formatBytes(task.speed)}/s` : ""}
          {task ? etaSuffix : ""}
        </p>
        {/* 排队中：告诉用户前面还有几个（小文件先下，队列会动）。 */}
        {task && queuedAhead != null && queuedAhead > 0 && (
          <p className="text-[10px] text-muted-foreground/80">
            {t("downloads.queuedAhead", { n: String(queuedAhead) })}
          </p>
        )}
        {/* 任务的下载源和本页不一致时标出来（例如之前从另一个平台开始下的）。 */}
        {task && task.source !== source && <SourceBadge source={task.source} className="mt-1" />}
        {task && (task.status === "downloading" || task.status === "paused") && (
          <div className="mt-1.5 h-1.5 w-full max-w-56 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300"
              style={{ width: `${task.percent ?? 0}%` }}
            />
          </div>
        )}
        {task?.status === "failed" && (
          <p className="mt-0.5 truncate text-[11px] text-destructive">{task.error ?? "failed"}</p>
        )}
      </div>

      {isInstalledHere ? (
        <Badge variant="secondary" className="shrink-0 text-[10px]">
          <CheckCircle2Icon className="size-3" /> {t("models.downloaded")}
        </Badge>
      ) : task ? (
        <div className="flex shrink-0 items-center gap-1">
          {task.status === "downloading" || task.status === "queued" ? (
            <>
              <span className="w-10 text-right text-[11px] text-muted-foreground tabular-nums">
                {task.percent != null ? `${task.percent.toFixed(0)}%` : "…"}
              </span>
              <Button
                variant="outline"
                size="icon-sm"
                tooltip={t("downloads.pause")}
                disabled={task.status === "queued"}
                onClick={() => pauseMutation.mutate()}
              >
                <PauseIcon className="size-3.5" />
              </Button>
            </>
          ) : task.status === "paused" ? (
            <>
              <span className="w-10 text-right text-[11px] text-muted-foreground tabular-nums">
                {task.percent != null ? `${task.percent.toFixed(0)}%` : "…"}
              </span>
              <Button
                variant="outline"
                size="icon-sm"
                tooltip={t("downloads.resume")}
                onClick={() => resumeMutation.mutate()}
              >
                <PlayIcon className="size-3.5" />
              </Button>
            </>
          ) : task.status === "failed" ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => resumeMutation.mutate()}
            >
              <RotateCcwIcon data-icon="inline-start" className="size-3" />
              {t("common.retry")}
            </Button>
          ) : null}
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="h-7 shrink-0 text-xs"
          disabled={startMutation.isPending}
          onClick={() => startMutation.mutate()}
        >
          {startMutation.isPending ? (
            <Loader2Icon data-icon="inline-start" className="animate-spin" />
          ) : (
            <DownloadIcon data-icon="inline-start" />
          )}
          {t("market.downloadFrom", { source: MODEL_SOURCE_META[source].label })}
        </Button>
      )}
      {active && <span className="sr-only" />}
    </div>
  );
}
