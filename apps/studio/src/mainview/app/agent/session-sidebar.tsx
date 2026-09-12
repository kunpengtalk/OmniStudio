import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CalendarClockIcon,
  CheckIcon,
  CircleAlertIcon,
  FolderIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SearchIcon,
  SparklesIcon,
  Trash2Icon,
  WaypointsIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { useAgentStore, type AgentSubView } from "@stores/agent";
import { useChatStore } from "@stores/chat";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import type { AgentSessionView } from "../../../bun/agent";

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期。 */
function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(ts).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

/** 工作区短名：路径最后一段。 */
function workspaceLabel(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function SessionRow({
  session,
  active,
  unread,
  onSelect,
  onPin,
  onArchive,
  onRename,
  onDelete,
}: {
  session: AgentSessionView;
  active: boolean;
  unread: boolean;
  onSelect: () => void;
  onPin: (pinned: boolean) => void;
  onArchive: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const progress =
    session.todo.total > 0 ? `${session.todo.completed}/${session.todo.total}` : null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "group flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left transition-colors",
          active ? "bg-muted" : "hover:bg-muted/60",
        )}
      >
        <div className="flex items-center gap-1.5">
          {session.running ? (
            <Loader2Icon className="size-3 shrink-0 animate-spin text-primary" />
          ) : session.needsAttention ? (
            <CircleAlertIcon className="size-3 shrink-0 text-amber-500" />
          ) : unread ? (
            <span className="size-1.5 shrink-0 rounded-full bg-primary" />
          ) : session.pinned ? (
            <PinIcon className="size-3 shrink-0 text-muted-foreground" />
          ) : null}
          <span className={cn("min-w-0 flex-1 truncate text-xs", active && "font-medium")}>
            {session.title}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground/70">
            {relativeTime(session.updatedAt)}
          </span>
        </div>
        <div className="flex items-center gap-1.5 pl-0.5">
          {session.preview && (
            <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground/70">
              {session.preview}
            </span>
          )}
          {progress && (
            <span className="shrink-0 rounded bg-muted px-1 text-[9px] text-muted-foreground">
              {progress}
            </span>
          )}
        </div>
        {session.sessionWorkspace && (
          <span className="flex items-center gap-1 pl-0.5 text-[10px] text-muted-foreground/60">
            <FolderIcon className="size-2.5" />
            {workspaceLabel(session.sessionWorkspace)}
          </span>
        )}
      </button>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen((v) => !v);
        }}
        className={cn(
          "absolute top-1 right-1 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-background group-hover:opacity-100",
          menuOpen && "opacity-100",
        )}
        title={t("agent.session.menu")}
      >
        <MoreHorizontalIcon className="size-3.5" />
      </button>

      {menuOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
          <div className="absolute right-1 top-6 z-50 w-40 overflow-hidden rounded-lg border bg-popover py-1 shadow-lg">
            <button
              type="button"
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-muted"
              onClick={() => {
                setMenuOpen(false);
                onPin(!session.pinned);
              }}
            >
              {session.pinned ? <PinOffIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}
              {session.pinned ? t("agent.session.unpin") : t("agent.session.pin")}
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-muted"
              onClick={() => {
                setMenuOpen(false);
                onRename();
              }}
            >
              <PencilIcon className="size-3.5" />
              {t("agent.session.rename")}
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-muted"
              onClick={() => {
                setMenuOpen(false);
                onArchive();
              }}
            >
              {session.archived ? (
                <ArchiveRestoreIcon className="size-3.5" />
              ) : (
                <ArchiveIcon className="size-3.5" />
              )}
              {session.archived ? t("agent.session.unarchive") : t("agent.session.archive")}
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-destructive hover:bg-destructive/10"
              onClick={() => {
                setMenuOpen(false);
                onDelete();
              }}
            >
              <Trash2Icon className="size-3.5" />
              {t("agent.session.remove")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Agent 会话侧栏（对齐 OpenWork 的会话列表）：
 * 新建任务 / 搜索 / 置顶分组 / 归档折叠 / 重命名 / 删除。
 */
/** 侧栏入口（对齐 OpenWork：新建任务下面是搜索 / 自动化 / 插件 / 技能）。 */
const NAV_ITEMS: {
  view: AgentSubView;
  icon: React.ComponentType<{ className?: string }>;
  labelKey: string;
}[] = [
  { view: "search", icon: SearchIcon, labelKey: "agent.nav.search" },
  { view: "automations", icon: CalendarClockIcon, labelKey: "agent.nav.automations" },
  { view: "plugins", icon: WaypointsIcon, labelKey: "agent.nav.plugins" },
  { view: "skills", icon: SparklesIcon, labelKey: "agent.nav.skills" },
];

export function AgentSessionSidebar({ activeConversationId }: { activeConversationId: number | null }) {
  const t = useT();
  const queryClient = useQueryClient();
  const subView = useAgentStore((s) => s.subView);
  const [showArchived, setShowArchived] = useState(false);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const sessionsQuery = useQuery({
    queryKey: ["agent-sessions", showArchived],
    queryFn: () => rpcClient.listAgentSessions({ includeArchived: showArchived }),
    // 运行中的会话状态（工具在跑 / 待办进度）变化快，轮询保持侧栏是最新的。
    refetchInterval: 4000,
  });
  const sessions = useMemo(() => sessionsQuery.data?.sessions ?? [], [sessionsQuery.data]);
  const unread = useAgentStore((s) => s.unread);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["agent-sessions"] });
    queryClient.invalidateQueries({ queryKey: ["conversations", "agent"] });
  };

  const createMutation = useMutation({
    mutationFn: () => rpcClient.createAgentSession({}),
    onSuccess: (data) => {
      invalidate();
      useAgentStore.getState().setSubView("chat");
      useChatStore.getState().upsertConversation({
        id: data.session.id,
        title: data.session.title,
        app: "agent",
        modelId: null,
        pinned: 0,
        createdAt: data.session.createdAt,
        updatedAt: data.session.updatedAt,
      });
      useChatStore.getState().setActiveConversation(data.session.id);
      useChatStore.getState().setActiveMessages([]);
      useChatStore.getState().setStreaming(false);
      useAgentStore.getState().clear();
    },
  });

  const pinMutation = useMutation({
    mutationFn: ({ id, pinned }: { id: number; pinned: boolean }) =>
      rpcClient.setAgentSessionPinned({ conversationId: id, pinned }),
    onSuccess: invalidate,
  });
  const archiveMutation = useMutation({
    mutationFn: ({ id, archived }: { id: number; archived: boolean }) =>
      rpcClient.setAgentSessionArchived({ conversationId: id, archived }),
    onSuccess: invalidate,
  });
  const renameMutation = useMutation({
    mutationFn: ({ id, title }: { id: number; title: string }) =>
      rpcClient.renameAgentSession({ conversationId: id, title }),
    onSuccess: () => {
      invalidate();
      setRenamingId(null);
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (id: number) => rpcClient.deleteConversation({ id }),
    onSuccess: (_data, id) => {
      invalidate();
      if (useChatStore.getState().activeConversationId === id) {
        useChatStore.getState().setActiveConversation(null);
        useAgentStore.getState().clear();
      }
    },
  });

  // 会话列表只做归档分组；按内容搜索走侧栏的「搜索」入口（能搜正文，不只是标题）。
  const pinned = sessions.filter((session) => session.pinned && !session.archived);
  const rest = sessions.filter((session) => !session.pinned && !session.archived);
  const archived = sessions.filter((session) => session.archived);

  // 按工作区分组：会话带自己的 workspace 时归到那个项目下面。
  const groups = useMemo(() => {
    const map = new Map<string, AgentSessionView[]>();
    for (const session of rest) {
      const key = session.sessionWorkspace ?? "";
      map.set(key, [...(map.get(key) ?? []), session]);
    }
    return [...map.entries()];
  }, [rest]);

  const renderRow = (session: AgentSessionView) => (
    <SessionRow
      key={session.id}
      session={session}
      active={session.id === activeConversationId}
      unread={unread.includes(session.id)}
      onSelect={() => {
        useAgentStore.getState().setSubView("chat");
        if (session.id === activeConversationId) return;
        useAgentStore.getState().clearUnread(session.id);
        useChatStore.getState().setActiveConversation(session.id);
        useChatStore.getState().setActiveMessages([]);
        useChatStore.getState().setStreaming(false);
        useAgentStore.getState().clear();
      }}
      onPin={(pinned) => pinMutation.mutate({ id: session.id, pinned })}
      onArchive={() => archiveMutation.mutate({ id: session.id, archived: !session.archived })}
      onRename={() => {
        setRenamingId(session.id);
        setRenameValue(session.title);
      }}
      onDelete={() => deleteMutation.mutate(session.id)}
    />
  );

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r bg-muted/20">
      <div className="flex items-center gap-1.5 border-b px-2 py-2">
        <Button
          variant="secondary"
          size="sm"
          className="h-7 flex-1 justify-start gap-1.5 text-xs"
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending}
        >
          {createMutation.isPending ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <PlusIcon className="size-3.5" />
          )}
          {t("agent.session.new")}
        </Button>
      </div>

      {/* 新建对话下面的一排入口：搜索 / 自动化 / 插件 / Skills —— 都在 Agent 主区域里打开 */}
      <nav className="flex flex-col gap-0.5 px-2 pt-1 pb-2">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = subView === item.view;
          return (
            <button
              key={item.view}
              type="button"
              onClick={() => useAgentStore.getState().setSubView(active ? "chat" : item.view)}
              className={cn(
                "flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors",
                active ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              <Icon className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{t(item.labelKey)}</span>
            </button>
          );
        })}
      </nav>
      <div className="mx-2 border-t" />

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {renamingId != null && (
          <div className="mb-1 flex items-center gap-1 rounded-lg border bg-background p-1">
            <Input
              value={renameValue}
              autoFocus
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  renameMutation.mutate({ id: renamingId, title: renameValue });
                } else if (e.key === "Escape") {
                  setRenamingId(null);
                }
              }}
              className="h-6 flex-1 text-xs"
            />
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => renameMutation.mutate({ id: renamingId, title: renameValue })}
              tooltip={t("common.save")}
            >
              <CheckIcon className="size-3.5" />
            </Button>
          </div>
        )}

        {pinned.length > 0 && (
          <div className="mb-2">
            <p className="px-1.5 py-1 text-[10px] font-medium text-muted-foreground/70">
              {t("agent.session.pinned")}
            </p>
            <div className="flex flex-col gap-0.5">{pinned.map(renderRow)}</div>
          </div>
        )}

        {groups.map(([workspace, items]) => (
          <div key={workspace || "__default"} className="mb-2">
            <p className="flex items-center gap-1 px-1.5 py-1 text-[10px] font-medium text-muted-foreground/70">
              <FolderIcon className="size-2.5" />
              {workspace ? workspaceLabel(workspace) : t("agent.session.defaultWorkspaceGroup")}
            </p>
            <div className="flex flex-col gap-0.5">{items.map(renderRow)}</div>
          </div>
        ))}

        {sessions.length === 0 && (
          <p className="px-2 py-4 text-center text-[11px] text-muted-foreground">
            {sessionsQuery.isLoading ? t("common.loading") : t("agent.session.empty")}
          </p>
        )}

        {(archived.length > 0 || showArchived) && (
          <div className="mt-2 border-t pt-2">
            <button
              type="button"
              onClick={() => setShowArchived((v) => !v)}
              className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-[10px] font-medium text-muted-foreground/70 hover:text-foreground"
            >
              <ArchiveIcon className="size-3" />
              {t("agent.session.archived")}
              <span className="tabular-nums">({archived.length})</span>
            </button>
            {showArchived && <div className="mt-0.5 flex flex-col gap-0.5">{archived.map(renderRow)}</div>}
          </div>
        )}
      </div>
    </aside>
  );
}
