# OmniStudio 架构

面向维护者的结构说明：**东西在哪、为什么这么切、改哪里会踩到谁**。

- 功能与用法见 [README.md](../README.md)
- 迭代计划与未完成任务见 [ROADMAP.md](../ROADMAP.md)
- 命令行手册见 [omi-cli.md](./omi-cli.md)
- 给 AI 编码助手的精简版约定见 [AGENTS.md](../AGENTS.md)

---

## 1. 定位与技术形态

一个**单体式本地 AI 工作台**：所有能力都在本机，没有服务端组件。联网只发生在两类场景——下载模型权重（ModelScope / HuggingFace），以及调用用户自己配置的云端厂商 API。

| 层 | 选型 |
| --- | --- |
| 桌面外壳 | Electrobun（**不是 Electron**，不要用 Electron API） |
| 主进程 | Bun 1.3（全部后端：进程编排、SQLite、HTTP 服务、媒体管线） |
| 前端 | React 19 + Tailwind + shadcn/ui + Zustand + TanStack Query |
| 主↔前端通信 | Electrobun RPC（单份类型契约，双向） |
| 数据库 | Drizzle ORM + SQLite（WAL） |
| 构建 | Vite + Turborepo + Bun workspaces |

仓库是 Bun workspaces + Turborepo 的 monorepo，但 `packages/*` 目前为空 —— 实际只有 `apps/studio`（桌面应用）和 `apps/landing`（官网静态站）两个 workspace，两者互不依赖。

## 2. 进程模型

理解这个项目最关键的一点：**复杂度不在代码分层，而在进程边界**。一共五类进程。

```
┌─ Webview（React）──────────────────────────────────────────┐
│  app-rail（12 个应用）→ app-sidebar → 各 Screen             │
│  Zustand（25 个 store）+ TanStack Query + 全局 rpcClient    │
└───────────── RPC（Electroview defineRPC，双向）────────────┘
┌─ Bun 主进程 ───────────────────────────────────────────────┐
│  rpc/index.ts —— RPC 契约定义 + 全部 handler                │
│  ├ 智能层   agent / chat / mcp / memory / knowledge / skills │
│  ├ 推理层   server-manager → runtimes/{llama,vllm,sglang,mlx}│
│  ├ 模型层   model-store / download-manager / modelscope      │
│  ├ 媒体层   ocr·ppocr / asr·tts / image-gen / video-gen      │
│  └ 服务面   gateway / image-server / control socket          │
└──────────── Drizzle + SQLite（WAL）─────────────────────────┘
        ↕ Bun.spawn（全部 detached 独立进程组）
  Python 常驻 worker   mlx-worker.py（生图）、ppocr-worker.py（PP-OCR）
  Python 一次性脚本    mlx-model.py（MLX 权重下载 / 校验）
  引擎二进制           llama-server / vllm / sglang / mlx_lm
                       / whisper-server / audiocpp_cli
                       / tesseract / mflux（独立 venv）
```

Webview 里没有任何业务逻辑与 IO —— 它只通过 RPC 请求数据、消费推送事件。所有文件读写、网络请求、子进程管理都在主进程。

**主进程启动顺序**（[src/bun/index.ts](../apps/studio/src/bun/index.ts)）体现了模块依赖：

1. `./user-data` 最先导入，把 userData 目录写进 `OMNI_DATA_DIR`
2. `./db` 打开 SQLite 并跑迁移
3. 提示词种子灌入、Agent 默认工作区、Skills 中央库初始化、MCP 服务器预热（后台，失败静默）
4. 图片服务（端口被占时降级，不让主进程崩）
5. 建窗口 → 挂 9 个广播通道 → `dom-ready` 时补推状态（HMR 刷新后 store 会重置）
6. 控制 socket → 自动检查更新 → 按设置自动启推理服务与网关

