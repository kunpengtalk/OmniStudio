# OmniStudio 架构

面向维护者的结构说明：**东西在哪、为什么这么切、改哪里会踩到谁**。

- 功能与用法见 [README.md](../README.md)
- 迭代计划与未完成任务见 [ROADMAP.md](../ROADMAP.md)
- 命令行手册见 [omi-cli.md](./omi-cli.md)
- 基准测试的缓存场景（命中 / 不命中的判定与常见坑）见 [benchmark-caching.md](./benchmark-caching.md)
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

**引擎可以一键安装，用户不必复制安装命令**（`bun/engine-install.ts` 是入口，`bun/python-engine.ts` 是 venv 内核，`bun/engine-paths.ts` 是落盘位置的唯一真源）。两条路径，对界面是一件事：

- **llama.cpp**：下载官方预编译二进制。上游**没有可用的「latest」**（`releases/latest` 指向一个只放 `nightly-tag.txt` 的稳定标签），所以安装时读 releases 列表挑最新的 `b<构建号>`，再按平台 / 显卡在资产名里匹配（`llama-b10976-bin-macos-arm64.tar.gz`）—— 构建号每次都在变，写死必坏；上游改过 `-bin-` 前缀与 `.tar.gz` 后缀，规则逐条降级：GPU 变体拿不到就退 CPU。有 NVIDIA 的 Linux / Windows 会连配套的 `cudart-*` 包一起下（缺了它 CUDA 构建根本起不来），装完用 `--list-devices` 验证 GPU 后端真的能起来，起不来就自动回退 CPU 构建重装；AMD / Intel 独显走 Vulkan（不需要额外运行库）。解包 → 补执行位 → `--version` 自证 → 原子 rename 到 `<dataDir>/engines/llama.cpp/current`，macOS 上跑不起来先兜一次 ad-hoc 重签名再判失败。
- **mlx-lm / vLLM / SGLang**：在 `<dataDir>/engines/<id>` 建独立 venv 装 pip 包（uv 优先、回退 `python -m venv`；默认 PyPI 源失败自动换清华镜像重试）；装完以「模块导得进来」为准验证，导不进来就把这半个环境删掉 —— 下次不会再被判成"已安装"。平台能力判定在 `shared/engines.ts` 的 `engineInstallSupport`（vLLM / SGLang 官方只发 Linux 的 CUDA 轮子，macOS / Windows 上界面只给手动提示），界面按钮与主进程行为读的是同一份，不会出现"点下去必然失败"的按钮。

**托管安装优先于 PATH**：四个 runtime 的 `checkBinary` 都先看托管目录（llama.cpp 的 `current/llama-server`、Python 引擎的 venv 解释器），再回落到 `Bun.which` / 常见安装路径 —— 用户自己装过的照旧能用（不接管、不删除），应用自己装的那份是版本可查、与启动参数对得上的一份。安装过程经 `initEngineInstallBroadcast` 推送（日志 80ms 合批、阶段 `throttleLatest` 合并），`getSetupEnvironment` 一并下发 `installSupport` / `installedVersions` / `installing`（`installing` 让界面在**重载之后**仍显示"安装中"，而不是让用户以为没反应又点一次）。

**机器画像决定首屏推荐什么**：探测在 `bun/hardware.ts`，纯计算在 `shared/hardware.ts`，界面在 `mainview/app/setup-screen/`。探测只用系统自带命令 —— macOS 走 `sysctl -n machdep.cpu.brand_string`（Apple 芯片直接回 `Apple M3 Ultra`）与 `hw.physicalcpu/logicalcpu`，**只有 Intel Mac 才跑 `system_profiler SPDisplaysDataType`** 拿独显型号与显存（秒级命令；Apple 芯片的 GPU 就是芯片本身，不必再跑）；Linux / Windows 用 `nvidia-smi` 查显存，其余走 `node:os`。结果缓存在进程里（芯片和内存不会在运行期变），随 `getSetupEnvironment` 一起下发 —— 引导页没有新增 RPC。命令与系统信息都可注入，四条平台路径在 `bun/hardware.test.ts` 里用假 runner 各走一遍（CI 上没有 Apple 芯片，本地是 Apple 芯片，两边都要能断言）。

内存预算有三个口径，界面上的「推理可用预算」是后面所有"约占多少内存"的比较基准：Apple 统一内存取物理内存的 **75%**（macOS 默认的 GPU wired 上限）、独显取显存的 **90%**、纯 CPU / 核显取内存的 **60%**。模型占用 = 权重（量化的真实体积）+ KV 缓存（层数 × KV 头 × head_dim × 2(K/V) × 2B × 上下文，引导页按 8K 估）+ 运行期开销（权重的 5%，下限 512MB）；占用 / 预算的比例分四档：≤60% 流畅、≤80% 可用、≤100% 偏紧、超过即装不下。

推荐规则全在 `shared/hardware.ts`（引擎推荐只回理由代号，文案在界面侧）：

- **引擎**：装了 mlx-lm 的 Apple 芯片 → MLX，≥48GB 显存的 NVIDIA 且装了 vLLM → vLLM，其余 → llama.cpp。vLLM 的门槛偏高是刻意的：它的预设只有 bf16 权重（没有量化档），显存不够大时"上 vLLM"反而把能跑的模型砍小一档（24GB 卡上 llama.cpp + 量化能装下 27B，vLLM 只装得下 4B）。
- **模型**：先看跑得舒服（流畅 / 可用）的那批，挑参数最大的（MoE 按总参数记）；一个都不舒服才在"装得下"的范围里挑；全都装不下就返回 null，界面保留原选择并标「超出内存」。
- **量化档**：先认目录里的默认档（Q4_K_M 这类质量 / 体积甜点档），机器很宽裕就往上抬一档，默认档偏紧或装不下就退到装得下的最大档。

用户点过任意模型或档位之后，推荐不再覆盖他的选择（`modelTouched` / `touchedQuants`）。

几个关键实现细节：

- 子进程一律 `detached: true` 独立进程组启动，停止时 `kill(-pid)` 杀整组。原因：llama.cpp 在 macOS 是 `script -q /dev/null llama-server` 包装，vLLM/SGLang/MLX 是 Python 启动器 —— 只杀直接子 PID 会留下占显存的孤儿进程。
- **健康检查用"活动重置"而非固定超时**：1 秒轮询 + 2 秒超时，日志命中 `downloading|fetching|pulling|%|progress` 就把空转计数清零。否则大模型下载/加载会被误判为启动失败。
- 启动失败时用 `extractStartupError` 从实时日志尾部挖真实错误行（跳过 `[...]` 和 `$` 开头的噪声行），而不是只看退出码。
- 各引擎就绪探测端点不同：llama.cpp / vLLM / SGLang 用 `/health`，MLX 没有 `/health` 改用 `/v1/models`。

### 4.3 模型库与下载器

**来源**：两个平台对等可选（市场顶部切换 ModelScope / HuggingFace），HuggingFace 走 hf-mirror 镜像优先、官方兜底。格式过滤是两个平台各自的能力：HuggingFace 有服务端 `filter=gguf|safetensors|mlx`；ModelScope 的检索接口忽略一切过滤参数（实测 `filter` / `tags` / `library` / `SingleCriterion` 均无效），只能把格式词并进检索词再按返回的 `library:*` 标签二次确认 —— 差异在 UI 上有文案说明，实现见 `bun/huggingface.ts` 与 `bun/modelscope.ts`。

**落盘**：市场下载（两个平台都是）落在 `<userData>/models/<safeRepoId>/<file>`，`safeRepoId` 把 `/ : 空格` 换成 `__`。**列文件与下载必须是同一个平台**：同一个仓库在 HF 与 ModelScope 上的文件路径并不一致（HF 常见 `BF16/xxx.gguf` 子目录，ModelScope 平铺），混用会出现"列表里有、下载 404"。所有落盘与删除都必须过 `modelDestPath()` / `safeJoin()` —— repo 和文件名来自 RPC 与控制 socket，不做校验就能删到数据目录外的任意文件。

