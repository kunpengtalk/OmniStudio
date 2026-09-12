<p align="center">
  <img src=".github/assets/logo.png" alt="OmniStudio" width="128" />
</p>

<h1 align="center">OmniStudio</h1>

<p align="center">
  <b>本地大模型一体化桌面工作台</b><br/>
  管理模型、运行推理服务，内置对话 / 语音 / 图片 / 视频 / OCR / 翻译应用，<br/>
  以及本地知识库、共享记忆与 Skills 管理，全程本地优先。
</p>

<p align="center">
  <b>中文</b> · <a href="./README.en.md">English</a>
</p>

<p align="center">
  <a href="https://kunpengtalk.com">官网</a> ·
  <a href="https://kunpengtalk.com/assets/kunpengtalk-studio-demo.mp4">演示视频</a> ·
  <a href="https://github.com/kunpengtalk/OmniStudio/releases/latest">下载</a> ·
  <a href="./CHANGELOG.md">更新日志</a>
</p>

<p align="center">
  ⭐ <a href="https://github.com/kunpengtalk/OmniStudio">Star</a> · License: <a href="LICENSE">MIT</a> · 作者：鲲鹏Talk
</p>

---

## 📸 界面预览

<table>
  <tr>
    <th align="center">模型云服务</th>
    <th align="center">集成 · 编码工具</th>
  </tr>
  <tr>
    <td><img src="docs/images/screenshot-cloud-service.png" alt="模型云服务" width="100%"/></td>
    <td><img src="docs/images/screenshot-integrations.png" alt="编码工具集成" width="100%"/></td>
  </tr>
  <tr>
    <th align="center">语音 · 实时对话</th>
    <th align="center">语音合成 TTS</th>
  </tr>
  <tr>
    <td><img src="docs/images/screenshot-voice.png" alt="语音实时对话" width="100%"/></td>
    <td><img src="docs/images/screenshot-tts.png" alt="语音合成 TTS" width="100%"/></td>
  </tr>
  <tr>
    <th align="center" colspan="2">模型选择 · 引导向导</th>
  </tr>
  <tr>
    <td colspan="2"><img src="docs/images/screenshot-model-chooser.png" alt="模型选择引导向导" width="100%" style="max-width:640px; margin:0 auto; display:block;"/></td>
  </tr>
</table>

---

## ✨ 功能特性

### 模型市集

- **搜索与浏览** — 基于 ModelScope 的模型搜索，仓库文件列表与详情页（参数、大小、下载量、许可证、标签）。
- **全格式下载** — GGUF（llama.cpp）、safetensors（vLLM / SGLang）、bin / pt / ckpt / onnx 等权重；单文件或整仓下载，audio.cpp 的 GGUF 走 HuggingFace 源。
- **下载管理** — 队列并发下载、暂停 / 继续 / 取消、断点续传（HTTP 206）、收藏、多目录存储。
- **能力分类** — 按 Chat / TTS / ASR / Image / Other 自动识别并持久化分类，以徽章与筛选呈现。

### 模型服务

- **首次引导** — 内置 Qwen3.5 4B / 9B / 35B-A3B 与 Qwen3.6 27B 一键模型，选中后自动下载并部署，选完即用；也支持手动输入 HuggingFace GGUF 自定义模型。
- **云端模型服务** — 内置 20 家主流 OpenAI 兼容厂商预设（OmniLabs、DeepSeek、通义千问、智谱 GLM、Kimi、豆包、文心一言、腾讯混元、MiniMax、讯飞星火、零一万物、阶跃星辰、硅基流动、OpenRouter、OpenAI、Anthropic、Gemini 等）；配置以「厂商列表 / 配置详情 / 模型」三栏呈现，多厂商并存、单一点击激活，激活厂商自动写回网关与 `omi` CLI 读取的槽位；支持连通检测与在线拉取模型列表，「默认模型」页集中指定各用途的默认模型。
- **三引擎统一运行时** — llama.cpp（默认：GGUF 本地文件或 HuggingFace，GPU 卸载、KV 缓存量化、多模态 mmproj）、vLLM、SGLang 统一抽象、热切换；也可直连任意 OpenAI 兼容端点（远程模式）。
- **统一网关** — 本地单一端点按模型名路由到本地推理服务或云端 API，同时提供 Chat Completions / Responses / Anthropic Messages 三套协议（含双向工具调用）；可选 API Key 鉴权，内置交互式 OpenAPI 文档，端点 `/v1`、`/health`、`/metrics` 设置页一键复制；另提供 `/mcp` 与 `/v1/memories` 对外暴露知识库与共享记忆。

