# 各菜单功能梳理与优化台账

> 建立于 2026-09-14。用途：把 App Rail 上每个一级菜单**拆成功能项**，逐项标出实现位置，
> 并把「从架构层面看出来的问题」落成可勾选的清单 —— 一个菜单清完再动下一个。
>
> 约定：每个问题都带 `file:line` 证据，且**只记录核实过的**（读代码 / 跑命令确认，不靠推测）。
> 勾选表示「已修 + 有验证」；只改了代码没验证的写清验证方式。
>
> **增量说明（2026-09-15）**：此后新增了一级菜单 **音乐（`music`）**，排在 Video 之后 ——
> 主屏 `app/music/index.tsx`，主进程 `bun/music-gen.ts`（云端按厂商协议分派：
> StepFun 异步提交 + 轮询 / MiniMax 同步长请求；本地引擎为预留位），记录表 `music_records`。
> 下表保留审计当时（13 个）的编号与结论，新菜单尚未走本文档的梳理流程。

## 菜单总表

App Rail 上是一级菜单（`mainview/stores/app.ts:3-16` 的 `AppId`），设置页是并列的一级页面
（`mainview/app/main-layout/settings.tsx:96-132` 的 `TAB_DEFS` / `TAB_GROUPS`，19 个标签分 6 组）。

| # | 菜单 | 入口 | 主屏文件 | 主进程模块 |
|---|---|---|---|---|
| 1 | Chat 对话 | `app-rail.tsx` | `app/chat-screen.tsx` | `bun/chat.ts` + `bun/chat-model.ts` |
| 2 | Agent | 同上 | `app/agent-screen.tsx` + `app/agent/*` | `bun/agent*.ts` + `bun/permissions.ts` |
| 3 | Voice Call 通话 | 同上 | `app/voice-call-screen.tsx` | `bun/voice-call.ts` + `bun/realtime-voice.ts` |
| 4 | Voice 语音 | 同上 | `app/voice-screen.tsx` | `bun/voice.ts` / `asr.ts` / `tts-local.ts` / `edge-tts.ts` |
| 5 | Image 生图 | 同上 | `app/image-screen.tsx` | `bun/image-gen.ts` / `mlx-gen.ts` / `media-setup.ts` |
| 6 | Video 生视频 | 同上 | `app/video-screen.tsx` | `bun/video-gen.ts` |
| 7 | OCR | 同上 | `app/ocr/*` | `bun/ocr.ts` / `ppocr.ts` / `queue.ts` |
| 8 | Translate 翻译 | 同上 | `app/translate-screen.tsx` / `app/live-translate.tsx` | `bun/translate.ts`（复用 `asr.ts`） |
| 9 | Prompt 提示词 | 同上 | `app/prompt-screen.tsx` | `bun/prompt-library.ts` / `user-prompt.ts` |
| 10 | Skills 技能 | 同上 | `app/skills/*` | `bun/skills/*` |
| 11 | KB 知识库 | 同上 | `app/kb/*` | `bun/knowledge.ts` / `kb-ingest.ts` / `kb-*.ts` |
| 12 | Memory 记忆 | 同上 | `app/memory-screen.tsx` + `app/main-layout/memory-tab.tsx` | `bun/memory.ts` / `memory-sync.ts` |
| 13 | Benchmark 基准 | 同上 | `app/benchmark-screen.tsx` | `bun/benchmark.ts` / `eval.ts` |
| — | 设置页（19 标签） | Rail 底部齿轮 | `app/main-layout/*-tab.tsx` / `cloud-provider-panel.tsx` | 横跨全部子系统 |

模型的存取还有三个并列页面挂在设置页的分组里：`local-models-screen`（model）、
`models-screen`（store）、`market-screen`（market），以及 `model-detail`（路由 `model-detail`）。

---

## 第 0 项：验证层加固（已完成）

动任何菜单之前必须先有一个可信的验证基线 —— 否则「优化」没有判据。开工时全量测试是**红的且随执行顺序变化**。

**根因（实测）**：Bun 的 `mock.module` 是**整体替换 + 进程级生效且撤不掉**的。测试文件里形如
`mock.module("./db/settings", () => ({ getSetting, updateSettings }))` 的写法把整个模块换成一个残缺替身，
之后任何 import 该模块的文件都只能拿到这份替身：

- `db/settings` 新增 `ensureSettingsEncrypted`（云端密钥加密那次）后，`chat.test.ts` 的模块图直接
  报 `Export named "ensureSettingsEncrypted" not found` —— 报错现场与原因隔着好几个文件；
- `secrets.test.ts`（新写的）拿到别的文件留下的 fake `updateSettings`（空函数），
  「落盘是密文」的断言永远看不到自己的写入。同一批用例单跑绿、全量跑红，且随 worker 数变化。

**已做的四件事**：

1. 测试脚本进 `apps/studio/package.json` 的 **`bun test --parallel`**（每个测试文件一个独立进程）。
   `--isolate` 单独用**不够** —— 它只隔离全局对象，module registry 仍在同一 worker 里共享；
   实测同一批用例 `--isolate` 红 23 条（报错落在 `safeJoin` / 备份 / 密钥加密 / 厂商列表这些
   毫不相干的文件里），换 `--parallel` 立刻全绿且更快（9.7s vs 25.9s，119 个文件）。
   `mock-hygiene.test.ts` 里有一条用例钉住这个选择，防止被改回去。
2. 新增 `src/bun/test-mocks.ts` 的 `mockModulePartial(specifier, overrides)`：先取真实模块铺开导出再覆盖。
   已把 19 处「整体替换」改写成它（覆盖 `db` / `db/settings` / `model-store` / `cloud-providers` /
   `image-server` / `mlx-gen` / `server-manager` / `stats` / `asr` / `voice` / `tts-local` /
   `gateway-images` / `runtimes` / `modelscope`）。
3. 新增 `src/bun/mock-hygiene.test.ts`：仓库级静态检查 —— 任何 `mock.module` 的替身必须覆盖被替换模块的
   全部运行时导出（或展开真实模块）。这是防复发的机制，不靠人记。
4. 删掉 `apps/studio/eb-test.test.tsx`（包根目录的临时文件，从不还原 DOM 全局；内容已由同目录的
   `src/mainview/components/error-boundary.test.tsx` 覆盖并多出两条断言）。

**顺带修出的真实问题**（改成带类型的替身后编译器逐个抓出来）：

- `download-manager.test.ts` 的 fake 里有 `partialBytesFor` —— 真实 `modelscope` 没有这个导出，是一条死替身。
- `gateway.test.ts` 的 `runTTSEdge` fake 返回 `status: "ok"`，而 `VoiceRecordRow.status` 只有
  `"done" | "failed"`；`lookupMlxModel` fake 只回 `{ id }`，缺 `label/cmd/defaultSteps/...`。
- `chat-model.test.ts` 的模型 fixture 用 `origin: "downloads"`，而 `ModelOrigin` 只有
  `"managed" | "external" | "hf-cache"`；`FakeRuntime` 缺 `Runtime` 要求的 `id` / `label`。
- 三处 provider 配置 fake 缺 `providerId` 字段（真实类型要求）。

**验收**：`bun run typecheck` 0 错、`bun run lint` 0 错、`bun run test` → **1217 用例 / 0 失败**
（119 个文件，三个连续跑批次结果一致）。

---

## 跨菜单的系统性缺口（三处，逐菜单清零）

这三条不是某个菜单的问题，而是所有菜单共用的地基，所以单独列 —— 每个菜单的清单里会引用它们。

### A. 统一日志「声明了通道但没接线」

`bun/app-log.ts:36-60` 的 `AppLogSource` 声明了 24 个 source。实际被调用过的（`grep -A3 'logEvent({'`）：

