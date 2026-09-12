import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BellIcon,
  BellRingIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { useChatStore } from "@stores/chat";
import { useAppStore } from "@stores/app";
import { useRouter } from "@stores/router";
import { useAgentStore } from "@stores/agent";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import type { AppNotification } from "../../../bun/notifications";

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(ts).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function kindIcon(kind: AppNotification["kind"]) {
  switch (kind) {
    case "permission":
      return <ShieldCheckIcon className="size-3.5 text-amber-600" />;
    case "error":
      return <CircleAlertIcon className="size-3.5 text-destructive" />;
    case "automation":
      return <SparklesIcon className="size-3.5 text-primary" />;
    default:
      return <CircleCheckIcon className="size-3.5 text-emerald-600" />;
  }
}

/**
 * 通知中心（对齐 OpenWork 的 notification bell）：
 * 后台跑完的会话、需要授权、自动化结果都收在这里，点开跳回对应会话。
 */
export function NotificationBell() {
  const t = useT();
  const queryClient = useQueryClient();
  const notificationsQuery = useQuery({
    queryKey: ["notifications"],
    queryFn: () => rpcClient.listNotifications({ limit: 50 }),
    refetchInterval: 15_000,
  });
  const [open, setOpen] = useState(false);
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

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="icon-sm"
        className={cn("relative text-muted-foreground", unread > 0 && "text-foreground")}
        tooltip={t("notifications.title")}
        onClick={() => {
          const next = !open;
          setOpen(next);
          // 打开就全部标记为已读：铃铛的未读点是"有新东西"的提示，不是待办。
          if (next && unread > 0) markRead.mutate(undefined);
        }}
      >
        {unread > 0 ? <BellRingIcon className="size-4" /> : <BellIcon className="size-4" />}
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] leading-4 text-primary-foreground tabular-nums">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </Button>

      {open && <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />}

      {open && (
        <div className="absolute top-full right-0 z-50 mt-1 w-80 overflow-hidden rounded-xl border bg-popover shadow-lg">
          <div className="flex items-center gap-1.5 border-b px-3 py-2">
            <span className="text-xs font-medium">{t("notifications.title")}</span>
            {notifications.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-6 text-[11px]"
                onClick={() => clear.mutate()}
              >
                {t("notifications.clear")}
              </Button>
            )}
          </div>
          <div className="max-h-80 overflow-y-auto">
            {notifications.length === 0 ? (
              <p className="px-3 py-6 text-center text-[11px] text-muted-foreground">
                {t("notifications.empty")}
              </p>
            ) : (
              notifications.map((notification) => (
                <button
                  key={notification.id}
                  type="button"
                  onClick={() => {
                    markRead.mutate([notification.id]);
                    if (notification.conversationId != null) {
                      useAppStore.getState().setActiveApp("agent");
                      useRouter.getState().setRoute({ path: "index" });
                      useAgentStore.getState().clearUnread(notification.conversationId);
                      useChatStore.getState().setActiveConversation(notification.conversationId);
                      useAgentStore.getState().clear();
                    }
                  }}
                  className={cn(
                    "flex w-full items-start gap-2 border-b px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-muted/60",
                    notification.readAt == null && "bg-primary/5",
                  )}
                >
                  <span className="mt-0.5 shrink-0">{kindIcon(notification.kind)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] font-medium">{notification.title}</span>
                    {notification.body && (
                      <span className="mt-0.5 line-clamp-2 block text-[10px] text-muted-foreground">
                        {notification.body}
                      </span>
                    )}
                    <span className="mt-0.5 block text-[9px] text-muted-foreground/70">
                      {relativeTime(notification.createdAt)}
                    </span>
                  </span>
                  {notification.readAt == null && (
                    <span className="mt-1 size-1.5 shrink-0 rounded-full bg-primary" />
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
