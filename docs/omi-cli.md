# omi — OmniStudio 命令行工具

omi 把桌面应用的后端能力（模型库、推理服务器、API 网关、共享记忆、编码工具启动器）封装成一条命令行。它和应用共用同一份 SQLite 与设置：应用在运行时走控制 socket 实时读写，应用没运行时直接读库兜底。

## 安装与启用

把 omi 装进 PATH，并确认它读写的是哪份数据。

```bash
cd apps/studio && bun link
```

在仓库里执行一次，把 omi 注册到全局（~/.bun/bin/omi）。
- 终端里提示找不到命令时：export PATH="$HOME/.bun/bin:$PATH"。
- 卸载：cd apps/studio && bun unlink。
- 仓库里另有早期的 omni 命令（chat / doctor / config 等，见 docs/omni-cli.md）；新能力只进 omi，两者共用同一份库与设置。

`omi --version` — 验证安装与当前版本。
`omi help` — 命令总览；omi help <命令> 看单命令详情。

```bash
OMNI_DATA_DIR=<数据目录> omi models
```

默认自动探测最新使用过的 channel 数据目录（macOS：~/Library/Application Support/omni-studio.kunpengtalk.com/<channel>）。无头 / 多份数据时用 OMNI_DATA_DIR 指定目录，OMNI_DB_PATH 可再单独指定数据库文件。

## 启动应用与推理服务器

唤起桌面应用、拉起 / 停止本地推理服务器，并查看状态。

```bash
omi start
```

启动 OmniStudio（未运行时自动拉起并等待控制通道就绪）。
- 装在非默认位置时加 --app-path /path/to/OmniStudio.app。

`omi start --server` — 启动应用并同时拉起推理服务器，就绪后打印地址与引擎。
`omi start --model` — 启动后直接在应用里打开模型列表。
`omi start --cloud` — 启动后打开设置里的云端配置页。

```bash
omi status
```

查看应用 / 推理服务器 / 网关状态（引擎、PID、端口、模式）。应用没运行时改为探测推理端口。

```bash
omi stop  ·  omi restart
```

停止 / 重启本地推理服务器（需要应用在运行）。当前只有一台本地服务器，引擎由设置决定，传名字会被忽略。

```bash
omi server <list|start|stop|restart|info|logs>
```

推理服务器的细粒度管理：列出可用引擎与当前活动引擎、启动、停止、重启、查看详情、打印日志尾部。

`omi server list` — 可用引擎清单（● 为活动引擎）。
`omi server info` — 引擎 / 状态 / PID / 地址。
`omi server logs` — 最近 200 行服务器日志，排错先看这里。

## 无界面常驻运行（serve）

不打开 GUI，直接复用同一套运行时把推理服务器跑在前台。

```bash
omi serve [--port 8080] [--host 127.0.0.1] [--engine llama.cpp] [--model <路径>] [--api-key <key>]
```

前台长驻：启动成功后命令不会退出，按 Ctrl+C 优雅停止。参数会写回应用设置（端口 / 监听地址 / 引擎 / 活动模型 / 网关 Key）。
- 后台运行用 tmux 包一层：tmux new -s omi -d 'omi serve && read'，之后 tmux kill-session -t omi。
- --model 传绝对路径，会同时设为活动模型；--engine 可选 llama.cpp / vllm / sglang / mlx。

## 模型：列出与加载

查看已装模型、切换活动模型、配置云端模型。

```bash
omi models
```

一次列出本地已装模型（名称 / 大小 / 类型 / 是否活动）与云端模型。

`omi models` — 脚本里取模型名：与 omi model --list 等价。

```bash
omi model
```

不带参数时在应用里打开模型列表下载 / 选择；--list 在终端打印；--select 用终端编号菜单选择并设为活动模型（会重启推理服务器）。

`omi model --list` — 终端里列出已装模型。
`omi model --select` — 终端选择模型并立即生效。

```bash
omi model-info <名称|文件名|slug|路径>
```

模型详情：仓库、文件、服务名、路径、大小、类型、是否活动。

```bash
omi cloud --list  ·  omi cloud --set <provider> <endpoint> [models...]
```

查看 / 写入云端 OpenAI 兼容服务（写入 SERVER_MODE=remote、服务商、端点与模型列表）。不带参数时打开应用里的云端配置页。

`omi cloud --set deepseek https://api.deepseek.com/v1 deepseek-chat` — 接入 DeepSeek 云端模型。

```bash
omi serve --model <路径>  ·  omi launch <工具> --model <名称|路径|云端 id>
```

在启动服务器 / 启动编码工具时直接指定模型：已装模型名、文件名、绝对路径或云端模型 id 都可以。省略时会自动选（只有一个模型）或弹出选择。

## 记忆：写入、检索、接入

同一份长期记忆库的三条调用通道：CLI、MCP、网关 REST。

```bash
omi memory add "记住：我偏好用中文回答" [--category fact|preference|experience|skill|other] [--tags 偏好,中文]
```

