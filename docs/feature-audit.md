# OmniStudio 功能菜单梳理与优化台账

> 本文档把 OmniStudio 的**每一个菜单**拆成功能点逐项列出，再从架构层面点评、逐个优化，并记录改动。
> 与本文档的分工：[architecture.md](./architecture.md) 讲「东西在哪、为什么这么切」，
> [ROADMAP.md](../ROADMAP.md) 讲「里程碑与未完成任务」，本文档讲「每个菜单有哪些功能、做过哪些整理」。
>
> 处理顺序：**一个菜单完整优化完，才进入下一个**。进度见 §2 的「状态」列。
>
> **增量说明（2026-09-15）**：此后新增了一级菜单 **音乐（`music`，`app/music/index.tsx`，
> 侧栏创作记录 `app/music/record-list.tsx`，主进程 `bun/music-gen.ts`）**，排在视频之后。
> 下表保留审计当时（13 个）的编号与结论，新菜单尚未走本文档的梳理流程。

---

## 1. 一级菜单总览

一级应用（App Rail，`stores/app.ts` 的 `AppId`），共 13 个，外加设置与几个非一级菜单的屏：

| # | 菜单 | AppId | 主屏文件 | 侧栏 |
|---|---|---|---|---|
| 1 | 对话 | `chat` | `app/chat/index.tsx` | 会话列表（`app-sidebar.tsx` ConversationRecordList） |
| 2 | Agent | `agent` | `app/agent/index.tsx` | 会话侧栏（`app/agent/session-sidebar.tsx`） |
| 3 | 通话 | `voicecall` | `app/voice-call-screen.tsx` | 通话记录 |
| 4 | 语音 | `voice` | `app/voice/index.tsx` | 语音记录 + 工具切换 |
| 5 | 图像 | `image` | `app/image/index.tsx` | 生图历史 |
| 6 | 视频 | `video` | `app/video/index.tsx` | 视频历史 |
| 7 | OCR | `ocr` | `app/ocr/index.tsx` | 文档记录 + 工具切换 |
| 8 | 翻译 | `translate` | `app/translate/index.tsx` | 翻译记录 + 工具切换 |
| 9 | 提示词 | `prompt` | `app/prompt/index.tsx` | 分类（`PromptSidebar`） |
| 10 | Skills | `skills` | `app/skills/index.tsx` | 六区导航（`skills/sidebar.tsx`） |
| 11 | 知识库 | `kb` | `app/kb/index.tsx` | KB 列表（`kb/sidebar.tsx`） |
| 12 | 记忆 | `memory` | `app/memory/index.tsx` | 分类（`MemorySidebar`，`memory/sidebar.tsx`） |
| 13 | 基准测试 | `benchmark` | `app/benchmark/index.tsx` | 基准记录（`BenchmarkRecordList`，仍在 `app-sidebar.tsx`） |

非一级菜单但属于「功能菜单」的屏（走设置内的分页 / 路由）：

- 设置（19 个分页）：`dashboard`(stats) / `network` / `defaults` / `model` / `store` / `market` / `gateway` / `integrations` / `websearch` / `mcp` / `permissions` / `agentcaps` / `cli` / `usage` / `logs`(console) / `backup` / `general` / `appearance` / `about`
- 覆盖整屏的路由：`models`（集成模型库 `models-screen.tsx`）、`model-detail`（`app/model-detail/index.tsx`）、`document`（`main-layout/document-view.tsx`）
- 全屏工作台：`live-translate`（`app/live-translate/index.tsx`）、`automations`（`app/automations/index.tsx`，从 Agent 侧栏进入），模型相关还有 `app/local-models/index.tsx`（设置 → 模型）

---

## 2. 逐菜单：功能清单 + 架构点评 + 优化记录

状态图例：⬜ 未处理 / 🔄 进行中 / ✅ 已完成

| # | 菜单 | 状态 |
|---|---|---|
| 1 | 对话 | ✅ |
| 2 | Agent | ✅ |
| 3 | 通话 | ✅ |
| 4 | 语音 | ✅ |
| 5 | 图像 | ✅ |
| 6 | 视频 | ✅ |
| 7 | OCR | ✅ |
| 8 | 翻译 | ✅ |
| 9 | 提示词 | ✅ |
| 10 | Skills | ✅ |
| 11 | 知识库 | ✅ |
| 12 | 记忆 | ✅ |
| 13 | 基准测试 | ✅ |
| 14 | 设置（19 分页） | ✅ |
| 15 | 覆盖屏（模型库 / 详情 / 文档 / 实时翻译 / 自动化） | ✅ |

---

## 3. 跨菜单架构问题（共性）

以下是逐菜单处理时会反复遇到的共性问题，先在此集中记录，处理到对应菜单时逐条消除。

1. **媒体结果 UI 三处复制**：`ResultError` 在 `voice-screen` / `image-screen` / `video-screen` 各写一份（完全相同的 8 行）；`RecentStrip` 在 image / video 各一份；`ResultEmpty` / `ResultPanel` 只在语音有，但结构可复用。→ 抽 `components/media-result.tsx`。**已建 `components/media-result.tsx`（`ResultError` / `ResultEmpty`）并在语音页、图像页、视频页接入。**
2. **模型行组件三处相似**：`voice-screen` 里 `LocalModelRow` / `AsrModelRow` / `AsrAudioCppModelRow` 结构雷同。→ 收敛为一个 `ModelListRow`。
3. **`rpc/index.ts` 巨型单文件**（同时承载契约与 handler，5000+ 行）。→ 契约类型抽到 `shared/rpc-contract.ts`（长期）。
4. **错误约定不统一**：多数 handler 返回 `{ ok, error }` 判别式，少数直接 throw。前端调用点需同时处理两种。→ 遇到时统一，不专门重写。
5. **侧栏列表组件都堆在 `app-sidebar.tsx`（1400+ 行）**。→ 各应用列表拆到各自目录（`app/chat/sidebar.tsx` 等），长期。已知：`BenchmarkRecordList` 仍在此文件。
6. **分段切换控件多处重复**：逐字相同的 detached 版曾在 `ocr/parts.tsx` / `skills/parts.tsx` 各一份（已抽 `components/segmented-control.tsx`，两处均改为再导出）。**已收口 attached 版**：`SegmentedControl` 新增 `variant="attached"`（`flex overflow-hidden rounded-lg border`），按「是否带图标」自动选 `px-2 gap-1.5` / `px-3`，benchmark×2 / live-translate / translate / voicecall / image / video / voice asr / voice tts 共 9 处全部改为调用，外观逐字保持不变；新增 `segmented-control.test.tsx` 锁住两个变体的类串。
7. **字节格式化多份实现且语义不一**：已将**十进制（1000 进位）**口径收敛为 `lib/format.ts:formatBytes(bytes, { zero, gbDecimals, mbDecimals })`，model-detail / market / models / local-models / voice / skills / dashboard / download-view 八处改为调用（差异用参数吸收，显示值与原来逐字一致），新增 `format.test.ts` 锁住默认值与覆盖值。IEC（1024 进位）的 `lib/format.ts:formatSize` 与 kb / image / ocr / setup 各自保留（语义不同，合并会改显示值），见债 #14。
8. **复制按钮三份实现**：OCR / 翻译 / 提示词各写一份（已抽 `components/copy-button.tsx`，三处均已接入；顺带修了 webview 里 `navigator.clipboard` 不可用时另两份会抛的问题）。后又支持 `iconOnly` + `title` + `className`，并接入设置 → 集成的 Agent 启动命令、设置 → 命令行的 `CopyLine` / `SnippetCard`。剩余：`cloud-provider-panel` 密钥行内联的裸 `<button>`（与显示/隐藏眼睛成对）、`document-view` / `dashboard` / `gateway` / `local-models` / `voice-asr-result` 等处的复制（各自菜单处理）。
9. **筛选 chip 样式两份**：提示词广场与 Skills 各一份（已抽 `components/filter-chip.ts:chipClass`，两处均接入）。
10. **「muted」分段切换另一变体三处**：`kb/index.tsx`（标签栏）/ `prompt/edit-dialog.tsx`（类型切换）/ `app-sidebar.tsx:1304`（视图切换），样式为 `bg-muted p-0.5` + 选中 `bg-background shadow-sm`，与 `SegmentedControl`（border + primary）不同。待各自菜单处理时再决定是否并入 `SegmentedControl` 的 variant。
11. **应用页反向依赖 `main-layout` 内部件**：`memory-screen.tsx` 从 `./main-layout/memory-tab` 引卡片、从 `./main-layout/setting-ui` 引排版件；`usage-screen.tsx` 同样引 `setting-ui`。应用目录依赖布局目录属于层次倒置。→ 已把通用的 `setting-ui` 上移到 `components/setting-ui.tsx`（10 处导入同步改 `@components/setting-ui`），记忆卡片迁入 `app/memory/`（见 §15）。
12. **统计小卡（StatCard）至少四份**：**已收口**到 `components/stat-card.tsx`，用 `variant`（row / rowCompact / stack / stackCompact）固化记忆概览 / 知识库详情 / 概览页 / 知识库治理四种外观，类串逐字保留；概览页与治理页保留同名薄包装。新增 `stat-card.test.tsx` 锁住四个变体。
13. **设置分页全部躺在 `app/main-layout/`**：`settings.tsx` + 九个 `*-tab.tsx`（含 1082 行的 `backup-tab.tsx`）+ `cloud-provider-panel` / `default-models-panel` / `console-screen` / `document-view`。它们既不是布局也不是侧栏，理想结构是独立的 `app/settings/` 目录。移动面广（导入路径 + 测试），曾经保守地未动；本轮已将栏目内的集成页拆为 `integrations-tab.tsx`。
14. **模型相关的屏未归组**：`app/models-screen.tsx`（模型库）、`app/market-screen.tsx`（在线市场）、`app/local-models/`（本地模型）、`app/model-detail/`（详情）分散在 `app/` 根/各自目录，命名不统一且共享 `formatBytes` / `MODEL_*` 等。理想结构是 `app/models/{index,market,local,detail}`。需重命名 + 改多处导入 + 测试，本轮任务额度内未做；`formatBytes` 已统一到 `@lib/format`（见债 #7），不再有两份重复。