关闭时反向收尾（`stopServer` / `stopAsr` / `stopGateway` / `stopPpOcr` / `shutdownSkills` / `stopControlServer`），并有 `SIGTERM` 与 `uncaughtException` 兜底杀进程组。

## 3. 仓库布局与依赖规则

```
apps/
├── studio/
│   ├── bin/omi.ts              # CLI 入口（4 行，转发给 src/cli）
│   ├── electrobun.config.ts    # 打包配置：views 资源、Python 脚本、原生包
│   ├── scripts/                # 冒烟脚本（KB / 记忆 / 视频 / 迁移 / CLI 手册）
│   ├── tests/                  # 需要 fixture 文件的测试
│   └── src/
│       ├── bun/                # 主进程（见 §4）
│       ├── shared/             # 双端共享：类型契约、常量、i18n 词典
│       ├── cli/                # omi CLI（独立进程，不在应用内）
│       ├── mainview/           # React 前端
│       │   ├── app/            # 各 Screen
│       │   ├── components/     # 通用组件 + shadcn/ui
│       │   ├── stores/         # 25 个 Zustand store
│       │   └── lib/            # rpc 客户端、工具函数
│       └── components/         # ai-elements
└── landing/                    # 官网（独立 Vite 站点，与 studio 无关）
```

三条**必须遵守**的依赖规则，都有实际踩坑背景：

1. **`src/shared/*` 被主进程和 webview 双端引用，绝不能 import electrobun。** 它是两个进程域之间唯一的类型/常量桥。
2. **`src/bun/paths.ts` 和 `src/bun/db/index.ts` 不能在模块作用域 import `electrobun/bun`。** 该模块求值有副作用（拉起 dev server、读 version.json），会污染只想复用数据层的独立进程。这两个文件自己按同样规则解析 userData 路径。
3. **`src/cli/*` 不依赖应用运行。** 它优先走控制 socket，应用未运行时降级为直连 SQLite —— 降级通过先设 `OMNI_DATA_DIR` / `OMNI_DB_PATH` 再动态 import `bun/` 模块实现。

`shared/` 里几个容易混淆的同名文件：

| 文件 | 职责 |
| --- | --- |
| `shared/engines.ts` | **引擎单一真源**：有哪些引擎、各自端口键、支持的模型格式 |
| `shared/cloud-providers.ts` | 20 家云端厂商预设数据（纯数据） |
| `shared/modelscope.ts` | 只做 re-export，保留旧导入路径 |
| `shared/i18n.ts` | 中英双语词典（单文件 3000+ 键）+ `translate()` |

## 4. 主进程分层

### 4.1 RPC 层

`src/bun/rpc/index.ts` 是整个应用的中枢：既定义类型契约 `AppRPC`，又聚合全部 handler。

契约分四段（Electrobun `RPCSchema`）：

- `bun.requests` —— webview → 主进程的请求，几百个方法，每个 `{ params, response }`
- `bun.messages` —— 空，主进程不接收 message
- `webview.requests` —— 空，主进程不反向请求
- `webview.messages` —— 主进程 → webview 的推送事件（chat 流、agent 事件、服务器日志、下载进度、知识库变更等约 40 个）

两侧注册：主进程 `BrowserView.defineRPC<AppRPC>`，webview `Electroview.defineRPC<AppRPC>`。

**推送事件的统一模式**：业务模块内部维护 `Set<callback>` + `emit*()`，RPC 层用 `initXxxBroadcast(win)` 订阅后 `win.webview.rpc?.send.*` 推给前端。业务模块因此完全不依赖窗口。

**错误约定不统一，调用方要同时处理两种**：多数 handler 不抛异常，而是返回 `{ ok: false, error }` 判别式；只有传输层异常才是 Promise reject。

### 4.2 推理运行时与服务器生命周期

