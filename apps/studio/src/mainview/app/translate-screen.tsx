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
  SparklesIcon,
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
import {
  TRANSLATION_LANGUAGES,
  TRANSLATION_SOURCE_AUTO,
} from "../../shared/translate";

/** 模型选择器中「Google 翻译」引擎的特殊取值（不是真实模型名）。 */
const GOOGLE_ENGINE_VALUE = "google-engine";

/** 翻译引擎：model = 当前对话模型；google = 谷歌浏览器同款免费接口。 */
function useTranslationEngine(): "model" | "google" {
  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  return settingsData?.settings?.TRANSLATION_ENGINE === "google" ? "google" : "model";
}

/** 模型/引擎选择器（内联紧凑版）：Google 免费引擎 + 本地模型 + OpenAI 兼容 API 模型。 */
function TranslationEnginePicker({ disabled }: { disabled?: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [pendingType, setPendingType] = useState<"local" | "api" | "google" | null>(null);

  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  const modelsQuery = useQuery({
    queryKey: ["chat-models"],
    queryFn: () => rpcClient.listChatModels(),
  });

  const settings = settingsData?.settings;
  const mode = settings?.SERVER_MODE ?? "local";
  const chatModel = settings?.CHAT_MODEL ?? "";
  const apiModel = settings?.VLLM_MODEL_NAME ?? "";
  const activePath = settings?.LOCAL_MODEL_PATH ?? "";
  const isGoogle = settings?.TRANSLATION_ENGINE === "google";

  const options = modelsQuery.data?.models ?? [];
  const current = isGoogle
    ? GOOGLE_ENGINE_VALUE
    : mode === "remote"
      ? apiModel || chatModel || ""
      : activePath || chatModel || "";

  const selectMutation = useMutation({
    mutationFn: async (opt: { type: "local" | "api" | "google"; value: string }) => {
      if (opt.type === "google") {
        await rpcClient.updateSettings({ settings: { TRANSLATION_ENGINE: "google" } });
        return { ok: true };
      }
      const r = await rpcClient.selectChatModel({ type: opt.type, value: opt.value });
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

  const handleChange = (value: string) => {
    if (value === GOOGLE_ENGINE_VALUE) {
      if (current === GOOGLE_ENGINE_VALUE) return;
      setPendingType("google");
      selectMutation.mutate({ type: "google", value: GOOGLE_ENGINE_VALUE });
      return;
    }
    const option = options.find((o) => o.value === value);
    if (!option || option.value === current) return;
    setPendingType(option.type);
    selectMutation.mutate({ type: option.type, value: option.value });
  };

  const busy = selectMutation.isPending || modelsQuery.isLoading || disabled;
  const selectError = selectMutation.isError
    ? String(selectMutation.error)
    : !selectMutation.isPending && selectMutation.data && !selectMutation.data.ok
      ? (selectMutation.data.error ?? "切换失败")
      : null;

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Label className="shrink-0 text-[11px] text-muted-foreground">
        {t("translate.model")}
      </Label>
      <Select value={current} onValueChange={handleChange} disabled={busy}>
        <SelectTrigger size="sm" className="h-8 w-52 max-w-64 text-xs">
          <SelectValue placeholder={t("chat.modelEmpty")} />
        </SelectTrigger>
        <SelectContent className="max-w-80">
          <SelectItem value={GOOGLE_ENGINE_VALUE}>
            <span className="truncate">{t("translate.engine.google")}</span>
            <span className="shrink-0 rounded-sm bg-emerald-500/15 px-1 text-[9px] leading-4 text-emerald-600">
              {t("translate.engine.free")}
            </span>
          </SelectItem>
          {options.filter((o) => o.type === "local").length > 0 && (
            <SelectGroup>
              <SelectLabel>{t("chat.modelLocal")}</SelectLabel>
              {options
                .filter((o) => o.type === "local")
                .map((o) => (
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
          {options.filter((o) => o.type === "api").length > 0 && (
            <SelectGroup>
              <SelectLabel>{t("chat.modelApi")}</SelectLabel>
              {options
                .filter((o) => o.type === "api")
                .map((o) => (
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
          {options.length === 0 && (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">
              {t("chat.modelEmpty")}
            </div>
          )}
        </SelectContent>
      </Select>
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
      {selectError && (
        <span className="flex min-w-0 items-center gap-1 text-[11px] text-destructive">
          <span className="truncate">{selectError}</span>
        </span>
      )}
      {selectMutation.isPending && (
        <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
          <Loader2Icon className="size-3 shrink-0 animate-spin" />
          <span className="truncate">
            {pendingType === "google"
              ? t("translate.engine.switching")
              : pendingType === "local"
                ? t("chat.modelRestarting")
                : t("chat.modelSwitching")}
          </span>
        </span>
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

export function TranslateScreen() {
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
    <div className="flex h-full min-h-0 flex-col">
      {/* 工具栏：标题 + 模型/引擎 + 语言对 */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2">
        <div className="flex items-center gap-1.5">
          <LanguagesIcon className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold">{t("translate.title")}</span>
        </div>
        <TranslationEnginePicker disabled={busy} />
        <div className="ml-auto flex items-center gap-1.5">
          <Select value={sourceLang} onValueChange={setSourceLang} disabled={busy}>
            <SelectTrigger className="h-8 w-40 text-xs">
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
          >
            <ArrowLeftRightIcon className="size-4" />
          </Button>
          <Select value={targetLang} onValueChange={setTargetLang} disabled={busy}>
            <SelectTrigger className="h-8 w-40 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>{langOptions(false)}</SelectContent>
          </Select>
        </div>
      </div>

      {error && (
        <div className="shrink-0 px-4 pt-3">
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-xs text-destructive">
            {error}
          </div>
        </div>
      )}

      {/* 双栏卡片：左原文右译文，撑满剩余高度 */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-4 md:grid-cols-2">
        <section className="flex min-h-64 flex-col overflow-hidden rounded-xl border bg-card shadow-sm md:min-h-0">
          <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b bg-muted/40 px-3">
            <span className="text-xs font-medium text-muted-foreground">
              {t("translate.sourceLabel")}
            </span>
            <span className="text-[10px] tabular-nums text-muted-foreground/70">
              {text.length} {t("translate.charCount")}
            </span>
          </header>
          <Textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (result || error) {
                setResult("");
                setError(undefined);
              }
              clearActive();
            }}
            placeholder={t("translate.placeholder")}
            className="min-h-0 flex-1 resize-none rounded-none border-0 p-4 font-normal text-sm leading-relaxed shadow-none focus-visible:ring-0"
            disabled={busy}
          />
        </section>

        <section className="flex min-h-64 flex-col overflow-hidden rounded-xl border bg-card shadow-sm md:min-h-0">
          <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b bg-muted/40 px-3">
            <span className="text-xs font-medium text-muted-foreground">
              {t("translate.targetLabel")}
            </span>
            <CopyTextButton text={result} />
          </header>
          <div className="relative min-h-0 flex-1">
            <Textarea
              readOnly
              value={result}
              placeholder={
                busy ? t("translate.translating") : t("translate.outputPlaceholder")
              }
              className="h-full min-h-0 w-full resize-none rounded-none border-0 p-4 font-normal text-sm leading-relaxed shadow-none focus-visible:ring-0"
            />
            {busy && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-background/60 text-xs text-muted-foreground backdrop-blur-[1px]">
                <Loader2Icon className="size-4 animate-spin text-primary" />
                {t("translate.translating")}
              </div>
            )}
          </div>
        </section>
      </div>

      {/* 底部操作栏 */}
      <div className="flex shrink-0 items-center gap-3 border-t px-4 py-3">
        <Button onClick={() => translate.mutate()} disabled={!canSend}>
          {busy ? (
            <Loader2Icon data-icon="inline-start" className="animate-spin" />
          ) : (
            <SendIcon data-icon="inline-start" />
          )}
          {busy ? t("translate.translating") : t("translate.send")}
        </Button>
        {!text.trim() && (
          <p className="text-xs text-muted-foreground">{t("translate.needText")}</p>
        )}
        {result && !busy && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <SparklesIcon className="size-3.5 text-primary" />
            {t("translate.doneHint")}
          </span>
        )}
        {(activeRecord !== null || text || result) && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={resetEditor}
            disabled={busy}
          >
            <FilePlusIcon data-icon="inline-start" />
            {t("translate.new")}
          </Button>
        )}
      </div>
    </div>
  );
}
