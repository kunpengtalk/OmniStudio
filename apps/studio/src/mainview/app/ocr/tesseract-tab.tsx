import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpIcon,
  CircleIcon,
  CpuIcon,
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
import { Input } from "@ui/input";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import { OCR_PSM_MODES } from "../../../shared/ocr";
import type { OcrLangModelInfo, OcrLine, OcrStatus } from "../../../bun/ocr";
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

/** 稳定引用，避免每次渲染都生成新数组。 */
const NO_MODELS: OcrLangModelInfo[] = [];

type TesseractResult = {
  text: string;
  lines: OcrLine[];
  modelLabel: string;
  modelCode: string;
};

function LangModelRow({
  model,
  busy,
  downloading,
  active,
  onDownload,
  onUse,
  onStop,
  onDelete,
}: {
  model: OcrLangModelInfo;
  busy: boolean;
  downloading: boolean;
  active: boolean;
  onDownload: () => void;
  onUse: () => void;
  onStop: () => void;
  onDelete: () => void;
}) {
  const t = useT();

  return (
    <div
      className={cn(
        "flex items-center gap-2.5 rounded-lg border px-2.5 py-2 transition-colors",
        active ? "border-primary/50 bg-primary/5" : "bg-card hover:bg-muted/40",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-xs font-medium">{model.name}</span>
          <Badge variant="secondary" className="h-4 shrink-0 px-1 text-[9px]">
            {model.script}
          </Badge>
          {active ? (
            <Badge className="h-4 shrink-0 gap-0.5 px-1 text-[9px]">
              <CircleIcon className="size-1.5 fill-current" />
              {t("ocr.tess.running")}
            </Badge>
          ) : null}
        </div>
        <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
          {model.languages.join(" / ")} · {formatBytes(model.installedSize ?? model.sizeBytes)}
          {model.downloaded ? ` · ${t("ocr.tess.installed")}` : ""}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {!model.downloaded ? (
          <Button size="xs" variant="outline" disabled={busy} onClick={onDownload}>
            {downloading ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <DownloadCloudIcon data-icon="inline-start" />
            )}
            {downloading ? t("ocr.tess.downloading") : t("ocr.tess.download")}
          </Button>
        ) : (
          <>
            <Button
              size="xs"
              variant={active ? "outline" : "default"}
              disabled={busy}
              onClick={active ? onStop : onUse}
            >
              {active ? (
                <SquareIcon data-icon="inline-start" />
              ) : (
                <PlayIcon data-icon="inline-start" />
              )}
              {active ? t("ocr.tess.stop") : t("ocr.tess.use")}
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              tooltip={t("ocr.tess.delete")}
              disabled={busy}
              className="text-muted-foreground hover:text-destructive"
              onClick={onDelete}
            >
              <TrashIcon />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export function TesseractTab({
  image,
  onImageChange,
}: {
  image: StagedImage | null;
  onImageChange: (img: StagedImage | null) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();

  const [selectedId, setSelectedId] = useState("");
  const [psm, setPsm] = useState("3");
  const [keyword, setKeyword] = useState("");
  const [result, setResult] = useState<TesseractResult | null>(null);
  const [error, setError] = useState<string>();
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [copyCmd, setCopyCmd] = useState(false);

  const { data: status } = useQuery({
    queryKey: ["ocr-status"],
    queryFn: () => rpcClient.getOcrStatus(),
    refetchInterval: 2500,
  });
  const ocrStatus = status as OcrStatus | undefined;
  const engineReady = !!ocrStatus?.tesseractInstalled;

  const { data: modelsData } = useQuery({
    queryKey: ["ocr-models"],
    queryFn: () => rpcClient.listOcrModels(undefined),
  });
  const models = modelsData?.models ?? NO_MODELS;

  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });

  // 恢复上次的语言模型与版面模式。
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current || !settingsData?.settings || models.length === 0) return;
    hydrated.current = true;
    const savedPsm = settingsData.settings.OCR_PSM;
    if (savedPsm && OCR_PSM_MODES.some((m) => m.value === savedPsm)) setPsm(savedPsm);
    const saved = settingsData.settings.OCR_TESSERACT_MODEL;
    if (saved && models.some((m) => m.id === saved)) {
      setSelectedId(saved);
      return;
    }
    const active = models.find((m) => m.active);
    if (active) setSelectedId(active.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsData, models.length]);

  const selectedModel = models.find((m) => m.id === selectedId) ?? null;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["ocr-models"] });
    void queryClient.invalidateQueries({ queryKey: ["ocr-status"] });
  };

  const startModel = useMutation({
    mutationFn: (id: string) => rpcClient.startOcr({ modelId: id }),
    onSuccess: (r, id) => {
      if (r.ok) {
        setError(undefined);
        setSelectedId(id);
      } else {
        setError(r.error ?? t("ocr.tess.needModel"));
      }
      refresh();
    },
    onError: (e) => setError(String(e)),
  });

  const stopModel = useMutation({
    mutationFn: () => rpcClient.stopOcr(),
    onSuccess: () => {
      setError(undefined);
      setSelectedId("");
      refresh();
    },
    onError: (e) => setError(String(e)),
  });

  const downloadModel = useMutation({
    mutationFn: async (id: string) => {
      setDownloadingId(id);
      try {
        return await rpcClient.downloadOcrModel({ modelId: id });
      } finally {
        setDownloadingId(null);
      }
    },
    onSuccess: (r, id) => {
      if (!r.ok) {
        setError(r.error ?? t("ocr.tess.needModel"));
        refresh();
        return;
      }
      setError(undefined);
      // 下载完成后自动启用，省一次点击。
      startModel.mutate(id);
      refresh();
    },
    onError: (e) => {
      setError(String(e));
      refresh();
    },
  });

  const deleteModel = useMutation({
    mutationFn: (id: string) => rpcClient.deleteOcrModel({ modelId: id }),
    onSuccess: (r, id) => {
      if (!r.ok) setError(t("ocr.tess.needModel"));
      else if (id === selectedId) setSelectedId("");
      refresh();
    },
  });

  // 启停/删除会改动共享的「当前模型」状态，需要锁住整个列表；下载只锁当前行。
  const busyOp = startModel.isPending || stopModel.isPending || deleteModel.isPending;

  const run = useMutation({
    mutationFn: () =>
      rpcClient.runOcr({
        imageRef: image!.ref,
        model: selectedId || undefined,
        psm: Number(psm),
      }),
    onSuccess: (r) => {
      if (r.error || !r.result) {
        setError(r.error ?? t("ocr.empty"));
        setResult(null);
        return;
      }
      setError(undefined);
      setResult(r.result);
      void rpcClient.updateSettings({ settings: { OCR_PSM: psm } });
    },
    onError: (e) => setError(String(e)),
  });

  const blocked = !image
    ? t("ocr.error.empty")
    : !engineReady
      ? t("ocr.tess.engineNone")
      : !selectedModel?.downloaded
        ? t("ocr.tess.needModel")
        : undefined;

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    const list = kw
      ? models.filter(
          (m) =>
            m.name.toLowerCase().includes(kw) ||
            m.id.toLowerCase().includes(kw) ||
            m.languages.join(" ").toLowerCase().includes(kw) ||
            m.script.toLowerCase().includes(kw),
        )
      : [...models];
    // 已下载的模型排在前面，常用语言取用更顺手。
    return list.sort(
      (a, b) => Number(b.downloaded) - Number(a.downloaded) || a.name.localeCompare(b.name),
    );
  }, [models, keyword]);

  const panel = (
    <>
      <PanelSection title={t("ocr.engine.tesseract")} hint={t("ocr.tess.desc")}>
        <StatusCard
          icon={<CpuIcon className="size-4" />}
          tone={engineReady ? "ok" : "warn"}
          title={engineReady ? t("ocr.tess.engineReady") : t("ocr.tess.engineNone")}
          detail={
            engineReady
              ? [
                  ocrStatus?.tesseractVersion ? `v${ocrStatus.tesseractVersion}` : null,
                  selectedModel?.downloaded
                    ? `${t("ocr.tess.running")}：${selectedModel.name}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : undefined
          }
          action={
            engineReady ? undefined : (
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard?.writeText("brew install tesseract");
                  setCopyCmd(true);
                  setTimeout(() => setCopyCmd(false), 1500);
                }}
              >
                {copyCmd ? t("ocr.tess.cmdCopied") : t("ocr.tess.copyCmd")}
              </Button>
            )
          }
        />
      </PanelSection>

      <PanelSection
        title={t("ocr.tess.models")}
        hint={t("ocr.tess.modelsHint")}
        action={
          <Badge variant="secondary" className="h-5 text-[10px]">
            {models.length}
          </Badge>
        }
      >
        <Input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder={t("ocr.tess.searchModels")}
          className="h-7 text-xs"
        />
        {filtered.length === 0 ? (
          <p className="py-6 text-center text-[11px] text-muted-foreground">
            {t("ocr.tess.noMatch")}
          </p>
        ) : (
          <div className="flex max-h-72 flex-col gap-1.5 overflow-y-auto pr-0.5">
            {filtered.map((m) => (
              <LangModelRow
                key={m.id}
                model={m}
                busy={busyOp || downloadingId === m.id}
                downloading={downloadingId === m.id}
                active={m.active && engineReady}
                onDownload={() => downloadModel.mutate(m.id)}
                onUse={() => startModel.mutate(m.id)}
                onStop={() => stopModel.mutate()}
                onDelete={() => deleteModel.mutate(m.id)}
              />
            ))}
          </div>
        )}
      </PanelSection>

      <PanelSection title={t("ocr.psm.label")}>
        <div className="flex flex-wrap gap-1.5">
          {OCR_PSM_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => setPsm(m.value)}
              className={cn(
                "rounded-md border px-2 py-1 text-[11px] transition-colors",
                psm === m.value
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
              )}
            >
              {t(m.labelKey)}
            </button>
          ))}
        </div>
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
    </div>
  );

  const resultHeader = (
    <ResultHeader
      meta={
        result
          ? `${result.modelLabel} · ${result.lines.length} ${t("ocr.lines")} · ${result.lines.reduce((n, l) => n + l.words.length, 0)} ${t("ocr.words")}`
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
              <span className="min-w-0 flex-1 break-words text-[11px] leading-snug">
                {l.text}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60 tabular-nums">
                {Math.round(l.conf)}%
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );

  return (
    <Workbench panel={panel} footer={footer} resultHeader={resultHeader} result={resultBody} />
  );
}
