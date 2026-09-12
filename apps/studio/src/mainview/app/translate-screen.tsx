import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LanguagesIcon,
  ArrowLeftRightIcon,
  Loader2Icon,
  SendIcon,
  CopyIcon,
  CheckIcon,
  RefreshCwIcon,
  FilePlusIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Textarea } from "@ui/textarea";
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
import { useT } from "@stores/ui-lang";
import { useTranslateStore } from "@stores/translate";
import { cn } from "@/mainview/lib/utils";
import type { TranslationRecordRow } from "../../bun/translate";
import { LiveTranslateTab } from "./live-translate";
import {
  TRANSLATION_LANGUAGES,
  TRANSLATION_SOURCE_AUTO,
} from "../../shared/translate";

/** 翻译引擎：model = 当前对话模型；google = 谷歌浏览器同款免费接口。 */
export function useTranslationEngine(): "model" | "google" {
  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  return settingsData?.settings?.TRANSLATION_ENGINE === "google" ? "google" : "model";
}

/** 翻译引擎选择（与生图页后端切换同款样式）：模型翻译 / Google 免费引擎 + 模型下拉。 */
export function TranslationEnginePicker({ disabled }: { disabled?: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [pendingType, setPendingType] = useState<"local" | "api" | null>(null);

  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  const modelsQuery = useQuery({
    queryKey: ["chat-models"],
    queryFn: () => rpcClient.listChatModels(),
  });

  const settings = settingsData?.settings;
  const isGoogle = settings?.TRANSLATION_ENGINE === "google";
  const mode = settings?.SERVER_MODE ?? "local";
  const chatModel = settings?.CHAT_MODEL ?? "";
  const apiModel = settings?.VLLM_MODEL_NAME ?? "";
  const activePath = settings?.LOCAL_MODEL_PATH ?? "";
  const engineKey = isGoogle ? "google" : "model";

  const allOptions = modelsQuery.data?.models ?? [];
  // 本地只给已启动的实例（与对话一致）：翻译要的是一个正在跑的本地服务，
  // 没启动的模型选进来只会报「没模型在跑」。
  const localOptions = allOptions.filter(
    (o) =>
      o.type === "local" &&
      (o.state === "running" || o.state === "starting" || o.state === "downloading"),
  );
  const apiOptions = allOptions.filter((o) => o.type === "api");
  const current =
    mode === "remote"
      ? apiOptions.find((o) => o.isActive)?.value ?? apiModel ?? chatModel ?? ""
      : localOptions.find((o) => o.isActive)?.value ?? "";

  const switchEngine = useMutation({
    mutationFn: (engine: "model" | "google") =>
      rpcClient.updateSettings({ settings: { TRANSLATION_ENGINE: engine } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  const selectMutation = useMutation({
    mutationFn: async (opt: { type: "local" | "api"; value: string }) => {
      const r = await rpcClient.selectChatModel({ type: opt.type, value: opt.value });
      // 选了模型即回到模型翻译引擎。
      await rpcClient.updateSettings({ settings: { TRANSLATION_ENGINE: "model" } });
      return r;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["installed-models"] });
      queryClient.invalidateQueries({ queryKey: ["chat-models"] });
      queryClient.invalidateQueries({ queryKey: ["server-status"] });
    },
    onSettled: () => setPendingType(null),
  });

  const pickModel = (value: string) => {
    const option = [...localOptions, ...apiOptions].find((o) => o.value === value);
    if (!option || option.value === current) return;
    setPendingType(option.type);
    selectMutation.mutate({ type: option.type, value: option.value });
  };

  const busy = selectMutation.isPending || switchEngine.isPending || modelsQuery.isLoading || disabled;
  const selectError = selectMutation.isError
    ? String(selectMutation.error)
    : !selectMutation.isPending && selectMutation.data && !selectMutation.data.ok
      ? (selectMutation.data.error ?? "切换失败")
      : null;

  return (
    <div>
      <Label className="mb-1.5 block text-xs">{t("translate.engine.title")}</Label>
      <div className="flex overflow-hidden rounded-lg border">
        {(["model", "google"] as const).map((key) => (
          <button
            key={key}
            type="button"
            disabled={busy}
            onClick={() => switchEngine.mutate(key)}
            className={cn(
              "flex-1 px-3 py-1.5 text-xs transition-colors",
              engineKey === key
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {key === "model" ? t("translate.engine.model") : t("translate.engine.google")}
          </button>
        ))}
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
        {switchEngine.isPending
          ? t("translate.engine.switching")
          : isGoogle
            ? t("translate.engine.googleDesc")
            : t("translate.engine.modelDesc")}
      </p>

      {!isGoogle && (
        <div className="mt-2.5">
          <div className="mb-1 flex items-center justify-between">
            <Label className="text-xs">{t("translate.model")}</Label>
            <Button
              variant="ghost"
              size="icon-sm"
              tooltip={t("chat.modelRefresh")}
              onClick={() => queryClient.invalidateQueries({ queryKey: ["chat-models"] })}
              disabled={modelsQuery.isFetching || disabled}
            >
              <RefreshCwIcon
                className={cn("size-3.5", modelsQuery.isFetching && "animate-spin")}
              />
            </Button>
          </div>
          <Select value={current} onValueChange={pickModel} disabled={busy}>
            <SelectTrigger className="h-8 w-full text-xs">
              <SelectValue placeholder={t("chat.modelEmpty")} />
            </SelectTrigger>
            <SelectContent className="max-w-80">
              {localOptions.length > 0 && (
                <SelectGroup>
                  <SelectLabel>{t("chat.modelLocalRunning")}</SelectLabel>
                  {localOptions.map((o) => (
                      <SelectItem key={`local-${o.value}`} value={o.value}>
                        <span className="truncate">{o.label}</span>
                        <span className="flex min-w-0 items-center gap-1">
                          {o.engine && (
                            <span className="rounded-sm bg-muted px-1 text-[9px] leading-4 text-muted-foreground">
                              {t(`settings.engine.${o.engine}`)}
                            </span>
                          )}
                          {o.detail && (
                            <span className="truncate text-[10px] text-muted-foreground/70">
                              {o.detail}
                            </span>
                          )}
                        </span>
                      </SelectItem>
                    ))}
                </SelectGroup>
              )}
              {apiOptions.length > 0 && (
                <SelectGroup>
                  <SelectLabel>{t("chat.modelApi")}</SelectLabel>
                  {apiOptions.map((o) => (
                      <SelectItem key={`api-${o.value}`} value={o.value}>
                        <span className="truncate">{o.label}</span>
                        {o.detail && (
                          <span className="truncate text-[10px] text-muted-foreground/70">
                            {o.detail}
                          </span>
                        )}
                      </SelectItem>
                    ))}
                </SelectGroup>
              )}
              {localOptions.length === 0 && apiOptions.length === 0 && (
                <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                  {t("chat.modelEmpty")}
                </div>
              )}
            </SelectContent>
          </Select>
          {selectError && (
            <p className="mt-1 flex items-center gap-1 text-[11px] text-destructive">
              <span className="truncate">{selectError}</span>
            </p>
          )}
          {selectMutation.isPending && (
            <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
              <Loader2Icon className="size-3 shrink-0 animate-spin" />
              <span className="truncate">
                {pendingType === "local" ? t("chat.modelRestarting") : t("chat.modelSwitching")}
              </span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function CopyTextButton({ text }: { text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={!text}
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? (
        <CheckIcon data-icon="inline-start" className="text-emerald-500" />
      ) : (
        <CopyIcon data-icon="inline-start" />
      )}
      {copied ? t("translate.copied") : t("translate.copy")}
    </Button>
  );
}

function TextTranslateTab() {
  const t = useT();
  const queryClient = useQueryClient();
  const [sourceLang, setSourceLang] = useState(TRANSLATION_SOURCE_AUTO);
  const [targetLang, setTargetLang] = useState("zh-CN");
  const [text, setText] = useState("");
  const [result, setResult] = useState("");
  const [error, setError] = useState<string>();

  const activeRecord = useTranslateStore((s) => s.activeRecord);
  const selectRecord = useTranslateStore((s) => s.selectRecord);
  const clearActive = useTranslateStore((s) => s.clearActive);
  const engine = useTranslationEngine();

  // 左侧边栏点选历史记录：把原文、译文与语言加载进编辑区。
  useEffect(() => {
    if (!activeRecord) return;
    setText(activeRecord.text);
    setResult(activeRecord.result ?? "");
    setSourceLang(activeRecord.sourceLang);
    setTargetLang(activeRecord.targetLang);
    setError(undefined);
  }, [activeRecord]);

  const translate = useMutation({
    mutationFn: () =>
      rpcClient.runTranslation({
        text,
        sourceLang,
        targetLang,
        engine,
      }),
    onSuccess: (r) => {
      if (r.error) {
        setError(r.error);
        return;
      }
      setError(undefined);
      setResult(r.text ?? "");
      if (r.id != null) {
        selectRecord({
          id: r.id,
          sourceLang,
          targetLang,
          text: text.trim(),
          result: r.text ?? "",
          model: null,
          createdAt: Date.now(),
        });
        queryClient.invalidateQueries({ queryKey: ["translation-records"] });
      }
    },
    onError: (e) => setError(String(e)),
  });

  const busy = translate.isPending;
  const canSend = text.trim().length > 0 && !busy;

  const swap = () => {
    // 交换源/目标语言，连同原文与译文一起对调；目标语言不允许 auto。
    const nextSource = targetLang;
    const nextTarget = sourceLang === TRANSLATION_SOURCE_AUTO ? "en" : sourceLang;
    setSourceLang(nextSource);
    setTargetLang(nextTarget);
    clearActive();
    if (result) {
      setText(result);
      setResult(text);
    }
  };

  const resetEditor = () => {
    setText("");
    setResult("");
    setError(undefined);
    clearActive();
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
          <span className="flex w-full items-center justify-between gap-3">
            <span className="truncate">{l.nativeLabel}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground/70">
              {l.label}
            </span>
          </span>
        </SelectItem>
      ))}
    </>
  );

  return (
    <div className="flex h-full min-h-0">
      {/* 左侧：参数面板（与生图页同款布局） */}
      <aside className="w-[340px] shrink-0 overflow-y-auto border-r p-4">
        <div className="flex flex-col gap-5">
          {/* 翻译引擎 / 模型 */}
          <TranslationEnginePicker disabled={busy} />

          {/* 语言对：源语言 ⇄ 目标语言 */}
          <div className="flex items-center gap-1.5 rounded-lg border bg-card p-2.5">
            <Select value={sourceLang} onValueChange={setSourceLang} disabled={busy}>
              <SelectTrigger className="h-8 min-w-0 flex-1 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>{langOptions(true)}</SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="icon-sm"
              tooltip={t("translate.swap")}
              disabled={busy}
              onClick={swap}
              className="shrink-0"
            >
              <ArrowLeftRightIcon className="size-4" />
            </Button>
            <Select value={targetLang} onValueChange={setTargetLang} disabled={busy}>
              <SelectTrigger className="h-8 min-w-0 flex-1 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>{langOptions(false)}</SelectContent>
            </Select>
          </div>

          {/* 原文 */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <Label htmlFor="translate-text" className="text-xs">
                {t("translate.sourceLabel")}
              </Label>
              <span className="text-[10px] tabular-nums text-muted-foreground/70">
                {text.length} {t("translate.charCount")}
              </span>
            </div>
            <Textarea
              id="translate-text"
              rows={9}
              placeholder={t("translate.placeholder")}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                if (result || error) {
                  setResult("");
                  setError(undefined);
                }
                clearActive();
              }}
              disabled={busy}
              className="resize-none text-xs"
            />
            {!text.trim() && (
              <p className="mt-1 text-[10px] text-muted-foreground">{t("translate.needText")}</p>
            )}
          </div>

          {/* 翻译 */}
          <Button size="lg" className="w-full" onClick={() => translate.mutate()} disabled={!canSend}>
            {busy ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <SendIcon data-icon="inline-start" />
            )}
            {busy ? t("translate.translating") : t("translate.send")}
          </Button>

          {(activeRecord !== null || text || result) && (
            <Button variant="ghost" size="sm" className="w-full" onClick={resetEditor} disabled={busy}>
              <FilePlusIcon data-icon="inline-start" />
              {t("translate.new")}
            </Button>
          )}
        </div>
      </aside>

      {/* 右侧：结果区 */}
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-8">
          {busy ? (
            <div className="flex flex-col items-center gap-3 text-center">
              <div className="flex size-20 items-center justify-center rounded-2xl bg-primary/15">
                <Loader2Icon className="size-9 animate-spin text-primary" />
              </div>
              <p className="text-sm text-muted-foreground">{t("translate.translating")}</p>
            </div>
          ) : error ? (
            <div className="w-full max-w-md rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
              {error}
            </div>
          ) : result ? (
            <div className="w-full max-w-2xl rounded-xl border bg-card p-4 shadow-sm">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("translate.targetLabel")}
                </span>
                <CopyTextButton text={result} />
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{result}</p>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-3 text-center">
              <div className="flex size-20 items-center justify-center rounded-2xl bg-primary/15">
                <LanguagesIcon className="size-9 text-primary" />
              </div>
              <p className="text-lg font-medium">{t("translate.title")}</p>
              <p className="max-w-xs text-sm text-muted-foreground">{t("translate.sidebarHint")}</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 应用入口：左侧栏工具入口切换（文本翻译 / 同传翻译）
// ---------------------------------------------------------------------------

export function TranslateScreen() {
  const tool = useTranslateStore((s) => s.tool);
  return tool === "live" ? <LiveTranslateTab /> : <TextTranslateTab />;
}
