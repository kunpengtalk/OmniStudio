/**
 * CLI 帮助文本。
 *
 * - HELP_TEXT：`omi` / `omi help` 的总览；
 * - CMD_HELP：单命令帮助（`omi help <命令>`、`omi <命令> --help`）；
 * - TOPIC_HELP：子命令帮助（`omi help memory add`、`omi memory add --help`）。
 *
 * 面向使用者的完整手册（含 memory / code 加载等专题与接入片段）在
 * `src/shared/cli-docs.ts`，由 `omi guide` 输出，并与设置页「命令行」页共用。
 */

export const HELP_TEXT = `OmniStudio — 本地大模型一体化桌面工作台（llama.cpp · vLLM · SGLang · MLX）

用法：omi <command> [options]

命令：
  start [options]      启动 OmniStudio 应用；--server 同时启动推理服务器，
                       --model 打开模型列表，--cloud 打开云端配置
  stop [name]          停止推理服务器
  restart              重启推理服务器
  serve [options]      前台独立运行推理服务器（OpenAI 兼容）
  launch <tool>        启动编码工具（codex / opencode / openclaw / hermes / pi / copilot / claude / chatgpt）
  model [options]      打开应用里的模型列表选模型；--list 列出已装模型，--select 终端选择
  cloud [options]      查看 / 配置云端模型服务
  models               列出本地与云端模型
  model-info <name>    查看模型详情
  memory <子命令>      共享记忆：add / search / list / stats / maintain / forget / export / import / mcp
  backup <子命令>      全局备份 / 恢复：list / create / inspect / restore
  status               查看服务器 / 网关状态
  server <action>      管理服务器：list | start | stop | restart | info | logs
  benchmark [model]    跑基准测速（本地引擎 / 云端 API），结果入库
  install              检查推理引擎依赖（llama.cpp / vLLM / SGLang / MLX）
  guide                打印完整使用手册（--md / --json / --lang en）
  version              显示版本
  update               检查更新
  help [命令] [子命令]  显示帮助

选项：
  -h, --help           显示帮助
  -v, --version        显示版本

常用示例：
  omi start --server                 启动应用与推理服务器
  omi model --select                 终端里选择活动模型
  omi memory add "偏好用中文回答"     写入一条共享记忆
  omi backup create --out ~/Backups  把设置 / 技能 / 聊天 / 记忆等打包备份
  omi launch claude --model qwen3-4b  用当前模型启动 Claude Code

运行 'omi help <命令>' 查看单命令详情，'omi guide' 查看完整手册（含记忆接入与 code 加载）。`;

