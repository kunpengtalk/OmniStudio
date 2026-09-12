import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  CpuIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  HardDriveIcon,
  Loader2Icon,
  PlayIcon,
  RocketIcon,
  SparklesIcon,
  SquareIcon,
  StarIcon,
  TerminalIcon,
  Trash2Icon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { SourceBadge } from "@components/source-badge";
import { useEngine } from "@lib/use-engine";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { Badge } from "@ui/badge";
import { Spinner } from "@ui/spinner";
import { useServerStore } from "@stores/server";
import { useModelDetailStore } from "@stores/model-detail";
import { useRouter } from "@stores/router";
import { useT } from "@stores/ui-lang";
import {
  ENGINE_OPTIONS,
  ENGINE_PORT_KEYS,
  ENGINE_EXTRA_ARGS_KEYS,
  MODEL_PRESETS,
  fileKind,
  engineSupports,
  matchQuant,
  safeRepoId,
  type ChatPreset,
  type InferenceEngine,
  type MarketFile,
  type ModelCategory,
  type ModelSource,
} from "@/shared/modelscope";
import { MODEL_PROFILES } from "@/shared/model-profiles";
import { MODEL_QUANTS } from "../setup-screen/constants";
import { serverErrorHint } from "@/mainview/lib/server-error";
import {
  CommitInput,
  CommitTextarea,
  DownloadControls,
  ModelFileImportZone,
  PanelCard,
  StatusRow,
  formatBytes,
  serverTone,
  useSettingsBlob,
  useSettingsPatch,
} from "./shared";
import { cn } from "@/mainview/lib/utils";

const ENGINE_TAB_LABEL: Record<InferenceEngine, string> = {
  "llama.cpp": "llama.cpp",
  vllm: "vLLM",
  sglang: "SGLang",
  mlx: "MLX",
};

// ---------------------------------------------------------------------------
// 结构化启动参数（沿用原 ServerParamsPanel 定义）
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
  mlx: [
    { key: "MLX_CACHE_SIZE_GB", labelKey: "models.params.mlxCacheGb", step: "1" },
  ],
};

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

// ---------------------------------------------------------------------------
// 引擎配置卡（显示名称 / 端口 / 启动命令参数 / 启动停止 / 运行状态）
// ---------------------------------------------------------------------------

