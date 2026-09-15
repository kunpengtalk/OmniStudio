# 故障手册：错误原文 → 原因 → 修复

用法：先在 `app.log` / 数据库里**找到原文**（下面每条的"证据"行告诉你该在哪找），
再按"修复"给出可执行动作。找不到原文 → 回到 SKILL.md 的第一步重新采集，不要猜。

判断规则：
- 报错是"**请先配置 / 请先下载 / 请先启动**"这类祈使句 → 配置或环境问题，用户自己能修。
- 报错来自上游服务（4xx/5xx/超时/SSL）→ 网络或第三方问题，先给复验方法。
- 报错是**内部异常 / 类型错误 / 空指针 / 逻辑矛盾**，或配置都对仍失败 → 代码缺陷，
  见 [escalation.md](escalation.md)。

---

## 云端模型（所有功能页共用的配置模型）

生图 / 语音 / OCR / 视频**都不在页面里填地址与密钥**，页面只存「厂商 id + 模型」；
连接信息统一在 `cloud_providers` 表（设置 →「模型云服务」）。排查三件事：

1. 厂商**启动**了吗（`enabled=1`）？只有启动过的厂商才会出现在功能页的选择器里，
   启动时会拿 `/v1/models` 校验密钥（401/403 = 密钥无效，事件 `cloud-provider-enable-failed`）。
2. 厂商有**这个用途的模型**吗？每个模型条目带用途（生图 / TTS / ASR / 视频 / 对话），
   没写就按模型名自动识别；识别不出来（`other`）的模型不会出现在功能页里。
3. 功能页选的是哪个厂商？`IMG_PROVIDER_ID` / `TTS_PROVIDER_ID` / `ASR_PROVIDER_ID` /
   `OCR_PROVIDER_ID` / `VIDEO_PROVIDER_ID`（`omi logs` 只能看到结果，配置看
   `bun scripts/omni-diag.ts` 的「云服务商」段）。

一把梭：`bun run --cwd apps/studio scripts/omni-diag.ts` 会列出每个厂商的
「已启动 / 有密钥 / 视频接口 / 模型数」与各功能页选中的厂商 id。

---

## 生图（source `image`，记录表 `image_records`）

证据：`omi logs --source image --verbose`；`image_records` 里 `status='failed'` 的 `error` 列。

| 原文 | 原因 | 修复 |
| --- | --- | --- |
| `请先输入提示词` | 调用侧没给 prompt | 让用户描述想生成的画面；若来自 Agent 工具，是 Agent 没传参 → 让它补 |
| `还没选定云厂商…` / `请先在「设置 → 模型云服务」里启用一个厂商` | 生图后端是云端但没选（或没有可用）厂商 | 设置 →「模型云服务」填 Key 后点「启动」（会校验密钥），回「图像」页选厂商与生图模型 |
| `请先填写生图模型 ID` | 厂商选了、模型 ID 空 | 在「图像」页选该厂商的生图模型 |
| `请先在左侧配置 ComfyUI 服务地址（如 http://127.0.0.1:8188）` / `Missing ComfyUI base URL` | 后端 `comfyui` 但没地址 | 「图像」→ 填 ComfyUI 地址，并确认 ComfyUI 已启动 |
| `请先填写 ComfyUI checkpoint 名称` | ComfyUI 里没选 checkpoint | 在 ComfyUI 下载模型后，在应用里选 checkpoint |
| `参考图修图仅支持 OpenAI 兼容的云端后端（api）` | 用 MLX/ComfyUI 做图生图 | 切后端到 `api` |
| `参考图文件不存在` | 参考图被移动/删除 | 重新选参考图 |
| `服务未返回任何图片` / `服务返回的数据无法解析为图片` | 上游返回体不是预期格式（b64_json / url） | 确认上游是 OpenAI 兼容的 `/v1/images/generations`；用 curl 直接打一次对比返回 |
| `MLX 引擎仅支持 Apple Silicon (arm64) 的 macOS` | 架构不符 | 换 `api` / `comfyui` 后端 |
| `未找到 python3，请先安装 Python 3.10+（brew install python）` | 缺 Python | `brew install python`（或换后端） |
| `MLX 引擎未安装，请先点击「下载引擎」` | mflux 引擎没装 | 「图像」页点「下载引擎」 |
| `模型「X」尚未下载，请先点击「下载模型」（约 N GB）` | 权重缺失 | 同页下载对应模型；网络受限时先解决镜像/代理（见下条） |
| `mflux 生成超时（超过 30 分钟），已终止进程，请重试` | 模型太大 / 显存不足 / 被系统换出 | 换更小的模型（如 Schnell / turbo 档），或减少步数；确认没有其它大模型在跑 |
| `上一次生图仍在进行中，请稍候或等它完成` | 并发保护 | 等上一次结束；若确认已卡死，重启应用 |
| `生图后端是云端模型，但还没选定云厂商…` 等 `media-setup` 文案 | Agent 调 `generate_image` 前的准备检查没过 | 这是**入口拦截**不是故障：按提示在弹窗（列的是已启动厂商的生图模型）或「图像」页选好，再让 Agent 继续 |
| `huggingface_hub.errors.IncompleteSnapshotError ... The Hub could not be reached (ConnectError: [SSL: UNEXPECTED_EOF_WHILE_READING])` | **实测过**：MLX 模型下载被网络中断，权重不完整 | 在能访问 HF 的网络/镜像下重下（应用内 MLX 模型下载走同样的源）；删掉 `DATA_DIR/engines/mflux` 下对应缓存后重试 |

