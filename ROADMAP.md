# OmniStudio 迭代规划与未完成任务清单

> 更新：2026-09-12　结构说明见 [docs/architecture.md](./docs/architecture.md)
> 图例：✅ 已完成 / 🟡 部分完成 / ❌ 未启动　优先级：P0 核心 / P1 重要 / P2 远期
>
> 同步到 GitHub Projects 用 `scripts/create-project-backlog.sh`，数据源是 `scripts/backlog.tsv`。
> 注意：该 TSV 是**一次性导入载荷**（脚本按标题幂等，已存在的 issue 会跳过），导入后看板状态以 GitHub Projects 为准，本文件不再反向同步。

当前完成度概览（截至 0.0.6-canary.0）：

- ✅ **已落地**：仪表盘、网络/服务配置、模型市集 + 下载器（含任务持久化与断点续传）、模型分类、多 App 结构 + 多模态聊天、集成 Launcher（`omi launch`）、基准测试（吞吐）、日志查看器（基础）、更新通道 / i18n、语音工作台（TTS / ASR / 克隆 / 实时通话）、**图片生图闭环**、**视频生成**、**OCR 三引擎 + 文档管线**、**知识库（本地 RAG）**、**共享记忆**、**MCP 客户端 + 服务端**、**Skills 管理**、云端厂商多配置。
- 🟡 **部分完成**：vLLM / SGLang 运行时（参数组装 + 二进制探测 + 安装提示已实现，**仍缺一键安装与实测验证**）、引擎状态 UI（有启停与运行状态，缺版本 / 路径 / 健康度）、性能与内存生命周期、平台支持（配置与发布流程已覆盖 Linux / Windows 构建，未做端到端验证）。
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
| LIE-06 | 引擎状态 UI | 🟡 | `local-engines/llm-panel.tsx` 有引擎配置卡（端口 / 启动参数 / 启停 / 运行状态）；缺版本、路径与健康度 |

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
