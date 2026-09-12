export const HELP_TEXT = `OmniStudio — 本地大模型一体化桌面工作台（llama.cpp · vLLM · SGLang）

用法：omi <command> [options]

命令：
  start [options]      启动 OmniStudio 应用；--server 同时启动推理服务器，
                       --model 打开模型列表，--cloud 打开云端配置
  stop [name]          停止推理服务器
  restart              重启推理服务器
  serve [options]      前台独立运行推理服务器（OpenAI 兼容）
  launch <tool>        启动编码工具（codex / opencode / openclaw / hermes / pi / copilot / claude）
  model [options]      打开应用里的模型列表选模型；--list 列出已装模型，--select 终端选择
  cloud [options]      查看 / 配置云端模型服务
  models               列出本地与云端模型
  model-info <name>    查看模型详情
  status               查看服务器 / 网关状态
  server <action>      管理服务器：list | start | stop | restart | info | logs
  install              检查推理引擎依赖（llama.cpp / vLLM / SGLang）
  version              显示版本
  update               检查更新
  help                 显示帮助

选项：
  -h, --help           显示帮助
  -v, --version        显示版本

运行 'omi <command> --help' 查看子命令详情。`;

export const CMD_HELP: Record<string, string> = {
  start: `启动 OmniStudio 应用；未运行时自动拉起（安装路径或 --app-path）。

用法：omi start [options]

选项：
  --server      启动后同时启动推理服务器
  --model       启动后打开应用里的模型列表，选择模型
  --cloud       启动后打开云端配置页
  --app-path    指定 OmniStudio.app 完整路径（默认 /Applications/OmniStudio.app）`,
  stop: `停止推理服务器（需要应用在运行）。

用法：omi stop [name]

参数：
  name          当前只有一台本地推理服务器，可省略；
                传其它名字会给出提示`,
  restart: `重启推理服务器（需要应用在运行）。

用法：omi restart`,
  serve: `前台独立运行推理服务器，不依赖 GUI 应用（复用 llama.cpp / vLLM / SGLang 运行时）。

用法：omi serve [options]

选项：
  --port <n>    服务器端口（默认读设置 SERVER_PORT）
  --host <ip>   监听地址（默认 127.0.0.1）
  --engine <e>  推理引擎：llama.cpp | vllm | sglang
  --model <p>   模型文件路径（同时写为活动模型）
  --api-key <k> 设置网关 API key`,
  memory: `记忆的命令行入口，也是外部 Agent 写回共享记忆的通道。

用法：omi memory <子命令>

子命令：
  add <内容> [--category fact|preference|experience|skill|other] [--tags a,b]
              写入一条记忆
  search <关键词> [--limit 8]
              检索记忆
  list         列出全部记忆
  mcp          作为 stdio MCP 服务器运行（omni-memory，供 Claude Code /
               Codex / OpenCode 等以 MCP 工具读写同一份记忆库）`,
  launch: `启动编码工具并接入当前模型的 OpenAI/Anthropic 兼容接口。

用法：omi launch <tool> [options] [-- 工具参数...]

工具：codex | opencode | openclaw | hermes | pi | copilot | claude

选项：
  --model <name|path>  直接指定模型（已装模型名 / 服务名 / 文件路径）；
                       省略时若只有一个模型则自动选中，否则提示选择
  --list               列出可用工具
  --app-path           指定 OmniStudio.app 完整路径`,
  model: `打开模型列表 / 列出已装模型。

用法：omi model [options]

选项：
  --list        终端里列出已装模型
  --select      终端里选择模型并设为活动模型
  （不带选项时在应用 GUI 里打开模型列表让你选择）`,
  cloud: `查看 / 配置云端模型服务（远端 OpenAI 兼容 provider）。

用法：omi cloud [options]

选项：
  --list                查看当前云端配置与云端模型
  --set <provider> <endpoint> [models...]   写入云端配置（SERVER_MODE=remote）
  （不带选项时在应用 GUI 里打开云端配置页）`,
  models: `列出本地已安装模型与云端模型。

用法：omi models`,
  "model-info": `查看模型详情。

用法：omi model-info <name|path>

参数：
  <name|path>   模型文件名 / 服务名（slug）/ 仓库名 / 文件完整路径`,
  status: `查看推理服务器与网关状态。

用法：omi status`,
  server: `管理推理服务器。

用法：omi server <action> [name]

actions:
  list        列出可用的推理引擎与当前活动引擎
  start       启动推理服务器
  stop        停止推理服务器
  restart     重启推理服务器
  info        查看服务器详情（状态 / pid / 端口 / 引擎）
  logs        打印服务器日志尾部`,
  install: `检查推理引擎依赖（llama.cpp / vLLM / SGLang），缺失时打印安装命令。

用法：omi install`,
  version: `显示版本号（读仓库根 package.json / 应用版本）。

用法：omi version`,
  update: `检查 GitHub Releases 是否有新版本。

用法：omi update`,
};
