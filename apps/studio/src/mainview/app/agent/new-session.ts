import type { QueryClient } from "@tanstack/react-query";

import { useAgentStore } from "@stores/agent";
import { useChatStore } from "@stores/chat";
import type { AgentSessionView } from "../../../bun/agent";

/**
 * 把一条刚建出来的会话接上：会话列表、当前会话、消息区、Agent 上下文，以及输入框上那个
 * 工作区的镜像一起切过去。
 *
 * 新会话有三条入口 —— 顶部「新任务」、侧栏项目行的 ＋、输入框换工作区（换目录 = 新会话）。
 * 三处必须做同一套收尾：少做一步的典型表现是"新会话开着，输入框上写的还是上一条的工作区"，
 * 而发消息时带的就是那个值（后端按 turn 参数优先取它），于是这一轮的命令与文件改动落在
 * 别人的目录里。工作区是 per-session 的，输入框那处只是它的镜像。
 */
export function activateNewSession(
  queryClient: QueryClient,
  session: AgentSessionView,
  defaultWorkspace: string,
): void {  queryClient.invalidateQueries({ queryKey: ["agent-sessions"] });
  queryClient.invalidateQueries({ queryKey: ["conversations"] });

  useChatStore.getState().upsertConversation({
    id: session.id,
    title: session.title,
    app: "agent",
    modelId: null,
    pinned: 0,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  });
  useChatStore.getState().setActiveConversation(session.id);
  useChatStore.getState().setActiveMessages([]);
  useChatStore.getState().setStreaming(false);

  useAgentStore.getState().clear();
  useAgentStore.getState().setSubView("chat");
  // 立刻把工作区切过去，不等 getConversation 回来（它回来之后会再校一次）。
  // 没指定工作区的会话跟随全局：拨回全局默认，不然会继承上一条会话的目录。
  useAgentStore.getState().setWorkspace(session.sessionWorkspace ?? defaultWorkspace);
  useAgentStore.getState().setWorkspaceIsDefault(!session.sessionWorkspace);
}

/**
 * 「新任务」（⌘N / 顶部按钮 / 侧栏动作区）建在哪个工作区。
 *
 * 当前会话挂在某个项目里 → 接着在那个文件夹里开：与会话列表"按工作区分组"是同一套语义，
 * 也免得用户在项目里按下新建，得到的却是一条跑到默认目录去的会话（还以为没生效）。
 * 跟随全局时返回 undefined（**不要**把全局默认路径写进新会话）：工作区写死之后，
 * 临时会话会被当成项目，从「会话」段跑到一个以默认目录命名的分组里去，而以后改全局默认
 * 它们也不会跟着走。
 */
export function newTaskWorkspace(workspace: string, workspaceIsDefault: boolean): string | undefined {
  if (workspaceIsDefault || !workspace) return undefined;
  return workspace;
}
