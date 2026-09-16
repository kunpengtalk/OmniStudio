import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AudioLinesIcon, Loader2Icon, SparklesIcon, SquareIcon, PlayIcon, CircleIcon, DownloadCloudIcon, ChevronsUpDownIcon, SearchIcon, TrashIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import { Badge } from "@ui/badge";
import { useT } from "@stores/ui-lang";
import { useModelDownloadStore } from "@stores/model-download";
import { AudioDownloadButton, audioFileName } from "@components/audio-download";
import { AUDIOCPP_REPO } from "@/shared/audiocpp";
import type { TtsLocalModelInfo, TtsLocalStatus } from "../../../bun/tts-local";
import type { VoiceClone, VoiceRecordRow } from "../../../bun/voice";
import { cn } from "@/mainview/lib/utils";

export function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function PlayAudio({ url, className }: { url: string; className?: string }) {
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

export function ResultPanel({ record, label }: { record?: VoiceRecordRow; label: string }) {
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

export function TtsLoading({ text }: { text: string }) {
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


export function SettingsValues() {
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

export function useClones() {
  const { data } = useQuery({
    queryKey: ["voice-clones"],
    queryFn: () => rpcClient.listVoiceClones(),
  });
  return data?.clones ?? [];
}

export function EdgeVoicePicker({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
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

export function LocalModelRow({
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

export function LocalVoicePicker({
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


// 体积口径统一到 @lib/format（本文件内也直接调用）。
import { formatBytes } from "@lib/format";
export { formatBytes };