### 内置应用

全部应用采用统一工作台布局：最左侧图标栏全局切换，应用内左侧参数面板（引擎切换 / 配置 / 输入 / 主操作）+ 右侧结果区，各页体验一致。

- **对话** — 流式回复 + 推理过程展示、图片多模态输入、联网检索（Bing / DuckDuckGo / Tavily，结果注入上下文并标注来源）、文本附件；可挂载本地知识库提问并给出 `[n]` 引用溯源；自动标题、按应用隔离会话、用量统计。
- **语音** — TTS 多来源（audio.cpp 本地引擎、Edge-TTS、OpenAI 兼容 TTS）+ 声音克隆库 + 多引擎 ASR（whisper.cpp / audio.cpp / OpenAI 兼容转写）；实时聆听对话（云端 / 本地），记录库内嵌播放器。
- **图片** — 经云端 OpenAI 兼容 API、ComfyUI 或 Apple Silicon 上的本地 MLX（mflux）引擎生图；MLX 权重生成前预下载并实时显示进度。
- **视频** — 三种后端统一为「提交任务 + 轮询」：MiniMax（H3，云端，支持首帧图生视频）、Seedance（火山方舟内容生成任务 API）、ComfyUI（本地工作流）；提示词 / 负向提示词 / 分辨率 / 时长 / 种子 / 宽高比 / 水印开关与首帧图上传，成片进历史库可直接播放、下载或删除。
- **OCR 文档识别** — 三引擎：本地 Tesseract（一键安装、多语言 LSTM 语言包、词级 / 行级包围盒）、PaddleOCR（PP-OCRv6 本地常驻 worker，medium 档约 140MB）与 VLM（Chandra / GLM-OCR / LightOnOCR）；识别记录入库；上传 PDF / 图片输出结构化 Markdown（GFM 表格、KaTeX 公式、代码块、图注、按包围盒裁剪的图片区域），带文档队列与检索。
- **翻译** — 引擎可切：当前对话模型（本地 / OpenAI 兼容）或 Google 免费接口，22 种语言互译，支持源语言自动检测、语言交换与一键复制；「同传翻译」打开麦克风实时转写（复用 whisper.cpp / audio.cpp / API 三套 ASR 引擎）并同步输出多种目标语言译文。
- **知识库（本地 RAG）** — 导入本地文件（文本直读，PDF / 图片走 VLM OCR）、手写笔记与网页；Markdown 感知切片（标题分节 + 段落贪心打包 + 超长硬切带重叠）+ 可选向量化（OpenAI 兼容 `/v1/embeddings`）+ BM25 与向量的 RRF 混合检索 + 可选重排序（Jina / SiliconFlow / Cohere 兼容 `/v1/rerank`）；召回测试 / 文档 / 访问 / 设置四个标签页；不依赖外部向量库或 FTS 扩展。
- **记忆** — 全 Agent 共享的长期记忆：Agent 经 `memory_search` / `memory_save` / `memory_list` 工具沉淀事实、偏好与经验，置顶与高热记忆注入系统提示；同一份库可经网关 REST `/v1/memories`、MCP 工具或 `omi memory` 命令行读写。
- **Skills 管理** — 中央技能库（默认 `~/.agents/skills`）统一管理并同步到各编码工具，53 个内置工具适配器、symlink / copy 两种同步模式；六区界面：技能市场（skillssh 榜单）、我的技能、预设、项目、工具、备份（Git 远端 + 快照 + 自动备份）。

### 智能体与协议