`src/bun/runtimes/` 是抽象最干净的一层。`Runtime` 接口（`runtimes/types.ts`）定义 14 个成员：`checkBinary` / `buildCommandLine` / `start` / `stop` / `restart` / `forceKill` / `getStatus` / `getPid` / `getLogs` / `getLastError` / `clearLogs` / `onLog` / `onStatusChange` + `id` / `label`。四个引擎各实现一份，注册在 `runtimes/index.ts` 的工厂表里，按 settings 的 `INFERENCE_ENGINE` 惰性单例化。

`server-manager.ts` 是 facade：持有 listener 集合，引擎切换时把外部订阅重挂到新 runtime 上，对外暴露稳定的 `startServer` / `stopServer` / `getLogs` 等。所有消费者（RPC、chat、OCR、gateway、应用启停）都只认这一层。

**引擎选择的真源是 `shared/engines.ts`**：每个引擎声明自己的端口设置键、额外参数键、支持的权重格式、是否 macOnly。加引擎只需改这里 + 写一个 Runtime 实现。

几个关键实现细节：

- 子进程一律 `detached: true` 独立进程组启动，停止时 `kill(-pid)` 杀整组。原因：llama.cpp 在 macOS 是 `script -q /dev/null llama-server` 包装，vLLM/SGLang/MLX 是 Python 启动器 —— 只杀直接子 PID 会留下占显存的孤儿进程。
- **健康检查用"活动重置"而非固定超时**：1 秒轮询 + 2 秒超时，日志命中 `downloading|fetching|pulling|%|progress` 就把空转计数清零。否则大模型下载/加载会被误判为启动失败。
- 启动失败时用 `extractStartupError` 从实时日志尾部挖真实错误行（跳过 `[...]` 和 `$` 开头的噪声行），而不是只看退出码。
- 各引擎就绪探测端点不同：llama.cpp / vLLM / SGLang 用 `/health`，MLX 没有 `/health` 改用 `/v1/models`。

### 4.3 模型库与下载器

**来源**：ModelScope 为主（搜索、列仓库文件、下载），HuggingFace 为辅（走 hf-mirror 镜像，用于 audio.cpp / whisper / TTS 等不在 ModelScope 的资源）。

**落盘**：`<userData>/models/<safeRepoId>/<file>`，`safeRepoId` 把 `/ : 空格` 换成 `__`。所有落盘与删除都必须过 `modelDestPath()` / `safeJoin()` —— repo 和文件名来自 RPC 与控制 socket，不做校验就能删到数据目录外的任意文件。

**`model-store.ts`** 负责扫描已装模型（递归找权重文件，标注分类/收藏/是否活动）、激活（必要时自动切引擎并写 `LOCAL_MODEL_PATH` / `LOCAL_MODEL_NAME` / `CHAT_MODEL`）、删除、导入。

**`download-manager.ts`** 是持久化队列：最大 2 并发，任务写进 settings 的 `MODEL_DOWNLOADS`，重启后靠磁盘上的 `.part` 分片续传。底层是 8 路 Range 并行分片，服务器不支持 Range 时回退单流。进度事件 400ms 节流 —— 因为 webview 每条进度都会写 store 并重渲染。

### 4.4 智能层

**Agent 循环**由 `@earendil-works/pi-agent-core` 驱动（**不是** Vercel AI SDK 的 agent），每个会话一个 Agent 实例，三种模式：`agent` / `plan` / `goal`。

- **Plan 模式在工具集层面硬约束为只读**，并且不注入记忆/MCP 这类有副作用的工具 —— 不是靠提示词约束。
- **历史回填时只回填 user/assistant 正文，不回放工具调用轨迹。** 轨迹写 `agent_events` 表，纯粹用于 UI 展示和审计。
- 每步工具调用先 `recordEvent` 落库再广播；步数上限 `AGENT_MAX_STEPS`（默认 40）。
- Agent 的正文流复用 chat 的 chunk/done/stats 通道，工具事件走独立的 `agentEvent`。

