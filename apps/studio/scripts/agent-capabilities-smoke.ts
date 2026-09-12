/**
 * Agent 能力面冒烟（对齐 OpenWork 的那批能力）：
 * 权限规则求值 → 授权往返（ask → 允许 / 会话总是 / 拒绝）→ 待办写入 → 产出物登记
 * → 工作区文件树 / 文件读取 → 自动化 CRUD 与调度巡检 → 会话管理（重命名 / 归档 / 工作区）。
 *
 * 全程不调用模型：自动化那步用「没有模型 → 记一条 failed 运行」的分支验证落库与续排。
 * 跑法：bun run scripts/agent-capabilities-smoke.ts
 */
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const providedDataDir = process.env.OMNI_DATA_DIR;
const dataDir = providedDataDir ?? mkdtempSync(path.join(tmpdir(), "omni-agent-smoke-"));
mkdirSync(dataDir, { recursive: true });
process.env.OMNI_DATA_DIR = dataDir;

const workspace = mkdtempSync(path.join(tmpdir(), "omni-agent-ws-"));
process.env.OMNI_AGENT_WORKSPACE = workspace;

const Chat = await import("../src/bun/chat");
const Agent = await import("../src/bun/agent");
const Permissions = await import("../src/bun/permissions");
const Interactions = await import("../src/bun/agent-interactions");
const Todos = await import("../src/bun/agent-todos");
const Artifacts = await import("../src/bun/agent-artifacts");
const Automations = await import("../src/bun/automations");
const { updateSettings } = await import("../src/bun/db/settings");

let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — ${detail ?? ""}`}`);
  if (!ok) failed++;
};

// ---------------------------------------------------------------------------
// 1. 权限：模式、规则求值、会话规则覆盖
// ---------------------------------------------------------------------------
check("默认审批模式是 smart", Permissions.approvalMode() === "smart");
check(
  "smart 模式放行普通命令、拦截危险命令",
  Permissions.evaluate({ permission: "bash", pattern: "npm test" }, Permissions.defaultRules("smart")).action === "allow" &&
    Permissions.evaluate({ permission: "bash", pattern: "rm -rf /" }, Permissions.defaultRules("smart")).action === "ask",
);
updateSettings({ AGENT_APPROVAL_MODE: "manual" });
check("切到 manual 后 bash 一律询问", Permissions.approvalMode() === "manual");
const rules = Permissions.effectiveRules(null, workspace);
check(
  "manual 下写工作区文件也要问",
  Permissions.evaluate({ permission: "edit", pattern: "a.ts" }, rules).action === "ask",
);
updateSettings({ AGENT_APPROVAL_MODE: "smart" });

updateSettings({
  AGENT_PERMISSION_RULES: JSON.stringify([{ permission: "bash", pattern: "npm *", action: "allow" }]),
});
check(
  "设置层规则生效",
  Permissions.evaluate({ permission: "bash", pattern: "npm run build" }, Permissions.effectiveRules(null, workspace))
    .action === "allow",
);
updateSettings({ AGENT_PERMISSION_RULES: "[]" });

// 用一个不存在的会话 id（避免和后面真实创建的会话撞号）
Permissions.grantPermission({
  scope: "session",
  scopeRef: "9999",
  permission: "bash",
  pattern: "rm -rf *",
  action: "allow",
});
check(
  "会话规则覆盖内置的「危险命令询问」",
  Permissions.evaluate({ permission: "bash", pattern: "rm -rf /tmp/x" }, Permissions.effectiveRules(9999, workspace))
    .action === "allow",
);
check(
  "换一个会话不继承（作用域隔离）",
  Permissions.evaluate({ permission: "bash", pattern: "rm -rf /tmp/x" }, Permissions.effectiveRules(8888, workspace))
    .action === "ask",
);

const summary = Permissions.summarizeEffectivePermissions(9999, workspace);
check("生效权限摘要含 6 个探针", summary.length === 6);
check(
  "摘要把窄规则计成「例外」",
  (summary.find((row) => row.permission === "bash")?.exceptions ?? 0) > 0,
  JSON.stringify(summary.map((r) => `${r.permission}:${r.action}:${r.source}:${r.exceptions}`)),
);
Permissions.clearPermissions("session", "9999");
check("清空会话授权后回到默认策略", Permissions.sessionRules(9999).length === 0);

// ---------------------------------------------------------------------------
// 2. 授权往返：挂起 → 应答 → 放行 / 拒绝
// ---------------------------------------------------------------------------
const conversation = Chat.createConversation("能力冒烟", "agent");
const conversationId = conversation.id;

const pendingSeen: string[] = [];
const offPermission = Interactions.onPermissionRequest((request) => pendingSeen.push(request.id));

