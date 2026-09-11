import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpIcon,
  BotIcon,
  DownloadCloudIcon,
  Loader2Icon,
  PlayIcon,
  ScanTextIcon,
  SquareIcon,
  TrashIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Badge } from "@ui/badge";
import { Button } from "@ui/button";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import { usePpOcrInstallStore } from "../../stores/ppocr-install";
import { PPOCR_MODEL_OPTIONS, type PpOcrModelSize } from "../../../shared/ocr";
import type { PpOcrStatus } from "../../../bun/ppocr";
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
  modelCode: string;
  lines: { conf: number; text: string }[];
};

export function PaddleOcrTab({
  image,
  onImageChange,
}: {
  image: StagedImage | null;
  onImageChange: (img: StagedImage | null) => void;
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

  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });

  // 恢复保存的模型档位。
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current || !settingsData?.settings) return;
    hydrated.current = true;
    const saved = settingsData.settings.PPOCR_MODEL_SIZE;
    if (saved === "tiny" || saved === "small" || saved === "medium") setModelSize(saved);
  }, [settingsData]);

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
  const sizeOption = PPOCR_MODEL_OPTIONS.find((o) => o.value === modelSize);

  const panel = (
    <>
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
            </div>
          }
          action={
            engineReady ? null : (
              <Button size="xs" variant="outline" disabled={installing} onClick={() => install.mutate()}>
                {installing ? (
                  <Loader2Icon data-icon="inline-start" className="animate-spin" />
                ) : (
                  <DownloadCloudIcon data-icon="inline-start" />
                )}
                {installing ? t("ocr.paddleocr.installing") : t("ocr.paddleocr.install")}
              </Button>
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
        </PanelSection>
      ) : null}

      <PanelSection
        title={t("ocr.paddleocr.size")}
        hint={t("ocr.paddleocr.sizeHint")}
        action={
          sizeOption ? (
            <Badge variant="secondary" className="h-5 text-[10px]">
              {sizeOption.sizeLabel}
            </Badge>
          ) : undefined
        }
      >
        <div className="flex flex-wrap gap-1.5">
          {PPOCR_MODEL_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => pickSize(o.value)}
              className={cn(
                "rounded-md border px-2 py-1 text-[11px] transition-colors",
                modelSize === o.value
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
              )}
            >
              {t(o.labelKey)}
            </button>
          ))}
        </div>
        {modelSize !== status?.modelSize && status?.workerRunning ? (
          <p className="text-[11px] text-amber-600">{t("ocr.paddleocr.modelChangeHint")}</p>
        ) : null}
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
      {!workerRunning && engineReady && !blocked ? (
        <p className="text-center text-[11px] text-muted-foreground">{t("ocr.paddleocr.autoStartHint")}</p>
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
