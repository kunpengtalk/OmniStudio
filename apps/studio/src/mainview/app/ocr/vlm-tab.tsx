import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpIcon,
  CheckCircle2Icon,
  FolderIcon,
  GlobeIcon,
  Loader2Icon,
  PlayIcon,
  ServerIcon,
  SettingsIcon,
  SparklesIcon,
  StoreIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Badge } from "@ui/badge";
import { Button } from "@ui/button";
import { Label } from "@ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@ui/select";
import { useRouter } from "@stores/router";
import { useServerStore } from "@stores/server";
import { useT, useTOptional } from "@stores/ui-lang";
import { CloudModelSelect } from "@components/cloud-model-select";
import { fileKind, engineSupports, type InferenceEngine } from "../../../shared/modelscope";
import { MODEL_PROFILES } from "../../../shared/model-profiles";
import {
  CopyButton,
  EmptyResult,
  ErrorNote,
  ImagePicker,
  ImagePreview,
  PanelSection,
  ResultHeader,
  ResultText,
  SegmentedControl,
  StatusCard,
  Workbench,
  type StagedImage,
} from "./parts";

type VlmSource = "local" | "remote";

export function VlmTab({
  image,
  onImageChange,
  engineSwitcher,
}: {
  image: StagedImage | null;
  onImageChange: (img: StagedImage | null) => void;
  engineSwitcher?: React.ReactNode;
}) {
  const t = useT();
  const tOptional = useTOptional();
  const queryClient = useQueryClient();
  const router = useRouter();
  const serverStatus = useServerStore((s) => s.status);
  const serverRunning = serverStatus === "running";
  const serverBusy = serverStatus === "starting" || serverStatus === "downloading";

  const [source, setSource] = useState<VlmSource>("local");
  const [profileId, setProfileId] = useState("");
  const [modelPath, setModelPath] = useState("");
  const [result, setResult] = useState<{ markdown: string; modelLabel: string } | null>(null);
  const [error, setError] = useState<string>();

  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  const settings = settingsData?.settings;
  const engine = (settings?.INFERENCE_ENGINE as InferenceEngine) || "llama.cpp";

  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current || !settingsData?.settings) return;
    hydrated.current = true;
    const savedProfile = settingsData.settings.VLLM_MODEL_PROFILE;
    if (savedProfile && MODEL_PROFILES.some((p) => p.id === savedProfile)) {
      setProfileId(savedProfile);
    }
    const savedSource = settingsData.settings.OCR_VLM_SOURCE;
    if (savedSource === "local" || savedSource === "remote") setSource(savedSource);
  }, [settingsData]);

  const switchSource = (v: VlmSource) => {
    setSource(v);
    setError(undefined);
    void rpcClient.updateSettings({ settings: { OCR_VLM_SOURCE: v } });
  };

  const switchProfile = (v: string) => {
    setProfileId(v);
    void rpcClient.updateSettings({ settings: { VLLM_MODEL_PROFILE: v } });
  };

  // ---------- 本地推理引擎 ----------
  const { data: installedData } = useQuery({
    queryKey: ["installed-models"],
    queryFn: () => rpcClient.listInstalledModels(),
  });
  const installedModels = (installedData?.models ?? [])
    // 目录条目（整个仓库）文件名没有扩展名，格式按目录内容判定。
    .filter((m) => engineSupports(engine, m.kind ?? fileKind(m.fileName)))
    // VLM 选的是对话模型：嵌入 / 重排类别会被 setActiveModel 拒掉，别让它们进下拉框。
    .filter((m) => m.category !== "embedding" && m.category !== "rerank")
    .sort((a, b) => Number(b.isActive) - Number(a.isActive));

  useEffect(() => {
    if (modelPath) return;
    const active = installedModels.find((m) => m.isActive) ?? installedModels[0];
    if (active) setModelPath(active.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installedModels.length]);

  const selectedModel = installedModels.find((m) => m.path === modelPath) ?? null;

  const selectModel = (path: string) => {
    setModelPath(path);
    setError(undefined);
    void rpcClient.setActiveModel({ path }).then((r) => {
      if (!r.ok) setError(r.error ?? t("ocr.vlm.needModelFirst"));
      void queryClient.invalidateQueries({ queryKey: ["installed-models"] });
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
      if (r && !r.ok) setError(r.error ?? t("ocr.vlm.serverHint"));
      void queryClient.invalidateQueries({ queryKey: ["installed-models"] });
    },
    onError: (e) => setError(String(e)),
  });

  // ---------- 远程 OpenAI 兼容服务 ----------
  const { data: providerData } = useQuery({
    queryKey: ["ocr-provider"],
    queryFn: () => rpcClient.getOcrProviderConfig(),
  });
  const provider = providerData?.config;
  const configured = !!provider?.providerId;

  // 云端 VLM OCR 只选厂商 + 模型（地址 / 密钥在「设置 → 模型云服务」里）。
  const [pProviderId, setPProviderId] = useState("");
  const [pModel, setPModel] = useState("");
  const lastProvider = useRef("");
  useEffect(() => {
    if (!provider) return;
    const sig = `${provider.providerId}|${provider.model}`;
    if (sig === lastProvider.current) return;
    lastProvider.current = sig;
    setPProviderId(provider.providerId);
    setPModel(provider.model ?? "");
  }, [provider]);

  const saveProvider = useMutation({
    mutationFn: () =>
      rpcClient.saveOcrProviderConfig({
        providerId: pProviderId.trim(),
        model: pModel.trim(),
      }),
    onSuccess: () => {
      setError(undefined);
      void queryClient.invalidateQueries({ queryKey: ["ocr-provider"] });
      void queryClient.invalidateQueries({ queryKey: ["cloud-providers"] });
    },
    onError: (e) => setError(String(e)),
  });

  const run = useMutation({
    mutationFn: () =>
      rpcClient.runOcrVlm({
        imageRef: image!.ref,
        profileId: profileId || undefined,
        source,
      }),
    onSuccess: (r) => {
      if (r.error || !r.result) {
        setError(r.error ?? t("ocr.empty"));
        setResult(null);
        return;
      }
      setError(undefined);
      setResult({ markdown: r.result.markdown, modelLabel: r.result.modelLabel });
      // 识别记录已入库（saveOcrRecord），刷新侧边栏「OCR 记录」列表。
      void queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
    onError: (e) => setError(String(e)),
  });

  const blocked = !image
    ? t("ocr.error.empty")
    : source === "remote"
      ? configured
        ? undefined
        : t("ocr.vlm.remote.notConfigured")
      : !serverRunning
        ? t("ocr.vlm.serverHint")
        : !selectedModel
          ? t("ocr.vlm.needModelFirst")
          : undefined;

  const panel = (
    <>
      {engineSwitcher}
      <PanelSection title={t("ocr.vlm.source")} hint={t("ocr.vlm.desc")}>
        <SegmentedControl<VlmSource>
          value={source}
          onChange={switchSource}
          options={[
            {
              value: "local",
              label: t("ocr.vlm.sourceLocal"),
              icon: <ServerIcon className="size-3.5" />,
            },
            {
              value: "remote",
              label: t("ocr.vlm.sourceRemote"),
              icon: <GlobeIcon className="size-3.5" />,
            },
          ]}
        />
      </PanelSection>

      {source === "remote" ? (
        <>
          <PanelSection title={t("ocr.vlm.sourceRemote")} hint={t("ocr.vlm.remote.desc")}>
            <StatusCard
              icon={<GlobeIcon className="size-4" />}
              tone={configured ? "ok" : "warn"}
              title={configured ? t("ocr.vlm.remote.configured") : t("ocr.vlm.remote.notConfigured")}
              detail={provider?.model ? provider.model : undefined}
            />
          </PanelSection>

          <PanelSection title={t("ocr.vlm.remote.settings")} hint={t("cloud.where")}>
            <div className="flex flex-col gap-2.5">
              <div className="flex flex-col gap-1">
                <Label className="text-[11px] text-muted-foreground">
                  {t("ocr.vlm.remote.cloudProvider")}
                </Label>
                <CloudModelSelect
                  // 用途分类里没有单独的"视觉"维度：VLM 与对话模型同属 `chat`，
                  // 所以这里只按 chat 过滤（`CloudModelType` 见 shared/cloud-providers.ts）。
                  kind="chat"
                  providerId={pProviderId}
                  model={pModel}
                  size="sm"
                  onChange={(choice) => {
                    setPProviderId(choice.providerId);
                    if (choice.model) setPModel(choice.model);
                  }}
                />
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  size="xs"
                  disabled={saveProvider.isPending || !pProviderId.trim()}
                  onClick={() => saveProvider.mutate()}
                >
                  {saveProvider.isPending ? (
                    <Loader2Icon data-icon="inline-start" className="animate-spin" />
                  ) : (
                    <CheckCircle2Icon data-icon="inline-start" />
                  )}
                  {t("ocr.vlm.remote.save")}
                </Button>
              </div>
            </div>
          </PanelSection>
        </>
      ) : (
        <>
          <PanelSection title={t("ocr.engine.vlm")}>
            <StatusCard
              icon={<ServerIcon className="size-4" />}
              tone={serverRunning ? "ok" : "warn"}
              title={serverRunning ? t("ocr.vlm.serverRunning") : t("ocr.vlm.serverHint")}
              detail={
                selectedModel
                  ? `${t("ocr.vlm.activeModel")}：${selectedModel.fileName}`
                  : undefined
              }
              action={
                <>
                  <Button
                    size="xs"
                    disabled={!selectedModel || startServer.isPending || serverBusy}
                    onClick={() => startServer.mutate()}
                  >
                    {startServer.isPending ? (
                      <Loader2Icon data-icon="inline-start" className="animate-spin" />
                    ) : (
                      <PlayIcon data-icon="inline-start" />
                    )}
                    {serverRunning ? t("ocr.vlm.restart") : t("ocr.vlm.startServer")}
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => router.setRoute({ path: "settings" })}
                  >
                    <SettingsIcon data-icon="inline-start" />
                    {t("ocr.vlm.openSettings")}
                  </Button>
                </>
              }
            />
            {serverRunning ? (
              <p className="text-[11px] text-amber-600">{t("ocr.vlm.restartHint")}</p>
            ) : null}
          </PanelSection>

          <PanelSection title={t("ocr.vlm.model")} hint={t("ocr.vlm.modelHint")}>
            {installedModels.length === 0 ? (
              <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed px-3 py-3">
                <p className="text-[11px] text-muted-foreground">{t("ocr.vlm.noModels")}</p>
                <Button size="xs" variant="outline" onClick={() => router.setRoute({ path: "settings", tab: "store" })}>
                  <StoreIcon data-icon="inline-start" />
                  {t("ocr.vlm.goLibrary")}
                </Button>
              </div>
            ) : (
              <Select value={selectedModel?.path ?? ""} onValueChange={selectModel}>
                <SelectTrigger className="h-9 w-full text-xs">
                  <SelectValue placeholder={t("ocr.vlm.model")} />
                </SelectTrigger>
                <SelectContent className="w-[28rem] max-w-[min(28rem,90vw)]">
                  {installedModels.map((m) => (
                    <SelectItem key={m.path} value={m.path} className="text-xs">
                      <span className="flex w-full min-w-0 items-center justify-between gap-2">
                        <span className="truncate">{m.fileName}</span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          {m.isDir && <FolderIcon className="size-3 text-muted-foreground/60" />}
                          <span className="max-w-40 truncate text-[10px] text-muted-foreground/70">
                            {m.repo}
                          </span>
                          {m.isActive ? (
                            <span className="text-[10px] text-emerald-500">
                              {t("ocr.vlm.activeModel")}
                            </span>
                          ) : null}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </PanelSection>
        </>
      )}

      <PanelSection title={t("ocr.vlm.profile")}>
        <Select value={profileId} onValueChange={switchProfile}>
          <SelectTrigger className="h-8 w-full text-xs">
            <SelectValue placeholder={t("ocr.vlm.profile")} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>{t("ocr.vlm.profile")}</SelectLabel>
              {MODEL_PROFILES.map((p) => (
                <SelectItem key={p.id} value={p.id} className="text-xs">
                  <span className="flex w-full items-center gap-2">
                    <span className="truncate">{p.label}</span>
                    {p.badge ? (
                      <Badge variant="secondary" className="shrink-0 text-[9px]">
                        {tOptional(`modelProfile.${p.id}.badge`, p.badge)}
                      </Badge>
                    ) : null}
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {/* 档案说明来自 shared/model-profiles.ts（英文），词条里备了中英两份：
              英文界面下不再硬塞英文说明，中文界面下也不再是英文。 */}
          {tOptional(
            `modelProfile.${profileId}.description`,
            MODEL_PROFILES.find((p) => p.id === profileId)?.description ?? t("ocr.vlm.profile"),
          )}
        </p>
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
    <ResultHeader meta={result?.modelLabel}>
      {result ? <CopyButton text={result.markdown} /> : null}
    </ResultHeader>
  );

  const resultBody = !result ? (
    <EmptyResult
      icon={<SparklesIcon className="size-7 text-muted-foreground" />}
      hint={t("ocr.noResult")}
    />
  ) : (
    <div className="flex flex-col gap-3 p-4">
      {image ? <ImagePreview image={image} /> : null}
      <ResultText text={result.markdown || t("ocr.empty")} />
    </div>
  );

  return (
    <Workbench panel={panel} footer={footer} resultHeader={resultHeader} result={resultBody} />
  );
}