---

## 4. 菜单 1 · 对话（chat）

### 4.1 功能清单

| # | 功能 | 实现位置 | 备注 |
|---|---|---|---|
| C-01 | 新建会话 | 侧栏 `createConversation` | |
| C-02 | 会话列表 / 选择 / 删除 / 置顶 | 侧栏 `listConversations` / `deleteConversation` / `togglePinConversation` | |
| C-03 | 消息渲染（Markdown） | `chat-screen.tsx` `MessageBubble` + `components/markdown.tsx` | |
| C-04 | 助手消息操作条：复制 / 重新生成 / 翻译 / 删除 | `MessageActionBar` + `regenerateMessage` / `translateMessage` / `deleteMessage` | |
| C-05 | 思考 / 轨迹折叠行 | `AssistantTraceRow` | |
| C-06 | 生成中行（转圈 + 秒数） | `GeneratingRow` | |
| C-07 | 知识库引用条 | `CitationBar` | |
| C-08 | 知识库选择弹窗 | `KbPickerDialog` | |
| C-09 | 附件：文件 / 图片 | `stageChatFiles` / `stageChatImages` / `discardChatImage` | |
| C-10 | 联网检索开关 | composer | |
| C-11 | 知识库挂载开关 | composer | |
| C-12 | 模型选择器 | composer + `components/model-picker.tsx` | |
| C-13 | 发送 / 停止 | `sendChatMessage` / `stopChatGeneration` | |
| C-14 | 流式正文与思考 | `stores/chat.ts` + `lib/rpc.ts` | 40ms 节流 |
| C-15 | 实时 / 实测 token 统计 | `components/token-stats.tsx` | |
| C-16 | 上下文占用条 | `stores/chat.ts` contextUsage | |
| C-17 | 消息图片展示 | `MessageImages` | |
| C-18 | 翻译整条消息 | `translateMessage` | |

### 4.2 架构点评

- 结构清晰：Screen（会话区 + composer）→ store（流式）→ RPC。双轨制（Query 拉历史 + Zustand 收流）执行到位。
- 问题：
  - `chat-screen.tsx` 1088 行里混了 6 个可复用子组件（`MessageActionBar` / `AssistantTraceRow` / `GeneratingRow` / `CitationBar` / `MessageBubble` / `KbPickerDialog`）+ `ChatMessages` + `ChatWindow`，可拆。
  - `MessageBubble` 与 Agent 的 `app/agent/message.tsx` 有重复的 Markdown / 图片 / 引用渲染逻辑（Agent 版更完整）。长期应共用一份消息渲染。
  - 无渲染性能优化：长会话每条消息都重渲染。`ChatMessages` 未做 memo。

### 4.3 优化记录

**拆文件（架构整理）**：原 `app/chat-screen.tsx`（1088 行）把消息渲染、输入区、会话编排三件事混在一起。拆为 `app/chat/`：

| 文件 | 职责 |
|---|---|
| `app/chat/index.tsx` | 编排：选会话 / 拉历史 / 发消息 / 停止 / 服务状态提示 |
| `app/chat/message.tsx` | 消息渲染：气泡、操作条、思考轨迹行、生成中行、引用条、右键菜单 |
| `app/chat/composer.tsx` | 输入区：草稿 / 附件 / 联网 / 知识库 / 模型 / 发送·停止，含知识库选择弹窗 |

边界明确：输入框的本地状态（草稿、附件、开关）只存在于 Composer，发送时把 `ChatSendPayload` 交给编排层；消息区不再读输入区内部状态。行为完全不变，改动由 `bun run test`（1288 通过）+ typecheck 验证。

**待办（记录在案，不阻塞）**：
- 对话与 Agent 的消息渲染仍是两份实现（Agent 侧多工具时间轴 / 授权卡片 / 产出物）。长期应共用一份 Markdown / 图片 / 引用渲染内核。
- 翻译目标语言目前跟随界面语言（zh / en），后端已支持 zh-TW / ja / ko / fr / de，多语种入口待补。
- `useMessageActions` 对每条消息都创建三个 mutation 对象，长会话有冗余（未验证到实际问题，先不动）。

---

## 5. 菜单 2 · Agent（agent）

### 5.1 功能清单

Agent 是三模式（agent / plan / goal）工作台，功能按「会话 / 时间轴 / 输入区 / 右侧面板 / 子视图」分组。

**主区与侧栏**

| # | 功能 | 实现 |
|---|---|---|
| A-01 | 会话侧栏：置顶 / 归档 / 搜索 / 重命名 / 工作区分组 | `agent/session-sidebar.tsx` |
| A-02 | 新建任务（⌘N）/ 在项目文件夹里新建 | `new-session.ts` + `agent/index.tsx` |
| A-03 | 搜索会话（⌘K 弹窗，标题 + 正文片段） | `agent/topbar.tsx` `AgentSearchDialog` |
| A-04 | 子视图：自动化 / 插件（MCP） | `agent/agent-views.tsx` |
| A-05 | 顶栏：收起侧栏 / 新建 / 搜索 / 通知铃铛 | `agent/topbar.tsx` + `notification-bell.tsx` |

**时间轴（message / timeline）**

| # | 功能 | 实现 |
|---|---|---|
| A-06 | 正文流式 + 思考行 | `agent/message.tsx` |
| A-07 | 工具调用行（图标 + 动作 + 参数 + diff 计数，可展开） | `agent/timeline.tsx` + `timeline-model.ts` |
| A-08 | 授权 / 提问卡片（内联在触发它的消息下方） | `agent/inline-interactions.tsx` |
| A-09 | 待办清单面板 | `agent/todo-panel.tsx` |
| A-10 | 目标面板（Goal） | `agent/goal-panel.tsx` |
| A-11 | 方案卡片（Plan） | `agent/plan-card.tsx` |
| A-12 | 排队 / 插话消息面板 | `agent/queue-panel.tsx` |
| A-13 | 会话状态面板（`/status`） | `agent/session-status-panel.tsx` |
| A-14 | 回合快照回退（撤销本轮） | `agent/revert-dialog.tsx` |
| A-15 | 产出物卡片 + 归属分组 | `agent/message.tsx` + `artifact-meta.ts` |