补充：生图失败**一定会**在 `image_records` 留一行 `status='failed'` + `error`，
所以"生图没反应"时先查这张表，再对日志。

---

## 生视频（source `video`，记录表 `video_records`）

证据：`omi logs --source video --verbose`（`video.submit.failed` / `video.poll.failed` / `video.poll.timeout`）。

| 原文 | 原因 | 修复 |
| --- | --- | --- |
| `还没选择云厂商。请到「设置 → 模型云服务」启用一个支持生视频的厂商` | 云端后端没选厂商 | 设置 →「模型云服务」启动一个厂商（生视频接口见下条），回「视频」页选厂商与视频模型 |
| `云厂商「X」没有配置生视频接口（在设置里选 MiniMax / Seedance）` | 厂商没选生视频协议 | 视频 API 各家不通用：在厂商详情里把「生视频接口」设为 MiniMax 或 Seedance |
| `这条任务的厂商已删除，无法继续查询上游状态` | 轮询时记录里的厂商行被删了 | 该任务无法续查，重新提交；轮询按记录里的 providerId 查上游，删厂商前先确认没有在途任务 |
| `请先配置 MiniMax 服务地址` / `请先配置 Seedance（火山方舟）服务地址` / `请先配置 ComfyUI 服务地址（如 http://127.0.0.1:8188）` | 后端地址空（云端看厂商行的地址） | 云端：设置 →「模型云服务」补地址；ComfyUI：「视频」页填地址 |
| `未找到 ComfyUI checkpoint，请先在 ComfyUI 下载 Wan 模型` / `未找到 ComfyUI CLIP（umt5）…` / `未找到 ComfyUI VAE（wan vae）…` | ComfyUI 缺 Wan 系列依赖模型 | 在 ComfyUI 侧下载 Wan 模型，并在应用里选好 ckpt / clip / vae |
| `MiniMax 未返回 task_id，请检查服务配置` / `Seedance 未返回任务 id，请检查 API Key 与模型` | 鉴权或模型名不对 | 核对 key、模型 id、base（Seedance 需方舟的 endpoint 与模型） |
| `首帧图文件不存在，请重新选择` | 首帧图失效 | 重选 |
| `上游任务不存在或已过期` | 上游把任务清了（隔太久才轮询） | 重新提交；避免跨天再回来看 |
| `生成超时（超过 30 分钟），可重试或检查服务状态` | 上游长时间无终态 | 查上游控制台配额/排队；`video.poll.retry`(debug) 里有每次轮询的瞬时错误 |
| 一直"生成中"但没有任何错误 | 轮询在重试（瞬时网络错）或上游排队 | `omi logs --source video --level debug` 看 `video.poll.retry`；超过 30 分钟会自动失败 |