**工具的安全模型**（`agent-tools.ts`）：工作区外**可读**（方便读用户提到的文件），但有一份凭据路径黑名单硬拦 —— `~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.kube`、`.netrc`、`.npmrc`、`.git-credentials`、`~/.omni`、应用自身数据目录等。理由写在注释里：工具结果会回喂模型，而网页与 MCP 返回的内容可能构成提示词注入。**写操作**则一律 `assertInsideWorkspace`。`bash` 每条命令先写审计日志，且受 `AGENT_ALLOW_SHELL` 开关控制。

**MCP 是双向的**：

- *作为客户端*（`bun/mcp.ts`）：stdio / Streamable HTTP / 旧版 SSE 三种传输**全是手写协议实现**，刻意不引官方 SDK —— 理由是 Electrobun 定制 Bun 运行时的 node 兼容层风险。已连接服务器的工具以 `mcp_*` 前缀注入 Agent。启动 stdio 服务器时会屏蔽 `NODE_OPTIONS` / `PYTHONPATH` / `LD_*` / `DYLD_*` 等进程加载器注入类环境变量，因为 MCP 配置是 webview 提交上来的。
- *作为服务端*（`bun/kb-mcp.ts`）：挂在网关 `POST /mcp`（Streamable HTTP，无状态），对外暴露知识库 `kb_search` / `kb_list` 与记忆 `memory_*` 工具。浏览器 `GET /mcp` 打开内置调试工作台。

### 4.5 知识库与记忆

**知识库**是一条完整的本地 RAG，但刻意不引外部依赖（没有向量库、没有 FTS 扩展）。五个模块各管一段：

```
kb-ingest  持久化摄取队列（解析 / 切片 / 向量化）
    │     作业落库 → 并发上限 2 → 指数退避重试 → 重启恢复；分块写入放进一个事务
    │     文本直读 / PDF·图片走 VLM OCR / 网页走 cheerio
    ▼
kb-chunk   Markdown 感知切片 + 溯源
    │     空行分段、标题起新段（标题跟内容走）、代码围栏不拆、超长硬切带重叠
    │     每块带标题路径与原文字符偏移
    ▼
kb-index   检索内核：term → postings 倒排表（平行数组 + 墓碑压缩）
    │     向量侧：归一化 Float32 常驻 + 槽位 swap-remove，按库 LRU（4 个）
    ▼
knowledge  召回编排：BM25 与余弦各自排序 → RRF 融合 → 可选重排
    │     → 相邻分块合并 → 同文档去冗 → 分数下限 → topK
    ▼
kb-events  审计流水：导入 / 删除 / 重新处理 / 配置变更 / 检索全部留痕
```

几处刻意的工程取舍：

- **嵌入与索引都用上下文增强文本**（`文档名 › 标题路径 + 正文`），展示仍用正文原样 —— 把孤立分块放回它
  所在语境，减少「分块本身没说清主语」的漏召回。
- **增量而非重建**：任何一次写入都不再让整库索引作废；重新索引按分块内容哈希复用旧向量，只把变化的
  分块送去嵌入（改一段不必为整篇重新付费）。
- **检索粒度与上下文档位解耦**：小块召回准，命中后与相邻块合并成一条再进上下文。
- **可见性开关**：库可标记为「不对 MCP 暴露」，网关 `/mcp` 的 `kb_search` / `kb_list` 只看得见打开的库。
- **整库导出 / 导入**（`kb-exports/*.json`，可选带向量），用于归档与换机迁移。

消费方有三处：聊天挂载知识库时注入编号参考资料并要求 `[n]` 引用（引用随消息落库）、Agent 的
`knowledge_search` 工具、网关 MCP。

**记忆**是单表 + 生命周期字段（重要度 / 状态 / 作用域 / 取代链 / 内容哈希 / 可选向量），落在同一个 SQLite 上：

