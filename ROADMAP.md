# OmniStudio 迭代规划与未完成任务清单

> 更新：2026-09-09　配套：`需求文档.md`（现状核对）、`scripts/create-project-backlog.sh`（一键同步到 GitHub Projects）
> 图例：P0 核心 / P1 重要 / P2 远期

当前完成度概览（与 `需求文档.md` §5 一致）：
- ✅ 已落地：仪表盘、网络/服务配置、模型市集 + 下载器、模型分类、多 App 结构 + 多模态聊天、集成 Launcher、基准测试（吞吐）、日志查看器（基础）、更新通道 / i18n、语音工作台（TTS / ASR / 克隆）。
- 🟡 部分：vLLM / SGLang 运行时（参数组装已实现，待实测验证与安装引导）、性能（调度/KV 量化已归组，内存生命周期未做）。
- ❌ 未启动：**图片 App 生图闭环（核心缺口）**、外观（托盘/Dock）、安全（Key 加密 / 日志脱敏）。

---

## M1 · 生图闭环（P0，最高优先）—— 图片 App 从"占位"到可用

当前 `app/` 下无 `image-screen.tsx`，侧边栏 Image 入口悬空；`components/image.tsx` 只是 Markdown 图片渲染器。`MODEL_PRESETS` 已含 SDXL / Kolors，但生图流程完全未接线。

| # | 任务 | 说明 |
|---|---|---|
| IMG-01 | 图片 App 专属界面 | 生图工作台：模型选择、提示词、参数、结果与历史列表（app/ 下新建 image-screen.tsx） |
| IMG-02 | 生图后端与任务队列 | RPC 封装 `images/generations` + 复用 `bun/queue.ts` 模式做异步任务/进度/重试 |
| IMG-03 | 本地生图引擎接入 | 评估并接入本地图像生成后端（ComfyUI / diffusers 服务器），SDXL / Kolors 模型安装即可用 |
| IMG-04 | 远程生图端点 | 远程模式下直连 OpenAI 兼容 `/v1/images/generations` |
| IMG-05 | 生图参数 UI | 提示词 / 负向提示词 / 步数 / CFG / 尺寸 / 采样器 |
| IMG-06 | 生成历史库 | SQLite 记录提示词与参数，输出图落到本地图片目录，内置查看 / 删除 / 保存到下载 |
| IMG-07 | 模型就绪校验 | image 分类模型选择 + 未安装时引导下载（SDXL / Kolors 预设） |

## M2 · 本地推理引擎交付（P0）—— vLLM / SGLang 从"🟡"到可交付

`runtimes/vllm.ts` 与 `runtimes/sglang.ts` 参数组装已实现，但依赖外部环境有 vllm / sglang 可执行文件，未实测、无安装引导、无失败诊断。

| # | 任务 | 说明 |
|---|---|---|
| LIE-01 | 引擎环境检测 | 检测 vllm / sglang 可执行文件与 Python 环境（复用 `BinaryCheckResult`），缺失时给出安装引导 |
| LIE-02 | 引擎一键安装 | pip/uv 虚拟环境或预编译包方案，安装状态写回设置 |
| LIE-03 | vLLM 运行时实测 | 启动 / 健康检查 / 吞吐验证，参数组装与真实 vLLM 行为对齐并修复差异 |
| LIE-04 | SGLang 运行时实测 | 同上 |
| LIE-05 | 引擎启动诊断 | 失败原因可读透传（缺依赖 / 显存不足 / 端口占用 / 模型格式不符） |
| LIE-06 | 引擎状态 UI | 设置页展示各引擎版本 / 路径 / 健康度，切换引擎前校验可用性 |

## M3 · 性能与生命周期（P1）—— `需求文档.md` §4.7 未落地部分

| # | 任务 | 说明 |
|---|---|---|
| PERF-01 | 空闲超时自动卸载 | 服务器空闲 N 分钟后自动卸载模型 |
| PERF-02 | 预填充内存防护与防护层级 | 验证 llama.cpp `--mlock` 等能力后设计 |
| PERF-03 | 模型回退路由 | 默认模型启动失败时回退到备选模型 |
| PERF-04 | KV 缓存热/冷分层与 SSD 溢出 | 缓存分层 + SSD 溢出目录，先做能力验证 |
| PERF-05 | 分块预填充 / 预填充优先级 | 按引擎支持情况接入设置 |

## M4 · 运维增强（P1）—— 日志 / 基准 / 统计补齐

| # | 任务 | 说明 |
|---|---|---|
| OPS-01 | 日志查看器：日志文件多文件切换 | server.log 按天/大小分片，可切换 |
| OPS-02 | 日志查看器：最近 N 条筛选 | 显式条数筛选 |
| OPS-03 | 基准测试：batch × ctx 扫描矩阵 | 当前一趟固定 batch，改矩阵扫描 |
| OPS-04 | 基准测试：准确度 / 质量基准 | 除吞吐外的质量维度 |
| OPS-05 | 服务统计：逐模型显存 / VRAM | `/slots` 增强，补齐 OMLX 有但我们缺的项 |
| OPS-06 | 服务统计：GPU 温度与显存锁定量 | |

## M5 · 工程与平台（P1 / P2）

| # | 任务 | 说明 | 优先级 |
|---|---|---|---|
| ENG-01 | 下载任务持久化 | 队列现为内存态，重启丢失活跃/排队任务 | P1 |
| ENG-02 | `vllm-studio launch <tool>` 子命令 | 集成页命令现在只能预览/复制，落地可执行 CLI | P1 |
| ENG-03 | 网络页：Anthropic / Claude Code 端点展示 | 现在并入集成页，未单独列出 | P2 |
| ENG-04 | TopK / repeat penalty 设为 UI 参数 | 目前 repeat penalty 取自模型 profile 的 serverArgs | P2 |
| ENG-05 | 模型库扩展目录选择器 | 现为手输文本，改目录选择 | P2 |
| ENG-06 | Linux 平台支持 | README 规划中 | P2 |
| ENG-07 | Windows 平台支持 | README 规划中 | P2 |

## M6 · 远期（P2，Phase 5）

| # | 任务 | 说明 |
|---|---|---|
| FUT-01 | 菜单栏 / Dock 托盘指标 | 先评估 Electrobun 系统托盘 / 菜单栏 API 支持度 |
| FUT-02 | API Key 加密存储 | macOS Keychain / 系统凭据，远端 Key 不回显 |
| FUT-03 | 日志脱敏 | 打印前脱敏 |
| FUT-04 | 本地引擎音频能力评估 | 语音工作台目前依赖外部 `/v1/audio/*` 服务 |

---

## 迭代节奏建议

- **M1 + M2 先并行**：生图闭环（IMG-01/02/04）与本地引擎交付（LIE-01/03/04）是用户可见价值最大的两块，也是最典型的"推理引擎没集成"缺口。
- 每个里程碑结束跑一次回归：`cd apps/studio && bun run build:dev` + 手工过 P0 路径（聊天 → 生图 → OCR → 语音）。
- 同步方式：`scripts/create-project-backlog.sh` 会按本文件内容把所有任务写入 GitHub Projects（附优先级 / 里程碑 / 状态字段）。
