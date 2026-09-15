/**
 * 通知中心（对齐 OpenWork 的 notification center）：
 * 后台发生的事要有地方看到 —— 会话跑完、Agent 需要授权、自动化跑成功 / 失败。
 *
 * 只存内存（一次运行期间有效）：这些事件本身都落库（会话、运行记录、轨迹），
 * 通知只是"提醒你回来看一眼"，重启后没有保留价值。
 */
import { randomUUID } from "crypto";
import { logEvent } from "./app-log";
import { notifyExternal } from "./agent-notify";

export type NotificationKind = "run_finished" | "permission" | "automation" | "error" | "info";

export type AppNotification = {
  id: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  /** 点开通知要跳去的会话（有的话）。 */
  conversationId?: number | null;
  /** 未读数 = readAt 为空。 */
  readAt: number | null;
  createdAt: number;
};

const MAX_NOTIFICATIONS = 100;

const items: AppNotification[] = [];

type Listener = (payload: { notification: AppNotification }) => void;
const listeners = new Set<Listener>();

export function onNotification(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function notify(input: {
  kind: NotificationKind;
  title: string;
  body?: string;
  conversationId?: number | null;
}): AppNotification {
  const notification: AppNotification = {
    id: randomUUID(),
    kind: input.kind,
    title: input.title,
    body: input.body,
    conversationId: input.conversationId ?? null,
    readAt: null,
    createdAt: Date.now(),
  };
  items.unshift(notification);
  if (items.length > MAX_NOTIFICATIONS) items.length = MAX_NOTIFICATIONS;
  /**
   * 外部通知回调（对齐 Codex 的 notify）：配了 `AGENT_NOTIFY_COMMAND` 就把这件事
   * 作为 JSON 载荷交给用户自己的命令。这里是**唯一的触发点** ——
   * 每种事件各埋一次点迟早会漏掉一种。
   */
  notifyExternal(input);
  // 通知只活一次运行，但它记的是"后台出过事"—— 顺手进统一日志，
  // 事后排查时才能在 app.log 里看到自动化失败 / 权限请求这些线索。
  logEvent({
    level: input.kind === "error" ? "error" : input.kind === "permission" ? "warn" : "info",
    source: "notice",
    event: `notification.${input.kind}`,
    message: input.title,
    detail: { body: input.body, conversationId: notification.conversationId },
  });
  for (const cb of listeners) cb({ notification });
  return notification;
}

export function listNotifications(limit = 50): AppNotification[] {
  return items.slice(0, limit);
}

export function unreadNotificationCount(): number {
  return items.filter((item) => item.readAt == null).length;
}

export function markNotificationsRead(ids?: string[]): void {
  const now = Date.now();
  for (const item of items) {
    if (item.readAt != null) continue;
    if (ids && !ids.includes(item.id)) continue;
    item.readAt = now;
  }
}

export function clearNotifications(): void {
  items.length = 0;
}

/** 测试用：重置内存态。 */
export function resetNotifications(): void {
  items.length = 0;
}
