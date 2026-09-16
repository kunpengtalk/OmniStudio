// Agent 工作台入口：侧栏 | 主区 | 右侧面板。
//
// 主区在「会话 / 子视图」之间切换（搜索、自动化、插件都在主区里打开，不弹新窗口）。
// 侧栏可收起 —— 收起后宽度归零并让主区的内容上限收紧，读长回答时能多出两百多像素。
import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { rpcClient } from "@lib/rpc";
import { isRemoteClient } from "@lib/remote";
import { useChatStore } from "@stores/chat";
import { useAgentStore } from "@stores/agent";
import { AgentSessionSidebar } from "./session-sidebar";
import { activateNewSession, newTaskWorkspace } from "./new-session";
import { AgentRightPanel } from "./right-panel";
import { AgentSearchDialog, AgentTopbar, WorkPanelToggle } from "./topbar";
import { AgentAutomationsView, AgentPluginsView } from "./agent-views";
import { AgentConversation, EmptyAgent } from "./conversation";
import type { AgentMode } from "../../../bun/agent";

const MODES: AgentMode[] = ["agent", "plan", "goal"];

/**
 * 网页端（/agent）：同一套界面，但右侧工作面板与"自动化 / 插件"子视图不渲染 ——
 * 那几个 Tab 是宿主机上的开发工具（终端、内置浏览器、评审），远程既用不上也不该开放。
 */
const remote = isRemoteClient();

export function AgentWindow() {
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const subView = useAgentStore((s) => s.subView);
  const panelOpen = useAgentStore((s) => s.panelOpen);
  const searchOpen = useAgentStore((s) => s.searchOpen);
  const queryClient = useQueryClient();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });

  // 未指定工作区时向后端要默认的（~/.omnistudio/workspace，不存在会自动创建）。
  const defaultWorkspaceQuery = useQuery({
    queryKey: ["agent-workspace"],
    queryFn: () => rpcClient.getAgentWorkspace(undefined),
  });

  // 模式 / 工作区持久化在设置里，首次进入时同步到 store。
  useEffect(() => {
    const settings = settingsData?.settings;
    if (!settings) return;
    const nextMode = settings.AGENT_MODE as AgentMode;
    if (MODES.includes(nextMode)) useAgentStore.getState().setMode(nextMode);
    const configured = (settings.AGENT_WORKSPACE ?? "").trim();
    useAgentStore
      .getState()
      .setWorkspace(configured || defaultWorkspaceQuery.data?.workspace || "");
    useAgentStore.getState().setWorkspaceIsDefault(!configured);
  }, [settingsData, defaultWorkspaceQuery.data]);

  const createMutation = useMutation({
    // 带工作区 = 在某个项目文件夹里开新会话（侧栏项目段的 ＋ / 打开工作区）。
    mutationFn: (workspace?: string) =>
      rpcClient.createAgentSession(workspace?.trim() ? { workspace } : {}),
    onSuccess: (data) => {
      activateNewSession(queryClient, data.session, defaultWorkspaceQuery.data?.workspace ?? "");
    },
  });

  /**
   * 「新任务」：当前会话挂在某个项目里就接着在那个文件夹里开，否则跟随全局默认。
   * 规则本身在 `newTaskWorkspace()` 里（可单测），这里只负责取当前状态。
   */
  const createNewTask = useCallback(() => {
    const { workspace, workspaceIsDefault } = useAgentStore.getState();
    createMutation.mutate(newTaskWorkspace(workspace, workspaceIsDefault));
  }, [createMutation]);

  // ⌘N 新建任务 / ⌘K 搜索会话。挂在 AgentWindow 而不是会话视图上：侧栏的动作区在
  // 空状态、自动化、插件这些子视图里同样可见，它对快捷键的提示（⌘N / ⌘K）在这里
  // 才全部成立。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        useAgentStore.getState().setSearchOpen(true);
      } else if (key === "n") {
        event.preventDefault();
        // 切回会话列表由 createMutation.onSuccess 负责，这里只发起。
        createNewTask();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [createNewTask]);

  // 与对话一致：优先复用一个空会话，避免反复进入累积空白 session。
  const conversationsQuery = useQuery({
    queryKey: ["conversations", "agent"],
    queryFn: () => rpcClient.listConversations({ app: "agent" }),
  });

  useEffect(() => {
    if (activeConversationId != null) return;
    if (conversationsQuery.isLoading && !conversationsQuery.data) return;
    const empty = conversationsQuery.data?.conversations?.find((c) => (c.messageCount ?? 0) === 0);
    if (empty) {
      useChatStore.getState().setActiveConversation(empty.id);
      useChatStore.getState().setActiveMessages([]);
      useChatStore.getState().setStreaming(false);
    } else if (!createMutation.isPending) {
      createNewTask();
    }
  }, [
    activeConversationId,
    conversationsQuery.data,
    conversationsQuery.isLoading,
    createMutation,
    createNewTask,
  ]);

  return (
    <div
      className={`pi-scope pi-agent${sidebarCollapsed ? " sidebar-collapsed" : ""}${
        panelOpen && activeConversationId != null ? " workpanel-open" : ""
      }`}
    >
      <AgentSessionSidebar
        activeConversationId={activeConversationId}
        collapsed={sidebarCollapsed}
        onNewTask={(workspace) => (workspace ? createMutation.mutate(workspace) : createNewTask())}
        onOpenSearch={() => useAgentStore.getState().setSearchOpen(true)}
        onToggleSidebar={() => setSidebarCollapsed(true)}
      />

      <section className="pi-main">
        <AgentTopbar
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
          onNewTask={createNewTask}
          onOpenSearch={() => useAgentStore.getState().setSearchOpen(true)}
        />
        {!remote && <WorkPanelToggle />}

        {!remote && subView === "automations" ? (
          <AgentAutomationsView />
        ) : !remote && subView === "plugins" ? (
          <AgentPluginsView />
        ) : activeConversationId != null ? (
          <AgentConversation
            key={activeConversationId}
            conversationId={activeConversationId}
            defaultWorkspace={defaultWorkspaceQuery.data?.workspace ?? ""}
          />
        ) : (
          <EmptyAgent onCreate={createNewTask} pending={createMutation.isPending} />
        )}
      </section>

      {!remote && activeConversationId != null ? (
        <AgentRightPanel conversationId={activeConversationId} />
      ) : null}

      <AgentSearchDialog
        open={searchOpen}
        onClose={() => useAgentStore.getState().setSearchOpen(false)}
      />
    </div>
  );
}
