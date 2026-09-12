import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlarmClockIcon,
  CalendarClockIcon,
  ChevronLeftIcon,
  CircleCheckIcon,
  CircleXIcon,
  ClockIcon,
  Loader2Icon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Textarea } from "@ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui/select";
import { useChatStore } from "@stores/chat";
import { useRouter } from "@stores/router";
import { useAppStore } from "@stores/app";
import { useT, useUILang } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import type { AutomationItem } from "../../bun/automations";

const WEEKDAYS = [
  { value: 1, zh: "周一", en: "Mon" },
  { value: 2, zh: "周二", en: "Tue" },
  { value: 3, zh: "周三", en: "Wed" },
  { value: 4, zh: "周四", en: "Thu" },
  { value: 5, zh: "周五", en: "Fri" },
  { value: 6, zh: "周六", en: "Sat" },
  { value: 0, zh: "周日", en: "Sun" },
];

function formatTime(ts: number | null): string {
  if (!ts) return "";
  return new Date(ts).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type FormState = {
  name: string;
  instructions: string;
  workspace: string;
  scheduleKind: "once" | "daily" | "weekly";
  hour: number;
  minute: number;
  daysOfWeek: number[];
  at: string;
  timezone: string;
  mode: string;
};

function defaultForm(workspace: string): FormState {
  const now = new Date();
  const inAnHour = new Date(now.getTime() + 3_600_000);
  return {
    name: "",
    instructions: "",
    workspace,
    scheduleKind: "daily",
    hour: 9,
    minute: 0,
    daysOfWeek: [1, 2, 3, 4, 5],
    at: `${inAnHour.getFullYear()}-${String(inAnHour.getMonth() + 1).padStart(2, "0")}-${String(
      inAnHour.getDate(),
    ).padStart(2, "0")}T${String(inAnHour.getHours()).padStart(2, "0")}:${String(
      inAnHour.getMinutes(),
    ).padStart(2, "0")}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    mode: "agent",
  };
}

/** 新建 / 编辑自动化任务的面板。 */
function AutomationEditor({
  automation,
  defaultWorkspace,
  onClose,
}: {
  automation?: AutomationItem;
  defaultWorkspace: string;
  onClose: () => void;
}) {
  const t = useT();
  const lang = useUILang((s) => s.lang);
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(() => {
    if (!automation) return defaultForm(defaultWorkspace);
    const schedule = automation.schedule as { at?: string; hour?: number; minute?: number; daysOfWeek?: number[] };
    return {
      name: automation.name,
      instructions: automation.instructions,
      workspace: automation.workspace,
      scheduleKind: automation.scheduleKind,
      hour: schedule.hour ?? 9,
      minute: schedule.minute ?? 0,
      daysOfWeek: schedule.daysOfWeek ?? [1, 2, 3, 4, 5],
      at: schedule.at
        ? new Date(Date.parse(schedule.at) - new Date().getTimezoneOffset() * 60_000)
            .toISOString()
            .slice(0, 16)
        : defaultForm(defaultWorkspace).at,
      timezone: automation.timezone,
      mode: automation.mode,
    };
  });

  const patch = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const save = useMutation({
    mutationFn: async () => {
      const schedule =
        form.scheduleKind === "once"
          ? { at: new Date(form.at).toISOString() }
          : form.scheduleKind === "daily"
            ? { hour: form.hour, minute: form.minute }
            : { hour: form.hour, minute: form.minute, daysOfWeek: form.daysOfWeek };
      if (automation) {
        return rpcClient.updateAutomation({
          id: automation.id,
          patch: {
            name: form.name,
            instructions: form.instructions,
            workspace: form.workspace,
            scheduleKind: form.scheduleKind,
            schedule,
            timezone: form.timezone,
            mode: form.mode,
          },
        });
      }
      return rpcClient.createAutomation({
        name: form.name,
        instructions: form.instructions,
        workspace: form.workspace,
        scheduleKind: form.scheduleKind,
        schedule,
        timezone: form.timezone,
        mode: form.mode,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["automations"] });
      onClose();
    },
  });

  const canSave = form.name.trim().length > 0 && form.instructions.trim().length > 0;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 p-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" onClick={onClose} tooltip={t("automations.back")}>
          <ChevronLeftIcon className="size-4" />
        </Button>
        <h2 className="text-sm font-medium">
          {automation ? t("automations.edit") : t("automations.new")}
        </h2>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">{t("automations.name")}</span>
        <Input
          value={form.name}
          onChange={(e) => patch("name", e.target.value)}
          placeholder={t("automations.name")}
          className="h-8 text-xs"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">{t("automations.instructions")}</span>
        <Textarea
          value={form.instructions}
          onChange={(e) => patch("instructions", e.target.value)}
          placeholder={t("automations.instructionsPlaceholder")}
          className="min-h-24 text-xs"
        />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">{t("automations.workspace")}</span>
          <div className="flex gap-1">
            <Input
              value={form.workspace}
              onChange={(e) => patch("workspace", e.target.value)}
              className="h-8 text-xs"
            />
            <Button
              variant="outline"
              size="sm"
              className="h-8 shrink-0 text-xs"
              onClick={async () => {
                const { path } = await rpcClient.openDirectoryDialog(undefined);
                if (path) patch("workspace", path);
              }}
            >
              …
            </Button>
          </div>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">{t("automations.timezone")}</span>
          <Input
            value={form.timezone}
            onChange={(e) => patch("timezone", e.target.value)}
            className="h-8 text-xs"
          />
        </label>
      </div>

      <div className="flex flex-col gap-2 rounded-xl border p-3">
        <span className="text-xs text-muted-foreground">{t("automations.schedule")}</span>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={form.scheduleKind}
            onValueChange={(value) => patch("scheduleKind", value as FormState["scheduleKind"])}
          >
            <SelectTrigger className="h-8 w-28 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="once">{t("automations.kind.once")}</SelectItem>
              <SelectItem value="daily">{t("automations.kind.daily")}</SelectItem>
              <SelectItem value="weekly">{t("automations.kind.weekly")}</SelectItem>
            </SelectContent>
          </Select>

          {form.scheduleKind === "once" ? (
            <Input
              type="datetime-local"
              value={form.at}
              onChange={(e) => patch("at", e.target.value)}
              className="h-8 w-52 text-xs"
            />
          ) : (
            <div className="flex items-center gap-1">
              <Input
                type="number"
                min={0}
                max={23}
                value={form.hour}
                onChange={(e) => patch("hour", Number(e.target.value) || 0)}
                className="h-8 w-16 text-xs"
              />
              <span className="text-xs text-muted-foreground">:</span>
              <Input
                type="number"
                min={0}
                max={59}
                value={form.minute}
                onChange={(e) => patch("minute", Number(e.target.value) || 0)}
                className="h-8 w-16 text-xs"
              />
            </div>
          )}
        </div>

        {form.scheduleKind === "weekly" && (
          <div className="flex flex-wrap gap-1">
            {WEEKDAYS.map((day) => {
              const active = form.daysOfWeek.includes(day.value);
              return (
                <button
                  key={day.value}
                  type="button"
                  onClick={() =>
                    patch(
                      "daysOfWeek",
                      active
                        ? form.daysOfWeek.filter((value) => value !== day.value)
                        : [...form.daysOfWeek, day.value],
                    )
                  }
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                    active ? "border-primary bg-primary/10 text-foreground" : "text-muted-foreground",
                  )}
                >
                  {lang === "en" ? day.en : day.zh}
                </button>
              );
            })}
          </div>
        )}

        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t("automations.mode")}</span>
          <Select value={form.mode} onValueChange={(value) => patch("mode", value)}>
            <SelectTrigger className="h-8 w-28 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="agent">Agent</SelectItem>
              <SelectItem value="plan">Plan</SelectItem>
              <SelectItem value="goal">Goal</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" className="text-xs" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          size="sm"
          className="text-xs"
          disabled={!canSave || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending && <Loader2Icon className="mr-1 size-3.5 animate-spin" />}
          {automation ? t("automations.save") : t("automations.create")}
        </Button>
      </div>
    </div>
  );
}

/** 运行记录列表（点开跳到那次运行的会话）。 */
function RunHistory({ automationId }: { automationId: number }) {
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