**`model-scan.ts`** 是本地模型的发现层，三类来源合成一个列表（`origin` 区分）：`managed` 应用下载目录、`external` 用户添加的目录（settings `MODEL_DIRS`）、`hf-cache` HuggingFace 官方缓存（`~/.cache/huggingface/hub`，尊重 `HF_HOME` / `HUGGINGFACE_HUB_CACHE`）。扫描不要求标准目录结构：任意深度、符号链接（缓存的 snapshot 全是指向 blobs 的软链）、文件直接放在根目录都能识别；缓存按仓库聚合一行（`isDir`），因为 MLX / vLLM 模型本来就是整目录。

**`model-store.ts`** 负责列表（分类/收藏/是否活动/来源标注）、激活、删除、导入。两个关键点：

- **激活存的是"运行时加载目标"而不是列表里那个文件**（`resolveRuntimeTarget`）：目录里有 `config.json` 就存目录（vLLM / SGLang / MLX 加载的是整仓库，单个分片文件加载不了），GGUF 存文件本身。`getLaunchCommand` 用同一套解析，保证"复制的命令"和"实际启动的"一致。
- **删除走白名单**（应用下载目录 / 用户已添加的目录 / HF 缓存）：路径来自 webview 与控制 socket，不校验就是一个任意文件删除漏洞；删 HF 缓存时删的是整个 `models--org--repo` 条目，因为 snapshot 里全是软链，删软链一个字节都释放不出来。

**`download-manager.ts`** 是持久化队列：最大 2 并发，任务写进 settings 的 `MODEL_DOWNLOADS`，重启后靠磁盘上的 `.part` 分片续传。底层是 8 路 Range 并行分片，服务器不支持 Range 时回退单流。进度事件 400ms 节流 —— 因为 webview 每条进度都会写 store 并重渲染。下载完成时把分类与来源平台写进仓库的 `.vllm-meta.json`，本地列表据此显示"从哪儿下的"。

**整仓库下载规则**：safetensors / MLX 这类模型，"下载全部"会额外带上 `config.json` / tokenizer 等加载必需文件（`SUPPORT_FILE_RE`）—— 只下权重分片是跑不起来的；GGUF 是单文件模型，只需要那一个量化文件。

**出站请求统一过代理层**（设置 → 偏好 → 通用，`bun/proxy.ts`）：启动时给 `globalThis.fetch` 挂一层包装，按目标主机决定要不要带 Bun 的 `proxy` 参数，于是云端模型调用、市场搜索、权重与引擎下载、联网检索、远端备份全部自动生效，不必在每个调用点重复接线。判定规则（回环恒直连、局域网看 `PROXY_ALLOW_LOCAL_NETWORK`、其余走代理）与设置页的「谁走代理」展示共用 `shared/proxy.ts` 同一份实现。子进程（pip / python worker / git lfs / brew / 各引擎拉权重）只认环境变量，由 `syncProxyEnv()` 与下载 spawn 点的 `proxyChildEnv()` 负责；WebSocket（Edge TTS / 实时通话）走 `proxyWebSocketOptions()`。

### 4.4 智能层

**Agent 循环**由 `@earendil-works/pi-agent-core` 驱动（**不是** Vercel AI SDK 的 agent），每个会话一个 Agent 实例，三种模式：`agent` / `plan` / `goal`。

- **Plan 模式在工具集层面硬约束为只读**，并且不注入记忆/MCP 这类有副作用的工具 —— 不是靠提示词约束。
- **历史回填时只回填 user/assistant 正文，不回放工具调用轨迹。** 轨迹写 `agent_events` 表，纯粹用于 UI 展示和审计。
- 每步工具调用先 `recordEvent` 落库再广播；步数上限 `AGENT_MAX_STEPS`（默认 40）。
- Agent 的正文流复用 chat 的 chunk/done/stats 通道，工具事件走独立的 `agentEvent`，**运行态走 `agentRunState`**（开跑 / 收尾各推一次，界面据此显示"还在干活"与停止按钮；打开会话时再用 `getAgentRunState` 补一次 —— 刷新窗口、切会话、自动化在后台起的运行都不经过本窗口的发送按钮，只靠前端自己的标记会把正在跑的会话显示成已经结束）。
- **需要用户拍板的动作会停下来问**：`generate_image` 在开跑前检查生图后端是否就绪，缺配置 / 缺模型 / 本地引擎没装 / 有多个候选模型可选时，主进程推 `mediaSetup` 消息给界面弹出配置窗（`media-setup.ts` + `components/media-setup-dialog.tsx`），用户确认后经 RPC `resolveMediaSetup` 回传，**同一次工具调用接着往下跑**。用户没指定模型时会扫一遍候选，多于一个就再弹一次确认用哪个。用户点取消（或超时 10 分钟、或按停止 / 会话重置）则工具立即收尾并告诉模型"别再自行重试"。没有界面在监听时（CLI、测试）直接按取消返回，不会挂起。

**工具授权模型**（`permissions.ts` + `agent-interactions.ts`）：每个工具调用先被翻译成一条 `(permission, pattern)` 请求（`bash` → 命令原文、`write_file` → 相对路径、工作区外读写 → `external_directory`、MCP → 工具名），再按「内置默认 → 设置规则 → 工作区规则 → 会话规则」求值（后匹配覆盖先匹配，无匹配则 ask）。动作分 `allow / ask / deny`：`ask` 由 `Agent.beforeToolCall` 挂起，把请求推给界面弹窗，用户选**允许一次 / 本会话总是 / 始终允许（写进工作区规则）/ 拒绝**后工具才继续（`respondAgentPermission`）。审批模式 `AGENT_APPROVAL_MODE` 四档：`smart`（默认，只拦危险命令与工作区外访问）、`manual`（有副作用的工具全问）、`auto`、`strict`。同一工具调用连续重复 3 次会按 `doom_loop` 询问一次，避免模型原地打转。

凭据路径黑名单是硬拦（授权也不放行）：`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.kube`、`.netrc`、`.npmrc`、`.git-credentials`、`~/.omni`、应用自身数据目录等 —— 工具结果会回喂模型，而网页与 MCP 返回的内容可能构成提示词注入。写操作默认只能落在工作区内（或 `AGENT_AUTHORIZED_FOLDERS` 里显式授权的目录）。`bash` 每条命令先写审计日志，且受 `AGENT_ALLOW_SHELL` 开关控制。

**上下文压缩**（`agent-compaction.ts`）挂在 `Agent.transformContext` 上：每次请求前按 `SERVER_CTX_SIZE` 的 60% 预算裁剪历史，保留第一条任务陈述与最近的进展，中间换成一条说明消息（并往轨迹里写一条 `compact` 状态），长任务因此不会在 8k 窗口的本地模型上直接炸掉；尾部刻意不以工具结果开头，否则真实 OpenAI 兼容服务会因「tool 消息没有对应的 tool_calls」直接 400。

**工程能力对齐 Codex**（详见 [docs/codex-parity.md](./codex-parity.md)）：