**输入区（composer）**

| # | 功能 | 实现 |
|---|---|---|
| A-16 | 输入卡 + 附件 | `agent/composer.tsx` |
| A-17 | 斜杠命令 `/` 与 `@` 文件提及补全 | `composer-suggestions.tsx` + `composer-slash.test.tsx` |
| A-18 | 模式切换 / 工作区 / 模型 / 审批与沙箱提示 | `composer-controls.tsx` |
| A-19 | 上下文占用条 | `composer-controls.tsx` |

**右侧面板（right-panel）**

| # | 功能 | 实现 |
|---|---|---|
| A-20 | 多页签：产出物 / 审查 / 文件 / 终端 / 浏览器 | `right-panel.tsx` + `artifacts-tab` / `review-tab` / `terminal-tab` / `browser-tab` |
| A-21 | 产出物预览（Markdown / 代码 / 图片 / 音视频 / PDF / HTML iframe） | `artifact-preview.tsx` |
| A-22 | 面板拖动分隔条（宽度本机记住） | `panel-splitter.tsx` |

### 5.2 架构点评

- **这是全项目组织得最好的一块**：30 个文件按职责切开，纯逻辑（`timeline-model` / `artifact-meta` / `new-session`）单独抽出并带单测，`agent-screen.tsx` 只做编排。可以作为其他菜单的参照。
- 问题（已在本轮处理）：
  1. `agent-screen.tsx` 在 `app/` 顶层，与 `app/agent/*` 分居两处；且内含 300 行的 `AgentConversation`。
  2. `AgentWindow` 里 `activeApp` 取了却 `void activeApp;`（死代码）。
  3. `use-server-message-sync` 的文档声称对话/Agent 共用同一份规则，但 Agent 页实际仍是内联的两段 effect —— 文档与代码已漂移。

### 5.3 优化记录

- **归位**：`app/agent-screen.tsx` → `app/agent/index.tsx`，并把会话视图拆到 `app/agent/conversation.tsx`（`AgentConversation` / `EmptyAgent` / `useAgentRunning`）。现在 Agent 的全部代码都在 `app/agent/` 下。同步更新 `bun/agent.ts` 与 `agent-events.test.ts` 里指向旧路径的注释。
- **死代码**：移除 `AgentWindow` 里未使用的 `activeApp`（原本靠 `void activeApp;` 压掉告警）。
- **消除漂移**：Agent 会话改用 `useServerMessageSync(conversationId, convQuery.data)`，与对话页共用同一份「切会话清流式态 / 同会话只合并」规则。hook 的文档从「声称共用」变成「真的共用」。

---

---

## 6. 菜单 3 · 通话（voicecall）

### 6.1 功能清单

实时语音通话：左侧配置面板（通话记录走侧栏），右侧通话区。本地模式 = VAD 断句 + 本地 ASR/LLM/TTS；云端模式 = Qwen Realtime 端到端语音。

**配置面板（左）**

| # | 功能 | 实现 |
|---|---|---|
| V-01 | 模式切换（本地 / 云端）持久化到 `VOICE_CALL_PROVIDER` | `voice-call-screen.tsx` |
| V-02 | 云端配置引导（厂商 → 实时端点 → 模型 / 音色，保存并测试连接） | `CloudSetupGuide` |
| V-03 | 就绪检测（模型 / ASR / TTS / 云端配置），缺项可点击跳配置 | `PreflightRow` + `voicecallPreflight` |
| V-04 | 拨号 / 错误展示 | `voice-call-screen.tsx` |

**通话区（右）**

| # | 功能 | 实现 |
|---|---|---|
| V-05 | 通话状态芯片（聆听 / 思考 / 朗读 + 时长） | `CallStatusChip` |
| V-06 | 麦克风电平条 / 频谱动画 | `MicLevelBar` |
| V-07 | 云端实时场景：语音球 + 实时字幕 | `RealtimeScene` + `VoiceOrb` |
| V-08 | 本地模式消息区 + 实时字幕条 | `CallMessageBubble` |
| V-09 | 底部挂断 / 继续通话 | `voice-call-screen.tsx` |

**引擎（hooks / stores）**

| # | 功能 | 实现 |
|---|---|---|
| V-10 | 麦克风采集 + 能量 VAD（48000 → 16k，断句） | `hooks/use-voice-call.ts` |
| V-11 | 本地模式：整段 WAV 增量转写（~280ms 一帧） | `use-voice-call.ts` |
| V-12 | 云端模式：增量 PCM16 16k 推流（~120ms 一帧） | `use-voice-call.ts` |
| V-13 | 播放队列（WAV `decodeAudioData` / PCM16 24k 直构，PCM 块合并消间隙） | `use-voice-call.ts` + `stores/voice-call.ts` |
| V-14 | 抢话打断 + 回声音量门控（助手出声时不当人声） | `use-voice-call.ts` |
| V-15 | 挂断 / 卸载自动挂断（避免麦克风后台常驻） | `use-voice-call.ts` |

### 6.2 架构点评

- 分层清楚：`stores/voice-call.ts` 只存状态与队列（无副作用），采集 / VAD / 播放 / RPC 全在 `hooks/use-voice-call.ts`，屏只做排版。电话式协作的难点（回声防护、抢话、块间间隙）都集中在 hook 里并有注释说明。
- **唯一的分层越界**：屏幕直接读写 chat store（`setStreaming` / `setActiveMessages` / `mergeServerMessages`），而对话与 Agent 都把这件事收敛进 `useServerMessageSync`。这既是重复也是 bug 温床。
- `CloudSetupGuide` 220 行混了引导文案与配置表单；当前可读，若要再拆可按「引导 / 表单」切开（暂不必要）。

### 6.3 优化记录

- **修掉整体替换 bug**：原本 `useEffect([conversationId, convQuery.data])` 里 `setStreaming(false) + setActiveMessages(data.messages)`。后果有两层：① 同会话内窗口重新聚焦 / `invalidateQueries` 触发重取时，正在流式的助手正文会被服务端那份还没落库的内容整体替换（正文被抹掉）；② 切会话与重取混在一个 effect，会互相打架。改为「切会话清空 + `useServerMessageSync(conversationId, convQuery.data)`」，与对话 / Agent 共用同一份规则。
- 至此，三个「会话型」菜单（对话 / Agent / 通话）的服务端消息同步只有一份实现（`hooks/use-server-message-sync.ts`）。

---

## 7. 菜单 4 · 语音（voice）

### 7.1 功能清单

语音是「一屏三工具」：侧栏顶部切换 语音合成 / 语音识别 / 声音克隆。

**语音合成（TTS，`voice/tts-tab.tsx`）**

| # | 功能 | 实现 |
|---|---|---|
| Vo-01 | 本地 / 云端引擎切换 | `TtsTab` |
| Vo-02 | 本地模型下载 / 启动 / 重启 / 卸载 | `LocalModelRow` + `useModelDownloadStore` |
| Vo-03 | 音色选择（preset / emotion 两类，本地模型） | `LocalVoicePicker` |
| Vo-04 | Edge-TTS 音色选择（可搜索下拉） | `EdgeVoicePicker` |
| Vo-05 | 云端模型 / 音色 / 参考音频 | `CloudModelSelect` + `detectReferenceAudioSupport` |
| Vo-06 | 文本输入 + 合成 + 结果播放 / 下载 | `TtsTab` + `PlayAudio` + `AudioDownloadButton` |
| Vo-07 | 合成中占位动画 | `TtsLoading` |

**语音识别（ASR，`voice/asr-tab.tsx`）**

