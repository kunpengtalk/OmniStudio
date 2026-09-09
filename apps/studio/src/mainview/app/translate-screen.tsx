import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LanguagesIcon,
  ArrowLeftRightIcon,
  Loader2Icon,
  SendIcon,
  CopyIcon,
  CheckIcon,
  RefreshCwIcon,
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
import { cn } from "@/mainview/lib/utils";
import {
  TRANSLATION_LANGUAGES,
  TRANSLATION_SOURCE_AUTO,
} from "../../shared/translate";

/** 模型选择器：与对话页一致，本地已安装模型 + OpenAI 兼容 API 模型。 */
function TranslationModelPicker({
  disabled,
}: {
  disabled?: boolean;
}) {
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
  const mode = settings?.SERVER_MODE ?? "local";
  const chatModel = settings?.CHAT_MODEL ?? "";
  const apiModel = settings?.VLLM_MODEL_NAME ?? "";
  const activePath = settings?.LOCAL_MODEL_PATH ?? "";

  const options = modelsQuery.data?.models ?? [];
  const current = mode === "remote" ? apiModel || chatModel || "" : activePath || chatModel || "";

  const selectMutation = useMutation({
    mutationFn: (opt: { type: "local" | "api"; value: string }) =>
      rpcClient.selectChatModel(opt),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["installed-models"] });
      queryClient.invalidateQueries({ queryKey: ["chat-models"] });
      queryClient.invalidateQueries({ queryKey: ["server-status"] });
    },
    onSettled: () => setPendingType(null),
  });

  const handleChange = (value: string) => {
    const option = options.find((o) => o.value === value);
    if (!option || option.value === current) return;
    setPendingType(option.type);
    selectMutation.mutate(option);
  };

  const busy = selectMutation.isPending || modelsQuery.isLoading || disabled;
  const selectError = selectMutation.isError
    ? String(selectMutation.error)
    : !selectMutation.isPending && selectMutation.data && !selectMutation.data.ok
      ? (selectMutation.data.error ?? "切换失败")
      : null;

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label className="text-xs">{t("translate.model")}</Label>
      <div className="flex min-w-0 items-center gap-1.5">
        <Select value={current} onValueChange={handleChange} disabled={busy}>
          <SelectTrigger size="sm" className="h-7 max-w-72 text-xs">
            <SelectValue placeholder={t("chat.modelEmpty")} />
          </SelectTrigger>
          <SelectContent className="max-w-80">
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
              {pendingType === "local" ? t("chat.modelRestarting") : t("chat.modelSwitching")}
            </span>
          </span>
        )}
      </div>
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
  const [sourceLang, setSourceLang] = useState(TRANSLATION_SOURCE_AUTO);
  const [targetLang, setTargetLang] = useState("zh-CN");
  const [text, setText] = useState("");
  const [result, setResult] = useState("");
  const [error, setError] = useState<string>();

  const translate = useMutation({
    mutationFn: () =>
      rpcClient.runTranslation({
        text,
        sourceLang,
        targetLang,
      }),
    onSuccess: (r) => {
      if (r.error) {
        setError(r.error);
        setResult("");
        return;
      }
      setError(undefined);
      setResult(r.text ?? "");
    },
    onError: (e) => setError(String(e)),
  });

  const canSend = text.trim().length > 0 && !translate.isPending;

  const swap = () => {
    // 交换源/目标语言；目标语言不允许 auto。
    const nextSource = targetLang;
    const nextTarget = sourceLang === TRANSLATION_SOURCE_AUTO ? "en" : sourceLang;
    setSourceLang(nextSource);
    setTargetLang(nextTarget);
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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 px-6 pt-2 pb-3">
        <LanguagesIcon className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">{t("translate.title")}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-6 py-2 pb-12">
          <TranslationModelPicker disabled={translate.isPending} />

          {/* 语言选择：左源右目标 */}
          <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">{t("translate.source")}</Label>
              <Select
                value={sourceLang}
                onValueChange={setSourceLang}
                disabled={translate.isPending}
              >
                <SelectTrigger className="h-8 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>{langOptions(true)}</SelectContent>
              </Select>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              tooltip={t("translate.swap")}
              disabled={translate.isPending}
              onClick={swap}
              className="mb-0.5 shrink-0"
            >
              <ArrowLeftRightIcon className="size-4" />
            </Button>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">{t("translate.target")}</Label>
              <Select
                value={targetLang}
                onValueChange={setTargetLang}
                disabled={translate.isPending}
              >
                <SelectTrigger className="h-8 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>{langOptions(false)}</SelectContent>
              </Select>
            </div>
          </div>

          {/* 双栏：左边源语言原文，右边目标语言译文 */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs">{t("translate.sourceLabel")}</Label>
                <span className="text-[10px] text-muted-foreground/70 tabular-nums">
                  {text.length} {t("translate.charCount")}
                </span>
              </div>
              <Textarea
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  if (result || error) {
                    setResult("");
                    setError(undefined);
                  }
                }}
                placeholder={t("translate.placeholder")}
                className="min-h-72 resize-y font-mono text-xs"
                disabled={translate.isPending}
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-xs">{t("translate.targetLabel")}</Label>
                <CopyTextButton text={result} />
              </div>
              <div className="relative min-h-72 flex-1">
                <Textarea
                  readOnly
                  value={translate.isPending ? t("translate.translating") : result}
                  placeholder={t("translate.outputPlaceholder")}
                  className="min-h-72 resize-y font-mono text-xs"
                />
                {translate.isPending && (
                  <Loader2Icon className="absolute top-3 right-3 size-4 animate-spin text-primary" />
                )}
              </div>
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
              {error}
            </div>
          )}

          <div className="flex items-center gap-3">
            <Button onClick={() => translate.mutate()} disabled={!canSend}>
              {translate.isPending ? (
                <Loader2Icon data-icon="inline-start" className="animate-spin" />
              ) : (
                <SendIcon data-icon="inline-start" />
              )}
              {translate.isPending ? t("translate.translating") : t("translate.send")}
            </Button>
            {!text.trim() && (
              <p className="text-xs text-muted-foreground">{t("translate.needText")}</p>
            )}
          </div>

          {result && !translate.isPending && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <SparklesIcon className="size-3.5 text-primary" />
              {t("translate.doneHint")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