- **项目指令**（`agent-instructions.ts`）在 `buildSystemPrompt()` 里注入：从工作区向上找到含 `.git` 的项目根，按「项目根 → 工作区」逐级读 `AGENTS.md`（同目录 `AGENTS.override.md` 优先），用户级指令在 `<数据目录>/AGENTS.md`，总量默认 8KB 封顶（本地窗口小，Codex 的 32KB 默认值在这里会把窗口塞满），截断处写明"后面还有内容"；设置页「Agent 能力」能看到**实际装载了哪几个文件**。输入框的 `/init` 就是让 Agent 补一份 AGENTS.md。
- **`apply_patch`**（`apply-patch.ts`）是 V4A 补丁（`*** Begin Patch` … `*** Add File / Update File / Delete File`），一次改多个文件、**任何一处定位失败就整体不落盘**；定位逐级放宽（精确 → 忽略行尾空白 → 忽略首尾空白 → Unicode 标点归一化），模糊命中时上下文行用文件里的原文，不重写用户格式。权限按补丁里所有文件一起求值：全在区内是 `edit`（模式取公共目录，如 `src/*`），有一个在区外就是 `external_directory`。
- **`view_image`** 把本地图片作为图片内容块交给模型（`pi-ai` 会把它转成工具结果之后的 user 消息 —— OpenAI 兼容 API 里只有这个位置能放图片）。它**只在模型可能支持视觉时才注册**（`chat-model.ts` 的 `chatModelSupportsImages()`，按模型名启发式判断，`AGENT_VISION_TOOL` 可强制 auto / on / off），同时 `buildModel().input` 跟着变 —— 声明了 `image` 却不支持，服务端会直接 400。
- **手动压缩与会话速览**（`/compact`、`/status`）：`compactConversationNow()` 复用自动压缩的算法与估算、只把预算收紧到一半（窗口 30%）——"现在多留点余量"；只动内存里的上下文，库里的历史一条不删（文档写明，避免用户以为压缩 = 删记录）。`describeAgentSession()` 把模型 / 窗口 / 预算 / 审批与沙箱档位一次汇总，数字全部现取，界面不另存一份状态。
- **会话内换模型**（`/model`）：候选清单是 `shared/model-command.ts` 的纯函数（本地只列已启动实例、云端只列用户添加过的对话模型），切换复用 `selectChatModel`；Agent 侧的会话缓存键**算上了当前模型**（`currentModelKey()`），所以换完下一轮就用新模型，而历史由 `historyAsAgentMessages()` 从库里回填 —— 换引擎不换上下文。
- **生命周期 hooks**（`agent-hooks.ts`）：`session_start` 与 `user_prompt_submit` 两个时机跑用户脚本（事件 JSON 走 stdin，stdout 纯文本即上下文、`{"decision":"block"}` 可拦下这一轮）。`session_start` 的输出作为「会话启动上下文」**挂在会话上**，每轮重建系统提示时要带上它（否则第一轮之后就被覆盖 —— live-check 逮到过这个坑）。hooks 只从设置读取，绝不执行工作区里的文件；失败 / 超时只记警告，上下文有 8KB/16KB 上限。
- **主动申请权限**（`request_permissions` 工具）：模型带着理由申请工作区之外的路径，翻译成 `external_directory` 的授权卡片；工具**必须过闸门**（能跑起来 = 用户刚点了允许），工具体内不再二次询问 —— 否则用户要点两次，或模型会拿到一句没有依据的"已授权"。
- **外部通知回调**（`agent-notify.ts`）：设置项 `AGENT_NOTIFY_COMMAND` 配了就把事件 JSON 交给用户命令（最后一个参数 + `OMNI_NOTIFY_PAYLOAD`）—— 触发点只有通知中心的 `notify()` 一处，回合跑完 / 需要授权 / 自动化结果 / 出错全覆盖；载荷不做字符串拼接（注入用例已钉住），失败只写统一日志。
- **命令沙箱**（`agent-sandbox.ts`）：权限闸门管得住工具，管不住 `bash` 里的一行命令 —— 开启后 `bash` 跑在 macOS 的 Seatbelt 里（`sandbox-exec -p <策略>`）。三档：`off`（= danger-full-access）、`workspace-write`（写只允许工作区 / 临时目录 / 已授权目录）、`read-only`（工作区与用户目录一律不可写，只有临时目录例外 —— 测试运行器与编译器要写 TMPDIR）；三档都拒凭据目录读取，联网可开关。命令**因为沙箱**失败时会问一次「是否跳过沙箱重试」（权限项 `sandbox_escalation`，`smart`/`manual` 询问、`auto`/`strict` 默认拒绝），允许则只对这一次去掉沙箱重跑并写审计日志，拒绝则把原因交给模型；只试一次、普通失败不触发、无人值守不注入。策略里的路径**必须带 realpath**（`/tmp` 是 `/private/tmp` 的软链，否则拦截会静默失效）。默认关闭。后端按平台选：macOS 用 Seatbelt（`sandbox-exec -p <策略>`），Linux 用 bubblewrap（`--ro-bind / /` + 白名单 `--bind` + 凭据目录 `--tmpfs` 挖空 + `--unshare-pid/--die-with-parent`，策略生成是纯函数所以能在 macOS 上单测），其它平台降级为不沙箱并在设置页写明；Linux 上还会探测真实的空沙箱（装了 bwrap 但容器禁用非特权 user namespace 时要降级），并在缺依赖时给出安装命令。**Landlock 是完整可用的兜底后端**（没有 bwrap 时自动启用，与 Codex 现在的选择一致 —— 它也是 bwrap 为主、Landlock 留档）：`landlockRuleset()` 是纯函数（档位 → 允许路径集合：`/` 只给读、可写目录再叠一组写位，写位必须全列进 `handled`，因为 Landlock 只处理声明的权限），`landlockRulesetSpec()` 出稳定 JSON，C 辅助程序 `src/bun/omni-landlock.c` 首用时按源码 hash 现编（要 cc；不往仓库塞预编译二进制）后只做"读规格 → 发 `landlock_*` 系统调用 → exec 命令"。它表达不了的写在 `unsupported` 里、不假装做了：规则只能"允许"，所以凭据目录的**读**拦不住（要 bwrap）；net 规则没实现，所以关掉联网开关时辅助程序直接拒绝执行、让位给 bwrap。两个真跑才发现的坑有回归用例：`/dev/null` 必须放行（否则 `2>/dev/null` 全线失败）、FUSE / 网络盘上规则整片落空（用 canary 探测识别后换后端）。端到端见 `scripts/landlock-e2e.ts` 与 CI 的 `linux-sandbox` 作业。
- **上下文占用**（`agent-context.ts`）：会话内记住上一轮实测的 `usage.prompt_tokens`，没有实测值时按消息估算（复用压缩那套 `estimateTokens`），预算 = 窗口的 60% —— 所以输入框上的占用条与"什么时候开始裁历史"是同一个判据。模型侧配只读工具 `get_context_remaining`（占用高时明确要求先 todo_write 记进度再继续），用户侧占用条按 70% / 90% 变色。
- **回合快照与回退**（`agent-snapshots.ts`）：影子 git 仓库建在数据目录（`git --git-dir <影子> --work-tree <工作区>`，**不碰用户自己的 `.git`**），`node_modules` / 构建产物写进 `.git/info/exclude`；`runAgentTurn` 在 Agent 动文件之前提交一次并绑定该轮助手消息；界面上的「撤销本轮」先预览再执行，回退走 `add -A` + `read-tree --reset -u <sha>`（**不动 HEAD**，所以还能回退到更近的一轮）。提交信息里带会话 / 消息 / 毫秒时间戳：同一秒同样内容在不同工作区会算出同一个 commit sha，撞车会回退到别人的工作区。没有 git 时整条链路静默降级。影子仓库跟着回合数长，占用超阈值（或轮数到顶）时在提交后顺手 `git gc`，设置页显示占用并提供「立即清理」——历史不受影响，每轮快照都是 HEAD 的祖先。

**会话能力面对齐 OpenWork / Claude Cowork**（详见 [docs/openwork-parity.md](./openwork-parity.md)）：`todo_write` 待办清单（`agent_todos` + 输入框上方的进度面板）、`ask_user` 反问（弹窗里选或自填）、`task` 子智能体（独立上下文跑只读/完整工具，只把结论带回主线）、侧边面板（多页签：产出物 / 审查 / 文件 / 终端 / 浏览器 + 预览页签，左侧分隔条可拖宽）—— 产出物与工作区文件走回环文件服务的 `/artifact/<id>`、`/workspace/<rootId>/<路径>`，HTML 在 iframe 里当网页加载；审查页签读 git 改动与 diff（`bun/workspace-changes.ts`，argv 调 git、路径限工作区内）；终端页签是真 PTY（`bun/terminal-sessions.ts` 的 `Bun.Terminal`，输出按帧批量推给 xterm，窗口关闭时统一 kill）、消息流渲染（工具调用一行一个、思考是「思考 · 持续了 N 秒」可展开行、正文不套气泡，见 `app/agent/message.tsx` 与 `app/agent/timeline.tsx`；正文与思考按 40ms 批量流式下发）、会话侧栏（置顶 / 归档 / 搜索 / 重命名 / 工作区分组，`conversations.workspace`）、自动化（`automations` + 30 秒巡检，到点开一条真实会话跑任务）、输入框的 `/` 命令与 `@` 文件提及。**运行中还能继续输入**：Enter 排队（本轮结束后逐条 drain）、Cmd/Ctrl+Enter 用 `Agent.steer` 立即插进当前这一轮，停止按钮会连队列一起取消。**授权与提问不做浮层弹窗**：请求与结果各落一条 `agent_events`（`permission_request` / `permission`、`question_request` / `question`，`args` 里带同一个 id），界面按 id 配对后在**触发它的那条消息下面**渲染确认卡片 —— 不遮挡输入框，答完收成一行记录留在流里。Agent 侧栏「新建任务」下面是搜索 / 自动化 / 插件 / Skills 四个入口，点开后在 Agent 主区域内渲染（`app/agent/agent-views.tsx`），它们不是应用的一级菜单。搜索走 `searchAgentSessions()`：标题 + 全部消息正文，结果带命中片段。通知中心（`bun/notifications.ts` + 顶栏铃铛）收集"后台发生的事"：需要授权的请求、自动化的成功 / 失败、无人值守回合的结束；助手消息支持**从这里分支**（`Chat.forkConversation`，复制到该条消息为止，原会话不动）。

