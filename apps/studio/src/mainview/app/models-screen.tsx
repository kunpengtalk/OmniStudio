import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  StoreIcon,
  ChevronRightIcon,
  FolderIcon,
  SparklesIcon,
  StarIcon,
  PlayIcon,
  Loader2Icon,
  AlertTriangleIcon,
  HardDriveIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { useEngine } from "@lib/use-engine";
import { Button } from "@ui/button";
import { ScrollArea } from "@ui/scroll-area";
import { Spinner } from "@ui/spinner";
import { useServerStore } from "@stores/server";
import { useModelDetailStore, type ModelDetailSource } from "@stores/model-detail";
import { useT } from "@stores/ui-lang";
import { serverErrorHint } from "@/mainview/lib/server-error";
import {
  MODEL_PRESETS,
  MODEL_CATEGORIES,
  fileKind,
  matchCategory,
  engineSupports,
  type ModelCategory,
  type InstalledModel,
} from "@/shared/modelscope";
import { cn } from "@/mainview/lib/utils";
import {
  ModelCategoryBadge,
  ModelFormatBadge,
} from "@/mainview/components/model-category-badge";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

/**
 * 推荐模型行（与在线市场/本地模型的行样式统一）：
 * 点击进入详情页下载；recommended（千问小模型）带「推荐」标记排在最前。
 */