- **Pi Agent 三模式** — Agent / Plan（只读工具，先出方案再动手）/ Goal；工具集 = 内置文件 / Shell / 检索工具 + 记忆工具 + 已启用 MCP 服务器的工具，Plan 模式自动排除有副作用的工具。
- **MCP 客户端** — 设置页「工具」组管理 MCP 服务器：stdio / Streamable HTTP / 旧版 SSE 三种传输，支持连通检测、工具枚举与 JSON 导入；工具以 `mcp_*` 注入 Agent，连接失败的服务器自动跳过。
- **MCP 服务端** — 本地网关 `POST /mcp`（Streamable HTTP，无状态）把知识库（`kb_search` / `kb_list`）与记忆（`memory_search` / `memory_save` / `memory_list`）开放给 Claude Code / Cursor 等任意 MCP 客户端；浏览器打开 `GET /mcp` 即内置调试工作台（连接 → 枚举工具 → 按 schema 生成表单 → 调用 → 查看原始 JSON-RPC）。
- **共享记忆三通道** — 内置 Agent 工具、网关 REST / MCP、`omi memory` CLI 读写同一个 SQLite 库；`omi launch` 启动编码工具时自动刷新 CLAUDE.md / AGENTS.md 的托管记忆区块，并给 Claude Code / Codex / OpenCode 挂载 `omni-memory` MCP 服务器。

### 运维与遥测

- **实时仪表盘** — 吞吐 / 速度（tok/s）、请求数、活跃模型、内存 / CPU 负载、运行时长与模型磁盘占用（数据目录所在卷的可用 / 总容量），每 2 秒轮询。
- **基准测试** — 上下文长度扫描（1K–200K），记录 TTFT / TPOT / TPS，以表格与图表呈现，支持本地或远程服务。
- **日志查看** — 实时滚动、ANSI 着色、自动滚动与截断保护、复制 / 清空。
- **编码工具集成** — 为 Claude Code（本地 / 云端，Opus–Sonnet–Haiku 三档映射）、Codex、OpenCode、OpenClaw、Hermes、Pi、Copilot CLI 一键生成启动命令并绑定默认模型，并自动接入共享记忆。
- **更新与多语言** — 稳定 / 测试更新通道与应用内更新、自动 / 手动更新检查（关于页可查最新 Release 并跳转下载）、浅色 / 深色 / 跟随系统主题、安装引导向导、中英界面、SQLite 会话持久化。

## 🚀 快速开始

**环境要求**