---

## 语音合成（source `tts`）

证据：`omi logs --source tts --verbose`（`tts.run.failed` / `tts.local.failed` / `voicecall`(debug)）；
`voice_records` 里 `kind='tts'` 的 `audio_path` 是否为空（转写/合成失败通常不写失败行）。

| 原文 | 原因 | 修复 |
| --- | --- | --- |
| `没有可用的 TTS 引擎` / `未配置三方 TTS Provider` / `本地引擎未启动` | 一个可用引擎都没有 | 二选一：本地（「本地引擎 → TTS」下载引擎与模型并启动）或用三方厂商（「设置 → 模型云服务」启动厂商并在「语音」页选它的 TTS 模型） |
| `未找到 audiocpp_cli，请先下载 audio.cpp 推理引擎` | 本地引擎二进制缺失 | 「本地引擎 → TTS」点下载引擎；平台不支持自动下载时按提示手动装 `audiocpp_cli` 并加入 PATH |
| `模型尚未下载，请先点击下载` / `模型未下载：X` | 权重缺失 | 下载对应 TTS 模型 |
| `请先在本地引擎中选择一个已启动的 TTS 模型` | 引擎起了但没选模型 | 选模型并启动 |
| `该模型需要参考音频，请先在「声音克隆」页创建一个克隆音色` / `找不到所选克隆音色的参考音频` | 用了克隆音色但参考音频丢了 | 重建克隆音色 |
| `本地合成失败（退出码 N）` | 引擎进程报错 | `omi logs --source tts --verbose` 看上下文；换模型/重建引擎 |
| `Edge TTS 连接失败，请检查网络` / `Edge TTS 合成超时` / `Edge TTS 未收到音频` | 需要公网访问 Edge 服务 | 检查网络与**设置 → 偏好 → 通用**的代理（WebSocket 也走它），或改用本地引擎 |
| `No inference server configured` / `TTS request failed` | 走了推理服务通道但服务没起 | `omi status`；没起就 `omi start --server` |

---

## 语音识别（source `asr`）

证据：`omi logs --source asr --verbose`（`asr.run.failed` / `asr.transcribe.failed`）；`voice_records` 里 `kind='asr'`。

| 原文 | 原因 | 修复 |
| --- | --- | --- |
| `未检测到 whisper.cpp，请先安装（brew install whisper-cpp）或使用 OpenAI 兼容 API` | 缺本地引擎 | `brew install whisper-cpp`，或在「语音 / ASR」切到远端 API |
| `请先下载并选择一个本地 ASR 模型` / `模型未下载：X` | 权重缺失 | 下载 ASR 模型 |
| `没有可用的推理服务（本地引擎或远程服务）` | 两条路都没配好 | 起本地引擎，或在「设置 → 模型云服务」启动厂商后在「语音 / ASR」选它的 ASR 模型 |
| `音频文件不存在` | 输入失效 | 重新选择音频 |
| `转写结果为空` | 音频无声 / 太短 / 采样率异常 | 换一个音频验证是文件问题还是引擎问题 |
| `whisper-cli 转写失败（退出码 N）` | 引擎报错（模型损坏 / 参数） | 看日志上下文；重下模型 |
| `audio.cpp 引擎未启用，请先在 ASR 页切换到 audio.cpp 引擎` / `请先在本地引擎中选择一个 audio.cpp ASR 模型` | 引擎选型不对 | 按提示在 ASR 页切换并选模型 |

---

## OCR / 文档解析（source `ocr`）

证据：`omi logs --source ocr --verbose`；`documents.status='failed'` 且**逐页错误在 `pages.error`**；
三种引擎的错误事件名分别是 `ocr.run.failed`(tesseract) / `ocr.vlm.failed` / `ocr.ppocr.failed`。

