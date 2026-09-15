# OmniStudio 迭代规划与未完成任务清单

> 更新：2026-09-13　结构说明见 [docs/architecture.md](./docs/architecture.md)
> 图例：✅ 已完成 / 🟡 部分完成 / ❌ 未启动　优先级：P0 核心 / P1 重要 / P2 远期
>
> 同步到 GitHub Projects 用 `scripts/create-project-backlog.sh`，数据源是 `scripts/backlog.tsv`。
> 注意：该 TSV 是**一次性导入载荷**（脚本按标题幂等，已存在的 issue 会跳过），导入后看板状态以 GitHub Projects 为准，本文件不再反向同步。

## M0 · Agent 能力对齐 OpenWork（Claude Cowork 开源版）—— ✅ 已完成

对照 [different-ai/openwork](https://github.com/different-ai/openwork) 把 Agent 从「一个会话 + 工具卡片」
补齐到产品级形态。逐项对照与差异说明见 [docs/openwork-parity.md](./docs/openwork-parity.md)。

| # | 任务 | 状态 | 实际落地 |
|---|---|---|---|
| OW-01 | 工具授权（allow / ask / deny + 弹窗四选） | ✅ | `bun/permissions.ts` + `bun/agent-interactions.ts` + `Agent.beforeToolCall` 闸门 + `app/agent/permission-modal.tsx`；审批模式 `AGENT_APPROVAL_MODE`（smart/manual/auto/strict） |
| OW-02 | 生效权限面板 + 记住的授权 | ✅ | 设置页「Agent 权限」：探针 + 命中规则 + 来源归属 + 例外计数 + 会话/工作区授权列表 + 授权目录 |
| OW-03 | 待办清单（todowrite） | ✅ | `agent-todos.ts` + `todo_write` 工具 + 输入框上方的进度面板 |
| OW-04 | 反问用户（question） | ✅ | `ask_user` 工具 + 选项/多选/自填答案弹窗 |
| OW-05 | 子智能体（task） | ✅ | `runSubagent()` 独立上下文循环 + 时间线里的折叠行（未做子会话单独打开） |
| OW-06 | 侧边面板：产出物 / 审查 / 文件 / 终端 / 浏览器（多页签、可拖动、HTML 当网页打开） | ✅ | `agent-artifacts.ts` + 右侧「产出物 / 文件」面板：markdown/代码/图片/音视频/PDF 预览；**HTML 走本地回环文件服务在 iframe 里当网页加载**（同目录 css/js 一起取到，带刷新 / 默认浏览器打开 / 访达定位），面板左侧分隔条可拖宽（宽度本机记住，双击回默认），新产出的 HTML 自动推进预览位 |
| OW-07 | 会话侧栏（置顶 / 归档 / 搜索 / 重命名 / 工作区分组） | ✅ | `listAgentSessions()` + `app/agent/session-sidebar.tsx`；`conversations.workspace` / `archived_at`。项目段是可操作的入口：点文件夹进项目（切到里面最近动过的会话）、行尾 ＋ 在该工作区新建会话、段标题打开新工作区 |
| OW-08 | 自动化（once / daily / weekly + 运行记录） | ✅ | `bun/automations.ts`（含 DST 的时区换算 + 30s 巡检）+ `automations-screen.tsx` 与 App Rail 入口 |
| OW-09 | 输入框斜杠命令 + @ 文件提及 | 🟡 | `/agent /plan /goal /new /tools /help` 与 `@` 工作区文件（上下键 + Tab/回车补全）；应用/连接器提及未做 |
| OW-09b | 上下文压缩（长任务不炸窗口） | ✅ | `bun/agent-compaction.ts` + `Agent.transformContext`；子智能体轮数独立上限 `AGENT_SUBAGENT_MAX_STEPS` |
| OW-10 | 编辑 diff 视图 | ✅ | LCS 行级 diff（+/- 计数）内联在 edit_file / write_file 卡片里 |
| OW-11 | 运行中排队消息 / 插话（steer） | ✅ | `followUpAgentMessage()` + 队列面板：Enter 排队、Cmd/Ctrl+Enter 立即插话、停止时连队列一起取消 |
| OW-12 | 会话分叉（从某条消息分支） | 🟡 | `Chat.forkConversation()` + 消息操作条「分支」按钮；回退 / 上下文压缩未做 |
| OW-12b | 确认改到消息流内（不遮挡输入框、可回看） | ✅ | 授权 / 提问的请求与结果各落一条事件（按 id 配对），卡片画在触发它的消息下方，答完收成一行记录 |
| OW-12c | 搜索 / 自动化 / 插件 / Skills 收到 Agent 侧栏 | ✅ | 「新建任务」下面四个入口，点开在 Agent 主区域内显示（带返回对话）；一级菜单移除「自动化」；搜索支持正文命中与片段 |
| OW-13 | 通知中心 | ✅ | `bun/notifications.ts` + 顶栏铃铛：后台授权请求、自动化结果、无人值守回合结束 |
| OW-16 | 审查 / 终端 / 浏览器页签（对齐 ZCode 侧栏） | ✅ | **审查**：工作区是 git 仓库时列 `git status` 改动 + numstat 增删行数，点开看 unified diff（`bun/workspace-changes.ts`，只走 argv 不经过 shell，路径限工作区内）；不是仓库时回落到「本会话 agent 改过的文件」（从工具事件里的 diff 汇总）。**终端**：`bun/terminal-sessions.ts` 起真实 PTY（`Bun.Terminal` + `zsh -l`），输出按 32ms 批量推送直通 xterm.js（`subscribeOutput` 不走 React 渲染），支持清屏 / 重开 / 跟随工作区，窗口关闭时统一收摊。**浏览器**：地址栏 + iframe，看本地产物页 / dev server，可转默认浏览器打开 |
| OW-15 | 消息流渲染（轨迹行 / 思考行 / 正文流式） | ✅ | 工具调用收成一行「图标 + 动作 + 参数 + diff 计数」（点开看命令原文 / diff / 输出，diff 结果按参数串缓存），思考是「思考 · 持续了 N 秒」可展开行，正文不再套气泡、产出文件在正文下挂卡片（点「打开」进右侧预览）；正文与思考按 40ms 批量流式下发（`bun/agent.ts`），会话重取不再覆盖流式中的正文（`stores/chat.ts` 的 `mergeServerMessages`），没有正文时不再留空白气泡 |
| OW-14 | 未做项（记录在案） | ❌ | 浏览器自动化、Computer Use、系统级通知、分屏、子智能体独立子会话、侧栏「辅助对话」 |

---

## M0b · Agent 能力对齐 Codex（编码智能体的工程实现）—— 🟡 仅剩 Windows 沙箱

15 项里 14 项已完成（含会话内 `/model`、快照仓库维护、`/compact` 与 `/status`）；CX-06 在 macOS 上三档齐全（Seatbelt）、
升级流程（被拦后按次申请）、**Linux 的 bubblewrap 后端**与 **Landlock 兜底后端**（策略纯函数 + C 辅助程序 + canary 探测 +
Linux 端到端 13 项）都做完了，只剩 **Windows 沙箱**（要 AppContainer / Job Object 原生方案 + Windows 环境验证）。
对照表见
[docs/codex-parity.md](./docs/codex-parity.md)（含每一条"为什么不做"的说明）。

对照 [openai/codex](https://github.com/openai/codex)：OpenWork 那一轮补的是产品形态，
这一轮补的是「在真实仓库里长时间干活」的工程细节。逐项对照与差异说明见
[docs/codex-parity.md](./docs/codex-parity.md)。

| # | 任务 | 状态 | 实际落地 |
|---|---|---|---|
| CX-01 | `apply_patch` 补丁工具（V4A 格式、多文件、原子落盘） | ✅ | `bun/apply-patch.ts`：Add / Update（含 `*** Move to:`）/ Delete；四级放宽定位（精确 → 忽略行尾空白 → 忽略首尾空白 → Unicode 标点归一化）；任何一处匹配失败**整体不落盘**；返回 `A/M/D` 摘要。权限按补丁里所有文件求值（工作区内 = `edit`，含区外 = `external_directory`）。16 个单测 + capabilities smoke + live-check 端到端 |
| CX-02 | 项目指令 AGENTS.md（逐级发现 + override + 上限） | ✅ | `bun/agent-instructions.ts`：向上找到含 `.git` 的项目根，按「根 → 工作区」拼接；`AGENTS.override.md` 同目录优先；用户级 `<数据目录>/AGENTS.md`；默认上限 8KB 且截断有说明；注入 `buildSystemPrompt`（在工作准则之后、记忆之前） |
| CX-03 | `/init`：生成 AGENTS.md | ✅ | 输入框斜杠命令（预置提示词：先摸清项目，已存在则补齐） |
| CX-04 | `view_image` 看图工具 | ✅ | 图片内容块交给模型（pi-ai 会转成工具结果后的 user 消息）；10MB 上限 + 扩展名白名单；**只在模型看起来支持视觉时注册**（`chatModelSupportsImages()`，`AGENT_VISION_TOOL` 可强制 auto / on / off），`buildModel().input` 同步 |
| CX-05 | Agent 能力设置页（装载了什么 / 当前模型能不能看图） | ✅ | 设置 → Agent 能力：项目指令开关 + 上限 + 实际装载的文件清单（来源 / 体积 / 截断提示）+ 看图工具模式与当前模型判定 |
| CX-06 | 沙箱模式（read-only / workspace-write / danger-full-access）+ 被拦后按次升级 | 🟡 | `bun/agent-sandbox.ts`：**macOS 上三档齐全** —— `off`（= `danger-full-access`）、`workspace-write`（写只允许工作区 / 临时目录 / 已授权目录）、`read-only`（工作区与用户目录一律不可写，只有临时目录例外：测试运行器 / 编译器要写 TMPDIR）；三档都拒凭据目录读取，联网可开关（默认放行）。**升级流程**（对齐 `sandbox_approval`）：命令因沙箱失败 → 问一次「是否跳过沙箱重试」→ 允许则只对这次去掉沙箱重跑（审计留痕）、拒绝则把原因交给模型；`smart`/`manual` 询问、`auto`/`strict` 默认拒绝（可加规则放行）。路径过滤器带 **realpath**（否则 `/var` → `/private/var` 的软链会让拦截整个失效）。默认关闭；**Linux：bwrap 优先 + Landlock 兜底**（`bwrapArgs()` 纯函数 + 能力探测 + 缺 bwrap 时降级并给安装命令）；**Landlock 兜底后端完整可用**：`landlockRuleset()` 按档位算允许路径集合（`/` 只给读、可写目录再叠写位）、`landlockRulesetSpec()` 出稳定 JSON，C 辅助程序 `src/bun/omni-landlock.c` 首用时按源码 hash 现编（要 cc，不塞预编译二进制）并只做"读规格 → 发 `landlock_*` 系统调用 → exec"，**canary 探测**挡住 FUSE / 网络盘上"规则整片落空"（不然用户看到的是每条命令都 Permission denied），`/dev/null` 等设备放行（否则 `2>/dev/null` 都失败），禁网时如实让位（net 规则没实现，不假装）。Linux 端到端 `scripts/landlock-e2e.ts`（走真实 `wrapShellCommand`）13 项全过，CI 有独立 `linux-sandbox` 作业跑它。剩一项外部阻塞：Windows 沙箱。真实 Seatbelt 端到端：两档 × 工作区/区外/临时目录/凭据读 + 升级的允许/拒绝/普通失败/无人值守四条路径，单测与 smoke 都跑过 |
| CX-07 | 回合快照与回退（编码智能体最实用的安全网） | ✅ | `bun/agent-snapshots.ts`：影子 git 仓库建在数据目录（`--git-dir` 指影子、`--work-tree` 指工作区，**不碰用户自己的 `.git`**），`node_modules` 等写进 `.git/info/exclude` 不进快照；`agent.ts` 每轮开跑前提交一次并绑定该轮助手消息；回退 = `add -A` + `read-tree --reset -u <快照>`（**不动 HEAD**，快照链保持完整，可再回退到更近的一轮）。界面在消息操作条上给「撤销本轮」：先预览（哪些还原、哪些会被删）再执行，结果留在弹窗里；设置页有开关与轮数。实测本仓库首次 611ms / 增量 42ms；无 git 时静默降级 |
| CX-08 | 回合内状态（上下文占用 / 剩余窗口） | ✅ | `bun/agent-context.ts`：会话内用**实测**（上一轮 `usage.prompt_tokens`），否则按消息估算；预算 = 窗口 60%（与压缩同一算法，所以"占用条满了"就是"要开始裁历史了"）。模型侧有只读工具 `get_context_remaining`（≥80% 时要求先 todo_write 记进度）；用户侧输入框上方有占用条（70% / 90% 变色，tooltip 写明来源）；RPC `getAgentContextUsage` |
| CX-09 | 命令归一化（`rm  -rf` 与 `rm -rf` 命中同一规则） | ✅ | `permissions.ts` 的 `canonicalCommand()`：按 shell 引号 / 转义切 token 再单空格拼回，规则求值时原文与归一化形式都试（只用于匹配、不用于执行）。修掉了「多一个空格就能绕过危险命令审批」的真实绕过；「本会话总是」也存归一化形式 |
| CX-10 | 外部通知回调（对齐 Codex 的 `notify`） | ✅ | `bun/agent-notify.ts` + 设置项 `AGENT_NOTIFY_COMMAND`：事件 JSON 作为最后一个参数（+ `OMNI_NOTIFY_PAYLOAD`）交给用户命令；触发点收在通知中心的 `notify()` 一处，四类事件（跑完 / 授权 / 自动化 / 出错）全覆盖；类型映射对齐 Codex（`agent-turn-complete` 等）；载荷走 `"$1"` 不做拼接，注入用例已钉住；命令失败只进统一日志。设置页「Agent 能力」可配 |
| CX-11 | 无头执行接口（`codex exec --json` 的对应物） | ✅ | `bun/agent-headless.ts` + `omi agent run <提示词>`：默认打印最终回答，`--json` 输出 **NDJSON**（`start` / `event` / `result`，`--chunks` 加正文增量），控制 socket 为这条命令开了流式响应；`--workspace` / `--mode` / `--conversation` / `--timeout` 可选，提示词也能从管道读。无人值守（不弹授权卡片，拦下的动作直接以理由回到模型），会话照常落库可继续追问。live-check 用桩服务端到端验过（含事件流三类行与 result 自带会话 id） |
| CX-15 | `/compact` 与 `/status`（对齐 Codex 的同名命令） | ✅ | `/compact` 手动收紧上下文：复用自动压缩的 `compactMessages` 与估算，**预算按自动的一半**（窗口 30% = "现在多留点余量"；否则没顶到线时按了没反应）；结果落 `compact` 轨迹事件并报"省略 N 条（X → Y）"，上下文本来就小时如实说无需裁剪。**只动上下文不动历史**（库里不删，重开会话重新装载，文档写明）。`/status` 用 `describeAgentSession()` 汇总模型 / 窗口 / 预算 / 占用 / 审批档位 / 沙箱档位 / 工作区 / 累计压缩量，数字全部现取（不另存一份状态），输入框上方弹面板。live-check 端到端验过（真实会话里裁掉一批、压缩后继续跑、库里历史完整、空会话不撒谎） |
| CX-14 | 快照仓库维护（占用可见 + 自动 / 手动 gc） | ✅ | `agent-snapshots.ts` 的 `snapshotRepoUsage()`（递归量 `.git`，20k 文件封顶）与 `maybeGcSnapshotRepo()`：占用超 `AGENT_SNAPSHOT_GC_MB`（默认 256MB）或轮数到 `AGENT_SNAPSHOT_GC_TURNS`（默认 200）时在提交后顺手 `git gc --prune=now`，10 分钟内只整理一次；设置页「Agent 能力」显示占用 + 「立即清理」，执行后如实显示"整理前 → 整理后"。历史不受影响（每轮快照都是 HEAD 的祖先，gc 只打包合并不删可达对象）—— 单测与 smoke 都断言"整理后仍可回退"；测试里特意写明**不能断言"整理后一定更小"**（小仓库的 pack 索引开销可能让总量反增） |
| CX-13 | 会话内换模型 `/model`（对齐 Codex 的同名命令） | ✅ | `shared/model-command.ts` 的候选清单纯函数（本地只列已启动实例、云端只列用户添加过的对话模型、当前模型排最前）+ 输入框补全面板选中即切；走的与右下角选择器**同一条 RPC** `selectChatModel`。关键在 Agent 侧：**会话缓存键算上当前模型**（`currentModelKey()` = 本地/云端 + 请求模型 id + 地址），否则换完这一轮还会发给旧模型；重建会话时历史由 `historyAsAgentMessages()` 从库里回填，等于"换引擎不换上下文"，并在轨迹里留一条「模型已切换：A → B」。live-check 端到端验过（同一会话第二轮请求的 model 字段真的换了、第一轮提示词仍在请求里） |
| CX-12 | 网络审批 / `request_permissions` / hooks / worktree / auto-review | ✅ | **`request_permissions`**：模型带理由申请工作区外路径，必须过授权闸门。**生命周期 hooks**（`bun/agent-hooks.ts` + `AGENT_HOOKS`）：`session_start` 输出进系统提示的「会话启动上下文」，`user_prompt_submit` 输出随本轮任务描述注入或 `{"decision":"block"}` 拦下这一轮（拦下时不发给模型、用户能看到原因）；事件 JSON 走 **stdin**（对齐 Codex），事件名 snake/Pascal 都认；失败 / 超时只记警告；上下文有 8KB/16KB 上限；**hooks 只来自设置，绝不执行工作区里的文件**。网络审批由沙箱联网开关以更粗粒度覆盖；worktree / auto-review 明确不做并写明理由（parity §2 #19 / #21）；工具级 PreToolUse / PostToolUse 不做（权限规则表已覆盖，理由见 parity §4） |

---

## M0c · Agent 能力对照 oh-my-pi（上下文生命周期 / 编排 / 提示词纪律）—— 🟡 三轮后主体已落地（剩命名 Agent 定义 / 注册表 / 并行 reviewer 三项，及一批判断后不做）

关键事实：**我们和 oh-my-pi 用的是同一个内核的两个分支** —— 都源自 Mario Zechner 的 pi-mono
（我们是 `@earendil-works/pi-agent-core@0.85.1`，它是 `@oh-my-pi/pi-agent-core@18.1.20`）。
所以这一轮的重点不是"移植"，而是**把我们已经装着的内核用满**：内核里本来就有
「模型摘要式压缩 + 切点 + 增量摘要」「SKills 加载器」「`afterToolCall` / `prepareNextTurnWithContext`
/ `maxRetryDelayMs` / `sessionId`」这些能力，我们一个都没用。

对照表与"该抄什么 / 明确不抄什么"见 [docs/omp-parity.md](./docs/omp-parity.md)。

| # | 任务 | 状态 | 实际落地 |
|---|---|---|---|
| OMP-01 | 系统提示不再被时间戳撞掉本地推理的前缀缓存 | ✅ | `currentTimeLine()` 从 `buildSystemPrompt()` 移出，改挂本轮用户消息（`withAttachments()` 新增 `clock` 参数）；每轮刷新系统提示**先比较再写回**；`Agent` 传 `sessionId`。原先"分钟一翻就整段重算 prefill"变成"只在 AGENTS.md / 记忆真变了时才失效" |
| OMP-02 | 重复读取去重（对齐 supersede pruning，零模型调用） | ✅ | `pruneSupersededReads()` 挂在 `transformContext` 里、排在确定性裁剪之前：同一路径更早的读取结果换成占位，消息条数 / 顺序 / 工具配对都不动；只有**更新的那次是整份读取**才敢省，省得不足 200 tokens 不动手；只收 `read_file` / `list_dir`，`grep` / `glob` 参数不同互不取代 |
| OMP-03 | 修掉空转的 400 保护 | ✅ | `compactMessages()` 的尾部守卫写成 `role === "tool"`，但 `transformContext` 收到的是 AgentMessage，工具结果在那里叫 **`toolResult`** —— 这道保护从来没生效过（旧单测用假数据把同一个误解固化了）。现在两个角色名都认，并补了回归测试 |
| OMP-04 | 截断提示带"下一步怎么办" | ✅ | `truncate()` 不再只给 `…(truncated, N more chars)`：写明被截断、还剩多少、**不要**当成完整内容、三种收窄办法（offset/limit 分页 / grep 定位 / head-tail 管道） |
| OMP-05 | 陈旧工具名与过时文档 | ✅ | `UNGATED_TOOLS` / `READ_ONLY_TOOLS` 去掉四个不存在的名字（`memory_recall` / `todo_read` / `update_plan` / `media_list`）；`codex-parity.md` 第 10 条同步（`/compact` 早已落地，只剩模型摘要式压缩没做） |
| OMP-06 | 模型摘要式压缩（切点 + 一次性摘要 + 确定性裁剪兜底） | ✅ | `bun/agent-summary.ts`（纯逻辑 + 单次模型调用）+ `makeContextTransform()`：请求前 **去重 → 摘要 → 裁剪** 三步，后一步兜住前一步的失败。切点用纯函数保证只切在**一轮的起点**上（切不干净会 400）；摘要是**五段式**（目标 / 已完成 / 关键结论与决策 / 涉及的文件 / 未解决·下一步），**增量续写**上一版；**摘要提示里带上按待压缩内容召回的记忆**（不喂的话压缩后上下文就断片）；记账挂在会话上（正文 + 覆盖到第几条），换模型 / 手动 `/compact` 时作废。摘要失败 / 超时 / 返回空一律退回确定性裁剪并记轨迹。**子智能体也走同一套**。开关 `AGENT_COMPACT_MODE`（`summary` 默认 / `trim`） |
| OMP-07 | 历史回填带上工具调用与结果 | ✅ | `bun/agent-history.ts`：从 `agent_events` 取 `tool_start`/`tool_end` 按消息配对，还原成「调用 → 结果 → 正文」。同名工具并行按**后进先出**配对（与时间线同一规则）；**每个 toolCall 必有 toolResult**（缺了会 400，没配上的合成"回合被中断"）；输出截断到 2000 字符并注明可重新执行；**子智能体内部事件不回填**；回填消息带 0 用量（不让占用条当成实测值）。此前换模型 / 重开会话后模型不记得做过什么，会把同一批文件再读一遍 |
| OMP-08 | Skills 接入 Agent（**修缺陷**：UI 文案已承诺"按需加载"，代码没做） | ✅ | `bun/agent-skills.ts` + 工具 `read_skill`：系统提示只列 `名字: 描述`（≤24 条、描述截 160 字、超出提示剩余数）+「匹配到先读 SKILL.md」；正文与技能目录里的脚本 / 模板按需取（返回带技能目录绝对路径）。路径过 `centralSkillDir()` + `safeJoin()` + 软链越界二次校验，只读文本后缀，设置层没起来时返回可读原因而非抛异常。开关 `AGENT_SKILLS_PROMPT` |
| OMP-09 | 子智能体升级（命名 Agent 定义 / 类型化结果 / 只读批量扇出） | 🟡 | ✅ 新增 **`review` 类型**：审当前工作区**未提交的改动**，diff 由主进程现取（不让模型描述"改了哪些文件"——它经常记不全），提示里写死三条反"泛泛而谈"的规矩（只报这次引入的 / 每条要说清触发条件 / 分 P0-P2 不全给最高级）；取不到 diff 会如实说明而不是编问题。❌ 批量 fan-out **判断后不做**：子智能体跑的是同一个本地模型，单卡上并发只会互相排队，省不下总时间，而弱模型写 `tasks[]` 出错的代价是"三个子智能体各跑十几步"；等有多卡 / 云端参与编排再评估 |
| OMP-10 | `think` 草稿纸工具 + 错误信息带恢复指令 | ✅ | `think`：我们默认 `reasoning: false`（没有原生推理通道），给它一个把推理写进去、只回 `------` 的地方，正文不混"想出声"的过程。工具提示：找不到文件给"怎么找"（list_dir / glob 按名片段）、编辑匹配不上给"内容变了先读回来"（`EDIT_MISMATCH_HINT`）、grep 空结果给三种换姿势并说明"没搜到 ≠ 不存在"（`NO_MATCH_HINT`）——**折叠在工具结果里**，等价于 OMP 的 TTSR 非打断半边，因此不必再引入正则规则系统 |
| OMP-11 | 提示词纪律（委派倾向改向 / 验证阶梯 / 交付契约）+ 记忆写入引导 | ✅ | 委派准则从"要大范围搜索就派子智能体"（OMP 的 `eager` 档，对弱模型是**反向激励**）改成 `restrained`：先自己摸底、只有两个以上互不依赖的调研才值得派、派了别管着。新增**验证阶梯**（改代码/改文档/生成媒体/修 bug 各一种验证方式，没法验证要明说）。新增**交付要求**（不虚构 / 不偷偷缩范围 / 不治症状）。记忆：只在 `MEMORY_ENABLED` 且非 plan 时教它"什么值得记"（补的是根因——弱模型不写记忆是没人告诉它写什么） |
| OMP-12 | 探索打点 / 收网（checkpoint · rewind） | ✅ | `bun/agent-checkpoint.ts` + 两个工具：打点记**消息条数**，收网用模型自己写的结论**整段替换**中间过程（不走摘要 → 零漂移）。难点在"切得对不对"，抽成纯函数 `applyRewind()` 单测（切错会吞掉打点前的任务描述、或吞掉**收网之后**的新内容）。因为 `rewind` 在工具里执行、改 `state.messages` 指不到运行中的循环，所以走 `transformContext` 生效；打点没关就每轮追加一条 `<system-reminder>`（内核没有 yield 钩子，这是"未 rewind 不许交差"的等价实现）；`revert_files` 可选还原工作区（用本轮快照），默认不还原；plan 模式不注入（与只读冲突） |
| OMP-13 | **Goal 模式补成真**：目标持久化 + 自动续跑 + 账本 + 完成审计 | ✅ | `bun/agent-goals.ts` + `agent_goals` 表 + `goal` 工具。目标与验收标准落库并每轮注入系统提示（含完成标准四条：验证范围 = 声明范围 / 不确定 = 没达成 / **预算耗尽 ≠ 完成**）；回合正常结束后目标仍 active 就**自己再开一轮**（这是与 Agent 模式的唯一实质差别，续跑消息写明「系统自动继续」，不藏成隐式注入）；账本只计 input+output（**不算 cacheRead**）；三道刹车：token 预算 / 续跑轮数上限（默认 6，设 0 = 关掉）/ 用户按停止→转 paused（不会松手后又自己跑起来，用户再发话才恢复）；complete 必须带证据、abandon 必须说明卡点。界面：输入框上方目标面板（状态 / 验收标准 / 用量余量 / 暂停·继续·放弃） |
| OMP-14 | **Plan 模式补成真**：方案落盘 + 批准 + 执行交接 | ✅ | `bun/agent-plans.ts` + `agent_plans` 表 + `write_plan` 工具（Plan 模式**唯一**能写的东西：写到数据目录 `plans/<会话>.md`，工作区一行不碰，同时登记成产出物可在右侧预览）。「批准并执行」→ 切 Agent 模式 + 方案正文作为执行轮任务描述立刻开工；**方案改过后批准自动作废**（不能批准 A 执行 B，有单测钉住）；批准过的方案进**子智能体开场上下文**（对齐 OMP 的 plan handoff）。提示词要求方案里每个路径都是本次会话真读过的 |
| OMP-15 | 逐条判断后不做的项（附理由与"什么条件下值得回头做"） | ➖ | **advisor 提议模型**（每轮再跑一个模型：本地部署下是双份显存/等待，收益未验证；替代方案是 `review` 类型的**按需复审**）；~~goal 预算账本~~（**判断已更正 → 已实现**，见 OMP-13：它是"允许它自己跑"的前提，不是装饰）；**`todo` 改单操作**（我们整表替换对弱模型更稳：无服务端 id、一回合改完；漏写的风险由常驻面板兜住）；**渐进披露 / 工具按需挂载**（实测 26 个工具描述 ~1562 tokens ≈ 窗口 25–30%，动机真实，但按需挂载要求弱模型自己想起来申请工具 —— 把"能不能用"押在模型聪明上，比省下的 1000 tokens 更贵）；**缓存感知剪枝完整版**（每次摘要本来就会改写前缀，收益小且难验证）；**预压缩**（要后台任务 + 失效 + 取消，先观察摘要真实耗时）；**内部 URL 子集**（工具数还没到记不住的规模）；**soft tool requirement / 工具并发语义**（内核这版没暴露，属于升级依赖的事）；**hashline**（需自研几千行补丁语言，主要风险已被 apply_patch + edit_file 覆盖）；**每 N 轮自动抽取记忆**（额外推理，该由用户显式选择）；**working→episodic 分层**（现有 importance/pinned/supersede 够用）；**managed skills**（模型写技能库是新的信任边界，需要复核流程） |
| OMP-16 | **瞬时失败自愈**：传输层重试 + 整轮失败重发 + 空回合提醒 | ✅ | 新增 `bun/agent-retry.ts`（判据 / 文案 / 退避，纯逻辑）+ `agent-retry.loop.test.ts`（假模型流钉住内核契约）。**传输层**：`maxRetries`（默认 2）与 `maxRetryDelayMs` 30s 传给 pi-ai 的 `retryProviderRequest` —— 之前**一处都没配**，而它的默认值是 0，所以一次瞬时 503 就整轮报废；**回合层**：整轮以 `stopReason=error` 收尾且 `isRetryableAssistantError`（按厂商错误文本分类，**排除配额 / 计费** —— 那属于该换模型）判为可恢复 → 摘掉空壳助手消息 + `agent.continue()`，退避 800ms→8s；**空回合**：`shouldStopAfterTurn` 返回 false + `agent.followUp()` 注入标注为 harness 的提醒（最多 2 次）。一个开关 `AGENT_RETRY_MAX`（默认 2，0 = 全关）；停止按钮在退避期间也生效（`stopRequests` 标记）；子智能体同样装。端到端证据是"桩服务真的收到过 503 又收到了同一个请求"（live-check 9 项） |
| OMP-17 | **工具输出转存**：超限不再"截断即丢失" | ✅ | 新增 `bun/agent-spill.ts` + 内核 `afterToolCall` 统一处理（一处生效，MCP / 媒体 / 新增工具自动享受；且早于 `tool_execution_end`，事件流与 `agent_events` 里落的也是截断后的文本）。超限输出先落盘到数据目录 `tool-output/<会话>/…`（按会话保留最近 40 个、删会话时清），截断提示带**绝对路径**与"用 read_file 分页读回来"。落地时发现转存目录被**两道**关卡挡着（凭据黑名单 + 工作区外读取授权），只放开一道会变成"每读一次弹一次窗"，现在按 `isSpillPath()` 同时开窄口子（只有这一个子目录，数据目录其余部分照旧拦死）—— live-check 断言"能读回第 2 万行"与"同级的 omni-studio.db 仍读不到" |
| OMP-18 | 多层 AGENTS.md 段落去重（monorepo 不再重复灌） | ✅ | `agent-instructions.ts` 的 `dedupeInstructionSections()` + `splitInstructionBlocks()`（代码围栏内不切段）：只在**更具体的那一层**删，**标题跟着正文一起走**（否则留下一个空标题比不删更误导），删掉的位置留一行说明；顺序改成**先去重再截断**（省下的字节留给本层内容）；顺手修掉截断切出半个多字节字符（U+FFFD）。单测 +8 项 |
| OMP-20 | **复杂任务端到端**：让自愈 / 转存 / 压缩 / 子智能体在**同一条任务里同时发生** | ✅ | 新增 `scripts/agent-resilience-smoke.ts`（进 `test:smoke`，桩服务、确定性、1.6 秒）：一条任务串起 传输层 503 → 大输出转存 → 回合中途流被掐断 → 空回合 → 照着提示读回原文 → 子智能体（也遇空回合）→ 写报告 → 4 次压缩，26 项检查钉住四条单点场景看不见的性质：重发不重复副作用也不重开一轮、失败那轮的半截正文被收回、harness 消息不落库（历史仍 1 问 1 答）、转存提示可执行。**抓出两个真缺陷**：① 建会话时把本轮提问重复回填了一遍（`agent-history.ts` 的 `dropCurrentPrompt()` 修掉：首轮 / 换模型后第一轮模型会看到同一段任务两遍，且时间提醒 / 召回记忆 / hook 上下文整段翻倍）；② 压缩后的请求是否仍符合线上协议此前从没被检查过 —— 桩服务现在对每个请求做协议校验（孤儿工具结果 / 未结算调用 = 直接 400），校验器有自检、并用变异实验（去掉 `compactMessages` 的尾部保护）确认能抓到。顺带记下教训：**桩服务的进度不能从请求里数**（压缩会让计数倒退，长流程撞步数上限） |
| OMP-19 | 第三轮的三个"看着该做、细看不必做" | ➖ | **压缩防抖动回收带**：OMP 需要它是因为它的压缩会被阈值反复触发；我们的摘要只覆盖**新增段**（`cut > covered` 才调用），"每轮重摘一遍"在结构上不会发生；**模型回退链**：自动回退 = 自动把工作区内容发给云端，这是**隐私决定**，必须由用户显式切模型；**工具死循环自动改道**：连续 3 次重复调用会弹授权卡片，用户看得见、能拒绝、能插话，再叠一层自动禁用只是把判断藏起来 |

明确不抄（附理由，见 parity §4 末表）：Rust 原生层（pi-natives / pi-shell / pi-ast）、
snapcompact（历史栅格化成图）、`xd://` 工具设备、协作中继、LSP / DAP、浏览器与桌面自动化、
60+ 厂商路由、mnemopi 全量、worktree 隔离后端矩阵。

---

当前完成度概览（截至 0.0.7-canary.0）：

- ✅ **已落地**：仪表盘、网络/服务配置、模型市集 + 下载器（含任务持久化与断点续传）、模型分类、多 App 结构 + 多模态聊天、集成 Launcher（`omi launch`）、基准测试（吞吐）、日志查看器（基础）、更新通道 / i18n、语音工作台（TTS / ASR / 克隆 / 实时通话）、**图片生图闭环**、**视频生成**、**OCR 三引擎 + 文档管线**、**知识库（本地 RAG）**、**共享记忆**、**MCP 客户端 + 服务端**、**Skills 管理**、云端厂商多配置、**Agent 能力面对齐 OpenWork**（授权 / 待办 / 反问 / 子智能体 / 产出物面板 / 会话侧栏 / 自动化，见 M0）、**Agent 工程能力对齐 Codex**（apply_patch 补丁 / AGENTS.md 项目指令 / 看图工具 / 命令归一化 / 回合快照与回退 / 上下文占用可见 / 命令沙箱 / 外部通知回调 / 生命周期 hooks / 主动申请权限 / `omi agent run` 无头执行 / 会话内 `/model` 换模型 / 快照仓库维护 / `/compact` 与 `/status`，见 M0b）、**Agent 能力面对齐 oh-my-pi**（系统提示去抖动 / 摘要式压缩 + 记忆拼接 / 重复读取去重 / 探索打点收网 / Skills 按需读取 / Goal 与 Plan 两个模式做实 / **瞬时失败自愈（重试 + 空回合提醒）/ 工具输出转存 / 多层 AGENTS.md 段落去重**，见 M0c）。
- 🟡 **部分完成**：vLLM / SGLang 运行时（参数组装 + 二进制探测 + 安装提示已实现，**仍缺一键安装与实测验证**）、引擎状态 UI（有启停与运行状态，缺版本 / 路径 / 健康度）、性能与内存生命周期、平台支持（配置与发布流程已覆盖 Linux / Windows 构建，未做端到端验证）、Agent 沙箱（M0b 的 CX-06：macOS 三档 + Linux 的 bubblewrap / Landlock 双后端已落地并有端到端，剩 Windows 后端一项）。
- ❌ **未启动**：外观（托盘 / Dock 指标）、安全（API Key 加密存储 / 日志脱敏）。

---

## M1 · 生图闭环 —— ✅ 已完成

早期这里是最大的功能缺口（`app/` 下没有 `image-screen.tsx`，Image 入口悬空）。0.0.6 已闭环，落地形态与最初的规划有出入，记录如下：

| # | 任务 | 状态 | 实际落地 |
|---|---|---|---|
| IMG-01 | 图片 App 专属界面 | ✅ | `mainview/app/image-screen.tsx`：参数面板 + 结果区 + 历史列表，统一工作台布局 |
| IMG-02 | 生图后端与任务队列 | ✅ | `bun/image-gen.ts` 三后端统一入口 + `image_records` 表落库（未复用 `queue.ts`，各后端自成流程） |
| IMG-03 | 本地生图引擎接入 | ✅ | 实际接的是 **MLX（mflux）** 与 **ComfyUI**，不是规划里的 diffusers；MLX 权重生成前必须已下载 |
| IMG-04 | 远程生图端点 | ✅ | OpenAI 兼容 `/v1/images/generations`；带参考图走 `/v1/images/edits` multipart |
| IMG-05 | 生图参数 UI | ✅ | 提示词 / 负向提示词 / 尺寸 / 步数 / 种子等，按后端能力暴露 |
| IMG-06 | 生成历史库 | ✅ | `image_records` 表 + `images/gen/` 落盘，内置查看 / 删除 / 保存 |
| IMG-07 | 模型就绪校验 | ✅ | MLX 权重校验按 mflux 自身清单逐文件核对大小（只看 snapshot 有无文件会漏掉下到一半的权重） |

顺带落地（原规划外）：**视频生成**（MiniMax / Seedance / ComfyUI 三后端、「提交 + 轮询」异步模式、`video_records` 表）与 **常驻 Python worker 协议**（模型加载一次反复生成、空闲自动卸载）。

## M2 · 本地推理引擎交付（P0）—— vLLM / SGLang 从"🟡"到可交付

`runtimes/vllm.ts` 与 `runtimes/sglang.ts` 参数组装已实现，并已接入统一的 `Runtime` 抽象与 `shared/engines.ts` 注册表；**仍缺一键安装与真实环境实测**。

| # | 任务 | 状态 | 说明 |
|---|---|---|---|
| LIE-01 | 引擎环境检测 | 🟡 | `Runtime.checkBinary()` 已实现（含 `BinaryCheckResult`），缺失时给出 `shared/engines.ts` 的 `installHint` 文本；未做 Python 环境探测 |
| LIE-02 | 引擎一键安装 | ❌ | 目前只有提示文本（`pip install vllm`）。对比：whisper.cpp / PaddleOCR / mflux / Tesseract 都已有一键安装 |
| LIE-03 | vLLM 运行时实测 | ❌ | 参数组装与真实 vLLM 行为对齐、修复差异 |
| LIE-04 | SGLang 运行时实测 | ❌ | 同上 |
| LIE-05 | 引擎启动诊断 | 🟡 | `extractStartupError` 已能从实时日志挖出可读错误；缺分类型诊断（缺依赖 / 显存不足 / 端口占用 / 格式不符） |
| LIE-06 | 引擎状态 UI | 🟡 | `app/local-models-screen.tsx` 有引擎选择 + 启动参数（含重试与并发）+ 启停 + 运行状态；缺版本、路径与健康度 |

## M3 · 性能与生命周期（P1）

| # | 任务 | 状态 | 说明 |
|---|---|---|---|
| PERF-01 | 空闲超时自动卸载 | 🟡 | MLX 生图 worker 已实现（`IMG_MLX_IDLE_MINUTES`，默认 10 分钟，0 = 关闭）；**推理服务器本身仍未做** |
| PERF-02 | 预填充内存防护与防护层级 | ❌ | 验证 llama.cpp `--mlock` 等能力后设计 |
| PERF-03 | 模型回退路由 | ❌ | 默认模型启动失败时回退到备选模型 |
| PERF-04 | KV 缓存热/冷分层与 SSD 溢出 | ❌ | 缓存分层 + SSD 溢出目录，先做能力验证 |
| PERF-05 | 分块预填充 / 预填充优先级 | ❌ | 按引擎支持情况接入设置 |

## M4 · 运维增强（P1）—— 日志 / 基准 / 统计补齐

| # | 任务 | 状态 | 说明 |
|---|---|---|---|
| OPS-01 | 日志查看器：多文件切换 | ❌ | 现为单流视图（`main-layout/server-logs.tsx`，197 行：自动滚动 / 复制 / 清空 / 行数）；server.log 未按天或大小分片 |
| OPS-02 | 日志查看器：最近 N 条筛选 | ❌ | 显式条数筛选 |
| OPS-03 | 基准测试：batch × ctx 扫描矩阵 | ❌ | 当前一趟固定 batch，改矩阵扫描 |
| OPS-04 | 基准测试：准确度 / 质量基准 | ❌ | 除吞吐外的质量维度 |
| OPS-05 | 服务统计：逐模型显存 / VRAM | ❌ | `/slots` 已能拿实际加载模型，但仅 llama-server 支持；其他引擎靠"最近使用即视作 loaded"兜底 |
| OPS-06 | 服务统计：GPU 温度与显存锁定量 | ❌ | |

## M5 · 工程与平台（P1 / P2）

| # | 任务 | 状态 | 说明 | 优先级 |
|---|---|---|---|---|
| ENG-01 | 下载任务持久化 | ✅ | `download-manager.ts`：任务写进 settings `MODEL_DOWNLOADS`，重启后按 `.part` 分片续传 | P1 |
| ENG-02 | `omi launch <tool>` 子命令 | ✅ | 原规划里的 `vllm-studio launch`；现名 `omi launch`，支持 claude / codex / opencode / openclaw / hermes / pi | P1 |
| ENG-03 | 网络页：Anthropic / Claude Code 端点单独展示 | ❌ | 现在并入集成页 | P2 |
| ENG-04 | TopK / repeat penalty 设为 UI 参数 | ❌ | 目前 repeat penalty 取自模型 profile 的 serverArgs | P2 |
| ENG-05 | 模型库扩展目录选择器 | ❌ | `MODEL_DIRS` 现为手输文本，改目录选择 | P2 |
| ENG-06 | Linux 平台支持 | 🟡 | 构建配置与发布流程已覆盖，未做端到端验证 | P2 |
| ENG-07 | Windows 平台支持 | 🟡 | 同上 | P2 |

## M6 · 远期（P2）

| # | 任务 | 状态 | 说明 |
|---|---|---|---|
| FUT-01 | 菜单栏 / Dock 托盘指标 | ❌ | 先评估 Electrobun 系统托盘 / 菜单栏 API 支持度 |
| FUT-02 | API Key 加密存储 | ❌ | macOS Keychain / 系统凭据，远端 Key 不回显（当前明文存 SQLite） |
| FUT-03 | 日志脱敏 | ❌ | 打印前脱敏 |
| FUT-04 | 本地引擎音频能力评估 | 🟡 | TTS 与 ASR 均已接入本地引擎（audio.cpp / whisper.cpp），本条实质已达成；保留用于评估更多本地音频能力 |

---

## 迭代节奏建议

- **M2 是当前最大的交付缺口**：vLLM / SGLang 的一键安装 + 实测（LIE-02/03/04）直接决定"三引擎统一运行时"能不能算兑现；其余引擎（whisper.cpp / PaddleOCR / mflux）的一键安装已有成熟模式可复用。
- **M3 的 PERF-01 有现成参照**：MLX 生图 worker 的空闲卸载逻辑可以照搬到 `server-manager` 层。
- 每个里程碑结束跑一次回归：`cd apps/studio && bun run build:dev` + 手工过 P0 路径（聊天 → 生图 → OCR → 语音）。
- 提交前跑：`bun run lint && bun run typecheck && bun run test && bun run --cwd apps/studio test:smoke`（与 CI 一致）。