const allowPromise = Interactions.authorizeToolCall({
  conversationId,
  messageId: null,
  toolName: "bash",
  args: { command: "rm -rf /tmp/whatever" },
  workspace,
  argsPreview: "rm -rf /tmp/whatever",
});
await new Promise((resolve) => setTimeout(resolve, 20));
check("危险命令挂起并推给 UI", pendingSeen.length === 1);
const pendingId = pendingSeen[0]!;
check("挂起请求带权限名与模式", Interactions.listPendingPermissions(conversationId)[0]?.permission === "bash");
Interactions.respondPermission(pendingId, "session");
const allowed = await allowPromise;
check("「本会话总是」后放行", allowed === null);
check(
  "放行规则已落库",
  Permissions.sessionRules(conversationId).some((rule) => rule.permission === "bash"),
);

const denyPromise = Interactions.authorizeToolCall({
  conversationId,
  messageId: null,
  toolName: "write_file",
  args: { path: "/etc/omni-smoke.txt" },
  workspace,
  argsPreview: "/etc/omni-smoke.txt",
});
await new Promise((resolve) => setTimeout(resolve, 20));
const external = Interactions.listPendingPermissions(conversationId)[0];
check("工作区外写入触发 external_directory", external?.permission === "external_directory");
Interactions.respondPermission(external!.id, "deny");
const denied = await denyPromise;
check("拒绝时返回明确原因（工具会被拦住）", typeof denied === "string" && denied.includes("拒绝"));

// 中断清理：挂起的请求在 stop 时全部收尾，不留悬挂的 await。
const hung = Interactions.authorizeToolCall({
  conversationId,
  messageId: null,
  toolName: "bash",
  args: { command: "git push origin main" },
  workspace,
  argsPreview: "git push origin main",
});
await new Promise((resolve) => setTimeout(resolve, 20));
Interactions.cancelPendingForConversation(conversationId);
check("中断会话会收尾挂起的授权", (await hung) !== null && Interactions.listPendingPermissions(conversationId).length === 0);
offPermission();

// ---------------------------------------------------------------------------
// 3. ask_user 提问往返
// ---------------------------------------------------------------------------
const questionSeen: string[] = [];
const offQuestion = Interactions.onQuestionAsked((q) => questionSeen.push(q.id));
const answerPromise = Interactions.askQuestions({
  conversationId,
  messageId: null,
  questions: [{ question: "用哪个方案？", header: "方案", options: [{ label: "A" }, { label: "B" }] }],
});
await new Promise((resolve) => setTimeout(resolve, 20));
check("提问推给 UI", questionSeen.length === 1);
Interactions.respondQuestion(questionSeen[0]!, [["A"]]);
const answers = await answerPromise;
check("答案回传（一问一答）", answers[0]?.[0] === "A");
offQuestion();

// ---------------------------------------------------------------------------
// 4. 待办清单
// ---------------------------------------------------------------------------
// 无人值守：ask_user 不应该挂起（自动化跑到需要澄清时不能让任务卡 10 分钟）。
const headlessConversation = Chat.createConversation("无人值守冒烟", "agent");
const toolset = await (
  await import("../src/bun/agent-tools")
).buildReadOnlyTools({
  workspace,
  allowShell: false,
  conversationId: headlessConversation.id,
  messageId: null,
  // 没有注入 askUser（等价于 headless）：工具必须给出明确的"不可用"而不是挂起。
});
const askTool = toolset.find((tool) => tool.name === "ask_user");
const askResult = askTool
  ? await askTool.execute("call", { questions: [{ question: "选哪个？" }] } as never)
  : null;
const askText = askResult ? JSON.stringify(askResult) : "";
check("无人值守时 ask_user 不挂起（返回明确错误）", askText.includes("not available"), askText.slice(0, 120));

const todoEvents: number[] = [];
const offTodos = Todos.onTodosChanged((payload) => todoEvents.push(payload.todos.length));
Todos.writeTodos(conversationId, [
  { content: "读代码", status: "completed", priority: "high" },
  { content: "改代码", status: "in_progress" },
  { content: "跑测试", status: "pending", priority: "low" },
  { content: "   " }, // 空白条目会被丢掉
]);
check("待办写入并过滤空白", Todos.listTodos(conversationId).length === 3);
check("全量覆盖：再写一次只剩 1 条", Todos.writeTodos(conversationId, [{ content: "只做这个" }]).length === 1);
Todos.writeTodos(conversationId, [
  { content: "a", status: "completed" },
  { content: "b", status: "in_progress" },
  { content: "c", status: "cancelled" },
]);
const progress = Todos.todoProgress(conversationId);
check("进度忽略 cancelled", progress.completed === 1 && progress.total === 2);
check("待办变化有推送", todoEvents.length >= 3);
offTodos();