| # | 功能 | 实现 |
|---|---|---|
| Vo-08 | 引擎切换（本地 whisper.cpp / audio.cpp / 云端） | `AsrTab` |
| Vo-09 | 模型下载 / 启动 / 卸载（两套引擎各自的模型行） | `AsrModelRow` / `AsrAudioCppModelRow` |
| Vo-10 | 语言选择（audio.cpp 用 `AUDIOCPP_LANG_LABELS`） | `AsrTab` |
| Vo-11 | 麦克风录音 + 实时电平 | `useMicRecorder` + `LevelMeter` |
| Vo-12 | 音频文件 / 录音转写 + 分段结果查看 | `TranscriptViewer` + `mergeSegments` |
| Vo-13 | 结果播放 / 下载 | `PlayAudio` |

**声音克隆（`voice/clone-tab.tsx`）**

| # | 功能 | 实现 |
|---|---|---|
| Vo-14 | 参考音频录制 / 上传 | `useMicRecorder` |
| Vo-15 | 创建克隆音色 | `CloneTab` + `useClones` |
| Vo-16 | 克隆列表（试听 / 下载 / 删除） | `CloneTab` |

### 7.2 架构点评

- **单文件 2429 行**，三个标签页（TtsTab 686 / AsrTab 791 / CloneTab 142）挤在一起，共用组件和专用组件混排；改一个标签页要在两千行里定位。
- 共用件（结果三态、模型行、播放器、麦克风条）没有落点，所以出现了 `ResultError` 这类逐字复制的组件。
- 单测只覆盖纯逻辑（`voice-asr-result.test.tsx` 等），UI 拆分后回归风险低。

### 7.3 优化记录

- **按标签页拆分**：`app/voice-screen.tsx` → `app/voice/{index,tts-tab,asr-tab,clone-tab,parts}.tsx`。
  - `parts.tsx`：跨标签页共用件（`formatTime` / `PlayAudio` / `ResultPanel` / `TtsLoading` / `SettingsValues` / `useClones` / `EdgeVoicePicker` / `LocalModelRow` / `LocalVoicePicker` / `formatBytes`）。
  - 三份标签页各自独立，`index.tsx` 只做 tab 分发。相对路径同步修正（`../../bun` → `../../../bun`，`./voice-asr-result` → `../voice-asr-result`）。
- **抽出跨菜单共用件**：新建 `components/media-result.tsx`（`ResultError` / `ResultEmpty`），语音页先接入。`ResultError` 原本在 voice / image / video 三处逐字重复 —— 图像、视频两页待各自菜单处理时替换为同一实现。

---

## 8. 菜单 5 · 图像（image）

### 8.1 功能清单

图像工作台按侧栏工具分发：生成 / 编辑（批量即将推出），另有整屏历史页。

**生成（`image/generate-tab.tsx`）**

| # | 功能 | 实现 |
|---|---|---|
| Im-01 | 后端切换（本地 MLX / 云端 / 其它） | `GenerateTab` + `useMlxInstallStore` |
| Im-02 | MLX 模型下载 / 运行 | `useMlxModelDownloadStore` / `useMlxModelRunStore` |
| Im-03 | 提示词输入 + 预设随机提示词 | `RANDOM_PROMPTS` |
| Im-04 | 宽高比 / 尺寸选择 | `RATIOS` |
| Im-05 | 步数 / 随机种子等高级参数（可折叠） | `Collapsible` |
| Im-06 | 生成 / 取消 / 结果网格与播放动画 | `GenLoading` + `ImageCard` |
| Im-07 | 来源筛选（本地 / 云端 / 导入） | `MediaSourceFilter` + `MediaSourceBadge` |
| Im-08 | 最近生成横向条 | `RecentStrip` |
| Im-09 | 下载 / 删除 | `downloadImage` |

**编辑（`image/edit-tab.tsx`）**

| # | 功能 | 实现 |
|---|---|---|
| Im-10 | 参考图上传 + 编辑提示词 | `EditTab` |
| Im-11 | 云端图像编辑（provider → model） | `CloudModelSelect` |
| Im-12 | 编辑结果对比 / 下载 / 删除 | `ImageCard` + `downloadImage` |

**历史（`image/history.tsx`）**

| # | 功能 | 实现 |
|---|---|---|
| Im-13 | 全部图片网格 + 提示词 + 时间 | `HistoryCard` |
| Im-14 | 查看大图 | `dialog` |
| Im-15 | 删除（带确认） | `HistoryCard` |

### 8.2 架构点评

- 单文件 2042 行，`GenerateTab` 一段就 971 行；常量 / 共用件 / 两张标签页 / 历史页 / 入口混排。
- 与语音页同病：`ResultError` 又抄了一份（三处逐字相同）。
- 已有正向分层：`media-source-badge` 已是跨页共用件，说明团队已经意识到该抽。

### 8.3 优化记录

- **按职责拆分**：`app/image-screen.tsx` → `app/image/{index,generate-tab,edit-tab,history,parts}.tsx`。
  - `parts.tsx`：常量（`RATIOS` / `RANDOM_PROMPTS` / `MLX_FALLBACKS`）与共用件（`ImageCard` / `GenLoading` / `RecentStrip` / `HistoryCard` / `Bubble` / `formatTime` / `formatBytes` / `downloadImage`）。
  - `index.tsx` 保留工具分发与「批量」占位。
- **接入共用件**：图像页的 `ResultError` 改用 `components/media-result.tsx`，删掉本地那份逐字复制。

---

## 9. 菜单 6 · 视频（video）

### 9.1 功能清单

**生成（`video/generate-tab.tsx`）**

| # | 功能 | 实现 |
|---|---|---|
| Vi-01 | 后端切换（minimax / seedance / comfyui） | `BACKEND_ITEMS` |
| Vi-02 | 云端 provider → model 选择 | `CloudModelSelect` |
| Vi-03 | 提示词 + 参考图上传 | `GenerateTab` |
| Vi-04 | 画面比例 / 分辨率 / 时长（后端相关取值范围） | `RATIOS` / `RESOLUTIONS` / `DURATION_RANGE` / `COMFY_SIZES` |
| Vi-05 | ComfyUI 专用尺寸 | `COMFY_SIZES` |
| Vi-06 | 高级参数折叠 / 开关 | `Collapsible` + `Switch` |
| Vi-07 | 生成 / 取消（`BanIcon`） | `GenerateTab` |
| Vi-08 | 在途任务轮询 | `useVideoRecordsPolling` |
| Vi-09 | 任务 / 失败 / 播放卡片 | `VideoTaskCard` / `VideoFailedCard` / `VideoPlayerCard` |
| Vi-10 | 来源筛选 | `MediaSourceFilter` + `MediaSourceBadge` |
| Vi-11 | 最近生成横向条 | `RecentStrip` |
| Vi-12 | 下载 / 删除 | `downloadVideo` |

**历史（`video/history.tsx`）**

| # | 功能 | 实现 |
|---|---|---|
| Vi-13 | 全部视频网格 + 提示词 + 时间 | `HistoryCard` |
| Vi-14 | 播放弹窗 | `dialog` |
| Vi-15 | 删除（带确认） | `HistoryCard` |

### 9.2 架构点评

- 单文件 1235 行，`GenerateTab` 一段 692 行；与图像页同构。
- 与图像页的 `RecentStrip` 结构相似但数据源不同（图片 vs `VideoThumb`），暂不强行合并 —— 强行抽象会引入 render-prop 复杂度，收益不抵。记录为已知重复。
- 轮询 hook 的注释指向了旧的 `video-screen.tsx` 调用点，本次一并修正。

### 9.3 优化记录

- **拆分**：`app/video-screen.tsx` → `app/video/{index,generate-tab,history,parts}.tsx`。`parts.tsx` 放常量与卡片（`VideoThumb` / 三类任务卡 / `RecentStrip` / `HistoryCard` / `formatTime` / `downloadVideo`）。
- **接入共用件**：`ResultError` 改用 `components/media-result.tsx`。至此三个媒体页（语音 / 图像 / 视频）的错误条只有一份实现，§3 的第 1 条债消除。
- 同步修正 `hooks/use-video-polling.test.tsx` 里指向旧文件名的注释。