**素材工具**（`media-tools.ts`）把应用里已经产生的媒体资产接进 Agent —— 用户在界面手工生成的和 Agent 生成的图片 / 语音 / 视频记在同一批表里，`source` 字段（`manual` / `agent`）区分来源，所以「用户之前做过什么」对 Agent 是可见的：

- `media_search`：按时间 / 关键词 / 类型 / 来源检索（默认最近优先，结果带 `ref`、绝对路径与提示词，末尾附复用方式）；
- `media_export`：把库里的素材复制进工作区，写文档时按相对路径引用（自动防重名）；
- `generate_image` / `generate_speech` / `generate_video`：直接调用「图像 / 语音 / 视频」页已配置好的后端，产物照常入库（`source: "agent"`，之后可被 `media_search` 检索）。

生成类工具会写文件、可能产生云端费用，因此**只在 Agent / Goal 模式注入**；`media_search` 只读，Plan 模式也有。引用解析只认 `media_search` 给出的 ref / `image#12` 句柄 / 工作区内的图片文件（自动暂存），一律经 `images` 根目录的目录穿越校验。

检索实现（`searchMediaLibrary`）同时供三处使用：内置 Agent 工具、网关 MCP 的 `media_search`（`bun/media-api.ts`）与 REST `GET /v1/media` —— 外部智能体（`omi launch` 拉起的 Claude / Codex、Cursor 等）拿到的是同一份结果，附带绝对路径与可播放 URL，可以直接读取或复制，不需要再问用户要图。界面侧，图片 / 视频 / 语音三处列表用 `MediaSourceBadge` 标出 Agent 生成的那些，图片与视频的生成历史还带来源筛选。

**MCP 是双向的**：

- *作为客户端*（`bun/mcp.ts`）：stdio / Streamable HTTP / 旧版 SSE 三种传输**全是手写协议实现**，刻意不引官方 SDK —— 理由是 Electrobun 定制 Bun 运行时的 node 兼容层风险。已连接服务器的工具以 `mcp_*` 前缀注入 Agent。启动 stdio 服务器时会屏蔽 `NODE_OPTIONS` / `PYTHONPATH` / `LD_*` / `DYLD_*` 等进程加载器注入类环境变量，因为 MCP 配置是 webview 提交上来的。
- *作为服务端*（`bun/kb-mcp.ts`）：挂在网关 `POST /mcp`（Streamable HTTP，无状态），对外暴露知识库 `kb_search` / `kb_list`、记忆 `memory_*` 与素材 `media_search`（`bun/media-api.ts`，只读，让外部智能体也能复用本机素材）。浏览器 `GET /mcp` 打开内置调试工作台。

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

**笔记也往记忆里沉淀**（`memory.ts` 的 `syncNoteMemory`）：小应用「笔记」每保存一条就写一条
**索引级**记忆（`笔记《标题》（日期）：正文压缩，≤500 字`，`sourceRef = note:<id>`），于是 Agent 靠
既有三条通路（常驻核心块 / 每轮召回 / `memory_search`）就能"想起"用户写过什么。三个刻意的边界：
记忆是**单行短句**，正文细节仍以笔记为准（笔记 2 万字、记忆 500 字，用途本来就不同）；同一条笔记
反复保存只更新同一条记忆（按 `sourceRef` 幂等），删笔记时连记忆一起删（否则 Agent 会记得一条打不开的笔记）；
疑似凭据的笔记**不进记忆库**（记忆会被注入所有 Agent 的上下文，凭据只能放密钥管理），正文照常落库。
**Agent 还能读正文**：`note_list` / `note_search` / `note_read` 三个只读工具（`bun/notes-tools.ts`，Plan 模式也给）——
只沉淀记忆是不够的：模型能"想起"一篇日记却读不到正文时，用户问「看看我的日记」它只能去 grep 工作区，
最后回一句"这只是记忆里的内容"。所以记忆摘要末尾会挂一句 `（完整正文：note_read #<id>）`，
让"想得起"直接接上"读得到"。开关是一把 `NOTES_AGENT_ACCESS`（笔记小应用设置里，默认开）：
同时管沉淀与可读——用户脑子里的问题是同一个"要不要让 Agent 看到我的笔记"，拆成两个开关只是拆成两道题。

对外四条通道（网关 REST `/v1/memories`、网关 MCP、`omi memory mcp` stdio、`omi memory add/search/export/import`）
共用 `memory-api.ts` / `memory.ts` 里的同一份实现，行为一致；`memory-sync.ts` 把「该常驻的那批」写进
CLAUDE.md / AGENTS.md 的托管区块（同样受预算约束，其余交给 `memory_search`）。

### 4.6 媒体管线

**OCR 三引擎**：VLM（走推理服务器或独立远端配置）、Tesseract、PaddleOCR PP-OCRv6。

文档管线是 `上传 → pdfjs/canvas 逐页渲染（或 sharp 归一化）→ 信号量并发（默认 3）→ VLM 识别 → HTML/Markdown 解析 → 按 bbox 裁图存 WebP`。裁剪出的图片文件名用**内容 md5**，保证同一张图跨页去重后名字一致。

**语音**：ASR 三条路径（audio.cpp / whisper.cpp / 远端），TTS 三条（本地 audio.cpp GGUF / vLLM 兼容端点 / Edge TTS 兜底）。通话有两种模式——本地半双工（增量转写 + 句切分 + 逐句合成，支持抢话打断）和云端全双工（Realtime WebSocket）。

云端语音的**厂商差异只写在两处**：TTS 走 OpenAI 兼容的 `/v1/audio/speech`（各家形状一致，差别只有音色名 —— `shared/tts-voices.ts` 收官方音色清单，以及"别家留下的占位音色换成这一家的默认值"这条规则）；ASR 与实时语音各有一层方言，由 `realtimeDialectFor`（地址为主、模型名为辅）判出：

| 厂商 | ASR | 实时语音 | 上行音频 |
| --- | --- | --- | --- |
| 百炼（DashScope） | OpenAI 兼容 `/v1/audio/transcriptions`（multipart） | `wss://…/api-ws/v1/realtime`，格式 `pcm`、断句 `smart_turn` / `semantic_vad` | 16k |
| 阶跃星辰（StepFun） | `/v1/audio/asr/sse`（base64 + SSE 增量文本：StepAudio 3 ASR 只在这个端点，带时间戳的文件接口要公网可下载的 URL） | `wss://api.stepfun.com/v1/realtime`，格式 `pcm16`、只认 `server_vad`、不能发手工 commit | 24k |

`realtimeBaseUrlForProvider` 把厂商的 HTTP 地址推成实时端点，所以换厂商时地址、模型、音色会一起跟着换（手填的中转地址除外）。

