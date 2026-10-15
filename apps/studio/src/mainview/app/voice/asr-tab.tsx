import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AudioLinesIcon, XIcon, Loader2Icon, FileAudioIcon, SquareIcon, PlayIcon, CircleIcon, ServerIcon, DownloadCloudIcon, GlobeIcon, SaveIcon, CpuIcon, TrashIcon, BotIcon, MicIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { CloudModelSelect } from "@components/cloud-model-select";
import { ResultError } from "@components/media-result";
import { SegmentedControl } from "@components/segmented-control";
import { Button } from "@ui/button";
import { Label } from "@ui/label";
import { Badge } from "@ui/badge";
import { Spinner } from "@ui/spinner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { useT } from "@stores/ui-lang";
import { useModelDownloadStore } from "@stores/model-download";
import { useMicRecorder } from "@hooks/use-mic-recorder";
import { useLiveDictation } from "@hooks/use-live-dictation";
import type { AsrModelItem, AsrSegment, AsrStatus } from "../../../bun/asr";
import type { AsrAudioCppModelInfo, AsrAudioCppStatus } from "../../../bun/asr-audiocpp";
import type { AsrConfuciusModelInfo, AsrConfuciusStatus } from "../../../bun/asr-confucius";
import { AsrResultPane, mergeSegments } from "./asr-result";
import { AUDIOCPP_REPO } from "@/shared/audiocpp";
import { CONFUCIUS_ASR_REPO, CONFUCIUS_ASR_LICENSE_URL } from "@/shared/asr-confucius";
import { normalizeScene, type AsrSceneId } from "@/shared/asr-insights";
import { applySensitivity, DEFAULT_VAD_CONFIG, type VadSensitivity } from "@/shared/asr-vad";
import { offsetUtteranceSegments } from "@lib/segments";
import { DEFAULT_ASR_MODEL_FILE } from "@/shared/modelscope";
import { PlayAudio, SettingsValues, formatBytes } from "./parts";
import { useFocusedVoiceRecord } from "./use-focused-record";

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

