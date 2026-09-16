import { CircleIcon, CpuIcon, DownloadCloudIcon, EraserIcon, GlobeIcon, LanguagesIcon, Loader2Icon, MicIcon, PlayIcon, SaveIcon, ServerIcon, SquareIcon, TimerIcon } from "lucide-react";
import { Badge } from "@ui/badge";
import { Button } from "@ui/button";
import { Label } from "@ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { CloudModelSelect } from "@components/cloud-model-select";
import { fmtClock } from "../voice-asr-result";
import { TranslationEnginePicker } from "../translate/engine-picker";
import { TRANSLATION_LANGUAGES } from "../../../shared/translate";
import { cn } from "@/mainview/lib/utils";
import { SegmentedControl } from "@components/segmented-control";
import { useLiveTranslate } from "./use-live-translate";
import { segKey, LevelBars } from "./parts";

export function LiveTranslateTab() {
  const { t, engineMode, sourceLang, targets, segments, translations, liveError, level, elapsed, switchEngine, whisperStatus, whisperReady, downloadedWhisper, whisperModel, setWhisperModel, installWhisper, startWhisper, stopWhisper, acpStatus, acpReady, downloadedAcp, acpModelId, setAcpModelId, acpInstallEngine, acpStart, acpStop, apiReady, pProviderId, setPProviderId, pModel, setPModel, pError, saveProvider, ready, recorder, clearAll, toggle, canStart, pickSource, toggleTarget, langOptions, scrollRef, lastSegIdx } = useLiveTranslate();

return (
    <div className="flex h-full min-h-0">
      {/* 左侧：引擎与参数面板 */}
      <aside className="w-[340px] shrink-0 overflow-y-auto border-r p-4">
        <div className="flex flex-col gap-5">
          {/* 识别引擎切换 */}
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
                <Label className="mb-1 block text-xs">{t("voice.asr.cloudProvider")}</Label>
                <CloudModelSelect
                  kind="asr"
                  providerId={pProviderId}
                  model={pModel}
                  size="sm"
                  disabled={recorder.recording}
                  onChange={(choice) => {
                    setPProviderId(choice.providerId);
                    if (choice.model) setPModel(choice.model);
                  }}
                />
                <p className="mt-1.5 text-[10px] text-muted-foreground">{t("cloud.where")}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button
                  size="sm"
                  onClick={() => saveProvider.mutate()}
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