**Bun ↔ Python worker 协议**是这层最值得记住的设计：**stdin/stdout 逐行 JSON（JSON-lines），stderr 留给 Python 侧的进度输出**（mflux 的 tqdm、paddle 的日志）。命令一般是 `load` / `generate|recognize` / `quit`，事件是 `phase` / `loaded` / `done` / `error`。常驻 worker 的价值是模型只加载一次、反复生成；MLX worker 空闲 10 分钟自动卸载，PP-OCR worker 加载有 5 分钟、识别有 3 分钟超时兜底（防"无限识别中"）。

## 5. 服务面（对外接口）

| 服务 | 地址 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| RPC | 进程内 | — | webview ↔ 主进程 |
| 控制 socket | `<userData>/omni-control.sock` | 文件权限 0600 | `omi` CLI 用，HTTP over Unix socket |
| API 网关 | `127.0.0.1:10000` | 网关 API Key（可多把，`gateway_keys` 表） | 见下 |
| 网页版对话 / Agent | 同上 `/chat`、`/agent` | 页面本身公开，数据接口要 API Key | 见下 |
| 内网穿透 | 出站到 Cloudflare 边缘 | 同上（**强制**，至少要有一把启用的） | 见下 |
| 图片/媒体服务 | `127.0.0.1:19782` | **无** | 所有媒体产物出口 |
| 推理服务 | 18080（llama）/ 8081（vLLM）/ 8082（SGLang）/ 18010（MLX） | — | 由 server-manager 管理 |
| 嵌入服务 | 18190 起（`EMBEDDING_PORT`，段宽 100 顺延；实际端口以应用注册表为准） | — | 嵌入类模型经 llama-server `--embeddings` 服务，不接管聊天活动状态 |
| ASR 服务 | 18081 | — | whisper-server |

**网关**（`bun/gateway.ts`，2200+ 行）把本机能力包装成标准协议，供外部客户端与集成 CLI 使用：

- 对话：`/v1/chat/completions`、`/v1/responses`、`/v1/messages`（Anthropic）三套协议，按模型名路由到本地推理服务或云端 API
- 嵌入：`POST /v1/embeddings`，代理运行中的嵌入实例（模型页以嵌入类别启动的模型）；无实例 503 并带启动引导
- 语音：`/v1/audio/speech`、`/v1/audio/transcriptions`（各有四级/多级回退链）
- 图像：`/v1/images/generations`
- 素材：`/v1/media`（只读检索本机素材库，与内置 Agent 的 `media_search` 同一份实现）
- 记忆与知识库：`/v1/memories`、`POST /mcp`
- 文档：`/health`、`/openapi.json`、`/docs`、`/redoc`

网关端口被占时自动 +1..+19 顺延。**鉴权之前**先做 Origin 白名单与 Host 回环校验（防 DNS rebinding），并有 `isSelfBase` 检测防止把上游配成网关自己导致无限递归。

**API Key 是一份列表，不是一个设置项**（`bun/gateway-keys.ts` + `gateway_keys` 表）：每把 Key 带名字，可单独停用 / 删除，网关**每个请求现读**启用的那些 Key，所以改动立即生效、不需要重启，也不用担心"吊销了旧 Key 还在放行"。列表之外还有两件事要知道：`settings.GATEWAY_API_KEY` 保留为**镜像**（= 最早启用的那把，没有则为空串），隧道判定、`/health`、`/docs`、`omi launch`、KB 接入页读的都是它；外部直接写进这个槽位的值（`omi serve --api-key`）会在下一次读列表时被**采纳**成一行，否则会出现"不在列表里却一直能用"的隐形 Key。没有启用的 Key（且槽位为空）时回到历史行为：对本机进程开放访问，公网暴露期间一律 401。

**网页版对话 / Agent**（`bun/gateway-web.ts` + `mainview/remote-shell.tsx` + `mainview/lib/remote.ts`）把桌面端的**同一份前端**搬到浏览器里，只留这两个窗口：

- **不是重画一套页面**：`/chat`、`/agent` 发出去的就是 vite 构建出来的那份 webview 产物（`Resources/app/views/mainview/`），组件、样式、stores 全部是应用自己的；浏览器里 `main.tsx` 检测不到 Electrobun 桥时改挂 `RemoteShell`（关键闸门 + 两个入口）而不是整套 `MainLayout`。
- **换的只有传输层**：`lib/rpc.ts` 在浏览器里 `rpc.setTransport(createHttpTransport())` —— 请求 POST `/v1/web/rpc`，推送走 **WebSocket `/v1/web/ws`**（帧名就是桌面端 `send.<名字>`）。RPC 之上的东西一行没改。
  事件流**必须走 WS，不能用 SSE**：Cloudflare 隧道会把 SSE 响应整段缓冲（实测隧道域名下 40 秒 0 字节，心跳与 2KB 开场填充都无效，而回环直连正常），后果是界面永远收不到 `chatDone`、停在"处理中"。`/v1/web/rpc/events` 的 SSE 版本保留给 curl / 脚本（只在回环可靠）。WS 握手指不了 Authorization 头，所以它认 RPC 桥下发的那枚票据 Cookie。
- **布局照抄 MainLayout 的层级**：`SidebarProvider > AppSidebar + SidebarInset`，顶栏作为 inset 里的 header。少一层 `SidebarInset` 就断掉对话窗口的 flex 链条 —— 表现是消息浮在顶部、输入框悬在页面中间。
- **推送零清单**：`init*Broadcast(win)` 只用到 `win.webview.rpc?.send.<名字>(payload)`，于是给它们喂一个**假窗口**（Proxy 接住每个名字转 WS 帧）就复用了全部几十种推送；新客户端连上时还要 `broadcastCurrentStatus` 补一次快照（推送是"变化时发"）。
- **暴露面收口在两处**：`REMOTE_METHODS` 白名单（只放对话 / Agent 用得到的方法；宿主弹窗、落盘、装引擎、改审批模式一律拒绝）、`getSettings` 出站前按 `REMOTE_SECRET_KEY` 抹掉所有凭据字段。被拒的方法写 `web.rpc.denied` 进 app.log。
- **远程不渲染**：右侧工作面板（终端 / 内置浏览器 / 评审）、自动化 / 插件子视图、设置页入口。
- **媒体走代理**：`<img>`/`<video>` 带不了 Authorization 头，所以 RPC 鉴权通过时下发一枚 HMAC 签名的 Cookie（`omni_media`，进程重启即失效），`/media/*` 认 Cookie 或 Key，并透传 Range（视频拖动依赖）。前端用 `setMediaBaseOverride()` 把媒体基址指向 `<站点>/media`。
- **vite `base: "./"`** 是这套方案的前提：同一份产物既要被 `views://mainview/index.html` 加载，又要被网关当作 `/chat` 下的静态站点（绝对 `/assets/...` 在子路径下会 404）。

**内网穿透**（`bun/tunnel.ts` + `bun/cloudflared.ts`）把网关经 Cloudflare 隧道暴露到公网，让远程客户端 / Agent 用同一套端点（含上面那两个网页）。几个不能丢的约束：

- **出站连接，不开入站端口**：不要求公网 IP、不动路由器，TLS 与域名由 Cloudflare 边缘负责。目标端口永远取网关**实际**绑定的端口（配置端口被占时会顺延）。
- **强制 API Key**：一把启用的网关 Key 都没有（`gateway_keys` 为空 / 全被停用）就不许开隧道 —— 公网 URL 泄漏等于把模型算力、共享记忆、素材库一起送人。隧道期间 Key 被停用 / 删除会立刻下线隧道（主进程在密钥增删改后重新对账）。
- **Host 白名单而不是改绑定**：隧道期间把公网域名交给 `setGatewayPublicExposure()`，`hostHeaderAllowed` 放行这一个域名；同时 `/`、`/health` 也要求 Key（`/docs`、`/redoc`、`/openapi.json` 是静态内容，保持开放）。比让用户改 `GATEWAY_HOST=0.0.0.0` 安全：后者会同时关掉 DNS-rebinding 防护并真的监听所有网卡。
- **二进制由应用自己装**：`<dataDir>/engines/cloudflared/current`（多镜像下载 + 跑一次 `--version` 验证 + 原子 rename），PATH 上已有则直接用用户的；`--no-autoupdate` 必须带，否则 cloudflared 自己重启会让我们失去进程生命周期控制。
- **进程托管**：detached + 进程组 kill，退出路径用 `stopTunnelSync()`；`<dataDir>/tunnel/cloudflared.pid` 用于下次启动清理被强杀遗留的公开隧道（只杀命令行里带 cloudflared 的进程）。
- 快速隧道（免账号、域名随机）与命名隧道（`--token`，自己的域名 + 可叠 Cloudflare Access）两种模式；协议回退用环境变量 `TUNNEL_TRANSPORT_PROTOCOL`（UDP 7844 被封时切 HTTP/2），cloudflared **没有** `--protocol` 参数。

