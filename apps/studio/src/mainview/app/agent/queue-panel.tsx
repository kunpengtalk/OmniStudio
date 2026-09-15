import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CornerUpRightIcon, Loader2Icon, SendIcon, XIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { useT } from "@stores/ui-lang";

/**
 * 排队消息面板（对齐 OpenWork 的 queued messages）：
 * 运行中继续输入的内容排在这里，本次运行结束后自动逐条执行；
 * 也可以点「立即插话」把它插进当前这一轮，或删掉不发。
 */
export function AgentQueuePanel({ conversationId }: { conversationId: number }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [steeringIndex, setSteeringIndex] = useState<number | null>(null);

  const queueQuery = useQuery({
    queryKey: ["agent-queue", conversationId],
    queryFn: () => rpcClient.listQueuedAgentMessages({ conversationId }),
    // 队列是内存态、随运行推进，2 秒拉一次比推送更省事（数量很少）。
    refetchInterval: 2000,
  });
  const messages = useMemo(() => queueQuery.data?.messages ?? [], [queueQuery.data]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["agent-queue", conversationId] });

  const steer = useMutation({
    mutationFn: (index: number) =>
      rpcClient
        .removeQueuedAgentMessage({ conversationId, index })
        .then(() => rpcClient.followUpAgentMessage({ conversationId, content: messages[index]!, mode: "steer" })),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (index: number) => rpcClient.removeQueuedAgentMessage({ conversationId, index }),
    onSuccess: invalidate,
  });

  if (messages.length === 0) return null;

  return (
    <div className="composer-panel collapsible">
      <div className="composer-panel-head">
        <SendIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="font-medium">{t("agent.queue.title")}</span>
        <span className="tabular-nums">{messages.length}</span>
        <span className="ml-auto composer-panel-label">{t("agent.queue.hint")}</span>
      </div>
      <div className="composer-panel-body composer-panel-scroll">
        <div className="composer-panel-divide">
          {messages.map((message, index) => (
            <div key={`${index}-${message.slice(0, 12)}`} className="flex items-start gap-1.5 py-1.5">
              <span className="composer-panel-label mt-0.5 shrink-0 tabular-nums">{index + 1}</span>
              <span className="composer-panel-text break-words">{message}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                tooltip={t("agent.queue.steer")}
                disabled={steer.isPending && steeringIndex === index}
                onClick={() => {
                  setSteeringIndex(index);
                  steer.mutate(index);
                }}
              >
                {steer.isPending && steeringIndex === index ? (
                  <Loader2Icon className="size-3 animate-spin" />
                ) : (
                  <CornerUpRightIcon className="size-3" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                tooltip={t("agent.queue.remove")}
                onClick={() => remove.mutate(index)}
              >
                <XIcon className="size-3" />
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
