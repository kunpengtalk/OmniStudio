/**
 * Agent 能力面冒烟（对齐 OpenWork 的那批能力）：
 * 权限规则求值 → 授权往返（ask → 允许 / 会话总是 / 拒绝）→ 待办写入 → 产出物登记
 * → 工作区文件树 / 文件读取 → 自动化 CRUD 与调度巡检 → 会话管理（重命名 / 归档 / 工作区）。
 *
 * 全程不调用模型：自动化那步用「没有模型 → 记一条 failed 运行」的分支验证落库与续排。
 * 跑法：bun run scripts/agent-capabilities-smoke.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
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

/** 仓库根（本脚本在 apps/studio/scripts/ 下）。 */
const repoRoot = path.resolve(import.meta.dir, "../../..");

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

// 命令归一化（对齐 Codex 的 command_canonicalization）：多一个空格 / 引号不该绕过审批。
check(
  "等价写法（多余空格 / 引号）同样命中危险命令规则",
  ["rm  -rf /tmp/x", "rm\t-rf /tmp/x", 'rm "-rf" /tmp/x'].every(
    (command) =>
      Permissions.evaluate({ permission: "bash", pattern: command }, Permissions.defaultRules("smart"))
        .action === "ask",
  ),
);
check(
  "普通命令不会被归一化误伤",
  Permissions.evaluate({ permission: "bash", pattern: "npm  test" }, Permissions.defaultRules("smart"))
    .action === "allow",
);

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
check("生效权限摘要含 7 个探针（含沙箱升级）", summary.length === 7);
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
// 8. Codex 对齐：项目指令（AGENTS.md）/ apply_patch / 看图工具
// ---------------------------------------------------------------------------
const Instructions = await import("../src/bun/agent-instructions");
const { buildAgentTools: buildTools, buildReadOnlyTools: buildReadTools } = await import(
  "../src/bun/agent-tools"
);

// 8.1 项目指令：从工作区向上找到仓库根，逐级装载
fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
fs.mkdirSync(path.join(workspace, "pkg"), { recursive: true });
fs.writeFileSync(path.join(workspace, "AGENTS.md"), "仓库约定：用 pnpm，改完跑 lint。\n");
fs.writeFileSync(path.join(workspace, "pkg", "AGENTS.md"), "包约定：先跑 typecheck。\n");
const loaded = Instructions.loadProjectInstructions(path.join(workspace, "pkg"));
check(
  "项目指令按「根 → 工作区」装载 AGENTS.md",
  loaded.files.length === 2 &&
    loaded.files[0]!.contents.includes("pnpm") &&
    loaded.files[1]!.contents.includes("typecheck"),
  JSON.stringify(loaded.files.map((file) => file.path)),
);
check(
  "拼出的段落标明来源文件与优先级",
  loaded.section.includes("项目指令") && loaded.section.includes("AGENTS.md"),
);

fs.writeFileSync(path.join(workspace, "pkg", "AGENTS.override.md"), "覆盖：这个包用 bun。\n");
const overridden = Instructions.loadProjectInstructions(path.join(workspace, "pkg"));
check(
  "同目录下 AGENTS.override.md 优先于 AGENTS.md",
  overridden.files.some((file) => file.contents.includes("这个包用 bun")) &&
    !overridden.files.some((file) => file.contents.includes("先跑 typecheck")),
);

// 8.2 工具面：apply_patch 只在能动手的模式里，view_image 只在视觉模型下
const agentTools = await Agent.listAgentTools("agent");
const planTools = await Agent.listAgentTools("plan");
check("agent 模式有 apply_patch（带盾牌标记）", agentTools.some((t) => t.name === "apply_patch" && t.gated));
check(
  "plan 模式没有 apply_patch（只出方案不动手）",
  planTools.every((t) => t.name !== "apply_patch"),
);
const visionCtx = { workspace, allowShell: false, vision: true };
const textCtx = { workspace, allowShell: false, vision: false };
check(
  "view_image 只给视觉模型",
  buildReadTools(visionCtx).some((t) => t.name === "view_image") &&
    !buildReadTools(textCtx).some((t) => t.name === "view_image"),
);