function EngineConfigCard({ engine }: { engine: InferenceEngine }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { engine: activeEngine } = useEngine();
  const serverStatus = useServerStore((s) => s.status);
  const { data } = useSettingsBlob();
  const patch = useSettingsPatch();
  const [startError, setStartError] = useState<string | null>(null);

  const settings = data?.settings ?? {};
  const host = settings.SERVER_HOST ?? "127.0.0.1";
  const port = settings[ENGINE_PORT_KEYS[engine]] ?? "8080";
  const isCurrent = engine === activeEngine;
  const status = isCurrent ? serverStatus : "stopped";
  const busy = status === "starting" || status === "downloading";
  const endpoint = `http://${host}:${port}/v1`;

  const startMutation = useMutation({
    mutationFn: async () => {
      if (!isCurrent) {
        await rpcClient.updateSettings({ settings: { INFERENCE_ENGINE: engine } });
        await queryClient.invalidateQueries({ queryKey: ["settings"] });
      }
      const st = useServerStore.getState().status;
      const res =
        st === "running" || st === "starting" || st === "downloading"
          ? await rpcClient.restartServer()
          : await rpcClient.startServer();
      if (!res.ok) throw new Error(res.error || "Failed to start server");
      return res;
    },
    onSuccess: () => {
      setStartError(null);
      queryClient.invalidateQueries({ queryKey: ["installed-models"] });
    },
    onError: (err: unknown) => setStartError(err instanceof Error ? err.message.replace(/^Error:\s*/i, "") : String(err)),
  });
  const stopMutation = useMutation({
    mutationFn: () => rpcClient.stopServer(),
  });

  const startErrorHint = startError ? serverErrorHint(t, startError) : null;

  return (
    <PanelCard>
      <div className="grid gap-3 sm:grid-cols-2">
        <CommitInput
          label={t("engine.displayName")}
          value={settings.LOCAL_MODEL_NAME ?? ""}
          placeholder="e.g. qwen3-4b"
          mono
          onCommit={(v) => patch.mutate({ LOCAL_MODEL_NAME: v })}
        />
        <CommitInput
          label={t("engine.port")}
          type="number"
          value={port}
          onCommit={(v) => patch.mutate({ [ENGINE_PORT_KEYS[engine]]: v })}
        />
      </div>
      <CommitTextarea
        label={t("engine.extraArgs")}
        hint={t("engine.extraArgsHint")}
        value={settings[ENGINE_EXTRA_ARGS_KEYS[engine]] ?? ""}
        placeholder="--flash-attn on --no-warmup"
        onCommit={(v) => patch.mutate({ [ENGINE_EXTRA_ARGS_KEYS[engine]]: v })}
      />
      <div className="flex flex-wrap items-center gap-3 border-t pt-3">
        <Button
          size="sm"
          className="h-8 bg-emerald-600 text-xs text-white hover:bg-emerald-600/90"
          disabled={busy || startMutation.isPending}
          onClick={() => startMutation.mutate()}
        >
          {startMutation.isPending ? (
            <Loader2Icon data-icon="inline-start" className="animate-spin" />
          ) : (
            <PlayIcon data-icon="inline-start" />
          )}
          {status === "running" ? t("models.restartServer") : t("engine.start")}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          className="h-8 text-xs"
          disabled={!isCurrent || status === "stopped" || busy || stopMutation.isPending}
          onClick={() => stopMutation.mutate()}
        >
          {stopMutation.isPending ? (
            <Loader2Icon data-icon="inline-start" className="animate-spin" />
          ) : (
            <SquareIcon data-icon="inline-start" />
          )}
          {t("engine.stop")}
        </Button>
        <div className="ml-auto">
          <StatusRow
            label={t("engine.status")}
            tone={serverTone(status)}
            text={t(`engine.status.${status}`)}
            extra={
              status === "running" ? (
                <a
                  href={endpoint}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-[11px] text-primary underline-offset-2 hover:underline"
                >
                  {endpoint}
                  <ExternalLinkIcon className="size-3" />
                </a>
              ) : undefined
            }
          />
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
          <p className="text-[11px] text-destructive/70">{startError}</p>
        </div>
      )}
    </PanelCard>
  );
}

// ---------------------------------------------------------------------------
// 模型配置卡（模型名称/路径 / API 兼容端点 / 结构化参数 / 模型文件导入）
// ---------------------------------------------------------------------------

