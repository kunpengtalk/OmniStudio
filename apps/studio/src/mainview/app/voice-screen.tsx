import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AudioLinesIcon,
  MicIcon,
  Wand2Icon,
  XIcon,
  Loader2Icon,
  Trash2Icon,
  FileAudioIcon,
  SparklesIcon,
  SquareIcon,
  PlayIcon,
  CircleIcon,
  ServerIcon,
  DownloadCloudIcon,
  ChevronsUpDownIcon,
  GlobeIcon,
  SearchIcon,
  SaveIcon,
  RefreshCwIcon,
  CpuIcon,
  TrashIcon,
  TimerIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import { Textarea } from "@ui/textarea";
import { Badge } from "@ui/badge";
import { Spinner } from "@ui/spinner";
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
import { useVoiceStore } from "@stores/voice";
import { useModelDownloadStore } from "@stores/model-download";
import { AudioDownloadButton, audioFileName } from "@components/audio-download";
import { useMicRecorder } from "@hooks/use-mic-recorder";
import type { AsrModelItem, AsrSegment, AsrStatus } from "../../bun/asr";
import type { AsrAudioCppModelInfo, AsrAudioCppStatus } from "../../bun/asr-audiocpp";
import { TranscriptViewer, mergeSegments, fmtClock } from "./voice-asr-result";
import { AUDIOCPP_REPO, AUDIOCPP_LANG_LABELS } from "@/shared/audiocpp";
import { DEFAULT_ASR_MODEL_FILE } from "@/shared/modelscope";
import { detectReferenceAudioSupport } from "@/shared/tts-reference-audio";
import type { TtsLocalModelInfo, TtsLocalStatus } from "../../bun/tts-local";
import type { VoiceClone, VoiceRecordRow } from "../../bun/voice";
import { cn } from "@/mainview/lib/utils";
import {
  DEFAULT_VOICE_BASE_URL,
  VOICE_PROVIDER_PRESETS,
  matchVoiceProvider,
} from "./voice-provider-presets";

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function PlayAudio({ url, className }: { url: string; className?: string }) {
  const t = useT();
  const [err, setErr] = useState(false);
  if (err) {
    return (
      <p className="rounded bg-muted/60 px-2 py-1 text-xs text-muted-foreground">
        {t("voice.records.missing")}
      </p>
    );
  }
  return <audio controls src={url} preload="none" className={cn("h-8 w-full", className)} onError={() => setErr(true)} />;
}

function ResultError({ error }: { error?: string }) {
  if (!error) return null;
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
      {error}
    </div>
  );
}

/**
 * 音频模型下拉：内置(服务商预设已知模型) + 已获取(/v1/models 拉取) 分组，
 * 支持关键字搜索；当前值不在列表中时也展示，保留手填能力。
 */
function AudioModelSelect({
  value,
  onChange,
  placeholder,
  builtin,
  fetched,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** 服务商预设的内置模型 ID */
  builtin: string[];
  /** 从 /v1/models 拉取的模型 ID */
  fetched: string[];
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const keyword = query.trim().toLowerCase();
  const matches = (m: string) => !keyword || m.toLowerCase().includes(keyword);

  const builtinList = [...new Set(builtin)].filter(matches);
  const fetchedList = [...new Set(fetched)].filter((m) => !builtin.includes(m) && matches(m));

  const closeAndReset = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };

  return (
    <Select
      value={value || undefined}
      open={open}
      onOpenChange={closeAndReset}
      onValueChange={(v) => {
        onChange(v);
        closeAndReset(false);
      }}
    >
      <SelectTrigger className="h-8 w-full text-xs">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent position="popper" sideOffset={6} className="max-w-80">
        <div
          className="sticky top-0 z-10 bg-popover p-1.5 pb-1"
          onKeyDown={(e) => e.stopPropagation()}
        >
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                closeAndReset(false);
              }
            }}
            placeholder={t("chat.modelSearch")}
            autoFocus
            className="h-7 text-xs"
          />
        </div>
        {value && !builtin.includes(value) && !fetched.includes(value) && (
          <SelectGroup>
            <SelectItem value={value}>
              <span className="truncate">{value}</span>
              <span className="truncate text-[10px] text-muted-foreground/70">
                {t("settings.integrations.currentValue")}
              </span>
            </SelectItem>
          </SelectGroup>
        )}
        {builtinList.length > 0 && (
          <SelectGroup>
            <SelectLabel>{t("voice.compat.builtin")}</SelectLabel>
            {builtinList.map((m) => (
              <SelectItem key={`builtin-${m}`} value={m}>
                <span className="truncate">{m}</span>
              </SelectItem>
            ))}
          </SelectGroup>
        )}
        {fetchedList.length > 0 && (
          <SelectGroup>
            <SelectLabel>{t("voice.compat.fetched")}</SelectLabel>
            {fetchedList.map((m) => (
              <SelectItem key={`fetched-${m}`} value={m}>
                <span className="truncate">{m}</span>
              </SelectItem>
            ))}
          </SelectGroup>
        )}
        {builtinList.length === 0 && fetchedList.length === 0 && (
          <div className="px-2 py-3 text-center text-xs text-muted-foreground">
            {query ? t("chat.modelNoMatch") : t("chat.modelEmpty")}
          </div>
        )}
      </SelectContent>
    </Select>
  );
}

