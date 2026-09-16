import { useT } from "@stores/ui-lang";

/**
 * 相对时间（「刚刚 / 3 分钟前 / 2 小时前 / 08-14」）。
 *
 * 这段逻辑此前在 Agent 的地点被抄了三遍（会话搜索视图、通知中心，另有一处已随死代码删除），
 * 而且全都写死中文与 `zh-CN` 的日期格式 —— 英文界面下会夹着中文。收敛到一处之后，
 * 语言与格式只有一个来源。
 */
export function relativeTimeText(
  t: (key: string, params?: Record<string, string>) => string,
  ts: number,
  now: number = Date.now(),
): string {
  const diff = now - ts;
  if (diff < 60_000) return t("common.justNow");
  if (diff < 3_600_000) return t("common.minutesAgo", { n: String(Math.floor(diff / 60_000)) });
  if (diff < 86_400_000) return t("common.hoursAgo", { n: String(Math.floor(diff / 3_600_000)) });
  return new Date(ts).toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" });
}

/** 组件里用的版本：自带当前语言。 */
export function useRelativeTime(): (ts: number) => string {
  const t = useT();
  return (ts: number) => relativeTimeText(t, ts);
}