**图片服务**无鉴权且提供文档图片、音频、视频，因此**必须只绑回环** —— 绑全网卡等于把用户文档和录音公开。它支持 HTTP Range（视频拖动播放必需），并给视频容器补了 MIME。

**嵌入访问**：嵌入类模型（category=embedding）经应用启动时，llama-server 自动附加 `--embeddings --pooling <P>`（`EMBEDDING_POOLING`，默认 `last`，可选 `mean`/`none`/`cls`）进入嵌入模式，端口从嵌入段分配——`EMBEDDING_PORT` 基址（默认 18190）起、段宽 100 顺延（18190..18289），与聊天扫描区 18080..18179 互不重叠；嵌入实例不接管聊天活动状态，聊天模型照常服务。**段位是偏好而非契约**——实际端口以应用注册表为准：`resolveEmbeddingBackend()` 返回最近启动的运行实例地址（无实例时 null），「服务器」页可见。

接入一律说 OpenAI Embeddings 方言，两种写法（直连时端口以「服务器」页为准）：

```bash
# 1) 直连嵌入实例：无鉴权
curl http://127.0.0.1:18190/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"input": ["第一条", "第二条"]}'

# 2) 经网关：设了 GATEWAY_API_KEY 时需带 Authorization 头；无运行实例时 503（响应体含启动引导）
curl http://127.0.0.1:10000/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"model": "nomic-embed-text-v1.5", "input": "要向量化的文本"}'
```

```python
# OpenAI SDK（Python）：两种写法只差 base_url；经网关时 api_key 用 GATEWAY_API_KEY，
# 直连实例时 api_key 填任意非空字符串即可（实例不校验）
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:10000/v1", api_key=os.environ["GATEWAY_API_KEY"])
r = client.embeddings.create(model="nomic-embed-text-v1.5", input=["第一条", "第二条"])
```

两个容易疑惑的行为：

- **model 字段被忽略**：llama-server 的 /v1/embeddings 只服务它启动时加载的那个模型，请求里的 `model` 字段被忽略；网关把请求体原样转发，所以经网关与直连行为一致。
- **本地实例会收到 Authorization 头**：KB / 记忆的嵌入调用直连本地实例时会带 `Authorization: Bearer <key>`
  （知识库配置的 Key，未配置时回落全局 `VLLM_API_KEY`）；llama-server 不校验鉴权头，忽略之，无害。

**KB 嵌入 base 回退链**：知识库「接口地址」（embeddingBase）留空时，按 **显式 base > 运行中嵌入实例 >
SERVER_MODE=remote 的 VLLM_API_BASE > 聊天活动端口** 依次解析（embeddings.ts 的 `resolveEmbeddingBase`）。
运行实例排在 remote 之上：remote 模式下默认嵌入后端指向云端 chat provider 本就出不了向量——用户显式启动
本地嵌入实例是最强意图信号。

**存量模型注意**：早期下载的嵌入模型可能已以 `chat` 类别持久化在模型库 meta（分类修复上线前的存量），
**不会自愈**——meta 的 category 优先于文件名回退分类。修复旅程：模型详情页把类别改为「嵌入 Embedding」→
重启模型（以嵌入模式重新拉起，落嵌入段）→ KB 嵌入选择器即可选中该模型（或经网关 /v1/embeddings 调用）。
类别改键仅对市场下载模型开放；改类别本身只写 meta，重启后按新类别启动。

## 6. 前端

**Boot 链**：`index.html → main.tsx → Providers（QueryClient + Tooltip）→ App → getSettings 判断是否已配置 → SetupScreen 或 MainLayout`。

**导航是显式的双层状态，没有 URL 路由**：

- `stores/app.ts` 管 `activeApp`（14 个应用：chat / agent / voicecall / voice / image / video / music / ocr / translate / prompt / skills / kb / memory / automations）
- `stores/router.ts` 管 8 种路由（index / settings / server / stats / models / model-detail / chat / document）
- `AppRail`（左侧 48px 图标栏）切应用并把路由重置为 index；`AppSidebar` 按 `activeApp` 渲染不同的列表；`main-layout/index.tsx` 的 Outlet 里，settings / models / model-detail / document 这类覆盖整个内容区，其余兜底 `renderActiveApp(activeApp)`

**状态管理是双轨制**：

- **TanStack Query** 管所有"从主进程读来的数据"（带缓存与失效）
- **Zustand** 管 UI 态与流式数据

主进程推送的事件在 `lib/rpc.ts` 的 message handler 里**直接写 store**（不走 React 路径，避免每 token 重渲染），只在进入终态时 `queryClient.invalidateQueries()` 刷新对应 key。

**用量与速度展示**（`bun/chat-stats.ts` + `components/token-stats.tsx`）：聊天与 Agent 两条路径共用 `MessageStats` 这一份口径 —— **生成速度只算解码窗口**（首 token 之后到结束；引擎自带 `timings.predicted_per_second` 时以它为准），端到端吞吐才含预填充 / 网络 / 工具执行时间；输入 / 输出 / 思考 / 缓存 tokens 有 `usage` 就用实测，没有就按 `shared/token-estimate.ts` 估算，卡片上标明来源。消息底部那行胶囊（`1,012 Tokens · 177.7 Token/秒`）点开是详情卡片；**生成中的实时值**来自 `stores/chat.ts` 的 `liveStats`（按增量累计字符数，而不是每个增量各自取整），收尾后由 `chatStats` 推来的实测值接管。统计随助手消息持久化在 `messages.stats`（JSON 列），刷新会话后速度仍是当时那次的真实值。

组件调主进程**没有封装层**：直接 `import { rpcClient }` 然后 `rpcClient.xxx()`。全项目约 220 处调用，语音页最多（53 处）。只有一处轻封装：`lib/use-engine.ts`（读写引擎设置）。

**i18n** 是单文件双语词典 `shared/i18n.ts`（3000+ 键）+ 简单的 `{name}` 插值，运行时语言存 `stores/ui-lang.ts`，默认中文、回落链 zh → en → key。设置页的 tab 结构、屏幕与路由的映射关系见 `main-layout/settings.tsx` 的 `TAB_DEFS` / `TAB_GROUPS`。

### 6.1 小应用中心（Mini Apps）

`activeApp = "apps"` 是一页**装小应用的容器**，不是又一个工具页：外面是应用中心（卡片墙 + 搜索 + 分类），点进去是运行容器（`app/apps/runner.tsx`）。

**小应用就是一份自包含 HTML**，放在 `src/mainview/miniapps/<id>.html`，用 `?raw` 取原文塞进 `<iframe sandbox srcDoc>`。它不参与主前端构建：新增一个小应用 = 加一个 HTML + 在 `shared/miniapps.ts` 登记一条，不用改 vite 入口，也不会因为新页面把主包顶大。宿主在页面 `<head>` 里注入三样东西 —— 基础样式（`MINIAPP_BASE_STYLE`，主题变量与按钮/输入/卡片这套"组件库"）、启动配置、以及 `window.omni` 运行时。

**沙箱不给 `allow-same-origin`**：小应用与宿主必须跨源，它碰不到宿主的 DOM / store / localStorage —— 那里面 `window.localStorage` 连读都会抛 SecurityError。想留住数据只有两条路：交给用户（`omni.files.save` 落到系统下载目录），或交给宿主存储（见下）。