function PresetRow({
  preset,
  onOpenDetail,
}: {
  preset: (typeof MODEL_PRESETS)[number];
  onOpenDetail: (source: ModelDetailSource) => void;
}) {
  const t = useT();

  const openDetail = () => {
    const source = { kind: "preset", preset } as const;
    useModelDetailStore.getState().setSource(source);
    onOpenDetail(source);
  };

  return (
    <button
      type="button"
      onClick={openDetail}
      className="flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors hover:border-muted-foreground/40 hover:bg-accent/40"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{preset.label}</span>
          {preset.recommended && (
            <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 text-[10px] font-medium text-primary">
              <SparklesIcon className="size-3" />
              {t("models.recBadge")}
            </span>
          )}
          <ModelCategoryBadge category={preset.app} label={t(`models.cat.${preset.app}`)} />
          {preset.engine && preset.engine !== "all" && (
            <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
              {t(`settings.engine.${preset.engine}`)}
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{preset.description}</p>
        <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/70">
          {preset.repo}
        </p>
      </div>
      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        {t("models.viewDetail")}
        <ChevronRightIcon className="size-4" />
      </span>
    </button>
  );
}

/** 已安装模型（我的模型）行：点行进详情，右侧收藏 + 一键启动。 */
function MyModelRow({
  model,
  engine,
  onOpenDetail,
}: {
  model: InstalledModel;
  engine: ReturnType<typeof useEngine>["engine"];
  onOpenDetail: (source: ModelDetailSource) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const serverStatus = useServerStore((s) => s.status);
  // 目录条目（vLLM / SGLang / MLX 的整个仓库）文件名没有扩展名，格式按目录内容判定。
  const kind = model.kind ?? fileKind(model.fileName);
  const compatible = engineSupports(engine, kind);
  const [startError, setStartError] = useState<string | null>(null);

  const favoriteMutation = useMutation({
    mutationFn: () => rpcClient.toggleFavoriteModel({ path: model.path }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["installed-models"] }),
  });

  const startMutation = useMutation({
    mutationFn: async () => {
      if (!model.isActive) {
        const act = await rpcClient.setActiveModel({ path: model.path });
        if (!act.ok) throw new Error(act.error || "Failed to activate model");
      }
      const status = useServerStore.getState().status;
      const res =
        status === "running" || status === "starting" || status === "downloading"
          ? await rpcClient.restartServer()
          : await rpcClient.startServer();
      if (!res.ok) throw new Error(res.error || "Failed to start server");
      return res;
    },
    onSuccess: () => {
      setStartError(null);
      queryClient.invalidateQueries({ queryKey: ["installed-models"] });
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (err: unknown) =>
      setStartError(err instanceof Error ? err.message.replace(/^Error:\s*/i, "") : String(err)),
  });

  const serverBusy = serverStatus === "starting" || serverStatus === "downloading";
  const startErrorHint = startError ? serverErrorHint(t, startError) : null;

  const openDetail = () => {
    const preset = MODEL_PRESETS.find((p) => p.repo === model.repo);
    const source: ModelDetailSource = preset
      ? { kind: "preset", preset }
      : {
          kind: "search",
          model: {
            id: model.repo,
            name: model.fileName.replace(/\.(gguf|safetensors|bin|onnx)$/i, ""),
            description: "",
            downloads: 0,
            likes: 0,
            license: "",
            tasks: [],
            tags: [],
            fileSize: model.size,
            params: 0,
            createdAt: "",
            lastModified: "",
            // 本机已装模型默认按魔搭口径列文件。
            source: "modelscope",
            formats: [],
            fileCount: 0,
          },
        };
    useModelDetailStore.getState().setSource(source);
    onOpenDetail(source);
  };

  return (
    <div className="flex flex-col gap-1 rounded-lg border px-4 py-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={openDetail}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {model.favorite && (
                <StarIcon className="size-3.5 shrink-0 fill-amber-500 text-amber-500" />
              )}
              {model.isDir && (
                <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
              )}
              <span className="truncate text-sm font-medium">{model.fileName}</span>
              <ModelCategoryBadge
                category={model.category ?? "other"}
                label={t(`models.cat.${model.category ?? "other"}`)}
              />
              <ModelFormatBadge
                kind={kind}
                label={
                  kind === "gguf"
                    ? t("models.format.gguf")
                    : kind === "safetensors"
                      ? t("models.format.safetensors")
                      : t("models.format.other")
                }
              />
              {!compatible && (
                <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-amber-100 px-1.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
                  <AlertTriangleIcon className="size-3" />
                  {t("models.autoSwitchEngine")}
                </span>
              )}
              {model.isActive && (
                <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 text-[10px] font-medium text-primary">
                  <SparklesIcon className="size-3" />
                  {t("models.inUse")}
                </span>
              )}
            </div>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {formatBytes(model.size)} · {model.repo}
            </p>
          </div>
          <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            tooltip={model.favorite ? t("models.unfavorite") : t("models.favorite")}
            onClick={() => favoriteMutation.mutate()}
            disabled={favoriteMutation.isPending}
            className={model.favorite ? "text-amber-500" : "text-muted-foreground"}
          >
            <StarIcon className={cn("size-4", model.favorite && "fill-amber-500")} />
          </Button>
          <Button
            variant="default"
            size="sm"
            className="h-7 text-xs"
            disabled={startMutation.isPending || serverBusy}
            onClick={() => startMutation.mutate()}
          >
            {startMutation.isPending ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <PlayIcon data-icon="inline-start" />
            )}
            {serverStatus === "running" ? t("models.restart") : t("models.run")}
          </Button>
        </div>
      </div>
      {startError && (
        <div className="space-y-0.5">
          {startErrorHint && (
            <p className="flex items-start gap-1 text-[11px] text-destructive">
              <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
              <span className="min-w-0 break-words">{startErrorHint}</span>
            </p>
          )}
          <p className="flex items-start gap-1 text-[11px] text-destructive/70">
            <span className="mt-1.5 size-0.5 shrink-0 rounded-full bg-destructive/50" />
            <span className="min-w-0 break-words">{startError}</span>
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * 模型库：默认展示推荐模型（千问小模型优先）；
 * 下方「我的模型」汇总收藏与本机已安装模型，支持点进详情与一键启动。
 * 嵌在设置页内，通过 onOpenDetail 原地打开详情。
 */
export function ModelsScreen({
  onOpenDetail,
}: {
  onOpenDetail: (source: ModelDetailSource) => void;
}) {
  const t = useT();
  const [activeCategory, setActiveCategory] = useState<ModelCategory | "all">("all");
  const { engine } = useEngine();

  const installedQuery = useQuery({
    queryKey: ["installed-models"],
    queryFn: () => rpcClient.listInstalledModels(),
  });

  const presets = MODEL_PRESETS.filter(
    (p) =>
      (!p.engine || p.engine === "all" || p.engine === engine) &&
      matchCategory(
        {
          ...p,
          id: p.repo,
          tags: [
            `task:${p.app === "chat" ? "text-generation" : p.app === "tts" ? "text-to-speech" : p.app === "asr" ? "auto-speech-recognition" : "text-to-image-synthesis"}`,
            `custom_tag:${p.app}`,
          ],
          tasks: [],
        } as unknown as Parameters<typeof matchCategory>[0],
        activeCategory,
      ),
  );

  // 收藏置顶，其余保持磁盘扫描顺序。
  const myModels = [...(installedQuery.data?.models ?? [])].sort(
    (a, b) => Number(b.favorite ?? false) - Number(a.favorite ?? false),
  );

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 pb-30 pt-2">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <StoreIcon className="size-5" />
            {t("models.title")}
          </h2>
          <p className="text-xs text-muted-foreground">{t("models.subtitle")}</p>
        </div>

        {/* 推荐模型：千问小模型置顶，点行进详情下载 */}
        <div>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-medium">
            <SparklesIcon className="size-4 text-primary" />
            {t("models.recommended")}
          </h3>
          <div className="mb-3 flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setActiveCategory("all")}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs transition-colors",
                activeCategory === "all"
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
              )}
            >
              {t("models.cat.all")}
            </button>
            {MODEL_CATEGORIES.filter((c) => c.value !== "all").map((cat) => {
              const isActive = activeCategory === cat.value;
              return (
                <button
                  key={cat.value}
                  type="button"
                  onClick={() => setActiveCategory(cat.value)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs transition-colors",
                    isActive
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
                  )}
                >
                  {t(cat.labelKey)}
                </button>
              );
            })}
          </div>
          <div className="flex flex-col gap-2">
            {presets.map((preset) => (
              <PresetRow key={preset.repo} preset={preset} onOpenDetail={onOpenDetail} />
            ))}
            {presets.length === 0 && (
              <p className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
                {t("models.noPresetInCat")}
              </p>
            )}
          </div>
        </div>

        {/* 我的模型：收藏 + 本地已安装，一键启动 */}
        <div>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-medium">
            <HardDriveIcon className="size-4" />
            {t("models.mine")}
            <span className="text-xs font-normal text-muted-foreground">
              {t("models.mineHint")}
            </span>
          </h3>
          {installedQuery.isLoading ? (
            <div className="flex justify-center py-8">
              <Spinner className="size-5" />
            </div>
          ) : myModels.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-8 text-center">
              <HardDriveIcon className="size-6 text-muted-foreground/50" />
              <p className="max-w-sm text-xs leading-5 text-muted-foreground">
                {t("models.mineEmpty")}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {myModels.map((m) => (
                <MyModelRow key={m.path} model={m} engine={engine} onOpenDetail={onOpenDetail} />
              ))}
            </div>
          )}
        </div>
      </div>
    </ScrollArea>
  );
}
