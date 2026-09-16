import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SparklesIcon, Loader2Icon, EraserIcon, ClapperboardIcon, ChevronDownIcon, ImagePlusIcon, XIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { CloudModelSelect } from "@components/cloud-model-select";
import { SegmentedControl } from "@components/segmented-control";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import { Textarea } from "@ui/textarea";
import { Badge } from "@ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@ui/collapsible";
import { Switch } from "@ui/switch";
import { useT } from "@stores/ui-lang";
import { ResultError } from "@components/media-result";
import { useVideoStore } from "@stores/video";
import type { VideoGenBackend } from "../../../bun/video-gen";
import { cn } from "@/mainview/lib/utils";
import { RATIOS, COMFY_SIZES, DURATION_RANGE, DURATION_OPTIONS, DEFAULT_RESOLUTION, RESOLUTIONS, BACKEND_ITEMS, snapDuration, VideoTaskCard, VideoFailedCard, VideoPlayerCard, RecentStrip } from "./parts";

export function GenerateTab() {
  const t = useT();
  const queryClient = useQueryClient();
  const focusRecordId = useVideoStore((s) => s.focusRecordId);
  const setFocusRecordId = useVideoStore((s) => s.setFocusRecordId);
  const setView = useVideoStore((s) => s.setView);

  const [prompt, setPrompt] = useState("");
  const [negative, setNegative] = useState("");
  const [ratioIdx, setRatioIdx] = useState(0); // 16:9
  const [duration, setDuration] = useState(5);
  const [resolution, setResolution] = useState("768P");
  const [steps, setSteps] = useState(20);
  const [cfg, setCfg] = useState(5);
  const [seed, setSeed] = useState("");
  const [watermark, setWatermark] = useState(false);
  const [firstFrame, setFirstFrame] = useState<{ ref: string; url: string }>();

  // 提示词库「去试试」带入的草稿：挂载时预填提示词框。
  const pendingPrompt = useVideoStore((s) => s.pendingPrompt);
  useEffect(() => {
    if (!pendingPrompt) return;
    setPrompt(pendingPrompt);
    useVideoStore.getState().setPendingPrompt(null);
  }, [pendingPrompt]);

  // ---------- 后端配置 ----------
  const [backend, setBackend] = useState<VideoGenBackend>("cloud");
  // 云端只记厂商 + 模型：地址 / 密钥 / 接口协议都在「设置 → 模型云服务」里。
  const [providerId, setProviderId] = useState("");
  const [cloudModel, setCloudModel] = useState("");
  const [comfyBase, setComfyBase] = useState("");
  const [comfyCkpt, setComfyCkpt] = useState("");
  const [comfyClip, setComfyClip] = useState("");
  const [comfyVae, setComfyVae] = useState("");
  const [configError, setConfigError] = useState<string>();
  const hydrated = useRef(false);

  const { data: configData } = useQuery({
    queryKey: ["video-gen-config"],
    queryFn: () => rpcClient.getVideoGenConfig(undefined),
  });
  const config = configData?.config;

  // 当前厂商的生视频协议（决定分辨率档位与时长范围）；没选厂商时按 MiniMax 显示。
  const providersQuery = useQuery({
    queryKey: ["cloud-providers"],
    queryFn: () => rpcClient.cloudProviderList(undefined),
  });
  const selectedProvider =
    (providersQuery.data?.providers ?? []).find((p) => p.id === providerId) ?? null;
  const protocol: "minimax" | "seedance" =
    selectedProvider?.videoApi === "seedance" ? "seedance" : "minimax";

  useEffect(() => {
    if (!config || hydrated.current) return;
    hydrated.current = true;
    setBackend(config.backend);
    setProviderId(config.providerId);
    setCloudModel(config.model);
    setComfyBase(config.comfyBase);
    setComfyCkpt(config.comfyCkpt);
    setComfyClip(config.comfyClip);
    setComfyVae(config.comfyVae);
  }, [config]);

  // 档位按**协议**分，换厂商等于换协议：MiniMax 的 480P/768P/2K 与 Seedance 的
  // 480p/720p/1080p 互不认，时长上限也不同（15s vs 12s）。不跟着收敛就会把
  // 上一个厂商的档位原样发给上游。
  useEffect(() => {
    const options = RESOLUTIONS[protocol];
    setResolution((r) => (options.includes(r) ? r : DEFAULT_RESOLUTION[protocol]));
    setDuration((d) => snapDuration(protocol, d));
  }, [protocol]);

  const switchBackend = (key: VideoGenBackend) => {
    setBackend(key);
    // 切后端时收敛时长与分辨率到该后端支持的档位。
    const key2 = key === "comfyui" ? "comfyui" : protocol;
    setDuration((d) => snapDuration(key2, d));
    if (key !== "comfyui") {
      const options = RESOLUTIONS[protocol];
      if (!options.includes(resolution)) setResolution(DEFAULT_RESOLUTION[protocol]);
    }
    void rpcClient.saveVideoGenConfig({ backend: key });
  };

  const saveConfig = useMutation({
    mutationFn: () =>
      rpcClient.saveVideoGenConfig({
        backend,
        providerId: providerId.trim(),
        model: cloudModel.trim(),
        comfyBase: comfyBase.trim(),
        comfyCkpt: comfyCkpt.trim(),
        comfyClip: comfyClip.trim(),
        comfyVae: comfyVae.trim(),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["video-gen-config"] });
      queryClient.invalidateQueries({ queryKey: ["cloud-providers"] });
    },
  });

  const configured =
    backend === "comfyui" ? !!comfyBase.trim() : !!providerId.trim() && !!cloudModel.trim();

  const fetchModels = useMutation({
    mutationFn: () => rpcClient.listVideoGenModels({ backend, base: comfyBase.trim() }),
    onSuccess: (r) => {
      if (r.error) {
        setConfigError(r.error);
        return;
      }
      setConfigError(undefined);
      // ComfyUI：未手填的模型名自动挑最像 Wan 的。
      const pick = (list: string[], re: RegExp) => list.find((n) => re.test(n)) ?? list[0] ?? "";
      setComfyCkpt((v) => v.trim() || pick(r.checkpoints, /wan/i));
      setComfyClip((v) => v.trim() || pick(r.clips, /umt5|wan/i));
      setComfyVae((v) => v.trim() || pick(r.vaes, /wan/i));
    },
    onError: (e) => setConfigError(String(e)),
  });

  const { data: modelsData } = useQuery({
    queryKey: ["video-gen-models", backend, comfyBase],
    queryFn: () => rpcClient.listVideoGenModels({ backend, base: comfyBase.trim() }),
    enabled: backend === "comfyui" && !!comfyBase.trim(),
  });
  const comfyCheckpoints = modelsData?.checkpoints ?? [];
  const comfyClips = modelsData?.clips ?? [];
  const comfyVaes = modelsData?.vaes ?? [];

  // ---------- 首帧图（图生视频，仅云端后端） ----------
  const pickFirstFrame = useMutation({
    mutationFn: async () => {
      const { paths } = await rpcClient.openFileDialog({
        allowedFileTypes: "png,jpg,jpeg,webp",
      });
      if (paths.length === 0) return undefined;
      const { files } = await rpcClient.stageEditImage({ paths });
      return files[0];
    },
    onSuccess: (file) => {
      if (file) setFirstFrame(file);
    },
    onError: (e) => setConfigError(String(e)),
  });

  // ---------- 记录与轮询 ----------
  // 轮询本身挂在 VideoScreen 上（见 useVideoRecordsPolling）：切到历史视图时这里会卸载，
  // 在途任务的进度不能跟着停。
  const { data: recordsData } = useQuery({
    queryKey: ["video-records"],
    queryFn: () => rpcClient.listVideoRecords(undefined),
  });
  const records = recordsData?.records ?? [];

  const del = useMutation({
    mutationFn: (id: number) => rpcClient.deleteVideoRecord({ id }),
    onSuccess: (_r, id) => {
      queryClient.invalidateQueries({ queryKey: ["video-records"] });
      if (focusRecordId === id) setFocusRecordId(null);
    },
  });

  // ---------- 生成 ----------
  const generate = useMutation({
    mutationFn: () => {
      const parsedSeed = Number.parseInt(seed, 10);
      const ratio = RATIOS[ratioIdx]!;
      const isCloud = backend !== "comfyui";
      return rpcClient.submitVideoGeneration({
        prompt,
        negativePrompt: backend === "comfyui" ? negative.trim() || undefined : undefined,
        duration,
        ratio,
        resolution: isCloud ? resolution : undefined,
        steps: backend === "comfyui" ? steps : undefined,
        cfg: backend === "comfyui" ? cfg : undefined,
        seed: Number.isFinite(parsedSeed) && parsedSeed > 0 ? parsedSeed : undefined,
        model: isCloud ? cloudModel.trim() || undefined : undefined,
        firstFrameRef: isCloud ? firstFrame?.ref : undefined,
        watermark: isCloud ? watermark : undefined,
        // 页面上的实时配置一并带上，后端优先使用它们并落盘（连接信息来自厂商行）。
        config: {
          backend,
          providerId: providerId.trim(),
          model: cloudModel.trim(),
          comfyBase: comfyBase.trim(),
          comfyCkpt: comfyCkpt.trim(),
          comfyClip: comfyClip.trim(),
          comfyVae: comfyVae.trim(),
        },
      });
    },
    onSuccess: (r) => {
      if (r.error || !r.record) {
        setConfigError(r.error ?? t("video.submitFailed"));
        return;
      }
      setConfigError(undefined);
      setFocusRecordId(r.record.id);
      queryClient.invalidateQueries({ queryKey: ["video-records"] });
    },
    onError: (e) => setConfigError(String(e)),
  });

  const canGenerate = !!prompt.trim() && !generate.isPending && configured;

  const protocolKey = backend === "comfyui" ? "comfyui" : protocol;
  const range = DURATION_RANGE[protocolKey];
  const durationOptions = DURATION_OPTIONS[protocolKey];
  const clampedDuration = snapDuration(protocolKey, duration);
  const ratio = RATIOS[ratioIdx]!;
  const comfySize = COMFY_SIZES[ratio] ?? COMFY_SIZES["16:9"]!;
  // 展示的记录：聚焦的记录，否则最新一条。
  const display = records.find((r) => r.id === focusRecordId) ?? records[0];

  return (
    <div className="flex h-full min-h-0">
      {/* 中间：参数面板 */}
      <aside className="w-[340px] shrink-0 overflow-y-auto border-r p-4">
        <div className="flex flex-col gap-5">
          {/* 后端切换 */}
          <div>
            <Label className="mb-1.5 block text-xs">{t("video.backend")}</Label>
            <SegmentedControl
              variant="attached"
              value={backend}
              onChange={switchBackend}
              options={BACKEND_ITEMS.map((b) => ({ value: b.key, label: t(b.label) }))}
            />
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              {t(
                backend === "comfyui"
                  ? "video.backend.comfyuiDesc"
                  : protocol === "seedance"
                    ? "video.backend.seedanceDesc"
                    : "video.backend.minimaxDesc",
              )}
            </p>
          </div>

          {/* 服务配置 */}
          <div className="flex flex-col gap-2.5 rounded-lg border bg-card p-3">
            {backend === "comfyui" ? (
              <>
                <div>
                  <Label htmlFor="video-comfy-base" className="mb-1 block text-xs">
                    {t("video.config.comfyBase")}
                  </Label>
                  <Input
                    id="video-comfy-base"
                    placeholder="http://127.0.0.1:8188"
                    value={comfyBase}
                    onChange={(e) => setComfyBase(e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
                <div>
                  <Label htmlFor="video-comfy-ckpt" className="mb-1 block text-xs">
                    {t("video.config.checkpoint")}
                  </Label>
                  <Input
                    id="video-comfy-ckpt"
                    list="video-comfy-ckpt-list"
                    placeholder="wan2.1_t2v_1.3b_fp16.safetensors"
                    value={comfyCkpt}
                    onChange={(e) => setComfyCkpt(e.target.value)}
                    className="h-8 text-xs"
                  />
                  {comfyCheckpoints.length > 0 && (
                    <datalist id="video-comfy-ckpt-list">
                      {comfyCheckpoints.map((m) => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label htmlFor="video-comfy-clip" className="mb-1 block text-xs">
                      {t("video.config.clip")}
                    </Label>
                    <Input
                      id="video-comfy-clip"
                      list="video-comfy-clip-list"
                      placeholder="umt5_xxl…"
                      value={comfyClip}
                      onChange={(e) => setComfyClip(e.target.value)}
                      className="h-8 text-xs"
                    />
                    {comfyClips.length > 0 && (
                      <datalist id="video-comfy-clip-list">
                        {comfyClips.map((m) => (
                          <option key={m} value={m} />
                        ))}
                      </datalist>
                    )}
                  </div>
                  <div>
                    <Label htmlFor="video-comfy-vae" className="mb-1 block text-xs">
                      {t("video.config.vae")}
                    </Label>
                    <Input
                      id="video-comfy-vae"
                      list="video-comfy-vae-list"
                      placeholder="wan_2.1_vae.safetensors"
                      value={comfyVae}
                      onChange={(e) => setComfyVae(e.target.value)}
                      className="h-8 text-xs"
                    />
                    {comfyVaes.length > 0 && (
                      <datalist id="video-comfy-vae-list">
                        {comfyVaes.map((m) => (
                          <option key={m} value={m} />
                        ))}
                      </datalist>
                    )}
                  </div>
                </div>
              </>
            ) : (
              // 云端生视频：只选厂商 + 模型。厂商要在设置里选好生视频接口
              // （MiniMax / Seedance），否则这里选不到它。
              <div>
                <Label className="mb-1 block text-xs">{t("video.config.cloudProvider")}</Label>
                <CloudModelSelect
                  kind="video"
                  requireVideoApi
                  providerId={providerId}
                  model={cloudModel}
                  size="sm"
                  onChange={(choice) => {
                    setProviderId(choice.providerId);
                    if (choice.model) setCloudModel(choice.model);
                  }}
                />
                <p className="mt-1.5 text-[10px] text-muted-foreground">{t("cloud.where")}</p>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => saveConfig.mutate()} disabled={saveConfig.isPending}>
                {saveConfig.isPending ? (
                  <Loader2Icon data-icon="inline-start" className="animate-spin" />
                ) : null}
                {t("video.config.save")}
              </Button>
              {/* 云端模型清单来自厂商，不需要在这里扫；ComfyUI 才要探测模型名。 */}
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
                  {t("video.config.fetchModels")}
                </Button>
              )}
              {configured && (
                <Badge variant="secondary" className="gap-1 text-[10px]">
                  <span className="size-2 rounded-full bg-emerald-500" />
                  {t("video.config.configured")}
                </Badge>
              )}
            </div>
            {configError && <ResultError error={configError} />}
          </div>

          {/* 提示词 */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <Label htmlFor="video-prompt" className="text-xs">
                {t("video.prompt")}
              </Label>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground"
                onClick={() => setPrompt("")}
              >
                <EraserIcon className="size-3" />
                {t("video.prompt.clear")}
              </Button>
            </div>
            <Textarea
              id="video-prompt"
              rows={6}
              placeholder={t("video.promptPlaceholder")}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="resize-none text-xs"
            />
          </div>

          {/* 首帧图（图生视频，仅云端后端） */}
          {backend !== "comfyui" &&
            (firstFrame ? (
              <div className="flex items-center gap-3 rounded-lg border bg-card p-2.5">
                <img
                  src={firstFrame.url}
                  alt="first frame"
                  className="size-14 shrink-0 rounded-md border object-cover"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium">{t("video.firstFrame")}</p>
                  <p className="text-[10px] leading-relaxed text-muted-foreground">
                    {t("video.firstFrame.hint")}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  tooltip={t("video.firstFrame.remove")}
                  onClick={() => setFirstFrame(undefined)}
                >
                  <XIcon className="size-3.5" />
                </Button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => pickFirstFrame.mutate()}
                className="flex items-center gap-2 rounded-lg border border-dashed bg-card/50 px-3 py-2.5 text-xs text-muted-foreground transition-colors hover:border-muted-foreground/50 hover:text-foreground"
              >
                {pickFirstFrame.isPending ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <ImagePlusIcon className="size-3.5" />
                )}
                {t("video.firstFrame.choose")}
                <span className="text-[10px]">（{t("video.firstFrame.optional")}）</span>
              </button>
            ))}

          {/* 参数 */}
          <div className="flex flex-col gap-3 rounded-lg border bg-card p-3">
            <p className="text-xs font-medium">{t("video.params")}</p>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <Label className="text-[11px] text-muted-foreground">
                  {t("video.params.duration")}
                </Label>
                <span className="text-[11px] tabular-nums text-foreground">
                  {clampedDuration}s
                </span>
              </div>
              {durationOptions ? (
                <div className="flex flex-wrap gap-1.5">
                  {durationOptions.map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setDuration(d)}
                      className={cn(
                        "rounded-md border px-2.5 py-1 text-[11px] tabular-nums transition-colors",
                        clampedDuration === d
                          ? "border-primary bg-primary/10 text-primary"
                          : "text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
                      )}
                    >
                      {d}s
                    </button>
                  ))}
                </div>
              ) : (
                <input
                  type="range"
                  min={range.min}
                  max={range.max}
                  step={1}
                  value={clampedDuration}
                  onChange={(e) => setDuration(Number(e.target.value))}
                  className="w-full accent-primary"
                />
              )}
              <p className="mt-1 text-[10px] text-muted-foreground tabular-nums">
                {durationOptions
                  ? t("video.params.durationFixed").replace(
                      "{values}",
                      durationOptions.map((d) => `${d}s`).join(" / "),
                    )
                  : t("video.params.durationRange")
                      .replace("{min}", String(range.min))
                      .replace("{max}", String(range.max))}
                {backend === "comfyui" && ` · ${t("video.params.fps16")}`}
              </p>
            </div>

            <div>
              <Label className="mb-1.5 block text-[11px] text-muted-foreground">
                {t("video.params.ratio")}
              </Label>
              <div className="flex flex-wrap gap-1.5">
                {RATIOS.map((r, i) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRatioIdx(i)}
                    className={cn(
                      "rounded-md border px-2 py-1 text-[11px] tabular-nums transition-colors",
                      ratioIdx === i
                        ? "border-primary bg-primary/10 text-primary"
                        : "text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
                    )}
                  >
                    {r}
                  </button>
                ))}
              </div>
              {backend === "comfyui" && (
                <p className="mt-1.5 text-[10px] text-muted-foreground tabular-nums">
                  {comfySize.width}×{comfySize.height}
                </p>
              )}
            </div>

            {backend !== "comfyui" && (
              <div>
                <Label className="mb-1 block text-[11px] text-muted-foreground">
                  {t("video.params.resolution")}
                </Label>
                <Select value={resolution} onValueChange={setResolution}>
                  <SelectTrigger className="h-8 w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RESOLUTIONS[protocol].map((r) => (
                      <SelectItem key={r} value={r} className="text-xs">
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* 高级选项 */}
            <Collapsible>
              <CollapsibleTrigger className="group flex w-full items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground">
                <ChevronDownIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
                {t("video.params.advanced")}
              </CollapsibleTrigger>
              <CollapsibleContent className="flex flex-col gap-3 pt-3">
                {backend === "comfyui" ? (
                  <>
                    <div>
                      <Label htmlFor="video-negative" className="mb-1 block text-[11px] text-muted-foreground">
                        {t("video.params.negative")}
                      </Label>
                      <Textarea
                        id="video-negative"
                        rows={2}
                        placeholder={t("video.params.negativePlaceholder")}
                        value={negative}
                        onChange={(e) => setNegative(e.target.value)}
                        className="resize-none text-xs"
                      />
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <Label htmlFor="video-steps" className="mb-1 block text-[11px] text-muted-foreground">
                          {t("video.params.steps")}
                        </Label>
                        <Input
                          id="video-steps"
                          type="number"
                          min={1}
                          max={100}
                          value={steps}
                          onChange={(e) => setSteps(Math.max(1, Math.min(100, Number(e.target.value) || 20)))}
                          className="h-8 text-xs tabular-nums"
                        />
                      </div>
                      <div>
                        <Label htmlFor="video-cfg" className="mb-1 block text-[11px] text-muted-foreground">
                          {t("video.params.cfg")}
                        </Label>
                        <Input
                          id="video-cfg"
                          type="number"
                          min={1}
                          max={20}
                          step={0.5}
                          value={cfg}
                          onChange={(e) => setCfg(Math.max(1, Math.min(20, Number(e.target.value) || 5)))}
                          className="h-8 text-xs tabular-nums"
                        />
                      </div>
                      <div>
                        <Label htmlFor="video-seed" className="mb-1 block text-[11px] text-muted-foreground">
                          {t("video.params.seed")}
                        </Label>
                        <Input
                          id="video-seed"
                          type="number"
                          min={-1}
                          placeholder="-1"
                          value={seed}
                          onChange={(e) => setSeed(e.target.value)}
                          className="h-8 text-xs tabular-nums"
                        />
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor="video-watermark" className="text-[11px] text-muted-foreground">
                        {t("video.params.watermark")}
                      </Label>
                      <Switch
                        id="video-watermark"
                        checked={watermark}
                        onCheckedChange={setWatermark}
                      />
                    </div>
                    {protocol === "seedance" && (
                      <div>
                        <Label htmlFor="video-seed" className="mb-1 block text-[11px] text-muted-foreground">
                          {t("video.params.seed")}
                        </Label>
                        <Input
                          id="video-seed"
                          type="number"
                          min={-1}
                          placeholder="-1"
                          value={seed}
                          onChange={(e) => setSeed(e.target.value)}
                          className="h-8 text-xs tabular-nums"
                        />
                      </div>
                    )}
                  </div>
                )}
              </CollapsibleContent>
            </Collapsible>
          </div>

          <Button size="lg" onClick={() => generate.mutate()} disabled={!canGenerate} className="w-full">
            {generate.isPending ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <SparklesIcon data-icon="inline-start" />
            )}
            {generate.isPending ? t("video.submitting") : t("video.generate")}
          </Button>
          {backend === "comfyui" && !configured && (
            <p className="text-center text-[10px] text-amber-600/80 dark:text-amber-400/80">
              {t("video.comfyNeedBase")}
            </p>
          )}
        </div>
      </aside>

      {/* 右侧：结果区 */}
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {focusRecordId != null && display && (
          <Button
            variant="ghost"
            size="sm"
            className="absolute right-5 top-5 z-20 h-7 gap-1 text-[11px] text-muted-foreground"
            onClick={() => setFocusRecordId(null)}
          >
            <XIcon className="size-3.5" />
            {t("common.cancel")}
          </Button>
        )}

        <div className="flex min-h-0 flex-1 items-center justify-center p-8">
          {!display ? (
            <div className="flex flex-col items-center justify-center gap-3 text-center">
              <div className="flex size-20 items-center justify-center rounded-2xl bg-primary/15">
                <ClapperboardIcon className="size-9 text-primary" />
              </div>
              <p className="text-lg font-medium">{t("video.result.empty")}</p>
              <p className="max-w-xs text-sm text-muted-foreground">
                {t("video.result.emptyHint")}
              </p>
            </div>
          ) : display.status === "processing" ? (
            <VideoTaskCard record={display} onDelete={(id) => del.mutate(id)} />
          ) : display.status === "failed" ? (
            <VideoFailedCard record={display} onDelete={(id) => del.mutate(id)} />
          ) : (
            <VideoPlayerCard record={display} onDelete={(id) => del.mutate(id)} />
          )}
        </div>

        {/* 底部：最近成功生成的视频 + 更多（全部历史） */}
        <RecentStrip records={records} onOpenHistory={() => setView("history")} />
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

