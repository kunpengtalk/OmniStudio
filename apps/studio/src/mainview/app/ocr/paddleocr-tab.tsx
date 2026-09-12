import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpIcon,
  BotIcon,
  DownloadCloudIcon,
  Loader2Icon,
  PlayIcon,
  RotateCcwIcon,
  ScanTextIcon,
  SquareIcon,
  TrashIcon,
  XIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Badge } from "@ui/badge";
import { Button } from "@ui/button";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import { usePpOcrInstallStore } from "../../stores/ppocr-install";
import { usePpOcrDownloadStore } from "../../stores/ppocr-download";
import type { PpOcrModelSize } from "../../../shared/ocr";
import type { PpOcrModelState, PpOcrStatus } from "../../../bun/ppocr";
import {
  CopyButton,
  EmptyResult,
  ErrorNote,
  ImagePicker,
  ImagePreview,
  PanelSection,
  ResultHeader,
  ResultText,
  StatusCard,
  Workbench,
  formatBytes,
  type StagedImage,
} from "./parts";

/** 阶段 → i18n 键（状态卡实时展示下载/加载/识别进度）。 */
const PHASE_KEYS: Record<string, string> = {
  idle: "ocr.paddleocr.idle",
  starting: "ocr.paddleocr.starting",
  downloading: "ocr.paddleocr.phase.downloading",
  loading: "ocr.paddleocr.phase.loading",
  ready: "ocr.paddleocr.phase.ready",
  recognizing: "ocr.paddleocr.phase.recognizing",
  error: "ocr.paddleocr.phase.error",
};

type PpOcrResult = {
  text: string;
  modelLabel: string;
  lines: { conf: number; text: string }[];
};

const SIZES = ["medium"] as const;

function modelName(size: PpOcrModelSize, kind: "det" | "rec"): string {
  return `PP-OCRv6_${size}_${kind}`;
}

