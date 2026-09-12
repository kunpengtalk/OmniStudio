# Changelog / 更新日志

All notable changes are documented here. 所有重要变更记录于此。

Format follows [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/), and the project adheres to [Semantic Versioning](https://semver.org/lang/zh-CN/).

## [0.0.6-canary.0] - 2026-09-12

### Added / 新增

- **AI 视频生成（新应用）**：左侧图标栏新增「视频」应用，三种后端统一为「提交任务 + 轮询」异步模式——MiniMax（H3，云端，支持首帧图生视频）、Seedance（火山方舟内容生成任务 API）、ComfyUI（本地工作流）；5 秒轮询任务状态，成片落盘后进历史库（新表 `video_records`，迁移 `0019_add_video_records`），结果区可直接播放 / 下载 / 删除，参数面板支持提示词、负向提示词、分辨率、时长、种子与首帧图上传。
- **Skills 管理（新应用）**：图标栏新增「Skills」应用，中央技能库（默认 `~/.agents/skills`）统一管理并同步到各编码工具；六区界面：技能市场（skillssh 榜单 + 一键安装 / 批量导入）、我的技能（启用 / 分组 / 标签 / 批量操作）、预设（技能集合一键套用到多个 Agent）、项目（按项目目录管理技能）、工具（53 个内置工具适配器 + 自定义工具 + 路径覆盖）、备份（Git 远端 + PAT、自动快照、快照列表）；支持 symlink / copy 两种同步模式、技能文档查看、审计日志与元数据同步。
- **知识库 / 本地 RAG（新应用）**：图标栏新增「知识库」应用——数据源摄取（本地文件（文本直读，PDF / 图片走 VLM OCR）、手写笔记、网页抓取）、Markdown 感知切片（标题分节 + 段落贪心打包 + 超长硬切带重叠）、可选向量化（OpenAI 兼容 `/v1/embeddings`，Float32 base64 存在分块行）、混合检索（BM25 关键词与余弦向量各自排序后 RRF 融合，不依赖外部向量库或 FTS 扩展）；四个标签页（召回测试、文档、访问、设置）；对话界面挂载知识库后回答带 **[n] 引用溯源**（迁移 `0017_knowledge_base`，引用随消息落库）。
- **知识库 · 重排序（Rerank）**：每个知识库可配置 Jina / SiliconFlow / Cohere 兼容的 `/v1/rerank` 二次排序模型（模型 / Base URL / API Key 三项，可从服务端拉取模型列表）；混合检索的候选按重排得分再次排序，召回落点标注「已重排」与相关性得分；未配置时保持原序，功能自动退化。
- **记忆层（新应用 + 全 Agent 共享）**：图标栏新增「记忆」应用；Agent 经 `memory_search` / `memory_save` / `memory_list` 工具沉淀事实 / 偏好 / 经验 / 技能，与手工录入同库（迁移 `0018_strong_corsair`）；置顶与高热记忆作为「常驻核心记忆」注入 Agent 系统提示（`MEMORY_ENABLED` 总开关）；记忆对外三条通道——网关 REST `/v1/memories`（GET 检索 / POST 写入 / DELETE 删除）、网关 MCP `memory_*` 工具、`omi memory add|search|list` CLI；`omi launch` 启动编码工具时自动刷新工具上下文文件（CLAUDE.md / AGENTS.md）的托管区块，并给 Claude Code / Codex / OpenCode 挂载 `omni-memory` MCP 服务器（在应用外用 `memory_save` 实时写回同一个库）。
- **MCP 客户端与调试工作台**：设置页新增「MCP」工具组，支持 stdio（换行分隔 JSON-RPC）/ Streamable HTTP / 旧版 SSE 三种传输的手写客户端（不引入 SDK，避免 Electrobun 自定义 Bun 运行时的 node 兼容层风险），服务增删改查、连通检测与工具枚举；已启用服务器的工具以 `mcp_*` 注入 Agent（连接失败的服务器自动跳过，Plan 模式不注入有副作用的工具）；网关同时提供 **MCP 服务端**——`POST /mcp`（Streamable HTTP，无状态），对外暴露知识库 `kb_search` / `kb_list` 与记忆 `memory_search` / `memory_save` / `memory_list`，浏览器 `GET /mcp` 打开单文件调试工作台（连接 → 枚举工具 → 按 inputSchema 生成表单 → 调用 → 看原始 JSON-RPC）。
- **模型云服务重构**：云端厂商配置从设置键迁移到 `cloud_providers` 表（迁移 `0015_slippery_vulture`）——多服务商配置并存、单一「激活」，激活行的 Base URL / API Key / 模型列表同步写回 `VLLM_API_BASE` / `VLLM_API_KEY` / `CLOUD_MODELS` 等旧槽位，网关、`chat-model`、`omi` CLI 与集成模型选择器零改动；设置页改为参照 Cherry Studio 的**三栏面板**（厂商列表 / 配置详情 / 模型），内置 20 家厂商预设（16 家彩色品牌 Logo，OpenAI / Anthropic / Gemini 用官方单色 path，未收录的回退字母徽章），并新增「默认模型」页集中指定各用途的默认模型；旧数据（`CUSTOM_PROVIDERS` / `CLOUD_MODELS`）首次读取时自动迁移入表。
- **实时仪表盘（重做）**：`server-stats` 替换为新的仪表盘页——吞吐 / 速度（tok/s）、请求数、活跃模型、内存 / CPU 负载、运行时长与**模型磁盘占用**（`statfs` 读数据目录所在卷的可用 / 总容量），每 2 秒轮询。
- **主题与更新检查**：新增 `UI_THEME` 设置（system / light / dark，跟随系统并监听变化，作用于 `<html>` 的 `.dark` 类）与 `AUTO_UPDATE` 开关；「关于」页新增版本与 GitHub Release 检查（匿名 API 结果缓存 10 分钟避免限流，按通道比较版本并提示更新，可一键跳转下载）。
- **OCR · PP-OCRv6 本地引擎（PaddleOCR）**：新增第三套本地 OCR 引擎，走 ONNX / PaddlePaddle CPU 装入独立 venv（`userData/engines/paddleocr`），主进程启动常驻 Python worker（`ppocr-worker.py`，JSON-lines stdio 协议），模型加载一次常驻内存、识别不阻塞界面；内置 PP-OCRv6 **medium** 档（约 140 MB，34.5M 参数）一键安装与首载自动下载，安装日志与加载 / 识别阶段实时推送到界面，全程离线无需 API Key。
- **OCR · 三引擎补全与模型详情**：Tesseract（一键安装 + 多语言 LSTM 语言包）/ PaddleOCR / VLM 三个引擎页签补齐引擎状态、安装与下载进度、识别记录；模型详情改为原地打开（不再跳页）。
- **翻译 · 同传翻译**：翻译页新增「同传翻译」——打开麦克风实时转写（复用 whisper.cpp / audio.cpp / OpenAI 兼容三套 ASR 引擎），并同步输出多种目标语言译文同屏滚动。

### Changed / 变更

- **工具页布局统一**：OCR / 图片 / 翻译 / 语音等工具页统一为「侧栏工具入口 + 左参数面板（引擎切换 / 配置 / 输入 / 主操作）+ 右结果区」，替换原先各自为政的页内切换方式。
- **设置页按组重构**：单文件设置页拆分为偏好组（通用 / 外观）、工具组（MCP / 记忆 / 联网搜索 / 云服务 / 默认模型）与「关于」页，配套抽出共用表单组件（`setting-ui.tsx`）与厂商图标表（`provider-logos.ts`）。
- **导航**：应用图标栏新增视频 / Skills / 知识库 / 记忆四个入口，Agent 图标改为 `CircuitBoardIcon`；各应用按统一工作台布局（左侧参数面板 + 右侧结果区）排布。
- **对话**：发送消息可挂载知识库（`kbIds`）并在重新生成时复用检索；assistant 消息新增 `citations` 字段承载引用溯源。
- **网关文档**：OpenAPI 补充 `/v1/memories`、`/mcp` 端点说明；`/v1/models` 聚合不变。
- **`omi` CLI**：新增 `omi memory`（`add` / `search` / `list` / `mcp`）——应用运行时走控制 socket（`memoryAdd` / `memorySearch` / `memoryList`），未运行时直连 SQLite；`omi help memory` 有完整用法。
- **SQLite 并发**：数据库启用 WAL、`busy_timeout=5000` 与 `synchronous=NORMAL`，支撑 `omi memory` / MCP 桥接在应用之外直连同一个库读写。
- **媒体分发**：图片服务器为视频容器补全 MIME（`.mp4` / `.webm` / `.mov` / `.mkv` 返回 `video/*`，成片可用 `<video>` 播放）。
- **国际化**：中英双语词条补齐新应用与设置页（`shared/i18n.ts` 新增 1255 行）。

### Fixed / 修复

- **迁移 0013 在老库升级时被跳过**：drizzle 以「库内已记录的最大 `created_at`」判断是否跳过迁移，而 `0013_uneven_lester` 的 `when` 小于前一条 `0012`，导致从旧版本升级的用户（库内最大 `when` 已被后续迁移抬高）**不会建出 `user_prompts` 表**，「我的提示词」功能直接报错；现将其 `when` 调整为严格递增区间内，并把该迁移改写为幂等 DDL（`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`），使「已建表 / 曾被跳过 / 已升到最新」三种库都安全。
- **知识库向量补齐**：`embedDocChunks` 内改为循环外复制一份配置对象（原写法在循环中展开累加，且可能污染调用方传入的对象）。

### Internal / 内部

- 新增迁移：`0014_talented_network`（Skills 预设工具开关 `preset_skill_tools`）、`0015_slippery_vulture`（`cloud_providers`）、`0016_lean_turbo`（`mcp_servers`）、`0017_knowledge_base`（`knowledge_bases` / `knowledge_docs` / `knowledge_chunks`）、`0018_strong_corsair`（`memories`）、`0019_add_video_records`（`video_records`）、`0020_kb_rerank`（`knowledge_bases` 增加重排模型 / Base / Key 三列）。
- 新增主进程模块：`video-gen.ts`、`cloud-providers.ts`、`mcp.ts`、`mcp-playground.ts`、`kb-mcp.ts`、`knowledge.ts`、`memory.ts`、`memory-api.ts`、`memory-sync.ts`、`release-check.ts`、`skills/`（13 个文件：中央库 / 安装器 / 同步引擎 / 扫描 / 元数据 / 预设 / 项目 / 审计 / 备份等）。
- 新增前端：`video-screen.tsx`、`dashboard-screen.tsx`、`memory-screen.tsx`、`kb/`（6 个文件）、`skills/`（9 个文件）、设置页各组面板与 `stores/{video,kb,memory-ui,skills}.ts`。
- 新增脚本：`apps/studio/scripts/migrations-smoke.ts`（journal 单调性 + 全新库建表 + 重复打开幂等；本次正是它先暴露出 0013 的 `when` 倒挂）。
- README 界面预览截图更新（模型云服务 / 编码工具集成 / 语音实时对话 / TTS / 模型选择向导），中英两份 README 同步重写。
- 依赖：无新增运行时依赖（MCP 客户端手写、向量检索纯 JS、调试工作台单文件无 CDN）。

## [0.0.5-canary.0] - 2026-09-11

### Added / 新增

- **提示词库 ·「我的提示词」（My Prompts）**：新增「我的」分区，支持手动新建提示词、从「广场」一键「加入我的提示词」；按 `source_key` 记录来源并防重复导入 / 判断「已加入」；支持自定义分类（空值统一归「未分类」）；卡片 / 详情浮层与广场复用同一行模型。新表 `user_prompts`（迁移 `0013_uneven_lester`）。
- **提示词库 · 广场浏览增强**：广场支持按来源（image / video 题库来源）筛选 chips、滚动到底部自动加载更多（广场 / 我的 共用）；封面图「云端直链 → 加载失败惰性下载本地缓存 → 渐变占位」三级兜底。
- **图片 App · MLX 常驻生图 Worker**：本地生图改为常驻 worker（`mlx-worker.py`，模型加载一次、反复生成，通常几秒出图）；界面分步展示「启动 / 加载 / 生成 n/N / 完成」阶段事件（`onMlxGenPhase`），可一键停止释放显存。
- **图片 App · MLX 下载进度持久化**：模型权重下载进度全程磁盘持久化（`userData/mlx-downloads/<modelId>.json`），界面据此展示「继续下载（已下载 X%）」，重启不丢进度。
- **语音 TTS · OpenAI 兼容服务多行配置**：配置面板改为多行表单（配置地址 / API 密钥 / 音频模型下拉）；内置主流服务商预设（OmniLabs / OpenAI / 豆包 / 通义千问 / DeepSeek / 智谱 / Kimi / 腾讯混元 / 百度千帆 / 讯飞星火 / MiniMax / 硅基流动 / OpenRouter），选厂商自动带出地址；地址默认填线上 OmniLabs（`omnilabs.vibeadmin.cn`）；音频模型改为可搜索下拉（内置 + 「获取模型」拉取的 `/v1/models`）。
- **语音 TTS · 参考音频（声音克隆）**：右侧按模型能力显示「参考音频」——支持参考音频的模型可上传（内联 base64 进 `/v1/audio/speech` 的 `reference_audio` 字段），不支持的自动收起；提供「此模型支持参考音频」开关手动覆盖（默认跟随自动检测，可一键「恢复自动」）；OmniLabs 线上地址默认视为支持。

### Changed / 变更

- **提示词库 · 媒体分发**：封面 / 视频媒体改为优先本地缓存、否则走 Image2Hub 镜像云端直链（`mediaUrl` / `promptMediaCloudUrl` / `promptLibraryLocalUrl`）；下载内容做魔数校验确认确为图片，少数特例回退到从案例页解析真实媒体地址。
- **语音 TTS 右侧**：移除对云端模型不适用的静态音色 chips（alloy/echo/…），改为自由文本音色输入 + 按模型的参考音频上传；参考音频落库 `voice_records.ref_audio_path`。

### Fixed / 修复

- **网关 · /v1/models 自引用死循环**：当 TTS Provider 地址被填成网关自身（如 `http://127.0.0.1:10001`）时，`/v1/models` 聚合会递归调用自身、挂起 ~10s 后断连；新增 `isSelfBase()` 防护，聚合 / 转发时跳过指向网关自身的 Provider。

### Internal / 内部

- DB：新增 `user_prompts` 表（迁移 `0013_uneven_lester`）。
- RPC：新增「我的提示词」CRUD、MLX 常驻 worker 启停 / 阶段事件 / 下载进度相关方法；`runTTS` 新增 `referenceAudioRef` 参数。
- 新增 `shared/tts-reference-audio.ts`（参考音频字段名常量 + 能力检测，前后端共用）、`voice-provider-presets.ts`（音频服务商预设）、`bun/user-prompt.ts`（我的提示词数据层）、`stores/mlx-model-run.ts`（常驻生图前端状态）。
- 设置：`TTS_PROVIDER_BASE` / `ASR_PROVIDER_BASE` 默认值改为线上 OmniLabs 地址。

---

## [0.0.4-canary.0] - 2026-09-10

### Added / 新增

- **导航 · 左侧图标栏（App Rail）**：新增最左侧 48px 常驻图标栏，负责全局应用切换（对话 / 语音 / 图片 / OCR / 翻译 + 设置），替代原侧边栏头部的应用切换网格；侧边栏不再支持折叠，专注各应用的记录列表（会话 / 图片 / 翻译）。跟随 PRD `docs/prd-app-rail-navigation.md`。
- **网关 · API Key 鉴权**：网关新增 `GATEWAY_API_KEY` 设置，支持 `Authorization: Bearer` 与 `x-api-key`（兼容 Anthropic 客户端）；`/v1/*` 需鉴权，`/health`、`/docs`、`/openapi.json` 保持开放。设置页新增 API Key 配置卡（生成 / 清除 / 保存）。
- **网关 · Anthropic Messages API**：新增 `/v1/messages` 端点，完整双向协议（system / 图片 content block / 工具调用双向转换），支持流式（`message_start → content_block_delta → message_stop`）与非流式。
- **网关 · OpenAI Responses API**：新增 `/v1/responses` 端点，支持 `instructions` / `input` / 函数调用项，流式事件序列（`response.created → output_text.delta → response.completed`）。
- **网关 · 对话后端路由**：`/v1/chat/completions` 按模型 ID 自动在本地推理服务器与云端 OpenAI 兼容 API 之间路由。
- **网关 · TTS 四段回退链**：本地 audio.cpp → 推理服务器 → 三方 TTS Provider → Edge 在线 TTS 兜底。
- **对话 · 思考过程（Reasoning）**：流式推送 `reasoning_content` 并用可折叠的 ReasoningBlock 展示（流式时展开自动滚动，结束后自动折叠），思考过程持久化到消息（DB 迁移 `0008_add_message_reasoning`）；自动剥离模型误输出的 `...` / ` response` 残留标签。
- **对话 · 当前时间注入**：每次推理注入当前日期 / 时区系统消息（仅本次请求，不落库），避免模型按训练数据旧日期回答"今天"类问题。
- **对话 · 搜索词改写**：开启联网检索时先调用模型把提问改写成搜索关键词（10s 超时，失败回退正则清洗），搜索结果按实际搜索词注入。
- **翻译 · Google 免费引擎**：新增 `google-engine` 免费翻译选项（gtx 接口，自动探测 macOS 系统代理），与模型翻译可在界面切换；新增翻译历史记录（`translation_records` 表，迁移 `0009_add_translation_records`），侧边栏展示历史列表，支持加载回填 / 删除。
- **图片 · 最近生成条 + 全部历史页**：生成结果区底部新增横向滚动的"最近生成"缩略条（前 6 张），可一键进入全部历史页（响应式网格、尺寸角标、prompt 预览、下载 / 删除二次确认）。
- **设置 · 云端厂商面板重构**：云端模型配置改为 macOS 源列表风格双栏（厂商列表 / 配置详情卡片），模型列表聚合已保存 + 厂商预设模型，点击即设为当前。
- **设置 · 联网搜索新增 Brave** 提供方（`X-Subscription-Token`，每月 2000 次免费额度），默认 provider 改为 Bing；`WEB_SEARCH_ENABLED` 默认开启。
- **设置 · OmniLabs 厂商**：`REMOTE_PROVIDERS` 新增 OmniLabs 预设（统一接入 TTS / ASR / LLM / OCR）。
- **MLX 生图 · 下载完整性权威校验**：改用 venv 内 `mlx-model.py check`（逐文件 + 字节数校验）替代原文件系统浅检查，`isMlxModelDownloaded` / `getDownloadedMlxModels` 异步化；下载前清理同模型孤儿进程，避免 HF 缓存锁冲突。
- **数据目录抽象**：新增 `paths.ts` 的 `getDataDir()`，支持 `OMNI_DATA_DIR` / `OMNI_DB_PATH` 环境变量短路（供 `omni` CLI 等独立进程指向打包应用数据目录），并迁移 image-server / modelscope / ocr / tts-local / whisper-engine / mlx-gen 全部路径读取。
- **网关测试套件**：新增 `gateway.test.ts` 完整测试（约 744 行）——生命周期、元信息端点、`/v1/models` 聚合、OpenAI / Anthropic / Responses 三套协议含工具调用双向转换与流式事件、TTS 回退、API Key 鉴权。

### Changed / 变更

- **网关 · 模型列表聚合**：`/v1/models` 现在聚合本地对话模型 + 云端对话模型 + TTS / ASR 可用模型 + `omni-*` 能力别名（带 `task` / `owned_by` / `description` 元数据，按 ID 去重）；OpenAPI 文档升级到 1.1.0。
- **翻译界面重排**：双栏改为两张卡片布局（header + 无边框 textarea 撑满），引擎选择器内联到顶部工具栏，翻译中右侧卡片遮罩 spinner，新增"新翻译"重置与语言交换时原文 / 译文对调。
- **RPC**：请求超时从 10 分钟放宽到 60 分钟（为 MLX 大权重下载兜底）；`chatChunk` / `chatDone` 事件新增 `kind` / `reasoning` 字段；新增 `generateGatewayKey`、`listTranslationRecords`、`deleteTranslationRecord` RPC。
- **侧边栏**：`collapsible` 改为 `none`，移除折叠触发器与相关动画；翻译侧栏从占位升级为真实历史记录列表。

### Fixed / 修复

- MLX 模型权重下载中途掉线 / 崩溃后，残留下载进程与未完成文件导致后续下载报"退出码 2"的问题。
- ASR / TTS 远端回退：推理服务器返回 404 / 501 时不再直接报错，而是继续走下一级回退。

### Internal / 内部

- DB：`messages` 表新增 `reasoning` 列；新增 `translation_records` 表；settings 新增 `GATEWAY_API_KEY`、`TRANSLATION_ENGINE`。
- 新增主进程 `paths.ts`；`web-search.ts` 新增 Brave provider 并归一化 provider 归一化（未知值回落 bing）。

---

## [0.0.3-canary.3] - 2026-09-09

### Added / 新增

- **翻译 App（Translate）**：侧边栏新增第 5 个内置应用「翻译」。通过当前对话模型（本地推理服务器 / OpenAI 兼容 API）进行文本翻译，支持 22 种语言目录、源语言自动检测、语言交换、一键复制与译文字数统计。
- **对话 · 联网检索（Web Search）**：对话输入框新增联网检索开关；开启后先搜索用户最新提问，再把搜索结果作为系统上下文注入模型，并标注来源。支持 Bing（免 Key）、DuckDuckGo（免 Key）、Tavily 三种搜索服务，可在设置页配置 provider / API Key / 结果条数与「默认开启」。
- **对话 · 文本附件（File Attachments）**：对话可附加文本 / 代码文件（`.txt .md .json .py .ts` 等白名单类型）。文件内容以 text part 注入上下文参与推理，不落库。单个文件上限 512KB，自动过滤不可读 / 超限 / 非文本文件。
- **图片 App · MLX 模型权重预下载**：本地生图引擎新增模型权重的检测 / 预下载 / 进度流，下载完成后方可生成，避免生成中途才拉取权重。进度通过 RPC 实时推送到界面（实时下载百分比、文件数与字节）。
  - 新增主进程辅助脚本 `mlx-model.py`（复用 mflux 的 ModelConfig + WeightDefinition 解析仓库与文件规则，与安装的 mflux 版本严格一致）。

### Changed / 变更

- **OCR 页面排版**：识别提取页（Tesseract / VLM）改为与「图片 App」一致的双栏布局——左侧固定宽度参数 / 配置面板，右侧独立结果区；顶部保留「识别提取 / 文档处理」菜单。结果区在无结果时显示居中空态图标与提示。
- **对话消息组装重构**：`sendMessage` 抽取 `buildPayloadMessages`，统一组装历史消息、图片、文本附件与联网检索上下文（附件与检索结果均只注入本次请求，不写入历史库）。
- **侧边栏**：App 切换网格由 4 列调整为 5 列以容纳翻译应用；翻译应用在侧边栏有独立的导航分组占位。

### Fixed / 修复

- 本轮修复了语音工作台的多处交互细节（TTS / ASR / 克隆面板重构、录音与实时转写联动），并统一了对话 / 图片入口的应用路由渲染（`renderActiveApp` 收敛了原先的重复分支）。

### Internal / 内部

- 新增 `translate.ts`、`web-search.ts` 共享 / 主进程模块，以及 `mlx-model-download.ts` 前端进度 store。
- RPC 新增 `runTranslation`、`stageChatFiles`、`downloadMlxModel`、`getDownloadedMlxModels`，并新增 `mlxModelDownloadProgress` 事件推送。

---

## [0.0.3-canary.2] - 2026-09-09

> 参见 Git 历史提交 `1e1b0ed`。

---
