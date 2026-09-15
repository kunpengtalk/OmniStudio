---
name: omni-doctor
description: 诊断 OmniStudio 桌面应用（本仓库）在运行时出的问题 —— 生图 / 生视频 / 语音合成 / 语音识别 / OCR / 翻译失败、推理服务器起不来或中途挂掉、模型 / 引擎下载卡住、Agent 不干活或答非所问、聊天无响应、图片音频预览 404、网关不通、数据库迁移失败、应用闪退。当用户说「XX 功能不好使 / 报错了 / 没反应 / 帮我看看什么问题 / 排查一下 / 诊断 / 定位 bug」，或贴出一段应用里的报错、空白气泡、失败截图时使用。Diagnose any OmniStudio runtime failure from real evidence (logs, DB rows, control socket, CLI) and tell the user how to fix it — or that it needs a code fix / upgrade.
---

# OmniStudio 排障

目标：**用证据定位到具体原因，再给出可执行的修复动作**。

这个技能存在的理由：没有它的时候，"为什么生图失败"很容易被答成一段对着工作区文件猜的分析
（"工作区里没有生图模型配置，所以模型无法生图"）—— 看着有道理，但和真实原因毫无关系，
用户照着做也修不好。**这个应用有日志、有控制通道、有数据库，先去读，再下结论。**

## 铁律

1. **没有证据不下结论。** 每个结论后面必须能指到一行日志、一条数据库记录或一条命令输出。
   读不到证据就说"需要先加日志 / 需要复现"，不要用推理填空。
2. **不要猜用户的工作区。** 应用的功能（生图、推理、语音…）配置在**应用设置和数据库**里，
   不在用户当前的工作区文件里。用户提了一句"帮我调生图"，工作区里没有生图配置文件是正常的，
   那不是失败原因。
3. **区分三类原因，修复路径完全不同**：
   - **配置/环境问题** → 用户自己能在界面上修（`reference/playbooks.md` 里有逐条对应）；
   - **代码缺陷** → 需要改代码 / 升级版本（`reference/escalation.md`）；
   - **数据损坏 / 磁盘 / 网络** → 有专门的处理步骤。
4. **默认只读。** 排查不改用户数据。确需写操作（清日志、重启服务）时先说清楚再执行。
5. **日志里可能有本地路径与提示词** —— 提醒用户别把整份报告贴到公开渠道；密钥已被自动脱敏成 `***`。

## 第一步：拿到现场（一条命令）

```bash
bun run --cwd apps/studio scripts/omni-diag.ts            # 人类可读报告
bun run --cwd apps/studio scripts/omni-diag.ts --json      # 给脚本/Agent 用
bun run --cwd apps/studio scripts/omni-diag.ts --logs 80   # 多带点日志
```

只读，应用没运行也能跑（起不来 / 闪退的场景才是它最重要的用途）。它一次性给出：

- 版本 / 渠道 / 数据目录 / 数据库 / 磁盘剩余；
- 应用是否在运行，推理服务器与网关状态、最后错误、服务器日志尾部；
- **统一日志 `logs/app.log` 里最近的 warn / error**（按子系统归类）；
- 媒体服务端口占用者身份（本实例 / 另一个数据目录的实例）；
- 数据库里最近失败的记录：生图 / 生视频 / 语音 / 文档 / 基准 / 自动化 / Agent 事件；
- 关键配置是否就位（密钥只报"有没有"）。

## 第二步：按用户描述的症状定位

