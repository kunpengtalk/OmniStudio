import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AudioLinesIcon, MicIcon, XIcon, Loader2Icon, FileAudioIcon, SquareIcon, PlayIcon, CircleIcon, ServerIcon, DownloadCloudIcon, GlobeIcon, SaveIcon, CpuIcon, TrashIcon, TimerIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { CloudModelSelect } from "@components/cloud-model-select";
import { ResultError, ResultEmpty } from "@components/media-result";
import { SegmentedControl } from "@components/segmented-control";
import { Button } from "@ui/button";
import { Label } from "@ui/label";
import { Badge } from "@ui/badge";
import { Spinner } from "@ui/spinner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { useT } from "@stores/ui-lang";
import { useModelDownloadStore } from "@stores/model-download";
import { useMicRecorder } from "@hooks/use-mic-recorder";
import type { AsrModelItem, AsrSegment, AsrStatus } from "../../../bun/asr";
import type { AsrAudioCppModelInfo, AsrAudioCppStatus } from "../../../bun/asr-audiocpp";
import { TranscriptViewer, mergeSegments, fmtClock } from "../voice-asr-result";
import { AUDIOCPP_REPO } from "@/shared/audiocpp";
import { DEFAULT_ASR_MODEL_FILE } from "@/shared/modelscope";
import { cn } from "@/mainview/lib/utils";
import { PlayAudio, SettingsValues, formatBytes } from "./parts";

