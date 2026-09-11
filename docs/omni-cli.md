# omni — OmniStudio 命令行工具

`omni` 把 OmniStudio 桌面应用的后端能力封装成全局命令行工具，**直接复用 `src/bun/` 的真实代码**（模型库、推理服务器、网关、聊天、设置），不重写一套。模型、配置、数据库与桌面应用完全共享——`omni model set` 激活的模型就是应用里默认的对话模型。

## 安装

```bash
cd apps/studio
bun link          # 全局注册 omni 命令
omni --version    # 验证
```

`bun link` 把 `omni` 装到 `~/.bun/bin/omni`。如果终端里找不到 `omni`，把 `~/.bun/bin` 加进 `PATH`（Bun 安装器通常已加）：

```bash
export PATH="$HOME/.bun/bin:$PATH"
```

卸载：

```bash
cd apps/studio && bun unlink
```

## 数据目录

CLI 直接读写桌面应用的数据库，默认自动探测**最新**使用过的 channel 数据目录
（`~/Library/Application Support/omni-studio.kunpengtalk.com/<channel>/`），
也可显式指定：

```bash
omni --data-dir /path/to/dir config path   # 查看生效目录
```

`OMNI_DATA_DIR`/`OMNI_DB_PATH` 环境变量优先级最高，脚本里可以用。

## 命令

```
omni model list|set|info|delete|dirs    管理本地模型
omni chat "<文本>" [-m 模型]            对话（本地/远端推理）
omni server start|stop|restart|kill|status   推理服务器
omni gateway start|stop|restart|status        统一 API 网关
omni serve [-m 模型]                    推理服务器 + 网关一体启动（长驻）
omni doctor                              环境体检
omni config list|get|set|path            读写应用设置
omni --help / --version
```

全局选项：`--json`（结构化输出，适合脚本）、`--data-dir <目录>`。

查看帮助：

```bash
omni --help                 # 全部命令
omni help <命令>            # 单命令帮助（等价于 <命令> --help）
omni chat --help            # 例如：chat 的详细选项
```

### 模型管理

```bash
omni model list                 # 列出已安装模型（● 为当前激活）
omni model list --json          # JSON 输出
omni model set Qwen3-4B-Q4_K_M.gguf   # 按文件名/slug/路径激活，自动切换推理引擎
omni model info qwen3-4b-q4_k_m       # 详情 + 实际启动命令
omni model delete tiny.bin --yes      # 删除模型文件（必须显式 --yes）
omni model dirs                       # 模型目录列表
```

### 对话

```bash
omni chat "用一句话介绍Git"            # 本地推理，流式输出
omni chat "你好" --no-stream           # 一次性返回全文
omni chat "1+1等于几" --reasoning      # 同时输出思考过程
omni chat "详细解释" -m deepseek-flash # -m 指定远端 API 模型 id
omni chat "..." --system "用英文回答"
```

本地模式下 `chat` 会**自动拉起推理服务器**并等待健康检查通过；如果检测到端口上已有
运行中的推理服务（比如桌面应用自己开的服务器），会直接复用，避免端口冲突。

### 推理服务器 / 网关

```bash
omni serve                      # 一次拉起推理服务器 + 网关（推荐）
omni server start               # 仅推理服务器（前台长驻）
omni server status              # 引擎 / 状态 / 启动命令；能识别应用已开的服务
omni server stop | kill         # 停止 / 强制结束
omni gateway start | status | stop | restart
```

**重要**：`server start`、`gateway start`、`serve` 是**前台长驻命令**——推理服务器和
网关必须与 CLI 进程同生命周期，启动成功后命令不会退出，按 `CTRL+C` 优雅停止。
如需后台运行，用 `tmux`/`nohup` 等包一层：

```bash
tmux new -s omni -d 'omni serve && read'
# 之后: tmux kill-session -t omni
```

`server status` / `gateway status` 会探测端口，即使服务是桌面应用启动的也能如实报告。

### 配置

```bash
omni config list                       # 全部设置
omni config get INFERENCE_ENGINE       # 读单个设置
omni config set SERVER_TEMP 0.8        # 写设置（直接写应用数据库，大多即时生效）
omni config path                       # 数据目录 / 数据库路径
```

`config set` 只接受已知设置项（拼错会报错并提示常见项），不会往数据库里写垃圾键。

### 体检

```bash
omni doctor          # 数据目录 / 数据库 / 引擎二进制 / 服务 / 云端 API 配置
omni doctor --json
```

有检查项不通过时退出码为非零，便于接入脚本。

## 常见用法

```bash
# 一条命令跟桌面应用本地模型对话
omni chat "今天有什么新闻" --reasoning

# 脚本里拿 JSON
MODELS=$(omni model list --json)

# 无头环境把推理服务 + 网关常驻
omni --data-dir "$MY_DIR" serve

# 换引擎再聊天
omni model set Spark-X2.5-4B.gguf && omni chat "你好"
```

## 说明与限制

- **共享同一个数据库**：`omni config set`、`omni model set` 会直接改桌面应用的设置；
  运行中的应用大多按请求读设置，会即时生效。
- **不加载桌面 UI**：CLI 只 import 后端模块，不启动应用窗口。
- **端口共存**：桌面应用开着时，CLI 启动的服务会因端口占用自动复用/让位（网关自动
  换端口），状态命令会用端口探测如实报告外部实例。
- **`chat`/`model list` 只读不改库**（`model set` 除外），可放心在脚本中使用。
