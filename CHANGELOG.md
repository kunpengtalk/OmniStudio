# Changelog / 更新日志

All notable changes are documented here. 所有重要变更记录于此。

Format follows [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/), and the project adheres to [Semantic Versioning](https://semver.org/lang/zh-CN/).

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
