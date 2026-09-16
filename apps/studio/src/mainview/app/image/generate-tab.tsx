import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SparklesIcon, Loader2Icon, EraserIcon, ShuffleIcon, DownloadCloudIcon, ImageIcon, ChevronDownIcon, CircleIcon, CpuIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import { Textarea } from "@ui/textarea";
import { Badge } from "@ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@ui/collapsible";
import { useT, useUILang } from "@stores/ui-lang";
import { CloudModelSelect } from "@components/cloud-model-select";
import { ResultError } from "@components/media-result";
import { SegmentedControl } from "@components/segmented-control";
import { useImageStore } from "@stores/image";
import { useMlxInstallStore } from "@stores/mlx-install";
import { useMlxModelDownloadStore } from "@stores/mlx-model-download";
import { useMlxModelRunStore } from "@stores/mlx-model-run";
import type { ImageGenBackend, ImageRecordRow } from "../../../bun/image-gen";
import type { MlxModelInfo } from "../../../bun/mlx-gen";
import { cn } from "@/mainview/lib/utils";
import { RATIOS, RANDOM_PROMPTS, MLX_FALLBACKS, formatTime, formatBytes, ImageCard, GenLoading, RecentStrip, isForeignModel } from "./parts";

export function GenerateTab() {
  const t = useT();
  const lang = useUILang((s) => s.lang);
  const queryClient = useQueryClient();
  const focusRecordId = useImageStore((s) => s.focusRecordId);
  const setView = useImageStore((s) => s.setView);

  const [prompt, setPrompt] = useState("");
  const [negative, setNegative] = useState("");
  const [ratioIdx, setRatioIdx] = useState(3); // 1:1
  const [count, setCount] = useState(1);
  const [steps, setSteps] = useState(25);
  const [seed, setSeed] = useState("");
  const [model, setModel] = useState("");
  const [quantize, setQuantize] = useState(8); // MLX：加载时量化位数，0 = 不量化
  const [results, setResults] = useState<ImageRecordRow[]>();

  // 提示词库「去试试」带入的草稿：挂载时预填提示词框。
  const pendingPrompt = useImageStore((s) => s.pendingPrompt);
  useEffect(() => {
    if (!pendingPrompt) return;
    setPrompt(pendingPrompt);
    useImageStore.getState().setPendingPrompt(null);
  }, [pendingPrompt]);

  // ---------- 后端配置 ----------
  const [backend, setBackend] = useState<ImageGenBackend>("api");
  // 云端只记厂商 id：地址 / 密钥在「设置 → 模型云服务」里（本页不再让用户填）。
  const [providerId, setProviderId] = useState("");
  const [comfyBase, setComfyBase] = useState("");
  const [configError, setConfigError] = useState<string>();
  const hydrated = useRef(false);

  const { data: configData } = useQuery({
    queryKey: ["image-gen-config"],
    queryFn: () => rpcClient.getImageGenConfig(),
  });
  const config = configData?.config;

  useEffect(() => {
    if (!config || hydrated.current) return;
    hydrated.current = true;
    setBackend(config.backend);
    setProviderId(config.providerId);
    setComfyBase(config.comfyBase);
    setModel(config.model);
    if (config.backend === "mlx") {
      const m = MLX_FALLBACKS.find((x) => x.id === config.model);
      if (m) setSteps(m.defaultSteps);
    }
  }, [config]);

  // patch 用于「选完即存」：选择器刚回传的新值还没进 state，直接读 state 会存下旧厂商。
  const saveConfig = useMutation({
    mutationFn: (patch: { providerId?: string; model?: string } = {}) =>
      rpcClient.saveImageGenConfig({
        backend,
        providerId: (patch.providerId ?? providerId).trim(),
        comfyBase: comfyBase.trim(),
        model: (patch.model ?? model).trim(),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["image-gen-config"] });
      queryClient.invalidateQueries({ queryKey: ["cloud-providers"] });
    },
  });

  const fetchModels = useMutation({
    mutationFn: () =>
      rpcClient.listImageGenModels({
        backend,
        base: backend === "comfyui" ? comfyBase.trim() : "",
      }),
    onSuccess: (r) => {
      if (r.error) {
        setConfigError(r.error);
        return;
      }
      setConfigError(undefined);
      if (r.models.length > 0 && !r.models.includes(model)) setModel(r.models[0]!);
    },
    onError: (e) => setConfigError(String(e)),
  });

  const { data: modelsData } = useQuery({
    queryKey: ["image-gen-models", backend, comfyBase],
    queryFn: () => rpcClient.listImageGenModels({ backend }),
    // 云端模型清单来自服务商（选择器里已经按用途筛过），只有 ComfyUI 需要探测。
    enabled: backend === "comfyui" && !!comfyBase.trim(),
  });
  const models = modelsData?.models ?? [];

  // ---------- MLX 本地引擎（mflux，Apple Silicon） ----------
  const mlxLogs = useMlxInstallStore((s) => s.logs);
  const clearMlxLogs = useMlxInstallStore((s) => s.clearLogs);
  const { data: mlxStatus, refetch: refetchMlxStatus } = useQuery({
    queryKey: ["mlx-gen-status"],
    queryFn: () => rpcClient.getMlxGenStatus(),
    enabled: backend === "mlx",
    // 未安装时轮询，安装进程结束后自动变为已就绪。
    refetchInterval: (q) => (q.state.data?.engineInstalled ? false : 3000),
  });
  const { data: mlxModelsData } = useQuery({
    queryKey: ["mlx-gen-models"],
    queryFn: () => rpcClient.listMlxGenModels(),
    enabled: backend === "mlx",
  });
  const mlxModels: MlxModelInfo[] = mlxModelsData?.models ?? [];

  // ---------- MLX 模型权重下载（先下载、后生成；带进度） ----------
  const { data: mlxDownloadedData, refetch: refetchMlxDownloaded } = useQuery({
    queryKey: ["mlx-downloaded-models"],
    queryFn: () => rpcClient.getDownloadedMlxModels(),
    enabled: backend === "mlx",
    // 下载可能超过 RPC 超时（十几分钟 vs 大模型几十 GB），进度/完成消息也未必可靠，
    // 这里兜底轮询：只要有下载在进行，就每 2s 拉一次“已下载模型”，
    // 确保真正下完后 UI 能及时把“下载中”切到“已下载”标识。
    refetchInterval: () => {
      const dl = useMlxModelDownloadStore.getState().progress?.stage === "downloading";
      return dl ? 2000 : false;
    },
  });
  const mlxDownloaded = new Set(mlxDownloadedData?.downloaded ?? []);
  const modelProgress = useMlxModelDownloadStore((s) => s.progress);
  // 持久化的断点进度：模型未下完时展示「继续下载（已下载 X%）」，点击从断点续传。
  const { data: mlxStatesData } = useQuery({
    queryKey: ["mlx-download-states"],
    queryFn: () => rpcClient.getMlxModelDownloadStates(),
    enabled: backend === "mlx",
  });
  const mlxStates = mlxStatesData?.states ?? [];
  const resumeState = mlxStates.find((s) => s.modelId === model.trim());
  // 有断点记录且确实没下完 → 按钮变「继续下载（已下载 X%）」，点击从断点续传。
  const showResume =
    !!resumeState &&
    resumeState.doneBytes > 0 &&
    resumeState.allBytes > 0 &&
    resumeState.percent > 0;

  // ---------- 常驻生图模型（启动一次、反复生成；展示启动/生成分步） ----------
  const { data: mlxActiveData, refetch: refetchMlxActive } = useQuery({
    queryKey: ["mlx-active-model"],
    queryFn: () => rpcClient.getMlxActiveModel(),
    enabled: backend === "mlx",
  });
  const mlxActive = mlxActiveData?.active ?? null;
  const activeForModel = mlxActive?.modelId === model.trim();
  const runPhase = useMlxModelRunStore((s) => s.phase);
  // 启动中/加载中：worker 已起但模型尚未 loaded（此期间 active 查询还是 null）。
  const runStartingThis =
    !!runPhase &&
    (runPhase.phase === "starting" || runPhase.phase === "loading") &&
    runPhase.modelId === model.trim() &&
    !activeForModel;
  const startModelMut = useMutation({
    mutationFn: () => rpcClient.startMlxModel({ modelId: model.trim(), quantize }),
    onSuccess: (r) => {
      if (!r.ok) setConfigError(r.error);
      else setConfigError(undefined);
      void refetchMlxActive();
    },
    onError: (e) => setConfigError(String(e)),
  });
  const stopModelMut = useMutation({
    mutationFn: () => rpcClient.stopMlxModel(),
    onSuccess: () => {
      void refetchMlxActive();
    },
  });
  const downloading = modelProgress?.stage === "downloading";
  const downloadingThis =
    downloading && !!modelProgress && modelProgress.modelId === model && mlxStatus?.engineInstalled;
  const downloadMlxModelMut = useMutation({
    mutationFn: () => rpcClient.downloadMlxModel({ modelId: model }),
    onSuccess: (r) => {
      if (!r.ok) setConfigError(r.error);
      else setConfigError(undefined);
      void refetchMlxDownloaded();
    },
    onError: (e) => setConfigError(String(e)),
  });
  const installMlx = useMutation({
    mutationFn: () => rpcClient.downloadMlxGenEngine(),
    onSuccess: (r) => {
      if (!r.ok) setConfigError(r.error);
      else setConfigError(undefined);
      void refetchMlxStatus();
    },
    // RPC 超时等错误不代表安装终止：安装继续在主进程进行，状态轮询会兜底。
    onError: (e) => setConfigError(String(e)),
  });
  const logEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: "end" });
  }, [mlxLogs]);

  const pickMlxModel = (id: string) => {
    setModel(id);
    const m = mlxModels.find((x) => x.id === id);
    if (m) setSteps(m.defaultSteps);
    void rpcClient.saveImageGenConfig({ backend, model: id });
  };

  const configured =
    backend === "mlx"
      ? (mlxStatus?.engineInstalled ?? false)
      : backend === "comfyui"
        ? !!comfyBase.trim()
        : // 云端：选了已启用的厂商与模型才算配好（地址与密钥由厂商行提供）。
          // 本地引擎的 id（切后端留下的残留）不算配好 —— 它到了厂商那边只会换来
          // 一句 "Model does not exist"，而界面此时若写着"已配置"，用户只能去猜。
          !!providerId.trim() && !!model.trim() && !isForeignModel("api", model, mlxModels);

  // MLX 后端：引擎就绪 + 已选模型 + 权重已下载，才允许生图。
  const mlxModelReady =
    (mlxStatus?.engineInstalled ?? false) && !!model.trim() && mlxDownloaded.has(model.trim());

  // ---------- 侧边栏聚焦的历史记录 ----------
  const { data: recordsData } = useQuery({
    queryKey: ["image-records"],
    queryFn: () => rpcClient.listImageRecords(undefined),
  });
  useEffect(() => {
    if (focusRecordId == null || !recordsData) return;
    const rec = recordsData.records.find((r) => r.id === focusRecordId);
    if (rec) setResults([rec]);
  }, [focusRecordId, recordsData]);

  // ---------- 生成 ----------
  const generate = useMutation({
    mutationFn: () => {
      const ratio = RATIOS[ratioIdx]!;
      const parsedSeed = Number.parseInt(seed, 10);
      return rpcClient.generateImage({
        prompt,
        negativePrompt: negative.trim() || undefined,
        width: ratio.w,
        height: ratio.h,
        count,
        steps,
        seed: Number.isFinite(parsedSeed) && parsedSeed >= 0 ? parsedSeed : undefined,
        model: model.trim() || undefined,
        quantize: backend === "mlx" ? quantize : undefined,
        // 把页面上的实时配置一并带上，后端优先使用它们并落盘，
        // 避免后台读到未保存的旧厂商而连错服务商。
        config: {
          backend,
          providerId: providerId.trim(),
          model: model.trim(),
          comfyBase: comfyBase.trim(),
        },
      });
    },
    onSuccess: (r) => {
      if (r.error) {
        setConfigError(r.error);
        return;
      }
      setConfigError(undefined);
      if (r.records.length > 0) setResults(r.records);
      queryClient.invalidateQueries({ queryKey: ["image-records"] });
      queryClient.invalidateQueries({ queryKey: ["image-gen-config"] });
    },
    onError: (e) => setConfigError(String(e)),
  });

  // 生图前需先下载好 MLX 模型权重（不改原有的自动下载行为）。
  const canGenerate =
    !!prompt.trim() &&
    !generate.isPending &&
    configured &&
    (backend !== "mlx" || mlxModelReady);


  const ratio = RATIOS[ratioIdx]!;
  // 右上角预览卡：取结果里最新一条（即最后生成的那张）。
  const latest = results?.[results.length - 1];

  return (
    <div className="flex h-full min-h-0">
      {/* 中间：参数面板 */}
      <aside className="w-[340px] shrink-0 overflow-y-auto border-r p-4">
        <div className="flex flex-col gap-5">
          {/* 后端切换 */}
          <div>
            <Label className="mb-1.5 block text-xs">{t("image.backend")}</Label>
            <SegmentedControl
              variant="attached"
              value={backend}
              onChange={(key) => {
                const next = key as ImageGenBackend;
                setBackend(next);
                // 三个后端共用一个 IMG_MODEL 槽位：从本地 MLX 切到云端时它不会被清掉，
                // 于是 z-image-turbo 这种本地 preset id 会被当成云端模型发给厂商，
                // 界面还显示"已配置"，直到生成时才拿回一句 "Model does not exist"。
                // 判定为"不属于目标后端"就清空，让用户重选（值也一起写回，别留着假配置）。
                const stale = isForeignModel(next, model, mlxModels);
                if (stale) setModel("");
                void rpcClient.saveImageGenConfig({
                  backend: next,
                  ...(stale ? { model: "" } : {}),
                });
              }}
              options={[
                { value: "api", label: t("image.backend.cloud") },
                { value: "mlx", label: t("image.backend.mlx") },
                { value: "comfyui", label: t("image.backend.comfyui") },
              ]}
            />
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              {t(
                backend === "api"
                  ? "image.backend.cloudDesc"
                  : backend === "mlx"
                    ? "image.backend.mlxDesc"
                    : "image.backend.comfyuiDesc",
              )}
            </p>
          </div>

          {/* 服务配置（MLX 为本地引擎卡片） */}
          {backend === "mlx" ? (
            <div className="flex flex-col gap-2.5 rounded-lg border bg-card p-3">
              <div className="flex items-center gap-2.5">
                <CpuIcon className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium">{t("image.mlx.engine")}</p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {!mlxStatus
                      ? "…"
                      : !mlxStatus.supported
                        ? t("image.mlx.unsupported")
                        : !mlxStatus.pythonFound
                          ? t("image.mlx.needPython")
                          : mlxStatus.engineInstalled
                            ? `${t("image.mlx.engineReady")}${mlxStatus.version ? ` · v${mlxStatus.version}` : ""}`
                            : t("image.mlx.engineNone")}
                  </p>
                </div>
                {mlxStatus?.supported && !mlxStatus.engineInstalled && (
                  <Button
                    size="sm"
                    disabled={!mlxStatus.pythonFound || installMlx.isPending}
                    onClick={() => {
                      clearMlxLogs();
                      installMlx.mutate();
                    }}
                  >
                    {installMlx.isPending ? (
                      <Loader2Icon data-icon="inline-start" className="animate-spin" />
                    ) : (
                      <DownloadCloudIcon data-icon="inline-start" />
                    )}
                    {installMlx.isPending
                      ? t("image.mlx.downloadingEngine")
                      : t("image.mlx.downloadEngine")}
                  </Button>
                )}
              </div>

              {(installMlx.isPending || mlxLogs.length > 0) && (
                <div className="max-h-32 overflow-y-auto rounded-md bg-muted/60 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
                  {mlxLogs.slice(-40).map((l, i) => (
                    <p key={i} className="break-all whitespace-pre-wrap">
                      {l}
                    </p>
                  ))}
                  <div ref={logEndRef} />
                </div>
              )}

              <div>
                <Label className="mb-1 block text-xs">{t("image.config.model")}</Label>
                <Select value={model} onValueChange={pickMlxModel}>
                  <SelectTrigger className="h-8 w-full text-xs">
                    <SelectValue placeholder={t("image.mlx.selectModel")} />
                  </SelectTrigger>
                  <SelectContent>
                    {mlxModels.map((m) => {
                      const downloaded = mlxDownloaded.has(m.id);
                      return (
                        <SelectItem key={m.id} value={m.id} className="text-xs">
                          <span className="flex w-full items-center justify-between gap-2">
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate">{m.label}</span>
                              {downloaded ? (
                                <Badge
                                  variant="secondary"
                                  className="h-4 shrink-0 gap-0.5 px-1 text-[9px] font-normal text-emerald-600 dark:text-emerald-400"
                                >
                                  <CircleIcon className="size-2 fill-current" />
                                  {t("image.mlx.modelDownloaded")}
                                </Badge>
                              ) : (
                                <span className="shrink-0 text-[9px] text-muted-foreground">
                                  {t("image.mlx.modelNotDownloaded")}
                                </span>
                              )}
                            </span>
                            <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                              ~{m.approxSizeGb}GB
                            </span>
                          </span>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>

                {/* 下载模型（权重） + 实时进度 */}
                {mlxStatus?.engineInstalled && (
                  <div className="mt-2 flex flex-col gap-2">
                    {downloadingThis && modelProgress ? (
                      <div className="flex flex-col gap-1 rounded-md border bg-muted/40 p-2">
                        <div className="flex items-center justify-between text-[10px] tabular-nums text-muted-foreground">
                          <span className="truncate text-primary">
                            {modelProgress.fileName
                              ? `${t("image.mlx.downloadingFile")}：${modelProgress.fileName.split("/").pop()}`
                              : t("image.mlx.downloadingModel")}
                          </span>
                          <span className="ml-2 shrink-0">{modelProgress.percent}%</span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-primary transition-[width] duration-300"
                            style={{ width: `${Math.min(100, modelProgress.percent)}%` }}
                          />
                        </div>
                        <p className="text-[9px] tabular-nums text-muted-foreground">
                          {modelProgress.filesTotal > 0
                            ? `${modelProgress.filesDone}/${modelProgress.filesTotal} 文件 · ${formatBytes(
                                modelProgress.doneBytes + modelProgress.received,
                              )} / ${formatBytes(modelProgress.allBytes)}`
                            : formatBytes(modelProgress.received)}
                        </p>
                      </div>
                    ) : mlxDownloaded.has(model.trim()) ? (
                      <Badge
                        variant="secondary"
                        className="w-fit gap-1 text-[10px] font-normal text-emerald-600 dark:text-emerald-400"
                      >
                        <CircleIcon className="size-2.5 fill-current" />
                        {t("image.mlx.modelDownloaded")}
                      </Badge>
                    ) : (
                      <>
                        {(() => {
                          return (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={!model.trim() || downloadMlxModelMut.isPending}
                                onClick={() => {
                                  setConfigError(undefined);
                                  useMlxModelDownloadStore.getState().reset();
                                  downloadMlxModelMut.mutate();
                                }}
                              >
                                {downloadMlxModelMut.isPending ? (
                                  <Loader2Icon
                                    data-icon="inline-start"
                                    className="animate-spin"
                                  />
                                ) : (
                                  <DownloadCloudIcon data-icon="inline-start" />
                                )}
                                {downloadMlxModelMut.isPending
                                  ? t("image.mlx.downloadingModel")
                                  : showResume
                                    ? `${t("image.mlx.resumeDownload")}（${t("image.mlx.resumePartial").replace(
                                        "{percent}",
                                        String(Math.max(1, resumeState!.percent)),
                                      )}）`
                                    : t("image.mlx.downloadModel")}
                              </Button>
                              {showResume && (
                                <div className="flex flex-col gap-1">
                                  <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                                    <div
                                      className="h-full rounded-full bg-primary/80"
                                      style={{
                                        width: `${Math.min(100, resumeState!.percent)}%`,
                                      }}
                                    />
                                  </div>
                                  <p className="text-[10px] leading-relaxed tabular-nums text-amber-600/80 dark:text-amber-400/80">
                                    {t("image.mlx.resumeHint")
                                      .replace("{done}", formatBytes(resumeState!.doneBytes))
                                      .replace("{all}", formatBytes(resumeState!.allBytes))}
                                  </p>
                                </div>
                              )}
                            </>
                          );
                        })()}
                        {model.trim() && !showResume && (
                          <p className="text-[10px] leading-relaxed text-amber-600/80 dark:text-amber-400/80">
                            {t("image.mlx.modelNeedDownload")}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                )}

                {/* 启动常驻模型：加载一次进内存，之后生图不再重载权重（分步展示进度） */}
                {mlxStatus?.engineInstalled && model.trim() && (
                  <div className="mt-1 flex flex-col gap-1.5">
                    {runStartingThis ? (
                      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                        <Loader2Icon className="size-3 animate-spin text-primary" />
                        <span>
                          {t("image.mlx.modelStarting").replace(
                            "{sec}",
                            String(runPhase?.seconds ?? 0),
                          )}
                        </span>
                      </div>
                    ) : activeForModel ? (
                      <div className="flex items-center justify-between gap-2">
                        <Badge
                          variant="secondary"
                          className="w-fit gap-1 text-[10px] font-normal text-emerald-600 dark:text-emerald-400"
                        >
                          <CircleIcon className="size-2 fill-current" />
                          {t("image.mlx.modelStarted")}
                          {mlxActive?.quantize ? ` · ${mlxActive.quantize}-bit` : ""}
                        </Badge>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 text-[11px] text-muted-foreground"
                          disabled={stopModelMut.isPending}
                          onClick={() => stopModelMut.mutate()}
                        >
                          {t("image.mlx.modelStop")}
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            startModelMut.isPending ||
                            downloading ||
                            !mlxDownloaded.has(model.trim())
                          }
                          onClick={() => startModelMut.mutate()}
                        >
                          <CpuIcon data-icon="inline-start" className="size-3.5" />
                          {t("image.mlx.modelStart")}
                        </Button>
                        <span className="text-[10px] text-muted-foreground">
                          {t("image.mlx.modelStartHint")}
                        </span>
                      </div>
                    )}
                  </div>
                )}
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {t("image.mlx.modelHint")}
                </p>
              </div>
              {configError && <ResultError error={configError} />}
            </div>
          ) : (
          <div className="flex flex-col gap-2.5 rounded-lg border bg-card p-3">
            {backend === "api" ? (
              // 云端生图：只选厂商 + 模型（都是「设置 → 模型云服务」里配好并启动过的），
              // 地址与密钥由厂商提供，这里不再出现输入框。
              <div>
                <Label className="mb-1 block text-xs">{t("image.config.cloudProvider")}</Label>
                <CloudModelSelect
                  kind="image"
                  providerId={providerId}
                  model={model}
                  size="sm"
                  onChange={(choice) => {
                    setProviderId(choice.providerId);
                    setModel(choice.model);
                    saveConfig.mutate(choice);
                  }}
                />
                <p className="mt-1.5 text-[10px] text-muted-foreground">{t("cloud.where")}</p>
              </div>
            ) : (
              <>
                <div>
                  <Label htmlFor="img-comfy-base" className="mb-1 block text-xs">
                    {t("image.config.comfyBase")}
                  </Label>
                  <Input
                    id="img-comfy-base"
                    placeholder="http://127.0.0.1:8188"
                    value={comfyBase}
                    onChange={(e) => setComfyBase(e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
                <div>
                  <Label htmlFor="img-model" className="mb-1 block text-xs">
                    {t("image.config.model")}
                  </Label>
                  <Input
                    id="img-model"
                    list="image-gen-models"
                    placeholder={t("image.config.checkpointPlaceholder")}
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    className="h-8 text-xs"
                  />
                  {models.length > 0 && (
                    <datalist id="image-gen-models">
                      {models.map((m) => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
                  )}
                </div>
              </>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={() => saveConfig.mutate({})}
                disabled={
                  saveConfig.isPending ||
                  (backend === "api" ? !providerId.trim() : !comfyBase.trim())
                }
              >
                {saveConfig.isPending ? (
                  <Loader2Icon data-icon="inline-start" className="animate-spin" />
                ) : null}
                {t("image.config.save")}
              </Button>
              {/* 云端模型清单来自服务商，不需要在这里扫；ComfyUI 的 checkpoint 仍要探测。 */}
              {backend === "comfyui" && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => fetchModels.mutate()}
                  disabled={fetchModels.isPending || !configured}
                >
                  {fetchModels.isPending ? (
                    <Loader2Icon data-icon="inline-start" className="animate-spin" />
                  ) : null}
                  {t("image.config.fetchModels")}
                </Button>
              )}
              {configured && (
                <Badge variant="secondary" className="gap-1 text-[10px]">
                  <CircleIcon className="size-2.5 fill-current text-emerald-500" />
                  {t("image.config.configured")}
                </Badge>
              )}
            </div>
            {backend === "comfyui" && models.length > 0 && (
              <p className="text-[10px] text-muted-foreground tabular-nums">
                {models.length} {t("image.config.modelsCount")}
              </p>
            )}
            {/* 探测失败此前是彻底静默的：模型列表空着，界面只显示"0 个模型"。
                ComfyUI 没启动 / 地址写错 / 代理挡了，都是这条错误在说话。 */}
            {backend === "comfyui" && modelsData?.error && <ResultError error={modelsData.error} />}
            {configError && <ResultError error={configError} />}
          </div>
          )}

          {/* 提示词 */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <Label htmlFor="img-prompt" className="text-xs">
                {t("image.prompt")}
              </Label>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground"
                  onClick={() => {
                    const picks = RANDOM_PROMPTS[lang];
                    setPrompt(picks[Math.floor(Math.random() * picks.length)]!);
                  }}
                >
                  <ShuffleIcon className="size-3" />
                  {t("image.prompt.random")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground"
                  onClick={() => setPrompt("")}
                >
                  <EraserIcon className="size-3" />
                  {t("image.prompt.clear")}
                </Button>
              </div>
            </div>
            <Textarea
              id="img-prompt"
              rows={7}
              placeholder={t("image.promptPlaceholder")}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="resize-none text-xs"
            />
          </div>

          {/* 参数 */}
          <div className="flex flex-col gap-3 rounded-lg border bg-card p-3">
            <p className="text-xs font-medium">{t("image.params")}</p>

            <div>
              <Label className="mb-1.5 block text-[11px] text-muted-foreground">
                {t("image.params.ratio")}
              </Label>
              <div className="flex flex-wrap gap-1.5">
                {RATIOS.map((r, i) => (
                  <button
                    key={r.label}
                    type="button"
                    onClick={() => setRatioIdx(i)}
                    className={cn(
                      "rounded-md border px-2 py-1 text-[11px] tabular-nums transition-colors",
                      ratioIdx === i
                        ? "border-primary bg-primary/10 text-primary"
                        : "text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
                    )}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="img-width" className="mb-1 block text-[11px] text-muted-foreground">
                  {t("image.params.width")}
                </Label>
                <Input
                  id="img-width"
                  type="number"
                  min={64}
                  max={4096}
                  step={64}
                  value={ratio.w}
                  disabled
                  className="h-8 text-xs tabular-nums"
                />
              </div>
              <div>
                <Label htmlFor="img-height" className="mb-1 block text-[11px] text-muted-foreground">
                  {t("image.params.height")}
                </Label>
                <Input
                  id="img-height"
                  type="number"
                  min={64}
                  max={4096}
                  step={64}
                  value={ratio.h}
                  disabled
                  className="h-8 text-xs tabular-nums"
                />
              </div>
            </div>

            <div>
              <Label htmlFor="img-count" className="mb-1 block text-[11px] text-muted-foreground">
                {t("image.params.count")}
              </Label>
              <Input
                id="img-count"
                type="number"
                min={1}
                max={8}
                value={count}
                onChange={(e) => setCount(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
                className="h-8 text-xs tabular-nums"
              />
            </div>

            {/* 高级选项 */}
            <Collapsible>
              <CollapsibleTrigger className="group flex w-full items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground">
                <ChevronDownIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
                {t("image.params.advanced")}
              </CollapsibleTrigger>
              <CollapsibleContent className="flex flex-col gap-3 pt-3">
                {backend === "mlx" ? (
                  <>
                    <div>
                      <Label className="mb-1 block text-[11px] text-muted-foreground">
                        {t("image.mlx.quantize")}
                      </Label>
                      <Select value={String(quantize)} onValueChange={(v) => setQuantize(Number(v))}>
                        <SelectTrigger className="h-8 w-full text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="0">{t("image.mlx.quantizeOff")}</SelectItem>
                          <SelectItem value="8">8-bit</SelectItem>
                          <SelectItem value="6">6-bit</SelectItem>
                          <SelectItem value="4">4-bit</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <p className="text-[11px] text-muted-foreground">{t("image.mlx.noNegative")}</p>
                  </>
                ) : (
                  <div>
                    <Label htmlFor="img-negative" className="mb-1 block text-[11px] text-muted-foreground">
                      {t("image.params.negative")}
                    </Label>
                    <Textarea
                      id="img-negative"
                      rows={2}
                      placeholder={t("image.params.negativePlaceholder")}
                      value={negative}
                      onChange={(e) => setNegative(e.target.value)}
                      className="resize-none text-xs"
                    />
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label htmlFor="img-steps" className="mb-1 block text-[11px] text-muted-foreground">
                      {t("image.params.steps")}
                    </Label>
                    <Input
                      id="img-steps"
                      type="number"
                      min={1}
                      max={100}
                      value={steps}
                      onChange={(e) => setSteps(Math.max(1, Math.min(100, Number(e.target.value) || 25)))}
                      className="h-8 text-xs tabular-nums"
                    />
                  </div>
                  <div>
                    <Label htmlFor="img-seed" className="mb-1 block text-[11px] text-muted-foreground">
                      {t("image.params.seed")}
                    </Label>
                    <Input
                      id="img-seed"
                      type="number"
                      min={-1}
                      placeholder="-1"
                      value={seed}
                      onChange={(e) => setSeed(e.target.value)}
                      className="h-8 text-xs tabular-nums"
                    />
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>

          <Button
            size="lg"
            onClick={() => generate.mutate()}
            disabled={!canGenerate}
            className="w-full"
          >
            {generate.isPending ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <SparklesIcon data-icon="inline-start" />
            )}
            {generate.isPending ? (
              runPhase?.phase === "generating" &&
              runPhase.modelId === model.trim() &&
              runPhase.step != null &&
              runPhase.total != null ? (
                t("image.mlx.generatingStep")
                  .replace("{step}", String(runPhase.step))
                  .replace("{total}", String(runPhase.total))
              ) : (
                t("image.generating")
              )
            ) : (
              t("image.generate")
            )}
          </Button>
          {backend === "mlx" && !canGenerate && !mlxModelReady && mlxStatus?.engineInstalled && (
            <p className="text-center text-[10px] text-amber-600/80 dark:text-amber-400/80">
              {t("image.mlx.modelNeedDownload")}
            </p>
          )}
        </div>
      </aside>

      {/* 右侧：结果区 */}
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* 右上角：当前结果的悬浮预览卡 */}
        {latest && latest.imageUrl && (
          <div className="absolute right-5 top-5 z-20 w-44 overflow-hidden rounded-xl border bg-card/95 shadow-lg backdrop-blur">
            <div
              className="relative w-full overflow-hidden bg-muted"
              style={{
                aspectRatio:
                  latest.width && latest.height && latest.width > 0 && latest.height > 0
                    ? latest.width / latest.height
                    : 16 / 9,
              }}
            >
              <img src={latest.imageUrl} alt={latest.prompt ?? ""} className="size-full object-cover" />
              <span className="absolute left-1.5 top-1.5 rounded-md bg-black/55 px-1.5 py-0.5 text-[9px] font-medium text-white">
                {latest.status}
              </span>
            </div>
            <div className="space-y-1 p-2">
              <p className="line-clamp-2 text-[11px] leading-snug text-foreground">{latest.prompt}</p>
              <p className="text-[10px] tabular-nums text-muted-foreground">
                {latest.width && latest.height ? `${latest.width}×${latest.height} · ` : ""}
                {formatTime(latest.createdAt)}
              </p>
            </div>
            {focusRecordId != null && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-full rounded-none border-t text-[11px] text-muted-foreground"
                onClick={() => {
                  useImageStore.getState().setFocusRecordId(null);
                  setResults(undefined);
                }}
              >
                {t("common.cancel")}
              </Button>
            )}
          </div>
        )}

        <div className="flex min-h-0 flex-1 items-center justify-center p-8 pt-16">
          {generate.isPending ? (
            <GenLoading prompt={prompt} />
          ) : results?.length ? (
            <div className="flex min-w-0 max-w-full flex-wrap items-center justify-center gap-5">
              {results.map((r) => (
                <ImageCard key={r.id} record={r} highlight={r.id === focusRecordId} />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-3 text-center">
              <div className="flex size-20 items-center justify-center rounded-2xl bg-primary/15">
                <ImageIcon className="size-9 text-primary" />
              </div>
              <p className="text-lg font-medium">{t("image.result.empty")}</p>
              <p className="max-w-xs text-sm text-muted-foreground">{t("image.result.emptyHint")}</p>
            </div>
          )}
        </div>

        {/* 底部：最近成功生成的图片 + 更多（全部历史） */}
        <RecentStrip records={recordsData?.records ?? []} onOpenHistory={() => setView("history")} />
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI 修图 Tab：与生图页布局基本一致，差别在于需要先上传一张参考图；
// 生成时把参考图 + 修改提示词一起发给 OpenAI 兼容的 /v1/images/edits。
// ---------------------------------------------------------------------------