| 原文 | 原因 | 修复 |
| --- | --- | --- |
| `未检测到 Tesseract，请先安装（macOS: brew install tesseract）` | 缺二进制 | `brew install tesseract` |
| `语言包尚未下载，请先点击下载` / `语言包未下载：X` | tessdata 缺失 | 「OCR」页下载语言包 |
| `Tesseract 引擎未启用，请先在 OCR 页切换到 Tesseract 引擎` / `请先在本地引擎中选择一个 Tesseract 语言模型` | 引擎/模型没选 | 按提示切换 |
| `请先在 OCR 页配置远程 OpenAI 兼容服务的 Base URL` / `Missing API base URL` | VLM 走远端但没配 | 「设置 → 模型云服务」启动厂商，再在「OCR → VLM」选厂商与模型（VLM 属于对话类模型） |
| `无法解析图片` / `图片文件不存在` | 输入文件问题 | 重选图片；PDF 先确认页图能生成（Sharp 转换是否失败） |
| `识别结果为空` | 图片无文字或引擎不匹配 | 换引擎试（VLM 对复杂版式更强） |
| `PaddleOCR 引擎未安装，请先点击「下载引擎」` / `引擎未安装完整，请重新点击「下载引擎」` | 引擎缺失/半装 | 重装引擎 |
| `worker 未运行，请先启动 PaddleOCR 引擎` | 引擎没起 | 启动 |
| `识别超时（3 分钟），已停止引擎，请重试` | 图片太大/引擎卡住 | 重试；仍超时换 VLM |
| 文档卡在 `processing` | 队列中断（应用退出 / 崩过） | 重启应用会恢复遗留作业（`runKbMaintenance` / 文档队列）；仍不动就 `kb doc retry` / 重新处理该文档 |

---

## 推理服务器（source `server`）

证据：`omi status`、`omi server logs`（最后 200 行）、`server.start.failed` /
`served_model.start.failed` / `served_model.crashed`；RPC `getServerStatus().error`。

| 现象 / 原文 | 原因 | 修复 |
| --- | --- | --- |
| `No free port near <port> (tried 100 ports)` | 端口段被占满 | 关掉不用的已启动模型；或改引擎端口设置 |
| 启动即失败，日志有 `error while loading shared libraries` / `not found` | 引擎二进制缺失或依赖不全 | `omi install` 看检查结果，按提示安装 llama.cpp / vLLM / SGLang / MLX |
| 日志有 `CUDA out of memory` / `failed to allocate` / `Metal` 相关错误 | 显存不足（多个模型同时驻留是常见原因） | 卸载其它已启动模型（控制台可多实例驻留）；换更小量化 |
| `Model not found: <path>` | 模型文件被移动/删除 | 模型页重新扫描目录；或重下 |
| 状态 `error` 且 `error` 为空、日志末尾没有明显错误 | 进程被系统杀掉（OOM / 手动 kill） | 看 `served_model.crashed` 与系统内存；减小上下文/批量 |
| MLX：服务在跑但生成线程死了（`extractDeadWorkerError`） | MLX worker 异常退出 | 重启该模型；仍复现则升级程序（已知缺陷形态） |
| 服务器起来后立刻 `stopped` 且条目消失 | 进程自己退出 | 同上，重点看日志尾部最后 20 行 |

服务器日志**停止即丢**（内存缓冲），所以这类问题要**当场看**；`app.log` 里只有失败事件。
复现命令：控制 socket `launchCommand` 拿到真实启动命令，可手工前台跑一遍看完整输出。

---

## 模型下载（source `download`）

证据：`omi logs --source download`、控制 socket `downloadsList`、`settings.MODEL_DOWNLOADS`、
`DATA_DIR/models` 下的 `.part` 文件、诊断报告里的磁盘剩余。