function ResultPanel({ record, label }: { record?: VoiceRecordRow; label: string }) {
  const t = useT();
  if (!record) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-dashed px-4 py-8 text-xs text-muted-foreground">
        {label}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium">
          <SparklesIcon className="size-3.5 text-primary" />
          {t("voice.result")} · {record.model || record.voice || record.kind} ·{" "}
          {formatTime(record.createdAt)}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {record.status === "failed" && <Badge variant="destructive">{t("voice.failed")}</Badge>}
          {record.audioUrl && (
            <AudioDownloadButton
              url={record.audioUrl}
              filename={audioFileName(record.audioUrl, record.model || record.voice || "tts")}
            />
          )}
        </span>
      </div>
      {record.audioUrl ? (
        <PlayAudio url={record.audioUrl} />
      ) : (
        <p className="whitespace-pre-wrap text-xs">{record.text}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 生成中动画：跳动的频谱条正在“演奏”你的音频
// ---------------------------------------------------------------------------

function TtsLoading({ text }: { text: string }) {
  const t = useT();
  return (
    <div className="flex flex-col items-center gap-6">
      {/* 音浪画布 */}
      <div className="gen-canvas relative flex size-56 items-center justify-center overflow-hidden rounded-3xl border bg-gradient-to-b from-violet-100/70 to-fuchsia-200/60 dark:from-violet-950/40 dark:to-fuchsia-950/40">
        {/* 扩散光环 */}
        <span className="gen-ring pointer-events-none absolute inset-0 rounded-3xl border-2 border-fuchsia-400/70" />
        <span
          className="gen-ring pointer-events-none absolute inset-0 rounded-3xl border border-primary/40"
          style={{ animationDelay: "0.8s" }}
        />

        {/* 角落声波符号 */}
        <AudioLinesIcon
          className="gen-spark pointer-events-none absolute left-8 top-8 size-5 text-fuchsia-500/80"
          style={{ animationDelay: "0.3s" }}
        />
        <AudioLinesIcon
          className="gen-spark pointer-events-none absolute right-7 top-12 size-4 text-violet-500/70"
          style={{ animationDelay: "1.1s" }}
        />

        {/* 频谱条 */}
        <div className="flex h-28 items-end gap-1.5">
          {Array.from({ length: 14 }).map((_, i) => (
            <span
              key={i}
              className="tts-eq w-2 rounded-full bg-gradient-to-t from-violet-500 to-fuchsia-400"
              style={{ height: `${26 + ((i * 7) % 5) * 13}px`, animationDelay: `${i * 0.09}s` }}
            />
          ))}
        </div>
      </div>

      {/* 提示文字 */}
      <div className="flex max-w-sm flex-col items-center gap-2">
        <p className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Loader2Icon className="size-4 animate-spin text-primary" />
          {t("voice.tts.generating")}
        </p>
        {text && (
          <p className="gen-shimmer line-clamp-2 rounded-lg px-3 py-1 text-center text-xs text-muted-foreground">
            {text}
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 右侧结果区空状态
// ---------------------------------------------------------------------------

function ResultEmpty({ icon, title, hint }: { icon: React.ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 text-center">
      <div className="flex size-20 items-center justify-center rounded-2xl bg-primary/15">
        {icon}
      </div>
      <p className="text-lg font-medium">{title}</p>
      {hint && <p className="max-w-xs text-sm text-muted-foreground">{hint}</p>}
    </div>
  );
}

function SettingsValues() {
  const [settings, setSettings] = useState<{
    ttsModel: string;
    asrModel: string;
    asrLang: string;
    ttsVoice: string;
    edgeVoice: string;
    asrEngine: string;
  }>({
    ttsModel: "",
    asrModel: "",
    asrLang: "zh",
    ttsVoice: "alloy",
    edgeVoice: "zh-CN-XiaoxiaoNeural",
    asrEngine: "whisper",
  });
  const [loaded, setLoaded] = useState(false);
  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  useEffect(() => {
    if (data?.settings) {
      setSettings({
        ttsModel: data.settings.TTS_MODEL ?? "",
        asrModel: data.settings.ASR_MODEL ?? "",
        asrLang: data.settings.ASR_LANG || "zh",
        ttsVoice: data.settings.TTS_VOICE ?? "alloy",
        edgeVoice: data.settings.TTS_EDGE_VOICE ?? "zh-CN-XiaoxiaoNeural",
        asrEngine: data.settings.ASR_ENGINE ?? "whisper",
      });
      setLoaded(true);
    }
  }, [data]);
  return { ...settings, loaded };
}

function useClones() {
  const { data } = useQuery({
    queryKey: ["voice-clones"],
    queryFn: () => rpcClient.listVoiceClones(),
  });
  return data?.clones ?? [];
}

function EdgeVoicePicker({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const t = useT();
  const { data } = useQuery({
    queryKey: ["edge-voices"],
    queryFn: () => rpcClient.listEdgeVoices(),
  });
  const voices = data?.voices ?? [];
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  const selected = voices.find((v) => v.id === value);

  // 点击外部时收起下拉。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const ql = q.trim().toLowerCase();
  const filtered = ql
    ? voices.filter(
        (v) =>
          v.name.toLowerCase().includes(ql) ||
          v.id.toLowerCase().includes(ql) ||
          v.locale.toLowerCase().includes(ql) ||
          (v.desc ?? "").toLowerCase().includes(ql),
      )
    : voices;

  const groups = new Map<string, typeof filtered>();
  for (const v of filtered) {
    const list = groups.get(v.locale) ?? [];
    list.push(v);
    groups.set(v.locale, list);
  }

  return (
    <div ref={containerRef} className="relative">
      <Button
        type="button"
        variant="outline"
        className="h-8 w-full justify-between text-xs font-normal"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="truncate">
          {selected ? (
            <>
              {selected.name} · {selected.locale}
              <span className="text-muted-foreground"> · {selected.gender}</span>
            </>
          ) : (
            placeholder
          )}
        </span>
        <ChevronsUpDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </Button>

      {open && (
        <div className="absolute z-50 mt-1 w-full overflow-hidden rounded-lg border bg-popover shadow-md ring-1 ring-foreground/10">
          <div className="relative border-b p-1.5">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("voice.tts.edgeSearch")}
              className="h-7 pl-7 text-xs"
            />
          </div>
          <div className="max-h-72 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-muted-foreground">{t("voice.tts.edgeEmpty")}</p>
            ) : (
              [...groups.entries()].map(([locale, list]) => (
                <div key={locale}>
                  <p className="px-2 py-1 text-[10px] font-medium text-muted-foreground">{locale}</p>
                  {list.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => {
                        onChange(v.id);
                        setOpen(false);
                      }}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                        v.id === value ? "bg-primary/10 text-primary" : "hover:bg-foreground/5",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-medium">{v.name}</span>
                        <span className="truncate font-mono text-[10px] text-muted-foreground">{v.id}</span>
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">{v.gender}</span>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 本地引擎（audio.cpp TTS）
// ---------------------------------------------------------------------------

function LocalModelRow({
  model,
  status,
  pending,
  showControls = true,
  onDownload,
  onStart,
  onStop,
  onDelete,
}: {
  model: TtsLocalModelInfo;
  status?: TtsLocalStatus;
  pending: boolean;
  showControls?: boolean;
  onDownload: (m: TtsLocalModelInfo) => void;
  onStart: (m: TtsLocalModelInfo) => void;
  onStop: () => void;
  onDelete: (m: TtsLocalModelInfo) => void;
}) {
  const t = useT();
  const tasks = useModelDownloadStore((s) => s.tasks);
  const task = tasks.find(
    (x) => x.repo === AUDIOCPP_REPO && x.fileName === model.repoPath,
  );
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
          {model.languages.join(" / ")} · {formatBytes(model.installedSize ?? Math.round(model.approxSizeGb * 1e9))}
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
        ) : showControls ? (
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
        ) : (
          <>
            <Badge variant="secondary" className="text-[10px]">
              {t("voice.local.installed")}
            </Badge>
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

function LocalVoicePicker({
  model,
  clones,
  voice,
  emotion,
  instruct,
  onVoice,
  onEmotion,
  onInstruct,
}: {
  model?: TtsLocalModelInfo;
  clones: VoiceClone[];
  voice: string;
  emotion: string;
  instruct: string;
  onVoice: (v: string) => void;
  onEmotion: (v: string) => void;
  onInstruct: (v: string) => void;
}) {
  const t = useT();
  if (!model) return null;

  const chip = (key: string, label: string, active: boolean, onClick: () => void) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 text-xs transition-colors",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
      )}
    >
      {label}
    </button>
  );

  if (model.voiceKind === "preset") {
    return (
      <div>
        <Label className="mb-1 block text-xs">{t("voice.local.voice")}</Label>
        <div className="flex flex-wrap gap-1.5">
          {(model.presetVoices ?? []).map((v) =>
            chip(v.id, v.name, voice === v.id, () => onVoice(v.id)),
          )}
        </div>
      </div>
    );
  }

  if (model.voiceKind === "emotion") {
    return (
      <>
        <div>
          <Label className="mb-1 block text-xs">{t("voice.local.voice")}</Label>
          <div className="flex flex-wrap gap-1.5">
            {(model.presetVoices ?? []).map((v) =>
              chip(v.id, v.name, voice === v.id, () => onVoice(v.id)),
            )}
          </div>
        </div>
        <div>
          <Label className="mb-1 block text-xs">{t("voice.local.emotion")}</Label>
          <div className="flex flex-wrap gap-1.5">
            {(model.emotions ?? []).map((e) => chip(e, e, emotion === e, () => onEmotion(e)))}
          </div>
        </div>
      </>
    );
  }

  if (model.voiceKind === "design") {
    return (
      <div>
        <Label htmlFor="tts-local-instruct" className="mb-1 block text-xs">
          {t("voice.local.voice")}
        </Label>
        <Input
          id="tts-local-instruct"
          placeholder={t("voice.local.instructPlaceholder")}
          value={instruct}
          onChange={(e) => onInstruct(e.target.value)}
          className="h-8 text-xs"
        />
        <p className="mt-1 text-[11px] text-muted-foreground">
          {t("voice.local.instructPlaceholder")}
        </p>
      </div>
    );
  }

  if (model.voiceKind === "clone") {
    return (
      <div>
        <Label className="mb-1 block text-xs">{t("voice.local.cloneVoice")}</Label>
        {clones.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("voice.local.noClone")}</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {clones.map((c) => chip(c.name, c.name, voice === c.name, () => onVoice(c.name)))}
          </div>
        )}
      </div>
    );
  }

  // auto
  return <p className="text-xs text-muted-foreground">{t("voice.local.autoVoice")}</p>;
}

function TtsTab() {
  const t = useT();
  const queryClient = useQueryClient();
  const settings = SettingsValues();
  const clones = useClones();
  const [source, setSource] = useState<"local" | "edge" | "compat">("edge");
  const [text, setText] = useState("");
  const [voice, setVoice] = useState(settings.ttsVoice);
  const [edgeVoice, setEdgeVoice] = useState(settings.edgeVoice);
  const [model, setModel] = useState(settings.ttsModel);
  const [result, setResult] = useState<VoiceRecordRow>();
  const [localError, setLocalError] = useState<string>();

  // ---------- 本地引擎 (audio.cpp) ----------
  const [localModelId, setLocalModelId] = useState("");
  const [localVoice, setLocalVoice] = useState("");
  const [localEmotion, setLocalEmotion] = useState("neutral");
  const [localInstruct, setLocalInstruct] = useState("");
  const [localLanguage, setLocalLanguage] = useState("");

  const { data: localStatus } = useQuery({
    queryKey: ["tts-local-status"],
    queryFn: () => rpcClient.getTtsLocalStatus(),
    refetchInterval: 2500,
  });

  const { data: localModelsData } = useQuery({
    queryKey: ["tts-local-models"],
    queryFn: () => rpcClient.listTtsLocalModels(),
  });
  const localModels = localModelsData?.models ?? [];

  // 有正在使用的模型时自动选中；否则选中已启动的模型。
  useEffect(() => {
    if (localStatus?.activeModelId) {
      setLocalModelId((cur) => cur || localStatus.activeModelId!);
    }
  }, [localStatus?.activeModelId]);

  useEffect(() => {
    if (!localModelId) {
      const active = localModels.find((m) => m.active);
      if (active) setLocalModelId(active.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localModels?.length]);

  // 根据已保存的设置恢复上次选择（合成模型 + 音色），仅执行一次。
  const sourceHydrated = useRef(false);
  useEffect(() => {
    if (!settings.loaded || sourceHydrated.current || !localModelsData) return;
    sourceHydrated.current = true;
    setEdgeVoice(settings.edgeVoice);
    setVoice(settings.ttsVoice);
    const m = settings.ttsModel.trim();
    if (m && m !== "edge-tts" && localModels.some((x) => x.id === m)) {
      setSource("local");
      setLocalModelId(m);
    } else if (m && m !== "edge-tts") {
      setSource("compat");
      setModel(m);
    } else {
      setSource("edge");
    }
  }, [settings, localModels, localModelsData]);

  // 顶部切换推理引擎（本地 audio.cpp / Edge TTS / OpenAI 兼容服务）。
  const switchSource = (s: "local" | "edge" | "compat") => {
    setLocalError(undefined);
    setSource(s);
    if (s === "edge") {
      void rpcClient.updateSettings({ settings: { TTS_MODEL: "edge-tts" } });
    } else if (s === "local") {
      if (localModelId) void rpcClient.updateSettings({ settings: { TTS_MODEL: localModelId } });
    } else if (s === "compat") {
      if (model.trim()) void rpcClient.updateSettings({ settings: { TTS_MODEL: model.trim() } });
    }
  };

  const selectedLocal = localModels.find((m) => m.id === localModelId);

  // 切换模型时重置音色/描述/语言为默认值。
  useEffect(() => {
    if (!selectedLocal) return;
    if (selectedLocal.voiceKind === "preset" || selectedLocal.voiceKind === "emotion") {
      if (!localVoice && selectedLocal.defaultVoice) setLocalVoice(selectedLocal.defaultVoice);
    } else if (selectedLocal.voiceKind === "design") {
      if (!localInstruct) setLocalInstruct(selectedLocal.defaultVoice ?? "");
    }
    if (
      localLanguage &&
      selectedLocal.languageSupported &&
      !(selectedLocal.languageCodes ?? []).includes(localLanguage)
    ) {
      setLocalLanguage("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLocal?.id]);

  const refreshLocal = () => {
    queryClient.invalidateQueries({ queryKey: ["tts-local-models"] });
    queryClient.invalidateQueries({ queryKey: ["tts-local-status"] });
  };

  const downloadEngine = useMutation({
    mutationFn: () => rpcClient.downloadTtsLocalEngine(),
    onSuccess: (r) => {
      setLocalError(r.ok ? undefined : r.error);
      refreshLocal();
    },
    onError: (e) => setLocalError(String(e)),
  });

  const downloadLocalModel = useMutation({
    mutationFn: (m: TtsLocalModelInfo) =>
      rpcClient.startModelDownload({
        repo: AUDIOCPP_REPO,
        fileName: m.repoPath,
        category: "tts",
        source: "huggingface",
      }),
    onSuccess: refreshLocal,
  });

  const startLocalModel = useMutation({
    mutationFn: (m: TtsLocalModelInfo) => rpcClient.startTtsLocal({ modelId: m.id }),
    onSuccess: (r, m) => {
      setLocalError(r.ok ? undefined : r.error);
      if (r.ok) {
        setLocalModelId(m.id);
        setLocalVoice("");
        setLocalInstruct("");
      }
      refreshLocal();
    },
  });

  const stopLocalEngine = useMutation({
    mutationFn: () => rpcClient.stopTtsLocal(),
    onSuccess: refreshLocal,
  });

  const deleteLocalModel = useMutation({
    mutationFn: (m: TtsLocalModelInfo) => rpcClient.deleteTtsLocalModel({ modelId: m.id }),
    onSuccess: (r) => {
      if (!r.ok) setLocalError("删除失败");
      refreshLocal();
    },
  });

  const localPending =
    downloadEngine.isPending ||
    downloadLocalModel.isPending ||
    startLocalModel.isPending ||
    stopLocalEngine.isPending ||
    deleteLocalModel.isPending;

  // ---------- OpenAI 兼容 provider ----------
  const { data: providerData } = useQuery({
    queryKey: ["tts-provider"],
    queryFn: () => rpcClient.getTTSProviderConfig(),
  });
  const provider = providerData?.config;
  const configured = !!provider?.base;
  const [pBase, setPBase] = useState("");
  const [pKey, setPKey] = useState("");
  const [pError, setPError] = useState<string>();
  const [presetId, setPresetId] = useState("");
  // 参考音频：已选文件（ref 传给后端 / url 前端预览）+ 是否手动覆盖“该模型支持参考音频”（null=跟随自动检测）。
  const [refAudio, setRefAudio] = useState<{ ref: string; url: string } | null>(null);
  const [refOverride, setRefOverride] = useState<boolean | null>(null);
  const syncedRef = useRef(false);
  useEffect(() => {
    if (provider && !syncedRef.current) {
      syncedRef.current = true;
      // 地址留空时回退到线上 OmniLabs 默认地址，避免空着。
      setPBase(provider.base || DEFAULT_VOICE_BASE_URL);
      setPKey(provider.apiKey);
      setModel((m) => m || provider.model);
      setPresetId(matchVoiceProvider(provider.base || DEFAULT_VOICE_BASE_URL)?.id ?? "");
    }
  }, [provider]);

  // 选择内置服务商：自动带出 Base URL；有内置 TTS 模型且当前为空时自动选中。
  const pickProvider = (id: string) => {
    setPresetId(id);
    const p = VOICE_PROVIDER_PRESETS.find((x) => x.id === id);
    if (!p) return;
    setPBase(p.baseUrl);
    setPError(undefined);
    if (p.ttsModels.length > 0) setModel((m) => m || p.ttsModels[0]!);
  };

  const saveProvider = useMutation({
    mutationFn: () =>
      rpcClient.saveTTSProviderConfig({ base: pBase.trim(), apiKey: pKey.trim(), model: model.trim() }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tts-provider"] });
      fetchModels.mutate();
    },
  });

  const fetchModels = useMutation({
    mutationFn: () =>
      rpcClient.listProviderModels({
        base: pBase.trim() || provider?.base || undefined,
        apiKey: pKey.trim() || provider?.apiKey || undefined,
      }),
    onSuccess: (r) => {
      if (r.error) {
        setPError(r.error);
        return;
      }
      setPError(undefined);
      if (r.models.length > 0) setModel((m) => m || r.models[0]!);
    },
  });

  useEffect(() => {
    if (configured) void fetchModels.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured]);

  const models = fetchModels.data?.models ?? [];

  // 参考音频能力：跟随自动检测，可被手动开关覆盖。base 用当前配置地址（留空回退线上默认）。
  const compatBase = pBase || DEFAULT_VOICE_BASE_URL;
  const supportsRef = refOverride ?? detectReferenceAudioSupport(model, compatBase);

  // 换模型 / 换地址时重置手动覆盖，重新跟随自动检测。
  useEffect(() => {
    setRefOverride(null);
  }, [model, compatBase]);

  // 选择参考音频文件（复用 ASR / 克隆页的 openFileDialog → stageAudio 模式）。
  const pickRef = useMutation({
    mutationFn: async () => {
      const { paths } = await rpcClient.openFileDialog({
        allowedFileTypes: "mp3,wav,m4a,aac,flac,ogg,opus,webm,wma,mp4",
      });
      if (paths.length === 0) return;
      const { files } = await rpcClient.stageAudio({ paths });
      if (files[0]) setRefAudio(files[0]);
    },
  });

  // ---------- Generate ----------
  const generate = useMutation({
    mutationFn: () => {
      if (source === "local") {
        return rpcClient.runTTSLocal({
          text,
          model: localModelId || undefined,
          voice: localVoice || undefined,
          emotion: localEmotion,
          language: localLanguage || undefined,
          instruct: localInstruct || undefined,
        });
      }
      return source === "edge"
        ? rpcClient.runTTSEdge({ text, voice: edgeVoice })
        : supportsRef && refAudio
          ? rpcClient.runTTS({ text, model: model.trim() || undefined, referenceAudioRef: refAudio.ref })
          : rpcClient.runTTS({ text, model: model.trim() || undefined, voice: voice.trim() || undefined });
    },
    onSuccess: ({ record }) => {
      setResult(record);
      setLocalError(undefined);
      queryClient.invalidateQueries({ queryKey: ["voice-records"] });
      if (source === "edge") {
        void rpcClient.updateSettings({ settings: { TTS_EDGE_VOICE: edgeVoice } });
      } else if (source === "local") {
        if (localModelId) void rpcClient.updateSettings({ settings: { TTS_MODEL: localModelId } });
      } else if (source === "compat") {
        // 用参考音频合成时，音色来源是参考音频本身，不要回写默认 alloy。
        const toSave: Record<string, string> = {};
        if (!(supportsRef && refAudio)) toSave.TTS_VOICE = voice;
        if (model.trim()) toSave.TTS_MODEL = model.trim();
        void rpcClient.updateSettings({ settings: toSave });
      }
    },
    onError: (e) => setLocalError(String(e)),
  });

  return (
    <div className="flex h-full min-h-0">
      {/* 左侧：引擎与参数面板（与生图页同款布局） */}
      <aside className="w-[340px] shrink-0 overflow-y-auto border-r p-4">
        <div className="flex flex-col gap-5">
          {/* 推理引擎切换 */}
          <div>
            <Label className="mb-1.5 block text-xs">{t("voice.tts.engine")}</Label>
            <div className="flex overflow-hidden rounded-lg border">
              {(
                [
                  { key: "local", label: t("voice.tts.sourceLocal"), icon: <CpuIcon className="size-3.5" /> },
                  { key: "edge", label: t("voice.tts.sourceEdge"), icon: <GlobeIcon className="size-3.5" /> },
                  { key: "compat", label: t("voice.tts.sourceCompat"), icon: <ServerIcon className="size-3.5" /> },
                ] as const
              ).map(({ key, label, icon }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => switchSource(key)}
                  className={cn(
                    "flex flex-1 items-center justify-center gap-1.5 px-2 py-1.5 text-xs transition-colors",
                    source === key
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {icon}
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              {t(source === "local" ? "voice.local.desc" : source === "edge" ? "voice.tts.edgeDesc" : "voice.compat.desc")}
            </p>
          </div>

          {source === "local" && (
            <>
              {/* 引擎状态 */}
              <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
                <CpuIcon className="size-4 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{t("voice.local.engine")}</p>
                  <p className="text-xs text-muted-foreground">
                    {!localStatus?.engineInstalled
                      ? t("voice.local.engineNone")
                      : `${t("voice.local.engineReady")}${localStatus.binaryPath ? ` · ${localStatus.binaryPath}` : ""}`}
                  </p>
                </div>
                {!localStatus?.engineInstalled ? (
                  <Button size="sm" disabled={downloadEngine.isPending} onClick={() => downloadEngine.mutate()}>
                    {downloadEngine.isPending ? (
                      <Loader2Icon data-icon="inline-start" className="animate-spin" />
                    ) : (
                      <DownloadCloudIcon data-icon="inline-start" />
                    )}
                    {downloadEngine.isPending ? t("voice.local.downloadingEngine") : t("voice.local.downloadEngine")}
                  </Button>
                ) : (
                  <Badge variant="default" className="gap-1 text-[10px]">
                    <CircleIcon className="size-2.5 fill-current" />
                    {t("voice.local.engineReady")}
                  </Badge>
                )}
              </div>

              {/* 模型列表（下载管理） */}
              <div>
                <h3 className="mb-2 flex items-center gap-2 text-sm font-medium">
                  <AudioLinesIcon className="size-4 text-muted-foreground" />
                  {t("voice.local.models")}
                  <span className="text-xs font-normal text-muted-foreground">
                    {t("voice.local.modelsHint")}
                  </span>
                </h3>
                <div className="flex flex-col gap-2">
                  {localModels.map((m) => (
                    <LocalModelRow
                      key={m.id}
                      model={m}
                      status={localStatus}
                      pending={localPending}
                      showControls={false}
                      onDownload={(mm) => downloadLocalModel.mutate(mm)}
                      onStart={(mm) => startLocalModel.mutate(mm)}
                      onStop={() => stopLocalEngine.mutate()}
                      onDelete={(mm) => deleteLocalModel.mutate(mm)}
                    />
                  ))}
                </div>
              </div>
            </>
          )}

          {source === "compat" && (
            <>
              {/* 服务配置：服务商 + Base URL + API Key + 模型 */}
              <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-xs font-medium">
                    <GlobeIcon className="size-3.5 text-muted-foreground" />
                    {t("voice.compat.providerTitle")}
                  </span>
                  {configured && (
                    <Badge variant="secondary" className="gap-1 text-[10px]">
                      <CircleIcon className="size-2.5 fill-current text-emerald-500" />
                      {t("voice.compat.configured")}
                    </Badge>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground">{t("voice.compat.desc")}</p>

                {/* 服务商预设：选中自动带出地址 */}
                <div>
                  <Label className="mb-1 block text-xs">{t("voice.compat.provider")}</Label>
                  <Select value={presetId} onValueChange={pickProvider}>
                    <SelectTrigger className="h-8 w-full text-xs">
                      <SelectValue placeholder={t("voice.compat.providerPlaceholder")} />
                    </SelectTrigger>
                    <SelectContent position="popper" sideOffset={6}>
                      {VOICE_PROVIDER_PRESETS.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          <span className="truncate">{p.label}</span>
                          {p.note && (
                            <span className="truncate text-[10px] text-muted-foreground/70">
                              {p.note}
                            </span>
                          )}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* 第一行：服务地址 */}
                <div>
                  <Label htmlFor="tts-provider-base" className="mb-1 block text-xs">
                    {t("voice.compat.base")}
                  </Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="tts-provider-base"
                      placeholder="https://api.openai.com/v1"
                      value={pBase}
                      onChange={(e) => setPBase(e.target.value)}
                      className="h-8 flex-1 text-xs"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => fetchModels.mutate()}
                      disabled={fetchModels.isPending || !pBase.trim()}
                      className="shrink-0"
                    >
                      {fetchModels.isPending ? (
                        <Loader2Icon data-icon="inline-start" className="animate-spin" />
                      ) : (
                        <RefreshCwIcon data-icon="inline-start" />
                      )}
                      {t("voice.compat.fetchModels")}
                    </Button>
                  </div>
                </div>

                {/* 第二行：密钥 */}
                <div>
                  <Label htmlFor="tts-provider-key" className="mb-1 block text-xs">
                    {t("voice.compat.apiKey")}
                  </Label>
                  <Input
                    id="tts-provider-key"
                    type="password"
                    placeholder="sk-…"
                    value={pKey}
                    onChange={(e) => setPKey(e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>

                {/* 第三行：模型（内置 + 已获取） */}
                <div>
                  <Label className="mb-1 block text-xs">{t("voice.compat.model")}</Label>
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <AudioModelSelect
                        value={model}
                        onChange={setModel}
                        placeholder={t("voice.compat.modelPlaceholder")}
                        builtin={
                          VOICE_PROVIDER_PRESETS.find((p) => p.id === presetId)?.ttsModels ?? []
                        }
                        fetched={models}
                      />
                    </div>
                    {models.length > 0 && (
                      <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                        {models.length} {t("voice.compat.modelsCount")}
                      </span>
                    )}
                  </div>
                </div>

                {/* 保存 */}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button
                    size="sm"
                    onClick={() => saveProvider.mutate()}
                    disabled={saveProvider.isPending || !pBase.trim()}
                  >
                    {saveProvider.isPending ? (
                      <Loader2Icon data-icon="inline-start" className="animate-spin" />
                    ) : (
                      <SaveIcon data-icon="inline-start" />
                    )}
                    {t("voice.compat.save")}
                  </Button>
                </div>
                {(pError || (fetchModels.isError ? String(fetchModels.error) : undefined)) && (
                  <ResultError error={pError ?? String(fetchModels.error)} />
                )}
              </div>
            </>
          )}

          {source === "edge" && (
            <div>
              <Label className="mb-1 block text-xs">{t("voice.tts.edgeVoice")}</Label>
              <EdgeVoicePicker value={edgeVoice} onChange={setEdgeVoice} placeholder={t("voice.tts.edgeVoice")} />
            </div>
          )}

          {source === "local" && (
            <>
              {/* 当前引擎：状态 + 选择模型 + 启动/停止 */}
              <div className="flex flex-col gap-3 rounded-lg border bg-card p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-xs font-medium">
                    <CpuIcon className="size-3.5 text-primary" />
                    {t("voice.local.engine")}
                  </span>
                  {localStatus?.active ? (
                    <Badge variant="default" className="gap-1 text-[10px]">
                      <CircleIcon className="size-2.5 fill-current" />
                      {t("voice.local.running")}
                    </Badge>
                  ) : localStatus?.engineInstalled ? (
                    <Badge variant="secondary" className="gap-1 text-[10px]">
                      <CircleIcon className="size-2.5 fill-current" />
                      {t("voice.local.notStarted")}
                    </Badge>
                  ) : null}
                </div>

                <div>
                  <Label className="mb-1 block text-xs">{t("voice.local.select")}</Label>
                  {localModels.filter((m) => m.downloaded).length === 0 ? (
                    <div className="flex items-center justify-center rounded-lg border border-dashed px-4 py-6 text-xs text-muted-foreground">
                      {t("voice.local.empty")}
                    </div>
                  ) : (
                    <Select
                      value={localModelId}
                      onValueChange={(v) => {
                        setLocalModelId(v);
                        setLocalError(undefined);
                      }}
                    >
                      <SelectTrigger className="h-8 w-full text-xs">
                        <SelectValue placeholder={t("voice.local.select")} />
                      </SelectTrigger>
                      <SelectContent>
                        {localModels
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
                </div>

                {!selectedLocal?.downloaded && (
                  <p className="text-xs text-amber-600">{t("voice.local.needModel")}</p>
                )}

                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant={localStatus?.active ? "outline" : "default"}
                    disabled={localPending || !selectedLocal?.downloaded || !localStatus?.engineInstalled}
                    onClick={() => {
                      if (localStatus?.active) stopLocalEngine.mutate();
                      else if (selectedLocal) startLocalModel.mutate(selectedLocal);
                    }}
                  >
                    {localPending ? (
                      <Loader2Icon data-icon="inline-start" className="animate-spin" />
                    ) : localStatus?.active ? (
                      <SquareIcon data-icon="inline-start" />
                    ) : (
                      <PlayIcon data-icon="inline-start" />
                    )}
                    {localStatus?.active ? t("voice.local.stop") : t("voice.local.start")}
                  </Button>
                  {!localStatus?.engineInstalled && (
                    <Button
                      variant="link"
                      size="sm"
                      className="h-6 px-1 text-xs"
                      onClick={() => downloadEngine.mutate()}
                    >
                      {t("voice.local.downloadEngine")}
                    </Button>
                  )}
                </div>
              </div>

              <LocalVoicePicker
                model={selectedLocal}
                clones={clones}
                voice={localVoice}
                emotion={localEmotion}
                instruct={localInstruct}
                onVoice={setLocalVoice}
                onEmotion={setLocalEmotion}
                onInstruct={setLocalInstruct}
              />

              {selectedLocal?.languageSupported && (
                <div>
                  <Label className="mb-1 block text-xs">{t("voice.local.language")}</Label>
                  <Select
                    value={localLanguage || "auto"}
                    onValueChange={(v) => setLocalLanguage(v === "auto" ? "" : v)}
                    key={selectedLocal?.id}
                  >
                    <SelectTrigger className="h-8 w-full text-xs">
                      <SelectValue placeholder="auto" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">auto</SelectItem>
                      {(selectedLocal.languageCodes ?? []).map((code) => (
                        <SelectItem key={code} value={code}>
                          {AUDIOCPP_LANG_LABELS[code] ?? code}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </>
          )}

          {source === "compat" && (
            <>
              {/* 参考音频（按模型能力显示：支持可上传，不支持不显示）+ 手动覆盖开关 */}
              <div className="flex flex-col gap-2">
                {supportsRef && (
                  <div className="rounded-lg border p-3">
                    <Label className="mb-1 block text-xs">{t("voice.tts.refAudio")}</Label>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pickRef.isPending}
                        onClick={() => pickRef.mutate()}
                      >
                        {pickRef.isPending ? (
                          <Spinner data-icon="inline-start" />
                        ) : (
                          <FileAudioIcon data-icon="inline-start" />
                        )}
                        {refAudio ? t("voice.clone.picked") : t("voice.clone.pickRef")}
                      </Button>
                      {refAudio && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          tooltip={t("voice.remove")}
                          onClick={() => setRefAudio(null)}
                        >
                          <XIcon className="size-4" />
                        </Button>
                      )}
                    </div>
                    {refAudio && (
                      <div className="mt-2">
                        <PlayAudio url={refAudio.url} />
                      </div>
                    )}
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      {t("voice.tts.refAudioHint")}
                    </p>
                  </div>
                )}

                <div className="flex items-center gap-2 text-xs">
                  <Label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      className="size-3.5"
                      checked={supportsRef}
                      onChange={(e) => setRefOverride(e.target.checked)}
                    />
                    {t("voice.tts.refAudioToggle")}
                  </Label>
                  {refOverride === null ? (
                    <span className="text-[10px] text-muted-foreground">
                      {t("voice.tts.refAudioAuto")}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setRefOverride(null)}
                      className="text-[10px] text-primary underline"
                    >
                      {t("voice.tts.refAudioReset")}
                    </button>
                  )}
                </div>
              </div>

              {/* 音色（自由输入，适配任意云端模型的音色名） */}
              <div>
                <Label htmlFor="tts-voice" className="mb-1 block text-xs">
                  {t("voice.tts.voice")}
                </Label>
                <Input
                  id="tts-voice"
                  value={voice}
                  onChange={(e) => setVoice(e.target.value)}
                  placeholder={t("voice.tts.voiceNamePlaceholder")}
                  className="h-8 text-xs"
                />
              </div>

              {generate.isError && <ResultError error={String(generate.error)} />}
            </>
          )}

          {/* 文本录入 */}
          <div>
            <Label htmlFor="tts-text" className="mb-1 block text-xs">
              {t("voice.tts.text")}
            </Label>
            <Textarea
              id="tts-text"
              rows={7}
              placeholder={t("voice.tts.textPlaceholder")}
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="resize-none text-xs"
            />
          </div>

          {localError && <ResultError error={localError} />}

          {/* 生成 */}
          <Button
            size="lg"
            onClick={() => generate.mutate()}
            disabled={!text.trim() || generate.isPending}
            className="w-full"
          >
            {generate.isPending ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <SparklesIcon data-icon="inline-start" />
            )}
            {generate.isPending ? t("voice.tts.generating") : t("voice.tts.generate")}
          </Button>
        </div>
      </aside>

      {/* 右侧：结果区 */}
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1 items-center justify-center p-8">
          {generate.isPending ? (
            <TtsLoading text={text} />
          ) : result ? (
            <div className="w-full max-w-md">
              <ResultPanel record={result} label={t("voice.tts.noResult")} />
            </div>
          ) : (
            <ResultEmpty
              icon={<AudioLinesIcon className="size-9 text-primary" />}
              title={t("voice.tts.generate")}
              hint={t("voice.tts.noResult")}
            />
          )}
        </div>
      </main>
    </div>
  );
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}


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

function AsrTab() {
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
      setTError(r.ok ? undefined : r.error ?? "启动失败");
      refresh();
    },
    onError: (e) => setTError(String(e)),
  });
  const stopEngine = useMutation({
    mutationFn: () => rpcClient.stopAsr(),
    onSuccess: (r) => {
      if (r && !r.ok) setTError(r.error ?? "停止失败");
      refresh();
    },
    onError: (e) => setTError(String(e)),
  });
  const whisperPending = downloadModel.isPending || startModel.isPending || stopEngine.isPending;

  // 一键安装 whisper.cpp 引擎（whisper-cli / whisper-server）。
  const installWhisperEngine = useMutation({
    mutationFn: () => rpcClient.downloadWhisperEngine(),
    onSuccess: (r) => {
      setTError(r.ok ? undefined : r.error ?? "引擎安装失败");
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
      setTError(r.ok ? undefined : r.error ?? "启动失败");
      if (r.ok) setAcpModelId(m.id);
      refresh();
    },
    onError: (e) => setTError(String(e)),
  });
  const acpStop = useMutation({
    mutationFn: () => rpcClient.stopAsrAudioCpp(),
    onSuccess: (r) => {
      if (r && !r.ok) setTError(r.error ?? "停止失败");
      refresh();
    },
    onError: (e) => setTError(String(e)),
  });
  const acpDelete = useMutation({
    mutationFn: (m: AsrAudioCppModelInfo) => rpcClient.deleteAsrAudioCppModel({ modelId: m.id }),
    onSuccess: (r) => {
      if (!r.ok) setTError(r.error ?? "删除失败");
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

  // ---------- OpenAI 兼容 API provider ----------
  const [pBase, setPBase] = useState("");
  const [pKey, setPKey] = useState("");
  const [pModel, setPModel] = useState("");
  const [pError, setPError] = useState<string>();
  const [presetId, setPresetId] = useState("");
  const providerSynced = useRef(false);

  const { data: providerData } = useQuery({
    queryKey: ["asr-provider"],
    queryFn: () => rpcClient.getASRProviderConfig(),
  });
  const provider = providerData?.config;
  const providerConfigured = !!provider?.base;
  useEffect(() => {
    if (provider && !providerSynced.current) {
      providerSynced.current = true;
      // 地址留空时回退到线上 OmniLabs 默认地址，避免空着。
      setPBase(provider.base || DEFAULT_VOICE_BASE_URL);
      setPKey(provider.apiKey);
      setPModel(provider.model);
      setPresetId(matchVoiceProvider(provider.base || DEFAULT_VOICE_BASE_URL)?.id ?? "");
    }
  }, [provider]);

  // 选择内置服务商：自动带出 Base URL；有内置 ASR 模型且当前为空时自动选中。
  const pickProvider = (id: string) => {
    setPresetId(id);
    const p = VOICE_PROVIDER_PRESETS.find((x) => x.id === id);
    if (!p) return;
    setPBase(p.baseUrl);
    setPError(undefined);
    if (p.asrModels.length > 0) setPModel((m) => m || p.asrModels[0]!);
  };

  const saveProvider = useMutation({
    mutationFn: () =>
      rpcClient.saveASRProviderConfig({
        base: pBase.trim(),
        apiKey: pKey.trim(),
        model: pModel.trim(),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["asr-provider"] });
      fetchModels.mutate();
    },
  });

  const fetchModels = useMutation({
    mutationFn: () =>
      rpcClient.listProviderModels({
        base: pBase.trim() || provider?.base || undefined,
        apiKey: pKey.trim() || provider?.apiKey || undefined,
      }),
    onSuccess: (r) => {
      if (r.error) {
        setPError(r.error);
        return;
      }
      setPError(undefined);
      if (r.models.length > 0) setPModel((m) => m || r.models[0]!);
    },
  });

  useEffect(() => {
    if (engineMode === "api" && providerConfigured) void fetchModels.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineMode, providerConfigured]);

  const apiModels = fetchModels.data?.models ?? [];

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
            <div className="flex overflow-hidden rounded-lg border">
              {(
                [
                  { key: "whisper", label: t("voice.asrAudiocpp.engineWhisper"), icon: <ServerIcon className="size-3.5" /> },
                  { key: "audiocpp", label: t("voice.asrAudiocpp.engineAcp"), icon: <CpuIcon className="size-3.5" /> },
                  { key: "api", label: t("voice.asr.sourceRemote"), icon: <GlobeIcon className="size-3.5" /> },
                ] as const
              ).map(({ key, label, icon }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => switchEngine(key)}
                  className={cn(
                    "flex flex-1 items-center justify-center gap-1.5 px-2 py-1.5 text-xs transition-colors",
                    engineMode === key
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {icon}
                  {label}
                </button>
              ))}
            </div>
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
              {/* 服务配置：服务商 + Base URL + API Key + 模型 */}
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

                {/* 服务商预设：选中自动带出地址 */}
                <div>
                  <Label className="mb-1 block text-xs">{t("voice.compat.provider")}</Label>
                  <Select value={presetId} onValueChange={pickProvider}>
                    <SelectTrigger className="h-8 w-full text-xs">
                      <SelectValue placeholder={t("voice.compat.providerPlaceholder")} />
                    </SelectTrigger>
                    <SelectContent position="popper" sideOffset={6}>
                      {VOICE_PROVIDER_PRESETS.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          <span className="truncate">{p.label}</span>
                          {p.note && (
                            <span className="truncate text-[10px] text-muted-foreground/70">
                              {p.note}
                            </span>
                          )}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* 第一行：服务地址 */}
                <div>
                  <Label htmlFor="asr-provider-base" className="mb-1 block text-xs">
                    {t("voice.compat.base")}
                  </Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="asr-provider-base"
                      placeholder="https://api.openai.com/v1"
                      value={pBase}
                      onChange={(e) => setPBase(e.target.value)}
                      className="h-8 flex-1 text-xs"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => fetchModels.mutate()}
                      disabled={fetchModels.isPending || !pBase.trim()}
                      className="shrink-0"
                    >
                      {fetchModels.isPending ? (
                        <Loader2Icon data-icon="inline-start" className="animate-spin" />
                      ) : (
                        <RefreshCwIcon data-icon="inline-start" />
                      )}
                      {t("voice.compat.fetchModels")}
                    </Button>
                  </div>
                </div>

                {/* 第二行：密钥 */}
                <div>
                  <Label htmlFor="asr-provider-key" className="mb-1 block text-xs">
                    {t("voice.compat.apiKey")}
                  </Label>
                  <Input
                    id="asr-provider-key"
                    type="password"
                    placeholder="sk-…"
                    value={pKey}
                    onChange={(e) => setPKey(e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>

                {/* 第三行：模型（内置 + 已获取） */}
                <div>
                  <Label className="mb-1 block text-xs">{t("voice.compat.model")}</Label>
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <AudioModelSelect
                        value={pModel}
                        onChange={setPModel}
                        placeholder={t("voice.compat.modelPlaceholder")}
                        builtin={
                          VOICE_PROVIDER_PRESETS.find((p) => p.id === presetId)?.asrModels ?? []
                        }
                        fetched={apiModels}
                      />
                    </div>
                    {apiModels.length > 0 && (
                      <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                        {apiModels.length} {t("voice.compat.modelsCount")}
                      </span>
                    )}
                  </div>
                </div>

                {/* 保存 */}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button
                    size="sm"
                    onClick={() => saveProvider.mutate()}
                    disabled={saveProvider.isPending || !pBase.trim()}
                  >
                    {saveProvider.isPending ? (
                      <Loader2Icon data-icon="inline-start" className="animate-spin" />
                    ) : (
                      <SaveIcon data-icon="inline-start" />
                    )}
                    {t("voice.compat.save")}
                  </Button>
                </div>
                {(pError || (fetchModels.isError ? String(fetchModels.error) : undefined)) && (
                  <ResultError error={pError ?? String(fetchModels.error)} />
                )}
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

function CloneTab() {
  const t = useT();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [ref, setRef] = useState<{ ref: string; url: string } | null>(null);

  const { data } = useQuery({
    queryKey: ["voice-clones"],
    queryFn: () => rpcClient.listVoiceClones(),
  });
  const clones = data?.clones ?? [];

  const pick = useMutation({
    mutationFn: async () => {
      const { paths } = await rpcClient.openFileDialog({
        allowedFileTypes: "mp3,wav,m4a,aac,flac,ogg,opus,webm,wma,mp4",
      });
      if (paths.length === 0) return;
      const { files } = await rpcClient.stageAudio({ paths });
      if (files[0]) setRef(files[0]);
    },
  });

  const create = useMutation({
    mutationFn: () => rpcClient.createVoiceClone({ name, audioRef: ref!.ref }),
    onSuccess: () => {
      setName("");
      setRef(null);
      queryClient.invalidateQueries({ queryKey: ["voice-clones"] });
      queryClient.invalidateQueries({ queryKey: ["voice-records"] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => rpcClient.deleteVoiceClone({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["voice-clones"] }),
  });

  return (
    <div className="flex h-full min-h-0">
      {/* 左侧：创建克隆 */}
      <aside className="w-[340px] shrink-0 overflow-y-auto border-r p-4">
        <div className="flex flex-col gap-5">
        <p className="text-xs text-muted-foreground">{t("voice.clone.desc")}</p>

        <div className="flex flex-col gap-3 rounded-lg border bg-card p-3">
          <div>
            <Label htmlFor="clone-name" className="mb-1 block text-xs">
              {t("voice.clone.name")}
            </Label>
            <Input
              id="clone-name"
              placeholder={t("voice.clone.namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-8 text-xs"
            />
          </div>

          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={pick.isPending} onClick={() => pick.mutate()}>
              {pick.isPending ? <Spinner data-icon="inline-start" /> : <FileAudioIcon data-icon="inline-start" />}
              {ref ? t("voice.clone.picked") : t("voice.clone.pickRef")}
            </Button>
            {ref && (
              <Button variant="ghost" size="icon-sm" tooltip={t("voice.remove")} onClick={() => setRef(null)}>
                <XIcon className="size-4" />
              </Button>
            )}
          </div>
          {ref && <PlayAudio url={ref.url} />}

          <ResultError error={create.isError ? String(create.error) : undefined} />

          <Button
            size="lg"
            className="w-full"
            onClick={() => create.mutate()}
            disabled={!name.trim() || !ref || create.isPending}
          >
            {create.isPending ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <Wand2Icon data-icon="inline-start" />
            )}
            {create.isPending ? t("voice.clone.creating") : t("voice.clone.create")}
          </Button>
        </div>

        </div>
      </aside>

      {/* 右侧：克隆列表 */}
      <main className="relative min-w-0 flex-1 overflow-y-auto">
        <div className="flex h-full min-h-0 items-center justify-center p-8">
          {clones.length === 0 ? (
            <ResultEmpty
              icon={<Wand2Icon className="size-9 text-primary" />}
              title={t("voice.clone.empty")}
              hint={t("voice.clone.desc")}
            />
          ) : (
            <div className="w-full max-w-md">
              <h3 className="mb-2 text-sm font-medium">{t("voice.clone.list")}</h3>
              <div className="flex flex-col gap-2">
                {clones.map((c: VoiceClone) => (
                  <div key={c.id} className="flex items-center gap-3 rounded-lg border bg-card p-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{c.name}</p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {c.model ? `· ${c.model}` : ""} {formatTime(c.createdAt)}
                      </p>
                    </div>
                    {c.audioUrl && (
                      <div className="flex shrink-0 items-center gap-1">
                        <PlayAudio url={c.audioUrl} className="w-40" />
                        <AudioDownloadButton
                          url={c.audioUrl}
                          filename={audioFileName(c.audioUrl, `clone-${c.name}`)}
                        />
                      </div>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      tooltip={t("voice.clone.delete")}
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(c.id)}
                    >
                      <Trash2Icon className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export function VoiceScreen() {
  const { tab } = useVoiceStore();

  // 工具入口（语音合成 / 语音识别 / 声音克隆）在左侧栏顶部，与生图页一致。
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {tab === "tts" && <TtsTab />}
      {tab === "asr" && <AsrTab />}
      {tab === "clone" && <CloneTab />}
    </div>
  );
}