- **写入**：先过校验（长度上限、凭证特征拦截 —— 记忆会注入所有 Agent 的上下文，密钥不进库），再三级判重
  （归一化哈希 → 词元包含度 ≥ 0.85 → 向量余弦 ≥ 0.9），命中即合并（取更完整的正文、标签并集、重要度取高）；
  冲突由模型经 `memory_save(supersedes)` 显式取代，旧条目保留取代链但不参与检索。
- **检索**：`text-search.ts` 的 BM25（CJK 二元组，标签加权）与可选向量各自排序后 RRF 融合，再按
  相关度 0.55 / 重要度 0.25 / 新鲜度 0.20 加权。BM25 索引是内存缓存，靠模块写版本号 + `PRAGMA data_version`
  感知其他进程（`omi` CLI、MCP 桥）的写入。条目命中会累计使用热度，界面浏览不累计。
- **注入**：常驻核心块（置顶 + 高重要度，条数与字符双预算）进系统提示；每轮再按当前问题召回的相关记忆
  拼进用户消息（不动系统提示，保住本地推理的前缀缓存）。普通对话同样注入召回块。
- **生命周期**：分类默认重要度、复用即时加成、30 天半衰期的新鲜度衰减；长期（120 天）未用且重要度低于
  0.55 的记忆自动归档（不删除，可恢复/可检索）。应用启动与记忆页「整理」按钮触发同一份维护逻辑。
- **审计与观测**：`memory_events` 记录写入/合并/取代/归档/删除（删除只留 60 字摘要），`memory_metrics`
  累计检索次数、命中率、合并与拦截次数 —— 记忆页与 `omi memory stats` 都读它。

对外四条通道（网关 REST `/v1/memories`、网关 MCP、`omi memory mcp` stdio、`omi memory add/search/export/import`）
共用 `memory-api.ts` / `memory.ts` 里的同一份实现，行为一致；`memory-sync.ts` 把「该常驻的那批」写进
CLAUDE.md / AGENTS.md 的托管区块（同样受预算约束，其余交给 `memory_search`）。

### 4.6 媒体管线

**OCR 三引擎**：VLM（走推理服务器或独立远端配置）、Tesseract、PaddleOCR PP-OCRv6。

文档管线是 `上传 → pdfjs/canvas 逐页渲染（或 sharp 归一化）→ 信号量并发（默认 3）→ VLM 识别 → HTML/Markdown 解析 → 按 bbox 裁图存 WebP`。裁剪出的图片文件名用**内容 md5**，保证同一张图跨页去重后名字一致。

**语音**：ASR 三条路径（audio.cpp / whisper.cpp / 远端 OpenAI 兼容），TTS 三条（本地 audio.cpp GGUF / vLLM 兼容端点 / Edge TTS 兜底）。通话有两种模式——本地半双工（增量转写 + 句切分 + 逐句合成，支持抢话打断）和云端全双工（DashScope Realtime WebSocket）。

**Bun ↔ Python worker 协议**是这层最值得记住的设计：**stdin/stdout 逐行 JSON（JSON-lines），stderr 留给 Python 侧的进度输出**（mflux 的 tqdm、paddle 的日志）。命令一般是 `load` / `generate|recognize` / `quit`，事件是 `phase` / `loaded` / `done` / `error`。常驻 worker 的价值是模型只加载一次、反复生成；MLX worker 空闲 10 分钟自动卸载，PP-OCR worker 加载有 5 分钟、识别有 3 分钟超时兜底（防"无限识别中"）。

## 5. 服务面（对外接口）

| 服务 | 地址 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| RPC | 进程内 | — | webview ↔ 主进程 |
| 控制 socket | `<userData>/omni-control.sock` | 文件权限 0600 | `omi` CLI 用，HTTP over Unix socket |
| API 网关 | `127.0.0.1:10000` | `GATEWAY_API_KEY`（可选） | 见下 |
| 图片/媒体服务 | `127.0.0.1:19782` | **无** | 所有媒体产物出口 |
| 推理服务 | 18080（llama）/ 8081（vLLM）/ 8082（SGLang）/ 18010（MLX） | — | 由 server-manager 管理 |
| ASR 服务 | 18081 | — | whisper-server |