**「笔记」是第一个需要落库的小应用，也是"小应用数据"这条路径的样板**（`bun/notes.ts` + `miniapp_notes` 表 + `images/notes/`）：正文进主库、附件进数据目录，于是笔记跟着 `omi backup` 一起走、重装不丢、CLI 也读得到 —— 这三件事是"存成文件"给不了的。为此新加了四个动作（`notes.list` / `notes.save` / `notes.remove` / `notes.attach`）与对应的四个 RPC（`miniappNotes*`）。两条必须守住的规则：**附件 ref 只认宿主自己生成的形状** `notes/<附件 id>/<文件名>.<图片后缀>`（删笔记要按 ref 反推目录并整目录删掉，形状放松一点就等于给沙箱开了"删数据目录里的任意目录"），以及**尺寸 / 体积在宿主侧再夹一次**（长边超 2048 压到 2048 并转 webp，单张上限 12MB）；被放弃的新建草稿会留下无引用附件，由 `listNotes` 的一次性回收（只删 24 小时以前、无引用的目录）兜底。界面侧是一套"窄栏 + 内容区"的应用壳（日记 / 日历 / 标签 / 设置四项），不做组件复用，全在同一个 HTML 里 —— 与其它小应用一致的取舍：多一行配置不如多一份自包含的文件。**正文是 Markdown**：编辑就在内容区里做（不是弹窗抽屉），顶部标题、底部一条格式工具栏、右上 ✓ 保存并返回，编辑 / 分栏 / 预览三档；图片以 `![](媒体地址)` 的形式写在正文里（同时登记在附件列表中，保存时正文里已删掉的那些会被连文件一起回收），列表卡片上的摘要是剥掉语法后的纯文本。渲染器是本页自带的一小段（`mdToHtml`）—— 小应用引不进依赖，而正文是用户输入，**先整段转义、再套标记**、链接只放行 http(s) 是这里唯一需要自己把关的安全点（顺序颠倒就等于自己开了一个 XSS 口子）。「AI 助手」（润色 / 续写 / 起标题，走 `text.complete`）钉在同一条工具栏上，没配模型只禁用那几个按钮，写正文不受影响。**对话与 Agent 的助手消息上有「保存到笔记」**（草稿规则抽在 `mainview/lib/note-draft.ts`：`# 标题` 优先、否则短首行当标题并从正文里取走，两边共用一份）；保存成功后只把按钮改成 ✓，**不把用户从正在读的回答里拽走**。

**能力走宿主转发，没有任意方法透传**：小应用能说的动作全都列在 `shared/miniapps.ts` 的 `MINIAPP_ACTIONS` 里（生图 / 以图改图 / 本地抠图的状态、下载与执行 / 麦克风录音 / 转写 / 一次性补全 / 笔记的读写与附件 / 选文件 / 读回文件 / 存文件 / 跳设置 / 记日志 / 读能力），**要加能力必须在那张表里加一条**。`lib/miniapp-bridge.ts` 的 `dispatchMiniAppRequest` 逐个翻译成具体 RPC，**参数一律当不可信输入**（长度、范围、枚举都夹一遍），认不出的动作直接拒绝并写 `miniapp.*` 日志 —— 一旦这里退化成"按名字透传 RPC"，iframe 里的一段脚本就等于拿到了整个 RPC 面。同理，跨源读文件（`miniappReadFile`）只认用户刚在系统对话框里亲手选过的路径（`bun/dialog-paths.ts` 那一份凭据）。

**能力探测是前置的**（`bun/miniapps.ts` 的 `getMiniAppCapabilities`）：生图 / AI 修图 / 对话 / ASR / 本地抠图 / 纯本机，每一类各自 ready 与否，判定口径与各功能页"未配置"的提示同源。卡片上直接标「需配置」，容器里再给一条"去设置"的路，而不是让用户点进去撞错误墙。两类是**永远 ready** 的：本地抠图的权重能在小应用里自己下（拦在门外就够不着那个下载按钮）、纯本机处理（马赛克）不依赖任何模型或厂商，它们的 label 只回答"模型在不在本地"。

小应用跑在 iframe 里，宿主读不到它的 console —— 所以失败必须有出口：`miniappLog`（每分钟配额，防止一个死循环的小应用把 2MB 的 app.log 刷爆）与运行时自己挂的 `window.onerror` 转发。**新增小应用能力时，两处一起改**：`shared/miniapps.ts` 的动作清单 + `lib/miniapp-bridge.ts` 的分发分支。

## 7. CLI（`omi`）

`omi` 是套在控制面之上的薄客户端，**不重复实现业务逻辑**：

```
omi <cmd>
  ├─ 应用在运行 → 控制 socket（HTTP over Unix socket）→ 复用主进程的真实实现
  ├─ 应用未运行 → 只读操作降级：设 OMNI_DATA_DIR/OMNI_DB_PATH → 动态 import bun/ 模块 → 直连 SQLite
  └─ serve / install → 完全不走 socket，前台常驻运行
```

命令表在 `src/cli/index.ts` 的 `COMMANDS`（`start` / `stop` / `restart` / `serve` / `launch` / `memory` / `backup` / `model` / `cloud` / `models` / `model-info` / `status` / `server` / `install` / `guide` / `version` / `update`）。表里的值是「取处理函数的异步工厂」—— 命令模块按需 `import`，避免解析参数时把别人的依赖（尤其是 import 即跑迁移的数据层）一起拖进来；`omi backup` 正是靠这一点在数据库迁移失败、应用起不来时照常工作。

**帮助体系是数据驱动的**：`src/shared/cli-docs.ts` 是唯一数据源，`omi guide`（文本 / `--md` / `--json` / `--lang en`）、`docs/omi-cli.md`、应用内「设置 → 工具 → 命令行」页三处都从它渲染，因此永远一致。`scripts/omi-docs-smoke.ts` 校验命令表 ↔ 帮助文本 ↔ 数据源 ↔ 磁盘上的文档四者同步。

**`omi agent run`** 是给脚本用的入口（对齐 Codex 的 `codex exec`）：`agent-headless.ts` 跑一个无人值守回合（不弹授权卡片，被拦下的动作直接以拒绝理由回到模型），控制通道的 `agentRun` 命令支持 **NDJSON 流式响应**（`start` / `event` / `result`，可选正文增量），`--json` 就是把它逐行打给调用方；会话照常落库，跑完能在界面里继续追问。

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

迁移在 `src/bun/db/migrations/`（0000–0024）。**加了新迁移要留意 drizzle 的 `when` 排序** —— 曾出现过新迁移的 `when` 小于前一条，导致老库升级时被整条跳过。

**数据目录布局**（`<userData>`，macOS 上是 `~/Library/Application Support/omni-studio.kunpengtalk.com/<channel>`）：

```
omni-studio.db          SQLite
models/<repo>/...       模型权重
engines/{paddleocr,mflux,whispercpp,audiocpp,tessdata}/   各本地引擎
images/{<docId>,chat,gen,edit,ocr,audio,videos}/          媒体产物
uploads/                上传的原始文件
backups/                全局备份文件（*.omnibackup，可加密）+ 恢复时的临时目录
mlx-downloads/          MLX 权重下载进度（支持"继续下载"）
omni-control.sock       CLI 控制通道
```

**全局备份 / 恢复**（`src/bun/backup/`，设置 → 数据 → 备份与恢复 / `omi backup`）把数据分成 7 个**作用域**（`shared/backup.ts`：settings / chats / prompts / skills / memory / knowledge / media），每个作用域 = 一组不可拆分的表 + 若干文件根。归档是 gzip + tar（`backup/tar.ts` 自己实现，`Bun.Archive` 当前版本会把 `Bun.file()` 条目写成 0 字节且不支持 gzip），内含 `manifest.json` + `data/omni-studio.db` + `data/files/<根>/<相对路径>`：

