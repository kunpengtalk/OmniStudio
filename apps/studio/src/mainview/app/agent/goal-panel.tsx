import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ChevronDownIcon, CrosshairIcon, PauseIcon, PlayIcon } from "lucide-react";

import { rpcClient } from "@/mainview/lib/rpc";
import { useAgentStore } from "@stores/agent";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";

/**
 * 目标面板（Goal 模式）。
 *
 * Goal 模式会**自己接着跑**，所以这个面板存在的意义不只是展示进度，更是给用户
 * 一个随时能按停的地方 —— 一个不需要用户发话就会继续行动的 Agent，
 * 必须让人一眼看到"它现在在为什么跑、跑了多久、还要跑几轮"。
 */
export function AgentGoalPanel({ conversationId }: { conversationId: number }) {
  const t = useT();
  const goal = useAgentStore((s) => s.goal);
  const [open, setOpen] = useState(true);

  const setStatus = useMutation({
    mutationFn: (status: "active" | "paused" | "dropped") =>
      rpcClient.setAgentGoalStatus({ conversationId, status }),
  });

  if (!goal) return null;
  const running = goal.status === "active";
  const finished = goal.status === "complete" || goal.status === "dropped";

  const statusLabel: Record<typeof goal.status, string> = {
    active: t("agent.goal.active"),
    paused: t("agent.goal.paused"),
    "budget-limited": t("agent.goal.limited"),
    complete: t("agent.goal.complete"),
    dropped: t("agent.goal.dropped"),
  };

  return (
    <div className="composer-panel collapsible">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="composer-panel-head"
      >
        <CrosshairIcon
          className="size-3.5 shrink-0"
          style={{ color: running ? "var(--ds-text-primary)" : undefined }}
          aria-hidden
        />
        <span className="font-medium">{t("agent.goal.title")}</span>
        <span
          className={cn(
            "composer-panel-pill",
            running && "accent",
            goal.status === "budget-limited" && "warn",
          )}
        >
          {statusLabel[goal.status]}
        </span>
        <span className="composer-panel-objective">{goal.objective}</span>
        <span className="shrink-0 tabular-nums">
          {goal.tokenBudget ? `${goal.tokensUsed}/${goal.tokenBudget}` : goal.tokensUsed} tok ·{" "}
          {goal.continuations}/{goal.maxContinuations}
        </span>
        <ChevronDownIcon className={cn("size-3 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="composer-panel-body space-y-1.5">
          {goal.acceptance ? (
            <div className="composer-panel-line">
              <span className="composer-panel-label">{t("agent.goal.acceptance")}</span>
              <span className="whitespace-pre-wrap">{goal.acceptance}</span>
            </div>
          ) : (
            <div className="composer-panel-line composer-panel-tone-warn">{t("agent.goal.noAcceptance")}</div>
          )}
          {goal.outcome && (
            <div className="composer-panel-line">
              <span className="composer-panel-label">{t("agent.goal.outcome")}</span>
              <span className="whitespace-pre-wrap">{goal.outcome}</span>
            </div>
          )}
          {goal.secondsUsed > 0 && (
            <div className="composer-panel-line composer-panel-label">
              {t("agent.goal.elapsed", { minutes: String(Math.round(goal.secondsUsed / 60)) })}
            </div>
          )}
          {/* 用户能按停，是"允许它自己跑"的前提。 */}
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {running ? (
              <button
                type="button"
                onClick={() => setStatus.mutate("paused")}
                className="composer-panel-btn"
              >
                <PauseIcon className="size-3" aria-hidden />
                {t("agent.goal.pause")}
              </button>
            ) : (
              !finished && (
                <button
                  type="button"
                  onClick={() => setStatus.mutate("active")}
                  className="composer-panel-btn"
                >
                  <PlayIcon className="size-3" aria-hidden />
                  {t("agent.goal.resume")}
                </button>
              )
            )}
            {!finished && (
              <button type="button" onClick={() => setStatus.mutate("dropped")} className="composer-panel-btn">
                {t("agent.goal.drop")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