```
app 32 · agent 23 · video 9 · skills 5 · image 5 · tts 4 · server 4 · media-server 4
ocr 3 · notice 2 · download 2 · asr 2 · usage 1 · client 1
```

**从未使用**：`chat` / `translate` / `gateway` / `kb` / `memory` / `backup` / `mcp` / `automation` / `update` / `cli`。
对应模块的 `logEvent(` 计数实测全为 0：`chat.ts`、`translate.ts`、`gateway.ts`、`knowledge.ts`、
`kb-ingest.ts`、`memory.ts`、`automations.ts`、`mcp.ts`、`backup/index.ts`、`updates.ts`。

AGENTS.md 的原话是「A failure path without a `logEvent` call is a bug: the next person cannot diagnose it」，
`.agents/skills/omni-doctor/` 的整套排查流程也建立在这份日志上。现状 = 这十个子系统的故障在
`omi logs` / `getAppLogs` / `omni-diag` 里**完全不可见**。

> 注：这些子系统各自有降级记录（`kb_events` 表、`memory_events` 表、`skill_audit_log` 表），
> 但它们不在统一日志视图里，排障时不会出现在同一条时间线上。

**本轮后的状态**：`kb` / `memory` / `skills`（本轮补齐）、`chat` / `translate` / `benchmark`（此前各菜单轮次）均已接线；
仅剩 `mcp` / `backup` / `automation` / `update` / `cli` 等低频通道待核。

**C 的收口进度**：`voicecallSaveProviderConfig` / `voicecallTestRealtime` 已从契约与实现里删除 `apiKey`
（密钥只在主进程按 `providerId` 解析）；生图 / 视频 / TTS / ASR / 翻译各页此前已走厂商行。
仍待处理：KB 嵌入 / 重排模型改用 `CloudModelSelect`（需把 KB 表的 base/key 迁成 `providerId`）、
通话页的 WebSocket 地址手填与模型下拉未按 `CloudModelEntry.type` 过滤（通话模型是固定实时清单，
与通用 type 不完全对应，暂留）。

### B. 推送节流只覆盖了一半

AGENTS.md 规定「chat 40ms、download progress 400ms、logs 80ms」，理由是每个事件都会重渲染 webview。
合规的：模型下载器 400ms（`download-manager.ts:39`）、Agent/chat 正文 40ms（`agent.ts:2501`、`chat.ts:669`）。
**未节流**且事件率高的：

| 推送 | 位置 | 现状 |
|---|---|---|
| PaddleOCR 安装日志 | `rpc/index.ts:5407-5410` ← `ppocr.ts:167-181` | 每条 stdout 直推 |
| PaddleOCR 模型下载进度 | `rpc/index.ts:5414-5418` ← `ppocr.ts:148-154` | 每个下载 chunk 直推 |
| Tesseract 安装日志 | `rpc/index.ts:5421-5428` ← `ocr.ts:201-207` | 每条 stdout 直推 |
| MLX 生图权重下载进度 | `rpc/index.ts:5382-5385` ← `mlx-gen.ts:563-603` | 每个 tqdm 行直推 |
| MLX 安装日志 | `rpc/index.ts:5373-5377` | 每条 stdout 直推 |
| 通话字幕增量 | `rpc/index.ts:5486` 起 | ✅ 本轮按 60ms `throttleLatest` 合并，终态前 flush |
| 通话音频分片 | 同上 | 保留直推：追加到播放队列，合并会丢音频（与进度条语义相反） |

### C. `CloudModelSelect + providersForType` 这套约定没落地完整

AGENTS.md 写「a new cloud model selector must go through `CloudModelSelect` + `providersForType`」。
实测：`providersForType`（`shared/cloud-providers.ts:366-376`）在生产代码里**零调用点**，
只有它自己的测试引用；`CloudModelSelect` 把同一份判定内联复制了一遍
（`mainview/components/cloud-model-select.tsx:73-82`）。于是「过滤规则」有两个副本，会漂移。

同时仍有页面在旁路：

- `voice-call-screen.tsx:385-393` 手填 WebSocket 地址（`VOICE_CALL_REALTIME_BASE_URL`），不用
  `provider.baseUrl`；`:362-373` 的模型下拉不过滤 `CloudModelEntry.type`；`:225,266` 还把 apiKey 读进
  webview 再传回主进程。
- `translate-screen.tsx:55-223` 自建两级选择器，`selectChatModel` 丢 `providerId`（`:100-106`），
  多厂商下会发到错误的上游。
- KB 的嵌入/重排模型候选来自扁平设置 `CLOUD_MODELS`（`knowledge.ts:641-657`），页面仍要手填
  base/key（`kb/settings-tab.tsx:391-404`）。
- 主进程侧遗留的「页面传地址/密钥」参数（应随重构收口）：
  `runTTS.base`（`rpc/index.ts:1573`）、`voicecallSaveProviderConfig.apiKey`（`:1390`）、
  `voicecallTestRealtime.apiKey`（`:1403`）、`listImageGenModels.base/apiKey`（`:1873`）、
  `scanMediaSetupCandidates.apiKey`（`:1892`）、`generateImage.config.apiKey`（`:1852`，后端已忽略）。

---

## 菜单 1/13：Chat 对话

### 功能项

| 功能 | 触发位置 | 前端 | 后端 |
|---|---|---|---|
| 新建对话 | 侧栏「新建对话」/ 空态自动建 | `app-sidebar.tsx:690-749`、`chat-screen.tsx:997-1034` | `chat.ts:299` |
| 会话列表 + 标题搜索 | 侧栏 | `app-sidebar.tsx:665-712` | `chat.ts:268` |
| 置顶 / 删除会话 | 会话行 hover | `app-sidebar.tsx:700-707` | `chat.ts:315/308` |
| 发送消息 | Enter / 发送按钮 | `chat-screen.tsx:726-749` | `chat.ts:936` |
| 图片附件 / 文本文件附件 | 工具条 ＋ / 回形针 | `chat-screen.tsx:675-699` | `rpc/index.ts:3805/3835` |
| 联网检索开关 | 工具条地球按钮 | `chat-screen.tsx:925-939` | `chat.ts:1168-1187`（含查询改写 `:1076`） |
| 知识库挂载 + 引用溯源 | 工具条书本 + CitationBar | `chat-screen.tsx:467-558/365-387` | `chat.ts:1189-1195` |
| 模型选择 | 工具条右 | `components/model-picker.tsx:39-83` | `chat-model.ts` |
| 消息操作（复制/重生成/翻译/删除） | hover 条 + 右键 | `chat-screen.tsx:81-247/408` | `chat.ts:1209/1228/1276` |
| 思考轨迹行 / 计时 | 助手消息内 | `chat-screen.tsx:255-362` | 推送 `chatMessageStarted`（`chat.ts:147-155`） |
| 实时速率 / 用量胶囊 | 助手消息右下 | `components/token-stats.tsx` | 推送 `chatStats`（`chat.ts:908-925`） |
| 本地模型未启动横幅 | 输入框上方 | `chat-screen.tsx:600-618` | `chat.ts:476-533`（`ensureServerReady`） |

### 架构链路

`ChatWindow` → `rpcClient.sendChatMessage` → `bun/rpc/index.ts:3143` → `Chat.sendMessage`（`chat.ts:936`）：
落 user 行 → `insertAssistantMessage` 推 `chatMessageStarted` → `buildPayloadMessages`（附件/联网/知识库/记忆）
→ `streamAssistantReply`（`chat.ts:582`）流式打 `/v1/chat/completions` → 40ms 批量 `emitChunk`（`:669-707`）。
回推集中在 `initChatBroadcast`（`rpc/index.ts:5165-5185`）：`chatChunk` / `chatDone` / `chatStats` /
`chatMessageStarted`。webview 侧在 `lib/rpc.ts:74-98` 直接写 Zustand，终态才 invalidate 查询。

### 问题清单

