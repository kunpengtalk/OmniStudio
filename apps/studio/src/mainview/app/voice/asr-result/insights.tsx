/**
 * 「智能整理」区：把当前转写稿交给对话模型做一次加工（摘要 / 待办 / 关键问题 / 校对 /
 * 翻译 / 标题 / 自定义提问），结果以 Markdown 卡片列在这里。
 *
 * 动作清单来自 `shared/asr-insights.ts`（与主进程发出去的指令是同一份），场景决定
 * 角色设定与推荐的几个动作 —— 所以这里只负责"点了哪个动作"和"结果怎么摆"。
 * 结果**不做流式**：这类加工一次十几秒内返回，一次性给结果就够了，界面上给的是
 * 运行中的状态与已用时（回看时卡片头部记着当时的模型、token 与耗时）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckIcon,
  CopyIcon,
  LanguagesIcon,
  ListChecksIcon,
  Loader2Icon,
  MessageCircleQuestionIcon,
  ScrollTextIcon,
  SparklesIcon,
  SpellCheckIcon,
  TypeIcon,
} from "lucide-react";

import type { AsrSegment } from "../../../../bun/asr";
import {
  ASR_INSIGHT_ACTIONS,
  asrInsightAction,
  asrScene,
  type AsrInsightActionId,
  type AsrSceneId,
} from "@/shared/asr-insights";
import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Markdown } from "@components/markdown";
import { ResultError } from "@components/media-result";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";

/** 一条整理结果（留在页面上，供回看与复制）。 */
export type InsightAnswer = {
  id: number;
  action: AsrInsightActionId;
  question?: string;
  text: string;
  model?: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
};

const ACTION_ICONS: Record<AsrInsightActionId, typeof SparklesIcon> = {
  summary: ScrollTextIcon,
  actions: ListChecksIcon,
  questions: MessageCircleQuestionIcon,
  proofread: SpellCheckIcon,
  translate: LanguagesIcon,
  title: TypeIcon,
  custom: SparklesIcon,
};

function fmtTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

/**
 * 运行中的已用时。单独一个组件是为了把它自己的每秒重渲染关在这一小块里 ——
 * 计时状态放在上面会让整列 Markdown 结果跟着每秒重算一遍。
 */
function ElapsedSeconds() {
  const [seconds, setSeconds] = useState(1);
  useEffect(() => {
    const iv = setInterval(() => setSeconds((v) => v + 1), 1000);
    return () => clearInterval(iv);
  }, []);
  return <span className="tabular-nums">{seconds}s</span>;
}

/** 动作条顺序：当前场景推荐的几个排前面，其余保持目录顺序。 */
function orderedActions(scene: AsrSceneId): (typeof ASR_INSIGHT_ACTIONS)[number][] {
  const preferred = asrScene(scene).followUps;
  const rank = (id: AsrInsightActionId) => {
    const i = preferred.indexOf(id);
    return i < 0 ? preferred.length : i;
  };
  return [...ASR_INSIGHT_ACTIONS].sort((a, b) => rank(a.id) - rank(b.id));
}

