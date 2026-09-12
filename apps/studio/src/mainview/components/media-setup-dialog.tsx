import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2Icon,
  DownloadIcon,
  Loader2Icon,
  RefreshCwIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { useT } from "@stores/ui-lang";
import { useMediaSetupStore } from "@stores/media-setup";
import { useMlxInstallStore } from "@stores/mlx-install";
import { useMlxModelDownloadStore } from "@stores/mlx-model-download";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ui/dialog";
import { ScrollArea } from "@ui/scroll-area";
import { cn } from "@/mainview/lib/utils";
import type { ImageGenBackend } from "../../bun/image-gen";
import type { MediaSetupCandidate } from "../../bun/media-setup";

/**
 * Agent 生图前的「需要用户介入」弹窗。
 *
 * Agent 调 generate_image 时，如果生图后端没配好、本地模型没下载、或者有多个模型可选，
 * 主进程会把问题推到这里：用户填地址 / 点扫描 / 下载模型，点「确认并继续生图」后
 * 选择回传主进程，那次工具调用接着往下跑（不会丢掉 Agent 的上下文）。
 */
export function MediaSetupDialog() {
  const t = useT();
  const request = useMediaSetupStore((s) => s.request);
  const setRequest = useMediaSetupStore((s) => s.setRequest);
  const queryClient = useQueryClient();

  const [backend, setBackend] = useState<ImageGenBackend>("api");
  const [apiBase, setApiBase] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [comfyBase, setComfyBase] = useState("");
  const [model, setModel] = useState("");
  const [candidates, setCandidates] = useState<MediaSetupCandidate[]>([]);
  const [scanError, setScanError] = useState<string>();
  const [scanned, setScanned] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const scan = useMutation({
    mutationFn: (input: { backend: ImageGenBackend; base: string; apiKey: string }) =>
      rpcClient.scanMediaSetupCandidates({
        kind: "image",
        backend: input.backend,
        base: input.base.trim(),
        apiKey: input.apiKey.trim(),
      }),
    onSuccess: (res) => {
      setScanned(true);
      setCandidates(res.candidates ?? []);
      setScanError(res.error);
      // 扫到模型而用户还没选：默认选中第一个可用的，少一次点击。
      if (!model && res.candidates?.length) {
        const first = res.candidates.find((c) => c.ready !== false) ?? res.candidates[0];
        if (first) setModel(first.id);
      }
    },
    onError: (e) => {
      setScanned(true);
      setScanError(String(e));
    },
  });

  const scanFor = (next: { backend?: ImageGenBackend; base?: string; key?: string }) => {
    const b = next.backend ?? backend;
    scan.mutate({
      backend: b,
      base: next.base ?? (b === "comfyui" ? comfyBase : apiBase),
      apiKey: next.key ?? apiKey,
    });
  };

  // 每次新请求进来：按主进程给的现状重置表单，并自动扫一次候选。
  useEffect(() => {
    if (!request) return;
    const cfg = request.config;
    setBackend(request.backend);
    setApiBase(cfg.apiBase);
    setApiKey(cfg.apiKey);
    setComfyBase(cfg.comfyBase);
    setModel(cfg.model);
    setCandidates(request.candidates);
    setScanned(request.candidates.length > 0);
    setScanError(undefined);
    setSubmitting(false);
    if (request.candidates.length === 0) {
      scan.mutate({
        backend: request.backend,
        base: request.backend === "comfyui" ? cfg.comfyBase : cfg.apiBase,
        apiKey: cfg.apiKey,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.id]);

  // MLX 就绪状态：装引擎 / 下模型的进度直接复用图像页那套 query key 与 store。
  const { data: mlxStatus, refetch: refetchMlxStatus } = useQuery({
    queryKey: ["mlx-gen-status"],
    queryFn: () => rpcClient.getMlxGenStatus(),
    enabled: !!request && backend === "mlx",
    refetchInterval: (q) => (q.state.data?.engineInstalled ? false : 3000),
  });
  const { data: mlxDownloadedData, refetch: refetchDownloaded } = useQuery({
    queryKey: ["mlx-downloaded-models"],
    queryFn: () => rpcClient.getDownloadedMlxModels(),
    enabled: !!request && backend === "mlx",
    refetchInterval: () => (useMlxModelDownloadStore.getState().progress?.stage === "downloading" ? 2000 : false),
  });
  const downloaded = useMemo(() => new Set(mlxDownloadedData?.downloaded ?? []), [mlxDownloadedData]);
  const installLogs = useMlxInstallStore((s) => s.logs);
  const downloadProgress = useMlxModelDownloadStore((s) => s.progress);

  const installEngine = useMutation({
    mutationFn: () => rpcClient.downloadMlxGenEngine(),
    onSuccess: (r) => {
      if (r.ok) void refetchMlxStatus();
    },
  });
  const downloadModel = useMutation({
    mutationFn: (modelId: string) => rpcClient.downloadMlxModel({ modelId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mlx-downloaded-models"] });
      void refetchDownloaded();
    },
  });

  if (!request) return null;

  const readyById = new Map(candidates.map((c) => [c.id, c.ready !== false]));
  const selectedReady = !model || readyById.get(model) !== false;
  const needsDownload = backend === "mlx" && !!model && !downloaded.has(model);
  const engineMissing = backend === "mlx" && mlxStatus && !mlxStatus.engineInstalled;

  const cancel = async () => {
    await rpcClient.resolveMediaSetup({ id: request.id, action: "cancel" });
    setRequest(null);
  };

  const confirm = async () => {
    setSubmitting(true);
    await rpcClient.resolveMediaSetup({
      id: request.id,
      action: "confirm",
      backend,
      model: model.trim() || undefined,
      apiBase: apiBase.trim(),
      apiKey: apiKey.trim(),
      comfyBase: comfyBase.trim(),
    });
    setRequest(null);
  };

  const titleKey =
    request.reason === "choose-model"
      ? "media.setup.image.title.choose-model"
      : request.reason === "missing-assets"
        ? "media.setup.image.title.missing-assets"
        : "media.setup.image.title.missing-config";

  const lastLog = installLogs.length > 0 ? installLogs[installLogs.length - 1] : null;

  return (
    <Dialog
      open={!!request}
      onOpenChange={(open) => {
        if (!open) void cancel();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SparklesIcon className="size-4 text-primary" />
            {t(titleKey)}
          </DialogTitle>
          <DialogDescription>{request.message}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {/* 后端切换：每个后端带"是否就绪"的状态点 */}
          <div className="flex flex-wrap gap-1.5">
            {request.backends.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={backend === option.id}
                title={option.note}
                onClick={() => {
                  setBackend(option.id);
                  setCandidates([]);
                  setScanned(false);
                  setScanError(undefined);
                  if (option.id !== "mlx") {
                    scanFor({
                      backend: option.id,
                      base: option.id === "comfyui" ? comfyBase : apiBase,
                    });
                  }
                }}
                className={cn(
                  "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                  backend === option.id
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
                )}
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    option.ready ? "bg-emerald-500" : "bg-muted-foreground/40",
                  )}
                />
                {t(option.labelKey)}
              </button>
            ))}
          </div>

          {backend !== "mlx" ? (
            <>
              <div>
                <Label htmlFor="setup-base" className="mb-1 block text-xs">
                  {backend === "comfyui" ? t("image.config.comfyBase") : t("image.config.base")}
                </Label>
                <Input
                  id="setup-base"
                  value={backend === "comfyui" ? comfyBase : apiBase}
                  placeholder={backend === "comfyui" ? "http://127.0.0.1:8188" : "https://api.siliconflow.cn/v1"}
                  onChange={(e) =>
                    backend === "comfyui" ? setComfyBase(e.target.value) : setApiBase(e.target.value)
                  }
                  className="h-8 text-xs"
                />
              </div>
              {backend === "api" && (
                <div>
                  <Label htmlFor="setup-key" className="mb-1 block text-xs">
                    {t("image.config.apiKey")}
                  </Label>
                  <Input
                    id="setup-key"
                    type="password"
                    value={apiKey}
                    placeholder="sk-…"
                    onChange={(e) => setApiKey(e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
              )}
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={scan.isPending}
                  onClick={() => scanFor({})}
                >
                  {scan.isPending ? (
                    <Loader2Icon data-icon="inline-start" className="animate-spin" />
                  ) : (
                    <RefreshCwIcon data-icon="inline-start" />
                  )}
                  {scan.isPending ? t("media.setup.scanning") : t("media.setup.scan")}
                </Button>
                {scanned && candidates.length > 0 && (
                  <span className="text-[11px] text-muted-foreground">
                    {t("media.setup.scanCount", { count: String(candidates.length) })}
                  </span>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-2 rounded-lg border p-2.5">
              <div className="flex items-center gap-2 text-[11px]">
                {mlxStatus?.engineInstalled ? (
                  <CheckCircle2Icon className="size-3.5 text-emerald-500" />
                ) : (
                  <TriangleAlertIcon className="size-3.5 text-amber-500" />
                )}
                <span className="flex-1">
                  {mlxStatus?.engineInstalled
                    ? t("media.setup.engineInstalled")
                    : t("media.setup.engineMissing")}
                </span>
                {!mlxStatus?.engineInstalled && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={installEngine.isPending}
                    onClick={() => installEngine.mutate()}
                  >
                    {installEngine.isPending ? (
                      <Loader2Icon data-icon="inline-start" className="animate-spin" />
                    ) : (
                      <DownloadIcon data-icon="inline-start" />
                    )}
                    {t("media.setup.installEngine")}
                  </Button>
                )}
              </div>
              {lastLog && !mlxStatus?.engineInstalled && (
                <p className="line-clamp-2 font-mono text-[10px] text-muted-foreground">{lastLog}</p>
              )}
            </div>
          )}

          {/* 候选模型列表：扫描结果 / MLX 模型目录（带下载状态与下载按钮） */}
          {(candidates.length > 0 || scanError || scanned) && (
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">{t("media.setup.model")}</Label>
              {scanError && (
                <p className="text-[11px] text-destructive">
                  {t("media.setup.scanEmpty")}
                  {` (${scanError})`}
                </p>
              )}
              {scanned && !scanError && candidates.length === 0 && (
                <p className="text-[11px] text-muted-foreground">{t("media.setup.scanEmpty")}</p>
              )}
              {candidates.length > 0 && (
                // 高度必须给到滚动区自己（确定高度）：只给 max-h 的话 Radix 视口
                // 会被内容撑开、列表被裁掉且拉不动（见 download-panel 的同款说明）。
                <ScrollArea className="h-44">
                  <div className="flex flex-col gap-1 pr-2">
                    {candidates.map((candidate) => {
                      const isReady = candidate.ready !== false;
                      const isDownloaded = backend !== "mlx" || downloaded.has(candidate.id);
                      const downloading =
                        downloadProgress?.modelId === candidate.id &&
                        downloadProgress.stage === "downloading";
                      return (
                        <div
                          key={candidate.id}
                          className={cn(
                            "flex items-center gap-2 rounded-md border px-2 py-1.5",
                            model === candidate.id
                              ? "border-primary bg-primary/5"
                              : "border-border hover:bg-muted/50",
                          )}
                        >
                          <button
                            type="button"
                            aria-pressed={model === candidate.id}
                            onClick={() => {
                              // 来自「云端模型」的候选自带服务商地址与 Key：选中就切到
                              // 云端生图并按这份配置确认，不必让用户再手填一遍。
                              if (candidate.apiBase) {
                                setBackend("api");
                                setApiBase(candidate.apiBase);
                                if (candidate.apiKey !== undefined) setApiKey(candidate.apiKey);
                              }
                              setModel(candidate.id);
                            }}
                            className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
                          >
                            <span className="truncate text-xs font-medium">{candidate.label}</span>
                            {candidate.note && (
                              <span className="line-clamp-1 text-[10px] text-muted-foreground">
                                {candidate.note}
                              </span>
                            )}
                          </button>
                          {backend === "mlx" && (
                            <span className="shrink-0 text-[10px] text-muted-foreground">
                              {isDownloaded
                                ? t("media.setup.downloaded")
                                : downloading
                                  ? `${Math.round(downloadProgress.percent)}%`
                                  : t("media.setup.notDownloaded")}
                            </span>
                          )}
                          {backend === "mlx" && !isDownloaded && !downloading && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={downloadModel.isPending}
                              onClick={() => downloadModel.mutate(candidate.id)}
                            >
                              <DownloadIcon data-icon="inline-start" />
                              {t("media.setup.download")}
                            </Button>
                          )}
                          {backend !== "mlx" && isReady && (
                            <CheckCircle2Icon className="size-3.5 shrink-0 text-muted-foreground/50" />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </ScrollArea>
              )}
            </div>
          )}

          <p className="text-[11px] text-muted-foreground">{t("media.setup.waiting")}</p>
          {needsDownload && (
            <p className="text-[11px] text-amber-600">{t("media.setup.downloadFirst")}</p>
          )}
          {engineMissing && (
            <p className="text-[11px] text-amber-600">{t("media.setup.engineFirst")}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => void cancel()}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" disabled={submitting || !selectedReady} onClick={() => void confirm()}>
            {t("media.setup.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