// 8.3 apply_patch：多文件原子落盘 + 定位失败不动文件
// 产出物登记要按 agent.ts 的接线注入（工具本身不知道会话是谁）。
const patchTarget = path.join(workspace, "patch-target.txt");
fs.writeFileSync(patchTarget, '{"ok":true}\n');
const patchTool = buildTools({
  ...textCtx,
  conversationId,
  messageId: null,
  recordArtifact: (filePath, toolName) =>
    Artifacts.recordArtifact({ conversationId, messageId: null, filePath, workspace, tool: toolName }),
}).find((t) => t.name === "apply_patch")!;
const patchResult = await patchTool.execute("smoke-patch", {
  patch: [
    "*** Begin Patch",
    "*** Add File: notes/patch-smoke.md",
    "+# 补丁冒烟",
    "*** Update File: patch-target.txt",
    "@@",
    '-{"ok":true}',
    '+{"ok":false}',
    "*** End Patch",
  ].join("\n"),
});
const patchText = JSON.stringify(patchResult);
check(
  "apply_patch 一次改多个文件并给出 A/M 摘要",
  patchText.includes("A notes/patch-smoke.md") &&
    patchText.includes("M patch-target.txt") &&
    fs.readFileSync(patchTarget, "utf8").includes("false"),
);
const beforeFail = fs.readFileSync(patchTarget, "utf8");
const failResult = await patchTool.execute("smoke-patch-fail", {
  patch: ["*** Begin Patch", "*** Update File: patch-target.txt", "@@", "-不会出现的行", "+x", "*** End Patch"].join(
    "\n",
  ),
});
check(
  "定位失败时整体不落盘（原子）",
  JSON.stringify(failResult).includes("Invalid Context") && fs.readFileSync(patchTarget, "utf8") === beforeFail,
);
check(
  "补丁影响到的文件都登记成产出物",
  Artifacts.listArtifacts(conversationId).some((item) => item.title === "patch-smoke.md"),
);
check(
  "apply_patch 的授权请求是 edit（多文件用公共目录当模式）",
  Permissions.permissionRequestForTool({
    toolName: "apply_patch",
    workspace,
    args: { patch: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch" },
  })?.permission === "edit",
);

// 8.4 看图工具：视觉模型才注册；返回图片内容块
// 先验证「模型 → 工具集」这条接线本身：切到云端 + 视觉模型名，工具列表里就该有 view_image。
updateSettings({ SERVER_MODE: "remote", VLLM_MODEL_NAME: "gpt-4o", AGENT_VISION_TOOL: "auto" });
const visionTools = await Agent.listAgentTools("agent");
const planVisionTools = await Agent.listAgentTools("plan");
check(
  "视觉模型下工具集里出现 view_image（agent 与 plan 都有）",
  visionTools.some((t) => t.name === "view_image") && planVisionTools.some((t) => t.name === "view_image"),
  visionTools.map((t) => t.name).join(","),
);
updateSettings({ SERVER_MODE: "local", VLLM_MODEL_NAME: "", AGENT_VISION_TOOL: "off" });
check(
  "关掉后工具集里没有 view_image",
  (await Agent.listAgentTools("agent")).every((t) => t.name !== "view_image"),
);
updateSettings({ AGENT_VISION_TOOL: "auto" });

fs.writeFileSync(
  path.join(workspace, "shot.png"),
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const viewTool = buildReadTools(visionCtx).find((t) => t.name === "view_image")!;
const imageResult = (await viewTool.execute("smoke-image", { path: "shot.png" })) as {
  content: { type: string; mimeType?: string }[];
};
check(
  "view_image 把图片作为内容块交回模型",
  imageResult.content.some((part) => part.type === "image" && part.mimeType === "image/png"),
);

// 8.5 回合快照与回退（对齐 Codex 的回合安全网）
const Snapshots = await import("../src/bun/agent-snapshots");
if (!Snapshots.gitAvailable()) {
  console.log("· 跳过回合快照检查：环境里没有 git");
} else {
  const snapWorkspace = mkdtempSync(path.join(tmpdir(), "omni-snap-smoke-"));
  fs.writeFileSync(path.join(snapWorkspace, "doc.md"), "v1\n");
  fs.mkdirSync(path.join(snapWorkspace, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(snapWorkspace, "node_modules", "dep.js"), "dep\n");

  const snapshot = Snapshots.createTurnSnapshot({
    conversationId,
    messageId: null,
    workspace: snapWorkspace,
  });
  check(
    "回合快照创建成功（影子仓库建在数据目录，不碰工作区）",
    snapshot !== null && !fs.existsSync(path.join(snapWorkspace, ".git")),
  );
  fs.writeFileSync(path.join(snapWorkspace, "doc.md"), "v2\n");
  fs.writeFileSync(path.join(snapWorkspace, "new.md"), "new\n");

  const preview = Snapshots.previewSnapshotChanges(snapshot!.id);
  check(
    "回退预览列出改过与新建的文件",
    preview.ok && (preview.files ?? []).map((file) => file.path).sort().join(",") === "doc.md,new.md",
    JSON.stringify(preview.files),
  );
  const reverted = Snapshots.revertToSnapshot(snapshot!.id);
  check(
    "回退还原改动、删掉这一轮新建的文件",
    reverted.ok &&
      fs.readFileSync(path.join(snapWorkspace, "doc.md"), "utf8").trim() === "v1" &&
      !fs.existsSync(path.join(snapWorkspace, "new.md")),
  );
  check(
    "排除目录（node_modules）不进快照也不被回退波及",
    fs.existsSync(path.join(snapWorkspace, "node_modules", "dep.js")),
  );
  check(
    "快照列表按会话可查（界面据此把「撤销本轮」挂到消息上）",
    Snapshots.listTurnSnapshots(conversationId).some((item) => item.id === snapshot!.id),
  );

  // 仓库维护：占用可测、阈值可调、整理后历史仍可回退。
  const usage = Snapshots.snapshotRepoUsage(snapWorkspace);
  check(
    "影子仓库占用可测（设置页显示它吃了多少磁盘）",
    usage !== null && usage.bytes > 0 && usage.turns >= 1,
    JSON.stringify(usage),
  );
  updateSettings({ AGENT_SNAPSHOT_GC_MB: "", AGENT_SNAPSHOT_GC_TURNS: "" });
  check(
    "默认维护阈值：256MB / 200 轮",
    Snapshots.snapshotGcThresholds().bytes === 256 * 1024 * 1024 &&
      Snapshots.snapshotGcThresholds().turns === 200,
  );
  const skippedGc = Snapshots.maybeGcSnapshotRepo(snapWorkspace);
  check("没到阈值时不整理，并说明原因", !skippedGc.ran && (skippedGc.reason ?? "").includes("占用"));
  const forcedGc = Snapshots.maybeGcSnapshotRepo(snapWorkspace, { force: true });
  check(
    "手动整理（force）会真的跑一次 git gc",
    forcedGc.ran && forcedGc.bytesAfter > 0,
    JSON.stringify({ ran: forcedGc.ran, before: forcedGc.bytesBefore, after: forcedGc.bytesAfter }),
  );
  check(
    "整理之后快照依然可以回退（历史没被 gc 丢掉）",
    (() => {
      const again = Snapshots.revertToSnapshot(snapshot!.id);
      return again.ok && fs.readFileSync(path.join(snapWorkspace, "doc.md"), "utf8").trim() === "v1";
    })(),
  );
  rmSync(snapWorkspace, { recursive: true, force: true });
}

// 8.6 上下文占用（对齐 Codex 的 get_context_remaining / 状态行）
const ContextUsage = await import("../src/bun/agent-context");
ContextUsage.resetContextUsageCache();
updateSettings({ SERVER_CTX_SIZE: "8192" });
const estimated = ContextUsage.contextUsage(conversationId, { systemPromptTokens: 800 });
check(
  "没有实测用量时按消息估算，预算 = 窗口的 60%",
  estimated.source === "estimate" &&
    estimated.budgetTokens === Math.floor(8192 * 0.6) &&
    estimated.usedTokens >= 800,
  JSON.stringify(estimated),
);
ContextUsage.rememberPromptTokens(conversationId, 4500);
const measured = ContextUsage.contextUsage(conversationId);
check(
  "有实测用量时用实测值（占用条与压缩线同一个判据）",
  measured.source === "usage" && measured.usedTokens === 4500 && measured.percent === 92,
  JSON.stringify(measured),
);
check(
  "接近压缩线时给模型的提示会要求先记录进度",
  ContextUsage.describeContextUsage(measured).includes("todo_write"),
);
const contextTool = buildReadTools({ ...textCtx, conversationId, systemPromptTokens: 800 }).find(
  (t) => t.name === "get_context_remaining",
);
check("get_context_remaining 出现在只读工具集里", Boolean(contextTool));
check(
  "工具返回可读的占用状态（含剩余量）",
  JSON.stringify(await contextTool!.execute("smoke-ctx", {})).includes("剩余约"),
);
ContextUsage.resetContextUsageCache();

// 8.7 命令沙箱（对齐 Codex 的 workspace-write）
const Sandbox = await import("../src/bun/agent-sandbox");
updateSettings({ AGENT_SANDBOX_MODE: "off" });
check(
  "默认不沙箱：命令原样执行",
  Sandbox.wrapShellCommand("echo hi", { workspace, shell: "/bin/zsh" }).cmd[0] === "/bin/zsh",
);
updateSettings({ AGENT_SANDBOX_MODE: "workspace-write" });
const wrapped = Sandbox.wrapShellCommand("echo hi", { workspace, shell: "/bin/zsh" });
check(
  "开启后包上平台沙箱（不支持的平台降级并说明原因）",
  Sandbox.sandboxSupported()
    ? wrapped.cmd[0] === "sandbox-exec" && wrapped.degradedReason === undefined
    : wrapped.degradedReason !== undefined,
  JSON.stringify(wrapped.cmd.slice(0, 1)),
);
const profile = Sandbox.sandboxProfile({ workspace });
check(
  "策略只允许写工作区 / 临时目录，并拒绝凭据目录",
  profile.includes(`(subpath "${path.resolve(workspace)}")`) &&
    profile.includes("deny file-write*") &&
    profile.includes("deny file-read*"),
);
check(
  "三种档位可解析（off ↔ danger-full-access、workspace-write、read-only）",
  Sandbox.isSandboxMode("off") &&
    Sandbox.isSandboxMode("workspace-write") &&
    Sandbox.isSandboxMode("read-only") &&
    !Sandbox.isSandboxMode("nope"),
);
const readOnlyProfile = Sandbox.sandboxProfile({ workspace, mode: "read-only" });
check(
  "read-only 策略不放行工作区写入（只有临时目录与设备节点）",
  readOnlyProfile.includes("(deny default)") &&
    !readOnlyProfile.includes(`(allow file-write* (subpath "${path.resolve(workspace)}")`) &&
    readOnlyProfile.includes(`(subpath "${path.resolve(tmpdir())}")`),
);
if (Sandbox.sandboxSupported()) {
  // 真实跑一次：工作区内可写、工作区外被内核拦下。
  const sandboxTools = buildTools({ ...textCtx, allowShell: true });
  const sandboxBash = sandboxTools.find((t) => t.name === "bash")!;
  const insideResult = await sandboxBash.execute("smoke-sandbox-in", {
    command: "echo sandbox-inside > sandbox-note.txt && cat sandbox-note.txt",
  });
  check("沙箱内工作区可写", JSON.stringify(insideResult).includes("sandbox-inside"));
  const escapeTarget = path.join(process.env.HOME ?? "/tmp", `omni-smoke-escape-${Date.now()}.txt`);
  const outsideResult = await sandboxBash.execute("smoke-sandbox-out", {
    command: `echo nope > ${escapeTarget}`,
  });
  check(
    "沙箱拦下工作区外的写入（并给出可读解释）",
    JSON.stringify(outsideResult).includes("沙箱") && !fs.existsSync(escapeTarget),
  );
  // 沙箱升级（对齐 Codex 的 sandbox_approval）：被拦 → 问用户 → 跳沙箱重跑一次。
  const escalationWorkspace = mkdtempSync(path.join(process.env.HOME ?? tmpdir(), ".omni-smoke-escalate-"));
  updateSettings({ AGENT_SANDBOX_MODE: "read-only", AGENT_AUTHORIZED_FOLDERS: "[]" });
  try {
    const escalationTools = buildTools({
      workspace: escalationWorkspace,
      allowShell: true,
      vision: false,
      escalateSandbox: async () => null, // 用户点「跳过沙箱重试」
    });
    const escalationBash = escalationTools.find((t) => t.name === "bash")!;
    const escalated = await escalationBash.execute("smoke-escalate", {
      command: "echo escalated > out.txt && cat out.txt",
    });
    check(
      "沙箱升级：允许后跳过沙箱重跑一次（文件真的落了盘）",
      JSON.stringify(escalated).includes("跳过沙箱重试") &&
        fs.readFileSync(path.join(escalationWorkspace, "out.txt"), "utf8").trim() === "escalated",
    );
    const deniedTools = buildTools({
      workspace: escalationWorkspace,
      allowShell: true,
      vision: false,
      escalateSandbox: async () => "已按当前权限策略拒绝：跳过命令沙箱（sandbox_escalation）",
    });
    const deniedBash = deniedTools.find((t) => t.name === "bash")!;
    fs.rmSync(path.join(escalationWorkspace, "out.txt"), { force: true });
    const denied = await deniedBash.execute("smoke-escalate-deny", { command: "echo nope > out.txt" });
    check(
      "沙箱升级：拒绝时不重跑，并把原因交给模型",
      JSON.stringify(denied).includes("跳过沙箱重试被拒绝") &&
        !fs.existsSync(path.join(escalationWorkspace, "out.txt")),
    );
    check(
      "升级权限档位：smart 询问、auto 默认拒绝（用户可以显式放行）",
      Permissions.evaluate(
        { permission: "sandbox_escalation", pattern: "*" },
        Permissions.defaultRules("smart"),
      ).action === "ask" &&
        Permissions.evaluate(
          { permission: "sandbox_escalation", pattern: "*" },
          Permissions.defaultRules("auto"),
        ).action === "deny",
    );
  } finally {
    updateSettings({ AGENT_SANDBOX_MODE: "off", AGENT_AUTHORIZED_FOLDERS: "[]" });
    rmSync(escalationWorkspace, { recursive: true, force: true });
  }

  // Linux（bwrap）：策略生成本身是纯函数，macOS 上也能验；端到端留给 Linux runner。
  // 注意：前面的用例可能把沙箱关掉了 —— 这里自己把模式摆好（每块自洽，不依赖执行顺序）。
  updateSettings({ AGENT_SANDBOX_MODE: "workspace-write" });
  const bwrapPlan = Sandbox.bwrapArgs({
    workspace,
    shell: "/bin/bash",
    command: "echo hi",
    mode: "workspace-write",
    allowNetwork: true,
  });
  const bwrapBinds = bwrapPlan.filter((arg, index) => bwrapPlan[index - 1] === "--bind");
  check(
    "bwrap：先只读挂根、再把工作区与临时目录挂成可写",
    bwrapPlan.slice(0, 3).join(" ") === "--ro-bind / /" &&
      bwrapBinds.includes(path.resolve(workspace)) &&
      bwrapBinds.includes(path.resolve(tmpdir())),
  );
  check(
    "bwrap：read-only 不挂工作区；关联网加 --unshare-net",
    !Sandbox.bwrapArgs({ workspace, shell: "/bin/bash", command: "ls", mode: "read-only" })
      .filter((arg, index, all) => all[index - 1] === "--bind")
      .includes(path.resolve(workspace)) &&
      Sandbox.bwrapArgs({ workspace, shell: "/bin/bash", command: "ls", allowNetwork: false }).includes(
        "--unshare-net",
      ),
  );
  check(
    "后端按平台选：darwin → seatbelt / linux → bwrap / 其它 → none",
    Sandbox.sandboxBackend("darwin") === "seatbelt" &&
      Sandbox.sandboxBackend("linux") === "bwrap" &&
      Sandbox.sandboxBackend("win32") === "none",
  );
  check(
    "Linux 缺 bwrap 时降级并给出安装命令（不假装支持）",
    (() => {
      const degraded = Sandbox.wrapShellCommand("echo hi", {
        workspace,
        shell: "/bin/bash",
        platform: "linux",
        bwrapReady: false,
      });
      return degraded.cmd[0] === "/bin/bash" && (degraded.degradedReason ?? "").includes("apt install bubblewrap");
    })(),
  );
  check(
    "Linux 有 bwrap 时包出 bwrap 命令",
    Sandbox.wrapShellCommand("echo hi", {
      workspace,
      shell: "/bin/bash",
      platform: "linux",
      bwrapReady: true,
    }).cmd[0] === "bwrap",
  );

  // Linux（Landlock）：真实执行要原生辅助程序（Linux runner 才有），这里验策略生成 ——
  // 档位 → 允许路径集合是纯函数，macOS 上也能跑；将来辅助程序读同一份 JSON。
  const llWrite = Sandbox.landlockRuleset({
    workspace,
    mode: "workspace-write",
    authorizedFolders: [],
  });
  const llRead = Sandbox.landlockRuleset({ workspace, mode: "read-only", authorizedFolders: [] });
  const llWritePath = (ruleset: typeof llWrite) =>
    ruleset.rules.filter((r) => r.path === path.resolve(workspace));
  check(
    "Landlock：根只给读、工作区在 workspace-write 档才拿到写位",
    llWrite.rules[0]!.path === "/" &&
      !llWrite.rules[0]!.access.some(
        (bit) => bit.startsWith("write_") || bit.startsWith("make_") || bit === "truncate",
      ) &&
      llWritePath(llWrite).length === 1 &&
      llWritePath(llWrite)[0]!.access.includes("write_file") &&
      llWritePath(llRead).length === 0,
  );
  check(
    "Landlock：handled 覆盖全部写位（漏一位就是少拦一种）",
    ["write_file", "remove_file", "remove_dir", "make_reg", "make_dir", "truncate"].every((bit) =>
      llWrite.handled.includes(bit as (typeof llWrite.handled)[number]),
    ) &&
      llWrite.rules.every((rule) => rule.access.every((bit) => llWrite.handled.includes(bit))),
  );
  check(
    "Landlock：规格 JSON 稳定可交给辅助程序（同档位同串）",
    Sandbox.landlockRulesetSpec({ workspace, mode: "workspace-write", authorizedFolders: [] }) ===
      Sandbox.landlockRulesetSpec({ workspace, mode: "workspace-write", authorizedFolders: [] }),
  );
  check(
    "Landlock：状态如实（本机能不能用是真探测出来的，不是写死的）",
    Sandbox.landlockStatus().policyReady === true &&
      (process.platform === "linux"
        ? Sandbox.landlockStatus().helperAvailable === true ||
          (Sandbox.landlockStatus().reason ?? "").length > 0
        : Sandbox.landlockStatus().helperAvailable === false),
  );
  check(
    "Landlock：后端偏好 auto 时 bwrap 优先、Landlock 兜底（显式偏好也能生效）",
    Sandbox.effectiveSandboxBackend("linux", { bwrapReady: true, landlockReady: true }) === "bwrap" &&
      Sandbox.effectiveSandboxBackend("linux", { bwrapReady: false, landlockReady: true }) === "landlock" &&
      Sandbox.effectiveSandboxBackend("linux", { bwrapReady: true, landlockReady: false }) === "bwrap" &&
      Sandbox.effectiveSandboxBackend("linux", { bwrapReady: true, landlockReady: true, prefer: "landlock" }) ===
        "landlock",
  );
  check(
    "Landlock：辅助程序源码必须进打包清单（漏了它 Linux 上永远降级）",
    (() => {
      const config = readFileSync(path.join(repoRoot, "apps", "studio", "electrobun.config.ts"), "utf8");
      const source = path.join(repoRoot, "apps", "studio", "src", "bun", "omni-landlock.c");
      // 打包后主进程在 bun/ 下，landlock-helper.ts 用 import.meta.dir 找同目录的 .c，
      // 所以 copy 目标必须是 bun/omni-landlock.c。
      return existsSync(source) && config.includes('"src/bun/omni-landlock.c": "bun/omni-landlock.c"');
    })(),
  );
  check(
    "Landlock：没装编译器 / 内核不支持时给出可诊断的理由（不是一句含糊的不支持）",
    (() => {
      const status = Sandbox.landlockStatus();
      if (status.helperAvailable) return true; // 本机能用：这条没什么可验的
      return (status.reason ?? "").trim().length > 10;
    })(),
  );

  updateSettings({ AGENT_SANDBOX_MODE: "off" });

  // read-only：连工作区都不给写，只有临时目录例外。
  // 工作区必须放在用户目录下 —— TMPDIR 正是 read-only 唯一放行写入的地方。
  const roWorkspace = mkdtempSync(path.join(process.env.HOME ?? tmpdir(), ".omni-smoke-readonly-"));
  updateSettings({ AGENT_SANDBOX_MODE: "read-only", AGENT_AUTHORIZED_FOLDERS: "[]" });
  try {
    fs.writeFileSync(path.join(roWorkspace, "keep.txt"), "原样\n");
    const roTools = buildTools({ workspace: roWorkspace, allowShell: true, vision: false });
    const roBash = roTools.find((t) => t.name === "bash")!;
    const roWrite = await roBash.execute("smoke-ro-write", { command: "echo changed > keep.txt" });
    check(
      "read-only：工作区写入被内核拦下",
      JSON.stringify(roWrite).includes("沙箱") &&
        fs.readFileSync(path.join(roWorkspace, "keep.txt"), "utf8").trim() === "原样",
    );
    const roTmp = path.join(tmpdir(), `omni-smoke-ro-${Date.now()}.txt`);
    const roTmpWrite = await roBash.execute("smoke-ro-tmp", { command: `echo scratch > ${roTmp} && cat ${roTmp}` });
    check("read-only：临时目录例外（工具链要写 TMPDIR）", JSON.stringify(roTmpWrite).includes("scratch"));
    fs.rmSync(roTmp, { force: true });
  } finally {
    updateSettings({ AGENT_SANDBOX_MODE: "off", AGENT_AUTHORIZED_FOLDERS: "[]" });
    rmSync(roWorkspace, { recursive: true, force: true });
  }
} else {
  console.log("· 跳过沙箱端到端检查：当前平台没有沙箱实现");
}
updateSettings({ AGENT_SANDBOX_MODE: "off" });

// 8.75 request_permissions（对齐 Codex 的同名工具）：模型主动申请走同一条授权闸门
check(
  "request_permissions 在工具面里（交互分组）",
  agentTools.some((t) => t.name === "request_permissions" && t.group === "interact"),
  agentTools.map((t) => `${t.name}:${t.group}`).join(","),
);
const requestPromise = Interactions.authorizeToolCall({
  conversationId,
  messageId: null,
  toolName: "request_permissions",
  args: { path: "/opt/shared/reference", reason: "读参考文档" },
  workspace,
  argsPreview: "/opt/shared/reference（读参考文档）",
});
await new Promise((resolve) => setTimeout(resolve, 20));
const requestCard = Interactions.listPendingPermissions(conversationId)[0];
check(
  "申请权限时弹出的是 external_directory 卡片（带路径与理由）",
  requestCard?.permission === "external_directory" && requestCard?.pattern === "/opt/shared/reference",
  JSON.stringify(requestCard ?? null),
);
Interactions.respondPermission(requestCard!.id, "deny");
const requestOutcome = await requestPromise;
check(
  "拒绝后模型拿到明确原因（而不是一句假的已授权）",
  typeof requestOutcome === "string" && requestOutcome.includes("拒绝"),
  String(requestOutcome),
);

// 8.8 外部通知回调（对齐 Codex 的 notify）
const NotifyHook = await import("../src/bun/agent-notify");
const hookFile = path.join(dataDir, "notify-payload.json");
updateSettings({ AGENT_NOTIFY_COMMAND: "" });
check("默认不配置外部通知", !NotifyHook.externalNotifyConfigured());
updateSettings({ AGENT_NOTIFY_COMMAND: `sh -c 'printf %s "$1" > ${hookFile}' omni-notify` });
Notifications.notify({ kind: "permission", title: "需要授权", body: "bash", conversationId });
let payload: { type?: string; conversationId?: number } | null = null;
for (let i = 0; i < 60 && payload === null; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 50));
  try {
    payload = JSON.parse(fs.readFileSync(hookFile, "utf8")) as { type?: string; conversationId?: number };
  } catch {
    // 还没写完
  }
}
check(
  "通知事件以 JSON 载荷交给用户命令（类型映射 + 会话 id）",
  payload?.type === "agent-permission-request" && payload?.conversationId === conversationId,
  JSON.stringify(payload),
);
updateSettings({ AGENT_NOTIFY_COMMAND: "" });

// 8.83 /compact 与 /status（对齐 Codex 的同名命令）
const { compactMessages, estimateMessagesTokens } = await import("../src/bun/agent-compaction");
// 手动压缩的语义：同样的算法、**更紧的预算**（自动预算的一半，意思是"现在多留点余量"）。
const manualBudget = Math.max(256, Math.floor(Math.max(256, Math.floor(8192 * 0.6)) / 2));
const longHistory = [
  { role: "user", content: "任务陈述：" + "把这件事做完。".repeat(20) },
  ...Array.from({ length: 14 }, (_, index) => ({
    role: index % 2 === 0 ? "assistant" : "user",
    content: `第 ${index + 1} 段过程记录：` + "读了文件、跑了命令、又总结了一遍。".repeat(20),
  })),
  { role: "assistant", content: "最近的一条进展。" },
];
const compactedOnce = compactMessages(longHistory, manualBudget, (dropped) => ({
  role: "user",
  content: `（已省略 ${dropped} 条）`,
}));
check(
  "手动压缩：按更紧的预算裁掉中间历史，保留任务陈述与最近进展",
  compactedOnce.dropped > 0 &&
    compactedOnce.tokensAfter < compactedOnce.tokensBefore &&
    (compactedOnce.messages[0] as { content: string }).content.includes("任务陈述") &&
    (compactedOnce.messages[compactedOnce.messages.length - 1] as { content: string }).content.includes(
      "最近的一条进展",
    ),
  JSON.stringify({ dropped: compactedOnce.dropped, before: compactedOnce.tokensBefore, after: compactedOnce.tokensAfter }),
);
check(
  "手动压缩：上下文本来就很小时一条都不裁（如实说明无需裁剪）",
  compactMessages([{ role: "user", content: "很短" }], manualBudget, () => ({
    role: "user",
    content: "x",
  })).dropped === 0,
);
check(
  "手动压缩不会把 token 数算错（估算与压缩同一个口径）",
  estimateMessagesTokens(compactedOnce.messages as { content: unknown }[]) === compactedOnce.tokensAfter,
);
const emptyCompact = Agent.compactConversationNow(999_999);
check(
  "没跑过的会话不给假结果（明确说没有可压缩的上下文）",
  !emptyCompact.ok && (emptyCompact.reason ?? "").includes("还没跑过"),
);
const statusShape = Agent.describeAgentSession(999_999);
check(
  "/status 的字段齐全（模型 / 窗口 / 预算 / 审批 / 沙箱 / 工作区）",
  statusShape.model.length > 0 &&
    statusShape.contextWindow === 8192 &&
    statusShape.contextBudget === Math.floor(8192 * 0.6) &&
    ["smart", "manual", "auto", "strict"].includes(statusShape.approvalMode) &&
    ["off", "workspace-write", "read-only"].includes(statusShape.sandboxMode) &&
    statusShape.workspace.length > 0,
  JSON.stringify(statusShape),
);

// 8.85 会话内换模型（对齐 Codex 的 /model）
const { modelCommandOptions } = await import("../src/shared/model-command");
check(
  "/model 候选：本地只列已启动的实例，云端都留着",
  modelCommandOptions([
    { type: "local", value: "a", label: "a", state: "running" },
    { type: "local", value: "b", label: "b", state: "stopped" },
    { type: "api", value: "gpt-5", label: "gpt-5", providerName: "OpenAI" },
  ]).map((option) => option.value).join(",") === "a,gpt-5",
);
check(
  "/model 候选：当前模型排最前（回车 = 不换）",
  modelCommandOptions([
    { type: "local", value: "a", label: "a", state: "running" },
    { type: "api", value: "current", label: "current", isActive: true },
  ])[0]!.value === "current",
);
// 会话键跟着模型走：不带这一条，界面里换完模型这一轮还会发给旧模型。
updateSettings({ SERVER_MODE: "remote", VLLM_MODEL_NAME: "smoke-model-a" });
const keyA = Agent.currentModelKey();
updateSettings({ VLLM_MODEL_NAME: "smoke-model-b" });
const keyB = Agent.currentModelKey();
updateSettings({ SERVER_MODE: "local", VLLM_MODEL_NAME: "" });
const keyC = Agent.currentModelKey();
check(
  "换模型 / 换模式都会变会话键（下一轮按新模型重建会话）",
  keyA !== keyB && keyA !== keyC && keyB !== keyC,
  `${keyA} | ${keyB} | ${keyC}`,
);

// 8.9 生命周期 hooks（对齐 Codex 的 SessionStart / UserPromptSubmit）
const Hooks = await import("../src/bun/agent-hooks");
check(
  "事件名归一化（Codex 的 PascalCase 与我们的 snake_case 都认）",
  Hooks.normalizeHookEvent("UserPromptSubmit") === "user_prompt_submit" &&
    Hooks.normalizeHookEvent("session_start") === "session_start" &&
    Hooks.normalizeHookEvent("PreToolUse") === null,
);
const badHooks = Hooks.parseHookConfigs(JSON.stringify([{ event: "user_prompt_submit" }, { event: "nope", command: "x" }]));
check("坏配置逐条报错且不影响其余条目", badHooks.hooks.length === 0 && badHooks.errors.length === 2);
updateSettings({
  AGENT_HOOKS: JSON.stringify([
    { event: "user_prompt_submit", command: "echo 冒烟注入的上下文" },
  ]),
});
const hookOutcome = await Hooks.runHooks("user_prompt_submit", {
  conversationId,
  workspace,
  mode: "agent",
  prompt: "冒烟",
});
check(
  "hook 输出作为上下文回收（纯文本即可）",
  hookOutcome.context.join("").includes("冒烟注入的上下文") && hookOutcome.runs === 1,
  JSON.stringify(hookOutcome),
);
updateSettings({
  AGENT_HOOKS: JSON.stringify([
    { event: "user_prompt_submit", command: `echo '{"decision":"block","reason":"冒烟拦截"}'` },
  ]),
});
const blockedHook = await Hooks.runHooks("user_prompt_submit", {
  conversationId,
  workspace,
  mode: "agent",
  prompt: "冒烟",
});
check("明确 block 才拦下，并带回原因", blockedHook.blocked && blockedHook.reason === "冒烟拦截");
updateSettings({ AGENT_HOOKS: "[]" });

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
