import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon, PlayIcon, TerminalIcon, CheckIcon, CheckCircle2Icon, StarIcon, Trash2Icon, HardDriveIcon, FolderOpenIcon, AlertTriangleIcon, SparklesIcon, FolderIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { SourceBadge } from "@components/source-badge";
import { ModelCategoryBadge, ModelFormatBadge, MODEL_TAG_CLASS } from "@components/model-category-badge";
import { ModelCategoryChips } from "@components/model-category-chips";
import { Button } from "@ui/button";
import { Badge } from "@ui/badge";
import { Spinner } from "@ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ui/dialog";
import { useServedStore } from "@stores/served";
import { useT } from "@stores/ui-lang";
import { fileKind, engineSupports, type InferenceEngine, type ModelCategory, type ModelOrigin, type ModelSource } from "@/shared/modelscope";
import { serverErrorHint } from "@/mainview/lib/server-error";
import { StartFailureDetails } from "@components/start-failure-details";
import { cn } from "@/mainview/lib/utils";
import { formatBytes } from "./parts";

// ---------------------------------------------------------------------------
// 已安装模型管理
// ---------------------------------------------------------------------------

function InstalledModelRow({
  model,
  engine,
}: {
  model: {
    repo: string;
    fileName: string;
    path: string;
    size: number;
    isActive: boolean;
    isChatModel: boolean;
    category: ModelCategory;
    favorite: boolean;
    /** 下载来源平台（老数据可能没有）。 */
    source?: ModelSource;
    /** 模型来自哪个位置：应用下载 / 本地目录 / HF 缓存。 */
    origin: ModelOrigin;
    /** 整目录条目（HF 缓存里的模型目录）。 */
    isDir: boolean;
    /** 权重格式，目录条目按内容判定。 */
    kind: import("../../../shared/modelscope").ModelFileKind;
    /** 运行时实际加载的路径（分批 GGUF 指向第一个分片），与已启动实例对齐用。 */
    runtimeTarget: string;
  };
  engine: InferenceEngine;
}) {
  const queryClient = useQueryClient();
  const t = useT();
  const servedModels = useServedStore((s) => s.models);
  const kind = model.kind ?? fileKind(model.fileName);
  const compatible = engineSupports(engine, kind);
  const [startError, setStartError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const setActiveMutation = useMutation({
    mutationFn: () => rpcClient.setActiveModel({ path: model.path }),
    onSuccess: () => {
      setStartError(null);
      queryClient.invalidateQueries({ queryKey: ["installed-models"] });
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (err: unknown) => setStartError(String(err)),
  });
  const deleteMutation = useMutation({
    mutationFn: () => rpcClient.deleteLocalModel({ path: model.path }),
    onSuccess: (res) => {
      if (!res.ok) {
        setDeleteError(res.error ?? t("models.deleteFailed"));
        return;
      }
      setDeleteError(null);
      queryClient.invalidateQueries({ queryKey: ["installed-models"] });
    },
  });
  const favoriteMutation = useMutation({
    mutationFn: () => rpcClient.toggleFavoriteModel({ path: model.path }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["installed-models"] }),
  });
  const servedForModel = servedModels.find(
    (m) => m.modelRef === model.runtimeTarget || m.modelRef === model.path,
  );
  const startMutation = useMutation({
    mutationFn: async () => {
      // 嵌入模型不写聊天活动状态（LOCAL_MODEL_PATH / CHAT_MODEL 只跟聊天模型走），
      // 跳过 setActiveModel 前置步骤，直接按路径启动 / 重启嵌入实例。
      if (!model.isActive && model.category !== "embedding") {
        const act = await rpcClient.setActiveModel({ path: model.path });
        if (!act.ok) throw new Error(act.error || "Failed to activate model");
      }
      // 已启动过就重启那个实例，否则按路径启动新实例（可同时跑多个模型）。
      const res = servedForModel
        ? await rpcClient.restartServedModel({ id: servedForModel.id })
        : await rpcClient.startServedModel({ path: model.runtimeTarget || model.path });
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
  const serverStatus = servedForModel?.status ?? "stopped";
  const serverBusy = serverStatus === "starting" || serverStatus === "downloading";
  const startErrorHint = startError ? serverErrorHint(t, startError) : null;
  const [copied, setCopied] = useState(false);
  const copyCommand = async () => {
    try {
      const { command } = await rpcClient.getLaunchCommand({ path: model.path });
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable
    }
  };

  return (
    <div className="flex items-center gap-3 rounded-lg border p-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {model.isDir && (
            <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
          )}
          <span className="truncate text-sm font-medium">{model.fileName}</span>
          <ModelCategoryBadge
            category={model.category}
            label={t(`models.cat.${model.category}`)}
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
            <span className="inline-flex h-5 items-center gap-1 rounded-full bg-amber-100 px-1.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
              <AlertTriangleIcon className="size-3" />
              {t("models.autoSwitchEngine")}
            </span>
          )}
          <OriginBadge origin={model.origin} />
          {model.source && model.origin !== "hf-cache" && <SourceBadge source={model.source} />}
          {model.isActive && (
            <Badge variant="default" className="gap-1 text-[10px]">
              <SparklesIcon className="size-3" /> {t("models.inUse")}
            </Badge>
          )}
          {model.isChatModel && (
            <Badge variant="secondary" className="text-[10px]">
              Chat
            </Badge>
          )}
        </div>
        <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/70">
          {model.repo}
        </p>
        <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span>{formatBytes(model.size)}</span>
          {model.isDir && (
            <span className="rounded bg-muted px-1 text-[10px]">{t("models.wholeRepo")}</span>
          )}
        </p>
        {deleteError && (
          <p className="mt-1 flex items-start gap-1 text-[11px] text-destructive">
            <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
            <span className="min-w-0 break-words">{deleteError}</span>
          </p>
        )}
        {startError && (
          <div className="mt-1 space-y-0.5">
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
            {/* 引擎版本 / 模型字节数 / 日志首条 error —— 远程定位加载失败的最小信息集。 */}
            <StartFailureDetails
              engine={engine}
              model={model}
              servedId={servedForModel?.id}
            />
          </div>
        )}
      </div>
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
          variant="ghost"
          size="icon-sm"
          tooltip={t("models.copyCommand")}
          onClick={() => void copyCommand()}
          className="text-muted-foreground"
        >
          {copied ? <CheckIcon className="size-4 text-primary" /> : <TerminalIcon className="size-4" />}
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
        {/* 嵌入模型不能设为当前聊天模型（后端会拒），按钮藏掉别给死入口。 */}
        {model.category !== "embedding" && (
          <Button
            variant={model.isActive ? "default" : "outline"}
            size="sm"
            className="h-7 text-xs"
            disabled={model.isActive || setActiveMutation.isPending}
            onClick={() => setActiveMutation.mutate()}
          >
            {setActiveMutation.isPending ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <CheckCircle2Icon data-icon="inline-start" />
            )}
            {model.isActive ? t("models.inUse") : t("models.activate")}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          tooltip={t("models.showInFolder")}
          onClick={() => void rpcClient.showInExplorer({ filePath: model.path })}
          className="text-muted-foreground"
        >
          <FolderOpenIcon className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("common.delete")}
          tooltip={model.origin === "hf-cache" ? t("models.deleteCacheEntry") : t("common.delete")}
          onClick={() => setConfirmingDelete(true)}
          disabled={deleteMutation.isPending}
        >
          <Trash2Icon className="size-4" />
        </Button>
      </div>

      {/* 删除不可逆，而且**可能删的是用户自己的文件**：从「本地模型目录」扫进来的模型不在
          应用下载目录里，删掉没法从应用里恢复。以前点一下图标就直接删了 —— issue #18 里
          报告者正是把 LM Studio 的目录加进来之后发现权重文件不见了，事后连日志都查不到。
          所以这里必须先把「删哪个文件、它在哪、是不是应用自己下载的」摆出来再确认。 */}
      <Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DialogContent className="text-xs">
          <DialogHeader>
            <DialogTitle className="text-sm">{t("models.deleteConfirm.title")}</DialogTitle>
            <DialogDescription className="break-all font-mono text-[11px]">{model.path}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <p className="break-all">
              {model.fileName} · {formatBytes(model.size)}
            </p>
            <p className={cn("text-[11px]", model.origin === "managed" ? "text-muted-foreground" : "text-destructive")}>
              {model.origin === "managed" ? t("models.deleteConfirm.managed") : t("models.deleteConfirm.external")}
            </p>
            {deleteError && <p className="text-[11px] text-destructive">{deleteError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setConfirmingDelete(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="h-8 text-xs"
              disabled={deleteMutation.isPending}
              onClick={() => {
                setConfirmingDelete(false);
                deleteMutation.mutate();
              }}
            >
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 已安装模型分类筛选：全部分类各一颗（与模型库的分类口径一致），切换展示。 */
type InstalledTab = "all" | ModelCategory;

const INSTALLED_TABS: readonly InstalledTab[] = [
  "all",
  "chat",
  "embedding",
  "rerank",
  "tts",
  "asr",
  "image",
  "video",
];

/** 已安装模型列表的空态：一个模型都没有 / 收藏里还空着 / 该分类下没有 —— 三处共用一个样子。 */
export function ModelsEmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center">
      <HardDriveIcon className="size-6 text-muted-foreground/50" />
      <p className="text-xs font-medium">{title}</p>
      {hint && <p className="max-w-md text-[11px] leading-5 text-muted-foreground">{hint}</p>}
      {action}
    </div>
  );
}

export function InstalledModels({
  engine,
  favoritesOnly = false,
  allEngines = false,
  emptyTitle,
  emptyHint,
  emptyAction,
}: {
  engine: InferenceEngine;
  /** 只列收藏的模型（模型库 → 我的收藏）。 */
  favoritesOnly?: boolean;
  /**
   * 不按当前引擎过滤（模型库 → 运行模型）。
   *
   * 严格过滤看着整洁，代价是切一次引擎就有模型从列表里消失（GGUF 在 vLLM 下、
   * MLX 权重在 llama.cpp 下），而它们其实照样能跑 —— 启动时会自动把引擎切过去
   *（`models.autoSwitchEngine`），这样的行带一个提示徽标。
   */
  allEngines?: boolean;
  /** 空态文案：默认是"还没有下载任何本地模型"，收藏页与「运行模型」各自给话术。 */
  emptyTitle?: string;
  emptyHint?: string;
  emptyAction?: ReactNode;
}) {
  const t = useT();
  const [tab, setTab] = useState<InstalledTab>("all");
  const [origin, setOrigin] = useState<ModelOrigin | "all">("all");
  const { data, isLoading } = useQuery({
    queryKey: ["installed-models"],
    queryFn: () => rpcClient.listInstalledModels(),
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Spinner className="size-5" />
      </div>
    );
  }

  // 收藏页只留收藏（跨引擎、跨来源的一份清单）；运行模型页默认全列（见 allEngines）；
  // 其余情况按引擎过滤：只显示该引擎能加载的推理模型，`other`（TTS/ASR/生图等非推理模型）
  // 不经过推理引擎加载，始终展示，由分类 tab 分组。
  const allModels = (data?.models ?? []).filter((m) => {
    if (favoritesOnly) return m.favorite;
    if (allEngines) return true;
    return m.kind === "other" || engineSupports(engine, m.kind);
  });
  const byOrigin =
    origin === "all" ? allModels : allModels.filter((m) => m.origin === origin);
  const models =
    tab === "all" ? byOrigin : byOrigin.filter((m) => (m.category ?? "other") === tab);
  const countFor = (value: InstalledTab) =>
    value === "all" ? byOrigin.length : byOrigin.filter((m) => (m.category ?? "other") === value).length;
  const originCount = (value: ModelOrigin) => allModels.filter((m) => m.origin === value).length;

  return (
    <div className="flex flex-col gap-3">
      {/* 来源筛选：应用下载 / 本地目录 / HF 缓存 —— 一眼看出模型是从哪儿来的。
          尺寸与下面那条分类筛选对齐（同款药丸、同高），两行叠在一起才像一套。
          收藏页不摆这一行：收藏本来就跨来源，按来源再切一次只是噪音。 */}
      {!favoritesOnly && (
        <div className="flex flex-wrap items-center gap-1">
          {(["all", "managed", "external", "hf-cache"] as const).map((o) => {
            const active = origin === o;
            const count = o === "all" ? allModels.length : originCount(o);
            return (
              <button
                key={o}
                type="button"
                onClick={() => setOrigin(o)}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                  active
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
                )}
              >
                {o === "all" ? t("models.cat.all") : t(ORIGIN_LABEL_KEYS[o])}
                <span className="tabular-nums opacity-60">{count}</span>
              </button>
            );
          })}
        </div>
      )}
      {/* 分类筛选：图标 + 两字短名 + 计数 —— 一行放得下，排不下就换行，不拉滚动条 */}
      <ModelCategoryChips
        values={INSTALLED_TABS}
        value={tab}
        countOf={countFor}
        onChange={setTab}
      />
      {models.length === 0 ? (
        <ModelsEmptyState
          title={emptyTitle ?? (allModels.length === 0 ? t("models.noInstalled") : t("models.noInstalledInCat"))}
          hint={emptyHint}
          action={emptyAction}
        />
      ) : (
        <div className="flex flex-col gap-2">
          {models.map((m) => (
            <InstalledModelRow key={m.path} model={m} engine={engine} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 本地模型目录管理：默认扫描应用下载目录 + HF 缓存，用户可再添加自己的目录
// ---------------------------------------------------------------------------

const ORIGIN_LABEL_KEYS: Record<ModelOrigin, string> = {
  managed: "models.origin.managed",
  external: "models.origin.external",
  "hf-cache": "models.origin.hfCache",
};

/** 目录来源标签：应用下载目录 / HF 缓存 / 用户自己加的目录。 */
function OriginBadge({ origin, className }: { origin: ModelOrigin; className?: string }) {
  const t = useT();
  return (
    <span className={cn(MODEL_TAG_CLASS, className)}>
      <FolderIcon className="size-3" />
      {t(ORIGIN_LABEL_KEYS[origin])}
    </span>
  );
}

/**
 * 目录管理：
 * - 应用下载目录与 HF 缓存默认就在扫描范围里（HF / ModelScope 下载的模型都能看到）；
 * - "添加目录"走系统选择器 → 先扫描预览（认不出模型就不加），避免把整个磁盘加进来。
 */