| 用户说 | 先看 | 细读 |
| --- | --- | --- |
| 生图失败 / 出不来图 | `omi logs --source image --verbose`；`image_records` 最近 failed | [playbooks.md#生图](reference/playbooks.md) |
| 生视频没结果 / 一直"生成中" | `omi logs --source video --verbose`；`video_records` | [playbooks.md#生视频](reference/playbooks.md) |
| 语音没声音 / 转写是空的 | `omi logs --source tts,asr --verbose`；`voice_records` | [playbooks.md#语音](reference/playbooks.md) |
| OCR 识别不出来 / 文档解析失败 | `omi logs --source ocr --verbose`；`documents` + `pages.error` | [playbooks.md#ocr](reference/playbooks.md) |
| 推理服务器起不来 / 自己挂了 | `omi status`、`omi server logs`、`served_model.crashed` | [playbooks.md#推理服务器](reference/playbooks.md) |
| 模型下载卡住 / 失败 | `omi logs --source download`、`settings.MODEL_DOWNLOADS`、磁盘剩余 | [playbooks.md#模型下载](reference/playbooks.md) |
| 引擎 / 语言包一直"正在下载" | `omi logs --event engine.download --verbose`、`DATA_DIR/engines` | [playbooks.md#推理引擎--语言包下载](reference/playbooks.md) |
| Agent 不干活 / 空白气泡 / 答非所问 | `omi logs --source agent`、`agent_events`、`agent.turn.empty` | [playbooks.md#agent](reference/playbooks.md) |
| 图片 / 音频预览加载不出来 | 报告里的"媒体服务"一节、`omi logs --source media-server` | [playbooks.md#媒体预览](reference/playbooks.md) |
| 界面白屏 / 报错页 | `omi logs --source client` | [playbooks.md#界面](reference/playbooks.md) |
| 应用起不来 / 闪退 | `omi logs`（应用没跑也能读文件）、`logs/db-migrate-error.log` | [playbooks.md#启动](reference/playbooks.md) |

## 第三步：读日志的正确姿势

```bash
omi logs --level error --limit 50 -v        # 只看错误，带完整上下文
omi logs --source image --verbose                  # 单个子系统
omi logs --search "IncompleteSnapshot"      # 按关键字找（报错原文）
omi logs -f --source agent                  # 跟踪（让用户复现，实时看）
omi logs --path                             # 日志文件路径
```

日志是一条条 JSONL，一行一个事件，字段是
`{ ts, level, source, event, message, detail, pid }`。
`event` 是机器可读的事件名（如 `image.generate.failed`），**它比 message 更稳定**，
用它来定位分支；`detail` 里通常有后端类型、模型名、地址、提示词片段等。
完整字段说明、各 source 的含义、旧版遗留的日志位置 → [reference/logs.md](reference/logs.md)

应用没在运行时 `omi logs` 直接读磁盘上的文件 —— 闪退场景一样能用。

## 第四步：给用户修复方案

- **配置类**：直接给出「设置 → 哪个页面 → 填什么」的具体路径。`playbooks.md` 里每条原因都配了
  界面位置（例如生图后端与模型在「图像」页，本地 MLX 还要先下引擎和权重）。
- **环境类**：给出可复制的命令（`brew install whisper-cpp`、装 Python 3.10+ 等）。
- **数据/网络类**：给出重试与清理路径（重下模型、清 `mlx-downloads/<id>.json` 状态等）。
- **代码缺陷**：按 [reference/escalation.md](reference/escalation.md) 写工单，并告诉用户
  "这个需要升级程序才能解决" —— 不要让他反复重试。

## 第五步：验证

修完必须复验，不能只说"应该好了"：

- 重跑一次用户的那个操作，或
- 跑对应的只读检查（如 `omi server logs` 看到 `server is listening`、`omi diag` 里该子系统不再有 error），
- 再 `omi logs --level error --limit 10` 确认没有新错误。

## 相关文件（改代码时需要）

排障经常落到"这是代码 bug"，此时要能直接读实现的**失败路径**，而不是通读整个仓库：

| 子系统 | 实现文件 |
| --- | --- |
| 统一日志（读写、脱敏、轮转） | `apps/studio/src/bun/app-log.ts` |
| 生图 | `apps/studio/src/bun/image-gen.ts`、`mlx-gen.ts`、`media-setup.ts` |
| 生视频 | `apps/studio/src/bun/video-gen.ts` |
| 语音 | `apps/studio/src/bun/tts-local.ts`、`edge-tts.ts`、`asr.ts`、`asr-audiocpp.ts`、`voice.ts` |
| OCR / 文档 | `apps/studio/src/bun/ocr.ts`、`ppocr.ts`、`queue.ts` |
| 推理服务器 | `apps/studio/src/bun/model-servers.ts`、`server-manager.ts`、`runtimes/` |
| 下载 | `apps/studio/src/bun/download-manager.ts`、`downloader.ts` |
| Agent | `apps/studio/src/bun/agent.ts`、`agent-tools.ts`、`agent-outcome.ts`、`media-tools.ts` |
| 媒体预览服务 | `apps/studio/src/bun/image-server.ts` |
| 控制通道 / 接口总览 | [reference/surfaces.md](reference/surfaces.md) |

## 目录与接口速查

- 数据目录：`~/Library/Application Support/omni-studio.kunpengtalk.com/<channel>`（dev / canary / stable）
  —— 库 `omni-studio.db`、日志 `logs/app.log`、模型 `models/`、引擎 `engines/`、
  媒体 `images/` `uploads/`、控制 socket `omni-control.sock`。
- 读接口：`omi` CLI（`status` / `logs` / `server logs` / `models` / `memory` / `backup inspect`）、
  控制 socket（HTTP over unix socket，`{cmd,payload}`）、媒体服务 `127.0.0.1:19782`、
  直接只读打开 SQLite。
- 完整清单（含每个命令、socket 命令、RPC 方法组、数据库表）→ [reference/surfaces.md](reference/surfaces.md)

## 参考文件

- [reference/logs.md](reference/logs.md) —— 统一日志格式、各 source / event、遗留日志位置
- [reference/surfaces.md](reference/surfaces.md) —— CLI / 控制 socket / RPC / 媒体服务 / 数据库全清单
- [reference/playbooks.md](reference/playbooks.md) —— 按症状编排：错误原文 → 原因 → 修复
- [reference/escalation.md](reference/escalation.md) —— 确认是代码缺陷时：工单模板与话术