**网关**（`bun/gateway.ts`，2200+ 行）把本机能力包装成标准协议，供外部客户端与集成 CLI 使用：

- 对话：`/v1/chat/completions`、`/v1/responses`、`/v1/messages`（Anthropic）三套协议，按模型名路由到本地推理服务或云端 API
- 语音：`/v1/audio/speech`、`/v1/audio/transcriptions`（各有四级/多级回退链）
- 图像：`/v1/images/generations`
- 记忆与知识库：`/v1/memories`、`POST /mcp`
- 文档：`/health`、`/openapi.json`、`/docs`、`/redoc`

网关端口被占时自动 +1..+19 顺延。**鉴权之前**先做 Origin 白名单与 Host 回环校验（防 DNS rebinding），并有 `isSelfBase` 检测防止把上游配成网关自己导致无限递归。

**图片服务**无鉴权且提供文档图片、音频、视频，因此**必须只绑回环** —— 绑全网卡等于把用户文档和录音公开。它支持 HTTP Range（视频拖动播放必需），并给视频容器补了 MIME。

## 6. 前端

**Boot 链**：`index.html → main.tsx → Providers（QueryClient + Tooltip）→ App → getSettings 判断是否已配置 → SetupScreen 或 MainLayout`。

**导航是显式的双层状态，没有 URL 路由**：

- `stores/app.ts` 管 `activeApp`（12 个应用：chat / agent / voicecall / voice / image / video / ocr / translate / prompt / skills / kb / memory）
- `stores/router.ts` 管 8 种路由（index / settings / server / stats / models / model-detail / chat / document）
- `AppRail`（左侧 48px 图标栏）切应用并把路由重置为 index；`AppSidebar` 按 `activeApp` 渲染不同的列表；`main-layout/index.tsx` 的 Outlet 里，settings / models / model-detail / document 这类覆盖整个内容区，其余兜底 `renderActiveApp(activeApp)`

**状态管理是双轨制**：

- **TanStack Query** 管所有"从主进程读来的数据"（带缓存与失效）
- **Zustand** 管 UI 态与流式数据

主进程推送的事件在 `lib/rpc.ts` 的 message handler 里**直接写 store**（不走 React 路径，避免每 token 重渲染），只在进入终态时 `queryClient.invalidateQueries()` 刷新对应 key。

组件调主进程**没有封装层**：直接 `import { rpcClient }` 然后 `rpcClient.xxx()`。全项目约 220 处调用，语音页最多（53 处）。只有两处轻封装：`lib/use-engine.ts`（读写引擎设置）和 `local-engines/shared.tsx` 的 `useSettingsBlob` / `useSettingsPatch`。

**i18n** 是单文件双语词典 `shared/i18n.ts`（3000+ 键）+ 简单的 `{name}` 插值，运行时语言存 `stores/ui-lang.ts`，默认中文、回落链 zh → en → key。设置页的 tab 结构、屏幕与路由的映射关系见 `main-layout/settings.tsx` 的 `TAB_DEFS` / `TAB_GROUPS`。

## 7. CLI（`omi`）

`omi` 是套在控制面之上的薄客户端，**不重复实现业务逻辑**：

```
omi <cmd>
  ├─ 应用在运行 → 控制 socket（HTTP over Unix socket）→ 复用主进程的真实实现
  ├─ 应用未运行 → 只读操作降级：设 OMNI_DATA_DIR/OMNI_DB_PATH → 动态 import bun/ 模块 → 直连 SQLite
  └─ serve / install → 完全不走 socket，前台常驻运行
```

