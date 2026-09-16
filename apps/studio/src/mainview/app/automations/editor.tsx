import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronLeftIcon, Loader2Icon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Textarea } from "@ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { useT, useUILang } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import type { AutomationItem } from "../../../bun/automations";
import { WEEKDAYS, defaultForm, type FormState } from "./parts";

/** 新建 / 编辑自动化任务的面板。 */
export function AutomationEditor({
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
