import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlarmClockIcon, CalendarClockIcon, ClockIcon, Loader2Icon, PauseIcon, PencilIcon, PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import type { AutomationItem } from "../../../bun/automations";
import { AutomationEditor } from "./editor";
import { RunHistory } from "./run-history";
import { WEEKDAYS, formatTime } from "./parts";

/**
 * 自动化页面（对齐 OpenWork 的 Automations）：
 * 一个任务 = 计划 + 一句指令 + 工作区；到点自动开一条会话跑，结果进运行记录。
 */
export function AutomationsScreen() {
  const t = useT();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<AutomationItem | null>(null);
  const [creating, setCreating] = useState(false);

  const automationsQuery = useQuery({
    queryKey: ["automations"],
    queryFn: () => rpcClient.listAutomations(),
    refetchInterval: 15_000,
  });
  const automations = useMemo(() => automationsQuery.data?.automations ?? [], [automationsQuery.data]);

  const workspaceQuery = useQuery({
    queryKey: ["agent-workspace"],
    queryFn: () => rpcClient.getAgentWorkspace(undefined),
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      rpcClient.updateAutomation({ id, patch: { enabled } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["automations"] }),
  });
  const remove = useMutation({
    mutationFn: (id: number) => rpcClient.deleteAutomation({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["automations"] }),
  });
  const runNow = useMutation({
    mutationFn: (id: number) => rpcClient.runAutomationNow({ id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["automations"] });
      queryClient.invalidateQueries({ queryKey: ["automation-runs"] });
      queryClient.invalidateQueries({ queryKey: ["agent-sessions"] });
    },
  });

  const defaultWorkspace = workspaceQuery.data?.workspace ?? "";
  const scheduled = useMemo(
    () => automations.filter((automation) => automation.enabled && automation.nextRunAt),
    [automations],
  );

  if (creating || editing) {
    return (
      <AutomationEditor
        automation={editing ?? undefined}
        defaultWorkspace={defaultWorkspace}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
        <div className="flex items-start gap-3">
          <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <CalendarClockIcon className="size-4.5" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-sm font-medium">{t("automations.title")}</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("automations.subtitle")}</p>
          </div>
          <Button size="sm" className="gap-1.5 text-xs" onClick={() => setCreating(true)}>
            <PlusIcon className="size-3.5" />
            {t("automations.new")}
          </Button>
        </div>

        {automations.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed py-12 text-center">
            <AlarmClockIcon className="size-6 text-muted-foreground/50" />
            <p className="text-xs font-medium">{t("automations.empty")}</p>
            <p className="max-w-sm text-[11px] text-muted-foreground">{t("automations.emptyHint")}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {automations.map((automation) => (
              <div key={automation.id} className="rounded-2xl border">
                <div className="flex items-start gap-2 p-3">
                  <div
                    className={cn(
                      "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg",
                      automation.enabled ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
                    )}
                  >
                    <ClockIcon className="size-3.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-xs font-medium">{automation.name}</span>
                      {!automation.enabled && (
                        <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
                          {t("automations.disabled")}
                        </span>
                      )}
                      {automation.lastStatus && (
                        <span
                          className={cn(
                            "rounded px-1 text-[10px]",
                            automation.lastStatus === "succeeded"
                              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                              : automation.lastStatus === "failed"
                                ? "bg-destructive/10 text-destructive"
                                : "bg-muted text-muted-foreground",
                          )}
                        >
                          {t(`automations.status.${automation.lastStatus}`)}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                      {automation.instructions}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground/80">
                      <span>
                        {automation.scheduleKind === "daily" &&
                          t("automations.everyDayAt", {
                            time: `${String((automation.schedule as { hour: number }).hour).padStart(2, "0")}:${String(
                              (automation.schedule as { minute: number }).minute,
                            ).padStart(2, "0")}`,
                          })}
                        {automation.scheduleKind === "weekly" &&
                          t("automations.everyWeekAt", {
                            days: ((automation.schedule as { daysOfWeek: number[] }).daysOfWeek ?? [])
                              .map((day) => WEEKDAYS.find((item) => item.value === day)?.zh ?? "")
                              .filter(Boolean)
                              .join("、"),
                            time: `${String((automation.schedule as { hour: number }).hour).padStart(2, "0")}:${String(
                              (automation.schedule as { minute: number }).minute,
                            ).padStart(2, "0")}`,
                          })}
                        {automation.scheduleKind === "once" &&
                          t("automations.onceAt", {
                            time: new Date(
                              Date.parse((automation.schedule as { at: string }).at),
                            ).toLocaleString("zh-CN"),
                          })}
                      </span>
                      <span className="flex items-center gap-1">
                        <CalendarClockIcon className="size-2.5" />
                        {t("automations.nextRun")}：{formatTime(automation.nextRunAt) || "—"}
                      </span>
                      <span>
                        {t("automations.lastRun")}：
                        {automation.lastRunAt ? formatTime(automation.lastRunAt) : t("automations.never")}
                      </span>
                      <span className="truncate" title={automation.workspace}>
                        {automation.workspace}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      tooltip={t("automations.runNow")}
                      disabled={runNow.isPending}
                      onClick={() => runNow.mutate(automation.id)}
                    >
                      {runNow.isPending && runNow.variables === automation.id ? (
                        <Loader2Icon className="size-3.5 animate-spin" />
                      ) : (
                        <PlayIcon className="size-3.5" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      tooltip={automation.enabled ? t("automations.disabled") : t("automations.enabled")}
                      onClick={() => toggle.mutate({ id: automation.id, enabled: !automation.enabled })}
                    >
                      {automation.enabled ? (
                        <PauseIcon className="size-3.5" />
                      ) : (
                        <PlayIcon className="size-3.5" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      tooltip={t("automations.edit")}
                      onClick={() => setEditing(automation)}
                    >
                      <PencilIcon className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-destructive"
                      tooltip={t("common.delete")}
                      onClick={() => {
                        if (confirm(t("automations.deleteConfirm"))) remove.mutate(automation.id);
                      }}
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </div>
                </div>
                <div className="border-t px-3 py-2">
                  <p className="mb-1 text-[10px] font-medium text-muted-foreground/70">
                    {t("automations.runs")}
                  </p>
                  <RunHistory automationId={automation.id} />
                </div>
              </div>
            ))}
          </div>
        )}

        {scheduled.length > 0 && (
          <p className="text-center text-[10px] text-muted-foreground/70">
            {t("automations.title")} · {scheduled.length} / {automations.length}
          </p>
        )}
      </div>
    </div>
  );
}