// ---------------------------------------------------------------------------
// 5. 产出物 + 工作区文件树
// ---------------------------------------------------------------------------
const fs = await import("fs");
fs.mkdirSync(path.join(workspace, "notes"), { recursive: true });
fs.writeFileSync(path.join(workspace, "notes", "report.md"), "# 报告\n\n这是 agent 的产出。\n");
fs.writeFileSync(path.join(workspace, "data.json"), '{"ok":true}');

const artifact = Artifacts.recordArtifact({
  conversationId,
  messageId: null,
  filePath: "notes/report.md",
  workspace,
  tool: "write_file",
});
check("产出物登记成功", artifact?.title === "report.md" && artifact?.kind === "markdown");
check("产出物列表可查", Artifacts.listArtifacts(conversationId).length === 1);
const content = Artifacts.readArtifact(path.join(workspace, "notes", "report.md"));
check("文本产出物能读出内容", content.text?.includes("报告") === true && content.kind === "markdown");
check("扩展名映射到展示类型", Artifacts.artifactKindFor("a.png") === "image" && Artifacts.artifactKindFor("a.ts") === "code");

const tree = Artifacts.workspaceTree(workspace);
check("文件树包含目录与文件", tree.some((node) => node.name === "notes" && node.type === "dir"));
check(
  "文件树能下钻到子文件",
  tree.find((node) => node.name === "notes")?.children?.some((child) => child.name === "report.md") === true,
);
check(
  "工作区内文件可读取",
  Artifacts.readWorkspaceFile(workspace, "data.json").text?.includes("ok") === true,
);
let blockedOutside = false;
try {
  Artifacts.readWorkspaceFile(workspace, "../outside.txt");
} catch {
  blockedOutside = true;
}
check("工作区外文件读取被拒绝", blockedOutside);

// ---------------------------------------------------------------------------
// 6. 会话管理：列表 / 重命名 / 归档 / 工作区
// ---------------------------------------------------------------------------
const sessions = Agent.listAgentSessions();
check("会话列表包含刚建的会话", sessions.some((session) => session.id === conversationId));
check("会话带着待办进度", sessions.find((session) => session.id === conversationId)?.todo.total === 2);

Chat.renameConversation(conversationId, "改名后的任务");
check("重命名生效", Agent.listAgentSessions().find((s) => s.id === conversationId)?.title === "改名后的任务");

Agent.setConversationWorkspace(conversationId, workspace);
check(
  "会话级工作区生效",
  Agent.workspaceForConversation(conversationId) === path.resolve(workspace) &&
    Agent.listAgentSessions().find((s) => s.id === conversationId)?.sessionWorkspace === path.resolve(workspace),
);

Chat.setConversationArchived(conversationId, true);
check(
  "归档后默认列表不再出现，带 includeArchived 能看到",
  Agent.listAgentSessions().every((s) => s.id !== conversationId) &&
    Agent.listAgentSessions({ includeArchived: true }).some((s) => s.id === conversationId),
);
Chat.setConversationArchived(conversationId, false);
check("恢复归档", Agent.listAgentSessions().some((s) => s.id === conversationId));

// ---------------------------------------------------------------------------
// 6.5 会话分叉 + 通知中心
// ---------------------------------------------------------------------------
Chat.setConversationArchived(conversationId, false);
// 造两条消息用于分叉
const { db: dbc } = await import("../src/bun/db");
const { messages: messageTable } = await import("../src/bun/db/schema");
dbc.insert(messageTable).values({ conversationId, role: "user", content: "第一步" }).run();
const secondMessage = dbc
  .insert(messageTable)
  .values({ conversationId, role: "assistant", content: "已经做完第一步" })
  .returning({ id: messageTable.id })
  .get();
dbc.insert(messageTable).values({ conversationId, role: "user", content: "第二步" }).run();

const forked = Chat.forkConversation(conversationId, secondMessage.id);
check("从某条消息分叉出新会话", forked.ok && forked.conversationId != null, JSON.stringify(forked));
const forkedHistory = forked.conversationId ? Chat.getHistory(forked.conversationId) : [];
check(
  "分叉只复制到该消息为止（2 条），原会话不动",
  forkedHistory.length === 2 && Chat.getHistory(conversationId).length >= 3,
  `${forkedHistory.length} vs ${Chat.getHistory(conversationId).length}`,
);
check(
  "分叉会带上「分支」标记与工作区",
  (Agent.listAgentSessions().find((session) => session.id === forked.conversationId)?.title ?? "").includes("分支"),
);

