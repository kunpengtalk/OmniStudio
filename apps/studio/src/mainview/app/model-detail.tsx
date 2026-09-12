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
import {
  MODEL_SOURCES,
  MODEL_SOURCE_META,
  classifyModel,
  engineSupports,
  fileBaseName,
  matchQuant,
  type MarketFile,
  type ModelSource,
} from "../../shared/modelscope";
import type { ModelFileKind } from "../../shared/modelscope";
import { SourceBadge } from "@components/source-badge";
import { installedFileNames } from "@/mainview/lib/installed-models";
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

/** 加载必需的配套文件（config / tokenizer / chat template 等）。 */
const SUPPORT_FILE_RE = /\.(json|model|txt|jinja|spm|ya?ml)$/i;

const FORMAT_CLS: Record<MarketFile["kind"], string> = {
  gguf: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400",
  safetensors: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400",
  other: "bg-muted text-muted-foreground",
};

function FileRow({
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

  // 已安装列表存的是文件名，仓库里的文件可能是 `BF16/xxx.gguf` 这样的子目录路径；
  // 整仓库条目（一个仓库一条记录）的成员文件在 `files` 里，由 installedFileNames 摊平。
  const installedPaths = installedFileNames(installedModels.data?.models ?? []);
  const isInstalledHere = installedPaths.has(fileBaseName(file.name));
  const task = tasks.find((t) => t.repo === repo && t.fileName === file.name && t.status !== "canceled");

  const startMutation = useMutation({
    mutationFn: () => rpcClient.startModelDownload({ repo, fileName: file.name, category, source }),
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

/**
 * 模型详情页：独立路由（返回模型库）或嵌在设置页内（onBack 返回设置标签页）。
 */
export function ModelDetailScreen({ onBack }: { onBack?: () => void } = {}) {
  const t = useT();
  const queryClient = useQueryClient();
  const { source, setSource } = useModelDetailStore();
  const setRoute = useRouter((s) => s.setRoute);
  const goBack = () => (onBack ? onBack() : setRoute({ path: "settings", tab: "store" }));
  const { engine } = useEngine();
  // null = auto: follow the active engine's native format
  const [formatFilter, setFormatFilter] = useState<"all" | ModelFileKind | null>(null);

  const repo = source?.kind === "preset" ? source.preset.repo : source?.kind === "search" ? source.model.id : null;
  // 列文件与下载必须用同一个 source，否则会出现"列的是 A 站的文件、下的是 B 站的字节"
  // （同一仓库在两个平台的文件名/目录结构并不一致）。默认取该模型被发现时所在的平台，
  // 用户可以在文件区手动切到另一个平台。
  const originSource: ModelSource = source?.kind === "search" ? source.model.source : "modelscope";
  const [sourceOverride, setSourceOverride] = useState<ModelSource | null>(null);
  const modelSource: ModelSource = sourceOverride ?? originSource;

  const filesQuery = useQuery({
    queryKey: ["market-files", modelSource, repo],
    queryFn: () => rpcClient.listModelFiles({ repo: repo!, source: modelSource }),
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
    return weights.reduce<MarketFile>(
      (best, f) => (best.size < f.size ? f : best),
      weights[0]!,
    );
  }, [visibleFiles, source]);

  const { data: installedData } = useQuery({
    queryKey: ["installed-models"],
    queryFn: () => rpcClient.listInstalledModels(),
  });
  const installedNames = useMemo(
    () => installedFileNames(installedData?.models ?? []),
    [installedData],
  );

  // safetensors / MLX 这类"整仓库"模型：权重分片必须和 config / tokenizer 一起下载，
  // 否则 vLLM / SGLang / mlx-lm 加载不了（只下一个 safetensors 是跑不起来的）。
  const supportFiles = useMemo(
    () =>
      effectiveFilter === "gguf"
        ? []
        : files.filter((f) => f.kind === "other" && SUPPORT_FILE_RE.test(fileBaseName(f.name))),
    [files, effectiveFilter],
  );
  const pendingFiles = useMemo(() => {
    const byPath = new Map<string, MarketFile>();
    for (const f of [...visibleFiles, ...supportFiles]) {
      if (!installedNames.has(fileBaseName(f.name))) byPath.set(f.path, f);
    }
    return [...byPath.values()];
  }, [visibleFiles, supportFiles, installedNames]);

  const downloadAll = useMutation({
    mutationFn: async () => {
      for (const f of pendingFiles) {
        await rpcClient.startModelDownload({
          repo: repo!,
          fileName: f.name,
          category: category ?? undefined,
          source: modelSource,
        });
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["model-downloads"] }),
  });

  if (!source || !repo) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <p className="text-sm text-muted-foreground">{t("models.detailNoModel")}</p>
        <Button variant="outline" size="sm" onClick={goBack}>
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
        <Button variant="ghost" size="sm" className="-ml-2 w-fit" onClick={goBack}>
          <ArrowLeftIcon data-icon="inline-start" className="size-4" />
          {t("common.back")}
        </Button>

        {/* Hero */}
        <div className="rounded-xl border bg-card p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold tracking-tight">{name}</h2>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <SourceBadge source={modelSource} />
                <span className="font-mono text-xs text-muted-foreground/80">{repo}</span>
              </div>
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
                {source.model.fileSize > 0 && (
                  <Badge variant="secondary" className="text-[10px]">
                    {formatBytes(source.model.fileSize)} total
                  </Badge>
                )}
                {source.model.fileCount > 0 && (
                  <Badge variant="secondary" className="text-[10px]">
                    {t("market.fileCount", { count: String(source.model.fileCount) })}
                  </Badge>
                )}
                {source.model.formats.map((f) => (
                  <Badge key={f} variant="secondary" className="text-[10px]">
                    {t(`models.format.${f}`)}
                  </Badge>
                ))}
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
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-4">
            {recommended ? (
              <DownloadRecommendedButton
                repo={repo}
                file={recommended}
                source={modelSource}
                category={category}
                repoFiles={pendingFiles.length > 0 ? pendingFiles : [recommended]}
              />
            ) : (
              <p className="text-xs text-muted-foreground">{t("models.noFiles")}</p>
            )}
            <span className="text-[11px] text-muted-foreground/70">
              {t("market.allFrom", {
                source: MODEL_SOURCE_META[modelSource].label,
                host: MODEL_SOURCE_META[modelSource].host,
              })}
            </span>
          </div>
        </div>

        {/* Files */}
        <div>
          <div className="mb-2 flex items-end justify-between gap-3">
            <div className="flex flex-col gap-1.5">
              <h3 className="flex items-center gap-2 text-sm font-medium">
                <HardDriveIcon className="size-4" />
                {t("models.files")}
                <span className="text-xs font-normal text-muted-foreground">
                  ({visibleFiles.length})
                </span>
              </h3>
              <p className="text-[11px] text-muted-foreground">{t("models.formatHint")}</p>
              {effectiveFilter !== "gguf" && (
                <p className="text-[11px] text-muted-foreground/70">
                  {t("models.supportFilesHint")}
                </p>
              )}
              {/* 平台选择：列文件与下载都按它走，两个平台的文件路径不同，不能混用 */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] text-muted-foreground">
                  {t("market.filesSourceLabel")}
                </span>
                <div className="inline-flex rounded-lg border p-0.5">
                  {MODEL_SOURCES.map((s) => {
                    const active = modelSource === s;
                    const meta = MODEL_SOURCE_META[s];
                    return (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setSourceOverride(s)}
                        title={meta.host}
                        className={cn(
                          "flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] transition-colors",
                          active
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {meta.label}
                        <span
                          className={cn(
                            "font-mono text-[9px]",
                            active ? "text-primary-foreground/70" : "text-muted-foreground/60",
                          )}
                        >
                          {meta.host}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {sourceOverride && sourceOverride !== originSource && (
                  <span className="text-[11px] text-muted-foreground/70">
                    {t("market.originWas", { source: MODEL_SOURCE_META[originSource].label })}
                  </span>
                )}
              </div>
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
                <FileRow
                  key={f.path}
                  file={f}
                  repo={repo}
                  source={modelSource}
                  category={category ?? "other"}
                  engine={engine}
                />
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
  source,
  category,
  repoFiles,
}: {
  repo: string;
  file: MarketFile;
  source: ModelSource;
  category: import("../../shared/modelscope").ModelCategory | null;
  /** 非 GGUF：整仓库一起下（分片 + config/tokenizer），否则引擎加载不了。 */
  repoFiles: MarketFile[];
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const installed = useQuery({
    queryKey: ["installed-models"],
    queryFn: () => rpcClient.listInstalledModels(),
  });
  const installedNames = installedFileNames(installed.data?.models ?? []);

  const singleFile = file.kind === "gguf";
  const targets = singleFile ? [file] : repoFiles.length > 0 ? repoFiles : [file];
  const isInstalled = targets.every((f) => installedNames.has(fileBaseName(f.name)));

  const mutation = useMutation({
    mutationFn: async () => {
      for (const f of targets) {
        await rpcClient.startModelDownload({
          repo,
          fileName: f.name,
          category: category ?? undefined,
          source,
        });
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["model-downloads"] }),
  });

  if (isInstalled) {
    return (
      <Badge variant="default" className="h-8 gap-1.5 px-3 text-xs">
        <CheckCircle2Icon className="size-4" />
        {t("models.downloaded")} · {singleFile ? file.name : repo}
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
      {singleFile
        ? `${t("market.downloadFrom", { source: MODEL_SOURCE_META[source].label })} · ${file.name}`
        : t("models.downloadRepoSet", { count: String(targets.length) })}
    </Button>
  );
}