---

## 10. 菜单 7 · OCR（ocr）

### 10.1 功能清单

OCR 是「一屏两工具」：识别提取（三种引擎）/ 文档处理（`DropZone` 走文档管道）。

**入口（`ocr/index.tsx`）**

| # | 功能 | 实现 |
|---|---|---|
| O-01 | 工具切换（识别提取 / 文档处理） | `useOcrStore` + `DropZone` |
| O-02 | 引擎切换（Tesseract / PaddleOCR / VLM），持久化并随切走停 Paddle worker | `OcrScreen` + `SegmentedControl` |
| O-03 | 图片在引擎间共享（切换不必重选图） | `StagedImage` state |

**通用件（`ocr/parts.tsx`）**

| # | 功能 | 实现 |
|---|---|---|
| O-04 | 左参数面板 + 右结果区外壳 | `Workbench` |
| O-05 | 配置分组 / 状态卡 / 图片选择 / 复制 / 结果文本 / 空态 / 原图预览 | `PanelSection` / `StatusCard` / `ImagePicker` / `CopyButton` / `ResultText` / `EmptyResult` / `ImagePreview` |
| O-06 | 结果区标题条 | `ResultHeader` |

**Tesseract（`ocr/tesseract-tab.tsx`）**

| # | 功能 | 实现 |
|---|---|---|
| O-07 | 引擎安装 / 状态 | `installTesseractEngine` / `getOcrStatus` |
| O-08 | 语言模型列表：下载 / 删除 / 启用 | `LangModelRow` |
| O-09 | 识别 + 参数（PSM 等） | `runOcr` + `OCR_PSM` |

**PaddleOCR（`ocr/paddleocr-tab.tsx`）**

| # | 功能 | 实现 |
|---|---|---|
| O-10 | 引擎下载 / 状态 / 清理 | `downloadPpOcrEngine` / `getPpOcrStatus` / `cleanupPpOcrEngine` |
| O-11 | det / rec 模型卡片：下载 / 取消 / 删除 / 启用 | `ModelCard` |
| O-12 | 识别 + 模型规格选择 | `runPpOcr` + `PPOCR_MODEL_SIZE` |

**VLM（`ocr/vlm-tab.tsx`）**

| # | 功能 | 实现 |
|---|---|---|
| O-13 | 来源切换（本地 / 云端） | `SegmentedControl` |
| O-14 | 本地：已装模型列表 / 服务器启停 | `listInstalledModels` / `startServer` / `restartServer` |
| O-15 | 云端：provider → model + 保存配置 | `CloudModelSelect` / `saveOcrProviderConfig` |
| O-16 | 识别 | `runOcrVlm` |

### 10.2 架构点评

- **已经是“菜单 4/5/6 应该长成的样子”**：`index.tsx` 96 行只做分发与引擎状态，`parts.tsx` 收通用件，三个引擎标签页各自独立。本轮无需拆文件。
- 问题：`SegmentedControl` 与 `app/skills/parts.tsx` 里那份逐字相同（Skills 的注释甚至写着“与 OCR 页 parts 相同样式”），是典型的“知道重复但没落点”。

### 10.3 优化记录

- **抽出共用分段控件**：新建 `components/segmented-control.tsx`；OCR 与 Skills 的 `parts.tsx` 均改为 `export { SegmentedControl } from "@components/segmented-control"`，实现只剩一份。attached 版（9 处）记入 §3 第 6 条，待各自菜单统一。
- OCR 其余部分本轮不动（结构已经合理）。

---

## 11. 菜单 8 · 翻译（translate）

### 11.1 功能清单

**文本翻译（`translate/text-tab.tsx`）**

| # | 功能 | 实现 |
|---|---|---|
| T-01 | 引擎切换（当前模型 / Google 免费引擎）+ 模型下拉 | `translate/engine-picker.tsx` |
| T-02 | 模型列表按「本地运行中 / 云端厂商」分组 | `engine-picker.tsx` |
| T-03 | 语言对（源 ⇄ 目标，源可 auto） | `text-tab.tsx` + `TRANSLATION_LANGUAGES` |
| T-04 | 原文编辑（字数统计、改动即清结果） | `text-tab.tsx` |
| T-05 | 翻译 / 取消态 / 错误 | `runTranslation` + `ResultError` |
| T-06 | 结果展示 + 复制 | `CopyButton` |
| T-07 | 交换源/目标（连同原文译文对调） | `swap()` |
| T-08 | 新建（清空编辑器） | `resetEditor()` |
| T-09 | 历史记录回填（侧栏点选） | `useTranslateStore.activeRecord` |

**同传翻译（`app/live-translate.tsx`，覆盖整屏）**

| # | 功能 | 实现 |
|---|---|---|
| T-10 | 录音 / 实时队列 / 字幕 | `live-translate.tsx` + `lib/live-translate-queue.ts` |
| T-11 | 复用翻译引擎选择器 | 从 `translate/engine-picker` 导入 |

### 11.2 架构点评

- 单文件 475 行，混了「引擎选择器（可被同传页复用）+ 文本标签页 + 入口」。`useTranslationEngine` / `TranslationEnginePicker` 已经被同传页 import，说明它们本就不属于文本标签页。
- 复制按钮又抄一份（已在 OCR 菜单抽出共用件，此处接入）。
- 错误条又内联一份（`ResultError` 的样式）。

### 11.3 优化记录

- **按复用边界拆分**：`app/translate-screen.tsx` → `app/translate/{index,text-tab,engine-picker}.tsx`。
  - `engine-picker.tsx`：`useTranslationEngine` + `TranslationEnginePicker`（同传页复用）。
  - `text-tab.tsx`：文本翻译标签页；`index.tsx` 只做工具分发。
- **接入共用件**：复制按钮改用 `components/copy-button.tsx`；错误条改用 `components/media-result.tsx` 的 `ResultError`。
- 同步更新 `app/live-translate.tsx` 与 `main-layout/index.tsx` 的导入路径。

---

## 12. 菜单 9 · 提示词（prompt）

### 12.1 功能清单

**提示词广场（`prompt/plaza-view.tsx`）**

| # | 功能 | 实现 |
|---|---|---|
| P-01 | 来源筛选 chips（Image2Hub / H3 Cases 等，按类型不同） | `SOURCE_FILTERS` + `setSource` |
| P-02 | 搜索（300ms 防抖） | `SearchBox` + `setSearch` |
| P-03 | 分类简介（选中分类用其 intro，否则用默认） | `DEFAULT_INTROS` + `listPromptCategories` |
| P-04 | 无限滚动卡片墙 / 空态 | `useInfiniteQuery` + `PromptCard` + `InfiniteSentinel` |
| P-05 | 加入我的提示词（卡片 / 详情浮层） | `JoinMineButton` + `importMyPromptFromPlaza` |

**我的提示词（`prompt/my-view.tsx`）**

| # | 功能 | 实现 |
|---|---|---|
| P-06 | 新建 / 编辑表单 | `PromptEditDialog` |
| P-07 | 删除（确认框 + 失败反馈） | `deleteMyPrompt` + `deleteError` |
| P-08 | 搜索 / 无限滚动 / 空态（含去广场引导） | 同广场 |

**详情浮层（`prompt/detail-dialog.tsx`）**

| # | 功能 | 实现 |
|---|---|---|
| P-09 | 图片 / 视频预览（整图 contain） | `PromptMedia` |
| P-10 | 上一张 / 下一张（按钮 + ←/→ 键 + 循环） | `onStep` + 键盘监听 |
| P-11 | 完整提示词 + 复制 / 去试试 | `CopyButton` + `usePromptNow` |

**通用**：媒体惰性回填（云端直链失败 → `ensurePromptMedia` 下载缓存 → 渐变占位）；「去试试」按类型跳图片 / 视频 / 对话并预置提示词。

### 12.2 架构点评