| 现象 | 原因 | 修复 |
| --- | --- | --- |
| `download.failed` + 磁盘可用为 0 | 磁盘满 | 清理后 `omi` / 界面点「继续」（会从断点续传） |
| 反复重试后失败，错误含 `404` / `not found` | 仓库或文件名变了（镜像同步延迟也常见） | 换下载源（ModelScope ↔ HuggingFace）或换同名仓库 |
| 卡在 0% 或速度长期为 0 | 网络到镜像不通 | 检查**设置 → 偏好 → 通用**的代理模式与地址（下载与云端调用共用这一份设置，回环地址永远直连）；HuggingFace 源优先走 hf-mirror |
| `非法的下载路径：X` | 文件名含 `../` 或绝对路径（安全拦截） | 正常现象，换合法文件名 |
| 任务"消失" | `MODEL_DOWNLOADS` 里的状态被清理 | 重新发起下载（已有 `.part` 会续传） |

---

## 推理引擎 / 语言包下载

引擎二进制与语言包都挂在 GitHub 上（audio.cpp、whisper.cpp、tessdata），走
`bun/mirror-download.ts` 的多链路下载：直连可达性探测 → 加速镜像 → jsDelivr → 直连兜底，
链路之间还会**对冲**（当前这条跑超过 45s 就把下一条也开起来，谁先完成用谁）。
事件名统一是 `engine.download.ok` / `engine.download.source-failed` / `engine.download.all-failed`。

证据：`omi logs --event engine.download --verbose`（不看 --source，三条链路分属 tts / asr / ocr）；
`DATA_DIR/engines/` 下有没有引擎目录、有没有 `.partN` 残留。

| 事件 / 现象 | 原因 | 修复 |
| --- | --- | --- |
| `engine.download.ok` 里 `host` 不是 `github.com` | 直连不通，走了镜像（**正常**，不是故障） | 无需处理；日志里的 `ms` / `bytes` 能看出实际速度 |
| `engine.download.source-failed`，error 含 `连接超时`/`传输停滞` | 那条链路连不上或传一半卡住（每条链路都是短预算，会自动换下一条） | 看后续有没有 `ok`；全失败再处理 |
| `engine.download.all-failed` | 所有链路都不通 | 按 error 里逐条列出的原因判断：全是被墙特征 → 让用户配代理（**设置 → 偏好 → 通用**：模式选「系统代理」，或选「自定义代理」填 http 地址如 `http://127.0.0.1:7890`，填完点「测试代理」确认通）；镜像被限流 → 稍后重试 |
| 点了「下载引擎」按钮一直转 | 历史行为是每源白等 10 分钟（已修）；现在最慢 budget ≈ 连接 8s / 停滞 15s / 单链路传输 180s | 若新版仍长转，用 `engine.download.*` 事件看卡在哪条链路 |
| `当前平台暂不支持自动下载 audio.cpp 引擎` | audio.cpp 只有 macOS(arm64/x64) 与 Linux x64 资产 | 手动装 `audiocpp_cli` 并加入 PATH |
| 下载成功但引擎仍显示「未检测到」 | 引擎按数据目录分开放（dev / canary / 正式版各一份） | 确认界面所在渠道与 `DATA_DIR/engines/<引擎>` 是同一份 |

---

## Agent（source `agent`）

证据：`omi logs --source agent --verbose`；`agent_events`（`kind='error'`、`tool_start/tool_end`）。