function ModelConfigCard({ engine }: { engine: InferenceEngine }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { data } = useSettingsBlob();
  const patch = useSettingsPatch();
  const serverStatus = useServerStore((s) => s.status);
  const { data: installedData } = useQuery({
    queryKey: ["installed-models"],
    queryFn: () => rpcClient.listInstalledModels(),
  });
  const installedModels = installedData?.models ?? [];
  const settings = data?.settings ?? {};
  const host = settings.SERVER_HOST ?? "127.0.0.1";
  const port = settings[ENGINE_PORT_KEYS[engine]] ?? "8080";
  const endpoint = `http://${host}:${port}/v1`;
  const activePath = settings.LOCAL_MODEL_PATH ?? "";
  const busy = serverStatus === "starting" || serverStatus === "downloading";

  const setActiveMutation = useMutation({
    mutationFn: (path: string) => rpcClient.setActiveModel({ path }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["installed-models"] });
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  const fields = PARAM_FIELDS[engine];
  const mlxPresets = MODEL_PRESETS.filter((p) => p.engine === "mlx" && p.app === "chat");

  return (
    <PanelCard title={t("engine.modelSection")} icon={<HardDriveIcon className="size-4" />}>
      <div className="grid gap-3 sm:grid-cols-2">
        {engine === "mlx" ? (
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">{t("engine.mlxModel")}</span>
            <Select
              value={mlxPresets.some((p) => p.repo === settings.MLX_MODEL) ? settings.MLX_MODEL : undefined}
              onValueChange={(v) => patch.mutate({ MLX_MODEL: v })}
              disabled={busy}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder={t("engine.mlxSelectPlaceholder")} />
              </SelectTrigger>
              <SelectContent className="max-h-72 max-w-sm">
                {mlxPresets.map((p) => (
                  <SelectItem key={p.repo} value={p.repo}>
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{p.label}</span>
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/70">MLX</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        ) : (
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">{t("engine.modelNamePath")}</span>
            <Select
              value={activePath || undefined}
              onValueChange={(v) => setActiveMutation.mutate(v)}
              disabled={setActiveMutation.isPending || busy}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder={t("engine.modelPlaceholder")} />
              </SelectTrigger>
              <SelectContent className="max-h-72 max-w-sm">
                {installedModels
                  .filter((m) => engineSupports(engine, fileKind(m.fileName)))
                  .map((m) => {
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
          </label>
        )}
        <CommitInput label={t("engine.endpoint")} value={endpoint} readOnly mono />
      </div>

      {engine === "mlx" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <CommitInput
            label={t("engine.mlxModelRepo")}
            value={settings.MLX_MODEL ?? ""}
            placeholder="user/Model-MLX 或本地目录路径"
            mono
            onCommit={(v) => patch.mutate({ MLX_MODEL: v.trim() })}
          />
          <CommitInput
            label={t("engine.mlxHfEndpoint")}
            value={settings.MLX_HF_ENDPOINT ?? ""}
            placeholder="https://hf-mirror.com"
            mono
            onCommit={(v) => patch.mutate({ MLX_HF_ENDPOINT: v.trim() })}
          />
        </div>
      )}

      {fields.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {fields.map((f) =>
            f.options ? (
              <label key={f.key} className="flex flex-col gap-1">
                <span className="text-[11px] text-muted-foreground">{t(f.labelKey)}</span>
                <Select
                  value={settings[f.key] ?? f.options[0]?.value}
                  onValueChange={(v) =>
                    patch.mutate(
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
                onCommit={(v) => patch.mutate({ [f.key]: v })}
              />
            ),
          )}
        </div>
      )}

      <ModelFileImportZone />
    </PanelCard>
  );
}

// ---------------------------------------------------------------------------
// 支持的模型（按引擎过滤的精选模型 + 下载 / 使用）
// ---------------------------------------------------------------------------

function pickRecommendedFile(files: MarketFile[], defaultQuant?: string): MarketFile | null {
  if (files.length === 0) return null;
  const weights = files.filter((f) => f.isWeight);
  const pool = weights.length > 0 ? weights : files;
  if (defaultQuant) {
    const hit = pool.find((f) => matchQuant(f.name, defaultQuant));
    if (hit) return hit;
  }
  return pool.reduce<MarketFile | null>((best, f) => (best === null || best.size < f.size ? f : best), null);
}

function PresetRow({ preset, engine }: { preset: ChatPreset; engine: InferenceEngine }) {
  const t = useT();
  const queryClient = useQueryClient();
  const settingsBlob = useSettingsBlob();
  const { data: installedData } = useQuery({
    queryKey: ["installed-models"],
    queryFn: () => rpcClient.listInstalledModels(),
  });
  const installed = (installedData?.models ?? []).filter((m) => m.repo === safeRepoId(preset.repo));
  const installedAny = installed.length > 0;

  // 精选模型默认从 ModelScope 列文件 + 下载（DownloadControls 的 source 默认值一致）。
  const filesQuery = useQuery({
    queryKey: ["market-files", "modelscope", preset.repo],
    queryFn: () => rpcClient.listModelFiles({ repo: preset.repo, source: "modelscope" }),
    enabled: !installedAny && preset.engine !== "mlx",
  });
  const recommended = pickRecommendedFile(filesQuery.data?.files ?? [], preset.defaultQuant);

  const setActiveMutation = useMutation({
    mutationFn: (path: string) => rpcClient.setActiveModel({ path }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["installed-models"] });
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  // MLX 预设没有单文件下载：一键部署 = 切换 MLX 引擎 + 写入 repo + 启动服务
  // （首次启动由 mlx-lm 自动经 HF 下载到本地缓存，日志可见进度）。
  const mlxSettings = settingsBlob.data?.settings ?? {};
  const mlxActive =
    preset.engine === "mlx" &&
    mlxSettings.INFERENCE_ENGINE === "mlx" &&
    mlxSettings.MLX_MODEL === preset.repo;
  const [deployError, setDeployError] = useState<string | null>(null);
  const deployMutation = useMutation({
    mutationFn: async () => {
      setDeployError(null);
      await rpcClient.updateSettings({
        settings: { INFERENCE_ENGINE: "mlx", MLX_MODEL: preset.repo, SERVER_MODE: "local" },
      });
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
      const st = useServerStore.getState().status;
      const res =
        st === "running" || st === "starting" || st === "downloading"
          ? await rpcClient.restartServer()
          : await rpcClient.startServer();
      if (!res.ok) throw new Error(res.error || "Failed to start MLX server");
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["installed-models"] });
    },
    onError: (err: unknown) =>
      setDeployError(err instanceof Error ? err.message.replace(/^Error:\s*/i, "") : String(err)),
  });

  const openDetail = () => {
    useModelDetailStore.getState().setSource({ kind: "preset", preset });
    useRouter.getState().setRoute({ path: "model-detail" });
  };
  const bestInstalled =
    installed.find((m) => preset.defaultQuant && matchQuant(m.fileName, preset.defaultQuant)) ?? installed[0];

  return (
    <div className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-xs font-medium">{preset.label}</p>
          {preset.defaultQuant && (
            <Badge variant="secondary" className="text-[10px]">
              {preset.defaultQuant}
            </Badge>
          )}
          <span className="text-[11px] text-muted-foreground">
            {preset.engine === "mlx" ? "MLX" : preset.engine === "vllm" ? "safetensors" : "GGUF"}
          </span>
          {mlxActive && (
            <Badge variant="default" className="gap-1 text-[10px]">
              <CheckCircle2Icon className="size-3" /> {t("engine.inUse")}
            </Badge>
          )}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{preset.description}</p>
        <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/60">{preset.repo}</p>
        {deployError && (
          <p className="mt-1 text-[11px] text-destructive/80">{deployError}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button variant="ghost" size="icon-sm" tooltip={t("engine.details")} onClick={openDetail}>
          <ExternalLinkIcon className="size-3.5" />
        </Button>
        {preset.engine === "mlx" ? (
          <Button
            variant={mlxActive ? "default" : "outline"}
            size="sm"
            className="h-7 text-xs"
            disabled={deployMutation.isPending}
            onClick={() => deployMutation.mutate()}
          >
            {deployMutation.isPending ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : mlxActive ? (
              <CheckIcon data-icon="inline-start" />
            ) : (
              <RocketIcon data-icon="inline-start" />
            )}
            {mlxActive ? t("engine.inUse") : t("engine.deploy")}
          </Button>
        ) : installedAny && bestInstalled ? (
          <>
            <Badge variant="secondary" className="gap-1 text-[10px]">
              <CheckCircle2Icon className="size-3" /> {t("engine.installed")}
            </Badge>
            <Button
              variant={bestInstalled.isActive ? "default" : "outline"}
              size="sm"
              className="h-7 text-xs"
              disabled={bestInstalled.isActive || setActiveMutation.isPending}
              onClick={() => setActiveMutation.mutate(bestInstalled.path)}
            >
              {bestInstalled.isActive ? (
                <CheckIcon data-icon="inline-start" />
              ) : (
                <PlayIcon data-icon="inline-start" />
              )}
              {bestInstalled.isActive ? t("engine.inUse") : t("engine.useModel")}
            </Button>
          </>
        ) : (
          recommended && (
            <DownloadControls
              repo={preset.repo}
              fileName={recommended.name}
              category={preset.app as ModelCategory}
              installed={filesQuery.isFetching === false && false}
            />
          )
        )}
      </div>
    </div>
  );
}

function SupportedModels({ engine }: { engine: InferenceEngine }) {
  const t = useT();
  const presets = MODEL_PRESETS.filter((p) => {
    if (p.app !== "chat") return false;
    if (engine === "llama.cpp") return p.engine === "llama.cpp";
    if (engine === "mlx") return p.engine === "mlx";
    return p.engine === "vllm";
  });
  if (presets.length === 0) return null;
  return (
    <PanelCard
      title={t("engine.supported")}
      icon={<DownloadIcon className="size-4" />}
      hint={`${presets.length}`}
    >
      <div className="flex flex-col gap-2">
        {presets.map((p) => (
          <PresetRow key={p.repo} preset={p} engine={engine} />
        ))}
      </div>
    </PanelCard>
  );
}

// ---------------------------------------------------------------------------
// 已安装模型管理（沿用原 InstalledModels）
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
    /** 下载来源平台（老数据可能没有）。 */
    source?: ModelSource;
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
          {model.source && <SourceBadge source={model.source} />}
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
        <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/70">{model.repo}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{formatBytes(model.size)}</p>
        {startError && (
          <div className="mt-1 space-y-0.5">
            {startErrorHint && (
              <p className="flex items-start gap-1 text-[11px] text-destructive">
                <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
                <span className="min-w-0 break-words">{startErrorHint}</span>
              </p>
            )}
            <p className="text-[11px] text-destructive/70">{startError}</p>
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

export function InstalledModels({ engine }: { engine: InferenceEngine }) {
  const t = useT();
  const [tab, setTab] = useState<"all" | ModelCategory>("all");
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

  const allModels = (data?.models ?? []).filter(
    (m) => fileKind(m.fileName) === "other" || engineSupports(engine, fileKind(m.fileName)),
  );
  const models = tab === "all" ? allModels : allModels.filter((m) => (m.category ?? "other") === tab);

  const TABS: { value: "all" | ModelCategory; labelKey: string }[] = [
    { value: "all", labelKey: "models.cat.all" },
    { value: "chat", labelKey: "models.cat.chat" },
    { value: "tts", labelKey: "models.cat.tts" },
    { value: "asr", labelKey: "models.cat.asr" },
    { value: "image", labelKey: "models.cat.image" },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <h3 className="mr-1 flex items-center gap-2 text-sm font-medium">
          <HardDriveIcon className="size-4" />
          {t("models.installed")}
        </h3>
        {TABS.map((tb) => {
          const count =
            tb.value === "all"
              ? allModels.length
              : allModels.filter((m) => (m.category ?? "other") === tb.value).length;
          return (
            <button
              key={tb.value}
              type="button"
              onClick={() => setTab(tb.value)}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
                tab === tb.value
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
              )}
            >
              {t(tb.labelKey)}
              <span className="rounded-full bg-background/60 px-1.5 text-[10px] tabular-nums text-muted-foreground">
                {count}
              </span>
            </button>
          );
        })}
      </div>
      {models.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-8 text-center">
          <HardDriveIcon className="size-6 text-muted-foreground/50" />
          <p className="text-xs text-muted-foreground">{t("models.noInstalled")}</p>
        </div>
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
// 默认模型与目录（沿用原 DefaultModelConfig）
// ---------------------------------------------------------------------------

export function DefaultModelConfig() {
  const t = useT();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data } = useSettingsBlob();
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
            <Label htmlFor="localModel" className="mb-1 text-xs">
              {t("settings.modelPicker")}
            </Label>
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
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
                  <SelectItem value="none">None (raw output)</SelectItem>
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
              <Label htmlFor="customHf" className="mb-1 text-xs">
                {t("settings.customHf")}
              </Label>
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
              <Label htmlFor="modelDirPrimary" className="mb-1 text-xs">
                {t("settings.modelDirs.primary")}
              </Label>
              <Input id="modelDirPrimary" value={dirs[0] ?? ""} readOnly className="h-8 font-mono text-xs" />
            </div>
            <div>
              <Label htmlFor="modelDirExtra" className="mb-1 text-xs">
                {t("settings.modelDirs.extra")}
              </Label>
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
// 面板入口
// ---------------------------------------------------------------------------

export function LlmPanel() {
  const t = useT();
  const { engine: activeEngine } = useEngine();
  const settingsBlob = useSettingsBlob();
  // MLX 只面向 macOS（mlx-lm 基于 Apple Silicon），非 mac 上不提供该引擎标签。
  const isMac = settingsBlob.data?.platform === "darwin";
  const engineOptions = ENGINE_OPTIONS.filter((o) => o.value !== "mlx" || isMac);
  const [tab, setTab] = useState<InferenceEngine>(activeEngine);

  // 当前引擎若是非 mac 上不可用的 MLX（如旧配置残留），回退到默认标签。
  useEffect(() => {
    if (!engineOptions.some((o) => o.value === tab)) setTab("llama.cpp");
  }, [engineOptions, tab]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-1.5">
        {engineOptions.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => setTab(o.value)}
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors",
              tab === o.value
                ? "border-primary bg-primary/10 font-medium text-primary"
                : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
            )}
          >
            <CpuIcon className="size-3.5" />
            {ENGINE_TAB_LABEL[o.value]}
            {o.value === activeEngine && (
              <span className="rounded-full bg-emerald-500/15 px-1.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                {t("engine.current")}
              </span>
            )}
          </button>
        ))}
      </div>

      <EngineConfigCard engine={tab} />
      <ModelConfigCard engine={tab} />
      <SupportedModels engine={tab} />
      <InstalledModels engine={tab} />
      <DefaultModelConfig />
    </div>
  );
}
