import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleIcon,
  CpuIcon,
  DownloadCloudIcon,
  EraserIcon,
  GlobeIcon,
  LanguagesIcon,
  Loader2Icon,
  MicIcon,
  PlayIcon,
  RefreshCwIcon,
  SaveIcon,
  ServerIcon,
  SquareIcon,
  TimerIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Badge } from "@ui/badge";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui/select";
import { useT } from "@stores/ui-lang";
import { useMicRecorder } from "@hooks/use-mic-recorder";
import type { AsrSegment } from "../../bun/asr";
import type { AsrAudioCppModelInfo } from "../../bun/asr-audiocpp";
import { mergeSegments, fmtClock } from "./voice-asr-result";
import { TranslationEnginePicker, useTranslationEngine } from "./translate-screen";
import {
  DEFAULT_VOICE_BASE_URL,
  VOICE_PROVIDER_PRESETS,
  matchVoiceProvider,
} from "./voice-provider-presets";
import {
  TRANSLATION_LANGUAGES,
  TRANSLATION_SOURCE_AUTO,
} from "../../shared/translate";
import { cn } from "@/mainview/lib/utils";

type AsrEngineMode = "whisper" | "audiocpp" | "api";

/** 段落键：whisper 对同一段音频前缀的 start 时间戳稳定，可作增量翻译的锚点。 */
const segKey = (s: AsrSegment) => s.start.toFixed(2);

/** 翻译语言码 → whisper 识别语言码（zh-CN → zh；auto 透传）。 */
function asrLangOf(code: string): string {
  if (code === TRANSLATION_SOURCE_AUTO) return "auto";
  return code.split("-")[0]!;
}

/** whisper 识别语言码 → 翻译源语言码（恢复上次选择用）。 */
function translateLangOf(code: string): string {
  if (code === "zh") return "zh-CN";
  if (code === "en" || code === "ja" || code === "ko") return code;
  return TRANSLATION_SOURCE_AUTO;
}

/** 麦克风小电平条（同传状态栏用，条数少、更紧凑）。 */
function LevelBars({ level }: { level: number }) {
  const BARS = 13;
  return (
    <div className="flex h-4 items-end gap-[2px]" aria-hidden>
      {Array.from({ length: BARS }).map((_, i) => {
        const weight = Math.sin((i / (BARS - 1)) * Math.PI);
        const h = Math.max(2, Math.round(Math.max(0.08, level) * weight * 16));
        return (
          <span
            key={i}
            className="w-[2px] rounded-sm bg-primary/70 transition-all duration-100"
            style={{ height: h }}
          />
        );
      })}
    </div>
  );
}

/**
 * 同传翻译：麦克风实时转写（复用语音页三套 ASR 引擎）+ 逐段翻译成多种目标语言，
 * 原文与各语种译文同步上屏，像打字一样流式追加。
 */
