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

按关键词检索记忆（默认 8 条，上限 20）。

```bash
omi memory list
```

列出全部记忆，带编号、分类、置顶与来源（手动 / Agent）。删除可在应用的「记忆」应用里完成。

```bash
omi memory mcp
```

把同一个记忆库作为 stdio MCP 服务器（omni-memory）暴露给宿主 Agent，提供 memory_search / memory_save / memory_list 三个工具。应用在不在都能用：直连 SQLite，WAL 并发安全。
- omi launch 启动 Claude Code / Codex / OpenCode 时会自动写绝对路径并挂载它，多数情况下不用手配。

```bash
MEMORY_ENABLED=0
```

记忆总开关。关闭后不再注入上下文文件、不给编码工具挂 MCP，内置 Agent 也不再读写记忆。

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
