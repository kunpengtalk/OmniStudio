import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AudioLinesIcon, XIcon, Loader2Icon, FileAudioIcon, SparklesIcon, SquareIcon, PlayIcon, CircleIcon, ServerIcon, DownloadCloudIcon, GlobeIcon, SaveIcon, CpuIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { CloudModelSelect } from "@components/cloud-model-select";
import { ResultError, ResultEmpty } from "@components/media-result";
import { SegmentedControl } from "@components/segmented-control";
import { Button } from "@ui/button";
import { Label } from "@ui/label";
import { Textarea } from "@ui/textarea";
import { Badge } from "@ui/badge";
import { Spinner } from "@ui/spinner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { useT } from "@stores/ui-lang";
import { AUDIOCPP_REPO, AUDIOCPP_LANG_LABELS } from "@/shared/audiocpp";
import { detectReferenceAudioSupport } from "@/shared/tts-reference-audio";
import { audioVendorFor } from "@/shared/tts-voices";
import { VendorVoiceField } from "@components/vendor-voice-select";
import type { TtsLocalModelInfo } from "../../../bun/tts-local";
import type { VoiceRecordRow } from "../../../bun/voice";
import { DEFAULT_VOICE_BASE_URL } from "../voice-provider-presets";
import { PlayAudio, ResultPanel, TtsLoading, SettingsValues, useClones, EdgeVoicePicker, LocalModelRow, LocalVoicePicker } from "./parts";

export function TtsTab() {
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
      if (!r.ok) setLocalError(t("voice.engine.deleteFailed"));
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
  const configured = !!provider?.providerId;
  // 云端 TTS 只记厂商 id：地址 / 密钥在「设置 → 模型云服务」里（本页不再输入）。
  const [pProviderId, setPProviderId] = useState("");
  const [pError, setPError] = useState<string>();
  // 参考音频：已选文件（ref 传给后端 / url 前端预览）+ 是否手动覆盖“该模型支持参考音频”（null=跟随自动检测）。
  const [refAudio, setRefAudio] = useState<{ ref: string; url: string } | null>(null);
  const [refOverride, setRefOverride] = useState<boolean | null>(null);
  const syncedRef = useRef(false);
  useEffect(() => {
    if (provider && !syncedRef.current) {
      syncedRef.current = true;
      setPProviderId(provider.providerId);
      setModel((m) => m || provider.model);
    }
  }, [provider]);

  const saveProvider = useMutation({
    // 选择值由调用方传进来（`mutate(choice)`，与生图页同一写法）：在 onChange 里紧接着
    // `setState` 再调 `mutate()` 的话，mutationFn 读到的是**这一次渲染的旧值** ——
    // 存下去的仍是上一个厂商。
    mutationFn: (choice: { providerId?: string; model?: string } = {}) =>
      rpcClient.saveTTSProviderConfig({
        providerId: (choice?.providerId ?? pProviderId).trim(),
        model: (choice?.model ?? model).trim(),
      }),
    onSuccess: (res) => {
      setPError(undefined);
      // 换厂商后主进程可能把音色落成新厂商的默认值（alloy → cixingnansheng）：跟着显示，
      // 否则音色栏写的还是别家的名字。
      if (res.voice) setVoice(res.voice);
      queryClient.invalidateQueries({ queryKey: ["tts-provider"] });
      queryClient.invalidateQueries({ queryKey: ["cloud-providers"] });
    },
    // 保存失败必须说出来：下面那段 `{pError && …}` 就是为它留的位置，
    // 没有 onError 的话点「保存」失败时界面上一点反应都没有（按钮转一下就恢复原样），
    // 用户会以为已经保存好了。
    onError: (error) => setPError(error instanceof Error ? error.message : String(error)),
  });

  // 参考音频能力：跟随自动检测，可被手动开关覆盖。base 用厂商地址（空则回退线上默认）。
  const compatBase = provider?.base || DEFAULT_VOICE_BASE_URL;
  const supportsRef = refOverride ?? detectReferenceAudioSupport(model, compatBase);
  // 当前厂商：决定音色栏给不给官方音色清单（阶跃等已收录的厂商才有）。
  const compatVendor = audioVendorFor({ providerId: pProviderId || provider?.providerId, baseUrl: compatBase });

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
            <SegmentedControl
              variant="attached"
              value={source}
              onChange={switchSource}
              options={[
                { value: "local", label: t("voice.tts.sourceLocal"), icon: <CpuIcon className="size-3.5" /> },
                { value: "edge", label: t("voice.tts.sourceEdge"), icon: <GlobeIcon className="size-3.5" /> },
                { value: "compat", label: t("voice.tts.sourceCompat"), icon: <ServerIcon className="size-3.5" /> },
              ]}
            />
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
              {/* 服务配置：云厂商 + 模型（地址与密钥由厂商行提供，页面不再手填） */}
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

                {/* 厂商 + 模型：都是「设置 → 模型云服务」里配好并启动过的 TTS 模型 */}
                <div>
                  <Label className="mb-1 block text-xs">{t("voice.compat.cloudProvider")}</Label>
                  <CloudModelSelect
                    kind="tts"
                    providerId={pProviderId}
                    model={model}
                    size="sm"
                    onChange={(choice) => {
                      // 选完即存（与生图页一致）：只改本地 state 的话，用户没点「保存」
                      // 就合成，后端仍按**旧厂商**的地址发**新模型名** —— 上游只会回一句
                      // 看不懂的错，而界面上显示的是新的那个。
                      setPProviderId(choice.providerId);
                      if (choice.model) setModel(choice.model);
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

              {/* 音色：认得出的厂商给官方音色下拉，认不出的保持自由输入（见 VendorVoiceField） */}
              <VendorVoiceField
                vendor={compatVendor}
                value={voice}
                onChange={setVoice}
                label={t("voice.tts.voice")}
                labelClassName="text-xs"
                placeholder={t("voice.tts.voiceNamePlaceholder")}
              />
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

