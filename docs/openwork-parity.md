# Agent 能力对齐 OpenWork（Claude Cowork 开源版）

> 参照项目：[different-ai/openwork](https://github.com/different-ai/openwork)（MIT，23k★，opencode 驱动）。
> 本文是「OpenWork 有哪些 Agent 能力 / 功能页面 → 我们在哪落地 → 现状」的对照表，
> 也是后续继续补齐的清单。落地代码统一在 `apps/studio/src/bun/agent*.ts` 与
> `apps/studio/src/mainview/app/agent/*`、`automations-screen.tsx`。

## 1. 为什么对照它

我们的 Agent 原来只有「一个会话 + 一组工具 + 工具调用卡片」：没有授权确认、没有任务清单、
没有产出物面板、没有会话管理、没有子智能体、没有自动化。OpenWork 把这些做成了产品级形态，
逐项对照后补齐，是本轮工作的主体。

## 2. 能力对照表

| # | OpenWork 的能力 | 落地实现（本仓库） | 状态 |
|---|---|---|---|
| 1 | **权限/授权**：引擎按 `allow / ask / deny` 求值，last-match-wins，确认给「允许一次 / 本会话总是 / 拒绝」 | `bun/permissions.ts`（规则求值 + 通配匹配 + 分层来源）、`bun/agent-interactions.ts`（挂起/唤醒）、`Agent.beforeToolCall` 闸门、**消息流内的确认卡片** `app/agent/inline-interactions.tsx` | ✅ 完成，且多一档「始终允许（写进工作区规则）」与 `doom_loop` 检测 |
| 2 | **审批模式**：manual / auto 两种服务端审批 | `AGENT_APPROVAL_MODE` 四档：`smart`（默认）/ `manual` / `auto` / `strict` | ✅ 完成（多两档，更贴合本地开发） |
| 3 | **生效权限面板**：探针 + 命中规则 + 来源归属（engine/global/openwork/workspace） | `summarizeEffectivePermissions()` + 设置页「Agent 权限」（`main-layout/permissions-tab.tsx`） | ✅ 完成（来源 = builtin/settings/workspace/session，另有「N 条例外规则」计数） |
| 4 | **记住的授权**：`always` 只对同一会话生效，重放不越权 | `agent_permissions` 表（scope = session / workspace）+ 弹窗「本会话总是 / 始终允许」 | ✅ 完成（工作区级可持久化，比 OpenWork 更进一步） |
| 5 | **待办清单 `todowrite`** + 面板 | `agent-todos.ts` + `todo_write` 工具 + `app/agent/todo-panel.tsx`（输入框上方，进度条） | ✅ 完成 |
| 6 | **提问 `question`**（选项 / 多选 / 自定义答案） | `ask_user` 工具 + `askQuestions()` + 消息流内的提问卡片 `app/agent/inline-interactions.tsx` | ✅ 完成 |
| 7 | **子智能体 `task`**：独立上下文，只回结论；UI 折成一行 | `runSubagent()`（独立 Agent 循环、事件带 `subagentId`）+ `app/agent/timeline.tsx` 的 `SubagentGroup` | ✅ 完成（原地内联展示，未做"子会话可单独打开"） |
| 8 | **产出物面板 artifacts**：文件树 + 预览（markdown/代码/图片/PDF/表格） | `agent-artifacts.ts`（登记 + 预览 + 工作区文件树）+ `app/agent/artifact-panel.tsx`（产出物 / 文件两个页签，左侧分隔条可拖宽） | ✅ 完成（表格编辑未做；面板做成多页签：产出物 / 审查 / 文件 / 终端 / 浏览器 + 预览，HTML 走 `image-server.ts` 的 `/artifact/<id>`、`/workspace/<rootId>/<路径>` 在 iframe 里当网页加载） |
| 8b | **消息流渲染**：工具轨迹收成一行、思考可展开、正文是正文 | `app/agent/message.tsx`（思考行 / 产出物卡片 / 操作条）+ `app/agent/timeline.tsx`（一行一个工具调用，点开看命令、diff、输出） | ✅ 完成（正文不再套气泡；正文与思考按 40ms 批量流式下发） |
| 9 | **会话侧栏**：新建 / 搜索 / 自动化 / 插件 / Skills / 置顶 / 归档 / 重命名 / 工作区分组 | `listAgentSessions()` + `app/agent/session-sidebar.tsx`；`conversations.workspace`、`conversations.archived_at` | ✅ 完成（拖拽排序未做；四个入口都在 Agent 主区域内打开，不占一级菜单） |

> **两条交互约定（按用户反馈定的）**
> 1. **确认发生在消息流里，不是弹窗**：授权 / 提问的「请求 + 结果」各落一条 `agent_events`
>    （`permission_request` / `permission`、`question_request` / `question`，按 id 配对），
>    界面把卡片画在触发它的那条消息下面 —— 不遮挡输入框，回看历史时「当时问了什么、怎么答的」也还在。
> 2. **搜索 / 自动化 / 插件 / Skills 是 Agent 的能力，不是一级产品线**：
>    它们是 Agent 侧栏「新建任务」下面的入口，点开后在 Agent 主区域里显示（带「返回对话」），
>    应用左侧一级菜单里不再有「自动化」。
| 10 | **工作区（per-session cwd）** | `setConversationWorkspace()` / `workspaceForConversation()`；侧栏按工作区分组 | ✅ 完成 |
| 11 | **自动化 Automations**：once/daily/weekly + 时区、运行记录、桌面 runner | `bun/automations.ts`（计划计算含 DST + 30s 巡检 + 运行记录）+ `app/automations-screen.tsx` | ✅ 完成（单机调度；OpenWork 的企业 runner 不适用） |
| 12 | **斜杠命令 / @提及**（文件、应用、连接器） | `app/agent/composer-suggestions.tsx`（`/agent /plan /goal /new /tools /help`、`@` 工作区文件） | 🟡 文件提及已做；应用/连接器提及未做 |
| 12b | **会话搜索**（标题 + 正文片段） | `searchAgentSessions()` + `app/agent/agent-views.tsx` 的搜索视图 | ✅ 完成（原来只匹配标题与最后一条消息） |
| 13 | **编辑 diff 展示** | `timeline.tsx` 的 `EditDiff`（LCS 行级 diff，+/- 计数） | ✅ 完成 |
| 13b | **上下文压缩**（长任务不炸窗口） | `bun/agent-compaction.ts` + `Agent.transformContext`：按窗口 60% 预算裁剪历史，保留任务陈述与最近进展，裁掉的量写进轨迹；尾部不会以工具结果开头（否则真实服务 400） | ✅ 完成（确定性裁剪，不做额外模型调用） |
| 14 | **侧栏状态点**：运行中 / 需要你 / 未读 | `AgentSessionView.needsAttention` + 未读集合（`stores/agent.ts`） | ✅ 完成（桌面角标 / 系统通知未做） |
| 15 | **队列消息**：运行中继续输入，排队下发 / 立即插入（steer） | `followUpAgentMessage()`（steer 走 `Agent.steer`、queue 在本轮结束后逐条 drain）+ `app/agent/queue-panel.tsx` | ✅ 完成（Enter 排队、Cmd/Ctrl+Enter 插话、可单条移除） |
| 16 | **会话分支**（从某条消息 fork 出新会话） | `Chat.forkConversation()` + 消息操作条上的「分支」按钮；回退/压缩用已有的重新生成 | 🟡 分支已做，revert / compact 未做 |
| 17 | **浏览器自动化**（browser_tabs/observe/act + 接管） | — | ❌ 未做（需要原生浏览器视图，Electrobun WebContentsView 层工作量大） |
| 18 | **Computer Use**（原生辅助功能驱动桌面） | — | ❌ 未做（OpenWork 走 Swift 原生模块） |
| 19 | **技能 / MCP / 连接器** | 已有：`bun/skills/*`、`bun/mcp.ts`、`skills` 页与 MCP 设置页 | ✅ 本仓库原有能力，未改动 |
| 20 | **多会话并行 / 分屏** | 已有：会话侧栏可并行跑（每个会话一个 Agent 实例），但无分屏 | 🟡 并行可跑，分屏未做 |
| 21 | **通知中心** | `bun/notifications.ts` + 顶栏铃铛（`app/agent/notification-bell.tsx`）；来源 = 后台授权请求 / 自动化结果 / 无人值守回合结束 | ✅ 完成（系统级通知角标未做） |
| 22 | **企业控制面**（OpenWork Den：组织、策略、市场） | — | ➖ 不适用（单机产品） |

## 3. 关键设计差异（有意为之）

- **不引入 opencode 引擎**：OpenWork 把会话与权限托给 opencode；我们的 Agent 循环是
  `@earendil-works/pi-agent-core`，所以权限判定、待办、交互全部在进程内自己实现（无外部依赖）。
- **默认更"不打扰"**：OpenWork 默认 `ask` 所有工具（manual）；本地单人开发场景下那样噪声太大，
  因此默认 `smart`：普通命令与工作区内写入直接放行，只拦危险命令、工作区外访问与重复打转。
  想要严格模式随时切 `manual` / `strict`。
- **授权可持久化**：OpenWork 的 `always` 只记在同一 thread；我们把「始终允许」写成工作区规则落库，
  并在设置页可见可删（`agent_permissions` 表）。
- **自动化跑真实会话**：OpenWork 的桌面 runner 需要 Den 云控制面；我们直接开一条本地会话跑，
  结果可点开继续追问（`automation_runs.conversation_id`）。

## 4. 数据与接口

新增表（迁移 `0026_glossy_sentry`）：

- `agent_permissions`：会话/工作区级授权规则（`scope`, `scope_ref`, `permission`, `pattern`, `action`）
- `agent_todos`：会话待办清单（全量覆盖写入，`seq` 决定顺序）
- `agent_artifacts`：产出物（相对路径 + 绝对路径 + 类型 + 体积 + 写入它的工具）
- `automations` / `automation_runs`：计划与运行记录
- `conversations.workspace` / `conversations.archived_at`；`agent_events.subagent_id`

主要 RPC（`bun/rpc/index.ts`）：

- 会话：`listAgentSessions` / `createAgentSession` / `renameAgentSession` /
  `setAgentSessionPinned` / `setAgentSessionArchived` / `setAgentSessionWorkspace`
- 交互：`listAgentInteractions` / `respondAgentPermission` / `respondAgentQuestion` /
  `listAgentTodos` / `listAgentArtifacts` / `readAgentArtifact` / `deleteAgentArtifact` /
  `listWorkspaceFiles` / `readWorkspaceFile`
- 权限：`getAgentPermissions` / `setAgentApprovalMode` / `setAgentPermissionRules` /
  `deleteAgentPermissionRule` / `clearAgentPermissionGrants` / `setAgentAuthorizedFolders`
- 自动化：`listAutomations` / `createAutomation` / `updateAutomation` / `deleteAutomation` /
  `runAutomationNow` / `listAutomationRuns`
- 推送：`agentPermissionRequest` / `agentPermissionSettled` / `agentQuestion` /
  `agentQuestionSettled` / `agentTodos` / `agentArtifact` / `automationsChanged`

## 5. 工具集变化（`bun/agent-tools.ts`）

新增：`todo_write`、`ask_user`、`task`（子智能体）、`web_fetch`（正文抓取）。
改造：`read_file` / `list_dir` / `glob` / `grep` 走 `assertReadable`，`write_file` / `edit_file` 走
`assertWritable` —— 工作区之外的读写需要落在已授权目录里（弹窗授权后自动加入白名单）。

## 6. 验证

```bash
bun run lint && bun run typecheck && bun run test
bun run --cwd apps/studio test:smoke        # 含新增的 agent-capabilities-smoke
```

- `src/bun/permissions.test.ts`：规则求值、通配语义、工具→请求翻译、危险命令识别（20 例）
- `src/bun/automations.test.ts`：时区换算（含 DST）、daily/weekly/once 下次触发、计划描述（8 例）
- `scripts/agent-capabilities-smoke.ts`：模块级端到端 —— 授权往返（挂起→允许/拒绝/中断收尾）、
  提问往返、待办覆盖与进度、产出物登记与文件树、会话管理与归档、会话搜索（标题 / 正文 / 片段）、
  自动化 CRUD 与巡检落库
- `src/bun/agent-compaction.test.ts`：token 估算、裁剪边界（保留任务陈述与最近 4 条）、
  工具结果不能当尾部起点（9 例）
- `scripts/agent-live-check.ts`：**真实 Agent 循环**（自带脚本化 OpenAI 兼容桩服务，确定性、进 smoke）——
  流式解析（含工具参数分片）→ 危险命令弹窗 → 拒绝后工具确实没执行（用真实目录当靶子验证）
  → 允许后确实执行 → 轨迹 / 待办 / 产出物落库 → 运行中排队与插话（steer）→ 队列 drain
  → 子智能体跑完自己的多轮循环并把结论回传主线 → 上下文压缩在长任务里触发且任务仍跑完
  → 授权与提问的「请求 + 结果」都落成会话事件、按 id 配对、答案回到模型（界面据此在消息流里渲染）

> 说明：本轮没能跑通"真实本地模型"的验证 —— 应用拉起的 MLX 服务在探测时接受一次连接后就拒绝
> 连接（引擎侧问题，见 ROADMAP M2）。Agent 侧则用确定性桩服务把链路全覆盖了；
> 想用真实服务验证时把 `OMNI_LIVE_BASE` / `OMNI_LIVE_MODEL` 指过去即可。

## 7. 后续可继续补齐（按价值排序）

1. **浏览器自动化面板**（Electrobun 的 WebContentsView + 每步授权 + 接管）
2. **Computer Use**（macOS 辅助功能，按 app/window 授权）
3. 会话**回退 / 上下文压缩**（revert / compact；现在只有「重新生成」与「分支」）
4. 子智能体升级为**独立子会话**（现在内联折叠展示，OpenWork 可点进去）
5. 系统级通知（macOS 通知中心角标）与分屏对照
