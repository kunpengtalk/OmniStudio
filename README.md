<p align="center">
  <img src=".github/assets/logo.png" alt="OmniStudio" width="128" />
</p>

<h1 align="center">OmniStudio</h1>

<p align="center">
  <b>本地大模型一体化桌面工作台</b><br/>
  管理模型、运行推理服务，内置对话 / 语音 / 图片 / OCR / 翻译应用，全程本地优先。
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
- **云端模型服务** — 内置十余家国内主流 OpenAI 兼容厂商预设（DeepSeek、通义千问、智谱 GLM、Kimi、豆包、文心一言、腾讯混元、MiniMax、讯飞星火、零一万物、阶跃星辰、硅基流动、OpenRouter 等）；选择厂商后只需填 API Key，Base URL 自动带出，支持连通检测与在线拉取模型列表。
- **三引擎统一运行时** — llama.cpp（默认：GGUF 本地文件或 HuggingFace，GPU 卸载、KV 缓存量化、多模态 mmproj）、vLLM、SGLang 统一抽象、热切换；也可直连任意 OpenAI 兼容端点（远程模式）。
- **统一网关** — 本地单一端点按模型名路由到本地推理服务或云端 API，同时提供 Chat Completions / Responses / Anthropic Messages 三套协议（含双向工具调用）；可选 API Key 鉴权，内置交互式 OpenAPI 文档，端点 `/v1`、`/health`、`/metrics` 设置页一键复制。

### 五大内置应用

全部应用采用统一工作台布局：左侧栏工具入口 + 左侧参数面板（引擎切换 / 配置 / 输入 / 主操作）+ 右侧结果区，各页体验一致。

- **对话** — 流式回复 + 推理过程展示、图片多模态输入、联网检索（Bing / DuckDuckGo / Tavily，结果注入上下文并标注来源）、文本附件；自动标题、按应用隔离会话、用量统计。
- **语音** — TTS 多来源（audio.cpp 本地引擎、Edge-TTS、OpenAI 兼容 TTS）+ 声音克隆库 + 多引擎 ASR（whisper.cpp / audio.cpp / OpenAI 兼容转写）；实时聆听对话（云端 / 本地），记录库内嵌播放器。
- **OCR 文档识别** — 三引擎：本地 Tesseract（一键安装、多语言 LSTM 语言包、词级 / 行级包围盒）、PaddleOCR（PP-OCRv6 本地常驻 worker，medium 档约 140MB）与 VLM（Chandra / GLM-OCR / LightOnOCR）；识别记录入库；上传 PDF / 图片输出结构化 Markdown（GFM 表格、KaTeX 公式、代码块、图注、按包围盒裁剪的图片区域），带文档队列与检索。
- **图片** — 经云端 OpenAI 兼容 API、ComfyUI 或 Apple Silicon 上的本地 MLX（mflux）引擎生图；MLX 权重生成前预下载并实时显示进度。
- **翻译** — 引擎可切：当前对话模型（本地 / OpenAI 兼容）或 Google 免费接口，22 种语言互译，支持源语言自动检测、语言交换与一键复制。

### 运维与遥测

- **实时仪表盘** — 吞吐 / 速度（tok/s）、请求数、活跃模型、内存 / CPU 负载、运行时长、模型磁盘占用，每 2 秒轮询。
- **基准测试** — 上下文长度扫描（1K–200K），记录 TTFT / TPOT / TPS，以表格与图表呈现，支持本地或远程服务。
- **日志查看** — 实时滚动、ANSI 着色、自动滚动与截断保护、复制 / 清空。
- **编码工具集成** — 为 Claude Code（本地 / 云端，Opus–Sonnet–Haiku 三档映射）、Codex、OpenCode、OpenClaw、Hermes、Pi、Copilot CLI 一键生成启动命令并绑定默认模型。
- **更新与多语言** — 稳定 / 测试更新通道与应用内更新、安装引导向导、中英界面、SQLite 会话持久化。

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

## 💻 omni 命令行工具

`omni` 是封装后端能力的全局命令行工具——模型管理、对话、推理服务器、统一网关、配置读写，**与桌面应用共享同一个数据库**（模型、设置即时互通）。