function AsrConfuciusModelRow({
  model,
  status,
  pending,
  onDownload,
  onStart,
  onStop,
  onDelete,
}: {
  model: AsrConfuciusModelInfo;
  status?: AsrConfuciusStatus;
  pending: boolean;
  onDownload: (m: AsrConfuciusModelInfo) => void;
  onStart: (m: AsrConfuciusModelInfo) => void;
  onStop: () => void;
  onDelete: (m: AsrConfuciusModelInfo) => void;
}) {
  const t = useT();
  const tasks = useModelDownloadStore((s) => s.tasks);
  // 主模型 + 音频编码器是两次独立下载，任一在跑都算下载中。
  const mainTask = tasks.find((x) => x.repo === CONFUCIUS_ASR_REPO && x.fileName === model.mainFile);
  const mmprojTask = tasks.find((x) => x.repo === CONFUCIUS_ASR_REPO && x.fileName === model.mmprojFile);
  const activeTask = (mainTask?.status === "downloading" || mainTask?.status === "queued")
    ? mainTask
    : (mmprojTask?.status === "downloading" || mmprojTask?.status === "queued")
      ? mmprojTask
      : undefined;
  const downloading = !!activeTask;
  const running = model.active && !!status?.serverRunning;

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
          {!model.mainInstalled && mainTask?.status === "failed" && (
            <Badge variant="destructive" className="text-[10px]">
              {t("voice.failed")}
            </Badge>
          )}
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{model.description}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground/70 tabular-nums">
          {model.languages.join(" / ")} · {formatBytes(model.totalInstalledSize ?? model.totalSizeBytes)}
          {model.totalInstalledSize ? ` · ${t("voice.local.installed")}` : ""}
        </p>
        {/* 模型 id / 文件名全称不截断：它是用户要复述到 API 调用里的东西 */}
        <p className="mt-0.5 break-all text-[10px] text-muted-foreground/60 tabular-nums">
          {model.mainInstalled || model.mmprojInstalled ? "✓ " : ""}
          {model.mainFile} + {model.mmprojFile}
        </p>
        {downloading && activeTask && (
          <div className="mt-1.5 h-1.5 w-full max-w-56 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300"
              style={{ width: `${activeTask.percent ?? 0}%` }}
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
              ? `${activeTask?.percent != null ? Math.round(activeTask.percent) : 0}%`
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

/** 文件名（路径最后一段），用于控制台上的来源胶囊。 */
function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

export function AsrTab() {
  const t = useT();
  const queryClient = useQueryClient();
  const settings = SettingsValues();
  const [asrLang, setAsrLang] = useState(settings.asrLang);
  const [audio, setAudio] = useState<{ ref: string; url: string; name: string } | null>(null);
  const [meta, setMeta] = useState<string | null>(null);
  const [tError, setTError] = useState<string | undefined>();
  const [micError, setMicError] = useState<string | undefined>();
  // 「跑一次」的错误（转写 / 实时转写 / 麦克风）显示在右侧工作台 —— 报错的地方就是按按钮的地方；
  // tError 留给引擎安装 / 启停这类左栏配置错误，pError 在 API 卡片里就地显示。
  const [runError, setRunError] = useState<string | undefined>();
  // UI 视图态：whisper / 本地 GGUF（audio.cpp + Confucius4 合并）/ API。
  // 与设置态 ASR_ENGINE 分离 —— 点某个 GGUF 模型的「启动」时才写 ASR_ENGINE。
  const [engineMode, setEngineMode] = useState<"whisper" | "gguf" | "api">("whisper");
  // 本地 GGUF 区块内的引擎二级选择（视图态，不写 ASR_ENGINE）。
  const [ggufEngine, setGgufEngine] = useState<"audiocpp" | "confucius">("audiocpp");
  const [segments, setSegments] = useState<AsrSegment[]>([]);
  const [hasSpeakers, setHasSpeakers] = useState(false);
  const [plainText, setPlainText] = useState("");
  const [speakerMode, setSpeakerMode] = useState(true);
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  // 场景（写 ASR_SCENE）：决定整理的默认动作与人声分离默认值。
  const [scene, setScene] = useState<AsrSceneId>("general");
  // 实时转写暂停：录音继续，但先不往识别服务发（省算力、也让用户可以安静几秒）。
  const [livePaused, setLivePaused] = useState(false);
  // 这份稿子的来源：麦克风 or 音频文件（控制台的来源胶囊按它显示）。
  const [lastSource, setLastSource] = useState<"mic" | "file">("mic");
  /**
   * 采集模式：
   *   auto   —— 一直听着，按静音自动切句，说一句出一句（默认；"边说话边出字"就是这个）
   *   manual —— 手动按开始/停止，录一整段再转（适合有明确始终点的场景，如采访录音）
   */
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  // 自动切句的两个旋钮（存 ASR_VAD）：灵敏度与"停顿多久算说完"。
  const [vadSensitivity, setVadSensitivity] = useState<VadSensitivity>("medium");
  const [silenceMs, setSilenceMs] = useState(1000);
  /** 正在说的这一句的中间识别结果（灰色预览行，收句后被正式结果替换）。 */
  const [interim, setInterim] = useState<string | null>(null);
  /**
   * 左侧历史里点开的那条记录：右侧这时显示的是**那次任务**的稿子，
   * 而不是手上这份草稿（开始采集 / 转写文件时自动让位，见下面几个 handler）。
   */
  const { record: historyRecord, setFocusRecordId } = useFocusedVoiceRecord();

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

  // ---------- Confucius4-R2T2 engine (llama.cpp) ----------
  const { data: confuciusStatus } = useQuery({
    queryKey: ["asr-confucius-status"],
    queryFn: () => rpcClient.getAsrConfuciusStatus(),
    refetchInterval: 2500,
  });

  const { data: confuciusModelsData } = useQuery({
    queryKey: ["asr-confucius-models"],
    queryFn: () => rpcClient.listAsrConfuciusModels(),
  });
  const confuciusModels = confuciusModelsData?.models ?? [];

  // 恢复上次选择的引擎（ASR_ENGINE）与场景（ASR_SCENE）。
  const engineHydrated = useRef(false);
  useEffect(() => {
    if (!settings.loaded || engineHydrated.current) return;
    engineHydrated.current = true;
    setEngineMode(
      settings.asrEngine === "audiocpp" || settings.asrEngine === "confucius"
        ? "gguf"
        : settings.asrEngine === "api"
          ? "api"
          : "whisper",
    );
    setGgufEngine(settings.asrEngine === "confucius" ? "confucius" : "audiocpp");
    setScene(normalizeScene(settings.asrScene));
    const savedVad = parseVadPrefs(settings.asrVad);
    setVadSensitivity(savedVad.sensitivity);
    setSilenceMs(savedVad.silenceMs);
  }, [settings]);

  const switchEngine = (mode: "whisper" | "gguf" | "api") => {
    setEngineMode(mode);
    setTError(undefined);
    if (mode === "gguf") {
      // GGUF 视图不写 ASR_ENGINE：当前用哪个本地引擎由模型卡上的「启动」决定。
      return;
    }
    void rpcClient.updateSettings({ settings: { ASR_ENGINE: mode } });
    // 本地引擎与 API 模式互斥：切走时停掉 whisper-server（也会停 Confucius4 实例）。
    void rpcClient.stopAsr();
  };

  const pickScene = (next: AsrSceneId) => {
    setScene(next);
    void rpcClient.updateSettings({ settings: { ASR_SCENE: next } });
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
    queryClient.invalidateQueries({ queryKey: ["asr-confucius-models"] });
    queryClient.invalidateQueries({ queryKey: ["asr-confucius-status"] });
    queryClient.invalidateQueries({ queryKey: ["voice-records"] });
  };

  const refreshAcp = () => {
    queryClient.invalidateQueries({ queryKey: ["asr-audiocpp-models"] });
    queryClient.invalidateQueries({ queryKey: ["asr-audiocpp-status"] });
  };

  const refreshConfucius = () => {
    queryClient.invalidateQueries({ queryKey: ["asr-confucius-models"] });
    queryClient.invalidateQueries({ queryKey: ["asr-confucius-status"] });
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

  const confuciusDownloadModel = useMutation({
    mutationFn: (m: AsrConfuciusModelInfo) => {
      // 主模型 + 音频编码器两个文件都入队（下载管理支持续传，进度各自展示在下载列表）。
      void rpcClient.startModelDownload({
        repo: CONFUCIUS_ASR_REPO,
        fileName: m.mainFile,
        category: "asr",
        source: "huggingface",
      });
      return rpcClient.startModelDownload({
        repo: CONFUCIUS_ASR_REPO,
        fileName: m.mmprojFile,
        category: "asr",
        source: "huggingface",
      });
    },
    onSuccess: refreshConfucius,
  });
  const confuciusStart = useMutation({
    mutationFn: (m: AsrConfuciusModelInfo) => rpcClient.startAsrConfucius({ modelId: m.id }),
    onSuccess: (r) => {
      setTError(r.ok ? undefined : r.error ?? t("voice.engine.startFailed"));
      refresh();
    },
    onError: (e) => setTError(String(e)),
  });
  const confuciusStop = useMutation({
    mutationFn: () => rpcClient.stopAsrConfucius(),
    onSuccess: (r) => {
      if (r && !r.ok) setTError(r.error ?? t("voice.engine.stopFailed"));
      refresh();
    },
    onError: (e) => setTError(String(e)),
  });
  const confuciusDelete = useMutation({
    mutationFn: (m: AsrConfuciusModelInfo) => rpcClient.deleteAsrConfuciusModel({ modelId: m.id }),
    onSuccess: (r) => {
      if (!r.ok) setTError(r.error ?? t("voice.engine.deleteFailed"));
      refreshConfucius();
    },
    onError: (e) => setTError(String(e)),
  });
  const confuciusPending =
    confuciusDownloadModel.isPending ||
    confuciusStart.isPending ||
    confuciusStop.isPending ||
    confuciusDelete.isPending;

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
      setRunError(r.error);
      return;
    }
    setRunError(undefined);
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
    onError: (e) => setRunError(e instanceof Error ? e.message : String(e)),
  });

  // 录音是否还在进行（供 liveTranscribe 回调判断，避免停止后回写旧结果）。
  const recordingRef = useRef(false);
  // 实时转写暂停（与状态同步到 ref，供录音回调读取）。
  const livePausedRef = useRef(false);

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
      if (!recordingRef.current) return;
      if (r.error) {
        setRunError(r.error);
        return;
      }
      setRunError(undefined);
      const segs = r.segments;
      if (segs?.length) {
        setSegments((prev) => mergeSegments(prev, segs));
        setHasSpeakers((prev) => prev || !!r.hasSpeakers);
      } else if (r.text) {
        setPlainText(r.text);
      }
    },
    // 实时轮询失败不打断录音，第一次失败就把原因挂出来（成功一次后自动清掉）。
    onError: (e) => setRunError(e instanceof Error ? e.message : String(e)),
  });

  // ---------- 自动听写（VAD 切句，默认模式） ----------
  const vadConfig = useMemo(
    () =>
      applySensitivity(
        {
          ...DEFAULT_VAD_CONFIG,
          // 静音几帧算说完：帧长取默认 hop，1s 对应 16000/512 ≈ 31 帧。
          silenceHops: Math.max(4, Math.round((silenceMs / 1000) * 16000 / DEFAULT_VAD_CONFIG.hopSize)),
        },
        vadSensitivity,
      ),
    [silenceMs, vadSensitivity],
  );

  // 中间结果的请求闸门：上一次还没回来就跳过这一次，避免请求堆成一片。
  const interimBusyRef = useRef(false);
  /**
   * 中间结果的"代次"：每落一句正式结果就加一。
   * 请求是并发的，晚发出的那次中间识别可能后回来 —— 不认代次的话，收句后还会冒出一行
   * 已经过时的灰色预览，看着像卡住了。
   */
  const interimEpochRef = useRef(0);
  /** 还在识别中的句子数（界面上的"识别中"指示用；不影响追加顺序）。 */
  const dictationBusyRef = useRef(0);
  const handleInterim = (wav: string) => {
    if (interimBusyRef.current || livePaused) return;
    interimBusyRef.current = true;
    const epoch = interimEpochRef.current;
    void rpcClient
      .transcribeAudio({
        wavBase64: wav,
        save: false,
        source: engineMode === "api" ? "remote" : "local",
        // 中间结果只是给人看个大概，不做人声分离（省一半时间）。
        diarize: false,
        model: engineMode === "api" ? pModel.trim() || undefined : undefined,
      })
      .then((r) => {
        const text = (r.text ?? "").trim();
        // 代次变了说明这一句已经落定，这行预览是过期的，丢掉。
        if (!r.error && text && interimEpochRef.current === epoch) setInterim(text);
      })
      .catch(() => {})
      .finally(() => {
        interimBusyRef.current = false;
      });
  };

  /**
   * 一句说完：把这一句单独送去识别，再按它在整场录音里的位置贴回时间轴。
   * 引擎给的时间戳是相对于这一句的，只有加上 startSec 才能和别的句子排成一条时间轴。
   */
  const handleUtterance = (wav: string, meta: { startSec: number; endSec: number; durationSec: number }) => {
    if (livePaused) return;
    dictationBusyRef.current += 1;
    void rpcClient
      .transcribeAudio({
        wavBase64: wav,
        save: false,
        source: engineMode === "api" ? "remote" : "local",
        diarize: speakerMode,
        model: engineMode === "api" ? pModel.trim() || undefined : undefined,
      })
      .then((r) => {
        if (r.error) {
          setRunError(r.error);
          return;
        }
        setRunError(undefined);
        const segs = offsetUtteranceSegments(r.segments ?? [], r.text ?? "", meta);
        if (segs.length > 0) {
          setSegments((prev) => mergeSegments(prev, segs));
          setHasSpeakers((prev) => prev || !!r.hasSpeakers);
          setMeta((cur) => cur ?? r.engine ?? null);
        }
        // 正式结果到了才撤掉灰色预览行，中间不空窗；同时把代次推进，
        // 让还在路上的那次中间识别作废。
        interimEpochRef.current += 1;
        setInterim(null);
      })
      .catch((e) => setRunError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        dictationBusyRef.current -= 1;
      });
  };

  const dictation = useLiveDictation(handleUtterance, handleInterim, setLevel, {
    vad: vadConfig,
  });
  // 暂停开关同步给听写：放 ref 里而不是进依赖数组 —— setPaused 本身不依赖任何状态，
  // 但每次渲染都是新函数，写进依赖会每次重建 effect。
  const dictationRef = useRef(dictation);
  dictationRef.current = dictation;

  // 同一时间只允许一个实时轮询请求，避免积压。
  const liveBusyRef = useRef(false);
  useEffect(() => {
    liveBusyRef.current = liveTranscribe.isPending;
  }, [liveTranscribe.isPending]);

  // 电平回调约 10fps 节流，避免整页高频重渲染。
  const lastLevelEmit = useRef(0);
  const recorder = useMicRecorder(
    (wav) => {
      if (!liveBusyRef.current && !livePausedRef.current) liveTranscribe.mutate(wav);
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
    // 停止录音时把暂停态复位，下次录音默认是"实时转写中"。
    if (!recorder.recording) setLivePaused(false);
  }, [recorder.recording]);

  useEffect(() => {
    livePausedRef.current = livePaused;
    dictationRef.current.setPaused(livePaused);
  }, [livePaused]);

  const handleMicStart = () => {
    setSegments([]);
    setPlainText("");
    setHasSpeakers(false);
    setMeta(null);
    setRunError(undefined);
    setLastSource("mic");
    recorder.start();
  };

  const handleMicStop = () => {
    const wav = recorder.finish();
    transcribe.mutate({ wavBase64: wav });
  };

  // 手动模式下的错误也走右侧工作台；麦克风权限失败同样。
  useEffect(() => {
    if (recorder.error) setRunError(recorder.error);
  }, [recorder.error]);
  useEffect(() => {
    if (dictation.error) setRunError(dictation.error);
  }, [dictation.error]);

  // 采集中的计时（手动录音与自动听写共用）。
  const capturing = recorder.recording || dictation.listening;
  useEffect(() => {
    if (!capturing) {
      setElapsed(0);
      return;
    }
    const startedAt = Date.now();
    const iv = setInterval(() => setElapsed((Date.now() - startedAt) / 1000), 250);
    return () => clearInterval(iv);
  }, [capturing]);

  const pick = useMutation({
    mutationFn: async () => {
      const { paths } = await rpcClient.openFileDialog({
        allowedFileTypes: "mp3,wav,m4a,aac,flac,ogg,opus,webm,wma,mp4",
      });
      if (paths.length === 0) return;
      const { files } = await rpcClient.stageAudio({ paths });
      const first = files[0];
      if (first) setAudio({ ...first, name: baseName(paths[0] ?? first.ref) });
    },
  });

  useEffect(() => {
    setMicError(recorder.error);
  }, [recorder.error]);

  /** 转写暂存好的音频文件（控制台的主操作）。 */
  const transcribeFile = () => {
    if (!audio) return;
    setFocusRecordId(null);
    setSegments([]);
    setPlainText("");
    setHasSpeakers(false);
    setMeta(null);
    setRunError(undefined);
    setLastSource("file");
    transcribe.mutate({ audioRef: audio.ref });
  };

  /** 开始采集：自动听写一直听，手动模式录一整段。 */
  const handleStart = () => {
    // 采集的是新的一份：先把右侧从历史记录上收回来，否则录了半天界面还停在那条旧稿子上。
    setFocusRecordId(null);
    if (mode === "auto") {
      setSegments([]);
      setPlainText("");
      setHasSpeakers(false);
      setMeta(null);
      setInterim(null);
      setRunError(undefined);
      setLastSource("mic");
      setLivePaused(false);
      void dictation.start();
      return;
    }
    handleMicStart();
  };

  /** 停止采集：自动听写会把没等到静音的那半句先交出来（不丢最后一句）。 */
  const handleStop = () => {
    if (mode === "auto") {
      dictation.stop();
      return;
    }
    handleMicStop();
  };

  /**
   * 切模式：正在听/正在录的时候不许切（按钮此时是禁用的），
   * 真的切了就先把另一条链路停干净，避免两个采集同时开着。
   */
  const changeMode = (next: "auto" | "manual") => {
    if (next === mode) return;
    dictation.stop({ flush: false });
    if (recorder.recording) recorder.finish();
    setMode(next);
    setLivePaused(false);
    setInterim(null);
    setRunError(undefined);
  };

  /** 切句参数写回设置：调一次就记住，下次进来不用再调。 */
  const saveVadPrefs = (next: { sensitivity?: VadSensitivity; silenceMs?: number }) => {
    const value = {
      sensitivity: next.sensitivity ?? vadSensitivity,
      silenceMs: next.silenceMs ?? silenceMs,
    };
    if (next.sensitivity) setVadSensitivity(next.sensitivity);
    if (next.silenceMs) setSilenceMs(next.silenceMs);
    void rpcClient.updateSettings({ settings: { ASR_VAD: JSON.stringify(value) } });
  };

  const clearTranscript = () => {
    setFocusRecordId(null);
    setSegments([]);
    setPlainText("");
    setHasSpeakers(false);
    setMeta(null);
    setInterim(null);
    setRunError(undefined);
  };

  /** 控制台里的「识别目标」：当前实际会被用到的引擎 · 模型，只作展示。 */
  const target = (() => {
    if (engineMode === "whisper") {
      const active = status?.activeModel ? baseName(status.activeModel) : "";
      return `whisper.cpp · ${serverRunning && active ? active : t("voice.asr.notRunning")}`;
    }
    if (engineMode === "gguf") {
      if (ggufEngine === "audiocpp") {
        return `audio.cpp · ${selectedAcp?.name ?? t("voice.asr.notSelected")}`;
      }
      const activeConfucius = confuciusModels.find((m) => m.active);
      return `Confucius4 · ${activeConfucius?.name ?? t("voice.asr.notSelected")}`;
    }
    return `${t("voice.asr.sourceRemote")} · ${pModel.trim() || t("voice.asr.notSelected")}`;
  })();

  /**
   * 右侧要显示的那份稿子：左侧历史点开一条就是那条记录，否则是手上这份。
   * 两种来源只在这里合流 —— 工作台本身不认识"历史"，它只认一份稿子。
   * 记录里存的是整段文字（没有分段），所以按"纯文"那份走。
   */
  const viewing = historyRecord
    ? {
        segments: [] as AsrSegment[],
        text: historyRecord.text ?? "",
        engine: historyRecord.model ?? undefined,
        hasSpeakers: false,
        audioUrl: historyRecord.audioUrl ?? undefined,
      }
    : { segments, text: plainText, engine: meta ?? undefined, hasSpeakers, audioUrl: audio?.url };

  return (
    <div className="flex h-full min-h-0">
      {/* 左侧：引擎与参数面板（与生图页同款布局）。跑一次识别在右侧底部控制台。 */}
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
                { value: "gguf", label: t("voice.asr.engineGguf"), icon: <CpuIcon className="size-3.5" /> },
                { value: "api", label: t("voice.asr.sourceRemote"), icon: <GlobeIcon className="size-3.5" /> },
              ]}
            />
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              {engineMode === "whisper"
                ? t("voice.asr.desc")
                : engineMode === "gguf"
                  ? t("voice.asr.engineGgufDesc")
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

          {engineMode === "gguf" && (
            <>
              {/* 先选 GGUF 推理引擎，下面只列该引擎的模型（不写 ASR_ENGINE，点模型「启动」才写） */}
              <div>
                <Label className="mb-1.5 block text-xs">{t("voice.asr.ggufEngine")}</Label>
                <SegmentedControl
                  variant="attached"
                  value={ggufEngine}
                  onChange={setGgufEngine}
                  options={[
                    { value: "audiocpp", label: t("voice.asrAudiocpp.engineAcp"), icon: <CpuIcon className="size-3.5" /> },
                    { value: "confucius", label: t("voice.asrConfucius.engine"), icon: <BotIcon className="size-3.5" /> },
                  ]}
                />
              </div>

              {ggufEngine === "audiocpp" && (
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

              {ggufEngine === "confucius" && (
                <>
              {/* 引擎状态（llama.cpp 托管引擎，安装在 设置 → 模型引擎） */}
              <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
                <BotIcon className="size-4 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{t("voice.asrConfucius.engineTitle")}</p>
                  <p className="text-xs text-muted-foreground">
                    {!confuciusStatus?.engineInstalled
                      ? t("voice.asrConfucius.engineNone")
                      : `${t("voice.asrConfucius.engineReady")}${
                          confuciusStatus.llamaVersion ? ` · ${confuciusStatus.llamaVersion}` : ""
                        } · ${t("voice.asr.port")} ${confuciusStatus.port}`}
                    {confuciusStatus?.serverRunning
                      ? ` · ${t("voice.local.running")}`
                      : ` · ${t("voice.local.notStarted")}`}
                  </p>
                </div>
                {confuciusStatus?.serverRunning ? (
                  <Badge variant="default" className="gap-1 text-[10px]">
                    <CircleIcon className="size-2.5 fill-current" />
                    {t("voice.local.running")}
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="text-[10px]">
                    {t("voice.local.notStarted")}
                  </Badge>
                )}
              </div>
              {!confuciusStatus?.engineInstalled && (
                <p className="text-[11px] leading-relaxed text-amber-600">{t("voice.asrConfucius.engineHint")}</p>
              )}

              {/* Confucius4-R2T2 模型 */}
              <div>
                <h3 className="mb-2 flex items-center gap-2 text-sm font-medium">
                  <AudioLinesIcon className="size-4 text-muted-foreground" />
                  {t("voice.asrConfucius.models")}
                  <span className="text-xs font-normal text-muted-foreground">
                    {t("voice.asrConfucius.modelsHint")}
                  </span>
                </h3>
                <div className="flex flex-col gap-2">
                  {confuciusModels.map((m) => (
                    <AsrConfuciusModelRow
                      key={m.id}
                      model={m}
                      status={confuciusStatus}
                      pending={confuciusPending}
                      onDownload={(mm) => confuciusDownloadModel.mutate(mm)}
                      onStart={(mm) => confuciusStart.mutate(mm)}
                      onStop={() => confuciusStop.mutate()}
                      onDelete={(mm) => confuciusDelete.mutate(mm)}
                    />
                  ))}
                </div>
                <a
                  href={CONFUCIUS_ASR_LICENSE_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1.5 inline-block text-[10px] text-muted-foreground underline underline-offset-2"
                >
                  {t("voice.asrConfucius.license")}
                </a>
              </div>
                </>
              )}
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

                {/* 厂商 + 模型：只列「设置 → 云端模型」里已启动厂商的 ASR 模型 */}
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

          {/* 上传音频（识别在右侧控制台点「转写该文件」） */}
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
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    tooltip={t("voice.remove")}
                    onClick={() => {
                      setAudio(null);
                      if (lastSource === "file") clearTranscript();
                    }}
                  >
                    <XIcon className="size-4" />
                  </Button>
                )}
              </div>
            </div>
            {audio && <PlayAudio url={audio.url} />}
          </div>

          {/* 主操作在右侧控制台，这里给一句指路，避免用户在原位置找不到按钮 */}
          <p className="flex items-center gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
            <MicIcon className="size-3.5" />
            {t("voice.asr.dockHint")}
          </p>

          {/* 这里只留引擎安装 / 启停这类配置错误；转写与录音的错误显示在右侧工作台 */}
          {tError && <ResultError error={tError} />}
        </div>
      </aside>

      {/* 右侧：转写工作台（稿件 / 智能整理 / 控制台） */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <AsrResultPane
          segments={viewing.segments}
          text={viewing.text}
          engine={viewing.engine}
          hasSpeakers={viewing.hasSpeakers}
          streaming={!historyRecord && mode === "manual" && recorder.recording && liveTranscribe.isPending}
          audioUrl={viewing.audioUrl}
          source={lastSource}
          history={
            historyRecord
              ? { record: historyRecord, onClose: () => setFocusRecordId(null) }
              : undefined
          }
          error={historyRecord ? undefined : (micError ?? runError)}
          scene={scene}
          onScene={pickScene}
          speakerMode={speakerMode}
          onSpeakerMode={setSpeakerMode}
          target={target}
          onClear={clearTranscript}
          mode={mode}
          onMode={changeMode}
          listening={!historyRecord && dictation.listening}
          speaking={!historyRecord && dictation.speaking}
          interim={historyRecord ? null : interim}
          vadSensitivity={vadSensitivity}
          silenceMs={silenceMs}
          onVadSensitivity={(v) => saveVadPrefs({ sensitivity: v })}
          onVadSilence={(v) => saveVadPrefs({ silenceMs: v })}
          recording={!historyRecord && recorder.recording}
          paused={livePaused}
          level={level}
          elapsed={elapsed}
          onStart={handleStart}
          onStop={handleStop}
          onTogglePause={() => setLivePaused((v) => !v)}
          onTranscribeFile={transcribeFile}
          fileBusy={transcribe.isPending}
          fileReady={!!audio}
          fileName={historyRecord ? undefined : audio?.name}
        />
      </main>
    </div>
  );
}

/** `ASR_VAD` 的解析：坏值/空值一律回默认，绝不因为一条设置读不动就让听写起不来。 */
function parseVadPrefs(raw: string): { sensitivity: VadSensitivity; silenceMs: number } {
  const fallback = { sensitivity: "medium" as VadSensitivity, silenceMs: 1000 };
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as { sensitivity?: string; silenceMs?: number };
    const sensitivity: VadSensitivity =
      parsed.sensitivity === "low" || parsed.sensitivity === "high" ? parsed.sensitivity : "medium";
    const silenceMs =
      typeof parsed.silenceMs === "number" && parsed.silenceMs >= 300 && parsed.silenceMs <= 3000
        ? Math.round(parsed.silenceMs)
        : fallback.silenceMs;
    return { sensitivity, silenceMs };
  } catch {
    return fallback;
  }
}