- 单文件 1114 行，把「常量 + 媒体件 + 卡片 + 两个视图 + 两个弹窗 + 入口」全塞一起，是典型的「业务长出来了没跟着切」。
- 两个视图的工具栏搜索框逐字重复；空态块、无限滚动尾块也各抄一份（保留 —— 文案与操作不同）。

### 12.3 优化记录

- **按职责拆分** `app/prompt-screen.tsx` → `app/prompt/`：
  - `constants.tsx`：`KINDS` / `SOURCE_FILTERS` / `DEFAULT_INTROS` / `PAGE_SIZE`
  - `use-prompt-now.ts`：跨视图复用的「去试试」
  - `parts.tsx`：`PromptMedia` / `PromptCard` / `JoinMineButton` / `InfiniteSentinel` / **新增 `SearchBox`**
  - `detail-dialog.tsx` / `plaza-view.tsx` / `my-view.tsx` / `edit-dialog.tsx` / `index.tsx`
- **抽 `SearchBox`**：广场与我的两处工具栏搜索框（含清除按钮）合一。
- `main-layout/index.tsx`、`components/ui/dialog.test.ts` 里的旧路径/注释同步更新。

---

## 13. 菜单 10 · Skills（skills）

### 13.1 功能清单

六个区（`skills/sidebar.tsx` 导航，`index.tsx` 分发）。

**市场（`skills/market/index.tsx`）**

| # | 功能 | 实现 |
|---|---|---|
| S-01 | 四个子区：市场 / Git 导入 / 本地导入 / 扫描收编 | `SegmentedControl` + `MARKET_TABS` |
| S-02 | skills.sh 榜单（board 切换）、搜索、安装 | `MarketplacePane` + `MarketCard` |
| S-03 | Git 仓库导入 | `GitImportPane` |
| S-04 | 本地目录导入 | `LocalImportPane` |
| S-05 | 扫描已装技能并收编 | `ScanPane` |

**我的技能（`my-skills-tab.tsx`）**

| # | 功能 | 实现 |
|---|---|---|
| S-06 | 技能列表、标签筛选、启用/停用、卸载 | `SkillCard` + `chipClass` |
| S-07 | 查看 SKILL.md / 工具授权 | `SkillDocDialog` / `ToolPickerDialog` |

**预设（`presets-tab.tsx`）**：内置模板一键创建。
**项目（`projects-tab.tsx`）**：项目内 `.agents/skills` 同步（`SyncStateBadge`）。
**工具（`tools-tab.tsx`）**：各工具（Claude / Cursor / Codex…）的技能目录状态。
**备份（`backup-tab.tsx`）**：导入 / 导出 Skills 包。
**通用件（`parts.tsx`）**：`formatBytes` / `chipClass` / `Toolbar` / `ToolBadge` / `ToolPickerDialog` / `InstallState` / `SkillDocDialog` / `SkillCard`。

### 13.2 架构点评

- 本身就是拆分得比较到位的模块（六区各一文件 + 共享件），但仍有一处「文件里塞了四个子视图」：`market-tab.tsx` 把四个 pane、卡片、常量全放在一个 460 行文件里。
- `chipClass` 与提示词广场那份逐字相同（连注释都互指）——上一步已抽共用件，此处接入。

### 13.3 优化记录

- **拆市场 Tab** `skills/market-tab.tsx` → `skills/market/`：
  - `index.tsx`（`MARKET_TABS` + `MarketTab` 编排）
  - `market-card.tsx` / `marketplace-pane.tsx` / `git-import-pane.tsx` / `local-import-pane.tsx` / `scan-pane.tsx`
- **统一 chip 样式**：`parts.tsx` 的 `chipClass` 改为再导出 `components/filter-chip.ts`；`SegmentedControl` 亦再导出 `components/segmented-control.tsx`（OCR 菜单已建）。
- `index.tsx` 导入改为 `./market`。

---

## 14. 菜单 11 · 知识库（kb）

### 14.1 功能清单

**外壳（`kb/index.tsx`）**

| # | 功能 | 实现 |
|---|---|---|
| K-01 | 库列表查询（侧栏 / 主页 / 聊天选择器共用） | `useKbListQuery` |
| K-02 | 新建库（名称 / 描述 / 嵌入 / 重排模型） | `KbCreateDialog` |
| K-03 | 库详情头：名称描述 + 四格统计（文档 / 分块 / 向量 / 检索） | `KbHeader` / `StatCard` |
| K-04 | 五个标签页分发（文档 / 召回 / 设置 / 治理 / 访问） | `TABS` + store |
| K-05 | 空态 / 加载态 | `KbScreen` |

**文档（`docs-tab.tsx`）**：上传 / 解析状态 / 分块查看 / 预览 / 删除 / 重建。
**召回（`recall-tab.tsx`）**：测试查询 + 命中列表（方法 / 重排徽章）。
**设置（`settings-tab.tsx`）**：分块参数 / 嵌入 / 重排 / 检索 / 高级。
**治理（`governance-tab.tsx`）**：操作审计 + 统计。
**访问（`access-tab.tsx`）**：对外访问通道（复制地址 / 密钥）。
**模型选择（`model-select.tsx`）**：本地推理服务 + 云端候选统一选择器。

### 14.2 架构点评

- 已是目录化 + 按标签拆分的结构，测试也齐全（`create-dialog.test.tsx` / `settings-tab.test.tsx`）。
- 唯一「外壳文件塞了弹窗」：`index.tsx` 里 `KbCreateDialog` 占 110 行，且被侧栏、主页空态、测试三处引用。

### 14.3 优化记录

- **抽 `kb/create-dialog.tsx`**：`KbCreateDialog` 从 `index.tsx` 移出；`index.tsx` 保留 `import { KbCreateDialog } from "./create-dialog"; export { KbCreateDialog };`，侧栏与既有测试的导入路径 `./index` 不变（回归测试全绿）。
- 记入跨菜单债第 10 条：KB 标签栏等的「muted 分段切换」变体暂不并入 `SegmentedControl`（样式与交互不同，避免强合）。

---

## 15. 菜单 12 · 记忆（memory）

### 15.1 功能清单

**主屏（`app/memory/index.tsx`）**

| # | 功能 | 实现 |
|---|---|---|
| M-01 | 四格统计总览（总数 / 置顶 / 待确认 / 归档） | `StatCard` + `memoryStats` 查询 |
| M-02 | 记忆库管理（搜索 / 分类 / 状态过滤 + 列表 + 增删改） | `MemoryListCard`（`memory/list-card.tsx`） |
| M-03 | 总开关 + 复核模式 | `MemoryEnableCard`（`memory/cards.tsx`） |
| M-04 | 待确认队列（Agent / CLI / MCP 写入，批准 / 驳回 / 全批准） | `MemoryPendingCard` |
| M-05 | 维护：手动整理 / 导出 / 导入 / 最近审计流水 | `MemoryMaintenanceCard` |
| M-06 | 同步到外部 Agent（目标工具勾选 + 一键同步 / 移除） | `MemorySyncCard` |
| M-07 | 接入方式（HTTP API 地址 / 复制 cURL 等） | `MemoryApiCard`（`memory/api-card.tsx`） |
| M-08 | 侧栏分类过滤（与列表卡片共享 store） | `MemorySidebar`（`memory/sidebar.tsx`） |

**行 / 弹窗（`app/memory/entry.tsx`）**：`MemoryRow`（置顶 / 归档恢复 / 编辑 / 删除 + 徽章元信息）、`MemoryDialog`（新建 / 编辑：内容 / 分类 / 标签 / 置顶 / 重要度滑杆）。

**常量（`app/memory/constants.ts`）**：`CATEGORY_KEY` / `STATUS_KEY`（i18n key 生成），被行、卡片共用。

### 15.2 架构点评

