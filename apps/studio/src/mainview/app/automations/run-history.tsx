import { useQuery } from "@tanstack/react-query";
import { CircleCheckIcon, CircleXIcon, Loader2Icon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { useChatStore } from "@stores/chat";
import { useRouter } from "@stores/router";
import { useAppStore } from "@stores/app";
import { useT } from "@stores/ui-lang";
import { formatTime } from "./parts";

/** 运行记录列表（点开跳到那次运行的会话）。 */
export function RunHistory({ automationId }: { automationId: number }) {
  const t = useT();
  const runsQuery = useQuery({
    queryKey: ["automation-runs", automationId],
    queryFn: () => rpcClient.listAutomationRuns({ automationId, limit: 20 }),
    refetchInterval: 5000,
  });
  const runs = runsQuery.data?.runs ?? [];

  if (runs.length === 0) {
    return <p className="px-1 py-2 text-[11px] text-muted-foreground">{t("automations.noRuns")}</p>;
  }

  return (
    <div className="flex flex-col gap-1">
      {runs.map((run) => (
        <div key={run.id} className="flex items-start gap-2 rounded-lg border px-2 py-1.5">
          {run.status === "running" ? (
            <Loader2Icon className="mt-0.5 size-3.5 shrink-0 animate-spin text-primary" />
          ) : run.status === "succeeded" ? (
            <CircleCheckIcon className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
          ) : (
            <CircleXIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-[11px]">
              {formatTime(run.startedAt)} · {t(`automations.status.${run.status}`)}
              {run.trigger === "manual" ? " · 手动" : ""}
            </p>
            {(run.summary || run.error) && (
              <p className="mt-0.5 line-clamp-2 text-[10px] text-muted-foreground">
                {run.error ?? run.summary}
              </p>
            )}
          </div>
          {run.conversationId != null && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 text-[10px]"
              onClick={() => {
                useAppStore.getState().setActiveApp("agent");
                useRouter.getState().setRoute({ path: "index" });
                useChatStore.getState().setActiveConversation(run.conversationId!);
              }}
            >
              {t("automations.openThread")}
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