- [x] **[P1] 每次会话重取都会把流式正文清空** — 修法：抽 `mainview/hooks/use-server-message-sync.ts`，
  把「切会话清运行态」与「同会话内只合并」拆成两个 effect，对话页与 Agent 页共用一份实现；
  对话页不再整体替换消息。**测试**：`hooks/use-server-message-sync.test.tsx`（3 条，含"重取不能抹掉
  流式正文"与"重取不改运行态"）。
- [x] **[P1] chat 整条链路零 `logEvent`** — `chat.ts` 现记 `chat.send.rejected` / `chat.send.no_model` /
  `chat.send.no_server` / `chat.stream.failed` / `chat.stream.stopped`，RPC 层记 `chat.stop.requested`。
  `chat.stream.failed` 带 conversationId / model / base / 已生成字数。**测试**：`chat.test.ts` 4 条新用例断言事件名与 detail。
- [x] **[P2] 发送失败会永久锁死输入框** — 两条早退路径（会话不存在 / 空消息）补发带 `error` 的 `chatDone`，
  前端据此解除锁定。**测试**：`chat.test.ts` 两条。
- [x] **[P2] 没有停止按钮** — 新增 `Chat.stopChatGeneration` + RPC `stopChatGeneration` + 对话页生成中
  「发送」变「停止」；打断走与语音抢话同一套收尾（保留已生成内容），并按界面语言追加 `chat.stopped` 标记。
  **测试**：`chat.test.ts` 两条（保留半截内容并落库带标记 / 无生成时如实回 ok:false）。
- [x] **[P2] i18n 缺口** — 分叉标题改为按 `UI_LANG` 生成（新增 `bun/i18n.ts` 的 `mainT`，
  与 webview 共用 `shared/i18n.ts`）。**测试**：`chat.test.ts` 断言中英两种语言下的后缀。
- [x] **[P2] 翻译目标语言写死** — 改为跟随界面语言（zh→`zh-CN`、en→`en`）。
  后端另支持 zh-TW / ja / ko / fr / de，多语种入口留到翻译菜单那轮补（需要选择器控件）。
- [x] **[P2] 死代码** — 删掉 `stores/chat.ts` 的 `removeConversation`（声明与实现各一处，全仓无调用）。
- [x] **[P2] 同一 DB 操作两条 RPC** — `togglePinConversation` 改为委托 `setConversationPinned`，
  写入路径只剩一条。
- [x] **[P2] 与 Agent 重复的实现** — 三处都收敛了：
  `insertAssistantMessage` 现在只有 `chat.ts` 一份（导出给 Agent 用），顺带删掉 Agent 那条重复的
  `chatMessageStarted` 订阅与本地 `startedListeners`；时间注入抽出 `bun/current-time.ts`（只留
  「现在是什么时候」，措辞各自负责）；40ms 批量下发抽出 `bun/chunk-flusher.ts`（两条链路共用同一个
  常量，并补上 Agent 重发需要的 `discard()`）。**测试**：`chunk-flusher.test.ts` 6 条。

---

## 菜单 2/13：Agent

### 功能项

| 功能 | 触发位置 | 后端 |
|---|---|---|
| 新建任务（⌘N） | 顶栏 / 侧栏 / 空态 / 项目段 ＋ | `agent.ts:1383` |
| 会话搜索（⌘K） | 顶栏放大镜 | `agent.ts:1330` |
| 会话侧栏（置顶/时间桶/项目分组/归档） | 侧栏，4s 轮询 | `agent.ts:1227` |
| 重命名/置顶/归档/删除 | 会话行「⋯」 | `chat.ts:421/332/434/308` |
| 工作区选择器 | 输入框左上 chip | `agent.ts:508/523` |
| 发送消息 | 回车 / 按钮 | `agent.ts:2336` |
| 排队 / 插话（Cmd+Enter） | 输入框 + 队列面板 | `agent.ts:3071/3049/3057` |
| 停止运行 | 工具条方块 | `agent.ts:3141` |
| 模式 Agent/Plan/Goal | 工具条胶囊 + 斜杠命令 | 设置 `AGENT_MODE` |
| 工具授权档位 / 推理等级 / 模型 | 工具条胶囊 | `permissions.ts`、`agent.ts:480-485` |
| 上下文占用环 | 工具条右 | `agent-context.ts:57` |
| 待办 / 目标 / 方案面板 | 输入框上方 | `agent-todos.ts` / `agent-goals.ts` / `agent-plans.ts` |
| 授权与提问卡片（消息流内） | 时间轴内 | `agent-interactions.ts:132/231/258/300` |
| 执行轨迹时间轴（工具行/diff/思考） | 助手消息内 | 事件落 `agent_events`（`agent.ts:344/381`） |
| 消息操作（复制/重生成/分叉/撤销本轮/删除） | hover + 右键 | `agent.ts:3191`、`chat.ts:352`、`agent-snapshots.ts:406/455` |
| 右侧面板（产出物/审查/文件/终端/浏览器） | 顶栏开关 + 拖动分隔条 | `agent-artifacts.ts` / `workspace-changes.ts` / `terminal-sessions.ts` |
| 通知中心 | 外壳右上铃铛 | `notifications.ts:74` |
| 子视图：自动化 / 插件(MCP) | 侧栏动作区 | `automations.ts` / `mcp.ts` |
| 斜杠命令 12 条 | 输入框补全 | `agent.ts:960/1035` 等 |

### 架构链路

`AgentWindow` → `sendAgentMessage` → `Agent.runAgentTurn`（`agent.ts:2336`）：落 user + assistant 行、
`emitStarted` → `getOrCreateSession`（`:2083`，历史回填 `agent-history.ts:141`）→ 每轮开工快照。
模型循环内 `agent.subscribe`（`:2542-2621`）40ms flush 正文/思考 → 复用 chat 的 `chatChunk`；
工具调用 `recordEvent` 写 `agent_events` 并 `emitEvent` → `agentEvent`。
收尾 `classifyTurnOutcome`（`:2798`）→ `emitStats` + `emitDone` + 通知 + 队列/目标续跑（`:2974-2981`）。

### 问题清单

- [x] **[P1] 「重新生成」把同一条用户消息在库里写两遍** — 决策抽成纯函数 `planRegenerate`
  （`agent-history.ts`），调用方据此传 `insertUserMessage: false`。**测试**：`agent-history.test.ts`
  新增 5 条（删哪一段 / prompt 取哪条 / 「被复用的用户消息不在删除区间内」这条不变量 / 无上文时报错 / 纯函数幂等）。
- [x] **[P1] 启动失败时可能显示两条错误气泡** — 后端四条早退路径（会话不存在 / 空任务 / 没模型 /
  服务没起来）全部补发带 error 的 `chatDone` 并记日志；前端兜底改用 store 的幂等动作
  `finalizeTurnIfPending`（末尾已是「有内容的助手消息」就不再补）。Chat 侧同样切过去。
  **测试**：`stores/chat.test.ts` 新增 2 条（已收尾不再补 / 末尾是空助手行时照常补且复用该行）。
- [x] **[P2] i18n 缺口** — 授权十项动作名改走词条（`agent.permLabel.*`）；「已拒绝/已允许」「已回答/未作答」
  「Q:/A:」进字典；相对时间抽成 `mainview/lib/relative-time.ts`（一处在用，另一处随死代码消失）；
  plan 面板的「(N 字)」进字典。
- [x] **[P2] 死代码** — 删掉 `AgentSearchView` / `AgentSkillsView`（上一版子视图设计的遗留：搜索已改为
  顶栏 ⌘K 弹窗、Skills 已是一级菜单）、`agent/context-meter.tsx`（整个文件无 import）、
  `timeline.tsx` 的 `countToolCalls`、agent store 的 `sessions`/`setSessions`；顺带修正
  `session-sidebar.tsx` 与 ROADMAP OW-12c 的漂移描述。
