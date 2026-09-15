import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { GaugeIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { useChatStore } from "@stores/chat";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";

/**
 * 上下文占用条（对齐 Codex 的状态行 / `/status`）。
 *
 * 本地模型窗口小，用户需要知道"它还塞得下多少"：跑到 80% 以上就该收尾或开新会话，
 * 而不是等压缩把中间历史裁掉。数据来源优先用**上一轮的实测输入量**
 * （服务端返回的 usage.prompt_tokens），没有实测值时按消息估算 —— 估算用的就是
 * 触发压缩的那套 token 估算，所以两个数字不会互相打架。
 *
 * 打开会话时先按估算拉一次（RPC），回合结束后用推送来的实测值覆盖。
 */
export function AgentContextMeter({ conversationId }: { conversationId: number }) {
  const t = useT();
  const stats = useChatStore((s) => s.messageStats);
  const live = useChatStore((s) => s.contextUsage[conversationId]);

  const usageQuery = useQuery({
    queryKey: ["agent-context-usage", conversationId],
    queryFn: () => rpcClient.getAgentContextUsage({ conversationId }),
    // 打开会话时估一次即可；回合结束的实测值由 chatStats 推送进来。
    staleTime: 60_000,
  });

  // 推送来的实测值更新时优先，其次用估算的查询结果。
  const usage = useMemo(() => {
    const fromStats = Object.values(stats)
      .map((item) => item.context)
      .filter(Boolean)
      .pop();
    return live ?? fromStats ?? usageQuery.data ?? null;
  }, [live, stats, usageQuery.data]);

  if (!usage) return null;

  const tone =
    usage.percent >= 90
      ? "text-destructive"
      : usage.percent >= 70
        ? "text-amber-600 dark:text-amber-400"
        : "text-muted-foreground";
  const bar =
    usage.percent >= 90 ? "bg-destructive" : usage.percent >= 70 ? "bg-amber-500" : "bg-emerald-500";

  return (
    <div
      className="flex items-center gap-1.5"
      title={t("agent.context.tip", {
        window: String(usage.windowTokens),
        used: String(usage.usedTokens),
        source: t(
          usage.source === "usage" ? "agent.context.source.usage" : "agent.context.source.estimate",
        ),
      })}
    >
      <GaugeIcon className={cn("size-3.5", tone)} />
      <div className="h-1 w-16 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full transition-all", bar)} style={{ width: `${usage.percent}%` }} />
      </div>
      <span className={cn("text-[10px] tabular-nums", tone)}>
        {t("agent.context.label", { percent: String(usage.percent) })}
      </span>
    </div>
  );
}
