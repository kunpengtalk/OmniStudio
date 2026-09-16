# 日志：唯一的排查入口

## 统一日志（先看这个）

**位置**：`<数据目录>/logs/app.log`
macOS 默认 `~/Library/Application Support/omni-studio.kunpengtalk.com/<channel>/logs/app.log`
（channel 是 `dev` / `canary` / `stable` —— 打包应用读 bundle 里的 `version.json` 决定）。

**格式**：JSONL，一行一个事件。

```json
{"seq":412,"ts":1757660000000,"level":"error","source":"image","event":"image.generate.failed",
 "message":"Missing API base URL","detail":{"backend":"api","model":"z-image-turbo","hasApiKey":true,"prompt":"一只猫"},
 "pid":4711}
```

| 字段 | 含义 |
| --- | --- |
| `ts` | 毫秒时间戳（本地时间看：`new Date(ts).toLocaleString()`） |
| `level` | `debug` < `info` < `warn` < `error`；过滤是"该级别及以上" |
| `source` | 子系统，见下表 |
| `event` | 机器可读事件名（点号分隔）。**定位分支用它，比 message 稳** |
| `message` | 人读的一句话（就是界面/通知里那句） |
| `detail` | 结构化上下文：后端、模型、地址、提示词片段、`error.stack` 等 |
| `pid` | 主进程 pid |

**轮转**：单文件 2MB，超出改名为 `app-<ISO 时间戳>.log`，保留最近 5 份。
读的时候按文件名排序就是时间顺序（旧的在前，`app.log` 最新）。

**脱敏**：字段名命中 `api_key / apikey / token / secret / password / authorization / cookie`
（不区分大小写）时值被替换成 `***`；空值保持空值。字符串截断到 2000 字符，
单条 `detail` 总量上限约 4000 字符（超了退化成 `{_truncated, preview}`），
所以日志不会把整个请求体写进去。

## 怎么读

```bash
omi logs                              # 最近 50 条（应用没运行也能读文件）
omi logs --level error --limit 50     # 只看 error 及以上
omi logs --source image --verbose            # 单个子系统 + 完整 detail
omi logs --search "429"               # 事件名 / 消息 / detail 里含该文本
omi logs --event generate.failed      # 事件名子串
omi logs -f --source agent            # 跟踪（让用户复现）
omi logs --json | jq '.[] | select(.level=="error")'
omi logs --path                       # 只打印文件路径
omi logs --clear                      # 清空（保留轮转历史）
```

编程式读取：RPC `getAppLogs({level,source,event,search,since,limit,oldestFirst})`
→ `{ entries, path }`；`getAppLogInfo()` → `{dir,path,memoryEntries,files}`；
控制 socket `logs` / `logsPath` / `logsClear` 同构。
应用在跑时优先读内存环形缓冲（最近 2000 条，含尚未刷盘的部分），
不够 limit 再补磁盘上更早的记录，所以**跨重启也能连着看**。

## source 一览