export function InsightsSection({
  segments,
  text,
  hasSpeakers,
  scene,
  /** 清空转写稿时加一：结果跟着一起清掉，免得留着上一份稿子的摘要。 */
  resetSignal,
}: {
  segments: AsrSegment[];
  text: string;
  hasSpeakers: boolean;
  scene: AsrSceneId;
  resetSignal: number;
}) {
  const t = useT();
  const [answers, setAnswers] = useState<InsightAnswer[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState<AsrInsightActionId | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [askText, setAskText] = useState("");
  const [copied, setCopied] = useState<number | null>(null);
  const copyTimer = useRef<number | null>(null);

  const transcriptReady = segments.length > 0 || text.trim().length > 0;
  const actions = useMemo(() => orderedActions(scene), [scene]);

  // 换稿子（清空 / 重新转写）时把结果清掉。
  useEffect(() => {
    setAnswers([]);
    setError(undefined);
    setShowAll(false);
  }, [resetSignal]);

  // 用 ref 而不是 `running` 状态做闸门：两次点击落在同一帧里时状态还没更新，
  // 只靠状态判断会同时发两次请求（白花钱，结果还会乱序落到列表里）。
  const runBusyRef = useRef(false);
  const run = async (action: AsrInsightActionId, question?: string) => {
    if (runBusyRef.current) return;
    runBusyRef.current = true;
    setError(undefined);
    setRunning(action);
    try {
      const result = await rpcClient.runAsrInsight({
        action,
        scene,
        question,
        segments,
        text,
        hasSpeakers,
      });
      if (!result.ok || !result.text) {
        setError(result.error ?? t("voice.asr.insightFailed"));
        return;
      }
      setAnswers((prev) => [
        {
          id: Date.now(),
          action,
          question: question?.trim() || undefined,
          text: result.text!,
          model: result.model,
          latencyMs: result.latencyMs,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        },
        ...prev,
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      runBusyRef.current = false;
      setRunning(null);
    }
  };

  const copyAnswer = (answer: InsightAnswer) => {
    void navigator.clipboard.writeText(answer.text).catch(() => {});
    setCopied(answer.id);
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(null), 1600) as unknown as number;
  };

  const submitAsk = () => {
    const q = askText.trim();
    if (!q || running) return;
    setAskText("");
    setAskOpen(false);
    void run("custom", q);
  };

  const shown = showAll ? answers : answers.slice(0, 1);

  return (
    <section className="rounded-xl border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <SparklesIcon className="size-4 shrink-0 text-primary" />
          <span className="text-xs font-medium">{t("voice.asr.insights")}</span>
          <span className="truncate text-[11px] text-muted-foreground">{t("voice.asr.insightsHint")}</span>
        </div>
        {answers.length > 1 && (
          <div className="flex items-center rounded-full bg-muted p-0.5">
            {(
              [
                { v: false, label: t("voice.asr.insightLatest") },
                { v: true, label: t("voice.asr.insightAll", { n: String(answers.length) }) },
              ] as const
            ).map((o) => (
              <button
                key={String(o.v)}
                type="button"
                onClick={() => setShowAll(o.v)}
                className={cn(
                  "rounded-full px-2.5 py-1 text-[11px] transition-colors",
                  showAll === o.v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3 p-4">
        {/* 动作条：点一下就按这份稿子跑一次 */}
        <div className="flex flex-wrap items-center gap-1.5">
          {actions.map((action) => {
            const Icon = ACTION_ICONS[action.id];
            const busy = running === action.id;
            const needsQuestion = !!action.needsQuestion;
            return (
              <button
                key={action.id}
                type="button"
                disabled={!transcriptReady || !!running}
                onClick={() => {
                  if (needsQuestion) {
                    setAskOpen((v) => !v);
                    return;
                  }
                  void run(action.id);
                }}
                className={cn(
                  "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
                  "disabled:cursor-not-allowed disabled:opacity-40",
                  needsQuestion && askOpen
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
                )}
                title={t(asrScene(scene).hintKey)}
              >
                {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <Icon className="size-3.5" />}
                {t(action.labelKey)}
              </button>
            );
          })}
        </div>

        {/* 自定义提问：就地展开一行输入，不弹对话框 */}
        {askOpen && (
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              value={askText}
              maxLength={500}
              placeholder={t("voice.asr.askPlaceholder")}
              onChange={(e) => setAskText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submitAsk();
                }
                if (e.key === "Escape") setAskOpen(false);
              }}
              className="h-8 text-xs"
            />
            <Button size="sm" disabled={!askText.trim() || !!running} onClick={submitAsk}>
              {t("voice.asr.askSubmit")}
            </Button>
          </div>
        )}

        {error && <ResultError error={error} />}

        {running && (
          <div className="flex items-center gap-2 rounded-lg border border-dashed px-4 py-3 text-xs text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin text-primary" />
            {t("voice.asr.insightRunning")} · {t(asrInsightAction(running).labelKey)} · <ElapsedSeconds />
          </div>
        )}

        {!transcriptReady && (
          <div className="flex items-center justify-center rounded-lg border border-dashed px-4 py-6 text-xs text-muted-foreground">
            {t("voice.asr.insightNeedTranscript")}
          </div>
        )}

        {transcriptReady && answers.length === 0 && !running && (
          <p className="text-[11px] leading-relaxed text-muted-foreground/80">{t("voice.asr.insightEmpty")}</p>
        )}

        {shown.map((answer) => {
          const action = asrInsightAction(answer.action);
          const Icon = ACTION_ICONS[answer.action];
          const tokens = (answer.inputTokens ?? 0) + (answer.outputTokens ?? 0);
          return (
            <article key={answer.id} className="rounded-lg border bg-background/60">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
                <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium">
                  <Icon className="size-3.5 shrink-0 text-primary" />
                  {t(action.labelKey)}
                  {answer.question && (
                    <span className="truncate font-normal text-muted-foreground">· {answer.question}</span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-2 text-[10px] text-muted-foreground">
                  {answer.model && (
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono break-all">{answer.model}</span>
                  )}
                  {tokens > 0 && <span className="tabular-nums">{fmtTokens(tokens)} tok</span>}
                  {!!answer.latencyMs && <span className="tabular-nums">{(answer.latencyMs / 1000).toFixed(1)}s</span>}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    tooltip={t("voice.asr.insightCopy")}
                    onClick={() => copyAnswer(answer)}
                  >
                    {copied === answer.id ? (
                      <CheckIcon className="size-3.5 text-primary" />
                    ) : (
                      <CopyIcon className="size-3.5" />
                    )}
                  </Button>
                </span>
              </div>
              <div className="px-4 py-3">
                <Markdown content={answer.text} mode="static" />
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