- [Bun](https://bun.sh) 1.3+
- macOS（Apple Silicon）；Linux / Windows 支持规划中

```bash
bun install

# 开发模式（HMR，推荐）
cd apps/studio && bun run dev:hmr

# 开发模式（无 HMR）
cd apps/studio && bun run dev

# 生产构建
cd apps/studio && bun run build:dev
```

## 💻 omni 命令行（CLI）

`omni` 是封装后端能力的全局命令行工具——启动应用、管理推理服务器、配置云端、唤起模型列表、拉起编码工具、读写共享记忆，**与桌面应用共享同一个数据库**（模型、设置、记忆即时互通）。

```bash
cd apps/studio && bun link    # 安装全局 omni 命令（放进 ~/.bun/bin）
omni --help                    # 查看全部命令
omni help <命令>                # 查看单个命令用法

omni start --server            # 启动应用并拉起推理服务器
omni model                     # 打开应用里的模型列表选模型
omni model list                # 列出已安装模型
omni chat "你好" --reasoning    # 本地/远端对话（自动拉起推理服务器）
omni serve                     # 推理服务器 + 统一网关一体启动（前台长驻，CTRL+C 退出）
omni launch codex --model qwen3-4b-q4_k_m  # 拉起编码工具并接入当前模型（自动挂载共享记忆）
omni memory add "偏好用 pnpm"    # 写入共享记忆（Agent 与 CLI 共用一份库）
omni memory search 构建工具      # 检索记忆
omni memory mcp                # 以 stdio MCP 服务器运行，供编码工具读写同一份记忆
omni doctor                    # 环境体检
omni config get INFERENCE_ENGINE
omni status / omi models / omi stop / omi serve --port 8090
```

原理：应用主进程在数据目录监听 Unix socket（`omni-control.sock`，0600 权限），`omi` 通过该通道唤醒窗口、跳转页面、启停服务器、读写设置；应用未运行时 `models` / `model-info` / `cloud` / `memory` 直接读同一个 SQLite 兜底。帮助：`omi help` 或 `omi <command> --help`，完整手册见 [docs/omni-cli.md](./docs/omni-cli.md)。

## 🧩 技术栈

| 层级 | 技术 |
|---|---|
| 桌面 | [Electrobun](https://blackboard.sh/electrobun) + Bun |
| 前端 | React 19, Tailwind, shadcn/ui, Zustand, TanStack Query |
| AI | Vercel AI SDK (`ai`), `@ai-sdk/openai-compatible` |
| 推理引擎 | llama.cpp, vLLM, SGLang, OpenAI-compatible |
| 语音与 OCR | audio.cpp, whisper.cpp, Tesseract, PaddleOCR, Edge-TTS, VLM |
| 视频生成 | MiniMax (H3), Seedance (火山方舟), ComfyUI |
| 知识库与记忆 | 纯 JS 向量化 + BM25×RRF 混合检索 + `/v1/rerank` 重排（无外部向量库 / FTS）、SQLite 共享记忆 |
| 协议 | MCP（手写客户端 + Streamable HTTP 服务端）、Chat Completions / Responses / Anthropic Messages |
| 数据库 | Drizzle ORM + Bun SQLite |
| 文档处理 | Sharp, pdfjs-dist, @napi-rs/canvas, Cheerio, Turndown |
| 模型市集 | ModelScope OpenAPI, HuggingFace |
| 构建 | Vite, Turborepo, Bun workspaces |
| 代码质量 | oxlint, oxfmt |

## 📁 项目结构

```
apps/
├── studio/               # Electrobun 桌面应用
│   └── src/
│       ├── bun/            # Main process / 主进程
│       │   ├── runtimes/   #   llama.cpp / vLLM / SGLang runtime abstraction 运行时抽象
│       │   ├── vllm/       #   model profiles & endpoints 模型配置与端点
│       │   ├── db/         #   Drizzle schema, migrations, settings 数据库
│       │   ├── skills/     #   Skills manager: central repo, sync, presets, backup 技能管理
│       │   ├── control-server.ts  #   `omi` CLI ↔ 应用控制通道（Unix socket）
│       │   └── ...         #   chat / voice / image / video / OCR / translation / knowledge (RAG) /
│       │                   #   memory / MCP (client + server) / model hub / downloads / stats / updates
│       │                   #   对话、语音、图片、视频、OCR、翻译、知识库、记忆、MCP、模型市集、下载、统计、更新
│       ├── cli/            # `omi` 命令行（bin/omi.ts 入口，复用 bun 数据层与运行时）
│       ├── mainview/       # React UI（components, stores, lib）
│       └── shared/         # shared constants, i18n, engine metadata 共享常量 / 国际化 / 引擎元数据
├── landing/                # marketing site (kunpengtalk.com) 官网
```

## 🗺 Roadmap / 路线图

- [x] Model hub: ModelScope / HuggingFace downloads, queue, categories, favorites 模型市集（下载队列 / 分类 / 收藏 / 多目录）
- [x] Unified llama.cpp / vLLM / SGLang runtime + remote OpenAI-compatible API 三引擎统一运行时 + 远程 API
- [x] Chat / Voice / OCR apps with per-app sessions; voice multi-engine TTS/ASR + cloning + records 对话 / 语音（多引擎）/ OCR 应用
- [x] Dashboard, benchmarks, log viewer, CLI integrations, update channels, i18n 仪表盘 / 基准 / 日志 / 集成 / 更新 / 多语言
- [x] Image generation loop for the Image app 图片应用生图闭环
- [x] `omi` CLI: launch app / server / cloud, model picking, launcher tools, status & logs 命令行 omi（启动应用/服务器/云端、选模型、拉起编码工具、状态与日志）
- [x] AI video generation (MiniMax / Seedance / ComfyUI) with task polling and history AI 视频生成（三后端 + 任务轮询 + 历史库）
- [x] Local RAG knowledge base (hybrid BM25 + vector recall) with chat citations 本地知识库（混合检索 + 对话引用溯源）
- [x] Shared memory across agents (built-in tools, gateway REST / MCP, `omi memory`) 跨 Agent 共享记忆（内置工具 / 网关 / CLI 三通道）
- [x] Skills manager: central repo, 53 tool adapters, presets, Git backup Skills 管理与中央库同步
- [x] MCP both ways: client for external MCP servers + gateway `/mcp` server with playground MCP 客户端与服务端（含调试工作台）
- [ ] Linux and Windows support Linux 与 Windows 支持
- [ ] More document formats (PowerPoint, Word, Excel, etc.) 更多文档格式
- [ ] Memory lifecycle (idle unload, prefault protection), KV cache tiering with SSD offload 内存生命周期与 KV 缓存分层
- [ ] Menu bar / Dock indicators, API key encryption 菜单栏指标 / Key 加密

## 📄 许可证

MIT — by 鲲鹏Talk。见 [LICENSE](LICENSE)。