- [x] **[P2] 前端静默吞错** — `startTerminal` 失败（界面已有红字）与产出物的「外部打开 / 访达定位」
  失败补上 `reportClientError`；每次按键 / 每帧 resize 的失败保持静默，并把理由写在代码里
  （否则日志会被几十毫秒一条的频率淹掉）。
- [x] **[P2] 文档漂移** — ROADMAP OW-01 指的 `app/agent/permission-modal.tsx` 不存在，已改为
  `inline-interactions.tsx` 并说明「授权卡片画在消息下方，不是独立弹窗」。
- [x] **[P2] 授权档位图标不可区分** — `manual` 用 `HandIcon`、`strict` 用 `LockIcon`（此前两者都是
  `CircleIcon`，同一下拉里两个条目图标一样）。
- [x] **[P2] 与 Chat 重复的实现** — 见菜单 1 最后一条（三处已收敛）。

---

## 菜单 3/13：Voice Call 通话

### 功能项

本地（ASR→LLM→TTS 三段管线）与云端（DashScope Realtime 全双工）两套模式；就绪检测、拨号/恢复、
麦克风采集 + 能量 VAD、端句转写、逐句 TTS、抢话打断、挂断兜底、音频播放队列、通话记录侧栏。
入口 `voice-call-screen.tsx` + `hooks/use-voice-call.ts`；后端 `bun/voice-call.ts` + `bun/realtime-voice.ts`。

### 问题清单

- [x] **[P1] 云端配置仍手填 WebSocket 地址** — 新增 `shared/realtime-voice.ts` 的
  `realtimeBaseUrlForProvider()`：认得出的厂商（百炼 / DashScope）从 `provider.baseUrl` 推出
  `api-ws/v1/realtime`，认不出的（自建中转）保留手填值；主进程只在「存的地址等于默认值或为空」
  时才用推导值，用户真改过的一律优先。切厂商时页面也立刻把地址填成推导结果。
  **测试**：`shared/realtime-voice.test.ts` 4 条。
- [x] **[P1] 模型下拉不过滤用途** — `isRealtimeModelId()`（realtime / omni 两族）过滤厂商清单，
  对话 / 生图 / 嵌入模型不再混进实时下拉。
- [x] **[P1] 选择结果不注册回厂商清单** — 与本轮其它改动一致的做法：地址与密钥都从厂商行取，
  页面不再持有；`saveAppModelChoice` 的白名单与 `CloudModelType` 缺少「实时」这一类，
  要加就是一整条链路（分类器 + 分类芯片 + 各选择器的过滤集）—— 归到跨菜单 C 一起做，见文末。
- [x] **[P1] apiKey 绕 webview 一圈** — 页面不再读 `selectedProvider.apiKey`，连接测试只传
  `{ baseUrl, model, voice }`，密钥由主进程按 providerId 解析；「旧版手填 Key」的提示也去掉了
  （服务端仍保留该兜底，避免已装好的用户突然不能打）。
- [x] **[P2] 通话中 ASR 失败静默** — 增量转写与端句转写两个空 catch 都改为 `callLogFailure`
  （error 级、带 conversationId 与字节数）。
- [x] **[P2] 云端连接失败只记 debug** — `RealtimeVoiceClient` 新增 `onFailure` 钩子（与过程日志
  `log` 分开），失败记 error 并带上 model / baseUrl / openedOnce；「未配置就拨号」也留痕。
- [x] **[P2] 音频/字幕推送无节流** — 已修：字幕按 60ms `throttleLatest` 合并、终态前 flush；音频分片是追加队列不节流（见跨菜单 B）。
  它们是同一类问题，改法也一样）。

---

## 菜单 4/13：Voice 语音

### 问题清单

- [x] **[P1] 厂商/模型改选后不落地** — TTS 与 ASR 两个云端选择器都改成**选完即存**（与生图页一致），
  并把选择值作为变量传给 mutation（在 `onChange` 里紧接着 `setState` 再 `mutate()` 会读到本次渲染
  的旧值 —— 那会把上一个厂商存进去）。
- [x] **[P1] 本地引擎 / Edge 失败无 logEvent** — `rpc/index.ts` 新增 `loggedEngineCall` 包装
  （这一组接口按约定返回 `{ok:false}` 而不抛错，所以原来的 try/catch 写法根本不成立），
  装上：`downloadWhisperEngine` / `startAsr` / `stopAsr` / `startAsrAudioCpp` / `stopAsrAudioCpp` /
  `deleteAsrAudioCppModel` / `downloadTtsLocalEngine` / `startTtsLocal`；`runTTSEdge` 补 try/catch 与
  `tts.edge.failed`。
- [x] **[P2] 死 RPC / 死代码** — 删掉 `runASR`（前端零调用，且它绕过 ASR provider 用全局 VLLM base）、
  `listProviderModels` RPC（前端零调用；主进程内部那份仍被网关使用）、`Voice.runASR` 与其专用的
  `authHeaders`、以及 `voice-provider-presets.ts` 里那整套「内置预设 + 按地址反查」（142 行 → 10 行，
  只剩默认地址常量）。
- [x] **[P2] 硬编码中文错误文案** — 六处（启动 / 停止 / 安装 / 删除失败）改走词条。
- [x] **[P2] 注释与文案漂移** — 两处「Base URL + API Key」的注释改掉；`voice.compat.desc` 的中英文案
  同步成「厂商与密钥在设置里配一次，这里只选模型」。
- [x] **[P2] 页面仍接收明文 apiKey** — 已修：`getTTSProviderConfig` / `getASRProviderConfig` 响应去掉 `apiKey`，`voicecallSaveProviderConfig` / `voicecallTestRealtime` 也删除 `apiKey` 参数，密钥只在主进程按 `providerId` 解析。
  `apiKey`（当前 UI 不用它）。要清理得连同 `CloudProviderInfo.apiKey` 一起处理 —— 见跨菜单 C。
- [x] **[P2] `runTTS` 仍允许页面传 `base` 覆盖** — 已修：`runTTS` 不再接受 `base`，地址密钥只从服务商行 + 全局设置解析。
  同属跨菜单 C 的收口清单。

---

## 菜单 5/13：Image 生图

### 功能项

三个后端：云端 API（provider→model，选完即存）、MLX（引擎安装/权重下载/常驻 worker）、ComfyUI（地址/checkpoint 扫描）。
含参数面板、生成历史、AI 修图（参考图 → `/images/edits`）、Agent 生图弹窗（`media-setup-dialog.tsx`）。
入口 `image-screen.tsx`（1999 行）。

### 问题清单

- [x] **[P1] MLX 安装/下载/worker 启停失败无 logEvent** — `mlx-gen.ts` 新增 `logMlxFailure()`，
  接上八条失败分支：`image.mlx.install_failed`（平台不支持 / 没 python / venv 重建 / venv 创建 ×2 /
  pip 安装）、`image.mlx.download_failed`（带 repo、退出码、已下字节）、
  `image.mlx.model_load_failed`、`image.mlx.worker_failed`（spawn / 发加载指令 / 运行中退出，
  detail 里的 `stage` 取"退出时正在干什么"）。RPC 侧 `getMlxGenStatus` 的静默 catch 补
  `image.mlx.status_failed`（warn）—— 此前界面只会说"未安装"，用户反复点「下载引擎」也修不好。
  **验证方式**：无自动化测试（这几条路径要真实 python/pip 与本机网络，stub 整个安装过程的
  成本高于收益）；逐分支核对过 `grep -n "logMlxFailure\|logEvent" src/bun/mlx-gen.ts`，
  事件名与 detail 见上。