- 主屏本体很短（原 `memory-screen.tsx` 仅 203 行），但把「记忆」的绝大部分 UI 放在了 `app/main-layout/memory-tab.tsx`（771 行）里 —— 这是**层次倒置**：应用页反向 import 布局目录的内部实现；而设置里其实已无任何分页引用它（`grep` 证实只有记忆页引用），该文件是历史遗留的“设置页记忆分页”。
- 排版原语 `setting-ui.tsx` 同样住在 `main-layout` 下，却被 `memory-screen` / `usage-screen` 两个应用页反向引用。
- 复制交互在本页是「标签 + 代码 + 图标按钮」的行内布局，与共用 `CopyButton`（按钮式）外形不同，未强合。

### 15.3 优化记录

- **上移通用排版原语**：`app/main-layout/setting-ui.tsx` → `components/setting-ui.tsx`；10 处导入（8 个设置分页 + memory + usage）统一改为 `@components/setting-ui`。消除了应用目录对布局目录的依赖。
- **迁移并拆分记忆卡片**：`app/main-layout/memory-tab.tsx`（771 行）拆入 `app/memory/`：
  - `constants.ts`（i18n key 生成）
  - `entry.tsx`（`MemoryDialog` + `MemoryRow` + `memoryMetaLine`）
  - `cards.tsx`（`MemoryEnableCard` / `MemoryPendingCard` / `MemoryMaintenanceCard` / `MemorySyncCard`）
  - `list-card.tsx`（`MemoryListCard`）
- **迁移主屏与侧栏**：`app/memory-screen.tsx` → `app/memory/index.tsx`（`MemoryScreen`）+ `app/memory/sidebar.tsx`（`MemorySidebar`）+ `app/memory/api-card.tsx`（`CopyRow` / `MemoryApiCard`）。
- 更新引用：`main-layout/index.tsx`（`../memory-screen` → `../memory`）、`app-sidebar.tsx`（`MemorySidebar` 改从 `../memory/sidebar` 导入）。删除旧 `memory-screen.tsx` / `main-layout/memory-tab.tsx`。
- 记入跨菜单债第 11 条（应用页反向依赖布局件，已修）、第 12 条（`StatCard` 四份，暂不动）。

### 15.4 验证

`typecheck` 通过；`lint` 48 warning / 0 error（与基线一致）；`bun run test` 1288 pass / 1 skip / 0 fail（128 文件）。

---

## 16. 菜单 13 · 基准测试（benchmark）

### 16.1 功能清单

**主屏（`app/benchmark/index.tsx`）**：只做布局分发 —— 左栏配置 + 右栏结果。

| # | 功能 | 实现 |
|---|---|---|
| B-01 | 模式切换：测速 / 能力评测 | 顶部 `SegmentedControl`（attached，见债 §3.6） |
| B-02 | 目标切换：本地 / 云端 | 同上 |
| B-03 | 本地模型选择（只列聊天类已装模型，路径型 id 收敛为模型名） | `use-benchmark-config` |
| B-04 | 云端服务商 / 模型选择 + 缺 key 提示 + 跳设置 | `config-panel.tsx` |
| B-05 | 测速参数：生成长度 / 并发 / 上下文档位（预设 + 自定义 + 超窗提示）/ 缓存模式 | `config-panel.tsx` |
| B-06 | 评测参数：套件（含下载状态 / 题量）/ 抽样题数 / 并发 | `config-panel.tsx` |
| B-07 | 启动 / 取消 + 进度条（下载 / 评测 / 测速阶段） | `config-panel.tsx` + `use-benchmark-config` |
| B-08 | 结果视图：头部 / 汇总卡 / 注意项（失败 / 截断 / 提前收尾 / 缓存无效）/ 缓存对比 / 明细表 / TPS 条形图 | `result-view.tsx:ResultView` |
| B-09 | 能力评测结果：总分大卡 + 题量统计 + 类别得分条形 | `result-view.tsx:EvalResultView` |
| B-10 | 历史记录列表 / 删除 / 清空（侧栏） | `BenchmarkRecordList`（仍在 `app-sidebar.tsx`） |

**共用（`app/benchmark/parts.tsx`）**：`WEIGHT_EXT_RE` / `fmtTime` / `fmtMb` / `DisplayResult` 统一视图类型。

### 16.2 架构点评

- 原 `benchmark-screen.tsx` 1278 行的单体，把「数据逻辑 + 配置表单 + 结果视图 + 评测结果」全部塞在一个函数里。配置面板依赖约 45 个 state/派生值，所以之前没人拆。
- 结果视图（`ResultView` / `EvalResultView`）与配置面板之间本来就没有双向耦合，是天然的切分点。

### 16.3 优化记录

- **抽 `use-benchmark-config.ts`**：把全部查询、state、派生值（`display` / `isRunning` / `maxTps` / `serverWindow` / `overWindow` …）与副作用（运行结束刷新历史）从视图里剥离，导出 `BenchmarkConfig = ReturnType<typeof useBenchmarkConfig>` 供面板复用类型。
- **抽 `config-panel.tsx`**：左栏 470 行配置表单独立成 `BenchmarkConfigPanel`，从 `cfg` 解构所需字段。
- **抽 `result-view.tsx`**：`ResultView` + `EvalResultView`（约 450 行）独立；`STATUS_STYLES` 随结果视图走。
- **抽 `parts.tsx`**：`WEIGHT_EXT_RE` / `fmtTime` / `fmtMb` / `DisplayResult` 类型上移，供 hook 与两个视图共用。
- **`index.tsx` 缩到 31 行**：只做布局与空态分发。
- 更新引用：`main-layout/index.tsx`（`../benchmark-screen` → `../benchmark`）、`benchmark-screen.test.tsx`（动态导入改 `./benchmark`）。删除旧 `benchmark-screen.tsx`。
- 记入跨菜单债第 5 条（`BenchmarkRecordList` 仍在 `app-sidebar.tsx`）。

### 16.4 验证

`typecheck` 通过；`lint` 48 warning / 0 error（与基线一致）；`bun run test` 1288 pass / 1 skip / 0 fail（128 文件）。

---

## 17. 菜单 14 · 设置（19 分页）

### 17.1 功能清单

设置入口 `app/main-layout/settings.tsx` 管理 19 个分页（`SettingsTab`），按 `TAB_GROUPS` 分组：

| 分组 | 分页 |
|---|---|
| 概览 | stats（`DashboardScreen`） |
| 模型 | network（`CloudProviderPanel`）/ defaults（`DefaultModelsPanel`）/ model（`LocalModelsScreen`）/ store（`ModelsScreen`）/ market（`MarketScreen`） |
| 服务 | gateway（`GatewayScreen`）/ integrations（本轮抽出） |
| 工具 | websearch / mcp / permissions / agentcaps / cli |
| 偏好 | general / appearance（`prefs-tabs`）/ about |
| 数据 | usage（`UsageScreen`）/ logs（`ConsoleScreen`）/ backup |

其中 `network` / `defaults` / `model` / `store` / `market` / `gateway` / `stats` / `usage` / `logs` 是整屏页面，其余走后缀栏的通用面板容器。

### 17.2 架构点评

- 分页管理本身很干净：19 个分页绝大多数已经是独立文件，`settings.tsx` 只做分组导航 + 内容分发 + 外部 tab 参数跳转。
- 但「集成 Agent」整页（`LAUNCHER_TOOLS` / `CLAUDE_TIERS` / `IntegrationAgentCard` / `IntegrationsSettings` / `SaveRow`，约 220 行）此前内联在 `settings.tsx` 里，是唯一没拆出去的分页；且它的保存依赖 `SettingsScreen` 内的 `useTabSave` 工厂，状态跨层传递。
- 复制交互仍是内联实现（集成卡 + 命令行页两处），未走共用 `CopyButton`。

### 17.3 优化记录