export const CMD_HELP: Record<string, string> = {
  start: `启动 OmniStudio 应用；未运行时自动拉起（安装路径或 --app-path）。

用法：omi start [options]

选项：
  --server      启动后同时启动推理服务器并等待就绪
  --model       启动后打开应用里的模型列表，选择模型
  --cloud       启动后打开云端配置页
  --app-path    指定 OmniStudio.app 完整路径（默认 /Applications/OmniStudio.app）

示例：
  omi start --server                  应用 + 推理服务器一起起来
  omi start --model --app-path ~/Applications/OmniStudio.app`,
  stop: `停止推理服务器（需要应用在运行）。

用法：omi stop [name]

参数：
  name          当前只有一台本地推理服务器，可省略；
                传其它名字会给出提示`,
  restart: `重启推理服务器（需要应用在运行）。切换活动模型后可用它让新模型生效。

用法：omi restart`,
  serve: `前台独立运行推理服务器，不依赖 GUI 应用（复用 llama.cpp / vLLM / SGLang / MLX 运行时）。

用法：omi serve [options]

选项：
  --port <n>    服务器端口（默认读设置 SERVER_PORT）
  --host <ip>   监听地址（默认 127.0.0.1）
  --engine <e>  推理引擎：llama.cpp | vllm | sglang | mlx
  --model <p>   模型文件路径（同时写为活动模型）
  --api-key <k> 设置网关 API key

说明：
  前台长驻，按 Ctrl+C 优雅停止；参数会写回应用设置。
  后台运行：tmux new -s omi -d 'omi serve && read'`,
  memory: `记忆的命令行入口，也是外部 Agent 写回共享记忆的通道。

用法：omi memory <子命令>

子命令：
  add <内容> [--category fact|preference|experience|skill|other] [--tags a,b]
              写入一条记忆（重复内容自动合并；疑似密钥会被拒绝）
  search <关键词> [--limit 8]
              检索记忆（按相关度/重要度/新鲜度排序，上限 20）
  list [--status active|pending|archived|all] [--limit n]
              列出记忆（默认排除已被取代的条目）
  stats        记忆统计：条数、分类、检索命中率、合并/拦截次数
  maintain     整理记忆：合并历史重复、归档过期/长期未用的低价值记忆、补向量
  forget <id>  删除一条记忆（等同"忘掉"）
  export [--out file.json]
              导出全部记忆为 JSON（备份 / 迁移）
  import <file.json>
              从 JSON 导入（逐条判重合并，可安全重复执行）
  mcp          作为 stdio MCP 服务器运行（omni-memory，供 Claude Code /
               Codex / OpenCode 等以 MCP 工具读写同一份记忆库）

示例：
  omi memory add "偏好用中文回答" --category preference --tags 偏好
  omi memory search "构建工具" --limit 5
  omi memory stats
  omi memory export --out memories.json

接入片段见 'omi help memory mcp'；应用在运行时也可走网关：
  MCP   POST http://127.0.0.1:10000/mcp
  REST  GET/POST http://127.0.0.1:10000/v1/memories

完整手册：omi guide`,
  launch: `启动编码工具并接入当前模型的 OpenAI/Anthropic 兼容接口。

用法：omi launch <tool> [options] [-- 工具参数...]

工具：codex | opencode | openclaw | hermes | pi | copilot | claude | chatgpt

选项：
  --model <name|path>  直接指定模型（已装模型名 / 服务名 / 文件路径 / 云端 id）；
                       省略时若只有一个模型则自动选中，否则提示选择
  --opus <name>        Claude Code 的 Opus 档位单独指定模型
  --haiku <name>       Claude Code 的 Haiku 档位单独指定模型
  --list               列出可用工具
  benchmark [model]    跑基准测速（本地引擎 / 云端 API），结果入库
  --app-path           指定 OmniStudio.app 完整路径

说明：
  自动完成：确保应用在运行 → 选模型 → 必要时启动/重启本地推理服务器 →
  确保 API 网关在线 → 写各工具自己的配置 → 注入共享记忆 → 前台拉起工具。
  "--" 之后的参数原样传给工具。

示例：
  omi launch --list
  omi launch claude
  omi launch codex --model qwen3-4b-q4_k_m
  omi launch claude -- --resume

各工具的接线细节：omi help launch <tool>（如 omi help launch claude）`,
  model: `打开模型列表 / 列出已装模型。

用法：omi model [options]

选项：
  --list        终端里列出已装模型
  --select      终端里选择模型并设为活动模型（会重启推理服务器）
  （不带选项时在应用 GUI 里打开模型列表让你选择）

相关：omi models 本地+云端清单，omi model-info <名字> 详情`,
  cloud: `查看 / 配置云端模型服务（远端 OpenAI 兼容 provider）。

用法：omi cloud [options]

选项：
  --list                查看当前云端配置与云端模型
  --set <provider> <endpoint> [models...]   写入云端配置（SERVER_MODE=remote）
  （不带选项时在应用 GUI 里打开云端配置页）

示例：
  omi cloud --list
  omi cloud --set deepseek https://api.deepseek.com/v1 deepseek-chat`,
  models: `列出本地已安装模型与云端模型。列里 ● 表示当前活动模型。

用法：omi models`,
  "model-info": `查看模型详情。

用法：omi model-info <name|path>

参数：
  <name|path>   模型文件名 / 服务名（slug）/ 仓库名 / 文件完整路径`,
  status: `查看推理服务器与网关状态。

用法：omi status

说明：应用未运行时改为探测推理端口（可能报告外部实例）与打印设置里的地址。`,
  benchmark: `跑基准测速（本地引擎 / 云端 API），结果写进应用里的基准测试记录。

用法：omi benchmark [model] [options]

参数：
  [model]       要测的模型名 / 服务名（默认当前活动模型）；--cloud 时是服务商模型 ID

选项：
  --list             列出最近的基准记录（最多 20 条）后退出
  --cloud [provider] 直接测云端服务商（不带值则用当前配置的服务商）
  --gen <n>          每次请求生成多少 token
  --batch <n>        并发批大小
  --contexts <a,b>   要测的上下文档位，逗号分隔（如 1024,4096,8192）
  --json             以 JSON 输出结果
  --open             跑完后在应用里打开基准测试页

说明：应用未运行时在本进程内直接执行（结果写同一份数据库）；
Ctrl+C 取消本次测试（已跑完的档位会保留）。`,
  server: `管理推理服务器。

用法：omi server <action> [name]

actions:
  list        列出可用的推理引擎与当前活动引擎
  start       启动推理服务器
  stop        停止推理服务器
  restart     重启推理服务器
  info        查看服务器详情（状态 / pid / 端口 / 引擎）
  logs        打印服务器日志尾部（最近 200 行）

子命令帮助：omi help server <action>`,
  backup: `全局备份 / 恢复：把应用设置与云端模型、本地技能、提示词、聊天记录、
记忆库、生成的音频 / 图片 / 视频打包成一个文件，换机或重装后恢复。

用法：omi backup <list|create|inspect|restore|remote> [options]

子命令：
  list [--dir <目录>] [--json]
              列出备份文件（默认是数据目录下的 backups/）
  create [--scopes a,b] [--out <目录>] [--name <文件名>] [--note <备注>]
         [--password <密码>|--password-file <文件>] [--upload]
         [--redact] [--no-compress] [--json]
              创建备份；--password 加密（AES-256-GCM，忘密码=数据打不开），
              --upload 创建后传到已配置的远端存储
  inspect <file> [--password <密码>] [--json]
              预览备份内容、来源机器与警告（不改动任何数据）
  restore <file> [--password <密码>] [--scopes a,b] [--no-safety] [--yes] [--json]
              从备份恢复；默认先自动备份当前数据（pre-restore-*.omnibackup）
  remote <list|test|download> [--json]
              远端存储：列出远端备份 / 测试连接 / 下载到本地备份目录

内容分组（--scopes，逗号分隔）：
  settings   应用设置与云端模型（含 API Key、MCP 服务器）
  chats      聊天与 Agent 会话（含聊天附件图片）
  prompts    提示词库
  skills     本地技能（含技能中央仓库文件，不含 .git）
  memory     记忆库
  knowledge  知识库（文档 / 分块 / 向量；默认不含，体积可能很大）
  media      音频 / 图片 / 视频 / 文档（默认不含：体积大）

说明：
  list / create / inspect 不需要应用在运行 —— 备份内核不依赖应用进程与数据库
  迁移层，因此应用起不来时也能先把数据备份出来；restore 需要独占数据库，
  应用在运行时会拒绝执行，可在应用内「设置 → 数据 → 备份与恢复」里恢复
  （那里有实时进度，跑完自动刷新界面）。
  模型权重（models/）与推理引擎（engines/）不参与备份：体积大且可重新下载；
  生成的音频 / 图片 / 视频默认也不备份（要的话显式加 --scopes media）。
  远端存储（S3 兼容 / WebDAV，如坚果云）在应用内配置一次，之后 --upload 即可。

示例：
  omi backup create --out ~/Backups
  omi backup create --scopes settings,skills,chats,memory --password-file ~/.omni-pass
  omi backup create --password "口令" --upload           加密并上传到远端
  omi backup list
  omi backup inspect ~/Backups/OmniStudio-20260912-101500.omnibackup
  omi backup restore ~/Backups/OmniStudio-20260912-101500.omnibackup
  omi backup remote list                                 看远端有哪些备份
  omi backup remote download OmniStudio-20260912-101500.omnibackup`,
  guide: `打印完整使用手册：安装、启动、模型加载、记忆调用、编码工具（code）加载等。

用法：omi guide [options]

选项：
  --md      输出 Markdown（docs/omi-cli.md 的正文）
  --json    输出结构化 JSON（脚本用）
  --lang    输出语言：zh（默认）/ en

与设置页「工具 → 命令行」页共用同一份数据源（src/shared/cli-docs.ts）。`,
  install: `检查推理引擎依赖（llama.cpp / vLLM / SGLang / MLX），缺失时打印安装命令。

用法：omi install`,
  version: `显示版本号（读仓库根 package.json / 应用版本）。

用法：omi version`,
  update: `检查 GitHub Releases 是否有新版本。

用法：omi update`,
};