export function LiveTranslateTab() {
  const t = useT();
  const queryClient = useQueryClient();
  const engine = useTranslationEngine();

  const [engineMode, setEngineMode] = useState<AsrEngineMode>("whisper");
  const [sourceLang, setSourceLang] = useState(TRANSLATION_SOURCE_AUTO);
  const [targets, setTargets] = useState<string[]>(["en"]);
  const [segments, setSegments] = useState<AsrSegment[]>([]);
  const [translations, setTranslations] = useState<Record<string, Record<string, string>>>({});
  const [translatedFrom, setTranslatedFrom] = useState<Record<string, string>>({});
  const [liveError, setLiveError] = useState<string>();
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  // ---------- 恢复上次的引擎与语言选择 ----------
  const hydrated = useRef(false);
  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  useEffect(() => {
    if (hydrated.current || !settingsData?.settings) return;
    hydrated.current = true;
    const s = settingsData.settings;
    setEngineMode(
      s.ASR_ENGINE === "audiocpp" ? "audiocpp" : s.ASR_ENGINE === "api" ? "api" : "whisper",
    );
    if (s.ASR_LANG) setSourceLang(translateLangOf(s.ASR_LANG));
  }, [settingsData]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["asr-status"] });
    queryClient.invalidateQueries({ queryKey: ["asr-models"] });
    queryClient.invalidateQueries({ queryKey: ["asr-audiocpp-models"] });
    queryClient.invalidateQueries({ queryKey: ["asr-audiocpp-status"] });
  };

  const switchEngine = (m: AsrEngineMode) => {
    setEngineMode(m);
    setLiveError(undefined);
    void rpcClient.updateSettings({ settings: { ASR_ENGINE: m } });
    if (m !== "whisper") void rpcClient.stopAsr();
  };

  // ---------- whisper.cpp 引擎 ----------
  const { data: whisperStatus } = useQuery({
    queryKey: ["asr-status"],
    queryFn: () => rpcClient.getAsrStatus(),
    refetchInterval: 2500,
  });
  const whisperReady = !!whisperStatus?.serverRunning;
  const { data: whisperModelsData } = useQuery({
    queryKey: ["asr-models"],
    queryFn: () => rpcClient.listAsrModels(),
  });
  const downloadedWhisper = (whisperModelsData?.models ?? []).filter((m) => m.installedSize);
  const [whisperModel, setWhisperModel] = useState("");
  useEffect(() => {
    if (!whisperModel && downloadedWhisper.length > 0) setWhisperModel(downloadedWhisper[0]!.fileName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloadedWhisper.length]);

  const installWhisper = useMutation({
    mutationFn: () => rpcClient.downloadWhisperEngine(),
    onSuccess: (r) => {
      setLiveError(r.ok ? undefined : (r.error ?? "引擎安装失败"));
      refresh();
    },
  });
  const startWhisper = useMutation({
    mutationFn: () => rpcClient.startAsr({ model: whisperModel || downloadedWhisper[0]?.fileName }),
    onSuccess: (r) => {
      setLiveError(r.ok ? undefined : (r.error ?? "启动失败"));
      refresh();
    },
  });
  const stopWhisper = useMutation({ mutationFn: () => rpcClient.stopAsr(), onSuccess: refresh });

  // ---------- audio.cpp 引擎 ----------
  const { data: acpStatus } = useQuery({
    queryKey: ["asr-audiocpp-status"],
    queryFn: () => rpcClient.getAsrAudioCppStatus(),
    refetchInterval: 2500,
  });
  const acpReady = !!acpStatus?.active;
  const { data: acpModelsData } = useQuery({
    queryKey: ["asr-audiocpp-models"],
    queryFn: () => rpcClient.listAsrAudioCppModels(),
  });
  const downloadedAcp = (acpModelsData?.models ?? []).filter((m) => m.downloaded);
  const [acpModelId, setAcpModelId] = useState("");
  useEffect(() => {
    if (!acpModelId) {
      const active = downloadedAcp.find((m) => m.active);
      if (active) setAcpModelId(active.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloadedAcp.length]);

  const acpInstallEngine = useMutation({
    mutationFn: () => rpcClient.downloadTtsLocalEngine(),
    onSuccess: (r) => {
      setLiveError(r.ok ? undefined : r.error);
      refresh();
    },
  });
  const acpStart = useMutation({
    mutationFn: (m: AsrAudioCppModelInfo) => rpcClient.startAsrAudioCpp({ modelId: m.id }),
    onSuccess: (r, m) => {
      setLiveError(r.ok ? undefined : (r.error ?? "启动失败"));
      if (r.ok) setAcpModelId(m.id);
      refresh();
    },
  });
  const acpStop = useMutation({ mutationFn: () => rpcClient.stopAsrAudioCpp(), onSuccess: refresh });

  // ---------- OpenAI 兼容转写 ----------
  const { data: providerData } = useQuery({
    queryKey: ["asr-provider"],
    queryFn: () => rpcClient.getASRProviderConfig(),
  });
  const provider = providerData?.config;
  const apiReady = !!provider?.base;
  const [pBase, setPBase] = useState("");
  const [pKey, setPKey] = useState("");
  const [pModel, setPModel] = useState("");
  const [presetId, setPresetId] = useState("");
  const [pError, setPError] = useState<string>();
  const providerSynced = useRef(false);
  useEffect(() => {
    if (provider && !providerSynced.current) {
      providerSynced.current = true;
      setPBase(provider.base || DEFAULT_VOICE_BASE_URL);
      setPKey(provider.apiKey);
      setPModel(provider.model);
      setPresetId(matchVoiceProvider(provider.base || DEFAULT_VOICE_BASE_URL)?.id ?? "");
    }
  }, [provider]);

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
      rpcClient.saveASRProviderConfig({ base: pBase.trim(), apiKey: pKey.trim(), model: pModel.trim() }),
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
    if (engineMode === "api" && apiReady) void fetchModels.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineMode, apiReady]);

  const ready =
    engineMode === "whisper" ? whisperReady : engineMode === "audiocpp" ? acpReady : apiReady;

  // ---------- 实时转写（增量合并） ----------
  const applyResult = (
    prev: AsrSegment[],
    r: { text?: string; segments?: AsrSegment[] },
  ): AsrSegment[] => {
    if (r.segments?.length) return mergeSegments(prev, r.segments);
    const text = (r.text ?? "").trim();
    if (!text) return prev;
    // 无分段结果的引擎：整段文本作为最后一条追加 / 增量更新。
    const last = prev[prev.length - 1];
    if (last && text.startsWith(last.text) && text !== last.text) {
      return [...prev.slice(0, -1), { ...last, end: last.end + 1, text }];
    }
    if (last && text === last.text) return prev;
    return [...prev, { start: (last?.end ?? 0) + 1, end: (last?.end ?? 0) + 2, text }];
  };

  const liveTranscribe = useMutation({
    mutationFn: (wav: string) =>
      rpcClient.transcribeAudio({
        wavBase64: wav,
        save: false,
        source: engineMode === "api" ? "remote" : "local",
        model: engineMode === "api" ? pModel.trim() || undefined : undefined,
      }),
    onSuccess: (r) => {
      if (r.error) {
        setLiveError(r.error);
        return;
      }
      setLiveError(undefined);
      setSegments((prev) => applyResult(prev, r));
    },
  });

  const liveBusyRef = useRef(false);
  useEffect(() => {
    liveBusyRef.current = liveTranscribe.isPending;
  }, [liveTranscribe.isPending]);

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
    2500,
  );
  useEffect(() => {
    setLiveError(recorder.error);
  }, [recorder.error]);

  useEffect(() => {
    if (!recorder.recording) {
      setElapsed(0);
      return;
    }
    const startedAt = Date.now();
    const iv = setInterval(() => setElapsed((Date.now() - startedAt) / 1000), 250);
    return () => clearInterval(iv);
  }, [recorder.recording]);

  // ---------- 逐段翻译（新段落 / 原文变化 / 新增目标语言时补翻） ----------
  const pendingRef = useRef(new Set<string>());
  const translateSeg = useMutation({
    mutationFn: (p: { key: string; lang: string; text: string }) =>
      rpcClient.runTranslation({
        text: p.text,
        sourceLang: sourceLang === TRANSLATION_SOURCE_AUTO ? undefined : sourceLang,
        targetLang: p.lang,
        engine,
        save: false,
      }),
    onSuccess: (r, p) => {
      setTranslations((prev) => ({
        ...prev,
        [p.key]: { ...prev[p.key], [p.lang]: r.text || "—" },
      }));
    },
    onError: (e, p) => {
      setTranslations((prev) => ({ ...prev, [p.key]: { ...prev[p.key], [p.lang]: "—" } }));
      setLiveError(String(e));
    },
    onSettled: (_d, _e, p) => {
      pendingRef.current.delete(`${p.key}|${p.lang}`);
    },
  });

  useEffect(() => {
    if (targets.length === 0) return;
    for (const seg of segments) {
      const text = seg.text.trim();
      if (!text) continue;
      const key = segKey(seg);
      if (translatedFrom[key] !== text) {
        // 新段落或识别中的原文还在变：更新锚点并丢弃旧译文，下一轮再发起翻译。
        setTranslatedFrom((prev) => ({ ...prev, [key]: text }));
        setTranslations((prev) => {
          if (!prev[key]) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
        continue;
      }
      for (const lang of targets) {
        if (translations[key]?.[lang]) continue;
        const pid = `${key}|${lang}`;
        if (pendingRef.current.has(pid)) continue;
        pendingRef.current.add(pid);
        translateSeg.mutate({ key, lang, text });
      }
    }
  }, [segments, targets, translations, translatedFrom]);

  // ---------- 开始 / 停止 ----------
  const clearAll = () => {
    setSegments([]);
    setTranslations({});
    setTranslatedFrom({});
    pendingRef.current.clear();
  };

  const toggle = () => {
    if (recorder.recording) {
      const wav = recorder.finish();
      if (wav.length > 100) liveTranscribe.mutate(wav); // 收尾：补转最后一段
      return;
    }
    clearAll();
    setLiveError(undefined);
    recorder.start();
  };

  const canStart = ready && targets.length > 0;

  // ---------- 语言选择 ----------
  const pickSource = (code: string) => {
    setSourceLang(code);
    void rpcClient.updateSettings({ settings: { ASR_LANG: asrLangOf(code) } });
    setTargets((prev) => {
      const next = prev.filter((l) => l !== code);
      if (next.length > 0) return next;
      return [code === "zh-CN" ? "en" : "zh-CN"];
    });
  };

  const toggleTarget = (code: string) => {
    setTargets((prev) =>
      prev.includes(code) ? prev.filter((l) => l !== code) : [...prev, code],
    );
  };

  const langOptions = (allowAuto: boolean) => (
    <>
      {allowAuto && (
        <SelectItem value={TRANSLATION_SOURCE_AUTO} className="text-xs">
          {t("translate.auto")}
        </SelectItem>
      )}
      {TRANSLATION_LANGUAGES.map((l) => (
        <SelectItem key={l.code} value={l.code} className="text-xs">
          {l.nativeLabel}
        </SelectItem>
      ))}
    </>
  );

  // 字幕区自动滚到底部（新段落 / 译文到达时）。
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [segments, translations]);

  const lastSegIdx = segments.length - 1;

  return (
    <div className="flex h-full min-h-0">
      {/* 左侧：引擎与参数面板 */}
      <aside className="w-[340px] shrink-0 overflow-y-auto border-r p-4">
        <div className="flex flex-col gap-5">
          {/* 识别引擎切换 */}
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
              <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
                <ServerIcon className="size-4 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{t("voice.asrAudiocpp.engineWhisper")}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {!whisperStatus?.engineInstalled
                      ? t("voice.asr.engineNone")
                      : whisperReady
                        ? t("voice.asr.running")
                        : t("voice.asr.notRunning")}
                  </p>
                </div>
                {!whisperStatus?.engineInstalled ? (
                  <Button size="sm" disabled={installWhisper.isPending} onClick={() => installWhisper.mutate()}>
                    {installWhisper.isPending ? (
                      <Loader2Icon data-icon="inline-start" className="animate-spin" />
                    ) : (
                      <DownloadCloudIcon data-icon="inline-start" />
                    )}
                    {installWhisper.isPending ? t("voice.asr.installingEngine") : t("voice.asr.installEngine")}
                  </Button>
                ) : (
                  <Badge variant={whisperReady ? "default" : "secondary"} className="gap-1 text-[10px]">
                    {whisperReady && <CircleIcon className="size-2.5 fill-current" />}
                    {whisperReady ? t("voice.asr.running") : t("voice.asr.notRunning")}
                  </Badge>
                )}
              </div>

              <div className="flex flex-col gap-3 rounded-lg border bg-card p-3">
                <div>
                  <Label className="mb-1 block text-xs">{t("voice.local.select")}</Label>
                  {downloadedWhisper.length === 0 ? (
                    <p className="text-[11px] leading-relaxed text-amber-600">
                      {t("translate.live.noModels")}
                    </p>
                  ) : (
                    <Select value={whisperModel} onValueChange={setWhisperModel}>
                      <SelectTrigger className="h-8 w-full text-xs">
                        <SelectValue placeholder={t("voice.local.select")} />
                      </SelectTrigger>
                      <SelectContent>
                        {downloadedWhisper.map((m) => (
                          <SelectItem key={m.id} value={m.fileName} className="text-xs">
                            {m.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant={whisperReady ? "outline" : "default"}
                    disabled={
                      startWhisper.isPending ||
                      stopWhisper.isPending ||
                      downloadedWhisper.length === 0 ||
                      !whisperStatus?.engineInstalled
                    }
                    onClick={() => (whisperReady ? stopWhisper.mutate() : startWhisper.mutate())}
                  >
                    {whisperReady ? (
                      <SquareIcon data-icon="inline-start" />
                    ) : (
                      <PlayIcon data-icon="inline-start" />
                    )}
                    {whisperReady ? t("voice.local.stop") : t("voice.local.start")}
                  </Button>
                </div>
              </div>
            </>
          )}

          {engineMode === "audiocpp" && (
            <>
              <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
                <CpuIcon className="size-4 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{t("voice.asrAudiocpp.engineAcp")}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {!acpStatus?.engineInstalled
                      ? t("voice.asrAudiocpp.engineNone")
                      : acpReady
                        ? t("voice.local.running")
                        : t("voice.local.notStarted")}
                  </p>
                </div>
                {!acpStatus?.engineInstalled ? (
                  <Button size="sm" disabled={acpInstallEngine.isPending} onClick={() => acpInstallEngine.mutate()}>
                    {acpInstallEngine.isPending ? (
                      <Loader2Icon data-icon="inline-start" className="animate-spin" />
                    ) : (
                      <DownloadCloudIcon data-icon="inline-start" />
                    )}
                    {t("voice.asrAudiocpp.downloadEngine")}
                  </Button>
                ) : (
                  <Badge variant={acpReady ? "default" : "secondary"} className="gap-1 text-[10px]">
                    {acpReady && <CircleIcon className="size-2.5 fill-current" />}
                    {acpReady ? t("voice.local.running") : t("voice.local.notStarted")}
                  </Badge>
                )}
              </div>

              <div className="flex flex-col gap-3 rounded-lg border bg-card p-3">
                <div>
                  <Label className="mb-1 block text-xs">{t("voice.local.select")}</Label>
                  {downloadedAcp.length === 0 ? (
                    <p className="text-[11px] leading-relaxed text-amber-600">
                      {t("translate.live.noModels")}
                    </p>
                  ) : (
                    <Select
                      value={acpModelId}
                      onValueChange={(v) => {
                        setAcpModelId(v);
                        const m = downloadedAcp.find((x) => x.id === v);
                        if (m) acpStart.mutate(m);
                      }}
                    >
                      <SelectTrigger className="h-8 w-full text-xs">
                        <SelectValue placeholder={t("voice.local.select")} />
                      </SelectTrigger>
                      <SelectContent>
                        {downloadedAcp.map((m) => (
                          <SelectItem key={m.id} value={m.id} className="text-xs">
                            {m.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
                {acpReady && (
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" disabled={acpStop.isPending} onClick={() => acpStop.mutate()}>
                      <SquareIcon data-icon="inline-start" />
                      {t("voice.local.stop")}
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}

          {engineMode === "api" && (
            <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-xs font-medium">
                  <GlobeIcon className="size-3.5 text-muted-foreground" />
                  {t("voice.asr.providerTitle")}
                </span>
                {apiReady && (
                  <Badge variant="secondary" className="gap-1 text-[10px]">
                    <CircleIcon className="size-2.5 fill-current text-emerald-500" />
                    {t("voice.compat.configured")}
                  </Badge>
                )}
              </div>
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
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="live-asr-base" className="mb-1 block text-xs">
                  {t("voice.compat.base")}
                </Label>
                <Input
                  id="live-asr-base"
                  placeholder="https://api.openai.com/v1"
                  value={pBase}
                  onChange={(e) => setPBase(e.target.value)}
                  className="h-8 text-xs"
                />
              </div>
              <div>
                <Label htmlFor="live-asr-key" className="mb-1 block text-xs">
                  {t("voice.compat.apiKey")}
                </Label>
                <Input
                  id="live-asr-key"
                  type="password"
                  placeholder="sk-…"
                  value={pKey}
                  onChange={(e) => setPKey(e.target.value)}
                  className="h-8 text-xs"
                />
              </div>
              <div>
                <Label htmlFor="live-asr-model" className="mb-1 block text-xs">
                  {t("voice.compat.model")}
                </Label>
                <Input
                  id="live-asr-model"
                  list="live-asr-models"
                  placeholder={t("voice.compat.modelPlaceholder")}
                  value={pModel}
                  onChange={(e) => setPModel(e.target.value)}
                  className="h-8 text-xs"
                />
                {fetchModels.data?.models?.length ? (
                  <datalist id="live-asr-models">
                    {fetchModels.data.models.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                ) : null}
              </div>
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
                  {t("voice.compat.fetchModels")}
                </Button>
              </div>
              {pError && (
                <p className="text-[11px] leading-relaxed text-destructive">{pError}</p>
              )}
            </div>
          )}

          {/* 翻译引擎 */}
          <TranslationEnginePicker disabled={recorder.recording} />

          {/* 语言设置 */}
          <div className="flex flex-col gap-3 rounded-lg border bg-card p-3">
            <p className="text-xs font-medium">{t("translate.live.langTitle")}</p>
            <div>
              <Label className="mb-1 block text-xs">{t("translate.source")}</Label>
              <Select value={sourceLang} onValueChange={pickSource} disabled={recorder.recording}>
                <SelectTrigger className="h-8 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>{langOptions(true)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label className="mb-1.5 block text-xs">{t("translate.target")}</Label>
              <div className="flex flex-wrap gap-1.5">
                {TRANSLATION_LANGUAGES.filter((l) => l.code !== sourceLang).map((l) => {
                  const active = targets.includes(l.code);
                  return (
                    <button
                      key={l.code}
                      type="button"
                      onClick={() => toggleTarget(l.code)}
                      className={cn(
                        "rounded-md border px-2 py-1 text-[11px] transition-colors",
                        active
                          ? "border-primary bg-primary/10 text-primary"
                          : "text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
                      )}
                    >
                      {l.nativeLabel}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                {t("translate.live.targetsHint")}
              </p>
            </div>
          </div>

          {liveError && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] leading-relaxed text-destructive">
              {liveError}
            </div>
          )}

          {/* 开始 / 停止 */}
          <Button
            size="lg"
            className="w-full"
            disabled={!canStart || recorder.recording}
            onClick={toggle}
          >
            <MicIcon data-icon="inline-start" />
            {t("translate.live.start")}
          </Button>
          {recorder.recording && (
            <Button size="lg" variant="destructive" className="w-full" onClick={toggle}>
              <SquareIcon data-icon="inline-start" />
              {t("translate.live.stop")}
            </Button>
          )}
          {ready && targets.length === 0 && (
            <p className="text-center text-[10px] text-amber-600/80 dark:text-amber-400/80">
              {t("translate.live.needTarget")}
            </p>
          )}
          {!ready && (
            <p className="text-center text-[10px] text-amber-600/80 dark:text-amber-400/80">
              {t("translate.live.engineNotReady")}
            </p>
          )}
        </div>
      </aside>

      {/* 右侧：实时双语字幕 */}
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {recorder.recording && (
          <div className="flex h-11 shrink-0 items-center gap-3 border-b px-4">
            <span className="flex items-center gap-1.5 text-xs font-medium text-destructive">
              <CircleIcon className="size-2.5 animate-pulse fill-current" />
              {t("translate.live.listening")}
            </span>
            <span className="flex items-center gap-1 font-mono text-xs text-muted-foreground tabular-nums">
              <TimerIcon className="size-3.5" />
              {fmtClock(elapsed)}
            </span>
            <LevelBars level={level} />
            {segments.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-7 gap-1 text-[11px] text-muted-foreground"
                onClick={clearAll}
              >
                <EraserIcon className="size-3" />
                {t("translate.live.clear")}
              </Button>
            )}
          </div>
        )}

        {segments.length === 0 ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <div className="flex size-20 items-center justify-center rounded-2xl bg-primary/15">
              <LanguagesIcon className="size-9 text-primary" />
            </div>
            <p className="text-lg font-medium">{t("translate.live.title")}</p>
            <p className="max-w-xs text-sm text-muted-foreground">{t("translate.live.hint")}</p>
          </div>
        ) : (
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 py-6">
              {segments.map((seg, i) => {
                const key = segKey(seg);
                const done = translations[key] ?? {};
                const translating = targets.some((l) => !done[l]);
                return (
                  <div key={key} className="rounded-xl border bg-card p-3.5 shadow-sm">
                    <p className="text-sm leading-relaxed font-medium">
                      {seg.text}
                      {recorder.recording && i === lastSegIdx && (
                        <span className="animate-pulse text-primary">▍</span>
                      )}
                    </p>
                    {targets.map((lang) => {
                      const label =
                        TRANSLATION_LANGUAGES.find((l) => l.code === lang)?.nativeLabel ?? lang;
                      return (
                        <p key={lang} className="mt-1.5 flex items-start gap-2 text-sm leading-relaxed">
                          <span className="mt-0.5 shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {label}
                          </span>
                          <span className={cn("min-w-0 flex-1", !done[lang] && "text-muted-foreground")}>
                            {done[lang] ?? (translating ? "…" : "—")}
                          </span>
                        </p>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
