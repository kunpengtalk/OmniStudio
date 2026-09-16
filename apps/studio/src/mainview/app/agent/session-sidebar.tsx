import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CalendarClockIcon,
  ChevronDownIcon,
  FolderPlusIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SearchIcon,
  SidebarIcon,
  SquarePenIcon,
  Trash2Icon,
  WaypointsIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { reportClientError } from "@lib/app-log";
import { parseWorkspaceRecents, withRecentWorkspace, workspaceLabel } from "@lib/workspace";
import { isRemoteClient } from "@lib/remote";
import { useAgentStore, type AgentSubView } from "@stores/agent";
import { useChatStore } from "@stores/chat";
import { useT } from "@stores/ui-lang";
import { PiTip } from "./pi-tip";
import type { AgentSessionView } from "../../../bun/agent";

type TimeBucket = "today" | "yesterday" | "week" | "month" | "earlier";

const BUCKET_ORDER: TimeBucket[] = ["today", "yesterday", "week", "month", "earlier"];

/**
 * 时间分桶。分组内部按"什么时候动过"再分一层，比一条无尽的列表好找 ——
 * 用户回想的是"今天早上那个"，而不是第 37 行。
 */
function bucketOf(ts: number): TimeBucket {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86_400_000;
  if (ts >= startOfToday) return "today";
  if (ts >= startOfToday - day) return "yesterday";
  if (ts >= startOfToday - 7 * day) return "week";
  if (ts >= startOfToday - 30 * day) return "month";
  return "earlier";
}

/** 侧栏顶部动作区里的子视图入口：自动化 / 插件。 */
const SIDE_VIEW_ACTIONS: {
  view: Exclude<AgentSubView, "chat">;
  icon: React.ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
  labelKey: string;
}[] = [
  { view: "automations", icon: CalendarClockIcon, labelKey: "agent.nav.automations" },
  { view: "plugins", icon: WaypointsIcon, labelKey: "agent.nav.plugins" },
];

/** 快捷键提示里的修饰键：macOS 显示 ⌘，其它平台显示 Ctrl。 */
const MOD_KEY = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl+";

/**
 * 侧栏顶部动作区：新建任务 / 搜索 / 自动化 / 插件市场。
 *
 * 对齐参考实现：这四个是"接下来去哪"的入口，钉在会话列表上方，不落页脚。前两个
 * 带快捷键提示，实际按键在 AgentWindow 里统一监听（那里是所有子视图的共同祖先）。
 */