const Notifications = await import("../src/bun/notifications");
Notifications.resetNotifications();
check("初始没有未读通知", Notifications.unreadNotificationCount() === 0);
const seen: string[] = [];
const offNotify = Notifications.onNotification(({ notification }) => seen.push(notification.kind));
Notifications.notify({ kind: "permission", title: "需要授权", body: "bash", conversationId });
check("通知写入并推送", seen.length === 1 && Notifications.unreadNotificationCount() === 1);
check("列表能查到通知内容", Notifications.listNotifications()[0]?.title === "需要授权");
Notifications.markNotificationsRead();
check("标记已读后未读归零", Notifications.unreadNotificationCount() === 0);
Notifications.notify({ kind: "automation", title: "自动化完成" });
check("新通知重新累计未读", Notifications.unreadNotificationCount() === 1);
Notifications.clearNotifications();
check("清空通知", Notifications.listNotifications().length === 0);
offNotify();

// ---------------------------------------------------------------------------
// 6.6 会话搜索（标题 + 正文，结果带片段）
// ---------------------------------------------------------------------------
const searchConversation = Chat.createConversation("部署排查记录", "agent");
dbc.insert(messageTable)
  .values({
    conversationId: searchConversation.id,
    role: "assistant",
    content: "我先检查了网关端口，最后定位到是占用冲突导致启动失败。",
  })
  .run();
const otherConversation = Chat.createConversation("无关会话", "agent");
dbc.insert(messageTable)
  .values({ conversationId: otherConversation.id, role: "user", content: "今天天气不错。" })
  .run();

const byTitle = Agent.searchAgentSessions("部署排查");
check("搜索命中标题", byTitle.some((hit) => hit.id === searchConversation.id));
const byContent = Agent.searchAgentSessions("占用冲突");
check(
  "搜索命中**消息正文**（不只是标题）",
  byContent.some((hit) => hit.id === searchConversation.id),
  JSON.stringify(byContent.map((hit) => hit.title)),
);
check(
  "命中结果带上下文片段",
  (byContent[0]?.matches[0]?.snippet ?? "").includes("占用冲突"),
  byContent[0]?.matches[0]?.snippet,
);
check("不相关会话不会混进结果", byContent.every((hit) => hit.id !== otherConversation.id));
check("空关键词返回空结果（不把整个列表倒出来）", Agent.searchAgentSessions("   ").length === 0);

// ---------------------------------------------------------------------------
// 7. 自动化：CRUD + 调度 + 巡检
// ---------------------------------------------------------------------------
const created = Automations.createAutomation({
  name: "每天早上总结",
  instructions: "汇总工作区里的改动，写一份日报。",
  workspace,
  scheduleKind: "daily",
  schedule: { hour: 9, minute: 0 },
  timezone: "Asia/Shanghai",
});
check("创建自动化并算出下次触发", created.nextRunAt !== null && created.id > 0);
check("列表能查到", Automations.listAutomations().some((item) => item.id === created.id));
check("计划描述可读", Automations.describeSchedule(created.scheduleKind, created.schedule).includes("09:00"));

const disabled = Automations.updateAutomation(created.id, { enabled: false });
check("禁用后 nextRunAt 清空", disabled?.enabled === false && disabled?.nextRunAt === null);
const reenabled = Automations.updateAutomation(created.id, { enabled: true });
check("重新启用会重算下次触发", reenabled?.enabled === true && reenabled?.nextRunAt !== null);

// 强制到点 → 巡检应当把它捡起来跑一次；没有可用模型时会记一条 failed 运行。
Automations.updateAutomation(created.id, { scheduleKind: "daily", schedule: { hour: 0, minute: 0 } });
const { db } = await import("../src/bun/db");
const { automations } = await import("../src/bun/db/schema");
const { eq } = await import("drizzle-orm");
db.update(automations).set({ nextRunAt: Date.now() - 1000 }).where(eq(automations.id, created.id)).run();
const executed = await Automations.tickAutomations();
check("巡检捡起到点的任务", executed === 1, `executed=${executed}`);
const runs = Automations.listAutomationRuns(created.id);
check("没有可用推理服务时落一条 failed 运行记录", runs.length === 1 && runs[0]?.status === "failed");
check(
  "失败原因可读（指向模型 / 推理服务，而不是异常堆栈）",
  /模型|model/i.test(runs[0]?.error ?? ""),
  runs[0]?.error ?? "",
);
const afterRun = Automations.getAutomation(created.id);
check("跑完后下次触发已顺延", (afterRun?.nextRunAt ?? 0) > Date.now());

check(
  "调度触发的运行会产生通知（跑完/失败都会）",
  Notifications.listNotifications().some((item) => item.kind === "error" || item.kind === "automation"),
);
Automations.deleteAutomation(created.id);
check("删除自动化", Automations.listAutomations().length === 0 && Automations.listAutomationRuns(created.id).length === 0);

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------
Interactions.cancelPendingForConversation(conversationId);
if (providedDataDir === undefined) rmSync(dataDir, { recursive: true, force: true });
rmSync(workspace, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\nagent capabilities smoke: ${failed} 项失败`);
  process.exit(1);
}
console.log("\nagent capabilities smoke 全部通过");