- **快照**：`VACUUM INTO`（只读连接即可，WAL 下与应用并发也一致）；未勾选作用域的表会被 `secure_delete` 删除再 `VACUUM`，所以"没勾选"既不在体积里也不在文件残页里。
- **恢复**：先自动做一份 `pre-restore-*.omnibackup`，再把快照按表整表替换（列取交集，兼容旧版本备份），文件同名覆盖、不删除备份里没有的文件；归档条目一律过 `path-safety` 校验防越界。
- **归档是不可信输入**：外部根（技能中央库）是唯一不受数据目录约束的文件根，所以它的落地目录只认**恢复前**本机设置里的 `SKILLS_CENTRAL_PATH`（`captureExternalRootDirs`），绝不采用归档里那一份 —— 否则一个"把备份发给别人排错"的文件，只要把该设置指向 `$HOME` 再带上 `data/files/skills-repo/.zshrc`，就能在用户从未授权的位置覆盖任意文件。归档只能决定**写哪些文件**，不能决定**写到哪个根**；两处路径不一致时会给出提示。同一原则贯穿归档解析：scrypt 参数与 tar 头里的条目长度都有上界（`checkedScryptParams` / `MAX_READ_EXACT`），`deleteBackup` 只认扩展名 + 备份魔数（`isBackupArchive`），清单字段缺失或类型不对在预览阶段就报错。
- **恢复要求本机已建库**：恢复只做整表替换、不建表（内核不 import 数据层，拿不到那批迁移），所以目标库没有应用表结构时直接报错并提示"先启动一次应用"，而不是对每张表都判定"本机没有表"、最后交出一次"写回 0 条记录"的假成功。
- **不依赖应用运行**：模块不 import `db/index.ts`（避免连带跑迁移）与 electrobun，独立进程可在应用起不来时备份 / 恢复（恢复要求应用已退出，避免两个写者）。
- **加密**（`backup/crypto.ts`）：可选 AES-256-GCM + scrypt（N=2^15/r=8/p=1）。容器 = 明文头（魔数 `OMNBKP01`、KDF 参数、压缩标志、salt、iv、keyCheck）+ 密文 + 16 字节 GCM 标签；头部作为 AAD 参与认证。`keyCheck` 让"密码不对"在打开时就报明确错误（预览只读开头，流走不到结尾触发不了 GCM 校验）。密码不落盘。scrypt 派生与独立实现（Python `hashlib.scrypt`）逐字节对齐验证过。
- **远端存储**（`backup/remote.ts`）：S3 兼容（AWS / R2 / MinIO / OSS / COS，自己实现 SigV4，只用到 PUT / GET / DELETE / ListObjectsV2，单次 PUT 上限 5 GB）与 WebDAV（坚果云 / Nextcloud / 群晖，Basic 认证 + PROPFIND 列表）。不引 SDK，凭据存本机 settings（键名带 KEY/SECRET，备份的剔除密钥会抹掉）。配置在设置页填写，支持"创建后自动上传 / 上传后删本地"，远端列表可直接下载并恢复。
- 模型权重（`models/`）与引擎（`engines/`）不参与备份：体积大且可重新下载；生成的音频 / 图片 / 视频（`media`）默认也不备份。冒烟见 `scripts/backup-smoke.ts`（含加密、上传、坏库隔离三组场景）。

## 9. 端到端数据流

**一次聊天**：UI `rpcClient.sendChatMessage` → 主进程校验会话与模型 → 本地模式先 `ensureServerReady()`（必要时拉起推理服务）→ 组装 payload（历史转 OpenAI 格式、附件转 base64、联网检索结果与知识库召回作为 system 注入且**不落库**、每请求注入当前时间 system 消息防止模型按训练日期回答）→ `POST /v1/chat/completions` 流式 → SSE 解析出 `content` 与 `reasoning_content` → **40ms 批量下发**给 UI → 结束前先 flush 再发 `chatDone`。

**一次文档 OCR**：上传落盘 → 建 `documents` 行 → 逐页建 `pages(pending)` → 信号量并发 3 → 每页 VLM 识别 → 解析 HTML/Markdown + 裁图落 `images/<docId>/` → 更新计数并广播 `documentChanged` 让前端重查。

**一次生图**：参数校验 → MLX 后端确认权重已下载（**不再允许生成时自动下载**）→ 复用已加载的常驻 worker，否则一次性 CLI → JSON-lines 交互，stderr 解析 tqdm 步进 → 落 `images/gen/<uuid>.png` → 写 `image_records`。

**一次「带配图的写作」**：Agent 先 `media_search` 看有没有现成素材（没有就 `generate_image` / `generate_speech` 生成，`save_to` 直接落进工作区）→ `media_export` 把选中的素材复制到 `assets/` → `write_file` 写正文并引用相对路径。生成物同时留在素材库里，下次还能被检索到。

**一次 `omi launch codex`**：控制 socket 确认应用在线 → 解析模型 → 确保网关与推理服务 → 写 `~/.codex` 配置 + 刷新 AGENTS.md 记忆区块 + 挂 `omni-memory` MCP → spawn codex 并透传退出码。

## 10. 不变量清单（改代码前先读）

1. **`shared/*` 不 import electrobun**；**`bun/paths.ts`、`bun/db/index.ts` 不在模块作用域 import electrobun**。
2. **Python 脚本必须打进 bundle**（`electrobun.config.ts` 的 `copy` 里显式列出 `.py`），因为调用方用 `import.meta.dir` 同目录相对路径 spawn。漏掉时 Python 以"文件不存在"退出（退出码 2），表现为"模型检查/下载全部失败"这类误导性症状。
3. **子进程必须 detached + 杀进程组**，否则留下占显存的孤儿。
4. **路径穿越防护是调用方的责任**：下载落地、取消下载、媒体解析、Skills 删除各条路径都要显式校验，不能假设输入可信（repo 名、文件名、目录 id 都可能来自 webview 或控制 socket）。
5. **流式更新要节流**：chat 增量 40ms、下载进度 400ms、日志 80ms —— 都是为了避免 webview 高频重渲染。**emitDone 前必须 flush**，否则尾部乱序。
6. **图片服务无鉴权，只能绑回环。**
7. **新引擎只改 `shared/engines.ts` + 写一个 Runtime 实现**，别在别处硬编码引擎判断。
8. **出站 HTTP 走全局 `fetch`**（`bun/proxy.ts` 装的代理包装）**或显式 `proxy` 参数**；不要为远端主机另开 socket 或旁路 HTTP 客户端，否则那条请求会绕过用户的代理设置。本机 IPC（控制套接字的 `unix:` 请求）例外，包装层主动放行。
9. **小应用只能调用宿主放行的动作**（`shared/miniapps.ts` 的 `MINIAPP_ACTIONS`），转发层（`lib/miniapp-bridge.ts`）不得出现"按方法名透传 RPC"的写法；小应用页面必须保持在 `sandbox`（无 `allow-same-origin`）的 iframe 里。

## 11. 已知架构债

按影响排列，供后续迭代参考。

**巨型单文件**。`rpc/index.ts`（3500 行）同时承载类型契约与实现，是改动的天然冲突点；`gateway.ts`（2200 行）、`voice-screen.tsx`（2750 行）、`i18n.ts`（3260 行）、`app-sidebar.tsx`（1300 行）同理。**优先拆 `rpc/index.ts`** —— 把契约类型抽到 `shared/rpc-contract.ts`，webview 侧就能只依赖类型而不拉进主进程代码。

**死代码两处**：`chat-model.ts` 的 `getChatModel()` 全项目无引用（真实聊天链路是 `chat.ts` 自己拼 baseURL 后用原生 fetch）；`router.ts` 的 `server` 与 `stats` 两个路由只在类型定义里出现，没有任何调用方 `setRoute` 过去。

**遗留的第二套 CLI**：`src/cli/omni.ts`（1000 行）与 `omi` 并存，共用数据层但代码零复用，`docs/omni-cli.md` 也没有任何自动化校验。长期应收敛为一套。

**`cloud_providers` 表的双写**：激活的云厂商会把 baseUrl / apiKey / models 同步写回 `VLLM_API_BASE` 等旧 settings 槽位，以便网关、CLI、集成选择器零改动。这是有意的兼容层，但意味着"当前云厂商"状态存在两处 —— **表是真源，槽位是派生**。

**命名碰撞**：`shared/cloud-providers.ts`（预设数据）vs `bun/cloud-providers.ts`（表读写）；`bun/vllm/`（OCR 的 AI SDK 客户端）vs `bun/runtimes/vllm.ts`（引擎进程管理）。
