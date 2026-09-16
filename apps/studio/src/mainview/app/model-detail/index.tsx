import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftIcon, DownloadIcon, Loader2Icon, HardDriveIcon, TagIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { useEngine } from "@lib/use-engine";
import { Button } from "@ui/button";
import { Badge } from "@ui/badge";
import { Spinner } from "@ui/spinner";
import { ScrollArea } from "@ui/scroll-area";
import { useRouter } from "@stores/router";
import { useModelDetailStore } from "@stores/model-detail";
import { useT } from "@stores/ui-lang";
import { MODEL_SOURCES, MODEL_SOURCE_META, classifyModel, fileBaseName, matchQuant, safeRepoId, type MarketFile, type ModelCategory, type ModelSource } from "../../../shared/modelscope";
import { ModelFileKind } from "../../../shared/modelscope";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { PageShell } from "@components/setting-ui";
import { SourceBadge } from "@components/source-badge";
import { ModelCategoryBadge, ModelFormatBadge } from "@components/model-category-badge";
import { installedFileNames } from "@/mainview/lib/installed-models";
import { cn } from "@/mainview/lib/utils";
import { FileRow } from "./file-row";
import { DownloadRecommendedButton } from "./download-button";
import { formatBytes, formatParams, SUPPORT_FILE_RE, sortBySizeAsc } from "./parts";

/**
 * 模型详情页：独立路由（返回模型库）或嵌在设置页内（onBack 返回设置标签页）。
 */

/** 类别下拉的选项：可手动指定的分类（不含 all / other —— other 是「没认出来」，不可手选）。 */
const CATEGORY_OPTIONS: ModelCategory[] = [
  "chat",
  "embedding",
  "rerank",
  "tts",
  "asr",
  "image",
  "video",
];
export function ModelDetailScreen({ onBack }: { onBack?: () => void } = {}) {
  const t = useT();
  const queryClient = useQueryClient();
  const { source } = useModelDetailStore();
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

  const category: import("../../../shared/modelscope").ModelCategory | null = useMemo(() => {
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

  // 类别改键（③-C2）：只对应用下载目录（managed）里的模型生效 —— setModelMeta 按仓库
  // 目录写 `.vllm-meta.json`，外部目录 / HF 缓存模型没有这个目录，写了也落不了盘。
  // repo 两侧都过 safeRepoId：市场页带斜杠的原始 repo id（`Qwen/X`）与安装列表里
  // 编码过的仓库标签（`Qwen__X`）才能对上。
  const installed = installedData?.models ?? [];
  const managedEntries = useMemo(
    () => installed.filter((m) => m.origin === "managed" && m.repo === safeRepoId(repo ?? "")),
    [installed, repo],
  );
  const externalOnly = useMemo(
    () =>
      !managedEntries.length &&
      installed.some((m) => m.origin !== "managed" && safeRepoId(m.repo) === safeRepoId(repo ?? "")),
    [installed, managedEntries.length, repo],
  );
  const setCategoryMutation = useMutation({
    // repo 目录下的多个文件条目共享同一份仓库元数据，用第一个条目的 path 落盘即可。
    mutationFn: async (category: ModelCategory) => {
      const res = await rpcClient.setModelCategory({ path: managedEntries[0]!.path, category });
      if (!res.ok) throw new Error(res.error || "Failed to update category");
      return res.model;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["installed-models"] }),
  });

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
      // 小文件优先：config / tokenizer / index 这些几 KB 的先下完，模型目录立刻
      // 具备可读性，几个 GB 的权重分片排在最后（后端队列也会按体积重排兜底）。
      for (const f of sortBySizeAsc(pendingFiles)) {
        await rpcClient.startModelDownload({
          repo: repo!,
          fileName: f.name,
          category: category ?? undefined,
          source: modelSource,
          size: f.size,
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
      <PageShell>
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
              <ModelCategoryBadge
                category={category}
                label={t(`models.cat.${category}`)}
                className="h-6 px-2 text-xs"
              />
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
                  <ModelFormatBadge key={f} kind={f} label={t(`models.format.${f}`)} />
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
            {/* 类别改键：仅市场下载（应用下载目录）的模型支持 —— 已下载为 chat 的嵌入
                模型改到这里再重启，就能被嵌入场景消费（KB 选择器只认嵌入实例）。 */}
            {managedEntries.length > 0 && managedEntries[0] && (
              <div className="ml-auto flex items-center gap-2">
                <span className="text-[11px] text-muted-foreground">{t("models.categoryLabel")}</span>
                <Select
                  value={managedEntries[0].category}
                  onValueChange={(v) => setCategoryMutation.mutate(v as ModelCategory)}
                >
                  <SelectTrigger size="sm" className="h-7 w-40 text-xs" disabled={setCategoryMutation.isPending}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {CATEGORY_OPTIONS.map((c) => (
                        <SelectItem key={c} value={c} className="text-xs">
                          {t(`models.cat.${c}`)}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          {externalOnly && (
            <p className="mt-2 text-[11px] text-muted-foreground/70">
              {t("models.categoryManagedOnly")}
            </p>
          )}
          {setCategoryMutation.error instanceof Error && (
            <p className="mt-2 text-[11px] text-destructive">{setCategoryMutation.error.message}</p>
          )}
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
      </PageShell>
    </ScrollArea>
  );
}
