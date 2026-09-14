# Changelog / 更新日志

All notable changes are documented here. 所有重要变更记录于此。

Format follows [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/), and the project adheres to [Semantic Versioning](https://semver.org/lang/zh-CN/).

## [未发布] / Unreleased

### Added / 新增

- **网关页端点列表新增「嵌入服务」两行**：网关代理地址 `{网关地址}/v1/embeddings` 与直连嵌入实例的实时地址 `http://127.0.0.1:{port}/v1/embeddings`——端口取**最后一个运行中**的嵌入实例（与主进程解析规则同源），host 固定 127.0.0.1（`SERVER_HOST` 可能是 `0.0.0.0`，照抄实例 endpoint 会复制出连不上的地址）；无运行实例时直连行显示「未运行」+ 引导且复制禁用，行不消失。
- **默认模型新增「全局默认嵌入模型」（快照语义）**：面板可配嵌入模型 + 可选服务地址/密钥（`EMBEDDING_MODEL` / `EMBEDDING_BASE` / `EMBEDDING_API_KEY` 三键，bun 侧唯一读取点 `globalEmbeddingDefaults()`）。**全局默认只在写入时生效**：新建 KB 自动预填三字段；既有 KB **不被静默切换**，在知识库设置页点「启用向量检索」显式启用（写入该库配置并真的排入重嵌，无可用嵌入后端时按钮禁用并提示）；共享记忆设默认即走向量检索（`MEMORY_EMBEDDING_MODEL=none` 可显式关回纯关键词，清空全局默认同样回落）。**既有 KB 端点零漂移**：`resolveEmbeddingBase` 与 rerank 解析链保持原样（快照语义的设计出发点——解析期全局层级会让既有 KB 的服务地址被静默改道、维度漂移只在检索时报错）。

- **嵌入类模型现在真的能当嵌入服务用（自动 `--embeddings` + 专属端口 + 聊天零扰动）**：过去把嵌入模型（GGUF）加进来只能当聊天模型启动 —— llama.cpp 默认禁用嵌入端点、而运行时从不传 `--embeddings`，`POST /v1/embeddings` 直接 501（错误原文就写着 "Start it with --embeddings"）。更糟的是知识库的嵌入模型选择器**按模型名**过滤（名字里带 embedding 就列出来），选中必失败 —— 一个「列得出、调不通」的完整陷阱。现在：类别为 embedding 的模型经应用启动时自动以嵌入模式服务（`--embeddings --pooling`，池化方式由 `EMBEDDING_POOLING` 设置，默认 `last`），监听独立的嵌入端口段（`EMBEDDING_PORT` 默认 18190，与聊天 18080 段各自 +100 顺延、互不重叠）；嵌入实例**完全不参与聊天活动状态** —— 不写 `SERVED_ACTIVE_ID` / `CHAT_MODEL` / `LOCAL_MODEL_PATH`、不抢活动端口、聊天实例停止时也不会被自动提升成聊天目标（命令行快照测试锁定聊天路径逐字节不变）。嵌入服务地址解析改为四层：逐库显式地址 > 运行中的嵌入实例 > `SERVER_MODE=remote` 的 `VLLM_API_BASE` > 活动端口；非 llama.cpp 引擎收到 embedding 类别模型时明确拒绝启动，不再起一个没有嵌入端点的实例。
- **网关新增 `POST /v1/embeddings`**：外部客户端（OpenAI SDK / Continue / LangChain 等）可以经网关取嵌入，鉴权与 Origin/Host 防线与其他 `/v1/*` 完全一致；没有运行中的嵌入实例时返回 503 并给出可操作引导（「先在模型页启动嵌入类别的模型，或在知识库设置里配置嵌入服务地址」）。路由同时登记进 `endpoints` 列表与 `openApiSpec`（`/docs`、`/openapi.json` 同步可见）。
- **模型类别可改，分类不再被平台弱标签压过**：HF 仓库常给嵌入模型挂 `conversational` / `text-generation` 这类宽泛标签，而分类器是「标签优先」，于是 `WeMM-Embedding-9B` 这类模型被归成对话模型（实测该仓库 tags 确实含 `conversational`）。现在名字判定为嵌入时不再被**弱对话标签**压过（`text-to-image` 等强标签仍优先）；模型详情页新增类别下拉（chat / embedding / rerank / tts / asr / image / video，仅市场下载的模型可改，改完写 `.vllm-meta.json` 并回读确认落盘）；知识库的嵌入模型选择器改为只列**运行中嵌入实例**提供的模型，没有嵌入实例时显示空态与引导，而不是列出聊天端口上名字带 embedding 的模型。

- **云端模型统一成「先选云厂商、再选模型」：功能页不再填地址与密钥**：生图 / AI 修图 / 生视频 / 语音合成 / 语音识别 / 实时翻译 / VLM OCR 过去各自有一份「地址 + API Key + 模型名」表单，用户在「模型云服务」里配过的厂商到了这些页面完全看不见，只能把地址与密钥再抄一遍（Agent 的生图弹窗也一样，明明是配置引导却在教用户重复输入）。现在这些页面只做两件事：选**已启动**的云厂商、选该厂商下**对应用途**的模型，连接信息统一由 `cloud_providers` 表提供（`IMG_PROVIDER_ID` / `TTS_PROVIDER_ID` / `ASR_PROVIDER_ID` / `OCR_PROVIDER_ID` / `VIDEO_PROVIDER_ID` 五个新槽位只存厂商 id）。配套改动：模型条目有了**用途分类**（生图 / TTS / ASR / 生视频 / 对话 / 嵌入 / 重排，未标注的按模型名自动识别，设置页可逐条改并支持还原成「自动识别」），各功能页选择器只列本用途的模型——生图看不到 ASR 模型、TTS 看不到对话模型；新增共享组件 `CloudModelSelect`（厂商 → 模型两级选择器 + 空态引导去设置），对话 / Agent / 翻译的模型下拉也按厂商名分组。生视频还多一层：视频 API 各家不通用，厂商要选「生视频接口」（MiniMax / Seedance），只有选了协议的厂商才会出现在生视频选择器里；任务轮询按**记录里的厂商**查上游，提交后切厂商不会让在途任务查不到。
- **实时语音通话（云端模式）的密钥也改成从厂商取**：「通话 → 云端模式」过去要手填 DashScope API Key 与 WebSocket 地址，是最后一个还在要求用户输入凭据的功能页。现在选**已启动的云厂商**即可（百炼/ DashScope 厂商排在前面，自建中转照样可选），Key 由主进程从厂商行解析（`VOICE_CALL_REALTIME_PROVIDER_ID`，旧版手填的 Key 仍作兜底并在界面上说明）；实时模型列表 = 厂商的模型 + 内置实时型号，WebSocket 地址保持默认即可。
- **云厂商可同时启动多个，启动时校验密钥**：过去那个开关等于"唯一激活的对话厂商"，切换即切换全局 `SERVER_MODE`——于是"生图用 A、对话用 B"做不到，各功能页只好各存一份配置（见上条）。现在开关的语义是**启用**：可以同时启用任意多个厂商，启用时拿 `${base}/v1/models` 校验密钥（401/403 判定"密钥无效或没有权限"且不启用；本机端点如 Ollama / LM Studio 允许空 Key），校验通过顺手把探到的模型并进该厂商清单，失败原因显示在厂商详情里并落一条 `cloud-provider-enable-failed` 日志。功能页可选厂商 = 已启用 ∩ 有该用途的模型。停用激活中的厂商会回到本地推理模式（否则对话会继续打到一个已停用的地址）；「设为默认模型」仍是把某厂商设为对话默认来源（写回 `VLLM_*` 槽位），与启用 / 停用互相独立。
- **老配置自动搬家（各功能页的地址 + 密钥 → 厂商行）**：升级后不用重填——首次读取时把 `IMG_API_*` / `TTS_PROVIDER_*` / `ASR_PROVIDER_*` / `OCR_PROVIDER_*` / `VIDEO_MINIMAX_*` / `VIDEO_SEEDANCE_*`（视频后端 `minimax`/`seedance` 归一成 `cloud`，模型键并入 `VIDEO_MODEL`）按地址合并或新建为厂商行、置为已启用、把该页的模型按用途登记进去，再写上新槽位；地址还是默认值又没填过 Key 的不搬（否则 TTS / 视频会给每个用户凭空多出几个用不了的厂商）。迁移带 `CLOUD_APP_PROVIDERS_MIGRATED` 标记，只跑一次。

- **统一应用日志（排查任何问题的第一入口）**：过去失败信息散在三处——推理服务器日志只在内存里（停止即丢）、媒体管线失败只有一句瞬时错误、语音调试写 `/tmp/omni-voicecall.log`，"生图为什么失败"这类问题事后没有任何现场可查。现在 `src/bun/app-log.ts` 把**事件级**记录收敛到一处：`<数据目录>/logs/app.log`（逐行 JSONL，2MB 轮转保留 5 份，key/token/secret 等字段自动脱敏成 `***`，单条 detail 有上限），同时保留最近 2000 条内存环形缓冲供实时读取。已接入的失败路径：主进程生命周期与未捕获异常 / 未处理 rejection（含堆栈）、通知中心每一条（自动化失败、权限请求、媒体服务被占…）、生图与生视频（含后端、模型、地址、提示词片段）、TTS / ASR / OCR 三条管线、推理服务器启动失败与运行中崩溃、模型下载失败、Agent 回合错误与工具失败、数据库迁移失败，以及 **webview 侧**的渲染错误与全局未捕获错误（新增 RPC `writeAppLog`，source=client）。读取入口：`omi logs`（新增命令，支持 `--level/--source/--event/--search/--limit/--verbose/-f/--json/--path/--clear`，**应用没运行或已闪退时直接读磁盘文件**）、控制 socket `logs`/`logsPath`/`logsClear`、RPC `getAppLogs`/`getAppLogInfo`/`clearAppLogs`。推理服务器 stdout 仍不进 app.log（逐行刷盘不值得），继续走 `omi server logs` 的内存缓冲。
- **`omi-doctor` 排障技能 + 一条命令的现场采集**：`.agents/skills/omni-doctor/`（SKILL.md + 日志 / 接口 / 故障手册 / 升级判断四份参考）把"应用某个功能不好使"变成有据可依的流程：先采证 → 按错误原文对到成因 → 给出界面或命令级修复动作 → 配置与环境都无问题时按模板判定为代码缺陷并说明需要升级。**技能随应用打包内置**（`src/bun/builtin-skills/` → bundle 的 `bun/builtin-skills`），启动时由 `builtin-skills.ts` 播种进中央技能库（`~/.agents/skills`），装完应用就能在 Skills 中心看到、也能同步给 Claude Code / Cursor 等工具；播种规则是"绝不碰用户的东西"：同名技能不是我们装的就不动、用户改过的副本不再自动更新、用户删掉后记墓碑不复活（想恢复删掉中央库 `.omnistudio/builtin.json` 里的对应条目即可）。配套 `bun run --cwd apps/studio scripts/omni-diag.ts`（`--json` 供脚本）**只读**采集完整现场：版本 / 数据目录 / 磁盘、应用与推理服务器和网关状态、统一日志里的 warn/error（按子系统归类）、媒体服务端口占用者身份、数据库里最近失败的生图 / 生视频 / 语音 / 文档（含 `pages.error`）/ 基准 / 自动化 / Agent 事件、关键配置是否就位（密钥只报有无）。应用没运行也能跑——起不来和闪退才是它最重要的用途。

### Changed / 变更

- **设置页删掉重复的「偏好 → 通用」，自启动开关搬到「概览」**：那一页三条设置里两条是重复入口——更新通道与「关于」页的「测试计划」是同一个 `UPDATE_CHANNEL`，自动检查更新与「关于」页的「自动更新」是同一个 `AUTO_UPDATE`，只是两处控件写法不同（下拉 / 勾选框）让人以为各管一摊。整页删除，偏好组只剩外观 / 关于；唯一独一份的「启动应用时自动拉起本地推理服务」（`AUTO_START_SERVER`，`omi start` 后的自动拉起靠它）移到推理服务自己的「概览」页，和启停按钮同卡片，改动即时生效。回归测试锁住导航里不再出现「通用」、且这条开关仍能写进设置。同类清理：路由表里 `server` / `stats` 两条早已无人跳转（控制台 / 概览都已在设置页内，`navigate` 白名单同步收窄），以及 29 条设置页改版留下的死文案（旧端点列表 / 本地模型分组 / 关于区块等，界面与测试均已不再引用）。

- **设置菜单第二轮去重：「性能」「记忆」两个标签并入各自的功能页**：顺着「通用」往下查，设置导航里还有两处同类冗余。**「性能」**页（`SERVER_CTX_SIZE` / `SERVER_GPU_LAYERS` / `SERVER_PARALLEL` / `SERVER_BATCH_SIZE` / `SERVER_CACHE_TYPE_K,V`）与「本地模型」页的启动参数面板是同一批键，两处都能改、保存语义还不同（一个按保存、一个即时生效），页里的标签甚至是硬编码英文——现在整页删除，独有项 `SERVER_UBATCH_SIZE`、`MAX_VLLM_RETRIES`、`MAX_VLLM_FAILURE_RETRIES`、`PAGE_CONCURRENCY` 作为「重试与并发」分组并入本地模型页的启动参数面板（KV 缓存维持一个控件、同时写 K 与 V），界面首次有中文文案。**「记忆」**标签（设置 → 工具）渲染的五张卡片与一级应用「记忆」页完全同源、且少一个统计总览，整页删除，管理入口只剩应用页。顺带清掉死代码：`app/local-engines/` 整个目录（`llm-panel` / `asr-panel` / `shared`，约 2000 行）零引用，是这两个页面重复表单的历史来源，一并删除。回归测试从"导航里没有「通用」"升级为**锁死整份导航清单**，并新增"原「性能」页的设置键在本地模型页都有入口"的守卫，防止删页面顺手删掉设置。

### Fixed / 修复

- **启动嵌入模型不再写脏聊天模型配置（防串层补全）**：第一轮修复让嵌入**实例**不触碰聊天活动状态（`SERVED_ACTIVE_ID` / 活动端口），但模型页启动按钮的前置步骤仍会对嵌入模型调用 `setActiveModel`，把 `LOCAL_MODEL_PATH` / `LOCAL_MODEL_NAME` / `CHAT_MODEL` 三把聊天配置键写成嵌入模型——`omi model --list` 会给嵌入模型标 ● 活动，冷启动 auto-start 按这三把键找目标时只拉起嵌入实例、聊天无模型可用。现在三层防线：① `setActiveModel` 加**类别守卫**（嵌入 / 重排目标直接拒绝且零写入，模型库 / CLI / 控制通道所有入口通吃）；② UI 定点放行（本地模型页启动按钮对嵌入行跳过前置激活、直接按路径起嵌入实例；「激活」按钮对嵌入行隐藏，聊天启动条与 OCR VLM 选择器不再列嵌入 / 重排模型）；③ **启动自愈** `healDriftedChatConfig`——老版本写脏的库在 auto-start 之前检测并清掉三把键（仅判嵌入，保守处理），落一条 `chat_config.heal_drifted` 日志。
- **嵌入实例处理长文档必崩（物理 batch 太小触发 GGML 断言）**：llama.cpp 在 `--embeddings` 下会强制 `n_batch = n_ubatch`（不显式传值时压到 512），而物理 batch 就是单次能喂进模型的 token 上限 —— 超过它的请求在 `--pooling last` 时触发 GGML 断言**直接崩进程**（退出码 5，日志只留一句 `Process exited with code 5`），`--pooling mean` 时返回 500。知识库导入的 markdown 文档轻松超过 512 token，表现就是「一导入就崩 → 网关报嵌入服务未运行 → KB 下拉为空」。服务端错误原文点明了这一层：`input (631 tokens) is too large to process. increase the physical batch size (current batch size: 512)`。现在嵌入模式改为 `--batch-size` = `--ubatch-size` = `ctx-size`（塞得进上下文的文本就一定嵌得进去，不留静默上限），聊天路径仍是聊天调优的 256/64。
- **启动白屏：前端包被塞进了主进程代码**：通话页为拿一个模型名常量，从 `bun/realtime-voice.ts` **值导入**了 `DEFAULT_REALTIME_MODEL`；而这次改动又让该模块去 import 云厂商模块（`cloud-providers` → `db` → `paths`），后者在模块级调用 `os.homedir()` —— webview 里没有 Node 内置模块，打包后一加载就抛 `(0, y7.homedir) is not a function`，React 树根本没机会挂载，窗口纯白，**而且因为前端 JS 压根没跑起来，连一条 client 错误日志都不会留下**（事后只能靠「日志里什么都没有」反推）。现在常量搬进 `src/shared/realtime-voice.ts`（两个进程共用一份，不再各写各的），`bun/realtime-voice.ts` 转出以保持既有导入方不变，`update-store.ts` 那处对 `@/bun/updates` 的纯类型引用也改成 `import type`。另加静态守卫 `tests/webview-import-guard.test.ts`：mainview 下任何文件对 `bun/*` 的值导入都会让测试失败（`import type` 放行），并自带判据自检 —— 这类故障在运行时只表现为"白屏且无日志"，必须靠构建/静态检查拦住。
- **「通话 → 云端模式」整页崩掉（`Cannot access 'providerId' before initialization`）**：云端配置引导在 `.find()` 的回调里读 `providerId`，而那个 `useState` 声明写在下面几行 —— 厂商列表**非空**时渲染即抛 `ReferenceError`，等于选了云端模式就再也打不开这一页。声明挪到读取之前，并补上引导面板的渲染回归测试（原先没有任何用例渲染过它，所以整个套件是绿的）。
- **云端厂商「启动」时探错地址（Gemini 这类永远启用不了）**：密钥校验按「补 `/v1/models`」拼地址，对 `https://generativelanguage.googleapis.com/v1beta/openai` 这种本身已带版本段的 base 会探到不存在的路径（404）——而启用是各功能页选到该厂商的前提，于是这家在界面里等于不存在。现在按仓库既有的两种约定依次试（先 `/models`，不是模型清单或 404 再补 `/v1/models`），401/403 仍立即判定为密钥无效。
- **升级时在途的生视频任务被误报「厂商已删除」**：`provider_id` 那一列是新加的，升级前提交的记录没有它，轮询便直接落到「查不到上游」分支 —— 其实那次任务的地址与密钥刚被迁移成当前选中的厂商行。现在旧记录（backend 为 `minimax` / `seedance`）回落到当前厂商去查，与「提交后切厂商也能把在途任务查完」是同一套行为。
- **换生视频厂商后分辨率 / 时长没有跟着收敛**：档位是按接口协议分的（MiniMax `480P`/`768P`/`2K`、时长上限 15s；Seedance `480p`/`720p`/`1080p`、上限 12s），此前只在切「后端」时收敛，从 MiniMax 厂商换到 Seedance 厂商就把上一个厂商的档位原样发了出去。现在协议一变就收敛，且供应商下拉里百炼 / DashScope 真的排在最前（比较器此前写反）。
- **选了云端模型，却报 `{"code":20012,"message":"Model does not exist..."}`**：切模型是瞬时的，选云端**不会停掉**正在跑的本地实例，而请求侧取模型名的那条路径把「已启动实例」排在设置之前、且不看运行模式 —— 于是云端请求带着**本地模型名**（MLX 下是一个绝对路径）打到厂商接口，对方只认自己的模型名，回一句"模型不存在"；会话标题还写着本地模型，看起来就像"云端没这个模型"。现在按模式取名字：云端模式只认云端模型槽位（`VLLM_MODEL_NAME`），本地实例只在本地模式代表"当前模型"，展示用的模型名（会话标题 / 用量统计 / 通话）同步按模式取。同一类问题还有一处：激活厂商时自动选的默认模型原来取清单**第一条**，而清单第一条常常是用户最早配的生图 / 语音模型（比如 OmniLabs 的 `Qwen/Qwen-Image-2512`），拿它当对话模型同样是这句报错 —— 现在优先挑第一个**对话**模型，一个都没有时不拿非对话模型顶替。
- **对话的模型下拉：云端只列「模型云服务」里配好的对话模型**：云端那一半过去拿的是服务商 `/v1/models` 的全量清单（再加当前配置的模型名）按名字重认一遍分类，于是**没添加进清单**的模型也会冒出来，认不出名字的生视频 / 语音模型（`MiniMax-H3` 这种）又会被当成"未知"留在列表里——挑中的常常是一个发不出聊天的模型。现在厂商模型列表是唯一事实来源：厂商已启用、模型是用户添加过的、用途分类是对话才进下拉；显式标注的用途优先（标成 video / tts / asr / 生图的一律不进），名字认不出的照旧保留（自定义 / 自建端点不受影响）。顺带给 `classifyModelName` 补上 MiniMax 的生视频型号（`MiniMax-H3` / `MiniMax-H3-Max`；它的对话模型是 M1 / Text-01），这两个模型从此在生视频页显示为视频，而不再以"其他"混进对话列表。当前配置的模型若已从清单里删掉，下拉框把它标成「当前」占一行显示，避免看起来像没选模型。
- **媒体直链一律 403（TTS 音频点预览报「音频文件不存在或已被删除」）**：`/<相对路径>` 这条路由（聊天图片 / 生成图 / OCR 页图 / TTS 音频共用，URL 由 `chatImageUrl` 拼成）把带前导 `/` 的 pathname 直接交给 `safeJoin`，而它按设计把绝对路径判为越界——**每一个**媒体请求都拿到 403，音频文件其实好好躺在 `images/audio/` 里；网关的 `/v1/audio/speech` 也走同一 URL 取字节，同样以「音频读取失败 (403)」收尾。现在先剥掉前导斜杠再拼接，目录请求改判 404（不再让 `Bun.file` 去读目录），并补上这条路由的回归测试（音频 / 图片 MIME、Range 206、缺失与越界）。
- **媒体服务端口被占后不再静默降级（第二个实例整会话没有媒体服务）**：端口是固定的 19782，而 dev / canary / 正式版各有一份数据目录——两个实例同时开着时，后启动的那个只把 `EADDRINUSE` 吞进 `console.warn` 就再无下文：图片、音频预览全挂（而且端口上若是另一个数据目录的实例，同名文件还会取到别人的）。现在媒体服务会应答自己的身份（`/__omni/media-id`，返回数据目录指纹与 pid），后启动的实例据此区分三态并在顶栏亮出来：`serving`（自己服务）/ `shared`（端口上服务的是**同一份数据目录**的另一个实例，效果等同正常）/ `blocked`（另一个数据目录或不相干的软件占着，预览可能失败或串数据）。`blocked` 时每 5 秒重试绑定，对方退出即自动接管（不用重启应用），并落一条错误通知、恢复时补一条「已恢复」。
- **技能 id 越界（安全）**：`skillId` 从 webview 一路走到文件系统，而上次加固只覆盖了 `deleteSkills`——同步 / 卸载 / copy 目标重推 / 读 `SKILL.md` / 「在文件夹中打开」都还是 `join(中央库, id)`，`../..` 能把它们变成对中央库外任意目录的软链替换、拷贝覆盖或递归删除。现在统一走 `centralSkillDir()`（单层目录名 + 库内限位），非法 id 在触碰文件系统之前就被拒。
- **Agent 生图 / 生视频的参考图绕过读取授权（安全）**：`generate_image` 的参考图与 `generate_video` 的首帧只过了凭据黑名单，没过读取授权——被注入的提示词可以把工作区外任意图片（如 `~/Pictures/…`）暂存后送进（多为云端的）生图接口，等于把本地图片读出去。现在与 `read_file` 同一套策略：工作区外的路径按 `external_directory` 授权（弹窗可「始终允许」按目录记住并写入授权目录），工具侧再用 `assertReadable` 兜底；素材库引用（`#3` / `image#3` / `media_search` 给的 ref）与工作区内文件照旧。
- **`omi` 找不到正在运行的应用（从源码 / `build/` 跑的 dev、canary 包）**：CLI 解析数据目录时只看 `/Applications`、`~/Applications` 里的安装包，其余一律回落到 `dev` —— 于是用 `build/canary-…/OmniStudio-canary.app` 跑应用时，`omi status` 说"应用未运行"、`omi logs` 读的是另一个 channel 的空日志（文档承诺的"自动探测最近用过的 channel"其实没实现）。现在命令先**真的 ping 每个候选 channel 的控制通道**，连得上的那个就是当前实例（残留 socket 骗不过 ping）；没有实例在跑时才按"最近用过 / 安装包 / dev"回退，`omi models`、`omi launch`、`omi backup` 这些读库兜底的命令也跟着指向正确的数据目录。
- **另几处同类路径问题**：`discardChatImage` 遇到带前导斜杠的引用会静默失败、被丢弃的聊天附件一直留在磁盘上（现在先剥前导斜杠，与另存为 / 保存音频一致）；媒体服务的非法百分号编码过去会在 handler 里抛 `URIError` 变成 500（现在 400）；`/artifact/7//a.css` 这种多一个斜杠的地址会被误判越界（现在丢掉空段，与 `/workspace` 一致）。
- **测试：媒体路由不再因「本机开着应用」而整段跳过**：19782 被本机实例占着时，路由冒烟测试会自己跳过——而媒体 403 恰恰是从这种"本地从没跑到"的路由漏出去的。现在测试进程用专用端口（`NODE_ENV=test` 下的 `OMNI_IMAGE_SERVER_PORT`，**仅测试生效**：webview 读不到主进程 env，正式运行必须所有进程共用同一常量），并新增端口争用用例（另一个数据目录 / 认不出身份 / 对方退出后自动接管 / 同一份数据目录共用）与技能 id、参考图授权的用例。另外 `chat.test.ts` 不再把整个 `./image-server` 换成假实现：`mock.module` 会跨文件泄漏且 `mock.restore()` 撤不掉，被换掉的模块让别的文件只能无声跳过（正是上面那条路由测试被跳过的原因）；它后半段本来就用 `...真实模块` 展开，说明作者也知道手写桩会随实现变味。

## [0.0.8-canary.0] - 2026-09-13

### Added / 新增

- **大模型基准测试（独立应用，重做）**：从设置页标签升级为图标栏「基准测试」应用——左侧参数面板（模型快选 / 生成长度 / 并发请求数 / 上下文档位 1k–32k 扫描）+ 右侧结果区，侧栏沉淀**历史测试记录**（模型 · 平均 TPS · 时间，点击回放、可单删 / 清空）；测试改为**异步任务 + 轮询**模式（实时进度、可随时停止，取消时已完成档位仍入历史）；指标从 3 项扩到 9 项——TTFT / TPOT / 单流 TPS / 并发聚合吞吐 / Prefill 吞吐 / 精确输入输出 tokens（`stream_options.include_usage` + 预热请求，回退 chunk 计数）/ 成功失败数 / 总耗时，汇总卡展示平均与峰值；结果落库 `benchmark_records`（迁移 `0025_add_benchmark_records`，`kind` 字段为后续 MMLU / GSM8K 等本地能力评测脚本预留）。
- **基准测试 · 能力评测（MMLU / CMMLU / GSM8K / MMLU-Pro）**：基准测试页新增「能力评测」模式——四个主流评测套件：MMLU（英文综合，57 科目 4 选 1，5-shot）、CMMLU（中文综合，67 科目，5-shot 中文指令）、GSM8K（数学推理，5-shot CoT + `####` 数字答案）、MMLU-Pro（14 科目 10 选 1，0-shot，2048 tokens 预算），题面构造与判分遵循各数据集官方评测协议；题库 JSONL（HuggingFace 公开数据集打包）首次使用时自动下载缓存到 `userData/eval-data`（双镜像源、字节数校验），之后离线可用；抽样按固定种子做类别配额（同题数结果可对比，0 = 全量），并发跑题 worker 池 + 实时正确率进度 + 可取消；结果区展示综合准确率大卡、答对 / 已答 / 失败数 / 耗时、**分科目得分条形列表**（≥60% 绿 / ≥30% 主色 / 其余红）；评测记录入同一历史库（`kind='eval'`，侧栏显示套件名 + 准确率），与速度记录并列回放；`<think>` 推理段自动剥离、中文「答案：X」提取兼容。
- **能力评测 · 垂类套件（编程 / 写作 / 长上下文）**：新增四个垂类评测——**HumanEval 代码补全**（164 题，函数签名 + docstring 补全，提取生成代码后在本机 python3 沙箱执行单元测试判 pass@1，15 秒超时、临时文件即删、无 python3 时任务级报错）、**MBPP 编程实现**（500 题，自然语言题面 + assert 用例，同款沙箱执行判分）、**IFEval 指令写作**（540 题官方题库，25 种可编程校验指令——字数 / 句数 / 段落 / 禁词 / 词频 / 字母频次 / 大小写 / 引号包裹 / markdown 高亮 / bullet / JSON 整体 / 多段 Section / 占位符 / P.S. / 结尾短语 / 双响应 / 重复题面 / 约束选项 / 响应语言等，strict 口径全部指令通过才算对，HF 官方 + hf-mirror 双源下载）、**长文多针检索**（本地合成约 8k tokens 噪声长文埋 5 支「魔数」针，答案子串精确判分，**按针深度 ≤30% / 31–60% / ≥61% 分档统计**，直指 lost-in-the-middle 现象，无需下载题库）；套件列表数据驱动渲染，垂类附加说明随选中套件展示。
- **基准测试 · 云端直连测速 + CLI**：测试目标支持「云端 API」——直接选择 `cloud_providers` 里的任一服务商按 id 直连（无需全局激活），模型列表联动填充；云 API 参数自适应（首 400 按错误文案降级 `max_tokens`→`max_completion_tokens`、去 `stream_options`，结果按 base 缓存）；新增 `omi benchmark` CLI——终端跑测速并与应用内共用同一任务单例与历史表（应用运行走控制 socket 实时显示进度，未运行时进程内直连 SQLite 兜底）。
- **Agent 权限与授权（对齐 OpenWork / Claude Cowork）**：工具调用先被翻译成一条 `(permission, pattern)` 请求（`bash` → 命令、`write_file` → 路径、工作区外读取 → `external_directory`），规则表按「后匹配覆盖先匹配」求值、无匹配回落到该权限的内置默认动作；动作 `allow / ask / deny` 中 `ask` 会挂起工具执行，把请求推给**消息流里的确认卡片**（仅本次 / 本会话总是 / 始终允许写进工作区规则 / 拒绝），「始终允许」落 `agent_permissions` 表（session / workspace 两级作用域，重放不越权）。审批模式 `AGENT_APPROVAL_MODE` 四档（`smart` 默认 / `manual` / `auto` / `strict`），另有 `doom_loop` 检测——同一动作反复被拒时收尾，不再空转。设置页新增「Agent 权限」面板：生效规则、命中来源（builtin / settings / workspace / session）、例外规则计数与授权目录管理。
- **Agent 会话交互（消息流内，不弹窗）**：`ask_user` 提问卡片支持单选 / 多选 / 自定义答案；授权与提问的「请求 + 结果」各落一条 `agent_events`，回看历史能看到当时问了什么、选了什么，与工具调用在时间线里对齐。待办清单 `todo_write` 全量覆盖 + 输入框上方的进度面板（`agent_todos`）。子智能体 `task` 起独立上下文的 Agent 循环（事件带 `subagentId`），轨迹里折成一行、点开可见过程。上下文压缩在请求前做确定性裁剪（保留任务陈述 + 最近消息，中间用一条说明占位），丢掉的量在轨迹里明说——本地模型 8k 上下文下长任务能继续跑下去。
- **Agent 产出物与工作区面板（右侧多页签）**：产出物登记 `agent_artifacts`，工具写出的文件与生成的图片 / 语音 / 视频各落一条，面板列出并预览（markdown / 代码 / 图片 / PDF / 表格）；页签为产出物 / 审查 / 文件 / 终端 / 浏览器 + 产物预览，左边界分隔条可拖宽，HTML 产物与工作区文件经 image-server 新增的 `/artifact/<id>`、`/workspace/<rootId>/<路径>` 在 iframe 里当网页加载。「审查」页签在工作区是 git 仓库时给出改动清单（`git status` + `--numstat`）与单文件 unified diff，只用 argv 调 git、路径经 safeJoin 限制在工作区内。
- **Agent 终端页签（真实 PTY）**：Bun 伪终端起一个真实 shell，键盘输入写进 PTY，输出按帧批量推给前端 xterm.js——`top` / `vi` / 交互式 npm 提示都能正常跑；一个会话一个 shell，面板切走再切回是同一个（含回放缓冲），只有显式关闭或应用退出才杀进程。
- **会话侧栏**：新建 / 搜索 / 置顶 / 归档 / 重命名 / 工作区分组（`conversations.workspace`、`archived_at`），另有排队消息面板与分支会话；四个入口（搜索 / 自动化 / 插件 / Skills）都在 Agent 主区域内打开，不占一级菜单。
- **自动化任务**：`once` / `daily` / `weekly` 计划（纯函数计算，支持 IANA 时区与 DST）在指定工作区自动跑一次 Agent，结果落成一条会话可回看完整轨迹；30 秒巡检查询调度，不引入 job 队列。
- **通知中心**：会话跑完、Agent 需要授权、自动化成功 / 失败在标题栏铃铛里提醒，点击跳回对应会话（内存态，重启不保留）。
- **Agent 界面重做**：工具轨迹收成一行（点开看命令、diff、输出）、正文不再套气泡、思考可展开，正文与思考按 40ms 批量流式下发。
- **迁移 0026**：新增 `agent_artifacts` / `agent_permissions` / `agent_todos` / `automations` 与 `conversations` 的 `workspace` / `archived_at` 列（`benchmark_records` 已由 0025 手写迁移建过，0026 里去掉 drizzle-kit 的重复生成，避免老库升级建表失败）。
- **Agent 能力冒烟**：`scripts/agent-capabilities-smoke.ts` 与 `scripts/agent-live-check.ts`（工具面、授权与提问落事件、上下文压缩触发）接入 `test:smoke`。

### Changed / 变更

- **Agent 生图的后端来源**：`generate_image` 与它的配置弹窗过去只认「图像」页保存的那份配置，用户在设置 →「云端模型」里配好的服务商与模型完全看不见——表现就是「已经配过了还被要求再填一遍地址」。现在已配置服务商（地址与 Key 齐全）里分类为生图的模型会作为候选：恰好一个直接采用、不弹窗，多个弹窗让用户挑，一个都没有才轮到手填；候选自带服务商地址与 Key，选中即切到「云端生图」并按这份配置落盘（选自建服务那一行就不会串到别家）。弹窗顶部的后端状态点也把「云端模型里有生图模型」算作就绪。
- **MLX 引擎的就绪判定**：`mlx_lm.server` 的模型加载在后台线程里，架构不认识时线程直接退出而 HTTP 服务照常起来（`/v1/models` 返回 200），过去会被当成「运行中」——界面写着运行中、每次对话却没有返回。现在启动阶段识别 `Exception in thread` 即收尾进程并给出原因。
- **测试**：`media-setup` 的云服务商用例改用内存 fake——bun 的 `mock.module` 会跨文件泄漏，别的测试文件把 `./db` 换成自己的临时库并在收尾删除后，真实表读写会直接 `SQLITE_IOERR_VNODE`（整个套件一起跑才暴露，单跑本文件正常）；新增 `runtimes/errors.test.ts`。

### Fixed / 修复

- **Agent 生图不再要求重复配置**：在「云端模型」里配好生图模型后，Agent 不再弹窗索要接口地址；只有一个候选时连弹窗都没有。
- **MLX 不再假报「运行中」**：模型架构不支持（如 `model_type = deepseek_v41`，mlx-lm 至今没有对应实现）时，启动直接失败并说明「模型加载线程已退出、服务起来了也不会出图」，而不是挂着一个假的运行状态等用户一次次重发消息。
- **Agent 右侧面板「+」菜单被裁成一条图标列**：菜单左对齐展开时右边 148px 与全部文字标签被面板的 `overflow-hidden` 裁掉，看起来像一条莫名的竖排图标栏；改为右对齐向左展开。

## [0.0.7-canary.0] - 2026-09-12

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
- **设置 · 命令行手册页**：设置 → 工具 → 命令行，把 `omi` 的完整用法搬进应用——安装启用、启动应用与推理服务器、模型加载与切换、共享记忆（CLI / stdio MCP / HTTP MCP / REST）、编码工具（code）加载、引擎依赖与版本检查，每条命令与记忆接入片段都可一键复制（MCP / REST 片段里的网关地址取自当前设置）；内容与 `omi guide`、`docs/omi-cli.md` 同源（`src/shared/cli-docs.ts`），中英双语跟随界面语言。
- **架构文档**：新增 `docs/architecture.md` —— 面向维护者的结构说明：进程模型与五类进程边界、主进程各层（RPC / 推理运行时 / 模型库 / 智能层 / 媒体管线）、对外接口面（网关 / 图片服务 / 控制 socket 及端口与鉴权）、前端与 CLI 架构、数据层与目录布局、四条端到端数据流、不变量清单与已知架构债。

### Changed / 变更

- **网关文档**：OpenAPI 补充 `/v1/memories`、`/v1/media` 端点与 `/mcp` 工具说明（总述改为「对话协议 + TTS / ASR + 共享记忆 + 本地素材库」）；`/v1/models` 聚合不变。
- **模型下载**：下载面板每个任务都显示来源平台徽标（此前无法分辨字节从哪个站拉取）；下载完成后把分类与来源平台写入仓库目录的 `.vllm-meta.json`，本地模型列表据此显示「从哪儿下的」（没有记录的老数据不显示来源）。
- **首次本地模型安装向导**：列文件与下载统一走 ModelScope（此前列文件走 ModelScope、下载却写死 hf-mirror 镜像，两边文件名不一致时会出现「列表里有、下载 404」），向导中明确标注「文件与下载均来自 ModelScope（modelscope.cn）」。
- **模型分类识别**：同时识别 ModelScope 的 `task:*` 标签与 Hugging Face 直接放进 tags 的 pipeline tag（含 VLM `image-text-to-text` 归为对话），命名启发式补齐 deepseek / glm / mistral，减少落入「其它」；市场与详情页的格式徽标改为按平台元数据展示。
- **`omi` 帮助体系与手册**：新增 `omi guide`（纯文本 / `--md` / `--json` / `--lang en`）打印完整手册（安装、启动、模型加载、记忆调用、编码工具加载），`docs/omi-cli.md` 由同一份数据源生成（`omi guide --md`，`scripts/omi-docs-smoke.ts` 校验命令表、帮助文本与文档三者同步）；`omi help` 支持子命令与工具级帮助（`omi help memory add` / `omi help launch claude` / `omi server help logs`），`omi memory <子命令> -h` 等价；总览补齐此前遗漏的 `memory`、`guide` 与常用示例，`omi launch --list` 与错误提示指向对应帮助。
- **国际化**：中英双语词条补齐模型市场 / 素材来源标注 / Agent 生图配置弹窗 / 本地模型目录管理约 450 行。
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
- **手册漂移无人拦截**：`scripts/omi-docs-smoke.ts` 校验命令表 ↔ 帮助文本 ↔ 数据源 ↔ `docs/omi-cli.md` 四者同步，但它此前既不在 `test:smoke` 列表里、CI 也不会执行，文档漂移事实上不会被发现；现已纳入 `test:smoke`，随 CI 一起跑。
- **在线模型市场 · ModelScope 分页总数读错字段**：检索接口返回的是 `total_count`，此前读 `total` 导致「共 N 条」永远等于当前页条数、加载更多判断错误；现显示真实命中总数并正确分页（Hugging Face 本就没有总数接口，改为如实显示「已加载 N 条」而不是编造总数）。
- **模型详情「已下载」误判**：已安装列表登记的是文件名，而 HF 仓库常见 `BF16/xxx.gguf` 这类子目录路径，此前用完整路径比对导致已下载的文件仍显示成可下载；现统一按 basename 比对。
- **删除本地模型静默失败**：此前删除吞掉错误、只能删单个文件且无越界校验，用户看不到任何反馈；现在返回明确错误与原因并在行内展示，目录型条目按整目录删除、HF 缓存整条 `models--org--repo` 删除（否则只删软链一个字节都不释放），非白名单路径一律拒绝并给出说明。
- **复制出的启动命令与实际启动不一致**：仓库目录型模型实际是整目录加载，而复制命令仍按文件名猜引擎并把文件路径交给运行时；现在两条路径共用同一套运行时目标解析，"复制的命令"和"实际启动的"一致。
- **Hugging Face 检索结果里的私有 / 受限仓库**：此前 gated（需登录并接受协议）与 private 仓库也会列出，用户点了下载才撞 401；现在列表阶段直接过滤，且 401/403/404/451 立即抛出明确错误而不是换个域名再等一轮超时。
- **冒烟脚本不可重复运行**：`memory-smoke` / `mcp-smoke` / `omi-docs-smoke` 用固定名字的临时目录且从不清理，第二次运行时 `memory-smoke` 的计数断言（列表 2 条 / 检索命中 / 删除后剩 2 条）会读到上一轮残留数据而失败，"重跑一遍 test:smoke 就红"；现统一改为 `mkdtempSync` 建一次性目录并在结束时清理（与 `kb-*` / `video-gen` 冒烟脚本一致），调用方显式传 `OMNI_DATA_DIR` 时仍保留现场。

### Internal / 内部

- 新增迁移：`0021_tense_dragon_man`（补 `messages` / `agent_events` / `knowledge_*` 的会话与外键索引）、`0022_memory_lifecycle`（`memory_events` / `memory_metrics` 与记忆状态 / 指纹 / 作用域索引）、`0023_kb_governance`（`kb_events` / `kb_ingest_jobs` 与文档来源路径索引）、`0024_media_source`（`image_records` / `video_records` / `voice_records` 增加 `source` 列区分手工与 Agent 生成）。
- 新增主进程模块：`backup/`（5 个文件：归档内核 / tar / 加密 / 远端存储 / 作用域归置，刻意不依赖数据层与 electrobun）、`media-tools.ts`（Agent 侧素材检索与生成工具，兼素材库内核）、`media-api.ts`（网关对外只读素材接口）、`media-setup.ts`（Agent 生成前的「需要用户介入」通道）、`model-scan.ts`（本地模型目录扫描）、`huggingface.ts`（市场检索的 HF / hf-mirror 数据源）。
- 新增前端：`main-layout/backup-tab.tsx`、`components/media-setup-dialog.tsx`、`components/{media-,}source-badge.tsx` 与 `stores/{backup,market,media-setup}.ts`。
- 新增脚本：`apps/studio/scripts/backup-smoke.ts`（加密备份往返 / 远端上传下载 / 坏库下的离线可用性）。
- 备份内核新增「归档不可信输入」测试组（`backup/index.test.ts`）：伪造归档改写技能库落地目录、非法 KDF 参数、声明 1 GiB 的条目长度、缺字段清单、重复条目、非备份文件删除、`../` 文件名、空库恢复，各一条回归用例。

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