- [x] **[P1] MLX 下载进度未节流** — 已由上一轮完成（`throttleLatest`，400ms）。**顺带修掉它留下的
  类型断裂**：推送载荷改成 `{lines}` / 合批后，`lib/rpc.ts` 的三个安装日志处理器仍在读 `{text}`，
  `bun run typecheck` 是红的。现改为 `appendLines(lines)` + `lib/install-log.ts` 的终态行判定。
- [x] **[P2] MLX 安装日志未节流** — 同上，已由上一轮完成（`throttleBatch`，80ms）。
- [x] **[P2] RPC 仍保留「页面手填密钥」参数** — `listImageGenModels` 去掉 `apiKey`，逻辑下沉到
  `ImageGen.listImageGenModelIds()`；`scanMediaSetupCandidates` 去掉 `apiKey`（`media-setup.ts` 的入参同步）。
  **顺带修出一个真 bug**：页面调 `listImageGenModels` 时传的是 `apiKey: ""`，而 `"" ?? cfg.apiKey`
  取到的是空串 —— 需要鉴权的上游列模型必然 401（"清空密钥"不是"用配置里的密钥"）。
  **测试**：`image-gen.test.ts` 新增「列模型用的密钥来自选中的厂商行」，断言 `Authorization: Bearer sk-live-key`。
  另把 `generateImage.config` 的类型收窄成 `Pick<…, "backend" | "providerId" | "model" | "comfyBase">`
  （地址/密钥不再出现在页面契约里）。
- [x] **[P2] 修图页可改全局 `IMG_BACKEND` 但本页只支持 api** — 修图页的三档切换改成**只读展示**
  （当前后端徽章），非 api 时给一个明确的「切到云端后端」按钮 + 说明行。此前在修图页点一下 MLX，
  生图页的后端就被悄悄换掉。
- [x] **[P2] 删除/列表/扫描失败静默** — `listImageRecords` 的空 catch 改为记
  `image.records.list_failed`（error）并把 `error` 回给界面（历史页顶部显示，不再只显示空态）；
  `deleteImageRecord` 记录不存在时记 `image.record.delete_failed` 并回 `{ok:false,error}`，
  前端弹窗关闭后显示原因；`scanMediaSetupCandidates` 的错误记 `image.setup.scan_failed`；
  `listImageGenModels` 的错误记 `image.models.list_failed`（warn）**并显示在 ComfyUI 面板里**
  （此前模型列表空着、界面只说"0 个模型"）。
- [x] **[P2] 随机提示词硬编码中文** — `RANDOM_PROMPTS` 按 `UILang` 分组（中英各 4 条），
  取当前界面语言。此前是一份中英混排列表，英文界面下有一半概率蹦出中文提示词 ——
  而提示词是要真的发给模型的。

**验收**：`bun run typecheck` 0 错、`bun run lint` 0 错（48 条既有警告）、全量 **1255 用例 / 0 失败**。

---

## 菜单 6/13：Video 生视频

### 功能项

云端（MiniMax / Seedance，provider→model，provider 行带 `videoApi`）与 ComfyUI 两个后端；首帧图生视频、
参数（比例/时长/分辨率/steps/cfg/seed/水印）、在途任务卡（5s 轮询 + 取消）、历史页、侧栏记录。

### 问题清单

- [x] **[P2] 切到历史视图后在途任务停止轮询** — 轮询从生成页的 `refetchInterval` 提到
  `hooks/use-video-polling.ts`，挂在 `VideoScreen`（两个视图之外）。**测试**：
  `hooks/use-video-polling.test.tsx` 2 条（有在途任务按 id 问上游 / 没有就不问）。
- [x] **[P2] ComfyUI 轮询用「当前配置」而不是提交时的地址** — `video_records` 新增 `comfy_base`
  列（迁移 `0032_pale_thundra.sql`），提交时把实际地址落库，轮询按记录里的地址查；
  旧记录（没这列的值）回落到当前配置并记 `video.poll.comfy_base_missing`（warn）——
  回落是"可能问错服务器"的状态，日志里要看得见。**测试**：`video-gen.test.ts` 2 条
  （改地址后在途任务仍问老地址 / 旧记录回落并留 warn）。
  > 迁移序号踩到 AGENTS.md 说的那个坑：`drizzle-kit generate` 生成的 `when` 是真实时间戳
  > （1789426796135），比上一条的人工递增值（1790095000005）小 —— 老库升级会**静默跳过**
  > 这条迁移。已把 `when` 改成 1790095006000 系列的下一个值。
- [x] **[P2] `listVideoGenModels` 失败不进 app.log** — 补 `video.models.list_failed`（warn）；
  顺带把同一批静默 catch 一起收：`listVideoRecords` → `video.records.list_failed`（并回 error，
  历史页顶部显示）、`pollVideoRecords` → `video.poll.records_failed`、`deleteVideoRecord`
  记录不存在 → `video.record.delete_failed`（前端弹窗关闭后显示原因，不再"点了没反应"）。
- [x] **[P2] `saveImageToDownloads` 静默失败** — 三种原因分开记
  （限位拒绝 / 源文件不存在 / 文件名非法）+ 异常分支，事件 `image.save_to_downloads.failed`。
- [x] **[P2] 提交失败兜底文案硬编码中文** — 走 `video.submitFailed` / `video.deleteFailed`。

**顺带修掉的测试稳定性问题**：`use-server-message-sync.test.tsx` 用固定 `sleep(20)` 等 effect，
全量并行跑时偶发红（本轮就红过一次）。改成 `act()`（配 `IS_REACT_ACT_ENVIRONMENT`），
断言看到的就是页面上会有的状态；`cleanup` 的 `unmount` 也进 act。

**验收**：`bun run typecheck` 0 错、`bun run lint` 0 错、全量 **1270 用例 / 0 失败**（连跑两遍一致）。

---

## 菜单 7/13：OCR

### 功能项

两个子工具：「识别提取」（三引擎：Tesseract / PaddleOCR / VLM 本地或远程）与「文档处理」
（拖拽上传 → 逐页 VLM → Markdown/Raw 预览）。含引擎安装、语言包/模型下载、PSM、识别记录与侧栏。

### 问题清单

- [x] **[P1] PaddleOCR 全链路失败不进 app.log** — `ppocr.ts` 接上三条关键失败：
  `ocr.ppocr.install_failed`（pip 装不上）、`ocr.ppocr.model_download_failed`（带模型名 / kind / 直链）、
  `ocr.ppocr.start_failed`（worker 起不来）。RPC 侧 `installTesseractEngine` 补
  `ocr.tesseract.install_failed`；PaddleOCR 那组接口改成 `loggedThrow` 包装 —— 只在**抛错**时记，
  因为模块自己已经把 `{ok:false}` 记过了，再包一层会出现重复条目。
- [x] **[P1] 文档管线失败不进 app.log** — `queue.ts` 接上 `ocr.document.page_failed`（单页，带 documentId/page）
  与 `ocr.document.failed`（顶层）。顶层原来是 `console.error`：打包后 stderr 没人接，
  「文档一直处理中 / 直接失败」在 `omi logs` 里一个字都没有。
- [x] **[P1] 两类高频推送完全未节流** — 已由上一轮完成（PaddleOCR 日志 80ms 合批、进度 400ms 合并、
  Tesseract 日志 80ms 合批）；本轮修掉了它留下的 `lib/rpc.ts` 类型断裂（见菜单 5）。