写入一条记忆。这是外部 Agent 的写回通道，也是手工补录入口；内容重复时会合并（不会堆重复条目）。

`omi memory add "项目用 bun workspace，不要引入 pnpm" --category preference --tags build` — 带分类与标签写入。

```bash
omi memory search "关键词" [--limit 8]
```

检索记忆（默认 8 条，上限 20）。结果是排序过的：相关度为主，重要度与新鲜度加权，等价改写也能召回。

```bash
omi memory list [--status active|pending|archived|all] [--limit n]
```

列出记忆，带编号、分类、状态、置顶与来源。默认不含「已被取代」的旧事实。

```bash
omi memory stats
```

记忆统计：条数分布（可用/待确认/归档/已取代）、分类分布、检索命中率、合并与敏感内容拦截次数、向量化进度。

```bash
omi memory maintain
```

整理记忆：合并历史遗留的近似重复、归档过期或长期未用的低价值记忆（不删除，可恢复）、补齐向量。应用启动时也会自动跑一次。

```bash
omi memory forget <id>
```

删除一条记忆（编号见 list / search）。用于撤回写错或已过时的内容。

```bash
omi memory export [--out file.json]  ·  omi memory import <file.json>
```

导出全部记忆为 JSON，或从 JSON 导入：逐条判重合并，可安全重复执行（迁移 / 备份用）。

```bash
omi memory mcp
```

把同一个记忆库作为 stdio MCP 服务器（omni-memory）暴露给宿主 Agent，提供 memory_search / memory_save / memory_forget / memory_list 四个工具。写入自动判重合并，可用 supersedes 取代过时记忆；应用在不在都能用：直连 SQLite，WAL 并发安全。
- omi launch 启动 Claude Code / Codex / OpenCode 时会自动写绝对路径并挂载它，多数情况下不用手配。

```bash
MEMORY_ENABLED=0  ·  MEMORY_REVIEW_MODE=1  ·  MEMORY_EMBEDDING_MODEL=<模型>
```

记忆开关：MEMORY_ENABLED=0 关闭全部记忆能力（不注入上下文文件、不挂 MCP、内置 Agent 不读写）；MEMORY_REVIEW_MODE=1 让 Agent / CLI / MCP 的写入先落「待确认」，在记忆页批准后才生效；配置 MEMORY_EMBEDDING_MODEL（可加 MEMORY_EMBEDDING_BASE / _API_KEY）后启用向量检索，语义相近的改写也能召回。

## 启动编码工具（加载 code）

一条命令把 Claude Code / Codex / OpenCode 等接到当前模型。

```bash
omi launch <工具> [--model <名称|路径|云端 id>] [-- 工具参数...]
```

启动编码工具并接入当前模型。执行顺序：确认应用在运行 → 选模型 → 需要时启动 / 重启本地推理服务器 → 确保 API 网关在线 → 写各工具自己的配置（保留用户原有配置）→ 注入共享记忆 → 前台拉起工具。
- 工具参数用 `--` 透传，例如 omi launch claude -- --resume。
- 本地模型走本地推理服务器，云端 id 走云端 API；网关负责 Anthropic ↔ OpenAI 协议翻译。

`omi launch --list` — 列出支持的工具与各自的协议。
`omi launch claude` — 唯一模型时自动选中并启动 Claude Code。
`omi launch claude --opus <模型> --haiku <模型>` — Claude Code 三个档位分别指定模型。
`omi launch codex --model qwen3-4b-q4_k_m` — 按服务名指定模型。
`omi launch opencode` — opencode 走内联 provider 配置，不改用户的全局配置。

```bash
omi launch claude  ·  codex  ·  opencode  ·  openclaw  ·  hermes  ·  pi  ·  copilot  ·  chatgpt
```

