import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LanguagesIcon, ArrowLeftRightIcon, Loader2Icon, SendIcon, FilePlusIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Textarea } from "@ui/textarea";
import { Label } from "@ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { useT } from "@stores/ui-lang";
import { CopyButton } from "@components/copy-button";
import { ResultError } from "@components/media-result";
import { useTranslateStore } from "@stores/translate";
import { TRANSLATION_LANGUAGES, TRANSLATION_SOURCE_AUTO } from "../../../shared/translate";
import { TranslationEnginePicker, useTranslationEngine } from "./engine-picker";

export function TextTranslateTab() {
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
            <div className="w-full max-w-md">
              <ResultError error={error} />
            </div>
          ) : result ? (
            <div className="w-full max-w-2xl rounded-xl border bg-card p-4 shadow-sm">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("translate.targetLabel")}
                </span>
                <CopyButton
                  text={result}
                  label={t("translate.copy")}
                  copiedLabel={t("translate.copied")}
                />
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