| 事件 / 现象 | 原因 | 修复 |
| --- | --- | --- |
| `agent.turn.error` + `detail.model` | 模型请求失败：4xx/5xx、超时、key 无效、服务没起 | 先 `omi status`；本地 → 服务/模型；云端 → 「云端」页 key/endpoint/模型名 |
| `agent.turn.empty`（界面是"模型本轮没有给出正文…"） | 模型没产出也没调工具：能力不足 / 上下文过长 / 步数用尽 | 换更强的模型；精简任务；必要时提高最大步数 |
| `agent.tool.failed` | 具体工具失败（message 里就是工具返回的错误） | 按 message 走对应子系统（媒体类多为"后端未配置"） |
| Agent 停下来不动、界面提示要授权 | 权限待确认（`notification.permission`） | 在对话里点允许，或调「权限」设置/授权目录 |
| `No model configured` | 没选模型 | 选一个本地或云端模型 |
| Agent 反复重试同一个失败操作 | 工具错误信息不明确，模型在试错 | 看 `agent_events` 的 `tool_start/tool_end` 定位它是哪一步卡住；修好底层能力（后端/权限）后让它继续 |
| 子智能体（subagent）相关异常 | `kind='subagent_start'/'subagent_end'` 可还原调用树 | 一般不是根因，往上找第一个 error |

排 Agent 问题的顺序：**先看是不是模型/服务层（turn.error）→ 再看是不是工具层（tool.failed）→
最后才怀疑提示词/模型能力（turn.empty）**。

---

## 媒体预览（图片 / 音频加载不出来）

证据：诊断报告的「媒体服务」一节、`omi logs --source media-server`、通知中心里的告警。

| 状态 | 含义 | 修复 |
| --- | --- | --- |
| `serving` | 本实例在服务 | 若图仍 404，说明文件不在 `DATA_DIR/images` → 找生成它的那条记录（记录里有 `image_path`） |
| `blocked` | **端口被另一个数据目录的实例占用**（dev / canary / 正式版之一在跑） | 关掉另一个实例；本窗口会在几秒内自动接管，无需重启 |
| `down` | 端口上没有服务（应用没运行 / 启动失败） | 看 `control.start.failed` / 启动日志；重启应用 |
| 只有部分图片 404 | 文件被移动或从旧的 CWD 目录迁移失败 | 检查 `DATA_DIR/images` 结构；`omi logs --search media` 找线索 |

---

## 界面（source `client`）

| 事件 | 原因 | 修复 |
| --- | --- | --- |
| `client.render_error`（含 `componentStack`） | 前端渲染异常 → 报错页/白屏 | 记下 componentStack：这是代码缺陷，走工单；先让用户「重新加载」回到可用状态 |
| `client.window_error` / `client.unhandled_rejection` | 前端未捕获错误 | 同上；高频出现说明该页面有 bug |
| `voicecall`(debug) | 通话调试流水（前端推来的） | 排查"通话没声音/字幕不动"用：配合 `omi logs --source tts --level debug` |

---

## 启动 / 闪退（source `app`）

| 现象 | 证据 | 修复 |
| --- | --- | --- |
| 应用起不来，报"数据库迁移失败" | `db.migrate.failed` + `logs/db-migrate-error.log`；迁移前副本在 `DATA_DIR/db-backups/` | 按错误信息处理（多为库损坏/迁移冲突）；必要时用 `db-backups/` 里的副本回滚后重试。**先 `omi backup create` 留一份现场** |
| 控制 socket 不存在 | `omi status` 报"应用未运行" | 应用真的没起来；看 `app.start` 有没有出现、`app.uncaught_exception` 有没有堆栈 |
| 崩过一次，之后某些功能异常 | `app.uncaught_exception` / `app.unhandled_rejection`（含 stack） | 记 PID 前的最后几条日志 = 根因现场；这是缺陷证据，走工单 |
| 更新后行为变化 | `omi version`、`omi update` | 确认渠道（dev/canary/stable）与版本；必要时回退/等修复 |

---

## 先排除"假故障"

这些**不是** bug，别写成工单：

- 用户没配置后端/模型/密钥 → 报错原文就是"请先配置…"。
- 用户的工作区文件里没有某功能的配置 —— 功能配置在应用设置/数据库里，与工作区无关。
- 本地模型还没下载完就发起生成（大量 `尚未下载` 类错误属于此类）。
- 首次使用某引擎需要安装外部依赖（Python、whisper.cpp、tesseract、ComfyUI）。
- `omi logs` 在应用没运行时看不到本次会话的日志（读的是磁盘历史）——这是设计如此。