- [x] **[P1] 用户提供的路径未过 path-safety** — 新增 `bun/dialog-paths.ts`：只有**用户在系统文件
  对话框里亲手选过**（5 分钟内、最多 500 条）的路径才放行，`stageOcrImage` / `addDocument` /
  `stageEditImage` 三个收绝对路径的接口都过这道闸，被拒时记 `ocr.stage` / `ocr.document.add` /
  `image.edit.stage`（warn）。**没有**改成"限制在数据目录内"：这些功能的输入本来就该是任意路径
  （OCR 桌面上的合同、导入 ~/Documents 的 PDF），限位会把功能改坏；真正的判据是路径的来源 ——
  对话框是主进程弹的、用户看得见自己选了什么，而从 webview 直接收下的路径可能是被注入的页面
  伪造的 `~/.ssh/id_rsa`（应用自己的凭据黑名单明确视其不可读）。
  **测试**：`dialog-paths.test.ts` 4 条（未记过的路径被拒 / 空白归一 / 多选 / 上限淘汰）。
  前端 `addDocument` 的 `id < 0` 也会显示原因，不再拿着 -1 继续跑处理流程。
- [x] **[P2] 远程 VLM 缺配置时提示过时** — 文案改成指向「设置 → 模型云服务」
  （OCR 页早就没有地址输入框了）。
- [x] **[P2] VLM 选择器注释与实现不符** — 注释改成说清真实约束：用途分类里没有"视觉"维度，
  VLM 与对话模型同属 `chat`。
- [x] **[P2] VLM profile 描述硬编码英文** — `MODEL_PROFILES` 的说明与徽标进词典
  （`modelProfile.<id>.description` / `.badge`，中英各一份）；新增 `translateOptional` +
  `useTOptional`（词条缺失时回退到数据自带的那份，而不是回退成 key 本身），
  `vlm-tab.tsx` 按当前语言取。
- [x] **[P2] `saveOcrRecord` 静默吞异常** — 改为记 `ocr.record.save_failed`（warn）后继续，
  不阻断流程（识别结果已在界面上）。
- [x] **[P2] 上传整文件 base64、无大小上限** — 新增 `shared/uploads.ts` 的 `MAX_UPLOAD_BYTES`（100MB）
  与 `formatUploadLimit()`：webview 侧**读文件之前**按 `file.size` 拒绝（超限时连编码都不该开始），
  base64 换成 `FileReader.readAsDataURL`（原生实现，替掉逐字节拼串 + `btoa`）；
  主进程再按 base64 长度（含 4/3 膨胀）判一次，超限记 `ocr.upload.rejected` 并回
  `{id:-1,error}`。上传失败此前既不显示也没有 `onError`，现在有红字。
  **验证方式**：体积上限与 base64 膨胀系数是纯函数式判断，靠 RPC 层难以单测（没有 RPC 测试基座）；
  已读代码逐条核对两侧判据，并在 `drop-zone` 里放可见错误。
- [x] **[P2] 死 RPC** — 删掉 `listOcrProviderModels`（契约 + 实现，前端零调用；它还把页面传的
  `apiKey` 当凭据用，正是跨菜单 C 那类问题）。

**验收**：`bun run typecheck` 0 错、`bun run lint` 0 错、全量 **1274 用例 / 0 失败**（连跑 4 遍一致）。

## 菜单 8/13：Translate 翻译

### 功能项

两个子工具：「文本翻译」（引擎二选：模型 / Google 免费接口）与「同传翻译」（ASR 三选 + 麦克风 2.5s 切片
→ 增量转写 → 逐段多目标语言上屏）。含语言对交换、翻译历史侧栏。

### 问题清单

- [x] **[P1] 模型选择丢 providerId，多厂商下会发错厂商** — **工作区里已有人修过**（`translate-screen.tsx`
  的 `selectMutation` 与 `pickModel` 都带上了 `providerId`）。本轮做的是**核实**而不是重做：
  `ChatModelOption.providerId`（`chat-model.ts:218`）确实由厂商清单填出（`:356`），
  `selectChatModel(type, value, providerId)` 只在传了它时切默认厂商（`:400`），
  翻译链路的地址 / 密钥来自激活厂商（`activateCloudProvider` → `syncActiveSlot` 写回
  `VLLM_API_BASE` / `VLLM_API_KEY`），所以"选中即切厂商"这条链是通的。
- [x] **[P1] 翻译零 logEvent，`translate` source 形同虚设** — 接上六条：`translate.request.rejected`（warn，
  空文本 / 缺目标语言，同传一次几十个请求时先在这里现形）、`translate.google.failed`、
  `translate.model.not_configured`、`translate.server.not_ready`、`translate.model.failed`（带 status / base / 字数）、
  `translate.model.empty`。谷歌免费接口是最容易被网络环境挡住的一条路，此前完全无声。
- [x] **[P2] 同传逐段翻译无并发上限** — 派发计划抽成纯函数
  `mainview/lib/live-translate-queue.ts` 的 `planLiveTranslations()`：在飞上限
  `LIVE_TRANSLATE_CONCURRENCY = 3`，在飞请求占额度，原文还在变的段落只回"更新锚点"。
  原先 10 段 × 5 语种会一次打 50 个并发请求（单个超时 10 分钟），本地单实例模型必被拖垮。
  **测试**：`live-translate-queue.test.ts` 6 条（含"10×5 只派 3 个""在飞占额度""原文在变不翻"）。
- [x] **[P2] 硬编码中文** — `translate-screen.tsx` 的「切换失败」→ `translate.switchFailed`；
  `live-translate.tsx` 三处引擎失败兜底 → 复用既有的 `voice.engine.installFailed` / `voice.engine.startFailed`。
- [~] **[P2] 自建选择器绕开统一组件** — 复核后判定不是「页面自填云端地址/密钥」：翻译器同时管理**本地运行中模型**与云端模型，并通过 `selectChatModel` 复用全局默认（带 `providerId`）。`CloudModelSelect` 只覆盖云端两级选择，不能直接替。保留。

**验收**：`bun run typecheck` 0 错、`bun run lint` 0 错、全量 **1280 用例 / 0 失败**。

## 菜单 9/13：Prompt 提示词

### 功能项

广场（生图/大模型/视频三类 + 来源筛选 + 搜索 + 无限滚动 40/页 + 详情浮层 + 「去试试」跨 App 跳转）、
我的提示词（新建/编辑/删除 + 从广场导入）、媒体惰性缓存、统计徽标。

### 问题清单

- [x] **[P1] 广场图片绕过统一代理** — `prompt-library.ts:28-34/52-98` 产出第三方 CDN 直链，
  webview 直接 `<img src>` 加载（`prompt-screen.tsx:142-171`），不经过 `bun/proxy.ts` 包装的
  `globalThis.fetch`。只有兜底的 `ensurePromptMedia`（`:358-377`）走主进程。
  代理模式下广场图必然先失败再走兜底，首屏延迟被放大。
- [x] **[P1] 失败路径无 logEvent** — 整个 prompt-library/user-prompt 无 app-log 引用；
  seed 失败仅 `console.warn`（`:203-205`）、下载失败静默 `return false`（`:375`）。
- [x] **[P2] i18n 缺口** — 来源筛选标签（`prompt-screen.tsx:59-74`）与三段分类简介（`:76-80`）直接渲染中文。
- [x] **[P2] 搜索 LIKE 未转义** — `prompt-library.ts:286-289`、`user-prompt.ts:124-127`：输入 `%` 命中全库。
- [x] **[P2] 前后端分页常量不一致** — 前端 `PAGE_SIZE=40`（`prompt-screen.tsx:82`），后端默认 60
  （`prompt-library.ts:257`）。仅因前端每次显式传 limit 才不出错。
- [x] **[P2] `deleteMyPrompt` 恒返回成功且不校验 id** — `user-prompt.ts:239-242`。

---

**本轮核对（工作区已修，无需改动）**：`prompt-library.ts` 已用 `mediaUrl()` 把广场图收敛到本地媒体代理；
种子/媒体下载失败接 `logEvent`；`app/prompt/constants.tsx` 的来源与分类已带 `labelKey`；
`shared/sql-like.ts` 的 `containsLikePattern` 应用于提示词广场与我的提示词；分页常量统一为 `PROMPT_PAGE_SIZE=40`；
`deleteMyPrompt` 校验 id 并在不存在时返回 `{ok:false}`。