- **抽 `app/main-layout/integrations-tab.tsx`**：把集成页相关常量、`IntegrationAgentCard`、`SaveRow`、`IntegrationsSettings` 全部移出；`IntegrationsSettings` 改为自带 `useMutation`（不再从父层接收 `saveMutation`），消除了 `useTabSave` 工厂与 `SaveMutationLike`/`INTEGRATION_KEYS` 跨层传参。`settings.tsx` 从 532 行降到 295 行，并删掉随之无用的 `useMutation`/`useQueryClient` 与若干 UI/图标导入。
- **扩展并接入共用 `CopyButton`**：新增 `iconOnly` / `title` / `className` 三个可选属性（图标按钮形态）：
  - 设置 → 集成：Agent 启动命令行的复制按钮；
  - 设置 → 命令行：`CopyLine` 与 `SnippetCard` 两处内联复制（删掉各自 `copied` state 与 `navigator.clipboard` 调用，`cli-tab.tsx` 194→169 行）。
- 记入跨菜单债第 8 条（复制按钮统一，剩余页面待各自菜单）、第 13 条（设置分页目录归属）。

### 17.4 验证

`typecheck` 通过；`lint` 48 warning / 0 error（与基线一致）；`bun run test` 1288 pass / 1 skip / 0 fail（128 文件）。

---

## 18. 菜单 15 · 覆盖屏（模型库 / 详情 / 文档 / 实时翻译 / 自动化）

### 18.1 功能清单

这些屏不属于 `stores/app.ts` 的一级 `AppId`，而是走设置内的路由 / 分页，或作为全屏工作台从别处进入：

| 屏 | 入口 | 职责 |
|---|---|---|
| `models-screen.tsx` | 设置 → 模型 → 模型库（`store`） | 精选预设 + 已安装模型（我的模型），点行进详情 |
| `market-screen.tsx` | 设置 → 模型 → 在线市场（`market`） | ModelScope / HuggingFace 检索 + 下载 |
| `local-models/` | 设置 → 模型 → 本地模型（`model`） | 推理引擎 / 启动参数 / 启动条 / 已安装模型管理 / 模型目录 / 默认模型 |
| `model-detail/` | 路由 `model-detail` | 单个仓库的文件列表 + 按引擎推荐下载 |
| `document-view.tsx` | 路由 `document` | OCR / 翻译文档详情 |
| `live-translate/` | 翻译页「同传」 | 麦克风实时转写 + 逐段多语翻译 |
| `automations/` | Agent 侧栏 | 定时任务（计划 + 指令 + 工作区）与运行记录 |

### 18.2 架构点评

- **模型相关的四个屏散落在 `app/` 根目录**：`models-screen` / `market-screen` / `local-models-screen` / `model-detail`，命名不统一（有的叫 screen、有的不叫），彼此共享 `formatBytes`、`MarketFile`、`MODEL_*` 等却没有共同目录。理想是一个 `app/models/` 分组。
- **最大的两个文件都在这里**：`local-models-screen.tsx` 1204 行（引擎/参数/启动/管理四段注释清晰但未拆）、`live-translate.tsx` 811 行（一个组件内塞下三套 ASR 引擎 + 翻译队列 + 录制）。
- `model-detail.tsx` 675 行、`automations-screen.tsx` 619 行同理。
- `document-view.tsx` 386 行是单一组件，暂无需拆。
- `formatBytes` 在 `local-models-screen` / `model-detail` 各有一份**逐字相同**的实现（与其它页的 `formatBytes` 口径不同，故未做全局统一）。

### 18.3 优化记录

- **`local-models-screen.tsx`(1204) → `app/local-models/`**：`{index, engine-selector, params, launch-bar, installed, model-dirs, defaults, parts}`。启动参数、启动条、已安装管理、模型目录、默认模型各自成文件；`formatBytes` 收进 `parts.tsx`；`PARAM_FIELDS` / `PIPELINE_FIELDS` 迁到 `params.tsx`（`settings.test.tsx` 的动态导入同步改为 `../local-models/params`）。
- **`model-detail.tsx`(675) → `app/model-detail/`**：`{index, file-row, download-button, parts}`。`SUPPORT_FILE_RE` / `sortBySizeAsc` / `formatBytes` / `formatParams` 收进 `parts.tsx`。入口路径 `../model-detail` 不变（目录 `index.tsx` 直接解析）。
- **`automations-screen.tsx`(619) → `app/automations/`**：`{index, editor, run-history, parts}`。`WEEKDAYS` / `formatTime` / `FormState` / `defaultForm` 收进 `parts.tsx`；`app/agent/agent-views.tsx` 的引用改为 `../automations`。
- **`live-translate.tsx`(811) → `app/live-translate/`**：按 benchmark 范式拆成 `use-live-translate.tsx`（全部查询 / state / 副作用 / 增量翻译队列，返回渲染所需字段）+ `parts.tsx`（`segKey` / `asrLangOf` / `translateLangOf` / `LevelBars` / `AsrEngineMode`）+ `index.tsx`（只做布局渲染）。`translate/index.tsx` 的引用路径 `../live-translate` 不变。
- 记入跨菜单债第 14 条（模型四屏未归组）。

### 18.4 验证

每一步均通过 `typecheck`；`lint` 48 warning / 0 error（与基线一致）；`bun run test` 1288 pass / 1 skip / 0 fail（128 文件）。其中 `tests/webview-import-guard.test.ts`（禁 mainview 值导入 `bun/*`）曾捕获迁移中丢失的 `import type` 关键字，已修正。

---

## 19. 收尾：全部菜单状态与剩余债

15 个「菜单」（13 个一级 `AppId` + 设置 19 分页 + 覆盖屏/全屏工作台）已全部梳理并优化完毕：

对话 ✅ / Agent ✅ / 通话 ✅ / 语音 ✅ / 图像 ✅ / 视频 ✅ / OCR ✅ / 翻译 ✅ / 提示词 ✅ / Skills ✅ / 知识库 ✅ / 记忆 ✅ / 基准测试 ✅ / 设置 ✅ / 覆盖屏 ✅

本轮累计产出（均为 `apps/studio/src/mainview/` 内）：

- **新建共用件**：`components/media-result.tsx`、`components/segmented-control.tsx`、`components/copy-button.tsx`、`components/filter-chip.ts`、`components/setting-ui.tsx`（从 `main-layout/` 上移）。
- **大文件拆分**：`chat-screen`(1088)、`voice-screen`(2429)、`image-screen`(2042)、`video-screen`(1235)、`translate-screen`(475)、`prompt-screen`(1114)、`skills/market-tab`(460)、`memory-tab`(771) + `memory-screen`、`benchmark-screen`(1278)、`local-models-screen`(1204)、`model-detail`(675)、`automations-screen`(619)、`live-translate`(811)、以及 `settings.tsx` 中内联的集成页。
- **层次修正**：应用页不再反向依赖 `main-layout/`（`setting-ui` 上移；memory 卡片迁入 `app/memory/`）。

### 仍记为债（未做，需要时再处理）

1. attached 版分段切换控件约 9 处（`components/segmented-control.tsx` 只统一了 detached 版）。
2. 「muted」分段变体 3 处。
3. `StatCard` 至少 4 份（尺寸/字号不一，统一会改观感）。
4. `formatBytes` 多份（口径不同；`local-models/parts.tsx` 与 `model-detail/parts.tsx` 逐字相同）。
5. `bun/rpc/index.ts` 巨型单文件（5000+ 行）。
6. `app/main-layout/app-sidebar.tsx` 的列表组件堆叠（含 `BenchmarkRecordList`）。
7. 错误约定不统一（`{ok,error}` vs throw）。
8. 模型四屏未归组到 `app/models/`（见 §3 第 14 条）。
9. 设置分页仍躺在 `app/main-layout/`（见 §3 第 13 条）。

### 验证

- `bun run --cwd apps/studio typecheck`：通过。
- `bun run lint`：48 warning / 0 error（与开工基线一致）。
- `bun run test`：1288 pass / 1 skip / 0 fail（128 文件）。
- `bun run --cwd apps/studio test:smoke`：`memory-smoke` / 网关 MCP 存在**与本次改动无关**的失败（工作树里 `src/bun/*` 有大量此前未提交的改动；本轮只改了 `src/mainview/*` 与文档，未被任何 smoke 脚本覆盖的 bun 模块引用）。单独跑 `scripts/memory-smoke.ts` 同样复现，属既有状态。