/**
 * 子命令帮助。键是 `命令 子命令`（`omi help memory add` / `omi memory add --help`）。
 * launch 的工具条目是模板填充，见 launchToolHelp。
 */
export const TOPIC_HELP: Record<string, string> = {
  "backup create": `创建一份全局备份（单个 .omnibackup 文件，内含数据库快照 + 选中的文件）。

用法：omi backup create [options]

选项：
  --scopes <a,b,c>  要包含的内容分组，默认 settings,chats,prompts,skills,memory
  --out <目录>      保存目录，默认数据目录下的 backups/
  --name <文件名>   自定义文件名（默认 OmniStudio-<时间戳>.omnibackup）
  --note <备注>     写进备份清单，inspect / 应用内列表都能看到
  --password <密码> 加密备份（AES-256-GCM + scrypt）。密码不落盘，忘了就解不开
  --password-file <文件>
                    从文件读密码（推荐：不进 shell 历史 / ps 输出）
  --upload          创建完成后上传到已配置的远端存储
  --redact          剔除明文 API Key / Token（要把备份发给别人排错时用）
  --no-compress     不压缩（默认 gzip；媒体文件收益有限时可用它省时间）
  --json            输出结构化结果（脚本用）

说明：
  数据库快照用 SQLite 的 VACUUM INTO 生成，应用在运行（WAL）时也能拿到一致副本；
  未勾选的分组不会被打包 —— 表会被删掉（secure_delete）再压缩，不留残影。

示例：
  omi backup create --out ~/Backups --note "换机前"
  omi backup create --scopes settings,skills,chats,prompts,memory`,
  "backup restore": `从备份恢复（破坏性：整表替换所选分组的数据）。

用法：omi backup restore <file.omnibackup> [options]

选项：
  --password <密码> 加密备份的密码（也可用 --password-file <文件>，或交互输入）
  --scopes <a,b,c>  只恢复其中一部分分组，默认恢复备份里的全部
  --no-safety       不预先备份当前数据（默认会生成 pre-restore-*.omnibackup）
  --yes             跳过交互确认（非 TTY 环境必须加）
  --json            输出结构化结果（脚本用）

说明：
  恢复要求 OmniStudio 已退出：恢复过程会直接写数据库，应用在运行时有自己的
  连接与缓存，两个写者会互相踩。应用里的「设置 → 数据 → 备份与恢复」页面
  支持在线恢复（带进度、完成后自动刷新界面）。
  恢复只覆盖备份里有的同名文件，不会删除备份里没有的文件。

示例：
  omi backup restore ~/Backups/OmniStudio-20260912-101500.omnibackup
  omi backup restore backup.omnibackup --scopes settings,skills --yes`,
  "backup remote": `远端存储（S3 兼容 / WebDAV）：列出远端备份、测试连接、下载到本地。

用法：omi backup remote <list|test|download> [options]

子命令：
  list [--json]          列出远端已有的备份（文件名 / 时间 / 体积）
  test                   测试当前配置能否访问（列一次目录）
  download <文件名>       把远端的一份备份下载到本地备份目录，随后可 inspect / restore

说明：
  远端配置（类型 S3 或 WebDAV、地址、Bucket、凭据、目录前缀、自动上传）在应用内
  「设置 → 数据 → 备份与恢复 → 远端存储」里填写并保存；凭据只存在本机数据库，
  且备份自身会把它们剔除（分享备份不会泄露）。
  S3 用 Signature V4 签名；WebDAV 用 Basic 认证（坚果云请用「应用密码」）。
  单次上传走 S3 的 PUT，上限 5 GB —— 超过请减少备份内容或改走本地。

示例：
  omi backup remote test
  omi backup remote list
  omi backup remote download OmniStudio-20260912-101500.omnibackup
  omi backup restore ~/Library/Application\ Support/omni-studio.kunpengtalk.com/dev/backups/OmniStudio-20260912-101500.omnibackup`,
  "memory add": `写入一条共享记忆（外部 Agent 的写回通道）。

用法：omi memory add <内容> [options]

选项：
  --category <c>  分类：fact（默认）| preference | experience | skill | other
  --tags <a,b>    标签，逗号分隔（中英文逗号都可以）
  --content <文本>  以选项形式给内容（等价于位置参数）

说明：
  内容重复时自动合并，不会堆重复条目；应用在运行时实时写入，
  未运行时直连同一个 SQLite（WAL）。写入后可在应用「记忆」页查看。

示例：
  omi memory add "偏好用中文回答"
  omi memory add "项目用 bun workspace" --category preference --tags build,约定`,
  "memory search": `按关键词检索共享记忆。

用法：omi memory search <关键词> [options]

选项：
  --limit <n>   返回条数，默认 8，上限 20
  --query <文本>  以选项形式给关键词

示例：
  omi memory search "构建工具"
  omi memory search 部署 --limit 3`,
  "memory list": `列出共享记忆（编号、分类、来源、状态、标签）。

用法：omi memory list [--status active|pending|archived|all] [--limit n]

默认列出除"已被取代"之外的全部条目。

说明：条目编号即应用「记忆」页里的 id；删除、置顶请在应用内操作。`,
  "memory mcp": `把共享记忆库作为 stdio MCP 服务器（omni-memory）提供给外部 Agent。

用法：omi memory mcp

提供的工具：
  memory_search(query, limit, category?)          检索（相关度排序）
  memory_save(content, category?, tags?, supersedes?) 写入（重复合并 / 取代旧记忆）
  memory_forget(id?, query?, reason?)             删除错误或过时的记忆
  memory_list(status?, limit?)                    列出记忆

Claude Code（写进 MCP 配置，omi launch claude 会自动带上等价参数）
  {"mcpServers":{"omni-memory":{"command":"omi","args":["memory","mcp"]}}}

Codex / ChatGPT（~/.codex/config.toml）
  [mcp_servers.omni-memory]
  command = "omi"
  args = ["memory", "mcp"]

opencode（opencode.json 顶层 mcp 字段）
  {"mcp":{"omni-memory":{"type":"local","command":["omi","memory","mcp"],"enabled":true}}}

应用在运行时的 HTTP 方式（网关 Streamable HTTP，另含知识库工具）：
  url: http://127.0.0.1:10000/mcp

说明：
  应用不在运行时同样可用（直连 SQLite）；宿主 Agent 结束会话、stdin 关闭即退出。
  记忆总开关 MEMORY_ENABLED=0 时，omi launch 不再自动挂载。`,
  "server list": `列出可用推理引擎与当前活动引擎（● 为活动）。

用法：omi server list`,
  "server start": `启动推理服务器（异步返回，就绪状态用 omi status / omi server info 查看）。

用法：omi server start`,
  "server stop": `停止推理服务器。

用法：omi server stop`,
  "server restart": `重启推理服务器。

用法：omi server restart`,
  "server info": `查看服务器详情：引擎 / 状态 / PID / 地址。

用法：omi server info`,
  "server logs": `打印服务器日志尾部（最近 200 行）。

用法：omi server logs`,
};

