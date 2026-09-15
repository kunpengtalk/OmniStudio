import { useQuery } from "@tanstack/react-query";

import { rpcClient } from "@lib/rpc";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";

/**
 * 会话配置速览（对齐 Codex 的 `/status`）：模型 / 窗口 / 压缩预算 / 审批与沙箱档位。
 *
 * 全部走 RPC 现取（`getAgentSessionStatus`），界面**不另存一份状态** ——
 * 显示的和真正生效的必须是同一个值，否则"设置里是 smart、跑起来按 manual"这类
 * 问题会很难查。数字口径与输入框上方的占用条一致（实测优先、否则估算）。
 */
export function SessionStatusPanel({ conversationId }: { conversationId: number }) {
  const t = useT();
  const statusQuery = useQuery({
    queryKey: ["agent-session-status", conversationId],
    queryFn: () => rpcClient.getAgentSessionStatus({ conversationId }),
  });
  const status = statusQuery.data;
  if (!status) {
    return (
      <div className="rounded-2xl border bg-muted/30 p-3 text-xs text-muted-foreground">
        {t("agent.status.loading")}
      </div>
    );
  }

  const tone =
    status.percent >= 90
      ? "text-destructive"
      : status.percent >= 70
        ? "text-amber-600 dark:text-amber-400"
        : "text-emerald-600 dark:text-emerald-400";

  const rows: { label: string; value: string; hint?: string; className?: string }[] = [
    {
      label: t("agent.status.model"),
      value: status.model,
      hint: status.serverMode === "local" ? t("agent.status.local") : t("agent.status.cloud"),
    },
    {
      label: t("agent.status.context"),
      value: `${status.percent}%`,
      hint: t("agent.status.contextHint", {
        used: String(status.usedTokens),
        budget: String(status.contextBudget),
        window: String(status.contextWindow),
        source: t(
          status.usageSource === "usage"
            ? "agent.context.source.usage"
            : "agent.context.source.estimate",
        ),
      }),
      className: tone,
    },
    {
      label: t("agent.status.remaining"),
      value: String(status.remainingTokens),
      hint: t("agent.status.remainingHint"),
    },
    {
      label: t("agent.status.approval"),
      value: t(`agent.approval.mode.${status.approvalMode}`),
    },
    {
      label: t("agent.status.sandbox"),
      value: t(`settings.agentCaps.sandbox.mode.${sandboxKey(status.sandboxMode)}`),
    },
    { label: t("agent.status.mode"), value: status.mode },
    { label: t("agent.status.workspace"), value: status.workspace || "—" },
    ...(status.droppedSoFar > 0
      ? [
          {
            label: t("agent.status.compacted"),
            value: String(status.droppedSoFar),
            hint: t("agent.status.compactedHint"),
          },
        ]
      : []),
  ];

  return (
    <div className="grid gap-1.5 rounded-2xl border bg-muted/30 p-2 md:grid-cols-2">
      {rows.map((row) => (
        <div key={row.label} className="min-w-0 rounded-lg border bg-background/60 px-2.5 py-1.5">
          <p className="text-[10px] text-muted-foreground">{row.label}</p>
          <p className={cn("truncate text-xs font-medium", row.className)} title={row.value}>
            {row.value}
          </p>
          {row.hint && (
            <p className="truncate text-[10px] leading-4 text-muted-foreground/80" title={row.hint}>
              {row.hint}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

/** i18n 里沙箱档位用的是 camelCase 的键名（off / workspaceWrite / readOnly）。 */
function sandboxKey(mode: string): string {
  if (mode === "workspace-write") return "workspaceWrite";
  if (mode === "read-only") return "readOnly";
  return "off";
}
