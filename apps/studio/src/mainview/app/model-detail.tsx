import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeftIcon,
  DownloadIcon,
  CheckCircle2Icon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  HardDriveIcon,
  TagIcon,
  RotateCcwIcon,
  AlertTriangleIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { useEngine } from "@lib/use-engine";
import { Button } from "@ui/button";
import { Badge } from "@ui/badge";
import { Spinner } from "@ui/spinner";
import { ScrollArea } from "@ui/scroll-area";
import { useRouter } from "@stores/router";
import { useModelDetailStore } from "@stores/model-detail";
import { useModelDownloadStore } from "@stores/model-download";
import { useT } from "@stores/ui-lang";
import { classifyModel, engineSupports } from "../../shared/modelscope";
import type { ModelFileKind, ModelScopeFile } from "../../shared/modelscope";
import { cn } from "@/mainview/lib/utils";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

function formatParams(params: number): string {
  if (!params) return "";
  if (params >= 1e9) return `${(params / 1e9).toFixed(1)}B`;
  if (params >= 1e6) return `${(params / 1e6).toFixed(0)}M`;
  return String(params);
}

function matchQuant(fileName: string, quant: string): boolean {
  const a = fileName.toLowerCase().replace(/[^a-z0-9]/g, "");
  const b = quant.toLowerCase().replace(/[^a-z0-9]/g, "");
  return b.length > 0 && a.includes(b);
}

const FORMAT_CLS: Record<ModelScopeFile["kind"], string> = {
  gguf: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400",
  safetensors: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400",
  other: "bg-muted text-muted-foreground",
};

function FileRow({
  file,
  repo,
  category,
  engine,
}: {
  file: ModelScopeFile;
  repo: string;
  category: import("../../shared/modelscope").ModelCategory;
  engine: import("../../shared/modelscope").InferenceEngine;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const tasks = useModelDownloadStore((s) => s.tasks);
  const installedModels = useQuery({
    queryKey: ["installed-models"],
    queryFn: () => rpcClient.listInstalledModels(),
  });

  const installedPaths = new Set((installedModels.data?.models ?? []).map((m) => m.fileName));
  const task = tasks.find((t) => t.repo === repo && t.fileName === file.name && t.status !== "canceled");

  const startMutation = useMutation({
    mutationFn: () => rpcClient.startModelDownload({ repo, fileName: file.name, category }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["model-downloads"] }),
  });
  const pauseMutation = useMutation({
    mutationFn: () => rpcClient.pauseModelDownload({ id: task!.id }),
  });
  const resumeMutation = useMutation({
    mutationFn: () => rpcClient.resumeModelDownload({ id: task!.id }),
  });

  const active = task?.status === "downloading" || task?.status === "queued";
  const downloading = task?.status === "downloading";

  return (
    <div className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate font-mono text-xs">{file.name}</p>
          <span
            className={cn(
              "inline-flex h-4 shrink-0 items-center rounded px-1 text-[9px] font-medium",
              FORMAT_CLS[file.kind],
            )}
          >
            {file.kind === "gguf"
              ? t("models.format.gguf")
              : file.kind === "safetensors"
                ? t("models.format.safetensors")
                : t("models.format.other")}
          </span>
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
        </p>
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

      {installedPaths.has(file.name) ? (
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
          {t("models.download")}
        </Button>
      )}
      {active && <span className="sr-only" />}
    </div>
  );
}