/** 模型档位卡片：状态徽章 + 进度条/字节 + 下载/继续/重新下载/取消。 */
function ModelCard({
  size,
  state,
  selected,
  busy,
  onSelect,
  onDownload,
  onCancel,
  onClear,
  onDeleteModel,
}: {
  size: PpOcrModelSize;
  state: PpOcrModelState["models"];
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onDownload: () => void;
  onCancel: () => void;
  onClear: () => void;
  onDeleteModel: () => void;
}) {
  const t = useT();
  const progress = usePpOcrDownloadStore((s) => s.progress);
  const downloading = usePpOcrDownloadStore((s) => s.downloading);
  const [showDetails, setShowDetails] = useState(false);

  const det = state.det;
  const rec = state.rec;
  const detProg = progress[modelName(size, "det")];
  const recProg = progress[modelName(size, "rec")];
  const detDone = det.ready ? det.totalBytes : (detProg?.received ?? det.partialBytes);
  const recDone = rec.ready ? rec.totalBytes : (recProg?.received ?? rec.partialBytes);
  const total = det.totalBytes + rec.totalBytes;
  const done = Math.min(detDone, det.totalBytes) + Math.min(recDone, rec.totalBytes);
  const percent = total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 0;

  const isActive =
    downloading[modelName(size, "det")] || downloading[modelName(size, "rec")];
  const ready = det.ready && rec.ready;
  const partial = !ready && done > 0;
  const speed = Math.max(detProg?.speed ?? 0, recProg?.speed ?? 0);

  let badge: { label: string; tone: "ok" | "warn" | "neutral" | "active" };
  if (ready) badge = { label: t("ocr.paddleocr.modelState.ready"), tone: "ok" };
  else if (isActive) badge = { label: t("ocr.paddleocr.modelState.downloading"), tone: "active" };
  else if (partial) badge = { label: t("ocr.paddleocr.modelState.partial"), tone: "warn" };
  else badge = { label: t("ocr.paddleocr.modelState.none"), tone: "neutral" };

  return (
    <div
      onClick={onSelect}
      className={cn(
        "flex cursor-pointer flex-col gap-2 rounded-xl border bg-card p-3 transition-colors",
        selected
          ? "border-primary/60 bg-primary/5"
          : "hover:border-muted-foreground/40 hover:bg-muted/30",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-xs font-medium">
          {t(`ocr.paddleocr.size.${size}`)}
        </span>
        <Badge
          variant={badge.tone === "ok" ? "default" : badge.tone === "active" ? "default" : "secondary"}
          className={cn(
            "h-4 shrink-0 px-1.5 text-[9px]",
            badge.tone === "ok" && "bg-emerald-500/15 text-emerald-600",
            badge.tone === "active" && "bg-primary/15 text-primary",
            badge.tone === "warn" && "bg-amber-500/15 text-amber-600",
          )}
        >
          {badge.label}
          {isActive ? ` ${percent}%` : partial ? ` ${percent}%` : ""}
        </Badge>
        {selected ? (
          <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px]">
            {t("ocr.paddleocr.selected")}
          </Badge>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <span>
          {t("ocr.paddleocr.detRec")} · {formatBytes(total)}
        </span>
        {!ready && done > 0 ? (
          <span className="font-mono tabular-nums">
            {formatBytes(done)} / {formatBytes(total)}
            {isActive && speed > 0 ? ` · ${formatBytes(speed)}/s` : ""}
          </span>
        ) : null}
      </div>

      {/* 进度条：下载中或部分下载时展示 */}
      {!ready && done > 0 ? (
        <div className="flex flex-col gap-1">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full transition-[width] duration-200",
                isActive ? "bg-primary" : "bg-amber-500",
              )}
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      ) : null}

      {!ready ? (
        <div className="flex items-center gap-1">
          {isActive ? (
            <Button size="xs" variant="outline" className="flex-1" disabled={busy} onClick={(e) => { e.stopPropagation(); onCancel(); }}>
              <XIcon data-icon="inline-start" />
              {t("ocr.paddleocr.cancel")}
            </Button>
          ) : (
            <>
              <Button size="xs" variant="default" className="flex-1" disabled={busy} onClick={(e) => { e.stopPropagation(); onDownload(); }}>
                <DownloadCloudIcon data-icon="inline-start" />
                {partial ? t("ocr.paddleocr.continue") : t("ocr.paddleocr.download")}
              </Button>
              {partial ? (
                <Button size="icon-xs" variant="ghost" tooltip={t("ocr.paddleocr.again")} disabled={busy} onClick={(e) => { e.stopPropagation(); onClear(); }}>
                  <RotateCcwIcon />
                </Button>
              ) : null}
            </>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <DownloadCloudIcon className="size-3.5 shrink-0 text-emerald-600" />
          <span className="text-[10px] text-muted-foreground">{t("ocr.paddleocr.readyHint")}</span>
          <span className="ml-auto flex items-center gap-0.5">
            <Button
              size="icon-xs"
              variant="ghost"
              tooltip={t("ocr.paddleocr.deleteModelHint")}
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                onDeleteModel();
              }}
            >
              <TrashIcon />
            </Button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setShowDetails((s) => !s);
              }}
              className="text-[10px] text-muted-foreground hover:text-foreground"
            >
              {showDetails ? "▾" : "▸"}
            </button>
          </span>
        </div>
      )}

      {ready && showDetails ? (
        <div className="flex flex-col gap-1 border-t border-border/50 pt-2 text-[10px] text-muted-foreground">
          <div className="flex justify-between">
            <span>{modelName(size, "det")}</span>
            <span className="font-mono">{formatBytes(det.totalBytes)}</span>
          </div>
          <div className="flex justify-between">
            <span>{modelName(size, "rec")}</span>
            <span className="font-mono">{formatBytes(rec.totalBytes)}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function PaddleOcrTab({
  image,
  onImageChange,
  engineSwitcher,
}: {
  image: StagedImage | null;
  onImageChange: (img: StagedImage | null) => void;
  engineSwitcher?: React.ReactNode;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const { logs, clearLogs } = usePpOcrInstallStore();

  const [modelSize, setModelSize] = useState<PpOcrModelSize>("medium");
  const [result, setResult] = useState<PpOcrResult | null>(null);
  const [error, setError] = useState<string>();
  const [showLogs, setShowLogs] = useState(false);

  const { data: statusData } = useQuery({
    queryKey: ["ppocr-status"],
    queryFn: () => rpcClient.getPpOcrStatus(),
    refetchInterval: 2500,
  });
  const status = statusData as PpOcrStatus | undefined;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["ppocr-status"] });
  };

  const install = useMutation({
    mutationFn: () => rpcClient.downloadPpOcrEngine(),
    onSuccess: (r) => {
      if (!r.ok) setError(r.error ?? t("ocr.paddleocr.needInstall"));
      else setError(undefined);
      refresh();
    },
    onError: (e) => setError(String(e)),
  });

  const start = useMutation({
    mutationFn: () => rpcClient.startPpOcr({ modelSize }),
    onSuccess: (r) => {
      if (!r.ok) setError(r.error ?? t("ocr.paddleocr.needStart"));
      else setError(undefined);
      refresh();
    },
    onError: (e) => setError(String(e)),
  });

  const stop = useMutation({
    mutationFn: () => rpcClient.stopPpOcr(),
    onSuccess: () => {
      setError(undefined);
      refresh();
    },
    onError: (e) => setError(String(e)),
  });

  const pickSize = (v: PpOcrModelSize) => {
    setModelSize(v);
    setError(undefined);
    void rpcClient.updateSettings({ settings: { PPOCR_MODEL_SIZE: v } });
  };

  // 模型下载 / 取消 / 清空（fire-and-forget：进度由 ppOcrModelProgress 事件驱动）。
  const downloadModel = useMutation({
    mutationFn: (v: PpOcrModelSize) => rpcClient.downloadPpOcrModels({ modelSize: v }),
    onSettled: () => refresh(),
  });
  const cancelModel = useMutation({
    mutationFn: (v: PpOcrModelSize) => rpcClient.cancelPpOcrModelDownload({ modelSize: v }),
    onSettled: () => refresh(),
  });
  const clearModel = useMutation({
    mutationFn: (v: PpOcrModelSize) => rpcClient.deletePpOcrPartialModels({ modelSize: v }),
    onSettled: () => refresh(),
  });
  // 清理引擎（删 venv 保模型）与删除整个档位模型。
  const cleanupEngine = useMutation({
    mutationFn: () => rpcClient.cleanupPpOcrEngine(),
    onSuccess: (r) => {
      if (!r.ok) setError(r.error ?? t("ocr.paddleocr.cleanupEngine"));
      else setError(undefined);
      refresh();
    },
    onError: (e) => setError(String(e)),
  });
  const deleteModel = useMutation({
    mutationFn: (v: PpOcrModelSize) => rpcClient.deletePpOcrModels({ modelSize: v }),
    onSettled: () => refresh(),
  });

  const run = useMutation({
    mutationFn: () =>
      rpcClient.runPpOcr({
        imageRef: image!.ref,
        modelSize,
      }),
    onSuccess: (r) => {
      if (r.error || !r.result) {
        setError(r.error ?? t("ocr.empty"));
        setResult(null);
        return;
      }
      setError(undefined);
      setResult(r.result);
      refresh();
      // 识别记录已入库（saveOcrRecord），刷新侧边栏「OCR 记录」列表。
      void queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
    onError: (e) => setError(String(e)),
  });

  const engineReady = !!status?.engineInstalled;
  const workerRunning = !!status?.workerRunning;
  const sameSizeRunning = workerRunning && status?.modelSize === modelSize;
  const installing = install.isPending;

  const blocked = !image
    ? t("ocr.error.empty")
    : !status?.pythonFound
      ? t("ocr.paddleocr.noPython")
      : !engineReady
        ? t("ocr.paddleocr.needInstall")
        : undefined;

  const phaseKey = status ? PHASE_KEYS[status.phase] ?? "ocr.paddleocr.idle" : undefined;
  const modelState = status?.models?.find((m) => m.size === modelSize);
  const selectedReady = !!modelState && modelState.models.det.ready && modelState.models.rec.ready;

  const panel = (
    <>
      {engineSwitcher}
      <PanelSection title={t("ocr.engine.paddleocr")} hint={t("ocr.paddleocr.desc")}>
        <StatusCard
          icon={<BotIcon className="size-4" />}
          tone={engineReady && workerRunning ? "ok" : engineReady ? "neutral" : "warn"}
          title={
            engineReady
              ? workerRunning
                ? t("ocr.paddleocr.engineReady")
                : t("ocr.paddleocr.installed")
              : t("ocr.paddleocr.engineNone")
          }
          detail={
            <div className="flex flex-col gap-0.5">
              {status?.version ? <span>paddleocr v{status.version}</span> : null}
              {phaseKey ? (
                <span>
                  {t(phaseKey)}
                  {status?.phase === "downloading" && status.phaseMessage
                    ? ` · ${status.phaseMessage}`
                    : ""}
                </span>
              ) : null}
              {status?.phase === "error" && status.phaseMessage ? (
                <span className="text-destructive">{status.phaseMessage}</span>
              ) : null}
              {status?.installInterrupted && !installing ? (
                <span className="text-amber-600">{t("ocr.paddleocr.installInterrupted")}</span>
              ) : null}
            </div>
          }
          action={
            engineReady ? null : (
              <>
                <Button
                  size="xs"
                  variant="outline"
                  className="shrink-0 whitespace-nowrap"
                  disabled={installing}
                  onClick={() => install.mutate()}
                >
                  {installing ? (
                    <Loader2Icon data-icon="inline-start" className="animate-spin" />
                  ) : (
                    <DownloadCloudIcon data-icon="inline-start" />
                  )}
                  {installing ? t("ocr.paddleocr.installing") : t("ocr.paddleocr.install")}
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="shrink-0"
                  tooltip={t("ocr.paddleocr.cleanupHint")}
                  disabled={installing || cleanupEngine.isPending}
                  onClick={() => cleanupEngine.mutate()}
                >
                  {cleanupEngine.isPending ? (
                    <Loader2Icon className="animate-spin" />
                  ) : (
                    <RotateCcwIcon />
                  )}
                </Button>
              </>
            )
          }
        />
      </PanelSection>

      {engineReady ? (
        <PanelSection title={t("ocr.paddleocr.runtime")} hint={t("ocr.paddleocr.startHint")}>
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant={workerRunning ? "outline" : "default"}
              className="flex-1"
              disabled={!!sameSizeRunning || start.isPending}
              onClick={() => {
                if (workerRunning) stop.mutate();
                else start.mutate();
              }}
            >
              {workerRunning ? (
                <SquareIcon data-icon="inline-start" />
              ) : start.isPending ? (
                <Loader2Icon data-icon="inline-start" className="animate-spin" />
              ) : (
                <PlayIcon data-icon="inline-start" />
              )}
              {workerRunning
                ? t("ocr.paddleocr.stop")
                : start.isPending
                  ? t("ocr.paddleocr.starting")
                  : t("ocr.paddleocr.start")}
            </Button>
            <Badge variant={workerRunning ? "default" : "secondary"} className="h-5 text-[10px]">
              {workerRunning
                ? `${t("ocr.paddleocr.running")} · PP-OCRv6 ${status?.modelSize ?? modelSize}`
                : t("ocr.paddleocr.idle")}
            </Badge>
          </div>
          {modelSize !== status?.modelSize && status?.workerRunning ? (
            <p className="text-[11px] text-amber-600">{t("ocr.paddleocr.modelChangeHint")}</p>
          ) : null}
        </PanelSection>
      ) : null}

      <PanelSection
        title={t("ocr.paddleocr.models")}
        hint={t("ocr.paddleocr.modelsHint")}
      >
        <div className="flex flex-col gap-2">
          {SIZES.map((size) => {
            const st = status?.models?.find((m) => m.size === size);
            if (!st) return null;
            return (
              <ModelCard
                key={size}
                size={size}
                state={st.models}
                selected={modelSize === size}
                busy={
                  downloadModel.isPending ||
                  cancelModel.isPending ||
                  clearModel.isPending ||
                  deleteModel.isPending
                }
                onSelect={() => pickSize(size)}
                onDownload={() => downloadModel.mutate(size)}
                onCancel={() => cancelModel.mutate(size)}
                onClear={() => clearModel.mutate(size)}
                onDeleteModel={() => deleteModel.mutate(size)}
              />
            );
          })}
        </div>
      </PanelSection>

      <PanelSection
        title={t("ocr.paddleocr.installLog")}
        action={
          logs.length > 0 ? (
            <Button size="icon-xs" variant="ghost" title={t("ocr.paddleocr.clearLog")} onClick={clearLogs}>
              <TrashIcon />
            </Button>
          ) : undefined
        }
      >
        {logs.length === 0 ? (
          <p className="py-3 text-center text-[11px] text-muted-foreground">
            {t("ocr.paddleocr.noLogs")}
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border bg-background">
            <button
              type="button"
              onClick={() => setShowLogs((s) => !s)}
              className="w-full px-2.5 py-1.5 text-left text-[11px] font-medium text-muted-foreground hover:text-foreground"
            >
              {showLogs ? "▾" : "▸"} {t("ocr.paddleocr.installLog")}（{logs.length}）
            </button>
            {showLogs ? (
              <pre className="max-h-40 overflow-y-auto border-t px-2.5 py-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap break-words select-text">
                {logs.join("\n")}
              </pre>
            ) : null}
          </div>
        )}
      </PanelSection>

      <PanelSection title={t("ocr.image.label")}>
        <ImagePicker
          image={image}
          onPick={(f) => {
            setResult(null);
            setError(undefined);
            onImageChange(f);
          }}
          onClear={() => {
            setResult(null);
            onImageChange(null);
          }}
        />
      </PanelSection>

      <ErrorNote error={error} />
    </>
  );

  const footer = (
    <div className="flex flex-col gap-1.5">
      <Button
        size="lg"
        className="w-full"
        disabled={!!blocked || run.isPending}
        onClick={() => run.mutate()}
      >
        {run.isPending ? (
          <Loader2Icon data-icon="inline-start" className="animate-spin" />
        ) : (
          <ArrowUpIcon data-icon="inline-start" />
        )}
        {run.isPending ? t("ocr.running") : t("ocr.run")}
      </Button>
      {blocked ? <p className="text-center text-[11px] text-amber-600">{blocked}</p> : null}
      {!engineReady || (!selectedReady && !blocked) ? (
        <p className="text-center text-[11px] text-muted-foreground">
          {!engineReady ? t("ocr.paddleocr.autoInstallHint") : t("ocr.paddleocr.autoStartHint")}
        </p>
      ) : null}
    </div>
  );

  const resultHeader = (
    <ResultHeader
      meta={
        result
          ? `${result.modelLabel} · ${result.lines.length} ${t("ocr.lines")}`
          : undefined
      }
    >
      {result ? <CopyButton text={result.text} /> : null}
    </ResultHeader>
  );

  const resultBody = !result ? (
    <EmptyResult
      icon={<ScanTextIcon className="size-7 text-muted-foreground" />}
      hint={t("ocr.noResult")}
    />
  ) : (
    <div className="flex flex-col gap-3 p-4">
      {image ? <ImagePreview image={image} /> : null}
      <ResultText text={result.text || t("ocr.empty")} />
      {result.lines.length > 0 ? (
        <div className="overflow-hidden rounded-xl border bg-card">
          {result.lines.map((l, i) => (
            <div
              key={i}
              className="flex items-start gap-2 border-b border-border/50 px-3 py-1.5 last:border-0"
            >
              <span className="mt-px w-5 shrink-0 text-right font-mono text-[10px] text-muted-foreground/60 tabular-nums">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1 break-words text-[11px] leading-snug">{l.text}</span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60 tabular-nums">
                {Math.round(l.conf)}%
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );

  return <Workbench panel={panel} footer={footer} resultHeader={resultHeader} result={resultBody} />;
}