function SidebarActions({
  onNewTask,
  onOpenSearch,
}: {
  onNewTask: () => void;
  onOpenSearch: () => void;
}) {
  const t = useT();
  const subView = useAgentStore((s) => s.subView);
  const items: {
    key: string;
    icon: React.ReactNode;
    label: string;
    hint?: string;
    active?: boolean;
    onClick: () => void;
  }[] = [
    {
      key: "new",
      icon: <SquarePenIcon size={15} aria-hidden />,
      label: t("agent.session.new"),
      hint: `${MOD_KEY}N`,
      // 包一层：直接把函数交给 onClick，点击事件会被当成第一个参数传进去，
      // 而"新建任务"的第一个参数是工作区（侧栏的 onNewTask 支持指定文件夹）。
      onClick: () => onNewTask(),
    },
    {
      key: "search",
      icon: <SearchIcon size={15} aria-hidden />,
      label: t("agent.search.title"),
      hint: `${MOD_KEY}K`,
      onClick: onOpenSearch,
    },
    // 网页端只跑会话本身：自动化 / 插件在那边没有主区可切（也不该把宿主机的配置入口露出去）。
    ...(isRemoteClient() ? [] : SIDE_VIEW_ACTIONS).map((item) => {
      const Icon = item.icon;
      const active = subView === item.view;
      return {
        key: item.view,
        icon: <Icon size={15} aria-hidden />,
        label: t(item.labelKey),
        active,
        // 再点一次回到会话列表：这几个是"切主区"，不是开关面板。
        onClick: () => useAgentStore.getState().setSubView(active ? "chat" : item.view),
      };
    }),
  ];

  return (
    <div className="pi-side-actions">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className={`pi-side-action${item.active ? " active" : ""}`}
          aria-pressed={item.active}
          aria-label={item.label}
          onClick={item.onClick}
        >
          {item.icon}
          <span className="pi-side-action-label">{item.label}</span>
          {item.hint ? <span className="pi-kbd">{item.hint}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** 会话行。状态点占最左边 12px 车道，标题从 20px 起 —— 状态变化不会让文字左右跳。 */
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
  const progress = session.todo.total > 0 ? `${session.todo.completed}/${session.todo.total}` : null;

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        className={`pi-thread${active ? " active" : ""}${session.archived ? " archived" : ""}`}
        onClick={onSelect}
      >
        <span className="pi-thread-status" aria-hidden>
          {session.running ? (
            <span className="pi-thread-dot running" />
          ) : session.needsAttention ? (
            <span className="pi-thread-dot attention" />
          ) : unread ? (
            <span className="pi-thread-dot unread" />
          ) : active ? (
            <span className="pi-thread-ring" />
          ) : session.pinned ? (
            <PinIcon size={11} style={{ color: "var(--ds-accent)" }} />
          ) : null}
        </span>
        <span className="pi-thread-main">
          <span className="pi-thread-title">{session.title || t("agent.untitledTask")}</span>
          {progress ? <span className="pi-thread-progress">{progress}</span> : null}
        </span>
      </button>

      <button
        type="button"
        className="pi-thread-more"
        aria-expanded={menuOpen}
        aria-label={t("agent.session.menu")}
        style={{ position: "absolute", right: 4, top: 2 }}
        onClick={(event) => {
          event.stopPropagation();
          setMenuOpen((v) => !v);
        }}
      >
        <MoreHorizontalIcon size={14} aria-hidden />
      </button>

      {menuOpen ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
          <div
            className="pi-menu"
            style={{ right: 4, top: 30, width: "min(184px, calc(100vw - 16px))" }}
            role="menu"
          >
            <button
              type="button"
              className="pi-menu-item"
              onClick={() => {
                setMenuOpen(false);
                onPin(!session.pinned);
              }}
            >
              {session.pinned ? <PinOffIcon size={14} aria-hidden /> : <PinIcon size={14} aria-hidden />}
              {session.pinned ? t("agent.session.unpin") : t("agent.session.pin")}
            </button>
            <button
              type="button"
              className="pi-menu-item"
              onClick={() => {
                setMenuOpen(false);
                onRename();
              }}
            >
              <PencilIcon size={14} aria-hidden />
              {t("agent.session.rename")}
            </button>
            <button
              type="button"
              className="pi-menu-item"
              onClick={() => {
                setMenuOpen(false);
                onArchive();
              }}
            >
              {session.archived ? (
                <ArchiveRestoreIcon size={14} aria-hidden />
              ) : (
                <ArchiveIcon size={14} aria-hidden />
              )}
              {session.archived ? t("agent.session.unarchive") : t("agent.session.archive")}
            </button>
            <button
              type="button"
              className="pi-menu-item"
              style={{ color: "var(--ds-error)" }}
              onClick={() => {
                setMenuOpen(false);
                onDelete();
              }}
            >
              <Trash2Icon size={14} aria-hidden />
              {t("agent.session.remove")}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** 分组标题行：折叠箭头 + 标题 +（可选的）行尾动作。 */
function SectionHeader({
  label,
  count,
  icon,
  open,
  onToggle,
  onSelect,
  active,
  title,
  action,
}: {
  label: string;
  count?: number;
  icon?: React.ReactNode;
  open?: boolean;
  onToggle?: () => void;
  /**
   * 传入时标题本身变成"进入这一组"，箭头拆成独立按钮只管折叠。
   * 一个按钮不能既进组又折叠：项目段要的是"点文件夹就进去看它的会话"。
   */
  onSelect?: () => void;
  active?: boolean;
  /** 悬停提示。项目标题只显示路径最后一段，完整路径放这里。 */
  title?: string;
  action?: React.ReactNode;
}) {
  const t = useT();
  const caret = (
    <ChevronDownIcon size={12} className={`pi-caret${open ? "" : " collapsed"}`} aria-hidden />
  );
  const splitCaret = Boolean(onSelect && onToggle);

  const titleNode = onSelect ? (
    <button
      type="button"
      className={`pi-group-title${active ? " active" : ""}`}
      title={title}
      aria-current={active ? "true" : undefined}
      onClick={onSelect}
    >
      {splitCaret ? null : caret}
      {icon}
      <span>{label}</span>
      {count != null ? <span className="pi-group-count">{count}</span> : null}
    </button>
  ) : onToggle ? (
    <button type="button" className="pi-group-title" onClick={onToggle}>
      {caret}
      {icon}
      <span>{label}</span>
      {count != null ? <span className="pi-group-count">{count}</span> : null}
    </button>
  ) : (
    <span className="pi-group-title" style={{ cursor: "default" }}>
      {icon}
      <span>{label}</span>
      {count != null ? <span className="pi-group-count">{count}</span> : null}
    </span>
  );

  return (
    <div className="pi-group-header">
      {splitCaret ? (
        <button
          type="button"
          className="pi-caret-btn"
          aria-expanded={Boolean(open)}
          aria-label={t("agent.sidebar.toggleGroup")}
          onClick={onToggle}
        >
          {caret}
        </button>
      ) : null}
      {titleNode}
      {action}
    </div>
  );
}

/** 一组会话：内部再按时间分桶（今天 / 昨天 / 近 7 天…）。 */
function TimeBucketedSessions({
  sessions,
  renderRow,
}: {
  sessions: AgentSessionView[];
  renderRow: (session: AgentSessionView) => React.ReactNode;
}) {
  const t = useT();
  const buckets = useMemo(() => {
    const map = new Map<TimeBucket, AgentSessionView[]>();
    for (const session of sessions) {
      const key = bucketOf(session.updatedAt);
      map.set(key, [...(map.get(key) ?? []), session]);
    }
    return map;
  }, [sessions]);

  return (
    <>
      {BUCKET_ORDER.map((bucket) => {
        const items = buckets.get(bucket);
        if (!items || items.length === 0) return null;
        return (
          <div key={bucket}>
            <div className="pi-time-label">{t(`agent.sidebar.${bucket}`)}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>{items.map(renderRow)}</div>
          </div>
        );
      })}
    </>
  );
}

/** 一段列表默认最多露 5 条，多出来的收在「查看更多」后面。 */
const LIST_LIMIT = 5;

/**
 * 一段会话列表：默认只露前 5 条，点「查看更多」展开全部，再点收起。
 *
 * 列表是按最近更新排的（新的在最上面），所以收起的是最旧的那批 —— 不点开也
 * 不会漏掉"刚动过的那个"。置顶段（用户自己攒的短名单，要的就是一眼看到）与归档段
 * （本来就藏在"归档"折叠后面）不走这里。
 */
function SessionList({
  sessions,
  renderRow,
}: {
  sessions: AgentSessionView[];
  renderRow: (session: AgentSessionView) => React.ReactNode;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const hidden = sessions.length - LIST_LIMIT;
  const visible = expanded ? sessions : sessions.slice(0, LIST_LIMIT);

  return (
    <>
      <TimeBucketedSessions sessions={visible} renderRow={renderRow} />
      {hidden > 0 ? (
        <button
          type="button"
          className="pi-list-more"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <ChevronDownIcon size={12} className={`pi-caret${expanded ? "" : " collapsed"}`} aria-hidden />
          <span>
            {expanded ? t("agent.sidebar.showLess") : t("agent.sidebar.showMore", { count: String(hidden) })}
          </span>
        </button>
      ) : null}
    </>
  );
}

/**
 * Agent 会话侧栏。
 *
 * 结构对齐参考实现：顶栏是品牌与「收起侧栏」；主体最上方是动作区（新建任务 / 搜索 /
 * 自动化 / 插件市场），下面分「会话」与「项目」两段 —— 会话段放没挂项目的临时会话，
 * 项目段按工作区分组，每组内部再按时间分桶。页脚只留通知中心。
 *
 * 项目段是"文件夹即项目"的入口，三种操作各自独立：
 *   点文件夹   → 进这个项目（展开 + 切到里面最近动过的会话）；
 *   行尾的 ＋  → 在这个文件夹里开一个新会话；
 *   段标题的 📁+ → 打开一个还没进列表的文件夹（里面有会话就进去，没有就当场建一个）。
 * 只做分组不做这几件事的话，"选了文件夹"在界面上等于什么都没发生 —— 右侧还停在
 * 上一个项目的会话里。
 *
 * 动作区放在列表上方而不是页脚：这四个是"接下来去哪"的入口，跟会话内容不是一类；
 * 其中新建任务与搜索带 ⌘N / ⌘K 提示（按键在 AgentWindow 里监听）。
 *
 * 三段列表（置顶 / 会话 / 项目）一律**按最近更新倒序**，新的在最上面；每段默认只露
 * 前 5 条，剩下的收在行尾的「查看更多」里。
 */
export function AgentSessionSidebar({
  activeConversationId,
  onNewTask,
  onOpenSearch,
  onToggleSidebar,
  collapsed,
}: {
  activeConversationId: number | null;
  /** 新建任务；带工作区时直接建在那个文件夹里（项目段的 ＋ 与「打开工作区」用）。 */
  onNewTask: (workspace?: string) => void;
  onOpenSearch: () => void;
  onToggleSidebar: () => void;
  collapsed: boolean;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const unread = useAgentStore((s) => s.unread);
  const [showArchived, setShowArchived] = useState(false);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [openingWorkspace, setOpeningWorkspace] = useState(false);

  const sessionsQuery = useQuery({
    queryKey: ["agent-sessions", showArchived],
    queryFn: () => rpcClient.listAgentSessions({ includeArchived: showArchived }),
    // 运行中的会话状态（工具在跑 / 待办进度）变化快，轮询保持侧栏是最新的。
    refetchInterval: 4000,
  });
  const sessions = useMemo(() => sessionsQuery.data?.sessions ?? [], [sessionsQuery.data]);

  // 最近工作区设置：打开过的文件夹要与输入框上的工作区选择器共用同一份。
  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["agent-sessions"] });
    queryClient.invalidateQueries({ queryKey: ["conversations", "agent"] });
  };

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

  /**
   * 列表顺序在这里定：**最近更新的在最上面**（新的排最前）。
   *
   * 服务端本来就按这个顺序返回，这里再排一次是有意的：它是"默认只露 5 条"的前提
   * —— 顺序反了，收起来的就是最新的那批，而这种错在界面上看不出来。
   * 时间相同时排序是稳定的（V8 保证），沿用服务端给的先后，行不会自己来回跳。
   */
  const live = useMemo(
    () => sessions.filter((session) => !session.archived).sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions],
  );
  const archived = sessions.filter((session) => session.archived);

  /**
   * 置顶的单独成组摆在最上面：它要"无论挂没挂项目都一眼看得到"，所以不能留在
   * 各自的段里 —— 那会出现"钉过的会话跑到项目下面找不着"的情况。
   * 两个非置顶段互斥（按有没有指定工作区划分），任何一条会话只会出现在一处。
   */
  const pinned = live.filter((session) => session.pinned);
  const standalone = useMemo(
    () => live.filter((session) => !session.pinned && !session.sessionWorkspace),
    [live],
  );

  /**
   * 项目段：按工作区分组，**最近动过的排最前**。
   * 组的时间取"组内最新那条会话的 updatedAt"，所以在这个项目里新建会话 / 发消息，
   * 项目自己就会往前排；没人动过就保持原位置（稳定排序，时间相同沿用上面的先后）。
   */
  const projects = useMemo(() => {
    const map = new Map<string, AgentSessionView[]>();
    for (const session of live) {
      if (session.pinned) continue;
      if (!session.sessionWorkspace) continue;
      map.set(session.sessionWorkspace, [...(map.get(session.sessionWorkspace) ?? []), session]);
    }
    return [...map.entries()].sort((a, b) => {
      const aTime = Math.max(...a[1].map((s) => s.updatedAt));
      const bTime = Math.max(...b[1].map((s) => s.updatedAt));
      return bTime - aTime;
    });
  }, [live]);

  /**
   * 切到某个会话。会话行点击与"点项目文件夹"共用：两条路都只改这几样状态即可 ——
   * 消息、事件、工作区由 AgentConversation 挂载后自己取。
   */
  const selectSession = (session: AgentSessionView) => {
    useAgentStore.getState().setSubView("chat");
    if (session.id === activeConversationId) return;
    useAgentStore.getState().clearUnread(session.id);
    useChatStore.getState().setActiveConversation(session.id);
    useChatStore.getState().setActiveMessages([]);
    useChatStore.getState().setStreaming(false);
    useAgentStore.getState().clear();
  };

  /**
   * 进项目：展开分组，并切到里面最近动过的会话。
   * 已经在项目里的某个会话上就只展开 —— 否则点一下文件夹会把正在看的会话顶掉。
   */
  const enterProject = (workspace: string, items: AgentSessionView[]) => {
    setCollapsedGroups((prev) => ({ ...prev, [workspace]: false }));
    if (items.some((session) => session.id === activeConversationId)) return;
    const latest = [...items].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (latest) selectSession(latest);
  };

  /** 记住最近工作区：与输入框上的工作区选择器共用一份设置，那边也能直接选到。 */
  const rememberWorkspace = async (path: string): Promise<void> => {
    try {
      const recents = parseWorkspaceRecents(settingsData?.settings?.AGENT_WORKSPACES);
      await rpcClient.updateSettings({
        settings: { AGENT_WORKSPACES: JSON.stringify(withRecentWorkspace(recents, path)) },
      });
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    } catch {
      // 记不住"最近"不影响打开：选择器里少一条而已，不当错误报给用户。
    }
  };

  /**
   * 打开工作区：选一个文件夹，把它变成当前项目。
   * 里面已经有会话就进去（切到最近那个），没有就当场在里面建一个 ——
   * 「打开文件夹」的结果必须是"我现在就在这个文件夹里"，否则等于没打开。
   */
  const openWorkspace = async () => {
    setOpeningWorkspace(true);
    try {
      const { path } = await rpcClient.openDirectoryDialog(undefined);
      const target = path.trim();
      if (!target) return;
      void rememberWorkspace(target);
      const existing = sessions.filter(
        (session) => !session.archived && session.sessionWorkspace === target,
      );
      if (existing.length > 0) enterProject(target, existing);
      else onNewTask(target);
    } catch (error) {
      // 对话框本身失败（IPC / 权限）不该变成一个静默的未处理 rejection。
      reportClientError("agent.open_workspace_failed", error);
    } finally {
      setOpeningWorkspace(false);
    }
  };

  const renderRow = (session: AgentSessionView) => (
    <SessionRow
      key={session.id}
      session={session}
      active={session.id === activeConversationId}
      unread={unread.includes(session.id)}
      onSelect={() => selectSession(session)}
      onPin={(pinnedNext) => pinMutation.mutate({ id: session.id, pinned: pinnedNext })}
      onArchive={() => archiveMutation.mutate({ id: session.id, archived: !session.archived })}
      onRename={() => {
        setRenamingId(session.id);
        setRenameValue(session.title);
      }}
      onDelete={() => deleteMutation.mutate(session.id)}
    />
  );

  // 收起动画期间组件还在树上，但内容不该再参与交互。
  useEffect(() => {
    if (collapsed) setRenamingId(null);
  }, [collapsed]);

  if (collapsed) return null;

  const loading = sessionsQuery.isLoading && sessions.length === 0;

  return (
    <aside className="pi-sidebar" aria-label={t("agent.sessions")}>
      <div className="pi-sidebar-header">
        <span className="pi-brand" style={{ cursor: "default" }}>
          {t("apps.agent")}
        </span>
        <div className="pi-sidebar-header-actions">
          <PiTip label={t("agent.sidebar.collapse")}>
            <button
              type="button"
              className="pi-icon-btn"
              aria-label={t("agent.sidebar.collapse")}
              onClick={onToggleSidebar}
            >
              <SidebarIcon size={15} aria-hidden />
            </button>
          </PiTip>
        </div>
      </div>

      <div className="pi-sidebar-body">
        {renamingId != null ? (
          <div className="pi-rename-row">
            <input
              autoFocus
              value={renameValue}
              aria-label={t("agent.session.rename")}
              onChange={(event) => setRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") renameMutation.mutate({ id: renamingId, title: renameValue });
                else if (event.key === "Escape") setRenamingId(null);
              }}
              onBlur={() => setRenamingId(null)}
            />
          </div>
        ) : null}

        <SidebarActions onNewTask={onNewTask} onOpenSearch={onOpenSearch} />

        <div className="pi-scroll-group">
          {/* 会话段：没挂项目的会话，内部再按时间分桶。新建任务在顶部动作区。 */}
          <SectionHeader label={t("agent.sidebar.sessionsSection")} />

          {pinned.length > 0 ? (
            <>
              <div className="pi-time-label">{t("agent.session.pinned")}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>{pinned.map(renderRow)}</div>
            </>
          ) : null}

          <SessionList sessions={standalone} renderRow={renderRow} />
          {!loading && live.length === 0 ? <p className="pi-empty center">{t("agent.session.empty")}</p> : null}

          {loading ? (
            <div style={{ display: "grid", gap: 6, padding: "6px 8px" }}>
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  style={{
                    height: 14,
                    borderRadius: 4,
                    background: "var(--ds-tile)",
                    animation: "pi-skeleton 1.4s var(--e-std) infinite",
                    width: i % 2 === 0 ? "72%" : "52%",
                  }}
                />
              ))}
            </div>
          ) : null}

          {/* 项目段：按工作区分组，组内再按时间分桶。段落常驻 —— 「打开工作区」
              是还没有任何项目的用户唯一的入口，藏在空态后面就永远进不来。 */}
          <div className="pi-sidebar-sep" />
          <SectionHeader
            label={t("agent.sidebar.projectsSection")}
            action={
              // 「打开工作区」要开宿主机的目录选择框；网页端没有这条通道，
              // 工作区跟随会话本身的设置，入口先不显示。
              isRemoteClient() ? undefined : (
                <PiTip label={t("agent.sidebar.addProject")}>
                  <button
                    type="button"
                    className="pi-icon-btn"
                    aria-label={t("agent.sidebar.addProject")}
                    disabled={openingWorkspace}
                    onClick={() => void openWorkspace()}
                  >
                    {openingWorkspace ? (
                      <Loader2Icon size={13} className="animate-spin" aria-hidden />
                    ) : (
                      <FolderPlusIcon size={13} aria-hidden />
                    )}
                  </button>
                </PiTip>
              )
            }
          />
          {projects.map(([workspace, items]) => {
            const isOpen = !collapsedGroups[workspace];
            const activeProject = items.some((session) => session.id === activeConversationId);
            return (
              <div key={workspace}>
                <SectionHeader
                  label={workspaceLabel(workspace)}
                  title={workspace}
                  count={items.length}
                  open={isOpen}
                  active={activeProject}
                  onToggle={() =>
                    setCollapsedGroups((prev) => ({ ...prev, [workspace]: !prev[workspace] }))
                  }
                  onSelect={() => enterProject(workspace, items)}
                  action={
                    <PiTip label={t("agent.sidebar.newInProject")}>
                      <button
                        type="button"
                        className="pi-icon-btn pi-group-action"
                        aria-label={t("agent.sidebar.newInProject")}
                        onClick={() => onNewTask(workspace)}
                      >
                        <PlusIcon size={13} aria-hidden />
                      </button>
                    </PiTip>
                  }
                />
                <div
                  className="pi-group-body pi-project-body"
                  style={{ maxHeight: isOpen ? 2000 : 0 }}
                  aria-hidden={!isOpen}
                >
                  <SessionList sessions={items} renderRow={renderRow} />
                </div>
              </div>
            );
          })}
          {!loading && projects.length === 0 ? (
            <p className="pi-empty">{t("agent.sidebar.emptyProjects")}</p>
          ) : null}

          {archived.length > 0 || showArchived ? (
            <>
              <div className="pi-sidebar-sep" />
              <SectionHeader
                label={t("agent.session.archived")}
                count={archived.length}
                icon={<ArchiveIcon size={11} aria-hidden />}
                open={showArchived}
                onToggle={() => setShowArchived((v) => !v)}
              />
              {showArchived ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {archived.map(renderRow)}
                  {archived.length === 0 ? <p className="pi-empty">{t("agent.session.empty")}</p> : null}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
