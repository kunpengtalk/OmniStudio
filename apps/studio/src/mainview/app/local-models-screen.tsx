import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CpuIcon,
  Loader2Icon,
  PlayIcon,
  TerminalIcon,
  CopyIcon,
  CheckIcon,
  CheckCircle2Icon,
  StarIcon,
  Trash2Icon,
  HardDriveIcon,
  FolderOpenIcon,
  AlertTriangleIcon,
  SparklesIcon,
  SlidersHorizontalIcon,
  ChevronDownIcon,
  StoreIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { useEngine } from "@lib/use-engine";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { Badge } from "@ui/badge";
import { ScrollArea } from "@ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@ui/tabs";
import { Spinner } from "@ui/spinner";
import { useRouter } from "@stores/router";
import { useModelDetailStore, type ModelDetailSource } from "@stores/model-detail";
import { useServerStore } from "@stores/server";
import { useT } from "@stores/ui-lang";
import {
  MODEL_PRESETS,
  ENGINE_OPTIONS,
  fileKind,
  engineSupports,
  type ChatPreset,
  type InstalledModel,
  type InferenceEngine,
  type ModelCategory,
} from "@/shared/modelscope";
import { MODEL_PROFILES } from "@/shared/model-profiles";
import { MODEL_QUANTS } from "./setup-screen/constants";
import { serverErrorHint } from "@/mainview/lib/server-error";
import { cn } from "@/mainview/lib/utils";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

/**
 * 在 ModelScope 精选模型里自动挑选一个与当前引擎匹配的默认模型。
 * 仅用于「还没有已安装模型」时的提示/跳转，不直接启动。
 */
function useFirstSuggestedPreset(engine: InferenceEngine): ChatPreset | null {
  const { data } = useQuery({
    queryKey: ["installed-models"],
    queryFn: () => rpcClient.listInstalledModels(),
  });
  const installed = data?.models ?? [];
  if (installed.length > 0) return null;
  return (
    MODEL_PRESETS.find((p) => !p.engine || p.engine === "all" || p.engine === engine) ?? null
  );
}

// ---------------------------------------------------------------------------
// 引擎选择
// ---------------------------------------------------------------------------

