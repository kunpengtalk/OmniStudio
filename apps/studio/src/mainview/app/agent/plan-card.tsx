import { useMutation } from "@tanstack/react-query";
import { CheckIcon, FileTextIcon } from "lucide-react";

import { rpcClient } from "@/mainview/lib/rpc";
import { useAgentStore } from "@stores/agent";
import { useT } from "@stores/ui-lang";

/**
 * 方案批准卡片（Plan 模式）。
 *
 * Plan 模式的产出是一份**方案**，而不是一串改动 —— 所以这条链路必须有个明确的
 * "同意 / 不同意"动作，否则"看了方案再决定"就落空了：用户只能自己再打一遍字说"照这个做"。
 * 卡片摆在输入框上方（和待办、目标同一区域），批准后会切到 Agent 模式并立刻开工。
 */
export function AgentPlanCard({ conversationId }: { conversationId: number }) {
  const t = useT();
  const plan = useAgentStore((s) => s.plan);
  const mode = useAgentStore((s) => s.mode);
  const running = useAgentStore((s) => s.running);

  const approve = useMutation({
    mutationFn: () => rpcClient.approveAgentPlan({ conversationId }),
  });
  const discard = useMutation({
    mutationFn: () => rpcClient.clearAgentPlan({ conversationId }),
  });

  // 只在 Plan 模式、有方案、且还没批准时出现 —— 批准之后它会变成执行轮的任务说明。
  if (!plan || plan.approvedAt || mode !== "plan") return null;

  return (
    <div className="composer-panel collapsible accent">
      <div className="composer-panel-head">
        <FileTextIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="font-medium">{t("agent.plan.ready")}</span>
        <span className="composer-panel-label">({plan.chars} 字)</span>
        <div className="ml-auto flex items-center gap-1.5">
          <button type="button" onClick={() => discard.mutate()} className="composer-panel-btn">
            {t("agent.plan.discard")}
          </button>
          <button
            type="button"
            disabled={approve.isPending || running}
            onClick={() => approve.mutate()}
            className="composer-panel-btn primary"
          >
            <CheckIcon className="size-3" aria-hidden />
            {approve.isPending ? t("agent.plan.approving") : t("agent.plan.approve")}
          </button>
        </div>
      </div>
      {approve.data && approve.data.ok === false && approve.data.error && (
        <div className="composer-panel-body composer-panel-line composer-panel-tone-error">{approve.data.error}</div>
      )}
    </div>
  );
}