| source | 记什么 | 典型 event |
| --- | --- | --- |
| `app` | 主进程生命周期、数据库迁移、控制通道 | `app.start` `app.ready` `app.uncaught_exception` `app.unhandled_rejection` `db.migrate.failed` `control.start.failed` |
| `client` | webview 上报（渲染错误、未捕获异常、通话前端调试） | `client.render_error` `client.window_error` `client.unhandled_rejection` `voicecall` |
| `agent` | Agent 回合收尾、工具失败 | `agent.turn.error` `agent.turn.empty` `agent.tool.failed` |
| `image` | 生图 | `image.generate.failed` |
| `video` | 生视频 | `video.submit.failed` `video.poll.failed`（含鉴权被拒 / 地址填错这类不再重试的失败）`video.poll.http`(warn→error：可重试的查询失败，同一条记录按分钟节流) `video.poll.timeout` |
| `tts` / `asr` | 语音合成 / 识别 | `tts.run.failed` `tts.local.failed` `asr.run.failed` `asr.transcribe.failed` `voicecall`(debug) |
| `ocr` | OCR 三种引擎 | `ocr.run.failed`(tesseract) `ocr.vlm.failed` `ocr.ppocr.failed` |
| `server` | 推理服务器 | `server.start.failed` `served_model.start.failed` `served_model.start.threw` `served_model.crashed` |
| `gateway` | OpenAI 兼容网关 | `gateway.start.failed` |
| `benchmark` | 基准测试（速度扫描 / 能力评测；长跑的失败也要有现场） | `benchmark.run.started` `benchmark.run.finished` `benchmark.run.failed` `benchmark.bucket.failed`(warn) |
| `download` | 模型下载 | `download.failed` `download.invalid_path` |
| `media-server` / `notice` | 媒体服务状态 / 通知中心落下的条目 | `notification.error` `notification.permission` `notification.run_finished` |
| `memory` `kb` `backup` `skills` `mcp` `automation` `update` `translate` | 对应子系统的维护与失败 | `memory.maintenance.failed` `kb.maintenance.failed` … |
| `console`（事件名） | 主进程 `console.warn` / `console.error` 的兜底镜像（source 仍为 `app`） | `console.warn` `console.error` |

> `console.warn` / `console.error` 是**兜底镜像**：打包应用看不见主进程 stdout，所以
> warn / error 也进日志。若同一处失败同时有结构化事件（如 `server.start.failed`），
> 以结构化那条为准 —— 它有稳定的事件名与 `detail`，镜像条目只有原始参数。

## 各子系统的日志能力差异（读之前先知道）

- **推理服务器的 stdout/stderr 不进 app.log**（逐行刷盘不值得）。它们在各实例的内存缓冲里，
  每个上限 20 万字符，**停止即丢**。读法：`omi server logs`（活动模型，最后 200 行）、
  RPC `getServerStatus().logs`、`getServedModelLogs({id})`，控制 socket `serverLogs`。
  `app.log` 里只有"启动失败 / 崩了"这类事件与 `getLastError()` 提取出的错误行。
- **文档逐页 OCR 的错误**在数据库 `pages.error`，`documents.error` 常为空。
- **语音失败**（TTS/ASR）目前只有日志与抛错，`voice_records` 里通常不会留下失败行 ——
  判断"有没有产出"看 `audio_path` 是否为空。
- **LLM 请求失败**（模型 4xx/5xx、超时）表现为 Agent 回合的 `agent.turn.error`，
  或聊天里一条 `stopReason=error` 的空助手消息（见 `agent-outcome.ts` 的说明）。

## 遗留的日志位置（旧版本写过，新版本可能为空）

排查老机器的历史问题时仍可能用上：

| 路径 | 内容 | 现状 |
| --- | --- | --- |
| `<数据目录>/logs/db-migrate-error.log` | 数据库迁移失败（纯文本，给"应用起不来"用） | 仍在写，与 `db.migrate.failed` 双写 |
| `/tmp/omni-voicecall.log` | 通话 TTS / 前端调试 | **已迁入统一日志**（source `tts`/`client`，event `voicecall`，level debug） |
| `~/.agents/skills/.omnistudio/backup.log` | 技能库自动备份 | 仍在写（技能子系统自己的日志） |
| `~/Library/Logs/omni-studio.kunpengtalk.com/<channel>/` | Electrobun 的 `Utils.paths.userLogs` | 应用**从不写**这里（别去翻，会扑空） |

## 数据库里的"事件日志"（不是日志，但有审计价值）

- `agent_events`：`kind` 为 `error` 的行 = Agent 运行中的错误事件（含工具名与输出）。
- `image_records` / `video_records` / `voice_records` / `documents` / `pages` /
  `benchmark_records` / `automation_runs`：状态 + `error` 列，失败记录在此落库。
- `kb_events` / `memory_events` / `skill_audit_log`：知识库 / 记忆 / 技能的操作流水。
- `settings.MODEL_DOWNLOADS`：下载任务的持久化状态（JSON）——"下载卡住"看这里。