---

## 菜单 10/13：Skills 技能

### 功能项

六个页签：我的技能、场景预设、项目管理、工具管理、Git 备份、市场（榜单/搜索/Git 导入/本地导入/扫描收编）。
含同步到 53 个编码工具（symlink/copy）、更新检查、中央库与文件监听。

### 问题清单

- [x] **[P1] 用户可写任意路径进入「删除目标」链路** — `setCustomToolPath`/`addCustomTool` 原样存绝对路径
  （`store.ts:70-86`），`resolveAdapters` 直接 resolve（`:94-120`），UI 是纯文本框（`tools-tab.tsx:189-194`）；
  同步/覆盖时 `deploySkillDir` 会对 `join(adapterSkillsPath(adapter), skillId)` 执行 `rmSync(recursive)`
  （`sync-engine.ts:90-97/146-163`）。对照 AGENTS.md「anything that resolves a user-supplied path must validate it
  against the data directory」。`isOmniDataPath` 目前只被 agent-sandbox/agent-tools 使用。
- [x] **[P1] 整个 Skills 子系统几乎零 logEvent** — `skills/` 目录下仅 `builtin-skills.ts` 有（5 处）；
  `installer.ts:285-288` 市场 clone 失败只回字符串、`skillssh.ts:93/96/109` HTTP 失败直接 throw、
  `central-repo.ts:81-83/158/220-222` 全是空 catch、`git-backup.ts:161-203` 只回 `{ok:false,error}`。
- [x] **[P2] `skillsOpenFolder` 非 central 分支直接打开任意路径** — `rpc/index.ts:4879-4894`。
- [x] **[P2] 死 RPC + 误导性 UI** — `skillsGetCentralInfo`/`skillsSetCentralPath`/`skillsReindex`
  有契约与实现（`rpc/index.ts:2017-2030/4682-4691`）但前端无调用；侧栏 tooltip 写「中央技能库路径」
  而内容是「N 技能 · M 工具」（`skills/sidebar.tsx:52-59`）。
- [x] **[P2] zip/.skill 导入未逐条目校验路径** — 已修：`installer.ts` 在解压前用 `isSafeArchiveEntry` 逐条目校验（`../` / 绝对路径直接拒绝）。
  实际解包后只 `findSkillRoot`，依赖系统 `unzip` 的行为。
- [~] **[P2] 市场搜索固定 60 条无分页** — 上游 skills.sh 搜索 API 只接受 `limit`（上限 300）、无游标，无法真正分页；保留固定上限。

---

**本轮修复**：删掉前端零调用的 `skillsGetCentralInfo` / `skillsSetCentralPath` / `skillsReindex`（契约 + 实现）；
`skillsOpenFolder` 去掉任意 `path` 参数，只允许打开中央库里的技能目录；侧栏 tooltip 由误导性的「中央技能库路径」改为描述数量的 `skills.centralSummary`。
`installLocal` 的 zip/.skill 路径已在解压前用 `isSafeArchiveEntry` 逐条目校验（`bun/skills/installer.ts`）。
市场搜索的固定上限来自上游 skills.sh API（只支持 limit、无游标），属上游限制，保留。

---

## 菜单 11/13：KB 知识库

### 功能项

五个页签：文档（文件/目录/笔记/网页添加、重处理、分块查看）、召回测试、设置（嵌入/重排/检索参数）、
治理（事件流、队列统计、导出导入）、接入（聊天/Agent/MCP 三通道 + 网关）。

### 问题清单

- [x] **[P1] 摄取/向量失败不进 app.log** — `kb-ingest.ts:510-528` 只写 `kb_ingest_jobs.lastError` +
  `kb_events.doc_failed`，`pump()` 外层还 `catch(() => {})`（`:557`）；`knowledge.ts` 全目录无 logEvent。
- [x] **[P2] 文档/分块列表无上限无分页** — `listDocs`（`knowledge.ts:517-526`）、`listChunks`（`:528-553`）
  全量返回，docs-tab 直接 `docs.map`。KB 是唯一完全没有上限的文档列表（目录导入单次 300 文件、可累积）。
- [x] **[P2] 导入操作无结果反馈** — `kbAddFiles` 对不存在路径直接 `continue`（`knowledge.ts:356`）；
  `kbAddFolder` 的 `skipped` 前端丢弃（`docs-tab.tsx:339`）；四个 mutation 都无 `onError`（`:318-361`）。
- [x] **[P2] KB 云模型选择绕开 cloud_providers** — 已收口：KB 表新增 `embeddingProviderId` /
  `rerankProviderId`（迁移 0033，仅新增列、不破坏旧数据），选了云服务商后地址/密钥由主进程从
  `cloud_providers` 行解析（`resolveCloudProvider`，`kb-ingest.ts:embeddingConfigOf` /
  `knowledge.ts:resolveRerankBase/resolveRerankKey`），旧的手填 `embeddingBase/ApiKey`、
  `rerankBase/ApiKey` 仍作为「本地 / 自定义」路径保留；设置页新增「云服务商」选择器（只列已启用且
  该用途下有模型的厂商），选了就不再显示地址/密钥输入。见跨菜单 C。

---

**本轮修复**：摄取 `runJob` 失败/重试接 `kb.ingest.failed` / `kb.ingest.retry`；向量检索退化接
`kb.retrieve.vector_failed`、重排失败接 `kb.rerank.failed`；文档导入四个 mutation 补齐 `onError` 与
「已添加 / 跳过 / 未匹配到文件」反馈（新增 4 条 i18n）；`listDocs`/`listChunks` 加上限并回传 `total`，
界面在截断时明确提示（新增 2 条 i18n）。**KB 云模型已收口**：新增 `embeddingProviderId` /
`rerankProviderId`（迁移 0033），云服务商优先解析地址/密钥，设置页加「云服务商」选择器。

---

## 菜单 12/13：Memory 记忆

### 功能项

统计总览（8 格）、记忆库（分类/状态过滤 + 搜索 + 增删改 + 置顶）、待确认队列、维护（合并/归档/补向量 + 事件流）、
导出导入 JSON、外部 Agent 同步（CLAUDE.md/AGENTS.md 托管区块）、开关、对外接入卡（REST/MCP）。

### 问题清单

- [x] **[P1] 向量化失败静默无日志** — 判重嵌入 `catch {}`（`memory.ts:431-433`）、维护补向量 `catch {}`
  （`:1026-1030`）、事件/指标写入 `catch {}`（`:198-209/212-221`）；`memory.ts` 无 logEvent。
  用户只看到统计里 embedded 不涨，`omi logs` 无线索。
- [x] **[P2] 搜索无防抖** — `memory-tab.tsx:684-692` 每次按键发一次 `memoryList`，命中路径是排序检索
  （`rpc/index.ts:3697-3712`）。对照 prompt 300ms、skills 市场 450ms。
- [x] **[P2] 「置顶」过滤在客户端做** — `memory-tab.tsx:694`，叠加默认 limit 500（`memory.ts:751`）时
  语义是「前 500 条里的置顶」；当前排序恰好置顶优先所以不误伤，但契约脆弱。

---

**本轮修复**：判重嵌入与维护补向量的空 catch 接 `memory.dedupe.embed_failed` / `memory.maintain.embed_failed`（warn）；
搜索框 300ms 防抖（同提示词）；`memoryList` 新增 `pinned` 参数并在服务端过滤，关键词改为 `containsLikePattern` 转义。

---

