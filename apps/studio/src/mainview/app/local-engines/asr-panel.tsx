import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon, PlayIcon, SquareIcon, StopCircleIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Badge } from "@ui/badge";
import { CheckCircle2Icon } from "lucide-react";
import { useModelDownloadStore } from "@stores/model-download";
import { useT } from "@stores/ui-lang";
import { ASR_PRESETS } from "@/shared/modelscope";
import { AUDIOCPP_REPO } from "@/shared/audiocpp";
import {
  CommitInput,
  DownloadControls,
  EngineInstallRow,
  PanelCard,
  ProviderForm,
  StatusRow,
  formatBytes,
  useSettingsBlob,
  useSettingsPatch,
} from "./shared";

type AsrEngineKind = "whisper" | "audiocpp" | "api";

function anyDownloading() {
  return useModelDownloadStore
    .getState()
    .tasks.some((t) => t.status === "downloading" || t.status === "queued");
}

// ---------------------------------------------------------------------------
// whisper.cpp（常驻服务器）
// ---------------------------------------------------------------------------

function WhisperSection({ port }: { port: string }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [modelsDirty, setModelsDirty] = useState(false);

  const statusQuery = useQuery({
    queryKey: ["asr-status"],
    queryFn: () => rpcClient.getAsrStatus(),
    refetchInterval: 2500,
  });
  const modelsQuery = useQuery({
    queryKey: ["asr-models"],
    queryFn: () => rpcClient.listAsrModels(),
    refetchInterval: modelsDirty ? 3000 : false,
  });

  const installMutation = useMutation({
    mutationFn: () => rpcClient.downloadWhisperEngine(),
    onSuccess: () => statusQuery.refetch(),
  });
  const startMutation = useMutation({
    mutationFn: (model: string) => rpcClient.startAsr({ model }),
    onSuccess: () => statusQuery.refetch(),
  });
  const stopMutation = useMutation({
    mutationFn: () => rpcClient.stopAsr(),
    onSuccess: () => statusQuery.refetch(),
  });

  const status = statusQuery.data;
  const running = !!status?.serverRunning;

  // 下载任务推进时刷新已安装状态
  const tasks = useModelDownloadStore((s) => s.tasks);
  useEffect(() => {
    if (tasks.some((x) => x.status === "downloading" || x.status === "queued")) setModelsDirty(true);
    if (modelsDirty && !tasks.some((x) => x.status === "downloading" || x.status === "queued")) setModelsDirty(false);
  }, [tasks, modelsDirty]);

  return (
    <div className="flex flex-col gap-3">
      <EngineInstallRow
        installed={!!status?.engineInstalled}
        detail={status?.engineInstalled ? `whisper.cpp ${status.engineVersion ?? ""}`.trim() : undefined}
        onInstall={() => installMutation.mutate()}
        installing={installMutation.isPending}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <CommitInput
          label={t("engine.port")}
          type="number"
          value={port}
          onCommit={(v) => rpcClient.updateSettings({ settings: { ASR_PORT: v } }).then(() => queryClient.invalidateQueries({ queryKey: ["settings"] }))}
        />
        <div className="flex items-end">
          <StatusRow
            label={t("engine.status")}
            tone={running ? "on" : "off"}
            text={running ? `${t("engine.status.running")} · :${port}` : t("engine.status.stopped")}
          />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {(modelsQuery.data?.models ?? ASR_PRESETS.map((p) => ({ ...p, installed: false, installedSize: null, installedPath: null as string | null, id: p.id }))).map((m) => {
          const isRunning = running && status?.activeModel === m.installedPath;
          return (
            <div key={m.id} className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-xs font-medium">{m.label}</p>
                  <span className="text-[11px] text-muted-foreground">{formatBytes(m.sizeBytes)}</span>
                </div>
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{m.description}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <DownloadControls
                  repo={m.repo}
                  fileName={m.fileName}
                  category="asr"
                  installed={!!m.installedPath}
                />
                {m.installedPath ? (
                  isRunning ? (
                    <>
                      <Badge variant="default" className="gap-1 text-[10px]">
                        <CheckCircle2Icon className="size-3" /> {t("engine.inUse")}
                      </Badge>
                      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => stopMutation.mutate()}>
                        <SquareIcon data-icon="inline-start" />
                        {t("engine.stop")}
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      className="h-7 text-xs"
                      disabled={startMutation.isPending}
                      onClick={() => startMutation.mutate(m.fileName)}
                    >
                      {startMutation.isPending ? (
                        <Loader2Icon data-icon="inline-start" className="animate-spin" />
                      ) : (
                        <PlayIcon data-icon="inline-start" />
                      )}
                      {t("engine.start")}
                    </Button>
                  )
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// audio.cpp（按需执行）
// ---------------------------------------------------------------------------

function AudioCppSection() {
  const t = useT();
  const queryClient = useQueryClient();
  const [modelsDirty, setModelsDirty] = useState(false);

  const statusQuery = useQuery({
    queryKey: ["asr-audiocpp-status"],
    queryFn: () => rpcClient.getAsrAudioCppStatus(),
    refetchInterval: 2500,
  });
  const modelsQuery = useQuery({
    queryKey: ["asr-audiocpp-models"],
    queryFn: () => rpcClient.listAsrAudioCppModels(),
    refetchInterval: modelsDirty ? 3000 : false,
  });

  const installMutation = useMutation({
    mutationFn: () => rpcClient.downloadTtsLocalEngine(),
    onSuccess: () => statusQuery.refetch(),
  });
  const startMutation = useMutation({
    mutationFn: (modelId: string) => rpcClient.startAsrAudioCpp({ modelId }),
    onSuccess: () => {
      statusQuery.refetch();
      queryClient.invalidateQueries({ queryKey: ["asr-audiocpp-models"] });
    },
  });
  const stopMutation = useMutation({
    mutationFn: () => rpcClient.stopAsrAudioCpp(),
    onSuccess: () => {
      statusQuery.refetch();
      queryClient.invalidateQueries({ queryKey: ["asr-audiocpp-models"] });
    },
  });

  const status = statusQuery.data;
  const tasks = useModelDownloadStore((s) => s.tasks);
  useEffect(() => {
    if (tasks.some((x) => x.status === "downloading" || x.status === "queued")) setModelsDirty(true);
    if (modelsDirty && !tasks.some((x) => x.status === "downloading" || x.status === "queued")) setModelsDirty(false);
  }, [tasks, modelsDirty]);

  return (
    <div className="flex flex-col gap-3">
      <EngineInstallRow
        installed={!!status?.engineInstalled}
        detail={status?.engineInstalled ? "audio.cpp" : undefined}
        onInstall={() => installMutation.mutate()}
        installing={installMutation.isPending}
      />
      <div className="flex items-center">
        <StatusRow
          label={t("engine.status")}
          tone={status?.active && status.activeModelId ? "on" : "off"}
          text={status?.active && status.activeModelId ? t("engine.status.enabled") : t("engine.status.disabled")}
        />
      </div>
      <div className="flex flex-col gap-2">
        {(modelsQuery.data?.models ?? []).map((m) => (
          <div key={m.id} className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate text-xs font-medium">{m.name}</p>
                <span className="text-[11px] text-muted-foreground">{formatBytes(m.sizeBytes)}</span>
              </div>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{m.description}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <DownloadControls
                repo={AUDIOCPP_REPO}
                fileName={m.repoPath}
                category="asr"
                source="huggingface"
                installed={m.downloaded}
              />
              {m.downloaded &&
                (m.active ? (
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => stopMutation.mutate()}>
                    <StopCircleIcon data-icon="inline-start" />
                    {t("engine.disable")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    disabled={startMutation.isPending}
                    onClick={() => startMutation.mutate(m.id)}
                  >
                    {startMutation.isPending ? (
                      <Loader2Icon data-icon="inline-start" className="animate-spin" />
                    ) : (
                      <PlayIcon data-icon="inline-start" />
                    )}
                    {t("engine.useModel")}
                  </Button>
                ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 面板入口
// ---------------------------------------------------------------------------

export function AsrPanel() {
  const t = useT();
  const { data } = useSettingsBlob();
  const patch = useSettingsPatch();
  const settings = data?.settings ?? {};
  const [engine, setEngine] = useState<AsrEngineKind>((settings.ASR_ENGINE as AsrEngineKind) ?? "whisper");

  useEffect(() => {
    const v = settings.ASR_ENGINE as AsrEngineKind | undefined;
    if (v && v !== engine) setEngine(v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.ASR_ENGINE]);

  const switchEngine = (next: AsrEngineKind) => {
    setEngine(next);
    patch.mutate({ ASR_ENGINE: next });
    if (next !== "whisper") {
      // 离开 whisper 模式时停止其服务器（与语音页行为一致）
      void rpcClient.stopAsr();
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-1.5">
        {(
          [
            { value: "whisper", labelKey: "engine.asr.whisper" },
            { value: "audiocpp", labelKey: "engine.asr.audiocpp" },
            { value: "api", labelKey: "engine.asr.api" },
          ] as const
        ).map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => switchEngine(o.value)}
            className={
              engine === o.value
                ? "rounded-full border border-primary bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary"
                : "rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground"
            }
          >
            {t(o.labelKey)}
          </button>
        ))}
      </div>

      <PanelCard title={t("engine.modelSection")} className="pt-4">
        {engine === "whisper" && <WhisperSection port={settings.ASR_PORT ?? "18081"} />}
        {engine === "audiocpp" && <AudioCppSection />}
        {engine === "api" && (
          <ProviderForm
            base={settings.ASR_PROVIDER_BASE ?? ""}
            apiKey={settings.ASR_PROVIDER_API_KEY ?? ""}
            model={settings.ASR_PROVIDER_MODEL ?? ""}
            saving={patch.isPending}
            onSave={(cfg) => patch.mutate({ ASR_PROVIDER_BASE: cfg.base, ASR_PROVIDER_API_KEY: cfg.apiKey, ASR_PROVIDER_MODEL: cfg.model })}
          />
        )}
      </PanelCard>
    </div>
  );
}
