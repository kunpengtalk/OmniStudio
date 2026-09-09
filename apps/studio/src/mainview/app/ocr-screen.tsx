import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ScanTextIcon,
  FileTextIcon,
  CpuIcon,
  ServerIcon,
  GlobeIcon,
  DownloadCloudIcon,
  Loader2Icon,
  PlayIcon,
  SquareIcon,
  TrashIcon,
  ImagePlusIcon,
  XIcon,
  CopyIcon,
  CheckIcon,
  ArrowUpIcon,
  SettingsIcon,
  CircleIcon,
  SparklesIcon,
  StoreIcon,
  CheckCircle2Icon,
  RefreshCwIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import { Textarea } from "@ui/textarea";
import { Badge } from "@ui/badge";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@ui/select";
import { useT } from "@stores/ui-lang";
import { useRouter } from "@stores/router";
import { useServerStore } from "@stores/server";
import { cn } from "@/mainview/lib/utils";
import { fileKind, engineSupports, type InferenceEngine } from "@/shared/modelscope";
import { MODEL_PROFILES } from "../../shared/model-profiles";
import { OCR_PSM_MODES } from "../../shared/ocr";
import type { OcrLangModelInfo, OcrLine, OcrStatus } from "../../bun/ocr";
import { DropZone } from "./main-layout/drop-zone";

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}

function ResultError({ error }: { error?: string }) {
  if (!error) return null;
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
      {error}
    </div>
  );
}

function OcrEnginePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const t = useT();
  const options = [
    { key: "tesseract", label: t("ocr.engine.tesseract"), icon: <CpuIcon className="size-3.5" /> },
    { key: "vlm", label: t("ocr.engine.vlm"), icon: <GlobeIcon className="size-3.5" /> },
  ] as const;
  return (
    <div>
      <Label className="mb-1 block text-xs">{t("ocr.engine.title")}</Label>
      <div className="flex flex-wrap gap-1.5">
        {options.map(({ key, label, icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs transition-colors",
              value === key
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
            )}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function OcrLangModelRow({
  model,
  downloading,
  pending,
  active,
  onDownload,
  onStart,
  onStop,
  onDelete,
}: {
  model: OcrLangModelInfo;
  downloading: boolean;
  pending: boolean;
  active: boolean;
  onDownload: (m: OcrLangModelInfo) => void;
  onStart: (m: OcrLangModelInfo) => void;
  onStop: () => void;
  onDelete: (m: OcrLangModelInfo) => void;
}) {
  const t = useT();

  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">{model.name}</p>
          {active && (
            <Badge variant="default" className="gap-1 text-[10px]">
              <CircleIcon className="size-2.5 fill-current" />
              {t("ocr.tess.running")}
            </Badge>
          )}
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{model.description}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground/70 tabular-nums">
          {model.languages.join(" / ")} · {formatBytes(model.installedSize ?? model.sizeBytes)}
          {model.installedSize ? ` · ${t("ocr.tess.installed")}` : ""}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {!model.downloaded ? (
          <Button size="sm" disabled={downloading || pending} onClick={() => onDownload(model)}>
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
              size="sm"
              variant={active ? "outline" : "default"}
              disabled={pending}
              onClick={() => (active ? onStop() : onStart(model))}
            >
              {pending ? (
                <Loader2Icon data-icon="inline-start" className="animate-spin" />
              ) : active ? (
                <SquareIcon data-icon="inline-start" />
              ) : (
                <PlayIcon data-icon="inline-start" />
              )}
              {active ? t("ocr.tess.stop") : t("ocr.tess.start")}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              tooltip={t("ocr.tess.delete")}
              disabled={pending}
              onClick={() => onDelete(model)}
            >
              <TrashIcon className="size-4" />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function ImagePicker({
  image,
  onPick,
  onClear,
}: {
  image: { ref: string; url: string } | null;
  onPick: (f: { ref: string; url: string }) => void;
  onClear: () => void;
}) {
  const t = useT();
  const pick = useMutation({
    mutationFn: async () => {
      const { paths } = await rpcClient.openFileDialog({
        allowedFileTypes: "png,jpg,jpeg,webp,bmp,tiff,tif,gif,heic,heif,pdf",
      });
      if (paths.length === 0) return;
      const { files } = await rpcClient.stageOcrImage({ paths });
      if (files[0]) onPick(files[0]);
    },
  });

  return (
    <div>
      <Label className="mb-1 block text-xs">{t("ocr.image.label")}</Label>
      {!image ? (
        <button
          type="button"
          onClick={() => pick.mutate()}
          disabled={pick.isPending}
          className="flex w-full flex-col items-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors hover:border-muted-foreground/40"
        >
          {pick.isPending ? (
            <Loader2Icon className="size-5 animate-spin text-primary" />
          ) : (
            <ImagePlusIcon className="size-5 text-muted-foreground" />
          )}
          <div className="flex flex-col gap-0.5">
            <p className="text-xs font-medium">{t("ocr.image.pick")}</p>
            <p className="text-[11px] text-muted-foreground">{t("ocr.image.pickHint")}</p>
          </div>
        </button>
      ) : (
        <div className="flex items-start gap-3 rounded-lg border bg-card p-3">
          <img
            src={image.url}
            alt=""
            className="h-28 w-28 shrink-0 rounded-md border object-cover"
          />
          <div className="min-w-0 flex-1">
            <p className="mb-2 truncate font-mono text-[11px] text-muted-foreground">
              {image.ref.split("/").pop()}
            </p>
            <Button size="sm" variant="outline" onClick={() => pick.mutate()}>
              {pick.isPending ? (
                <Loader2Icon data-icon="inline-start" className="animate-spin" />
              ) : (
                <ImagePlusIcon data-icon="inline-start" />
              )}
              {t("ocr.image.pick")}
            </Button>
            <Button size="sm" variant="ghost" className="ml-1 text-destructive" onClick={onClear}>
              <XIcon data-icon="inline-start" />
              {t("ocr.image.remove")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function CopyTextButton({ text }: { text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={!text}
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? (
        <CheckIcon data-icon="inline-start" className="text-emerald-500" />
      ) : (
        <CopyIcon data-icon="inline-start" />
      )}
      {copied ? t("ocr.copied") : t("ocr.copy")}
    </Button>
  );
}

function TesseractTab() {
  const t = useT();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState("");
  const [psm, setPsm] = useState("3");
  const [image, setImage] = useState<{ ref: string; url: string } | null>(null);
  const [result, setResult] = useState<
    { text: string; lines: OcrLine[]; modelLabel: string; modelCode: string } | null
  >(null);
  const [error, setError] = useState<string>();
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [copyCmd, setCopyCmd] = useState(false);

  const { data: status } = useQuery({
    queryKey: ["ocr-status"],
    queryFn: () => rpcClient.getOcrStatus(),
    refetchInterval: 2500,
  });
  const ocrStatus = status as OcrStatus | undefined;

  const { data: modelsData } = useQuery({
    queryKey: ["ocr-models"],
    queryFn: () => rpcClient.listOcrModels(undefined),
  });
  const models = modelsData?.models ?? [];

  // 恢复上次选择的识别模型。
  const settingsHydrated = useRef(false);
  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  useEffect(() => {
    if (settingsHydrated.current || !settingsData?.settings || models.length === 0) return;
    settingsHydrated.current = true;
    const saved = settingsData.settings.OCR_TESSERACT_MODEL;
    if (saved && models.some((m) => m.id === saved)) {
      setSelectedId(saved);
    } else {
      const active = models.find((m) => m.active);
      if (active) setSelectedId(active.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsData, models.length]);
  const activeModel = models.find((m) => m.id === ocrStatus?.activeModelId);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["ocr-models"] });
    queryClient.invalidateQueries({ queryKey: ["ocr-status"] });
  };

  const downloadModel = useMutation({
    mutationFn: async (m: OcrLangModelInfo) => {
      setDownloadingId(m.id);
      const r = await rpcClient.downloadOcrModel({ modelId: m.id });
      setDownloadingId(null);
      if (!r.ok) setError(r.error ?? "下载失败");
      return r;
    },
    onSuccess: (r, m) => {
      if (r.ok) {
        setError(undefined);
        // 下载成功后自动启动。
        startModel.mutate(m);
      }
      refresh();
    },
  });

  const startModel = useMutation({
    mutationFn: (m: OcrLangModelInfo) => rpcClient.startOcr({ modelId: m.id }),
    onSuccess: (r, m) => {
      setError(r.ok ? undefined : (r.error ?? "启动失败"));
      if (r.ok) {
        setSelectedId(m.id);
        void rpcClient.updateSettings({ settings: { OCR_PSM: psm } });
      }
      refresh();
    },
    onError: (e) => setError(String(e)),
  });

  const stopModel = useMutation({
    mutationFn: () => rpcClient.stopOcr(),
    onSuccess: () => {
      setError(undefined);
      refresh();
    },
    onError: (e) => setError(String(e)),
  });

  const deleteModel = useMutation({
    mutationFn: (m: OcrLangModelInfo) => rpcClient.deleteOcrModel({ modelId: m.id }),
    onSuccess: (r) => {
      if (!r.ok) setError("删除失败");
      refresh();
    },
  });

  const pending =
    downloadModel.isPending || startModel.isPending || stopModel.isPending || deleteModel.isPending;

  const run = useMutation({
    mutationFn: () =>
      rpcClient.runOcr({
        imageRef: image!.ref,
        model: selectedId || undefined,
        psm: Number(psm),
      }),
    onSuccess: (r) => {
      if (r.error) {
        setError(r.error);
        setResult(null);
        return;
      }
      setError(undefined);
      setResult(r.result ?? null);
      void rpcClient.updateSettings({ settings: { OCR_PSM: psm } });
    },
    onError: (e) => setError(String(e)),
  });

  const canRun = !!image && !!selectedId && !run.isPending;

  return (
    <div className="flex flex-col gap-5">
      <p className="text-xs text-muted-foreground">{t("ocr.tess.desc")}</p>

      {/* 引擎状态 */}
      <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
        <CpuIcon className="size-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t("ocr.engine.tesseract")}</p>
          <p className="text-xs text-muted-foreground">
            {!ocrStatus?.tesseractInstalled
              ? t("ocr.tess.engineNone")
              : `${t("ocr.tess.engineReady")}${ocrStatus.tesseractPath ? ` · ${ocrStatus.tesseractPath}` : ""}${ocrStatus.tesseractVersion ? ` · v${ocrStatus.tesseractVersion}` : ""}`}
            {activeModel ? ` · ${t("ocr.tess.running")}：${activeModel.name}` : ""}
          </p>
        </div>
        {ocrStatus?.tesseractInstalled ? (
          <Badge variant="default" className="gap-1 text-[10px]">
            <CircleIcon className="size-2.5 fill-current" />
            {t("ocr.tess.engineReady")}
          </Badge>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void navigator.clipboard.writeText("brew install tesseract");
              setCopyCmd(true);
              setTimeout(() => setCopyCmd(false), 1500);
            }}
          >
            {copyCmd ? (
              <CheckIcon data-icon="inline-start" className="text-emerald-500" />
            ) : (
              <CopyIcon data-icon="inline-start" />
            )}
            {copyCmd ? t("ocr.tess.cmdCopied") : t("ocr.tess.copyCmd")}
          </Button>
        )}
      </div>

      {/* 模型列表 */}
      <div>
        <h3 className="mb-2 flex items-center gap-2 text-sm font-medium">
          <ScanTextIcon className="size-4 text-muted-foreground" />
          {t("ocr.tess.models")}
          <span className="text-xs font-normal text-muted-foreground">{t("ocr.tess.modelsHint")}</span>
        </h3>
        <div className="flex max-h-72 flex-col gap-2 overflow-y-auto pr-1">
          {models.map((m) => (
            <OcrLangModelRow
              key={m.id}
              model={m}
              downloading={downloadingId === m.id}
              pending={pending}
              active={m.active && !!ocrStatus?.tesseractInstalled}
              onDownload={(mm) => downloadModel.mutate(mm)}
              onStart={(mm) => startModel.mutate(mm)}
              onStop={() => stopModel.mutate()}
              onDelete={(mm) => deleteModel.mutate(mm)}
            />
          ))}
        </div>
      </div>

      {/* 选择识别模型 */}
      <div>
        <Label className="mb-1 block text-xs">{t("ocr.tess.select")}</Label>
        <Select
          value={selectedId}
          onValueChange={(v) => {
            const m = models.find((x) => x.id === v);
            setError(undefined);
            if (m?.downloaded) {
              setSelectedId(v);
              if (!m.active) void startModel.mutate(m);
            } else if (m) {
              void downloadModel.mutate(m);
            }
          }}
        >
          <SelectTrigger className="h-8 w-full text-xs">
            <SelectValue placeholder={t("ocr.tess.select")} />
          </SelectTrigger>
          <SelectContent>
            {models.length === 0 ? (
              <SelectItem value="__none__" disabled>
                {t("ocr.tess.noModels")}
              </SelectItem>
            ) : (
              models.map((m) => (
                <SelectItem key={m.id} value={m.id} className="text-xs">
                  <span className="flex w-full items-center justify-between gap-2">
                    <span className="truncate">
                      {m.name} · {m.languages.join("/")}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 text-[10px]",
                        m.downloaded ? "text-emerald-500" : "text-amber-500",
                      )}
                    >
                      {m.downloaded
                        ? m.active
                          ? t("ocr.tess.active")
                          : t("ocr.tess.installed")
                        : formatBytes(m.sizeBytes)}
                    </span>
                  </span>
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
        <p className="mt-1 text-[11px] text-muted-foreground">{t("ocr.tess.selectHint")}</p>
      </div>

      {/* 版面模式 */}
      <div>
        <Label className="mb-1 block text-xs">{t("ocr.psm.label")}</Label>
        <div className="flex flex-wrap gap-1.5">
          {OCR_PSM_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => setPsm(m.value)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs transition-colors",
                psm === m.value
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
              )}
            >
              {t(m.labelKey)}
            </button>
          ))}
        </div>
      </div>

      <ImagePicker
        image={image}
        onPick={(f) => {
          setImage(f);
          setResult(null);
          setError(undefined);
        }}
        onClear={() => {
          setImage(null);
          setResult(null);
        }}
      />
      {error && <ResultError error={error} />}

      <div className="flex items-center gap-3">
        <Button onClick={() => run.mutate()} disabled={!canRun}>
          {run.isPending ? (
            <Loader2Icon data-icon="inline-start" className="animate-spin" />
          ) : (
            <ArrowUpIcon data-icon="inline-start" />
          )}
          {run.isPending ? t("ocr.running") : t("ocr.run")}
        </Button>
        {!selectedId && <p className="text-xs text-amber-600">{t("ocr.tess.needModel")}</p>}
      </div>

      {/* 结果 */}
      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium">
            <SparklesIcon className="size-3.5 text-primary" />
            {t("ocr.result")}
            {result && (
              <span className="font-normal text-muted-foreground">
                · {result.modelLabel}
                {result.lines.length > 0 && (
                  <>
                    {" "}· {result.lines.length} {t("ocr.lines")
                    } ·{" "}
                    {result.lines.reduce((n, l) => n + l.words.length, 0)} {t("ocr.words")}
                  </>
                )}
              </span>
            )}
          </span>
          {result && <CopyTextButton text={result.text} />}
        </div>

        {!result ? (
          <div className="flex items-center justify-center rounded-lg border border-dashed px-4 py-8 text-xs text-muted-foreground">
            {t("ocr.noResult")}
          </div>
        ) : (
          <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
            <div className="rounded-md border bg-muted/40 p-2">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[10px] font-medium text-muted-foreground">{t("ocr.text")}</span>
              </div>
              <Textarea
                readOnly
                value={result.text}
                className="max-h-72 min-h-28 resize-y font-mono text-xs"
              />
            </div>
            {result.lines.length > 0 && (
              <div className="max-h-48 overflow-y-auto rounded-md border bg-muted/20">
                {result.lines.map((l, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2 border-b border-border/50 px-2 py-1 last:border-0"
                  >
                    <span className="mt-0.5 shrink-0 font-mono text-[10px] text-muted-foreground/60 tabular-nums">
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
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function VlmTab() {
  const t = useT();
  const queryClient = useQueryClient();
  const router = useRouter();
  const serverStatus = useServerStore((s) => s.status);
  const serverRunning = serverStatus === "running";
  const serverBusy = serverStatus === "starting" || serverStatus === "downloading";

  // 识别来源：本地推理引擎（默认）/ 远程 OpenAI 兼容 API。
  const [source, setSource] = useState<"local" | "remote">("local");
  const [profileId, setProfileId] = useState("");
  const [modelPath, setModelPath] = useState("");
  const [image, setImage] = useState<{ ref: string; url: string } | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string>();

  const settingsHydrated = useRef(false);
  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  const settings = settingsData?.settings;
  const engine = (settings?.INFERENCE_ENGINE as InferenceEngine) || "llama.cpp";

  useEffect(() => {
    if (settingsHydrated.current || !settingsData?.settings) return;
    settingsHydrated.current = true;
    const saved = settingsData.settings.VLLM_MODEL_PROFILE;
    if (saved && MODEL_PROFILES.some((p) => p.id === saved)) setProfileId(saved);
    const savedSource = settingsData.settings.OCR_VLM_SOURCE;
    if (savedSource === "local" || savedSource === "remote") setSource(savedSource);
  }, [settingsData]);

  const switchSource = (v: "local" | "remote") => {
    setSource(v);
    setError(undefined);
    void rpcClient.updateSettings({ settings: { OCR_VLM_SOURCE: v } });
  };

  // 已安装模型（按当前推理引擎过滤格式）。
  const { data: installedData } = useQuery({
    queryKey: ["installed-models"],
    queryFn: () => rpcClient.listInstalledModels(),
  });
  const installedModels = (installedData?.models ?? [])
    .filter((m) => engineSupports(engine, fileKind(m.fileName)))
    .sort((a, b) => Number(b.isActive) - Number(a.isActive));

  // 默认选中当前已激活的模型；没有则取第一个已安装模型。
  useEffect(() => {
    if (modelPath) return;
    const active = installedModels.find((m) => m.isActive) ?? installedModels[0];
    if (active) setModelPath(active.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installedModels.length]);

  const selectedModel = installedModels.find((m) => m.path === modelPath) ?? null;

  /** 选择模型即激活（写入 LOCAL_MODEL_PATH），再点「启动」/「重启」让服务器加载。 */
  const selectModel = (path: string) => {
    setModelPath(path);
    setError(undefined);
    void rpcClient.setActiveModel({ path }).then((r) => {
      if (!r.ok) setError(r.error ?? "激活失败");
      queryClient.invalidateQueries({ queryKey: ["installed-models"] });
    });
  };

  const startServer = useMutation({
    mutationFn: async () => {
      const model = selectedModel ?? installedModels.find((m) => m.isActive);
      if (!model) return { ok: false, error: t("ocr.vlm.needModelFirst") };
      if (!model.isActive) {
        const r = await rpcClient.setActiveModel({ path: model.path });
        if (!r.ok) return r;
      }
      const status = useServerStore.getState().status;
      return status === "running" || status === "starting" || status === "downloading"
        ? await rpcClient.restartServer()
        : await rpcClient.startServer();
    },
    onSuccess: (r) => {
      if (r && !r.ok) setError(r.error ?? "启动失败");
      queryClient.invalidateQueries({ queryKey: ["installed-models"] });
    },
    onError: (e) => setError(String(e)),
  });

  // ---------- 远程 OpenAI 兼容 provider（OCR 页单独配置，不依赖全局 SERVER_MODE） ----------
  const { data: providerData } = useQuery({
    queryKey: ["ocr-provider"],
    queryFn: () => rpcClient.getOcrProviderConfig(),
  });
  const provider = providerData?.config;
  const configured = !!provider?.base;

  const [pBase, setPBase] = useState("");
  const [pKey, setPKey] = useState("");
  const [pModel, setPModel] = useState("");
  const providerSynced = useRef(false);
  useEffect(() => {
    if (!provider || providerSynced.current) return;
    providerSynced.current = true;
    setPBase(provider.base);
    setPKey(provider.apiKey ?? "");
    if (provider.model) setPModel(provider.model);
  }, [provider]);

  const saveProvider = useMutation({
    mutationFn: () =>
      rpcClient.saveOcrProviderConfig({
        base: pBase.trim(),
        apiKey: pKey.trim(),
        model: pModel.trim(),
      }),
    onSuccess: () => {
      setError(undefined);
      queryClient.invalidateQueries({ queryKey: ["ocr-provider"] });
    },
    onError: (e) => setError(String(e)),
  });

  const fetchModels = useMutation({
    mutationFn: () =>
      rpcClient.listOcrProviderModels({
        base: pBase.trim() || provider?.base || undefined,
        apiKey: pKey.trim() || provider?.apiKey || undefined,
      }),
  });
  const providerModels = fetchModels.data?.models ?? [];
  const pError = fetchModels.data?.error;

  const run = useMutation({
    mutationFn: () =>
      rpcClient.runOcrVlm({
        imageRef: image!.ref,
        profileId: profileId || undefined,
        source,
      }),
    onSuccess: (r) => {
      if (r.error) {
        setError(r.error);
        setResult(null);
        return;
      }
      setError(undefined);
      setResult(r.result?.markdown ?? "");
    },
    onError: (e) => setError(String(e)),
  });

  const canRun =
    !!image &&
    !run.isPending &&
    (source === "remote" ? configured : serverRunning && !!selectedModel);

  return (
    <div className="flex flex-col gap-5">
      <p className="text-xs text-muted-foreground">{t("ocr.vlm.desc")}</p>

      {/* 识别来源 */}
      <div>
        <Label className="mb-1 block text-xs">{t("ocr.vlm.source")}</Label>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => switchSource("local")}
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs transition-colors",
              source === "local"
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
            )}
          >
            <ServerIcon className="size-3.5" />
            {t("ocr.vlm.sourceLocal")}
          </button>
          <button
            type="button"
            onClick={() => switchSource("remote")}
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs transition-colors",
              source === "remote"
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
            )}
          >
            <GlobeIcon className="size-3.5" />
            {t("ocr.vlm.sourceRemote")}
          </button>
        </div>
      </div>

      {source === "remote" ? (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">{t("ocr.vlm.remote.desc")}</p>

          {/* 配置状态 */}
          <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
            <GlobeIcon className="size-4 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{t("ocr.vlm.sourceRemote")}</p>
              <p className="text-xs text-muted-foreground">
                {configured ? t("ocr.vlm.remote.configured") : t("ocr.vlm.remote.notConfigured")}
                {provider?.model && (
                  <span className="ml-1 text-muted-foreground/70">· {provider.model}</span>
                )}
              </p>
            </div>
            {configured && (
              <Badge variant="secondary" className="gap-1 text-[10px]">
                <CircleIcon className="size-2.5 fill-current" />
                {t("ocr.vlm.remote.configured")}
              </Badge>
            )}
          </div>

          {/* 远程 provider 表单 */}
          <div className="flex flex-col gap-3 rounded-lg border bg-card p-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ocr-provider-base" className="text-xs">
                {t("ocr.vlm.remote.base")}
              </Label>
              <Input
                id="ocr-provider-base"
                placeholder="http://localhost:8080/v1"
                value={pBase}
                onChange={(e) => setPBase(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ocr-provider-key" className="text-xs">
                {t("ocr.vlm.remote.apiKey")}
              </Label>
              <Input
                id="ocr-provider-key"
                type="password"
                value={pKey}
                onChange={(e) => setPKey(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ocr-provider-model" className="text-xs">
                {t("ocr.vlm.remote.model")}
              </Label>
              <Input
                id="ocr-provider-model"
                list="ocr-provider-models"
                placeholder="e.g. Qwen2.5-VL"
                value={pModel}
                onChange={(e) => setPModel(e.target.value)}
                className="h-8 text-xs"
              />
              <datalist id="ocr-provider-models">
                {providerModels.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={() => saveProvider.mutate()}
                disabled={saveProvider.isPending || !pBase.trim()}
              >
                {saveProvider.isPending ? (
                  <Loader2Icon data-icon="inline-start" className="animate-spin" />
                ) : (
                  <CheckCircle2Icon data-icon="inline-start" />
                )}
                {t("ocr.vlm.remote.save")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => fetchModels.mutate()}
                disabled={fetchModels.isPending || !pBase.trim()}
              >
                {fetchModels.isPending ? (
                  <Loader2Icon data-icon="inline-start" className="animate-spin" />
                ) : (
                  <RefreshCwIcon data-icon="inline-start" />
                )}
                {t("ocr.vlm.remote.fetchModels")}
              </Button>
            </div>
            {(pError || (fetchModels.isError ? String(fetchModels.error) : undefined)) && (
              <ResultError error={pError ?? String(fetchModels.error)} />
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
            <ServerIcon className="size-4 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{t("ocr.engine.vlm")}</p>
              <p className="text-xs text-muted-foreground">
                {serverRunning ? t("ocr.vlm.serverRunning") : t("ocr.vlm.serverHint")}
                {selectedModel?.isActive && (
                  <span className="ml-1 text-muted-foreground/70">
                    · {t("ocr.vlm.activeModel")}：{selectedModel.fileName}
                  </span>
                )}
              </p>
              {serverRunning && (
                <p className="mt-0.5 text-[11px] text-amber-600">{t("ocr.vlm.restartHint")}</p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                size="sm"
                onClick={() => startServer.mutate()}
                disabled={!selectedModel || startServer.isPending || serverBusy}
              >
                {startServer.isPending ? (
                  <Loader2Icon data-icon="inline-start" className="animate-spin" />
                ) : (
                  <PlayIcon data-icon="inline-start" />
                )}
                {serverRunning ? t("ocr.vlm.restart") : t("ocr.vlm.startServer")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => router.setRoute({ path: "settings" })}
              >
                <SettingsIcon data-icon="inline-start" />
                {t("ocr.vlm.openSettings")}
              </Button>
            </div>
          </div>

          {/* 选择要加载的模型（VLM 必须先选模型再启动） */}
          <div>
            <Label className="mb-1 block text-xs">{t("ocr.vlm.model")}</Label>
            {installedModels.length === 0 ? (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-dashed px-4 py-4 text-xs text-muted-foreground">
                {t("ocr.vlm.noModels")}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => router.setRoute({ path: "models" })}
                >
                  <StoreIcon data-icon="inline-start" />
                  {t("ocr.vlm.goLibrary")}
                </Button>
              </div>
            ) : (
              <Select value={selectedModel?.path ?? ""} onValueChange={selectModel}>
                <SelectTrigger className="h-8 w-full text-xs">
                  <SelectValue placeholder={t("ocr.vlm.model")} />
                </SelectTrigger>
                <SelectContent>
                  {installedModels.map((m) => (
                    <SelectItem key={m.path} value={m.path} className="text-xs">
                      <span className="flex w-full items-center justify-between gap-2">
                        <span className="truncate">{m.fileName}</span>
                        {m.isActive && (
                          <span className="shrink-0 text-[10px] text-emerald-500">
                            {t("ocr.vlm.activeModel")}
                          </span>
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <p className="mt-1 text-[11px] text-muted-foreground">{t("ocr.vlm.modelHint")}</p>
          </div>
        </>
      )}

      {/* OCR 处理器（profile） */}
      <div>
        <Label className="mb-1 block text-xs">{t("ocr.vlm.profile")}</Label>
        <Select value={profileId} onValueChange={setProfileId}>
          <SelectTrigger className="h-8 w-full text-xs">
            <SelectValue placeholder={t("ocr.vlm.profile")} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>{t("ocr.vlm.profile")}</SelectLabel>
              {MODEL_PROFILES.map((p) => (
                <SelectItem key={p.id} value={p.id} className="text-xs">
                  <span className="flex w-full items-center justify-between gap-2">
                    <span className="truncate">
                      {p.label}
                      {p.badge ? (
                        <Badge variant="secondary" className="ml-1.5 text-[9px]">
                          {p.badge}
                        </Badge>
                      ) : null}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {MODEL_PROFILES.find((p) => p.id === profileId)?.description}
        </p>
      </div>

      <ImagePicker
        image={image}
        onPick={(f) => {
          setImage(f);
          setResult(null);
          setError(undefined);
        }}
        onClear={() => {
          setImage(null);
          setResult(null);
        }}
      />
      {error && <ResultError error={error} />}

      <div className="flex items-center gap-3">
        <Button onClick={() => run.mutate()} disabled={!canRun}>
          {run.isPending ? (
            <Loader2Icon data-icon="inline-start" className="animate-spin" />
          ) : (
            <ArrowUpIcon data-icon="inline-start" />
          )}
          {run.isPending ? t("ocr.running") : t("ocr.run")}
        </Button>
        {!!image && source === "local" && (!serverRunning || !selectedModel) && (
          <p className="text-xs text-amber-600">{t("ocr.vlm.needServer")}</p>
        )}
        {!!image && source === "remote" && !configured && (
          <p className="text-xs text-amber-600">{t("ocr.vlm.remote.notConfigured")}</p>
        )}
      </div>

      {/* 结果 */}
      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium">
            <SparklesIcon className="size-3.5 text-primary" />
            {t("ocr.result")}
          </span>
          {result && <CopyTextButton text={result} />}
        </div>
        {!result ? (
          <div className="flex items-center justify-center rounded-lg border border-dashed px-4 py-8 text-xs text-muted-foreground">
            {t("ocr.noResult")}
          </div>
        ) : (
          <div className="rounded-lg border bg-card p-3">
            <Textarea readOnly value={result} className="min-h-28 resize-y font-mono text-xs" />
          </div>
        )}
      </div>
    </div>
  );
}

export function OcrScreen() {
  const t = useT();
  const [tab, setTab] = useState<"extract" | "docs">("extract");
  const [engine, setEngine] = useState<string>("");
  const engineHydrated = useRef(false);

  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  useEffect(() => {
    if (engineHydrated.current || !settingsData?.settings) return;
    engineHydrated.current = true;
    const saved = settingsData.settings.OCR_ENGINE;
    if (saved === "tesseract" || saved === "vlm") setEngine(saved);
  }, [settingsData]);

  const switchEngine = (v: string) => {
    setEngine(v);
    void rpcClient.updateSettings({ settings: { OCR_ENGINE: v } });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 两个菜单：识别提取 / 文档处理 */}
      <div className="flex items-center gap-1 px-6 pt-2 pb-3">
        <button
          type="button"
          onClick={() => setTab("extract")}
          className={cn(
            "flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs transition-colors",
            tab === "extract"
              ? "border-primary bg-primary/10 text-primary"
              : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
          )}
        >
          <ScanTextIcon className="size-4" />
          {t("ocr.tab.extract")}
        </button>
        <button
          type="button"
          onClick={() => setTab("docs")}
          className={cn(
            "flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs transition-colors",
            tab === "docs"
              ? "border-primary bg-primary/10 text-primary"
              : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
          )}
        >
          <FileTextIcon className="size-4" />
          {t("ocr.tab.docs")}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "docs" ? (
          <DropZone />
        ) : (
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-6 py-2 pb-12">
            <OcrEnginePicker value={engine} onChange={switchEngine} />
            {engine === "vlm" ? <VlmTab /> : <TesseractTab />}
          </div>
        )}
      </div>
    </div>
  );
}