命令表在 `src/cli/index.ts` 的 `COMMANDS`（`start` / `stop` / `restart` / `serve` / `launch` / `memory` / `model` / `cloud` / `models` / `model-info` / `status` / `server` / `install` / `guide` / `version` / `update`）。

**帮助体系是数据驱动的**：`src/shared/cli-docs.ts` 是唯一数据源，`omi guide`（文本 / `--md` / `--json` / `--lang en`）、`docs/omi-cli.md`、应用内「设置 → 工具 → 命令行」页三处都从它渲染，因此永远一致。`scripts/omi-docs-smoke.ts` 校验命令表 ↔ 帮助文本 ↔ 数据源 ↔ 磁盘上的文档四者同步。

**`omi launch <tool>`** 是最复杂的命令：确认应用在线 → 解析模型 → 确保网关与推理服务 → 给 claude / codex / opencode / openclaw / hermes / pi 各写各的配置 → 注入记忆上下文到 CLAUDE.md / AGENTS.md 的托管区块 → 挂载 `omni-memory` MCP → 以 `Bun.spawn` 继承 stdio 启动目标工具并透传退出码。

> 仓库里还有一套早期的 `omni` 命令（`src/cli/omni.ts`，`chat` / `doctor` / `config` / `gateway`），是**完全独立的第二套 CLI**，不 import 新版任何代码，只共用数据层。新能力只进 `omi`，手册见 [omni-cli.md](./omni-cli.md)。

## 8. 数据层

单份 SQLite 库（WAL、`busy_timeout=5000`、`synchronous=NORMAL` —— 这组参数是为了支撑 `omi memory` 和 MCP 桥在应用之外并发读写同一个库）。33 张表按域分组：

| 域 | 表 |
| --- | --- |
| 对话 | `conversations`（按 `app` 字段隔离 chat/agent/voicecall）、`messages`、`agent_events` |
| 文档与媒体历史 | `documents`、`pages`、`image_records`、`video_records`、`translation_records`、`voice_records` |
| 提示词 | `prompt_categories`、`prompts`、`user_prompts` |
| Skills | `skills`、`skill_targets`、`skill_presets`、`preset_skills`、`preset_skill_tools`、`skill_projects`、`skillssh_cache`、`skill_audit_log` |
| 配置 | `settings`（全局 key/value）、`cloud_providers`、`mcp_servers`、`knowledge_bases` |
| 知识库 | `knowledge_docs`、`knowledge_chunks`（+ 可选 Float32 base64 向量） |
| 知识库运维 | `kb_ingest_jobs`（摄取队列）、`kb_events`（审计流水） |
| 记忆 | `memories`、`memory_events`、`memory_metrics` |

迁移在 `src/bun/db/migrations/`（0000–0023）。**加了新迁移要留意 drizzle 的 `when` 排序** —— 曾出现过新迁移的 `when` 小于前一条，导致老库升级时被整条跳过。

**数据目录布局**（`<userData>`，macOS 上是 `~/Library/Application Support/omni-studio.kunpengtalk.com/<channel>`）：

```
omni-studio.db          SQLite
models/<repo>/...       模型权重
engines/{paddleocr,mflux,whispercpp,audiocpp,tessdata}/   各本地引擎
images/{<docId>,chat,gen,edit,ocr,audio,videos}/          媒体产物
uploads/                上传的原始文件
mlx-downloads/          MLX 权重下载进度（支持"继续下载"）
omni-control.sock       CLI 控制通道
```

## 9. 端到端数据流

**一次聊天**：UI `rpcClient.sendChatMessage` → 主进程校验会话与模型 → 本地模式先 `ensureServerReady()`（必要时拉起推理服务）→ 组装 payload（历史转 OpenAI 格式、附件转 base64、联网检索结果与知识库召回作为 system 注入且**不落库**、每请求注入当前时间 system 消息防止模型按训练日期回答）→ `POST /v1/chat/completions` 流式 → SSE 解析出 `content` 与 `reasoning_content` → **40ms 批量下发**给 UI → 结束前先 flush 再发 `chatDone`。