/** 每个编码工具的接线方式（`omi help launch <tool>`）。 */
const LAUNCH_TOOL_WIRING: Record<string, { protocol: string; how: string; extra?: string }> = {
  claude: {
    protocol: "Anthropic 兼容",
    how: "环境变量 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL 指向本机网关",
    extra: "--mcp-config 挂载 omni-memory；--opus / --haiku 可单独指定档位模型",
  },
  codex: {
    protocol: "OpenAI 兼容（responses）",
    how: "写 ~/.codex/<profile>.config.toml 与模型目录 model.json，profile 名 omni-launch",
    extra: "记忆开启时在 profile 里登记 omni-memory MCP",
  },
  opencode: {
    protocol: "OpenAI 兼容",
    how: "OPENCODE_CONFIG_CONTENT 内联 provider（omni/<模型>），并把模型写入 recent",
    extra: "记忆开启时内联挂载 omni-memory MCP",
  },
  openclaw: {
    protocol: "OpenAI 兼容",
    how: "写 ~/.openclaw/openclaw.json 的 models.providers.omni 与 agents.defaults.model.primary",
  },
  hermes: {
    protocol: "通用 OpenAI 兼容",
    how: "写 ~/.hermes/config.yaml 的 model / providers[omni-launch]",
  },
  pi: {
    protocol: "通用 OpenAI 兼容",
    how: "写 ~/.pi/agent/models.json 的 providers.omni 与 settings.json 默认模型",
  },
  copilot: {
    protocol: "OpenAI 兼容（responses）",
    how: "环境变量 COPILOT_PROVIDER_BASE_URL / COPILOT_PROVIDER_API_KEY / COPILOT_MODEL",
  },
  chatgpt: {
    protocol: "OpenAI 兼容（responses）",
    how: "改写 ~/.codex/config.toml（首次先备份到 ~/.codex/backup-omni/）并写 models.json，然后打开桌面端",
    extra: "若 ChatGPT 正在运行，请完全退出（⌘Q）后重新打开",
  },
};