接入方式各自不同：claude 走环境变量（ANTHROPIC_*）并附带 --mcp-config；codex / chatgpt 写 ~/.codex 的 profile 与模型目录；opencode 用 OPENCODE_CONFIG_CONTENT；openclaw 写 ~/.openclaw/openclaw.json；hermes 写 ~/.hermes/config.yaml；pi 写 ~/.pi/agent/*.json；copilot 走环境变量。
- chatgpt 会改写 ~/.codex/config.toml（首次改写前备份到 ~/.codex/backup-omni/config.toml），然后打开桌面客户端；请先完全退出 ChatGPT（⌘Q）再让它重读配置。
- 每次启动的模型 / 端点记录在 ~/.omni/launcher/<工具>.json，方便排查。

## 备份与恢复

把设置、云端模型、技能、提示词、聊天、记忆与生成的媒体打包成一个文件，换机或重装后恢复。

```bash
omi backup create [--scopes a,b] [--out <目录>] [--note <备注>] [--password <密码>] [--upload] [--redact]
```

创建备份：数据库走 VACUUM INTO 快照（应用在运行时也是一致副本），选中的文件流式写入 tar + gzip。--password 用 AES-256-GCM 加密（密码不落盘，忘了就解不开，适合放 S3 / 网盘）；--upload 创建后传到已配置的远端存储；--redact 把明文 API Key 抹成空值（要把备份发给别人排错时用）。
- 模型权重（models/）与推理引擎（engines/）不参与备份：体积大且可重新下载；生成的音频 / 图片 / 视频默认也不备份（显式加 --scopes media 才会带上）。

`omi backup create --out ~/Backups --note "换机前"` — 整机备份到 ~/Backups，带备注。
`omi backup create --scopes settings,skills,chats,prompts,memory` — 只备份配置、技能、聊天、提示词与记忆（不含大体积媒体）。

```bash
omi backup list [--dir <目录>]  ·  omi backup inspect <file>
```

列出备份文件，或预览某份备份的内容、来源机器与警告（不改动任何数据）。

```bash
omi backup remote <list|test|download>
```

远端存储（S3 兼容对象存储 / WebDAV 网盘）：list 列出远端备份、test 测试连接、download 把远端备份拉到本地。配置在应用内「设置 → 数据 → 备份与恢复 → 远端存储」填一次（S3: Endpoint/Bucket/Region/AK/SK；WebDAV: 目录 URL/用户名/应用密码，坚果云即 dav.jianguoyun.com）；凭据只存本机，且备份自身会把它们剔除。

`omi backup remote test` — 验证远端凭据与目录是否可用。
`omi backup create --password-file ~/.omni-pass --upload` — 加密备份并直接上传到远端。

```bash
omi backup restore <file> [--password <密码>] [--scopes a,b] [--yes]
```

从备份恢复：默认先自动备份当前数据（pre-restore-*.omnibackup），再整表替换所选分组。恢复要求应用已退出（需要独占数据库）；应用内「设置 → 数据 → 备份与恢复」支持在线恢复并显示实时进度。

`omi backup restore ~/Backups/OmniStudio-20260912-101500.omnibackup --scopes settings,skills` — 只把设置与技能恢复回来。

```bash
omi backup create|list|inspect  ·  应用内「设置 → 数据 → 备份与恢复」
```

备份 / 列表 / 预览不需要应用在运行（内核不依赖应用进程与迁移层，应用起不来时也能先把数据备出来）；界面版另外支持按分组勾选内容、看体积预估、选保存位置、设置密码、配置远端存储并一键上传、远端备份列表直接下载并恢复、剔除密钥、恢复前预览与备份记录管理。

## 引擎依赖、版本与手册

排查引擎二进制、检查更新、随时打印完整手册。

```bash
omi install
```

检查 llama.cpp / vLLM / SGLang / MLX 是否可用，缺失时给出对应安装命令（MLX 只在 macOS 列出）。

```bash
omi version  ·  omi update
```

显示版本；检查 GitHub Releases 是否有新版本。

```bash
omi guide [--md] [--json] [--lang en]
```

打印这份完整手册：默认纯文本，--md 输出 Markdown，--json 输出结构化数据，--lang en 输出英文。

## 记忆接入片段

### Claude Code

写进项目或用户的 MCP 配置即可；用 omi launch claude 启动时会自动带上等价配置。

```json
{
  "mcpServers": {
    "omni-memory": {
      "command": "omi",
      "args": ["memory", "mcp"]
    }
  }
}
```

### Codex / ChatGPT

追加到 ~/.codex/config.toml；omi launch codex 会把绝对路径写进 omni-launch profile。

```toml
[mcp_servers.omni-memory]
command = "omi"
args = ["memory", "mcp"]
```

### opencode

加入 opencode.json 的顶层 mcp 字段（omi launch opencode 默认已挂载）。

```json
{
  "mcp": {
    "omni-memory": {
      "type": "local",
      "command": ["omi", "memory", "mcp"],
      "enabled": true
    }
  }
}
```

### 任意 MCP 客户端（HTTP）

应用在运行时，网关同时提供 Streamable HTTP 的 MCP 服务端（知识库 kb_search / kb_list + 记忆 memory_*）。设置了网关 Key 时需带 Authorization 头；浏览器打开同一地址可进入调试工作台。

```json
{
  "mcpServers": {
    "omni-gateway": {
      "type": "http",
      "url": "{{GATEWAY_URL}}/mcp",
      "headers": { "Authorization": "Bearer {{GATEWAY_KEY}}" }
    }
  }
}
```

### REST（脚本 / 服务）

网关另有 Mem0 风格的记忆接口，任何程序都能读写同一份记忆库。

```bash
# 检索
curl "{{GATEWAY_URL}}/v1/memories?q=关键词&limit=5" \
  -H "Authorization: Bearer {{GATEWAY_KEY}}"

# 写入
curl -X POST "{{GATEWAY_URL}}/v1/memories" \
  -H "Authorization: Bearer {{GATEWAY_KEY}}" \
  -H "Content-Type: application/json" \
  -d '{"content":"偏好用中文回答","category":"preference","tags":["偏好"]}'
```

---

本手册由 `omi guide --md` 生成（源数据：`apps/studio/src/shared/cli-docs.ts`）；设置页「工具 → 命令行」有同内容的可视化版本。
