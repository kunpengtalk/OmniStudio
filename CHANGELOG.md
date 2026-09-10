# Changelog / 更新日志

All notable changes are documented here. 所有重要变更记录于此。

Format follows [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/), and the project adheres to [Semantic Versioning](https://semver.org/lang/zh-CN/).

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