```bash
cd apps/studio && bun link    # 安装全局 omni 命令（放进 ~/.bun/bin）
omni --help                    # 查看全部命令
omni help <命令>                # 查看单个命令用法

omni model list                # 列出已安装模型
omni chat "你好" --reasoning    # 本地/远端对话（自动拉起推理服务器）
omni serve                     # 推理服务器 + 统一网关一体启动（前台长驻，CTRL+C 退出）
omni doctor                    # 环境体检
omni config get INFERENCE_ENGINE
```

完整手册见 [docs/omni-cli.md](./docs/omni-cli.md)。

## 🧩 技术栈

| 层级 | 技术 |
|---|---|
| 桌面 | [Electrobun](https://blackboard.sh/electrobun) + Bun |
| 前端 | React 19, Tailwind, shadcn/ui, Zustand, TanStack Query |
| AI | Vercel AI SDK (`ai`), `@ai-sdk/openai-compatible` |
| 推理引擎 | llama.cpp, vLLM, SGLang, OpenAI-compatible |
| 语音与 OCR | audio.cpp, whisper.cpp, Tesseract, PaddleOCR, Edge-TTS, VLM |
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
│       │   ├── control-server.ts  #   `omi` CLI ↔ 应用控制通道（Unix socket）
│       │   └── ...         #   chat, voice, OCR, model hub, downloads, benchmarks, stats, updates
│       │                   #   对话、语音、OCR、模型市集、下载、基准、统计、更新
│       ├── cli/            # `omi` 命令行（bin/omi.ts 入口，复用 bun 数据层与运行时）
│       ├── mainview/       # React UI（components, stores, lib）
│       └── shared/         # shared constants, i18n, engine metadata 共享常量 / 国际化 / 引擎元数据
└── landing/                # marketing site (kunpengtalk.com) 官网
```

## 🖥 CLI / 命令行（`omi`）

`omi` 是 OmniStudio 自带的本地命令（参照 [omlx](https://github.com/jundot/omlx) 设计）：启动应用、管理推理服务器、配置云端、唤起模型列表选模型、拉起编码工具。

```bash
cd apps/studio && bun link   # 安装一次，之后可直接用 `omi`
omi start --server           # 启动应用并拉起推理服务器
omi model                    # 打开应用里的模型列表选模型
omi launch codex --model qwen3-4b-q4_k_m   # 拉起编码工具并接入当前模型
omi status / omi models / omi stop / omi serve --port 8090
```

原理：应用主进程在数据目录监听 Unix socket（`omni-control.sock`，0600 权限），`omi` 通过该通道唤醒窗口、跳转页面、启停服务器、读写设置；应用未运行时 `models` / `model-info` / `cloud` 直接读同一个 SQLite 兜底。帮助：`omi help` 或 `omi <command> --help`。

## 🗺 Roadmap / 路线图

- [x] Model hub: ModelScope / HuggingFace downloads, queue, categories, favorites 模型市集（下载队列 / 分类 / 收藏 / 多目录）
- [x] Unified llama.cpp / vLLM / SGLang runtime + remote OpenAI-compatible API 三引擎统一运行时 + 远程 API
- [x] Chat / Voice / OCR apps with per-app sessions; voice multi-engine TTS/ASR + cloning + records 对话 / 语音（多引擎）/ OCR 应用
- [x] Dashboard, benchmarks, log viewer, CLI integrations, update channels, i18n 仪表盘 / 基准 / 日志 / 集成 / 更新 / 多语言
- [x] Image generation loop for the Image app 图片应用生图闭环
- [x] `omi` CLI: launch app / server / cloud, model picking, launcher tools, status & logs 命令行 omi（启动应用/服务器/云端、选模型、拉起编码工具、状态与日志）
- [ ] Linux and Windows support Linux 与 Windows 支持
- [ ] More document formats (PowerPoint, Word, Excel, etc.) 更多文档格式
- [ ] Memory lifecycle (idle unload, prefault protection), KV cache tiering with SSD offload 内存生命周期与 KV 缓存分层
- [ ] Menu bar / Dock indicators, API key encryption 菜单栏指标 / Key 加密

## 📄 许可证

MIT — by 鲲鹏Talk。见 [LICENSE](LICENSE)。