export function launchToolHelp(tool: string): string | undefined {
  const wiring = LAUNCH_TOOL_WIRING[tool];
  if (!wiring) return undefined;
  return `omi launch ${tool} — ${wiring.protocol}

用法：omi launch ${tool} [--model <名称|路径|云端 id>] [-- 工具参数...]

接线方式：
  ${wiring.how}${wiring.extra ? `\n  ${wiring.extra}` : ""}

启动流程：确保应用在运行 → 选模型 → 必要时启动/重启本地推理服务器 →
  确保 API 网关在线 → 写配置 → 注入共享记忆 → 前台拉起 ${tool}。

每次启动记录：~/.omni/launcher/${tool}.json（模型 / 端点 / 时间）

示例：
  omi launch ${tool}
  omi launch ${tool} --model qwen3-4b-q4_k_m`;
}

/**
 * 查帮助：依次尝试「命令 子命令」（含 launch <tool>）→「命令」→ 总览。
 * `omi help memory add`、`omi memory add -h` 都走这里。
 */
export function helpFor(words: (string | undefined)[]): string {
  const [cmd, sub] = words.filter((w): w is string => !!w);
  if (!cmd) return HELP_TEXT;
  if (cmd === "launch" && sub) {
    const tool = launchToolHelp(sub);
    if (tool) return tool;
  }
  if (sub) {
    const topic = TOPIC_HELP[`${cmd} ${sub}`];
    if (topic) return topic;
  }
  return CMD_HELP[cmd] ?? HELP_TEXT;
}