export function ModelDetailScreen() {
  const t = useT();
  const queryClient = useQueryClient();
  const { source, setSource } = useModelDetailStore();
  const setRoute = useRouter((s) => s.setRoute);
  const { engine } = useEngine();
  // null = auto: follow the active engine's native format
  const [formatFilter, setFormatFilter] = useState<"all" | ModelFileKind | null>(null);

  const repo = source?.kind === "preset" ? source.preset.repo : source?.kind === "search" ? source.model.id : null;

  const filesQuery = useQuery({
    queryKey: ["modelscope-files", repo],
    queryFn: () => rpcClient.listModelScopeFiles({ repo: repo! }),
    enabled: !!repo,
  });

  const category: import("../../shared/modelscope").ModelCategory | null = useMemo(() => {
    if (!source) return null;
    if (source.kind === "preset") return source.preset.app;
    return classifyModel(source.model);
  }, [source]);

  const files = filesQuery.data?.files ?? [];
  const effectiveFilter: "all" | ModelFileKind =
    formatFilter ?? (engine === "llama.cpp" ? "gguf" : "safetensors");
  const visibleFiles = useMemo(
    () => (effectiveFilter === "all" ? files : files.filter((f) => f.kind === effectiveFilter)),
    [files, effectiveFilter],
  );

  const recommended = useMemo(() => {
    if (visibleFiles.length === 0) return null;
    const quant = source?.kind === "preset" ? source.preset.defaultQuant : null;
    if (quant) {
      const hit = visibleFiles.find((f) => matchQuant(f.name, quant));
      if (hit) return hit;
    }
    // No quant match (or a search result): fall back to the largest weight
    // file — works for GGUF / safetensors / bin / pt / onnx / ckpt.
    const weights = visibleFiles.filter((f) => f.isWeight);
    if (weights.length === 0) return null;
    return weights.reduce<ModelScopeFile>(
      (best, f) => (best.size < f.size ? f : best),
      weights[0]!,
    );
  }, [visibleFiles, source]);

  const { data: installedData } = useQuery({
    queryKey: ["installed-models"],
    queryFn: () => rpcClient.listInstalledModels(),
  });
  const installedNames = useMemo(
    () => new Set((installedData?.models ?? []).map((m) => m.fileName)),
    [installedData],
  );
  const pendingFiles = useMemo(
    () => visibleFiles.filter((f) => !installedNames.has(f.name)),
    [visibleFiles, installedNames],
  );

  const downloadAll = useMutation({
    mutationFn: async () => {
      for (const f of pendingFiles) {
        await rpcClient.startModelDownload({ repo: repo!, fileName: f.name, category: category ?? undefined });
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["model-downloads"] }),
  });

  if (!source || !repo) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <p className="text-sm text-muted-foreground">{t("models.detailNoModel")}</p>
        <Button variant="outline" size="sm" onClick={() => setRoute({ path: "models" })}>
          <ArrowLeftIcon data-icon="inline-start" /> {t("common.back")}
        </Button>
      </div>
    );
  }

  const name = source.kind === "preset" ? source.preset.label : source.model.name || source.model.id;
  const description =
    source.kind === "preset" ? source.preset.description : source.model.description || "";

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-6">
        {/* Back */}
        <Button variant="ghost" size="sm" className="-ml-2 w-fit" onClick={() => setRoute({ path: "models" })}>
          <ArrowLeftIcon data-icon="inline-start" className="size-4" />
          {t("common.back")}
        </Button>

        {/* Hero */}
        <div className="rounded-xl border bg-card p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold tracking-tight">{name}</h2>
              <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground/80">{repo}</p>
            </div>
            {category && (
              <span className="inline-flex h-6 items-center rounded-full bg-primary/10 px-2 text-xs font-medium text-primary">
                {t(`models.cat.${category}`)}
              </span>
            )}
          </div>

          {description && (
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{description}</p>
          )}

          <div className="mt-3 flex flex-wrap gap-1.5">
            {source.kind === "search" && (
              <>
                {source.model.params > 0 && (
                  <Badge variant="secondary" className="text-[10px]">
                    {formatParams(source.model.params)} params
                  </Badge>
                )}
                <Badge variant="secondary" className="text-[10px]">
                  {formatBytes(source.model.fileSize)} total
                </Badge>
                <Badge variant="secondary" className="text-[10px]">
                  {source.model.downloads} downloads
                </Badge>
                <Badge variant="secondary" className="text-[10px]">
                  {source.model.likes} likes
                </Badge>
                {source.model.license && (
                  <Badge variant="secondary" className="text-[10px]">
                    {source.model.license}
                  </Badge>
                )}
              </>
            )}
            {source.kind === "preset" && source.preset.defaultQuant && (
              <Badge variant="secondary" className="text-[10px]">
                {source.preset.defaultQuant}
              </Badge>
            )}
          </div>

          {source.kind === "search" && (source.model.tags.length > 0 || source.model.tasks.length > 0) && (
            <div className="mt-3 flex flex-wrap gap-1">
              <TagIcon className="mt-0.5 size-3.5 text-muted-foreground/60" />
              {[...source.model.tasks, ...source.model.tags].slice(0, 12).map((tag) => (
                <span
                  key={tag}
                  className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* Big download button */}
          <div className="mt-4 flex items-center gap-2 border-t pt-4">
            {recommended ? (
              <DownloadRecommendedButton repo={repo} file={recommended} category={category} />
            ) : (
              <p className="text-xs text-muted-foreground">{t("models.noFiles")}</p>
            )}
          </div>
        </div>

        {/* Files */}
        <div>
          <div className="mb-2 flex items-end justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h3 className="flex items-center gap-2 text-sm font-medium">
                <HardDriveIcon className="size-4" />
                {t("models.files")}
                <span className="text-xs font-normal text-muted-foreground">
                  ({visibleFiles.length})
                </span>
              </h3>
              <p className="text-[11px] text-muted-foreground">{t("models.formatHint")}</p>
            </div>
            {visibleFiles.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={pendingFiles.length === 0 || downloadAll.isPending}
                onClick={() => downloadAll.mutate()}
              >
                {downloadAll.isPending ? (
                  <Loader2Icon data-icon="inline-start" className="animate-spin" />
                ) : (
                  <DownloadIcon data-icon="inline-start" />
                )}
                {t("models.downloadAll")} ({pendingFiles.length})
              </Button>
            )}
          </div>

          {/* Engine-aware format filter */}
          <div className="mb-3 flex flex-wrap gap-1.5">
            {(["all", "gguf", "safetensors", "other"] as const).map((f) => {
              const isActive = effectiveFilter === f;
              return (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFormatFilter(f === "all" ? "all" : f)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs transition-colors",
                    isActive
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
                  )}
                >
                  {f === "all"
                    ? t("models.formatFilter.all")
                    : f === "gguf"
                      ? t("models.format.gguf")
                      : f === "safetensors"
                        ? t("models.format.safetensors")
                        : t("models.format.other")}
                </button>
              );
            })}
          </div>

          {filesQuery.isLoading ? (
            <div className="flex justify-center py-8">
              <Spinner className="size-5" />
            </div>
          ) : filesQuery.isError ? (
            <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
              {t("models.searchFailed")}: {String(filesQuery.error)}
            </p>
            ) : visibleFiles.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-8 text-center">
                <HardDriveIcon className="size-6 text-muted-foreground/50" />
                <p className="text-xs text-muted-foreground">
                  {effectiveFilter === "all" ? t("models.noFiles") : t("models.noCompatibleFiles")}
                </p>
                {effectiveFilter !== "all" && (
                  <button
                    type="button"
                    onClick={() => setFormatFilter("all")}
                    className="text-xs text-primary underline-offset-2 hover:underline"
                  >
                    {t("models.showAllFormats")}
                  </button>
                )}
              </div>
            ) : (
            <div className="flex flex-col gap-2">
              {visibleFiles.map((f) => (
                <FileRow key={f.path} file={f} repo={repo} category={category ?? "other"} engine={engine} />
              ))}
            </div>
          )}
        </div>
      </div>
    </ScrollArea>
  );
}

function DownloadRecommendedButton({
  repo,
  file,
  category,
}: {
  repo: string;
  file: ModelScopeFile;
  category: import("../../shared/modelscope").ModelCategory | null;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const installed = useQuery({
    queryKey: ["installed-models"],
    queryFn: () => rpcClient.listInstalledModels(),
  });
  const installedPaths = new Set((installed.data?.models ?? []).map((m) => m.fileName));
  const isInstalled = installedPaths.has(file.name);

  const mutation = useMutation({
    mutationFn: () => rpcClient.startModelDownload({ repo, fileName: file.name, category: category ?? undefined }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["model-downloads"] }),
  });

  if (isInstalled) {
    return (
      <Badge variant="default" className="h-8 gap-1.5 px-3 text-xs">
        <CheckCircle2Icon className="size-4" />
        {t("models.downloaded")} · {file.name}
      </Badge>
    );
  }

  return (
    <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
      {mutation.isPending ? (
        <Loader2Icon data-icon="inline-start" className="animate-spin" />
      ) : (
        <DownloadIcon data-icon="inline-start" />
      )}
      {t("models.downloadRecommended")} · {file.name}
    </Button>
  );
}
