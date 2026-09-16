

export const WEEKDAYS = [
  { value: 1, zh: "周一", en: "Mon" },
  { value: 2, zh: "周二", en: "Tue" },
  { value: 3, zh: "周三", en: "Wed" },
  { value: 4, zh: "周四", en: "Thu" },
  { value: 5, zh: "周五", en: "Fri" },
  { value: 6, zh: "周六", en: "Sat" },
  { value: 0, zh: "周日", en: "Sun" },
];

export function formatTime(ts: number | null): string {
  if (!ts) return "";
  return new Date(ts).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export type FormState = {
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

export function defaultForm(workspace: string): FormState {
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
