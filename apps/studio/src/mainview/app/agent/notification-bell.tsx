import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BellIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  InfoIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { useChatStore } from "@stores/chat";
import { useAppStore } from "@stores/app";
import { useRouter } from "@stores/router";
import { useAgentStore } from "@stores/agent";
import { useT } from "@stores/ui-lang";
import { PiTip } from "./pi-tip";
import { useDismiss } from "./composer-controls";
import type { AppNotification } from "../../../bun/notifications";

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(ts).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

/** 每类通知一个图标与颜色：列表里一眼能分出"跑完了"和"要你授权"。 */
function kindIcon(kind: AppNotification["kind"]) {
  switch (kind) {
    case "permission":
      return <ShieldCheckIcon size={13} style={{ color: "var(--ds-warning)" }} />;
    case "error":
      return <CircleAlertIcon size={13} style={{ color: "var(--ds-error)" }} />;
    case "automation":
      return <SparklesIcon size={13} style={{ color: "var(--ds-purple)" }} />;
    case "info":
      return <InfoIcon size={13} style={{ color: "var(--ds-text-muted)" }} />;
    default:
      return <CircleCheckIcon size={13} style={{ color: "var(--ds-success)" }} />;
  }
}

type Filter = "all" | "unread";

/**
 * 通知中心（挂在外层顶栏右上角，与状态胶囊、下载按钮同排）。
 *
 * 后台跑完的会话、需要授权、自动化结果都收在这里，点一条跳回对应会话。
 * 打开即全部标记已读：铃铛上的数字是「有新东西」，不是一份待办清单 ——
 * 让用户为了清掉角标再点一次是多余的。
 *
 * 挂载点在 `.pi-agent` 之外（应用外壳的顶栏），而铃铛与角标用的是 `--ds-*` token，
 * 所以根节点自己补一层 `.pi-scope` —— 否则角标没有底色、hover 也没有反馈。
 */
export function NotificationBell() {
  const t = useT();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<{
    left: number;
    /** 触发器在上半屏时向下开（贴它的下沿），否则向上开（贴它的上沿）。 */
    top: number | null;
    bottom: number | null;
  } | null>(null);

  /**
   * 贴在铃铛旁边开，并且 portal 到 body —— 挂着它的容器可能是 `overflow: hidden`
   * （原侧栏页脚），留在里面会被裁成一条。
   *
   * 方向要按触发器位置定：铃铛现在在顶栏右上角，写死"向上开"会让面板整块跑到屏幕外
   * （面板高 108px、触发器 top 16px —— 顶边量出来是 -98px，用户只看到最上面一条）。
   */
  useEffect(() => {
    if (!open) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const openUp = rect.top > window.innerHeight / 2;
    setAnchor({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 368)),
      top: openUp ? null : rect.bottom + 6,
      bottom: openUp ? window.innerHeight - rect.top + 6 : null,
    });
  }, [open]);

  const notificationsQuery = useQuery({
    queryKey: ["notifications"],
    queryFn: () => rpcClient.listNotifications({ limit: 50 }),
    refetchInterval: 15_000,
  });
  const notifications = notificationsQuery.data?.notifications ?? [];
  const unread = notificationsQuery.data?.unread ?? 0;

  const markRead = useMutation({
    mutationFn: (ids?: string[]) => rpcClient.markNotificationsRead(ids ? { ids } : undefined),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const clear = useMutation({
    mutationFn: () => rpcClient.clearNotifications(undefined),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const visible = filter === "unread" ? notifications.filter((n) => n.readAt == null) : notifications;

  return (
    <div ref={ref} className="pi-scope pi-notif-wrap">
      <PiTip label={t("notifications.title")}>
        <button
          ref={triggerRef}
          type="button"
          className="pi-footer-action"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={t("notifications.title")}
          onClick={() => {
            const next = !open;
            setOpen(next);
            if (next && unread > 0) markRead.mutate(undefined);
          }}
        >
          <span style={{ position: "relative", display: "inline-flex" }}>
            <BellIcon size={15} aria-hidden />
            {unread > 0 ? (
              <span className="pi-notif-badge" style={{ position: "absolute", top: -7, right: -8 }}>
                {unread > 9 ? "9+" : unread}
              </span>
            ) : null}
          </span>
        </button>
      </PiTip>

      {open && anchor
        ? createPortal(
            <span className="pi-scope">
              <div
                className="pi-notif-pop"
                role="dialog"
                aria-label={t("notifications.title")}
                style={{
                  left: anchor.left,
                  top: anchor.top ?? "auto",
                  bottom: anchor.bottom ?? "auto",
                  right: "auto",
                }}
              >
                <div className="pi-notif-head">
                  <span className="pi-notif-title">{t("notifications.title")}</span>
                  <button
                    type="button"
                    className={`pi-notif-filter${filter === "all" ? " active" : ""}`}
                    onClick={() => setFilter("all")}
                  >
                    {t("notifications.filterAll")}
                  </button>
                  <button
                    type="button"
                    className={`pi-notif-filter${filter === "unread" ? " active" : ""}`}
                    onClick={() => setFilter("unread")}
                  >
                    {t("notifications.filterUnread")}
                  </button>
            {notifications.length > 0 ? (
              <button
                type="button"
                className="pi-notif-filter"
                onClick={() => clear.mutate()}
              >
                {t("notifications.clear")}
              </button>
            ) : null}
          </div>

          <div className="pi-notif-list">
            {visible.length === 0 ? (
              <p className="pi-menu-empty">{t("notifications.empty")}</p>
            ) : (
              visible.map((notification) => (
                <button
                  key={notification.id}
                  type="button"
                  className={`pi-notif-item${notification.readAt == null ? " unread" : ""}`}
                  onClick={() => {
                    markRead.mutate([notification.id]);
                    if (notification.conversationId != null) {
                      useAppStore.getState().setActiveApp("agent");
                      useRouter.getState().setRoute({ path: "index" });
                      useAgentStore.getState().clearUnread(notification.conversationId);
                      useChatStore.getState().setActiveConversation(notification.conversationId);
                      useAgentStore.getState().clear();
                    }
                    close();
                  }}
                >
                  <span className="pi-notif-icon">{kindIcon(notification.kind)}</span>
                  <span className="pi-notif-body">
                    <span className="pi-notif-name">{notification.title}</span>
                    {notification.body ? <span className="pi-notif-text">{notification.body}</span> : null}
                  </span>
                  <span className="pi-notif-time">{relativeTime(notification.createdAt)}</span>
                  {notification.readAt == null ? <span className="pi-notif-dot" aria-hidden /> : null}
                </button>
              ))
            )}
          </div>
              </div>
            </span>,
            document.body,
          )
        : null}
    </div>
  );
}
