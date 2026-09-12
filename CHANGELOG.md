# Changelog / 更新日志

All notable changes are documented here. 所有重要变更记录于此。

Format follows [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/), and the project adheres to [Semantic Versioning](https://semver.org/lang/zh-CN/).

## [0.0.6-canary.0] - 2026-09-12

### Added / 新增

- **全局备份 / 恢复（设置 → 数据 → 备份与恢复）**：把云端模型配置与 API Key、本地技能、提示词、聊天记录、记忆库、知识库与本地生成的音频 / 图片 / 视频按**作用域**打包成一个 `.omnibackup` 文件（gzip + tar，内含 `VACUUM INTO` 数据库快照与 `manifest.json` 清单），换机或重装后一键恢复。界面支持逐项勾选并显示体积 / 条数预估、选择保存位置（含可用空间校验）、剔除明文密钥（便于把备份发给别人排错）、压缩开关、恢复前预览来源机器与内容、恢复时的实时进度与取消、自动生成 `pre-restore-*.omnibackup` 回退点，以及备份记录列表（恢复 / 定位 / 删除）。未勾选的作用域**既不进体积也不留残页**（表按 `secure_delete` 删除后 `VACUUM`），恢复按表整表替换（列取交集，兼容旧版本备份），文件同名覆盖且不删除备份里没有的文件。
- **备份加密（密码保护）**：创建备份可设置密码（AES-256-GCM + scrypt，流式加密，密码不落盘）；加密归档里连清单都读不到，没密码只能看到文件名与体积。容器头部带 keyCheck，密码错误立即报明确错误而不是解出乱码；GCM 认证 + 头部 AAD 保证被截断 / 篡改的归档一定报错（顺带修掉了明文 gzip 归档"截断到 tar 结束标记仍算读成功"的静默问题）。CLI 用 `--password` / `--password-file`，界面有密码框与"忘记密码=数据打不开"的提示。
- **备份远端存储（S3 兼容 / WebDAV）**：设置 → 数据 → 备份与恢复 新增「远端存储」，可配置 S3 兼容对象存储（AWS / Cloudflare R2 / MinIO / 阿里云 OSS / 腾讯云 COS，自实现 Signature V4，无需 SDK）或 WebDAV（坚果云 / Nextcloud / 群晖，Basic 认证），带「测试连接」「创建后自动上传」「上传后删除本地文件」；远端备份列表可直接下载并恢复，CLI 有 `omi backup remote list|test|download` 与 `omi backup create --upload`。网络请求带超时（元数据 60 秒 / 传输 20 分钟上限），不会无限挂起。
- **备份默认值调整**：生成的音频 / 图片 / 视频（`media`）与知识库向量改为**默认不备份**（体积大、可重算），配置 / 聊天 / 提示词 / 技能 / 记忆仍默认备份；勾选项按「配置与记忆 / 内容 / 大文件」分组展示，每项带体积与条数预估。
- **`omi backup` CLI**：`list` / `create` / `inspect` / `restore` / `remote` 子命令，与界面共用同一套内核（`src/bun/backup/`）；`--scopes` 选择作用域、`--out` 指定目录、`--redact` 剔除密钥、`--json` 供脚本消费，`omi help backup`、`omi guide`、`docs/omi-cli.md` 与设置页「命令行」页同步更新。该内核刻意不 import 数据层与 electrobun，因此**应用没启动、甚至数据库迁移失败起不来时也能把数据备份出来**（`scripts/backup-smoke.ts` 专门用一个坏库验证了这一点）；`restore` 需要独占数据库，应用在运行时会拒绝并提示改用应用内页面。
- **在线模型市场 · 双平台检索**：检索新增「平台」维度——ModelScope（modelscope.cn）与 Hugging Face（优先国内镜像 hf-mirror.com，失败回退 huggingface.co），按钮上直接标出真正请求的域名；检索、列仓库文件、下载字节三件事走同一平台，结果行 / 模型详情 / 下载任务 / 本地模型列表统一打来源徽标。HF 侧按下载量排序并过滤 private 与需登录的 gated 仓库（401/403/404/451 立即报明确错误，不再换域名空等一轮超时）；分页改为每页 20 条「加载更多」，ModelScope 显示真实命中总数，HF 无总数接口只如实显示「已加载 N 条」；平台与格式选择存全局 store，进详情页再返回不重置。
- **在线模型市场 · 格式筛选**：新增「跟随引擎 / 全部 / GGUF / safetensors / MLX」筛选，默认跟随当前引擎对应格式（llama.cpp→gguf、vLLM/SGLang→safetensors、MLX→mlx，换引擎即换格式）。格式只认平台元数据（HF 的 `tags` / `library_name` / siblings，ModelScope 的 `library:*` / `custom_tag:*`）与仓库实际文件后缀，**不再从模型名里猜**（名字带 GGUF 不再参与判断）；HF 走服务端 `filter=`，ModelScope 检索接口实测忽略一切过滤参数，改为把格式词并进检索词并按返回标签二次确认，界面文案说明两边差异；元数据缺失的仓库不会被筛掉。
- **模型详情 · 文件与下载同源 + 整仓库下载**：文件区新增「文件与下载来源」切换（默认取发现该模型时的平台，另标「原始来源：X」），列文件与下载严格同源，避免同一仓库两边路径不同导致的「列表里有、下载 404」；GGUF 按单文件下载，safetensors / MLX 这类仓库型模型的「下载整仓库（N 个文件）」会连同 `config.json` / tokenizer 等加载必需文件一起下；"已下载"判断改为按文件名（basename）比对，兼容 HF 的 `BF16/xxx.gguf` 子目录路径。
- **本地模型 · 三类来源与目录管理**：本地模型列表把「应用下载目录」「用户添加的目录」「Hugging Face 官方缓存」合并为一个列表，每行带来源徽标（应用下载 / 本地目录 / HF 缓存）、下载平台徽标与「整仓库」标记，顶部可按来源筛选并显示各来源计数，可「在文件夹中显示」。新增目录管理器：列出三类目录各自的模型数与占用体积，「添加目录」走系统选择器并**先扫描预览**（模型数 / 总体积 / 前 5 个文件，认不出模型不允许添加；应用自身目录、HF 缓存目录与已存在目录会被拒绝），移除只从列表摘掉、不删磁盘文件。扫描不要求标准目录结构（任意深度、文件直接放根目录、HF snapshot 指向 blobs 的符号链接都能认，隐藏文件跳过），HF 缓存按 `models--org--repo` 聚合为「整仓库」一行，并尊重 `HF_HOME` / `HUGGINGFACE_HUB_CACHE`。
- **本地模型 · 仓库型模型可加载**：vLLM / SGLang / MLX 的仓库型模型（目录内有 `config.json`）激活时记录并加载**整个仓库目录**（单个 safetensors 分片加载不了），GGUF 仍指向文件本身；复制出的启动命令与实际启动共用同一套运行时目标解析，两者一致。目录型条目的权重格式按目录内容判定，不再拿目录名当文件名猜扩展名。
- **Agent 素材工具**：内置 Pi Agent 新增 `media_search`（关键词 / 类型 / 来源 / 最近 N 天检索素材库，默认 12 条上限 50，结果带日期、提示词与绝对路径，并附素材库总量与其中 Agent 生成数量）、`media_export`（把素材复制进工作区按相对路径引用，自动防重名、拒绝越界）、`generate_image`（1–8 张，支持宽高 / 比例 / 负向提示词 / 种子 / 以图改图，可复制进工作区）、`generate_speech`（audio.cpp → 三方 Provider → 免费 Edge 在线依次回退，单次上限 5000 字）与 `generate_video`（提交后每 5 秒轮询，默认等 10 分钟、上限 30 分钟，超时或中断会明确告知产物稍后可被检索，不要在回答里假定已完成）。生成类工具会写文件且可能产生云端费用，只在 Agent / Goal 模式注入；`media_search` 只读，Plan 模式也可用。
- **Agent 生图「需要用户介入」弹窗**：Agent 调 `generate_image` 前检查生图后端是否就绪（缺 Base URL / ComfyUI 地址 / 未选模型 / MLX 引擎未装或权重未下载），不满足时弹出全局配置窗（任何页面都能弹）：可切换 OpenAI 兼容 / MLX / ComfyUI 三个后端（各带就绪状态点）、填地址与 API Key、「扫描模型」拉候选（ComfyUI checkpoint 或 `/v1/models`）、MLX 可直接装引擎并在窗内下载权重（带进度）。「确认并继续生图」后同一次工具调用继续跑且选择落盘到「图像」页配置；取消 / 关闭 / 超时 10 分钟 / 停止 / 会话重置都会立即收尾并明确告诉模型不要自行重试；同一时刻只保留一个弹窗，无界面监听（CLI / 无人值守）时按取消返回不挂起。
- **网关素材接口（只读）+ MCP `media_search`**：网关新增 `GET /v1/media`（`q` / `kind=image|video|audio` / `source=manual|agent` / `days` / `limit`，返回含绝对路径与可播放 URL 的结构化列表），MCP 端 `tools/list` 在知识库与记忆之外新增 `media_search`，Claude Code / Codex / Cursor 等外部智能体经网关即可查到并复用本机素材；与内置 Agent 共用同一份检索实现，鉴权与 `/v1/*` 一致，OpenAPI 已补端点说明。接口只读 —— 生成与导出仍只由界面或内置 Agent 触发。
- **素材来源标注（手工 vs Agent）**：`image_records` / `video_records` / `voice_records` 新增 `source` 列（迁移 `0024_media_source`，默认 `manual`），界面手工生成记为 `manual`、内置 Agent 与经网关生成记为 `agent`；图片与视频历史新增「全部 / 我生成 / Agent 生成」筛选，Agent 生成的卡片与侧栏记录显示「Agent 生成」徽标（手工生成不加标签，避免视觉噪音）。
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
- **设置 · 命令行手册页**：设置 → 工具 → 命令行，把 `omi` 的完整用法搬进应用——安装启用、启动应用与推理服务器、模型加载与切换、共享记忆（CLI / stdio MCP / HTTP MCP / REST）、编码工具（code）加载、引擎依赖与版本检查，每条命令与记忆接入片段都可一键复制（MCP / REST 片段里的网关地址取自当前设置）；内容与 `omi guide`、`docs/omi-cli.md` 同源（`src/shared/cli-docs.ts`），中英双语跟随界面语言。
- **架构文档**：新增 `docs/architecture.md` —— 面向维护者的结构说明：进程模型与五类进程边界、主进程各层（RPC / 推理运行时 / 模型库 / 智能层 / 媒体管线）、对外接口面（网关 / 图片服务 / 控制 socket 及端口与鉴权）、前端与 CLI 架构、数据层与目录布局、四条端到端数据流、不变量清单与已知架构债。

### Changed / 变更

- **工具页布局统一**：OCR / 图片 / 翻译 / 语音等工具页统一为「侧栏工具入口 + 左参数面板（引擎切换 / 配置 / 输入 / 主操作）+ 右结果区」，替换原先各自为政的页内切换方式。
- **设置页按组重构**：单文件设置页拆分为偏好组（通用 / 外观）、工具组（MCP / 记忆 / 联网搜索 / 云服务 / 默认模型）与「关于」页，配套抽出共用表单组件（`setting-ui.tsx`）与厂商图标表（`provider-logos.ts`）。
- **导航**：应用图标栏新增视频 / Skills / 知识库 / 记忆四个入口，Agent 图标改为 `CircuitBoardIcon`；各应用按统一工作台布局（左侧参数面板 + 右侧结果区）排布。
- **对话**：发送消息可挂载知识库（`kbIds`）并在重新生成时复用检索；assistant 消息新增 `citations` 字段承载引用溯源。
- **网关文档**：OpenAPI 补充 `/v1/memories`、`/v1/media` 端点与 `/mcp` 工具说明（总述改为「对话协议 + TTS / ASR + 共享记忆 + 本地素材库」）；`/v1/models` 聚合不变。
- **模型下载**：下载面板每个任务都显示来源平台徽标（此前无法分辨字节从哪个站拉取）；下载完成后把分类与来源平台写入仓库目录的 `.vllm-meta.json`，本地模型列表据此显示「从哪儿下的」（没有记录的老数据不显示来源）。
- **首次本地模型安装向导**：列文件与下载统一走 ModelScope（此前列文件走 ModelScope、下载却写死 hf-mirror 镜像，两边文件名不一致时会出现「列表里有、下载 404」），向导中明确标注「文件与下载均来自 ModelScope（modelscope.cn）」。
- **模型分类识别**：同时识别 ModelScope 的 `task:*` 标签与 Hugging Face 直接放进 tags 的 pipeline tag（含 VLM `image-text-to-text` 归为对话），命名启发式补齐 deepseek / glm / mistral，减少落入「其它」；市场与详情页的格式徽标改为按平台元数据展示。
- **`omi` CLI**：新增 `omi memory`（`add` / `search` / `list` / `mcp`）——应用运行时走控制 socket（`memoryAdd` / `memorySearch` / `memoryList`），未运行时直连 SQLite；`omi help memory` 有完整用法。
- **`omi` 帮助体系与手册**：新增 `omi guide`（纯文本 / `--md` / `--json` / `--lang en`）打印完整手册（安装、启动、模型加载、记忆调用、编码工具加载），`docs/omi-cli.md` 由同一份数据源生成（`omi guide --md`，`scripts/omi-docs-smoke.ts` 校验命令表、帮助文本与文档三者同步）；`omi help` 支持子命令与工具级帮助（`omi help memory add` / `omi help launch claude` / `omi server help logs`），`omi memory <子命令> -h` 等价；总览补齐此前遗漏的 `memory`、`guide` 与常用示例，`omi launch --list` 与错误提示指向对应帮助。
- **SQLite 并发**：数据库启用 WAL、`busy_timeout=5000` 与 `synchronous=NORMAL`，支撑 `omi memory` / MCP 桥接在应用之外直连同一个库读写。
- **媒体分发**：图片服务器为视频容器补全 MIME（`.mp4` / `.webm` / `.mov` / `.mkv` 返回 `video/*`，成片可用 `<video>` 播放）。
- **国际化**：中英双语词条补齐新应用与设置页（`shared/i18n.ts` 新增 1255 行），本次再补模型市场 / 素材来源标注 / Agent 生图配置弹窗 / 本地模型目录管理约 450 行。
- **文档口径对齐**：`ROADMAP.md` 完成度重估（生图闭环 / 视频生成 / 知识库 / 记忆 / MCP / Skills / 下载持久化 / `omi launch` 等已落地项从"未启动"移入已完成，vLLM / SGLang 一键安装与实测、内存生命周期、平台支持改为按实际状态标注，并注明 `scripts/backlog.tsv` 是一次性导入载荷、看板状态以 GitHub Projects 为准）；`AGENTS.md` 补齐遗漏的 `memory` / `guide` 命令、Agent SDK 与 MLX 引擎，并新增「Hard Rules」一节固化跨进程边界约定；README 中英双份的技术栈表补上 Agent SDK 与 MLX、修正残留的 `omni` 提法，并挂上架构文档入口。

### Fixed / 修复

- **备份恢复：归档可以把文件写到任意目录（安全）**：技能中央库是唯一不受数据目录约束的文件根，而恢复写回文件时按「恢复后的设置」重新解析它的落地目录 —— 那份设置来自归档本身。于是一个做过手脚的备份只要把 `SKILLS_CENTRAL_PATH` 指向 `$HOME`（或 `~/Library/LaunchAgents`），再带上 `data/files/skills-repo/.zshrc`，就能在用户从未授权的位置覆盖任意文件；而这正是文档推荐的「把备份发给别人排错」场景。现在落地目录只认**恢复前**本机设置里的值：归档只能决定写哪些文件，不能决定写到哪个根，两处路径不一致时给出提示。
- **备份恢复：离谱的 scrypt 参数能让进程吃光内存**：KDF 的 N / r / p 写在归档头部（外部输入），`unlock()` 直接喂给 `scryptSync`，而 `maxmem` 又是按 N×r 算出来的，内置护栏永远不会触发 —— 一个 147 字节的文件声明 `N=2^30` 就能让进程去申请 1 TiB，`N=2^28` 直接把线程挂死。现在打开归档时就按「单次派生 ≤ 256 MB」校验参数并拒绝，明文报「密钥派生参数不合法」。
- **备份恢复：归档声明的条目长度能撑爆内存**：读取长度来自 tar 头，一个 61 KB 的 gzip 声明清单有 64 MiB，预览就要 1.2 GiB 内存、3 秒（128 MiB → 1.9 GiB / 11 秒，而备份列表会对每个文件都做一次），原因是读取时逐块 `Buffer.concat`（O(n²)）。现在单次读取有 8 MiB 上界，且攒够再拼一次。
- **备份恢复：数据库已提交后整次恢复仍可能失败**：`rename` 失败一律退回复制，而目标是个目录（EISDIR）或源文件已被重复条目搬走（ENOENT）时复制同样失败，于是「数据库回来了、文件一个没写」。两个条目归一化到同一路径（`a/../b` 与 `b`）现在会在解包阶段识别并跳过后者，写回失败的单个文件改为记入警告继续（数据库事务此时已提交，不该让整次恢复失败）。
- **备份恢复：新机器上恢复"成功"但什么都没恢复**：目标库不存在时，整表替换会对每张表判定「本机没有表」全部跳过，最后报告写回 0 条记录 0 个文件。恢复只做替换、不建表（内核刻意不依赖数据层，拿不到那批迁移），所以现在直接报错并提示「先启动一次应用让它建库，或改用应用内页面」，不再给出假成功。
- **`omi backup restore` 无法用交互输入的密码恢复加密备份**：提示输入的密码只用于重新 `inspect`，传给 `restoreBackup` 的仍是原来的 `undefined`（另有一行 `effectivePassword` 算了却从没用过），于是终端里只有 `--password` / `--password-file` 能用。现在输入的密码会回流到恢复调用。
- **`omi backup delete` 能删任意文件**：目录白名单取自调用方同时传入的 `dir`，把目标文件的父目录当 `dir` 传进来就绕过了守卫，且不校验扩展名。现在除目录边界外还要求「确实是备份文件」（`.omnibackup` 扩展名 + 备份魔数），非备份文件一律拒绝并说明原因。
- **远端下载中断会在最终文件名上留下半截备份**：下载直接写目标路径、不校验长度，短包只会照常返回，流中断后列表里就多出一份「损坏的备份」（取消下载同样如此）。现在先写 `.part`、核对 content-length 后原子改名，失败即清理。
- **S3 兼容存储列取备份必然 403**：`ListObjectsV2` 的签名用了去掉尾部斜杠的路径，而真正发出的请求仍带斜杠 —— SigV4 下 canonical URI 必须与请求逐字节一致（AWS 不做路径归一化），真实 S3 会直接拒绝；只有测试用的假服务端不校验 canonical URI 才没暴露出来。现在签名与请求共用同一个 path，查询串也改用同一套编码（`URLSearchParams` 会把空格编成 `+`，而签名用 `%20`，带空格的 prefix 同样对不上）。
- **「创建后自动上传」是死开关**：`autoUpload` 会被保存、会渲染成开关，但没有任何代码读它，用户打开它之后备份并不会自动上传（文档还写着它会生效）。现在创建备份时真的会读它；恢复前自动生成的 `pre-restore-*` 回退点除外（就地兜底用，推远端既不符合预期，也会让恢复多受一次网络波动影响）。
- **备份清单缺字段会让恢复页白屏**：预览只校验格式与版本，缺 `db` / `tables` / `scopes` 的清单能通过预览，随后在恢复面板渲染时抛 `TypeError`（整页空白），恢复本身也以 `Cannot read properties of undefined` 收场。现在这些字段在预览阶段就校验并提示「文件可能已损坏」。
- **创建备份时传入的文件名可以越出目标目录**：`fileName` 来自 webview / CLI 且未净化，`../../x` 会把归档写到所选目录之外；现在只取 basename（缺扩展名时仍自动补 `.omnibackup`）。
- **迁移 0013 在老库升级时被跳过**：drizzle 以「库内已记录的最大 `created_at`」判断是否跳过迁移，而 `0013_uneven_lester` 的 `when` 小于前一条 `0012`，导致从旧版本升级的用户（库内最大 `when` 已被后续迁移抬高）**不会建出 `user_prompts` 表**，「我的提示词」功能直接报错；现将其 `when` 调整为严格递增区间内，并把该迁移改写为幂等 DDL（`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`），使「已建表 / 曾被跳过 / 已升到最新」三种库都安全。
- **知识库向量补齐**：`embedDocChunks` 内改为循环外复制一份配置对象（原写法在循环中展开累加，且可能污染调用方传入的对象）。
- **手册漂移无人拦截**：`scripts/omi-docs-smoke.ts` 校验命令表 ↔ 帮助文本 ↔ 数据源 ↔ `docs/omi-cli.md` 四者同步，但它此前既不在 `test:smoke` 列表里、CI 也不会执行，文档漂移事实上不会被发现；现已纳入 `test:smoke`，随 CI 一起跑。
- **在线模型市场 · ModelScope 分页总数读错字段**：检索接口返回的是 `total_count`，此前读 `total` 导致「共 N 条」永远等于当前页条数、加载更多判断错误；现显示真实命中总数并正确分页（Hugging Face 本就没有总数接口，改为如实显示「已加载 N 条」而不是编造总数）。
- **模型详情「已下载」误判**：已安装列表登记的是文件名，而 HF 仓库常见 `BF16/xxx.gguf` 这类子目录路径，此前用完整路径比对导致已下载的文件仍显示成可下载；现统一按 basename 比对。
- **删除本地模型静默失败**：此前删除吞掉错误、只能删单个文件且无越界校验，用户看不到任何反馈；现在返回明确错误与原因并在行内展示，目录型条目按整目录删除、HF 缓存整条 `models--org--repo` 删除（否则只删软链一个字节都不释放），非白名单路径一律拒绝并给出说明。
- **复制出的启动命令与实际启动不一致**：仓库目录型模型实际是整目录加载，而复制命令仍按文件名猜引擎并把文件路径交给运行时；现在两条路径共用同一套运行时目标解析，"复制的命令"和"实际启动的"一致。
- **Hugging Face 检索结果里的私有 / 受限仓库**：此前 gated（需登录并接受协议）与 private 仓库也会列出，用户点了下载才撞 401；现在列表阶段直接过滤，且 401/403/404/451 立即抛出明确错误而不是换个域名再等一轮超时。
- **冒烟脚本不可重复运行**：`memory-smoke` / `mcp-smoke` / `omi-docs-smoke` 用固定名字的临时目录且从不清理，第二次运行时 `memory-smoke` 的计数断言（列表 2 条 / 检索命中 / 删除后剩 2 条）会读到上一轮残留数据而失败，"重跑一遍 test:smoke 就红"；现统一改为 `mkdtempSync` 建一次性目录并在结束时清理（与 `kb-*` / `video-gen` 冒烟脚本一致），调用方显式传 `OMNI_DATA_DIR` 时仍保留现场。

### Internal / 内部

- 新增迁移：`0014_talented_network`（Skills 预设工具开关 `preset_skill_tools`）、`0015_slippery_vulture`（`cloud_providers`）、`0016_lean_turbo`（`mcp_servers`）、`0017_knowledge_base`（`knowledge_bases` / `knowledge_docs` / `knowledge_chunks`）、`0018_strong_corsair`（`memories`）、`0019_add_video_records`（`video_records`）、`0020_kb_rerank`（`knowledge_bases` 增加重排模型 / Base / Key 三列）、`0021_tense_dragon_man`（补 `messages` / `agent_events` / `knowledge_*` 的会话与外键索引）、`0022_memory_lifecycle`（`memory_events` / `memory_metrics` 与记忆状态 / 指纹 / 作用域索引）、`0023_kb_governance`（`kb_events` / `kb_ingest_jobs` 与文档来源路径索引）、`0024_media_source`（`image_records` / `video_records` / `voice_records` 增加 `source` 列区分手工与 Agent 生成）。
- 新增主进程模块：`video-gen.ts`、`cloud-providers.ts`、`mcp.ts`、`mcp-playground.ts`、`kb-mcp.ts`、`knowledge.ts`、`memory.ts`、`memory-api.ts`、`memory-sync.ts`、`release-check.ts`、`skills/`（13 个文件：中央库 / 安装器 / 同步引擎 / 扫描 / 元数据 / 预设 / 项目 / 审计 / 备份等）、`backup/`（5 个文件：归档内核 / tar / 加密 / 远端存储 / 作用域归置，刻意不依赖数据层与 electrobun）、`media-tools.ts`（Agent 侧素材检索与生成工具，兼素材库内核）、`media-api.ts`（网关对外只读素材接口）、`media-setup.ts`（Agent 生成前的「需要用户介入」通道）、`model-scan.ts`（本地模型目录扫描）、`huggingface.ts`（市场检索的 HF / hf-mirror 数据源）。
- 新增前端：`video-screen.tsx`、`dashboard-screen.tsx`、`memory-screen.tsx`、`kb/`（6 个文件）、`skills/`（9 个文件）、`main-layout/backup-tab.tsx`、`components/media-setup-dialog.tsx`、`components/{media-,}source-badge.tsx`、设置页各组面板与 `stores/{video,kb,memory-ui,skills,backup,market,media-setup}.ts`。
- 新增脚本：`apps/studio/scripts/migrations-smoke.ts`（journal 单调性 + 全新库建表 + 重复打开幂等；本次正是它先暴露出 0013 的 `when` 倒挂）、`apps/studio/scripts/backup-smoke.ts`（加密备份往返 / 远端上传下载 / 坏库下的离线可用性）。
- 备份内核新增「归档不可信输入」测试组（`backup/index.test.ts`）：伪造归档改写技能库落地目录、非法 KDF 参数、声明 1 GiB 的条目长度、缺字段清单、重复条目、非备份文件删除、`../` 文件名、空库恢复，各一条回归用例。
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