**一次文档 OCR**：上传落盘 → 建 `documents` 行 → 逐页建 `pages(pending)` → 信号量并发 3 → 每页 VLM 识别 → 解析 HTML/Markdown + 裁图落 `images/<docId>/` → 更新计数并广播 `documentChanged` 让前端重查。

**一次生图**：参数校验 → MLX 后端确认权重已下载（**不再允许生成时自动下载**）→ 复用已加载的常驻 worker，否则一次性 CLI → JSON-lines 交互，stderr 解析 tqdm 步进 → 落 `images/gen/<uuid>.png` → 写 `image_records`。

**一次 `omi launch codex`**：控制 socket 确认应用在线 → 解析模型 → 确保网关与推理服务 → 写 `~/.codex` 配置 + 刷新 AGENTS.md 记忆区块 + 挂 `omni-memory` MCP → spawn codex 并透传退出码。

## 10. 不变量清单（改代码前先读）

1. **`shared/*` 不 import electrobun**；**`bun/paths.ts`、`bun/db/index.ts` 不在模块作用域 import electrobun**。
2. **Python 脚本必须打进 bundle**（`electrobun.config.ts` 的 `copy` 里显式列出 `.py`），因为调用方用 `import.meta.dir` 同目录相对路径 spawn。漏掉时 Python 以"文件不存在"退出（退出码 2），表现为"模型检查/下载全部失败"这类误导性症状。
3. **子进程必须 detached + 杀进程组**，否则留下占显存的孤儿。
4. **路径穿越防护是调用方的责任**：下载落地、取消下载、媒体解析、Skills 删除各条路径都要显式校验，不能假设输入可信（repo 名、文件名、目录 id 都可能来自 webview 或控制 socket）。
5. **流式更新要节流**：chat 增量 40ms、下载进度 400ms、日志 80ms —— 都是为了避免 webview 高频重渲染。**emitDone 前必须 flush**，否则尾部乱序。
6. **图片服务无鉴权，只能绑回环。**
7. **新引擎只改 `shared/engines.ts` + 写一个 Runtime 实现**，别在别处硬编码引擎判断。

## 11. 已知架构债

按影响排列，供后续迭代参考。

**巨型单文件**。`rpc/index.ts`（3500 行）同时承载类型契约与实现，是改动的天然冲突点；`gateway.ts`（2200 行）、`voice-screen.tsx`（2750 行）、`i18n.ts`（3260 行）、`app-sidebar.tsx`（1300 行）同理。**优先拆 `rpc/index.ts`** —— 把契约类型抽到 `shared/rpc-contract.ts`，webview 侧就能只依赖类型而不拉进主进程代码。

**死代码两处**：`chat-model.ts` 的 `getChatModel()` 全项目无引用（真实聊天链路是 `chat.ts` 自己拼 baseURL 后用原生 fetch）；`router.ts` 的 `server` 与 `stats` 两个路由只在类型定义里出现，没有任何调用方 `setRoute` 过去。

**遗留的第二套 CLI**：`src/cli/omni.ts`（1000 行）与 `omi` 并存，共用数据层但代码零复用，`docs/omni-cli.md` 也没有任何自动化校验。长期应收敛为一套。

**`cloud_providers` 表的双写**：激活的云厂商会把 baseUrl / apiKey / models 同步写回 `VLLM_API_BASE` 等旧 settings 槽位，以便网关、CLI、集成选择器零改动。这是有意的兼容层，但意味着"当前云厂商"状态存在两处 —— **表是真源，槽位是派生**。

**命名碰撞**：`shared/cloud-providers.ts`（预设数据）vs `bun/cloud-providers.ts`（表读写）；`bun/vllm/`（OCR 的 AI SDK 客户端）vs `bun/runtimes/vllm.ts`（引擎进程管理）。