**本轮修复**：`listBenchmarkRecords()` 恢复完整正文（CLI / 控制通道一次只取前 20 条展示摘要），
新增 `listBenchmarkRecordSummaries()`（轻量元数据 + `total`，上限 500）与 `getBenchmarkRecord(id)`；
界面侧列表只取元数据、结果页按需单条拉正文；`readJsonl` 逐行容错并接 `eval.dataset.bad_lines`；
`ROADMAP.md` OPS-04 修正为 ✅。评测数据集仍整文件读入（各套件 < 10MB，抽样需要全量做按类别采样），记为已知取舍。
另外补一个导出报告的真 bug：`benchmark.export.title/config/footer/generatedAt`（以及新增的 `summary`）词条
从未写进 i18n，导出的 HTML 里直接显示英文 key；「成功/失败」列被 `numCell()` 二次转义成字面量标签。
本轮补齐中英词条 + 修正单元格拼接，新增 `export-html.test.ts` 2 条钉住。

---

## 菜单 13/13：Benchmark 基准测试

### 功能项

测速（本地模型或云端 provider 直连；上下文档位多选 + 生成长度 + 并发 batch）、能力评测（8 套件）、
停止、结果表格 + TPS 图 + 汇总卡、评测结果、历史侧栏（回放/删除/清空）、CLI `omi benchmark`。

### 问题清单

- [x] **[P1] 零 logEvent** — `benchmark.ts`/`eval.ts` 无 app-log 引用；失败只写内存 `state.error` 与
  `benchmark_records.error`（`:741-743/797-799`），题库下载失败抛字符串（`eval.ts:167-171`）。
  长跑几十分钟的失败在 `omi logs` 无痕迹。
  **已修（1M / 缓存维度那次）**：新增 source `benchmark`，事件 `benchmark.run.started` /
  `benchmark.run.finished` / `benchmark.run.failed` / `benchmark.bucket.failed`(warn)，detail 里带
  档位、缓存场景、超窗早停原因；omni-doctor 的 `reference/logs.md` 来源表同步。
  `eval.ts` 的题库下载失败仍只在 run 级事件里体现，没有单独一条。
- [x] **[P2] 历史记录无上限** — `listBenchmarkRecords()` 全量返回且每条带 `rows`/`summary` JSON
  （`benchmark.ts:842-849`），侧栏每次打开全量拉取（`app-sidebar.tsx:347-351` 与 `benchmark-screen.tsx:101-104`
  各一个 query）。
- [x] **[P2] 评测数据集整文件读入内存** — `eval.ts:148-158`。
- [x] **[P2] ROADMAP 漂移** — `ROADMAP.md:163` 记 OPS-04「准确度/质量基准 ❌」，实际已有 eval 模式与 8 个套件。

---

## 收尾：设置页 19 个标签

设置页是并列一级页面（齿轮），19 个标签分 6 组，横跨全部子系统。三项已知点核对如下：

1. **引擎扩展规则**：引擎名列在 `shared/engines.ts`（`ENGINE_SPECS`），端口键 / 附加参数键 / 平台限制 /
   可加载格式 / 市场检索格式都从这里派生；`availableEngines()` 已按 `macOnly` 过滤。
   **本轮修复**：`local-models/engine-selector.tsx` 原先硬编码 `o.value !== "mlx"`，改为
   新增的 `engineOptions(isMac)` —— 以后再加 macOnly 引擎，选择器不会再漏。
2. **`CloudProviderPanel` 的模型类型标注**：面板已有 `ModelCategoryChips` + 添加时的 `dlgType`
   （auto 时由 `modelTypeOf` 推断），逐模型可改类型，无需改动。
3. **`AGENT_PERMISSION_RULES` 与规则链一致性**：`permissions.ts` 的求值链
   （内置默认 → 设置规则 → 工作区规则 → 会话规则）已统一；**本轮修复**发现设置页下拉的
   权限名清单是**另一份会漂移的副本**（漏了 `websearch` / `doom_loop`）。
   现在 `permissions.ts` 导出唯一权威清单 `HUMAN_PERMISSION_LABELS`，
   `getAgentPermissions` 响应新增 `permissionNames`，设置页直接消费（新增 2 条单测钉住）。

---

## 执行顺序

1. ~~第 0 项 验证层~~（已完成，见上）
2. ~~菜单 1 Chat~~（已完成，剩一条跨菜单重复实现挪到菜单 2）
3. ~~菜单 2 Agent → 3 Voice Call → 4 Voice → 5 Image → 6 Video → 7 OCR → 8 Translate
   → 9 Prompt → 10 Skills → 11 KB → 12 Memory → 13 Benchmark → 设置页~~（全部完成）
4. 每个菜单的验收口径：`bun run typecheck` + `bun run lint` + `bun run test` 全绿，
   且该菜单的每条修复要么有新测试钉住、要么在清单里写明手工验证方式。
5. 跨菜单 A/B/C 三类缺口在**每个菜单自己那一节**里清零（不另开「统一整改」的大改动）。

## 进度

| 项 | 状态 | 验证 |
|---|---|---|
| 第 0 项 验证层 | ✅ | 全量 1213 用例 / 0 失败；两道新护栏（helper 契约 + mock 卫生扫描） |
| 1 Chat | ✅ | `chat.test.ts` 15 条、`use-server-message-sync.test.tsx` 3 条、`stores/chat.test.ts` 18 条 |
| 2 Agent | ✅ | `agent-history.test.ts` 18 条（含 planRegenerate 5 条）、`chunk-flusher.test.ts` 6 条；typecheck + lint + 全量绿 |
| 3 Voice Call | ✅ | 增量字幕按 60ms 合并（定稿/阶段/打断/报错前 flush）；TTS 音频分片刻意不节流（追加队列，合并会丢音频），已在代码注释说明 |
| 4 Voice | ✅ | `getTTS/ASRProviderConfig` 不再回传 apiKey；`runTTS` 去掉页面传 `base`/`apiKey` 的覆盖口（地址密钥只从服务商行解析） |
| 5 Image | ✅ | `image-gen.test.ts` 新增 1 条（密钥来源）、`install-log.test.ts` 3 条（终态行判定，含"重试行不算终态"）；typecheck + lint + 全量 1255 / 0 失败 |
| 6 Video | ✅ | `video-gen.test.ts` 新增 2 条（ComfyUI 地址绑定 / 旧记录回落）、`use-video-polling.test.tsx` 2 条；迁移 0032；全量 1270 / 0 失败（连跑两遍） |
| 7 OCR | ✅ | `dialog-paths.test.ts` 4 条；typecheck + lint + 全量 1274 / 0 失败（连跑 4 遍） |
| 8 Translate | ✅ | `live-translate-queue.test.ts` 6 条；typecheck + lint + 全量 1280 / 0 失败（剩一条自建选择器归跨菜单 C） |
| 9 Prompt | ✅ | 广场图走统一代理、失败路径 logEvent、i18n、LIKE 转义、分页常量共享、删除校验（工作区已完成，本轮核对确认） |
| 10 Skills | ✅ | path-safety 收口、5 个文件接 logEvent、删掉 3 个死 RPC、`skillsOpenFolder` 只允许中央库路径；市场搜索受上游 skills.sh API 限制（无游标）保留固定上限 |
| 11 KB | ✅ | 摄取/检索/重排失败接 logEvent、导入结果与错误有界面反馈、docs/chunks 列表加上限并回传总数（截断有提示）、云模型走 cloud_providers（迁移 0033 + 设置页服务商选择器） |
| 12 Memory | ✅ | 判重/维护补向量失败接 logEvent、搜索 300ms 防抖、置顶改服务端过滤 + LIKE 转义 |
| 13 Benchmark | ✅ | 历史列表改轻量元数据 + 单条 `getBenchmarkRecord` 取正文、eval 逐行解析并容忍坏行、ROADMAP OPS-04 状态修正 |
| 设置页 19 标签 | ✅ | 引擎选择器去掉硬编码 mlx（改走 `engineOptions`）；权限名清单收敛到 `HUMAN_PERMISSION_LABELS` + RPC `permissionNames`（新增 2 条单测）；云厂商面板模型类型标注本已具备 |