function EngineSelector() {
  const t = useT();
  const { engine, setEngine, isSaving } = useEngine();
  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  // MLX 只面向 macOS，非 mac 不展示该引擎选项。
  const isMac = data?.platform === "darwin";
  const options = ENGINE_OPTIONS.filter((o) => o.value !== "mlx" || isMac);

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <CpuIcon className="size-3.5" />
        {t("settings.engine")}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Select value={engine} onValueChange={(v) => setEngine(v as InferenceEngine)} disabled={isSaving}>
          <SelectTrigger className="h-8 w-72 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value}>{t(o.labelKey)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">{t("models.engineHint")}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 启动参数
// ---------------------------------------------------------------------------

type ParamNumberField = { key: string; labelKey: string; step?: string };
type ParamSelectField = { key: string; labelKey: string; options: { value: string; label: string }[] };
type ParamField = (ParamNumberField & { options?: undefined }) | (ParamSelectField & { step?: undefined });

const PARAM_FIELDS: Record<InferenceEngine, ParamField[]> = {
  "llama.cpp": [
    { key: "SERVER_CTX_SIZE", labelKey: "models.params.ctx" },
    { key: "SERVER_PARALLEL", labelKey: "models.params.parallel" },
    { key: "SERVER_BATCH_SIZE", labelKey: "models.params.batch" },
    { key: "SERVER_TEMP", labelKey: "models.params.temp", step: "0.1" },
    { key: "SERVER_TOP_P", labelKey: "models.params.topP", step: "0.05" },
    { key: "SERVER_GPU_LAYERS", labelKey: "models.params.gpuLayers" },
    {
      key: "SERVER_CACHE_TYPE_K",
      labelKey: "models.params.cacheType",
      options: [
        { value: "q8_0", label: "q8_0" },
        { value: "f16", label: "f16" },
        { value: "q4_0", label: "q4_0" },
      ],
    },
  ],
  vllm: [
    { key: "VLLM_MAX_MODEL_LEN", labelKey: "models.params.maxModelLen" },
    { key: "VLLM_TENSOR_PARALLEL_SIZE", labelKey: "models.params.tp" },
    { key: "VLLM_GPU_MEMORY_UTILIZATION", labelKey: "models.params.gpuMem", step: "0.05" },
    {
      key: "VLLM_DTYPE",
      labelKey: "models.params.dtype",
      options: [
        { value: "auto", label: "auto" },
        { value: "bfloat16", label: "bfloat16" },
        { value: "half", label: "half" },
        { value: "fp32", label: "fp32" },
      ],
    },
  ],
  sglang: [
    { key: "SGLANG_CONTEXT_LENGTH", labelKey: "models.params.ctx" },
    { key: "SGLANG_TP_SIZE", labelKey: "models.params.tp" },
    { key: "SGLANG_MEM_FRACTION_STATIC", labelKey: "models.params.memFraction", step: "0.02" },
  ],
  mlx: [{ key: "MLX_CACHE_SIZE_GB", labelKey: "models.params.mlxCacheGb", step: "1" }],
};

/** 数字参数输入：编辑中不写库，失焦 / Enter 时提交（下次启动生效）。 */
function ParamInput({
  label,
  value,
  step,
  onCommit,
}: {
  label: string;
  value: string;
  step?: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <Input
        type="number"
        step={step}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft.trim() !== "" && draft !== value) onCommit(draft.trim());
          else setDraft(value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="h-8 text-xs"
      />
    </label>
  );
}

/** 当前引擎的启动参数（上下文长度等），改完即写入设置，下一次启动/重启推理服务器时生效。 */
function ServerParamsPanel({ engine }: { engine: InferenceEngine }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(true);
  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  const settings = data?.settings ?? {};
  const fields = PARAM_FIELDS[engine];

  const saveMutation = useMutation({
    mutationFn: (patch: Record<string, string>) => rpcClient.updateSettings({ settings: patch }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });

  const commit = (patch: Record<string, string>) => saveMutation.mutate(patch);

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-xs font-medium text-muted-foreground"
      >
        <SlidersHorizontalIcon className="size-3.5" />
        {t("models.params")}
        <span className="text-[10px] font-normal text-muted-foreground/60">{t("models.paramsHint")}</span>
        <ChevronDownIcon className={cn("ml-auto size-3.5 transition-transform", !open && "-rotate-90")} />
      </button>
      {open && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {fields.map((f) =>
            f.options ? (
              <label key={f.key} className="flex flex-col gap-1">
                <span className="text-[11px] text-muted-foreground">{t(f.labelKey)}</span>
                <Select
                  value={settings[f.key] ?? f.options[0]?.value}
                  onValueChange={(v) =>
                    commit(
                      f.key === "SERVER_CACHE_TYPE_K" ? { SERVER_CACHE_TYPE_K: v, SERVER_CACHE_TYPE_V: v } : { [f.key]: v },
                    )
                  }
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {f.options.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            ) : (
              <ParamInput
                key={f.key}
                label={t(f.labelKey)}
                value={settings[f.key] ?? ""}
                step={f.step}
                onCommit={(v) => commit({ [f.key]: v })}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 启动条
// ---------------------------------------------------------------------------

/** 启动条：选择已下载的模型 + 启动/重启服务器（使用上方所选引擎与启动参数）。
 * 只列出当前引擎能加载的模型，避免在 MLX 下选到 GGUF 等不兼容文件。 */
function LaunchBar({ installedModels, engine }: { installedModels: InstalledModel[]; engine: InferenceEngine }) {
  const compatibleModels = installedModels.filter((m) =>
    engineSupports(engine, fileKind(m.fileName)),
  );
  const t = useT();
  const queryClient = useQueryClient();
  const serverStatus = useServerStore((s) => s.status);
  const [startError, setStartError] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  const activePath = data?.settings.LOCAL_MODEL_PATH ?? "";

  const selectMutation = useMutation({
    mutationFn: (path: string) => rpcClient.setActiveModel({ path }),
    onSuccess: () => {
      setStartError(null);
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["installed-models"] });
    },
  });
  const startMutation = useMutation({
    mutationFn: async () => {
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
    },
    onError: (err: unknown) =>
      setStartError(err instanceof Error ? err.message.replace(/^Error:\s*/i, "") : String(err)),
  });

  const busy = serverStatus === "starting" || serverStatus === "downloading";
  const startErrorHint = startError ? serverErrorHint(t, startError) : null;

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-64 flex-1 flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">{t("models.chooseModel")}</span>
          <Select
            value={activePath}
            onValueChange={(v) => selectMutation.mutate(v)}
            disabled={selectMutation.isPending || busy}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder={t("models.chooseModelEmpty")} />
            </SelectTrigger>
            <SelectContent className="max-w-sm">
              {compatibleModels.map((m) => {
                const kind = fileKind(m.fileName);
                return (
                  <SelectItem key={m.path} value={m.path}>
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{m.fileName}</span>
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/70">
                        {kind === "gguf" ? "GGUF" : kind === "safetensors" ? "safetensors" : "·"}
                        {m.isActive ? ` · ${t("models.inUse")}` : ""}
                      </span>
                    </span>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>
        <span
          className={cn(
            "pb-2 text-[11px]",
            serverStatus === "running" && "text-emerald-600 dark:text-emerald-400",
            (serverStatus === "starting" || serverStatus === "downloading") && "text-amber-600 dark:text-amber-400",
            serverStatus === "error" && "text-destructive",
            serverStatus === "stopped" && "text-muted-foreground",
          )}
        >
          {t(`server.status.${serverStatus}`)}
        </span>
        <Button
          variant="default"
          size="sm"
          className="h-8 text-xs"
          disabled={!activePath || busy || startMutation.isPending}
          tooltip={!activePath ? t("models.needModel") : undefined}
          onClick={() => startMutation.mutate()}
        >
          {startMutation.isPending ? (
            <Loader2Icon data-icon="inline-start" className="animate-spin" />
          ) : (
            <PlayIcon data-icon="inline-start" />
          )}
          {serverStatus === "running" ? t("models.restartServer") : t("models.launch")}
        </Button>
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

// ---------------------------------------------------------------------------
// 已安装模型管理
// ---------------------------------------------------------------------------

const CAT_BADGE_CLASSES: Record<string, string> = {
  chat: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400",
  tts: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400",
  asr: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400",
  image: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400",
  other: "bg-muted text-muted-foreground",
};

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
  };
  engine: InferenceEngine;
}) {
  const queryClient = useQueryClient();
  const t = useT();
  const serverStatus = useServerStore((s) => s.status);
  const kind = fileKind(model.fileName);
  const compatible = engineSupports(engine, kind);
  const [startError, setStartError] = useState<string | null>(null);

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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["installed-models"] }),
  });
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
          <span className="truncate text-sm font-medium">{model.fileName}</span>
          <span
            className={cn(
              "inline-flex h-5 items-center rounded-full px-1.5 text-[10px] font-medium",
              CAT_BADGE_CLASSES[model.category],
            )}
          >
            {t(`models.cat.${model.category}`)}
          </span>
          <span
            className={cn(
              "inline-flex h-5 shrink-0 items-center rounded-full px-1.5 text-[10px] font-medium",
              kind === "gguf"
                ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400"
                : kind === "safetensors"
                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
                  : "bg-muted text-muted-foreground",
            )}
          >
            {kind === "gguf"
              ? t("models.format.gguf")
              : kind === "safetensors"
                ? t("models.format.safetensors")
                : t("models.format.other")}
          </span>
          {!compatible && (
            <span className="inline-flex h-5 items-center gap-1 rounded-full bg-amber-100 px-1.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
              <AlertTriangleIcon className="size-3" />
              {t("models.autoSwitchEngine")}
            </span>
          )}
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
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {formatBytes(model.size)}
        </p>
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
        <Button
          variant="ghost"
          size="icon-sm"
          tooltip={t("common.delete")}
          onClick={() => deleteMutation.mutate()}
          disabled={deleteMutation.isPending}
        >
          <Trash2Icon className="size-4" />
        </Button>
      </div>
    </div>
  );
}

/** 已安装模型 tab 页：全部 / 对话·VLM / TTS / ASR / 生图，切换展示，不再上下堆叠。 */
type InstalledTab = "all" | ModelCategory;

const INSTALLED_TABS: { value: InstalledTab; labelKey: string }[] = [
  { value: "all", labelKey: "models.cat.all" },
  { value: "chat", labelKey: "models.cat.chat" },
  { value: "tts", labelKey: "models.cat.tts" },
  { value: "asr", labelKey: "models.cat.asr" },
  { value: "image", labelKey: "models.cat.image" },
];

function InstalledModels({ engine }: { engine: InferenceEngine }) {
  const t = useT();
  const [tab, setTab] = useState<InstalledTab>("all");
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

  // 严格按当前引擎过滤：只显示该引擎能加载的推理模型；`other`（TTS/ASR/生图
  // 等非推理模型）不属于推理引擎加载，始终展示，由分类 tab 分组。
  const allModels = (data?.models ?? []).filter(
    (m) => fileKind(m.fileName) === "other" || engineSupports(engine, fileKind(m.fileName)),
  );
  const models =
    tab === "all" ? allModels : allModels.filter((m) => (m.category ?? "other") === tab);
  const countFor = (value: InstalledTab) =>
    value === "all" ? allModels.length : allModels.filter((m) => (m.category ?? "other") === value).length;

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as InstalledTab)} className="gap-3">
      <TabsList className="w-fit max-w-full overflow-x-auto">
        {INSTALLED_TABS.map((tb) => (
          <TabsTrigger key={tb.value} value={tb.value} className="gap-1.5 text-xs">
            {t(tb.labelKey)}
            <span className="rounded-full bg-background/60 px-1.5 text-[10px] tabular-nums text-muted-foreground">
              {countFor(tb.value)}
            </span>
          </TabsTrigger>
        ))}
      </TabsList>
      {models.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-8 text-center">
          <HardDriveIcon className="size-6 text-muted-foreground/50" />
          <p className="text-xs text-muted-foreground">
            {allModels.length === 0 ? t("models.noInstalled") : t("models.noInstalledInCat")}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {models.map((m) => (
            <InstalledModelRow key={m.path} model={m} engine={engine} />
          ))}
        </div>
      )}
    </Tabs>
  );
}