function AsrModelRow({
  model,
  status,
  pending,
  onDownload,
  onStart,
  onStop,
}: {
  model: AsrModelItem;
  status?: AsrStatus;
  pending: boolean;
  onDownload: (m: AsrModelItem) => void;
  onStart: (m: AsrModelItem) => void;
  onStop: () => void;
}) {
  const t = useT();
  const tasks = useModelDownloadStore((s) => s.tasks);
  const task = tasks.find((x) => x.repo === model.repo && x.fileName === model.fileName);
  const downloading = task && (task.status === "downloading" || task.status === "queued");
  const running =
    !!model.installedPath && status?.serverRunning && status.activeModel === model.installedPath;

  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">{model.label}</p>
          {model.fileName === DEFAULT_ASR_MODEL_FILE && (
            <Badge variant="secondary" className="text-[10px]">
              {t("voice.asr.default")}
            </Badge>
          )}
          {running && (
            <Badge variant="default" className="gap-1 text-[10px]">
              <CircleIcon className="size-2.5 fill-current" />
              {t("voice.asr.running")}
            </Badge>
          )}
          {task?.status === "failed" && (
            <Badge variant="destructive" className="text-[10px]">
              {t("voice.failed")}
            </Badge>
          )}
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{model.description}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground/70 tabular-nums">
          {formatBytes(model.installedSize ?? model.sizeBytes)}
          {model.installedSize ? ` · ${t("voice.asr.installed")}` : ""}
        </p>
        {downloading && task && (
          <div className="mt-1.5 h-1.5 w-full max-w-56 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300"
              style={{ width: `${task.percent ?? 0}%` }}
            />
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {!model.installedSize ? (
          <Button
            size="sm"
            disabled={downloading || pending}
            onClick={() => onDownload(model)}
          >
            {downloading ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <DownloadCloudIcon data-icon="inline-start" />
            )}
            {downloading
              ? `${task?.percent != null ? Math.round(task.percent) : 0}%`
              : t("voice.asr.download")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant={running ? "outline" : "default"}
            disabled={pending}
            onClick={() => (running ? onStop() : onStart(model))}
          >
            {pending ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : running ? (
              <SquareIcon data-icon="inline-start" />
            ) : (
              <PlayIcon data-icon="inline-start" />
            )}
            {running ? t("voice.asr.stop") : t("voice.asr.start")}
          </Button>
        )}
      </div>
    </div>
  );
}

function AsrAudioCppModelRow({
  model,
  status,
  pending,
  onDownload,
  onStart,
  onStop,
  onDelete,
}: {
  model: AsrAudioCppModelInfo;
  status?: AsrAudioCppStatus;
  pending: boolean;
  onDownload: (m: AsrAudioCppModelInfo) => void;
  onStart: (m: AsrAudioCppModelInfo) => void;
  onStop: () => void;
  onDelete: (m: AsrAudioCppModelInfo) => void;
}) {
  const t = useT();
  const tasks = useModelDownloadStore((s) => s.tasks);
  const task = tasks.find((x) => x.repo === AUDIOCPP_REPO && x.fileName === model.repoPath);
  const downloading = task && (task.status === "downloading" || task.status === "queued");
  const running = model.active && !!status?.active;

  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">{model.name}</p>
          {running && (
            <Badge variant="default" className="gap-1 text-[10px]">
              <CircleIcon className="size-2.5 fill-current" />
              {t("voice.local.running")}
            </Badge>
          )}
          {task?.status === "failed" && (
            <Badge variant="destructive" className="text-[10px]">
              {t("voice.failed")}
            </Badge>
          )}
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{model.description}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground/70 tabular-nums">
          {model.languages.join(" / ")} · {formatBytes(model.installedSize ?? model.sizeBytes)}
          {model.installedSize ? ` · ${t("voice.local.installed")}` : ""}
        </p>
        {downloading && task && (
          <div className="mt-1.5 h-1.5 w-full max-w-56 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300"
              style={{ width: `${task.percent ?? 0}%` }}
            />
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {!model.downloaded ? (
          <Button size="sm" disabled={downloading || pending} onClick={() => onDownload(model)}>
            {downloading ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <DownloadCloudIcon data-icon="inline-start" />
            )}
            {downloading
              ? `${task?.percent != null ? Math.round(task.percent) : 0}%`
              : t("voice.local.download")}
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              variant={running ? "outline" : "default"}
              disabled={pending}
              onClick={() => (running ? onStop() : onStart(model))}
            >
              {pending ? (
                <Loader2Icon data-icon="inline-start" className="animate-spin" />
              ) : running ? (
                <SquareIcon data-icon="inline-start" />
              ) : (
                <PlayIcon data-icon="inline-start" />
              )}
              {running ? t("voice.local.stop") : t("voice.local.start")}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              tooltip={t("voice.local.delete")}
              onClick={() => onDelete(model)}
              disabled={pending}
            >
              <TrashIcon className="size-4" />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** 录音时的音量电平条（rAF 每帧驱动，纯展示）。 */
function LevelMeter({ level }: { level: number }) {
  const BARS = 28;
  return (
    <div className="flex h-11 items-end gap-[3px] rounded-lg border bg-muted/40 px-3 pt-1.5 pb-1">
      {Array.from({ length: BARS }).map((_, i) => {
        // 每个条有固定的“相位”，让整体像波形跳动而不是同步闪烁。
        const phase = Math.abs(Math.sin(i * 12.9898));
        const peak = (0.18 + 0.82 * (i / BARS)) * (0.6 + 0.4 * phase);
        const h = Math.max(8, Math.min(100, (level * 100 * peak + 6) * 0.95));
        return (
          <span
            key={i}
            className="w-full flex-1 rounded-full bg-primary/70 transition-[height] duration-75"
            style={{ height: `${h}%` }}
          />
        );
      })}
    </div>
  );
}

export function AsrTab() {
  const t = useT();
  const queryClient = useQueryClient();
  const settings = SettingsValues();
  const [asrLang, setAsrLang] = useState(settings.asrLang);
  const [audio, setAudio] = useState<{ ref: string; url: string } | null>(null);
  const [meta, setMeta] = useState<string | null>(null);
  const [tError, setTError] = useState<string | undefined>();
  const [micError, setMicError] = useState<string | undefined>();
  const [engineMode, setEngineMode] = useState<"whisper" | "audiocpp" | "api">("whisper");
  const [segments, setSegments] = useState<AsrSegment[]>([]);
  const [hasSpeakers, setHasSpeakers] = useState(false);
  const [plainText, setPlainText] = useState("");
  const [speakerMode, setSpeakerMode] = useState(true);
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [jumpIndex, setJumpIndex] = useState<number | null>(null);

  // ---------- whisper.cpp engine ----------
  const { data: modelsData } = useQuery({
    queryKey: ["asr-models"],
    queryFn: () => rpcClient.listAsrModels(),
  });
  const models = modelsData?.models ?? [];

  const { data: status } = useQuery({
    queryKey: ["asr-status"],
    queryFn: () => rpcClient.getAsrStatus(),
    refetchInterval: 2500,
  });
  const serverRunning = status?.serverRunning ?? false;

  // ---------- audio.cpp engine ----------
  const [acpModelId, setAcpModelId] = useState("");
  const { data: acpStatus } = useQuery({
    queryKey: ["asr-audiocpp-status"],
    queryFn: () => rpcClient.getAsrAudioCppStatus(),
    refetchInterval: 2500,
  });

  const { data: acpModelsData } = useQuery({
    queryKey: ["asr-audiocpp-models"],
    queryFn: () => rpcClient.listAsrAudioCppModels(),
  });
  const acpModels = acpModelsData?.models ?? [];

  // 恢复上次选择的引擎（ASR_ENGINE 设置）。
  const engineHydrated = useRef(false);
  useEffect(() => {
    if (!settings.loaded || engineHydrated.current) return;
    engineHydrated.current = true;
    setEngineMode(
      settings.asrEngine === "audiocpp"
        ? "audiocpp"
        : settings.asrEngine === "api"
          ? "api"
          : "whisper",
    );
  }, [settings]);

  const switchEngine = (mode: "whisper" | "audiocpp" | "api") => {
    setEngineMode(mode);
    setTError(undefined);
    void rpcClient.updateSettings({ settings: { ASR_ENGINE: mode } });
    if (mode === "audiocpp" || mode === "api") {
      // 本地引擎与 API 模式互斥：切走时停掉 whisper-server。
      void rpcClient.stopAsr();
    }
  };

  // 有正在使用的 audio.cpp 模型时自动选中。
  useEffect(() => {
    if (acpStatus?.activeModelId) {
      setAcpModelId((cur) => cur || acpStatus.activeModelId!);
    }
  }, [acpStatus?.activeModelId]);

  useEffect(() => {
    if (!acpModelId) {
      const active = acpModels.find((m) => m.active);
      if (active) setAcpModelId(active.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acpModels?.length]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["asr-models"] });
    queryClient.invalidateQueries({ queryKey: ["asr-status"] });
    queryClient.invalidateQueries({ queryKey: ["asr-audiocpp-models"] });
    queryClient.invalidateQueries({ queryKey: ["asr-audiocpp-status"] });
    queryClient.invalidateQueries({ queryKey: ["voice-records"] });
  };

  const refreshAcp = () => {
    queryClient.invalidateQueries({ queryKey: ["asr-audiocpp-models"] });
    queryClient.invalidateQueries({ queryKey: ["asr-audiocpp-status"] });
  };

  const downloadModel = useMutation({
    mutationFn: (m: AsrModelItem) =>
      rpcClient.startModelDownload({ repo: m.repo, fileName: m.fileName, category: "asr" }),
    onSuccess: refresh,
    onError: (e) => setTError(String(e)),
  });
  const startModel = useMutation({
    mutationFn: (m: AsrModelItem) => rpcClient.startAsr({ model: m.fileName }),
    onSuccess: (r) => {
      setTError(r.ok ? undefined : r.error ?? t("voice.engine.startFailed"));
      refresh();
    },
    onError: (e) => setTError(String(e)),
  });
  const stopEngine = useMutation({
    mutationFn: () => rpcClient.stopAsr(),
    onSuccess: (r) => {
      if (r && !r.ok) setTError(r.error ?? t("voice.engine.stopFailed"));
      refresh();
    },
    onError: (e) => setTError(String(e)),
  });
  const whisperPending = downloadModel.isPending || startModel.isPending || stopEngine.isPending;

  // 一键安装 whisper.cpp 引擎（whisper-cli / whisper-server）。
  const installWhisperEngine = useMutation({
    mutationFn: () => rpcClient.downloadWhisperEngine(),
    onSuccess: (r) => {
      setTError(r.ok ? undefined : r.error ?? t("voice.engine.installFailed"));
      refresh();
    },
    onError: (e) => setTError(String(e)),
  });

  const acpDownloadEngine = useMutation({
    mutationFn: () => rpcClient.downloadTtsLocalEngine(),
    onSuccess: (r) => {
      setTError(r.ok ? undefined : r.error);
      refreshAcp();
    },
    onError: (e) => setTError(String(e)),
  });
  const acpDownloadModel = useMutation({
    mutationFn: (m: AsrAudioCppModelInfo) =>
      rpcClient.startModelDownload({
        repo: AUDIOCPP_REPO,
        fileName: m.repoPath,
        category: "asr",
        source: "huggingface",
      }),
    onSuccess: refreshAcp,
  });
  const acpStart = useMutation({
    mutationFn: (m: AsrAudioCppModelInfo) => rpcClient.startAsrAudioCpp({ modelId: m.id }),
    onSuccess: (r, m) => {
      setTError(r.ok ? undefined : r.error ?? t("voice.engine.startFailed"));
      if (r.ok) setAcpModelId(m.id);
      refresh();
    },
    onError: (e) => setTError(String(e)),
  });
  const acpStop = useMutation({
    mutationFn: () => rpcClient.stopAsrAudioCpp(),
    onSuccess: (r) => {
      if (r && !r.ok) setTError(r.error ?? t("voice.engine.stopFailed"));
      refresh();
    },
    onError: (e) => setTError(String(e)),
  });
  const acpDelete = useMutation({
    mutationFn: (m: AsrAudioCppModelInfo) => rpcClient.deleteAsrAudioCppModel({ modelId: m.id }),
    onSuccess: (r) => {
      if (!r.ok) setTError(r.error ?? t("voice.engine.deleteFailed"));
      refreshAcp();
    },
    onError: (e) => setTError(String(e)),
  });
  const acpPending =
    acpDownloadEngine.isPending ||
    acpDownloadModel.isPending ||
    acpStart.isPending ||
    acpStop.isPending ||
    acpDelete.isPending;

  const selectedAcp = acpModels.find((m) => m.id === acpModelId);

  // ---------- OpenAI 兼容 API provider（厂商 + 模型，连接信息在设置里） ----------
  const [pProviderId, setPProviderId] = useState("");
  const [pModel, setPModel] = useState("");
  const [pError, setPError] = useState<string>();
  const providerSynced = useRef(false);

  const { data: providerData } = useQuery({
    queryKey: ["asr-provider"],
    queryFn: () => rpcClient.getASRProviderConfig(),
  });
  const provider = providerData?.config;
  const providerConfigured = !!provider?.providerId;
  useEffect(() => {
    if (provider && !providerSynced.current) {
      providerSynced.current = true;
      setPProviderId(provider.providerId);
      setPModel(provider.model);
    }
  }, [provider]);

  const saveProvider = useMutation({
    // 同 TTS：选择值由调用方传进来，避免读到这一次渲染的旧值。
    mutationFn: (choice: { providerId?: string; model?: string } = {}) =>
      rpcClient.saveASRProviderConfig({
        providerId: (choice?.providerId ?? pProviderId).trim(),
        model: (choice?.model ?? pModel).trim(),
      }),
    onSuccess: () => {
      setPError(undefined);
      queryClient.invalidateQueries({ queryKey: ["asr-provider"] });
      queryClient.invalidateQueries({ queryKey: ["cloud-providers"] });
    },
    onError: (error) => setPError(error instanceof Error ? error.message : String(error)),
  });

  const handleResult = (r: {
    text?: string;
    engine?: string;
    segments?: AsrSegment[];
    hasSpeakers?: boolean;
    error?: string;
  }) => {
    if (r.error) {
      setTError(r.error);
      return;
    }
    setTError(undefined);
    setMeta(r.engine ?? null);
    if (r.segments?.length) {
      setSegments(r.segments);
      setHasSpeakers(!!r.hasSpeakers);
      setPlainText("");
    } else {
      setSegments([]);
      setHasSpeakers(false);
      setPlainText(r.text ?? "");
    }
    refresh();
  };

  const transcribe = useMutation({
    mutationFn: (p: { audioRef?: string; wavBase64?: string }) =>
      rpcClient.transcribeAudio({
        ...p,
        save: true,
        source: engineMode === "api" ? "remote" : "local",
        diarize: speakerMode,
        model: engineMode === "api" ? pModel.trim() || undefined : undefined,
      }),
    onSuccess: handleResult,
  });

  // 录音是否还在进行（供 liveTranscribe 回调判断，避免停止后回写旧结果）。
  const recordingRef = useRef(false);

  const liveTranscribe = useMutation({
    mutationFn: (wav: string) =>
      rpcClient.transcribeAudio({
        wavBase64: wav,
        save: false,
        source: engineMode === "api" ? "remote" : "local",
        diarize: speakerMode,
        model: engineMode === "api" ? pModel.trim() || undefined : undefined,
      }),
    onSuccess: (r) => {
      if (r.error || !recordingRef.current) return;
      const segs = r.segments;
      if (segs?.length) {
        setSegments((prev) => mergeSegments(prev, segs));
        setHasSpeakers((prev) => prev || !!r.hasSpeakers);
      } else if (r.text) {
        setPlainText(r.text);
      }
    },
  });

  // 同一时间只允许一个实时轮询请求，避免积压。
  const liveBusyRef = useRef(false);
  useEffect(() => {
    liveBusyRef.current = liveTranscribe.isPending;
  }, [liveTranscribe.isPending]);

  // 电平回调约 10fps 节流，避免整页高频重渲染。
  const lastLevelEmit = useRef(0);
  const recorder = useMicRecorder(
    (wav) => {
      if (!liveBusyRef.current) liveTranscribe.mutate(wav);
    },
    (l) => {
      const now = performance.now();
      if (now - lastLevelEmit.current > 100) {
        lastLevelEmit.current = now;
        setLevel(l);
      }
    },
  );

  useEffect(() => {
    recordingRef.current = recorder.recording;
  }, [recorder.recording]);

  const handleMicStart = () => {
    setSegments([]);
    setPlainText("");
    setHasSpeakers(false);
    setMeta(null);
    setTError(undefined);
    setJumpIndex(null);
    recorder.start();
  };

  const handleMicStop = () => {
    const wav = recorder.finish();
    transcribe.mutate({ wavBase64: wav });
  };

  // 录音中的计时。
  useEffect(() => {
    if (!recorder.recording) {
      setElapsed(0);
      return;
    }
    const startedAt = Date.now();
    const iv = setInterval(() => setElapsed((Date.now() - startedAt) / 1000), 250);
    return () => clearInterval(iv);
  }, [recorder.recording]);

  const pick = useMutation({
    mutationFn: async () => {
      const { paths } = await rpcClient.openFileDialog({
        allowedFileTypes: "mp3,wav,m4a,aac,flac,ogg,opus,webm,wma,mp4",
      });
      if (paths.length === 0) return;
      const { files } = await rpcClient.stageAudio({ paths });
      if (files[0]) setAudio(files[0]);
    },
  });

  useEffect(() => {
    setMicError(recorder.error);
  }, [recorder.error]);

  return (
    <div className="flex h-full min-h-0">
      {/* 左侧：引擎与参数面板（与生图页同款布局） */}
      <aside className="w-[340px] shrink-0 overflow-y-auto border-r p-4">
        <div className="flex flex-col gap-5">
          {/* 推理引擎切换 */}
          <div>
            <Label className="mb-1.5 block text-xs">{t("voice.asr.engine")}</Label>
            <SegmentedControl
              variant="attached"
              value={engineMode}
              onChange={switchEngine}
              options={[
                { value: "whisper", label: t("voice.asrAudiocpp.engineWhisper"), icon: <ServerIcon className="size-3.5" /> },
                { value: "audiocpp", label: t("voice.asrAudiocpp.engineAcp"), icon: <CpuIcon className="size-3.5" /> },
                { value: "api", label: t("voice.asr.sourceRemote"), icon: <GlobeIcon className="size-3.5" /> },
              ]}
            />
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              {engineMode === "whisper"
                ? t("voice.asr.desc")
                : engineMode === "audiocpp"
                  ? t("voice.asrAudiocpp.desc")
                  : t("voice.asr.compatDesc")}
            </p>
          </div>

          {engineMode === "whisper" && (
            <>
              {/* 引擎状态 */}
              <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
                <ServerIcon className="size-4 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{t("voice.asrAudiocpp.engineWhisper")}</p>
                  <p className="text-xs text-muted-foreground">
                    {status?.engine === "none"
                      ? t("voice.asr.engineNone")
                      : status?.engine === "whisper-server"
                        ? t("voice.asr.engineServer")
                        : t("voice.asr.engineCli")}
                    {status?.engineVersion ? ` · v${status.engineVersion}` : ""}
                    {status ? ` · ${t("voice.asr.port")} ${status.port}` : ""}
                  </p>
                </div>
                {!status?.engineInstalled ? (
                  <Button size="sm" disabled={installWhisperEngine.isPending} onClick={() => installWhisperEngine.mutate()}>
                    {installWhisperEngine.isPending ? (
                      <Loader2Icon data-icon="inline-start" className="animate-spin" />
                    ) : (
                      <DownloadCloudIcon data-icon="inline-start" />
                    )}
                    {installWhisperEngine.isPending
                      ? t("voice.asr.installingEngine")
                      : t("voice.asr.installEngine")}
                  </Button>
                ) : (
                  <Badge variant={serverRunning ? "default" : "secondary"} className="gap-1 text-[10px]">
                    {serverRunning ? (
                      <>
                        <CircleIcon className="size-2.5 fill-current" />
                        {t("voice.asr.running")}
                      </>
                    ) : (
                      t("voice.asr.notRunning")
                    )}
                  </Badge>
                )}
              </div>

              {/* 识别语言：默认中文，避免短句中文被 whisper 误判成英文 */}
              <div>
                <Label className="mb-1.5 block text-xs">{t("voice.asr.lang")}</Label>
                <Select
                  value={asrLang}
                  onValueChange={(v) => {
                    setAsrLang(v);
                    void rpcClient.updateSettings({ settings: { ASR_LANG: v } });
                  }}
                >
                  <SelectTrigger className="h-8 w-full text-xs">
                    <SelectValue placeholder={t("voice.asr.langAuto")} />
                  </SelectTrigger>
                  <SelectContent>
                    {(
                      [
                        { v: "auto", label: t("voice.asr.langAuto") },
                        { v: "zh", label: t("voice.asr.langZh") },
                        { v: "en", label: t("voice.asr.langEn") },
                        { v: "ja", label: t("voice.asr.langJa") },
                        { v: "ko", label: t("voice.asr.langKo") },
                      ] as const
                    ).map((o) => (
                      <SelectItem key={o.v} value={o.v}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  {t("voice.asr.langHint")}
                </p>
              </div>

              {/* whisper.cpp ASR 模型 */}
              <div>
                <h3 className="mb-2 flex items-center gap-2 text-sm font-medium">
                  <AudioLinesIcon className="size-4 text-muted-foreground" />
                  {t("voice.asr.models")}
                  <span className="text-xs font-normal text-muted-foreground">
                    {t("voice.asr.modelsHint")}
                  </span>
                </h3>
                <div className="flex flex-col gap-2">
                  {[...models]
                    .sort(
                      (a, b) =>
                        Number(b.fileName === DEFAULT_ASR_MODEL_FILE) -
                        Number(a.fileName === DEFAULT_ASR_MODEL_FILE),
                    )
                    .map((m) => (
                      <AsrModelRow
                        key={m.id}
                        model={m}
                        status={status}
                        pending={whisperPending}
                        onDownload={(mm) => downloadModel.mutate(mm)}
                        onStart={(mm) => startModel.mutate(mm)}
                        onStop={() => stopEngine.mutate()}
                      />
                    ))}
                </div>
              </div>
            </>
          )}

          {engineMode === "audiocpp" && (
            <>
              {/* 引擎状态 */}
              <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
                <CpuIcon className="size-4 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{t("voice.asrAudiocpp.engineAcp")}</p>
                  <p className="text-xs text-muted-foreground">
                    {!acpStatus?.engineInstalled
                      ? t("voice.asrAudiocpp.engineNone")
                      : `${t("voice.asrAudiocpp.engineReady")}${
                          acpStatus.binaryPath ? ` · ${acpStatus.binaryPath}` : ""
                        }`}
                    {acpStatus?.active
                      ? ` · ${t("voice.local.running")}`
                      : ` · ${t("voice.local.notStarted")}`}
                  </p>
                </div>
                {!acpStatus?.engineInstalled ? (
                  <Button size="sm" disabled={acpDownloadEngine.isPending} onClick={() => acpDownloadEngine.mutate()}>
                    {acpDownloadEngine.isPending ? (
                      <Loader2Icon data-icon="inline-start" className="animate-spin" />
                    ) : (
                      <DownloadCloudIcon data-icon="inline-start" />
                    )}
                    {acpDownloadEngine.isPending
                      ? t("voice.asrAudiocpp.downloadingEngine")
                      : t("voice.asrAudiocpp.downloadEngine")}
                  </Button>
                ) : (
                  <Badge variant="default" className="gap-1 text-[10px]">
                    <CircleIcon className="size-2.5 fill-current" />
                    {t("voice.asrAudiocpp.engineReady")}
                  </Badge>
                )}
              </div>

              {/* audio.cpp ASR 模型 */}
              <div>
                <h3 className="mb-2 flex items-center gap-2 text-sm font-medium">
                  <AudioLinesIcon className="size-4 text-muted-foreground" />
                  {t("voice.asrAudiocpp.models")}
                  <span className="text-xs font-normal text-muted-foreground">
                    {t("voice.asrAudiocpp.modelsHint")}
                  </span>
                </h3>
                <div className="flex flex-col gap-2">
                  {acpModels.map((m) => (
                    <AsrAudioCppModelRow
                      key={m.id}
                      model={m}
                      status={acpStatus}
                      pending={acpPending}
                      onDownload={(mm) => acpDownloadModel.mutate(mm)}
                      onStart={(mm) => acpStart.mutate(mm)}
                      onStop={() => acpStop.mutate()}
                      onDelete={(mm) => acpDelete.mutate(mm)}
                    />
                  ))}
                </div>
              </div>

              {/* 选择识别模型（选中即启用） */}
              <div>
                <Label className="mb-1 block text-xs">{t("voice.asrAudiocpp.select")}</Label>
                {acpModels.filter((m) => m.downloaded).length === 0 ? (
                  <div className="flex items-center justify-center rounded-lg border border-dashed px-4 py-6 text-xs text-muted-foreground">
                    {t("voice.local.empty")}
                  </div>
                ) : (
                  <Select
                    value={acpModelId}
                    onValueChange={(v) => {
                      setAcpModelId(v);
                      setTError(undefined);
                      const m = acpModels.find((x) => x.id === v);
                      if (m?.downloaded) acpStart.mutate(m);
                    }}
                  >
                    <SelectTrigger className="h-8 w-full text-xs">
                      <SelectValue placeholder={t("voice.asrAudiocpp.select")} />
                    </SelectTrigger>
                    <SelectContent>
                      {acpModels
                        .filter((m) => m.downloaded)
                        .map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            {m.name}
                            {m.active ? ` · ${t("voice.local.active")}` : ""}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                )}
                {selectedAcp && !selectedAcp.downloaded && (
                  <p className="mt-1 text-xs text-amber-600">{t("voice.asrAudiocpp.needModel")}</p>
                )}
                {acpStatus?.active && selectedAcp && !selectedAcp.active && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {t("voice.asrAudiocpp.selectHint")}
                  </p>
                )}
              </div>
            </>
          )}

          {engineMode === "api" && (
            <>
              {/* 服务配置：云厂商 + 模型（地址与密钥由厂商行提供，页面不再手填） */}
              <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-xs font-medium">
                    <GlobeIcon className="size-3.5 text-muted-foreground" />
                    {t("voice.asr.providerTitle")}
                  </span>
                  {providerConfigured && (
                    <Badge variant="secondary" className="gap-1 text-[10px]">
                      <CircleIcon className="size-2.5 fill-current text-emerald-500" />
                      {t("voice.compat.configured")}
                    </Badge>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground">{t("voice.asr.compatDesc")}</p>

                {/* 厂商 + 模型：只列「设置 → 模型云服务」里已启动厂商的 ASR 模型 */}
                <div>
                  <Label className="mb-1 block text-xs">{t("voice.asr.cloudProvider")}</Label>
                  <CloudModelSelect
                    kind="asr"
                    providerId={pProviderId}
                    model={pModel}
                    size="sm"
                    onChange={(choice) => {
                      // 同 TTS：选完即存，否则"改了模型没保存就转写"会拿旧厂商的地址发新模型名。
                      setPProviderId(choice.providerId);
                      if (choice.model) setPModel(choice.model);
                      saveProvider.mutate(choice);
                    }}
                  />
                  <p className="mt-1.5 text-[10px] text-muted-foreground">{t("cloud.where")}</p>
                </div>

                {/* 保存 */}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button
                    size="sm"
                    onClick={() => saveProvider.mutate({})}
                    disabled={saveProvider.isPending || !pProviderId.trim()}
                  >
                    {saveProvider.isPending ? (
                      <Loader2Icon data-icon="inline-start" className="animate-spin" />
                    ) : (
                      <SaveIcon data-icon="inline-start" />
                    )}
                    {t("voice.compat.save")}
                  </Button>
                </div>
                {pError && <ResultError error={pError} />}
              </div>
            </>
          )}

          {/* 参数：人声分离开关 */}
          <div className="flex items-center justify-between gap-2 rounded-lg border bg-card p-3">
            <span className="text-xs font-medium">{t("voice.asr.spkSeparate")}</span>
            <button
              type="button"
              onClick={() => setSpeakerMode((v) => !v)}
              aria-pressed={speakerMode}
              className={cn(
                "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors",
                speakerMode ? "border-primary bg-primary" : "border-border bg-muted",
              )}
            >
              <span
                className={cn(
                  "inline-block size-3.5 transform rounded-full bg-background shadow-sm transition-transform",
                  speakerMode ? "translate-x-[18px]" : "translate-x-[2px]",
                )}
              />
            </button>
          </div>

          {/* 上传音频 */}
          <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-xs font-medium">
                <FileAudioIcon className="size-3.5 text-muted-foreground" />
                {t("voice.asr.uploadTitle")}
              </span>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="sm" disabled={pick.isPending} onClick={() => pick.mutate()}>
                  {pick.isPending ? <Spinner data-icon="inline-start" /> : <FileAudioIcon data-icon="inline-start" />}
                  {audio ? t("voice.asr.picked") : t("voice.asr.pick")}
                </Button>
                {audio && (
                  <Button variant="ghost" size="icon-sm" tooltip={t("voice.remove")} onClick={() => setAudio(null)}>
                    <XIcon className="size-4" />
                  </Button>
                )}
              </div>
            </div>
            {audio && <PlayAudio url={audio.url} />}
          </div>

          {/* 麦克风录音 */}
          <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
            <span className="flex items-center gap-1.5 text-xs font-medium">
              <MicIcon className="size-3.5 text-muted-foreground" />
              {t("voice.asr.micTitle")}
            </span>
            <div className="flex items-center gap-3">
              {!recorder.recording ? (
                <Button onClick={handleMicStart}>
                  <MicIcon data-icon="inline-start" />
                  {t("voice.asr.recordStart")}
                </Button>
              ) : (
                <Button variant="destructive" onClick={handleMicStop}>
                  <SquareIcon data-icon="inline-start" />
                  {t("voice.asr.recordStop")}
                </Button>
              )}
              {recorder.recording && (
                <>
                  <span className="flex items-center gap-1.5 text-xs text-destructive">
                    <CircleIcon className="size-2.5 animate-pulse fill-current" />
                    {t("voice.asr.recording")}
                  </span>
                  <span className="flex items-center gap-1 font-mono text-xs text-muted-foreground tabular-nums">
                    <TimerIcon className="size-3.5" />
                    {fmtClock(elapsed)}
                  </span>
                </>
              )}
            </div>
            {recorder.recording && (
              <>
                <LevelMeter level={level} />
                <p className="text-[11px] text-muted-foreground">{t("voice.asr.liveHint")}</p>
              </>
            )}
          </div>

          {(micError || tError || (transcribe.isError ? String(transcribe.error) : undefined) || (liveTranscribe.isError ? String(liveTranscribe.error) : undefined)) && (
            <ResultError
              error={micError ?? tError ?? (transcribe.isError ? String(transcribe.error) : String(liveTranscribe.error))}
            />
          )}

          {/* 识别 */}
          <Button
            size="lg"
            className="w-full"
            onClick={() => audio && transcribe.mutate({ audioRef: audio.ref })}
            disabled={!audio || transcribe.isPending}
          >
            {transcribe.isPending ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <MicIcon data-icon="inline-start" />
            )}
            {transcribe.isPending ? t("voice.asr.transcribing") : t("voice.asr.transcribe")}
          </Button>
        </div>
      </aside>

      {/* 右侧：结果区 */}
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1 items-center justify-center p-8">
          {plainText || segments.length > 0 ? (
            <div className="h-full w-full max-w-3xl">
              <TranscriptViewer
                segments={segments}
                text={plainText}
                engine={meta ?? undefined}
                hasSpeakers={hasSpeakers}
                speakerMode={speakerMode}
                streaming={recorder.recording && liveTranscribe.isPending}
                jumpIndex={jumpIndex}
                onJump={(i) => setJumpIndex(i)}
              />
            </div>
          ) : (
            <ResultEmpty
              icon={<MicIcon className="size-9 text-primary" />}
              title={t("voice.asr.emptyTitle")}
              hint={t("voice.asr.emptyHint")}
            />
          )}
        </div>
      </main>
    </div>
  );
}

