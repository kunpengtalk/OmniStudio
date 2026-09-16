import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { rpcClient } from "@lib/rpc";
import { SelectItem } from "@ui/select";
import { useT } from "@stores/ui-lang";
import { useMicRecorder } from "@hooks/use-mic-recorder";
import type { AsrSegment } from "../../../bun/asr";
import type { AsrAudioCppModelInfo } from "../../../bun/asr-audiocpp";
import { mergeSegments } from "../voice-asr-result";
import { useTranslationEngine } from "../translate/engine-picker";
import { TRANSLATION_LANGUAGES, TRANSLATION_SOURCE_AUTO } from "../../../shared/translate";
import { planLiveTranslations } from "@/mainview/lib/live-translate-queue";
import { segKey, asrLangOf, translateLangOf, type AsrEngineMode } from "./parts";

/** 实时翻译的全部状态与副作用（渲染见 index.tsx）。 */
export function useLiveTranslate() {
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
      setLiveError(r.ok ? undefined : (r.error ?? t("voice.engine.installFailed")));
      refresh();
    },
  });
  const startWhisper = useMutation({
    mutationFn: () => rpcClient.startAsr({ model: whisperModel || downloadedWhisper[0]?.fileName }),
    onSuccess: (r) => {
      setLiveError(r.ok ? undefined : (r.error ?? t("voice.engine.startFailed")));
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
      setLiveError(r.ok ? undefined : (r.error ?? t("voice.engine.startFailed")));
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
  const apiReady = !!provider?.providerId;
  // 与语音页共用同一份 ASR 厂商配置：这里也只选厂商 + 模型。
  const [pProviderId, setPProviderId] = useState("");
  const [pModel, setPModel] = useState("");
  const [pError, setPError] = useState<string>();
  const providerSynced = useRef(false);
  useEffect(() => {
    if (provider && !providerSynced.current) {
      providerSynced.current = true;
      setPProviderId(provider.providerId);
      setPModel(provider.model);
    }
  }, [provider]);

  const saveProvider = useMutation({
    mutationFn: () =>
      rpcClient.saveASRProviderConfig({ providerId: pProviderId.trim(), model: pModel.trim() }),
    onSuccess: () => {
      setPError(undefined);
      queryClient.invalidateQueries({ queryKey: ["asr-provider"] });
      queryClient.invalidateQueries({ queryKey: ["cloud-providers"] });
    },
    // 保存失败必须说出来：下面那段 `{pError && …}` 就是为它留的位置。
    onError: (error) => setPError(error instanceof Error ? error.message : String(error)),
  });

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
    // 派发计划抽成纯函数（见 lib/live-translate-queue.ts）：它同时管住"原文还在变就别翻"
    // 与"在飞请求上限"—— 后者原先是缺的，10 段 × 5 语种会一次打 50 个并发请求。
    const plan = planLiveTranslations({
      segments: segments.map((seg) => ({ key: segKey(seg), text: seg.text })),
      targets,
      translations,
      translatedFrom,
      pending: pendingRef.current,
    });
    for (const r of plan.resync) {
      // 新段落或识别中的原文还在变：更新锚点并丢弃旧译文，下一轮再发起翻译。
      setTranslatedFrom((prev) => ({ ...prev, [r.key]: r.text }));
      setTranslations((prev) => {
        if (!prev[r.key]) return prev;
        const next = { ...prev };
        delete next[r.key];
        return next;
      });
    }
    for (const d of plan.dispatch) {
      pendingRef.current.add(`${d.key}|${d.lang}`);
      translateSeg.mutate(d);
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

  return {
    t,
    engine,
    engineMode,
    sourceLang,
    targets,
    segments,
    translations,
    liveError,
    level,
    elapsed,
    switchEngine,
    whisperStatus,
    whisperReady,
    downloadedWhisper,
    whisperModel,
    setWhisperModel,
    installWhisper,
    startWhisper,
    stopWhisper,
    acpStatus,
    acpReady,
    downloadedAcp,
    acpModelId,
    setAcpModelId,
    acpInstallEngine,
    acpStart,
    acpStop,
    apiReady,
    pProviderId,
    setPProviderId,
    pModel,
    setPModel,
    pError,
    saveProvider,
    ready,
    recorder,
    clearAll,
    toggle,
    canStart,
    pickSource,
    toggleTarget,
    langOptions,
    scrollRef,
    lastSegIdx,
  };
}