// ---------------------------------------------------------------------------
// 默认模型与目录（从设置页迁入）
// ---------------------------------------------------------------------------

function DefaultModelConfig() {
  const t = useT();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  const { data: modelDirs } = useQuery({
    queryKey: ["model-dirs"],
    queryFn: () => rpcClient.getModelDirs(),
  });
  const settings = data?.settings ?? {};
  const [form, setForm] = useState<Record<string, string>>({});

  useEffect(() => {
    if (data?.settings) setForm((prev) => ({ ...prev, ...data.settings }));
  }, [data]);

  const updateField = (key: string, value: string) => setForm((prev) => ({ ...prev, [key]: value }));

  const saveMutation = useMutation({
    mutationFn: () => {
      const keys = ["VLLM_MODEL_PROFILE", "CUSTOM_HF_MODEL", "MODEL_DIRS"] as const;
      const patch: Record<string, string> = {};
      for (const k of keys) if (form[k] !== undefined) patch[k] = form[k];
      return rpcClient.updateSettings({ settings: patch });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["model-dirs"] });
    },
  });

  const currentProfileId = form.VLLM_MODEL_PROFILE ?? "chandra";
  const isCustomLocal = !MODEL_PROFILES.some((p) => p.id === currentProfileId);
  const quantInfo = MODEL_QUANTS[currentProfileId];
  const currentQuant = (() => {
    const custom = form.CUSTOM_HF_MODEL;
    if (custom && quantInfo) {
      const suffix = custom.split(":")[1];
      if (suffix && quantInfo.quants.some((q) => q.name === suffix)) return suffix;
    }
    return quantInfo?.defaultQuant ?? "";
  })();

  const dirs = modelDirs?.dirs ?? [];
  const ALL_PROFILES = [
    ...MODEL_PROFILES.map((p) => ({ id: p.id, label: p.label })),
    { id: "none" as const, label: "None (raw output)" },
  ];

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-xs font-medium text-muted-foreground"
      >
        <FolderOpenIcon className="size-3.5" />
        {t("settings.defaultModel")}
        <ChevronDownIcon className={cn("ml-auto size-3.5 transition-transform", !open && "-rotate-90")} />
      </button>
      {open && (
        <div className="flex flex-col gap-4 pt-1">
          <div>
            <Label htmlFor="localModel" className="mb-1 text-xs">{t("settings.modelPicker")}</Label>
            <div className="flex gap-2">
              <Select
                value={isCustomLocal ? "custom" : currentProfileId}
                onValueChange={(v) => {
                  if (v === "custom") {
                    updateField("VLLM_MODEL_PROFILE", "none");
                    updateField("CUSTOM_HF_MODEL", "");
                  } else {
                    updateField("VLLM_MODEL_PROFILE", v);
                    const info = MODEL_QUANTS[v];
                    updateField("CUSTOM_HF_MODEL", info ? `${info.repo}:${info.defaultQuant}` : "");
                  }
                }}
              >
                <SelectTrigger id="localModel" className="h-8 flex-1 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODEL_PROFILES.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                  ))}
                  {ALL_PROFILES.filter((p) => p.id === "none").map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                  ))}
                  <SelectItem value="custom">Custom HuggingFace model</SelectItem>
                </SelectContent>
              </Select>
              {!isCustomLocal && quantInfo && quantInfo.quants.length > 1 && (
                <Select
                  value={currentQuant}
                  onValueChange={(v) => updateField("CUSTOM_HF_MODEL", `${quantInfo.repo}:${v}`)}
                >
                  <SelectTrigger className="h-8 w-[130px] shrink-0 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {quantInfo.quants.map((q) => (
                      <SelectItem key={q.name} value={q.name}>
                        <p>{q.name}</p>
                        <span className="text-muted-foreground tabular-nums">{formatBytes(q.size)}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            {!isCustomLocal && quantInfo && (
              <p className="mt-1 font-mono text-[11px] text-muted-foreground/60">{quantInfo.repo}</p>
            )}
          </div>

          {isCustomLocal && (
            <div>
              <Label htmlFor="customHf" className="mb-1 text-xs">{t("settings.customHf")}</Label>
              <Input
                id="customHf"
                placeholder="e.g. user/Model-GGUF:Q4_K_M"
                value={form.CUSTOM_HF_MODEL ?? ""}
                onChange={(e) => updateField("CUSTOM_HF_MODEL", e.target.value)}
                className="h-8 text-xs"
              />
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="modelDirPrimary" className="mb-1 text-xs">{t("settings.modelDirs.primary")}</Label>
              <Input id="modelDirPrimary" value={dirs[0] ?? ""} readOnly className="h-8 font-mono text-xs" />
            </div>
            <div>
              <Label htmlFor="modelDirExtra" className="mb-1 text-xs">{t("settings.modelDirs.extra")}</Label>
              <Input
                id="modelDirExtra"
                placeholder="/path/one,/path/two"
                value={form.MODEL_DIRS ?? ""}
                onChange={(e) => updateField("MODEL_DIRS", e.target.value)}
                className="h-8 font-mono text-xs"
              />
            </div>
          </div>

          <div className="flex items-center gap-3 border-t pt-3">
            <Button size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
              {saveMutation.isPending ? (
                <Loader2Icon data-icon="inline-start" className="animate-spin" />
              ) : saveMutation.isSuccess ? (
                <CheckIcon data-icon="inline-start" />
              ) : null}
              {saveMutation.isSuccess ? t("common.saved") : t("common.save")}
            </Button>
            <p className="text-[11px] text-muted-foreground">{t("settings.restartHint")}</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

/** 本地模型：推理引擎 / 启动参数 / 启动按钮 / 已安装模型管理。 */
export function LocalModelsScreen({
  onOpenDetail,
}: {
  onOpenDetail?: (source: ModelDetailSource) => void;
} = {}) {
  const t = useT();
  const setRoute = useRouter((s) => s.setRoute);
  const { engine } = useEngine();
  const { data: installedData } = useQuery({
    queryKey: ["installed-models"],
    queryFn: () => rpcClient.listInstalledModels(),
  });
  const installedModels = installedData?.models ?? [];
  const suggested = useFirstSuggestedPreset(engine);

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 pb-30 pt-2">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <CpuIcon className="size-5" />
            {t("local.title")}
          </h2>
          <p className="text-xs text-muted-foreground">{t("local.subtitle")}</p>
        </div>

        {suggested && installedModels.length === 0 && (
          <div className="flex flex-col gap-2 rounded-lg border border-dashed p-4">
            <p className="text-xs text-muted-foreground">
              {t("local.noModel")}：{suggested.label}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() => {
                const source = { kind: "preset", preset: suggested } as const;
                useModelDetailStore.getState().setSource(source);
                if (onOpenDetail) onOpenDetail(source);
                else setRoute({ path: "model-detail" });
              }}
            >
              <StoreIcon data-icon="inline-start" className="size-3.5" />
              {t("local.goMarket")}
            </Button>
          </div>
        )}

        <EngineSelector />
        <ServerParamsPanel engine={engine} />
        <LaunchBar installedModels={installedModels} engine={engine} />

        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              <HardDriveIcon className="size-4" />
              {t("models.installed")}
            </h3>
          </div>
          <InstalledModels engine={engine} />
        </div>

        <DefaultModelConfig />
      </div>
    </ScrollArea>
  );
}
