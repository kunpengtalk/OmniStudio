/**
 * `omi` 命令行手册的唯一数据源（中英双语）。
 *
 * 三个出口共用这一份定义，避免文档与实现漂移：
 * - 设置页「命令行」标签页（`mainview/app/main-layout/cli-tab.tsx`）；
 * - `omi guide`（`src/cli/commands/guide.ts`，文本 / Markdown / JSON）；
 * - `docs/omi-cli.md`（由 `omi guide --md` 生成，scripts/omi-docs-smoke.ts 校验同步）。
 *
 * 这里只放纯数据与纯函数，不 import 任何 Node / DOM 模块，主进程与 webview 都能用。
 */

export type CliLang = "zh" | "en";

export type CliExample = {
  cmd: string;
  zh: string;
  en: string;
};

export type CliEntry = {
  /** 主命令：等宽显示并可一键复制。 */
  cmd: string;
  zh: string;
  en: string;
  /** 补充说明（每行一个要点）。 */
  notes?: { zh: string; en: string }[];
  /** 可复制的示例命令。 */
  examples?: CliExample[];
};

export type CliSection = {
  id: string;
  titleZh: string;
  titleEn: string;
  descZh: string;
  descEn: string;
  entries: CliEntry[];
};

export type CliSnippet = {
  id: string;
  titleZh: string;
  titleEn: string;
  descZh: string;
  descEn: string;
  /** 代码块语言（markdown 渲染 / 高亮用）。 */
  language: "json" | "toml" | "bash";
  /** 代码正文；`{{GATEWAY_URL}}` / `{{GATEWAY_KEY}}` 由 renderSnippet 替换。 */
  code: string;
};

export const GATEWAY_URL_PLACEHOLDER = "{{GATEWAY_URL}}";
export const GATEWAY_KEY_PLACEHOLDER = "{{GATEWAY_KEY}}";

export type SnippetContext = {
  gatewayUrl: string;
  gatewayKey: string;
};

/** 把片段里的网关占位符换成当前设置里的真实地址 / 密钥。 */
export function renderSnippet(code: string, ctx: SnippetContext): string {
  return code
    .split(GATEWAY_URL_PLACEHOLDER)
    .join(ctx.gatewayUrl)
    .split(GATEWAY_KEY_PLACEHOLDER)
    .join(ctx.gatewayKey);
}

export const CLI_DOC_TITLE = { zh: "omi — OmniStudio 命令行工具", en: "omi — the OmniStudio command line" };

export const CLI_DOC_INTRO = {
  zh:
    "omi 把桌面应用的后端能力（模型库、推理服务器、API 网关、共享记忆、编码工具启动器）封装成一条命令行。" +
    "它和应用共用同一份 SQLite 与设置：应用在运行时走控制 socket 实时读写，应用没运行时直接读库兜底。",
  en:
    "omi exposes the desktop app's backend (model library, inference server, API gateway, shared memory, coding-tool launcher) as a single command line. " +
    "It shares the same SQLite database and settings as the app: commands talk to the running app over its control socket, and fall back to reading the database directly when it is not running.",
};

// ---------------------------------------------------------------------------
// 命令分组
// ---------------------------------------------------------------------------

export const CLI_SECTIONS: CliSection[] = [
  {
    id: "install",
    titleZh: "安装与启用",
    titleEn: "Install & enable",
    descZh: "把 omi 装进 PATH，并确认它读写的是哪份数据。",
    descEn: "Put omi on your PATH and confirm which data directory it uses.",
    entries: [
      {
        cmd: "cd apps/studio && bun link",
        zh: "在仓库里执行一次，把 omi 注册到全局（~/.bun/bin/omi）。",
        en: "Run once from the repo to register omi globally (~/.bun/bin/omi).",
        notes: [
          {
            zh: '终端里提示找不到命令时：export PATH="$HOME/.bun/bin:$PATH"。',
            en: 'If the shell cannot find it: export PATH="$HOME/.bun/bin:$PATH".',
          },
          { zh: "卸载：cd apps/studio && bun unlink。", en: "Uninstall: cd apps/studio && bun unlink." },
          {
            zh: "仓库里另有早期的 omni 命令（chat / doctor / config 等，见 docs/omni-cli.md）；新能力只进 omi，两者共用同一份库与设置。",
            en: "The repo also ships the earlier omni command (chat / doctor / config …, see docs/omni-cli.md); new features land in omi only, and both share the same database and settings.",
          },
        ],
        examples: [
          { cmd: "omi --version", zh: "验证安装与当前版本。", en: "Verify the install and current version." },
          { cmd: "omi help", zh: "命令总览；omi help <命令> 看单命令详情。", en: "Command overview; omi help <command> for details." },
        ],
      },
      {
        cmd: "OMNI_DATA_DIR=<数据目录> omi models",
        zh:
          "默认自动探测最新使用过的 channel 数据目录（macOS：~/Library/Application Support/omni-studio.kunpengtalk.com/<channel>）。" +
          "无头 / 多份数据时用 OMNI_DATA_DIR 指定目录，OMNI_DB_PATH 可再单独指定数据库文件。",
        en:
          "By default omi auto-detects the most recently used channel data directory (macOS: ~/Library/Application Support/omni-studio.kunpengtalk.com/<channel>). " +
          "For headless setups or multiple profiles, point OMNI_DATA_DIR at a directory; OMNI_DB_PATH overrides the database file alone.",
      },
    ],
  },
  {
    id: "start",
    titleZh: "启动应用与推理服务器",
    titleEn: "Start the app & inference server",
    descZh: "唤起桌面应用、拉起 / 停止本地推理服务器，并查看状态。",
    descEn: "Launch the desktop app, start or stop the local inference server, and check status.",
    entries: [
      {
        cmd: "omi start",
        zh: "启动 OmniStudio（未运行时自动拉起并等待控制通道就绪）。",
        en: "Start OmniStudio (launches it if needed and waits for the control channel).",
        notes: [
          {
            zh: "装在非默认位置时加 --app-path /path/to/OmniStudio.app。",
            en: "Installed elsewhere? Pass --app-path /path/to/OmniStudio.app.",
          },
        ],
        examples: [
          { cmd: "omi start --server", zh: "启动应用并同时拉起推理服务器，就绪后打印地址与引擎。", en: "Start the app and the inference server, printing address and engine once ready." },
          { cmd: "omi start --model", zh: "启动后直接在应用里打开模型列表。", en: "Open the model list in the app after starting." },
          { cmd: "omi start --cloud", zh: "启动后打开设置里的云端配置页。", en: "Open the cloud provider settings after starting." },
        ],
      },
      {
        cmd: "omi status",
        zh: "查看应用 / 推理服务器 / 网关状态（引擎、PID、端口、模式）。应用没运行时改为探测推理端口。",
        en: "Show app, inference server and gateway status (engine, PID, port, mode). Falls back to probing the inference port when the app is not running.",
      },
      {
        cmd: "omi stop  ·  omi restart",
        zh: "停止 / 重启本地推理服务器（需要应用在运行）。当前只有一台本地服务器，引擎由设置决定，传名字会被忽略。",
        en: "Stop or restart the local inference server (requires the app to be running). There is one local server whose engine comes from settings, so a name argument is ignored.",
      },
      {
        cmd: "omi server <list|start|stop|restart|info|logs>",
        zh: "推理服务器的细粒度管理：列出可用引擎与当前活动引擎、启动、停止、重启、查看详情、打印日志尾部。",
        en: "Fine-grained server control: list available engines and the active one, start, stop, restart, show details, print the log tail.",
        examples: [
          { cmd: "omi server list", zh: "可用引擎清单（● 为活动引擎）。", en: "Engine list with ● marking the active one." },
          { cmd: "omi server info", zh: "引擎 / 状态 / PID / 地址。", en: "Engine, status, PID and address." },
          { cmd: "omi server logs", zh: "最近 200 行服务器日志，排错先看这里。", en: "Last 200 log lines — the first place to look when debugging." },
        ],
      },
    ],
  },
  {
    id: "serve",
    titleZh: "无界面常驻运行（serve）",
    titleEn: "Headless serve",
    descZh: "不打开 GUI，直接复用同一套运行时把推理服务器跑在前台。",
    descEn: "Run the inference server in the foreground without the GUI, reusing the same runtimes.",
    entries: [
      {
        cmd: "omi serve [--port 8080] [--host 127.0.0.1] [--engine llama.cpp] [--model <路径>] [--api-key <key>]",
        zh: "前台长驻：启动成功后命令不会退出，按 Ctrl+C 优雅停止。参数会写回应用设置（端口 / 监听地址 / 引擎 / 活动模型 / 网关 Key）。",
        en: "Foreground and long-lived: the command does not exit after a successful start; press Ctrl+C to stop gracefully. Flags are written back to app settings (port, host, engine, active model, gateway key).",
        notes: [
          {
            zh: "后台运行用 tmux 包一层：tmux new -s omi -d 'omi serve && read'，之后 tmux kill-session -t omi。",
            en: "For background use, wrap it in tmux: tmux new -s omi -d 'omi serve && read', then tmux kill-session -t omi.",
          },
          {
            zh: "--model 传绝对路径，会同时设为活动模型；--engine 可选 llama.cpp / vllm / sglang / mlx。",
            en: "--model takes an absolute path and also sets it active; --engine accepts llama.cpp / vllm / sglang / mlx.",
          },
        ],
      },
    ],
  },
  {
    id: "models",
    titleZh: "模型：列出与加载",
    titleEn: "Models: list & load",
    descZh: "查看已装模型、切换活动模型、配置云端模型。",
    descEn: "Inspect installed models, switch the active model, configure cloud models.",
    entries: [
      {
        cmd: "omi models",
        zh: "一次列出本地已装模型（名称 / 大小 / 类型 / 是否活动）与云端模型。",
        en: "List installed local models (name, size, kind, active flag) together with cloud models.",
        examples: [{ cmd: "omi models", zh: "脚本里取模型名：与 omi model --list 等价。", en: "Same data as omi model --list, handy in scripts." }],
      },
      {
        cmd: "omi model",
        zh: "不带参数时在应用里打开模型列表下载 / 选择；--list 在终端打印；--select 用终端编号菜单选择并设为活动模型（会重启推理服务器）。",
        en: "With no flags it opens the model list in the app; --list prints in the terminal; --select picks from a numbered terminal menu and sets the model active (restarting the inference server).",
        examples: [
          { cmd: "omi model --list", zh: "终端里列出已装模型。", en: "List installed models in the terminal." },
          { cmd: "omi model --select", zh: "终端选择模型并立即生效。", en: "Pick a model in the terminal and apply it." },
        ],
      },
      {
        cmd: "omi model-info <名称|文件名|slug|路径>",
        zh: "模型详情：仓库、文件、服务名、路径、大小、类型、是否活动。",
        en: "Model details: repo, file, served name, path, size, kind, active flag.",
      },
      {
        cmd: "omi cloud --list  ·  omi cloud --set <provider> <endpoint> [models...]",
        zh: "查看 / 写入云端 OpenAI 兼容服务（写入 SERVER_MODE=remote、服务商、端点与模型列表）。不带参数时打开应用里的云端配置页。",
        en: "Inspect or write the cloud OpenAI-compatible provider (sets SERVER_MODE=remote, provider, endpoint and model list). With no flags it opens the cloud settings page in the app.",
        examples: [
          { cmd: "omi cloud --set deepseek https://api.deepseek.com/v1 deepseek-chat", zh: "接入 DeepSeek 云端模型。", en: "Configure a DeepSeek cloud model." },
        ],
      },
      {
        cmd: "omi serve --model <路径>  ·  omi launch <工具> --model <名称|路径|云端 id>",
        zh: "在启动服务器 / 启动编码工具时直接指定模型：已装模型名、文件名、绝对路径或云端模型 id 都可以。省略时会自动选（只有一个模型）或弹出选择。",
        en: "Pin the model while starting a server or a coding tool: an installed name, file name, absolute path or cloud model id all work. Omitted, omi auto-selects when there is exactly one model, otherwise it asks.",
      },
    ],
  },
  {
    id: "memory",
    titleZh: "记忆：写入、检索、接入",
    titleEn: "Memory: save, search, connect",
    descZh: "同一份长期记忆库的三条调用通道：CLI、MCP、网关 REST。",
    descEn: "Three ways into the same long-term memory store: CLI, MCP, and the gateway REST API.",
    entries: [
      {
        cmd: 'omi memory add "记住：我偏好用中文回答" [--category fact|preference|experience|skill|other] [--tags 偏好,中文]',
        zh: "写入一条记忆。这是外部 Agent 的写回通道，也是手工补录入口；内容重复时会合并（不会堆重复条目）。",
        en: "Save one memory — the write-back channel for external agents and a manual entry point. Duplicate content is merged instead of piling up.",
        examples: [
          {
            cmd: 'omi memory add "项目用 bun workspace，不要引入 pnpm" --category preference --tags build',
            zh: "带分类与标签写入。",
            en: "Save with a category and tags.",
          },
        ],
      },
      {
        cmd: 'omi memory search "关键词" [--limit 8]',
        zh: "检索记忆（默认 8 条，上限 20）。结果是排序过的：相关度为主，重要度与新鲜度加权，等价改写也能召回。",
        en: "Search memories (8 by default, max 20), ranked by relevance with importance and freshness weighting — paraphrases match too.",
      },
      {
        cmd: "omi memory list [--status active|pending|archived|all] [--limit n]",
        zh: "列出记忆，带编号、分类、状态、置顶与来源。默认不含「已被取代」的旧事实。",
        en: "List memories with id, category, status, pinned flag and source. Superseded entries are hidden by default.",
      },
      {
        cmd: "omi memory stats",
        zh: "记忆统计：条数分布（可用/待确认/归档/已取代）、分类分布、检索命中率、合并与敏感内容拦截次数、向量化进度。",
        en: "Memory stats: counts by status and category, search hit rate, merge and secret-block counts, embedding progress.",
      },
      {
        cmd: "omi memory maintain",
        zh: "整理记忆：合并历史遗留的近似重复、归档过期或长期未用的低价值记忆（不删除，可恢复）、补齐向量。应用启动时也会自动跑一次。",
        en: "Tidy the store: merge legacy near-duplicates, archive expired or long-unused low-value memories (never deleted, always restorable), backfill embeddings. Also runs automatically at app start.",
      },
      {
        cmd: "omi memory forget <id>",
        zh: "删除一条记忆（编号见 list / search）。用于撤回写错或已过时的内容。",
        en: "Delete one memory by id (from list / search) — retract wrong or outdated content.",
      },
      {
        cmd: "omi memory export [--out file.json]  ·  omi memory import <file.json>",
        zh: "导出全部记忆为 JSON，或从 JSON 导入：逐条判重合并，可安全重复执行（迁移 / 备份用）。",
        en: "Export all memories as JSON, or import from JSON with per-entry dedup and merge — safe to re-run (backup / migration).",
      },
      {
        cmd: "omi memory mcp",
        zh:
          "把同一个记忆库作为 stdio MCP 服务器（omni-memory）暴露给宿主 Agent，提供 memory_search / memory_save / memory_forget / memory_list 四个工具。" +
          "写入自动判重合并，可用 supersedes 取代过时记忆；应用在不在都能用：直连 SQLite，WAL 并发安全。",
        en:
          "Expose the same memory store as a stdio MCP server (omni-memory) with four tools: memory_search / memory_save / memory_forget / memory_list. " +
          "Writes are deduplicated and merged automatically, and supersedes retires outdated entries. Works with or without the app running, straight against SQLite (WAL-safe).",
        notes: [
          {
            zh: "omi launch 启动 Claude Code / Codex / OpenCode 时会自动写绝对路径并挂载它，多数情况下不用手配。",
            en: "omi launch writes the absolute-path config and mounts it for Claude Code / Codex / OpenCode automatically, so manual setup is rarely needed.",
          },
        ],
      },
      {
        cmd: "MEMORY_ENABLED=0  ·  MEMORY_REVIEW_MODE=1  ·  MEMORY_EMBEDDING_MODEL=<模型>",
        zh:
          "记忆开关：MEMORY_ENABLED=0 关闭全部记忆能力（不注入上下文文件、不挂 MCP、内置 Agent 不读写）；" +
          "MEMORY_REVIEW_MODE=1 让 Agent / CLI / MCP 的写入先落「待确认」，在记忆页批准后才生效；" +
          "配置 MEMORY_EMBEDDING_MODEL（可加 MEMORY_EMBEDDING_BASE / _API_KEY）后启用向量检索，语义相近的改写也能召回。",
        en:
          "Memory switches: MEMORY_ENABLED=0 disables everything (no context injection, no MCP, no agent reads or writes); " +
          "MEMORY_REVIEW_MODE=1 makes agent / CLI / MCP writes land as pending until approved in the Memory view; " +
          "set MEMORY_EMBEDDING_MODEL (plus MEMORY_EMBEDDING_BASE / _API_KEY) to enable vector retrieval so paraphrases match.",
      },
    ],
  },
  {
    id: "code",
    titleZh: "启动编码工具（加载 code）",
    titleEn: "Launch coding tools",
    descZh: "一条命令把 Claude Code / Codex / OpenCode 等接到当前模型。",
    descEn: "Point Claude Code, Codex, OpenCode and friends at your current model with one command.",
    entries: [
      {
        cmd: "omi launch <工具> [--model <名称|路径|云端 id>] [-- 工具参数...]",
        zh:
          "启动编码工具并接入当前模型。执行顺序：确认应用在运行 → 选模型 → 需要时启动 / 重启本地推理服务器 → 确保 API 网关在线 → " +
          "写各工具自己的配置（保留用户原有配置）→ 注入共享记忆 → 前台拉起工具。",
        en:
          "Launch a coding tool against the current model. Order of operations: make sure the app runs → pick the model → start or restart the local server if needed → ensure the API gateway is up → " +
          "write each tool's own config (preserving the user's existing settings) → inject shared memory → hand the terminal over to the tool.",
        notes: [
          { zh: "工具参数用 `--` 透传，例如 omi launch claude -- --resume。", en: "Pass tool arguments after `--`, e.g. omi launch claude -- --resume." },
          { zh: "本地模型走本地推理服务器，云端 id 走云端 API；网关负责 Anthropic ↔ OpenAI 协议翻译。", en: "Local models go to the local server, cloud ids to the cloud API; the gateway translates Anthropic ↔ OpenAI." },
        ],
        examples: [
          { cmd: "omi launch --list", zh: "列出支持的工具与各自的协议。", en: "List supported tools and their protocols." },
          { cmd: "omi launch claude", zh: "唯一模型时自动选中并启动 Claude Code。", en: "Auto-select the only model and start Claude Code." },
          { cmd: "omi launch claude --opus <模型> --haiku <模型>", zh: "Claude Code 三个档位分别指定模型。", en: "Give Claude Code's three tiers separate models." },
          { cmd: "omi launch codex --model qwen3-4b-q4_k_m", zh: "按服务名指定模型。", en: "Pick the model by served name." },
          { cmd: "omi launch opencode", zh: "opencode 走内联 provider 配置，不改用户的全局配置。", en: "opencode uses inline provider config, leaving global config untouched." },
        ],
      },
      {
        cmd: "omi launch claude  ·  codex  ·  opencode  ·  openclaw  ·  hermes  ·  pi  ·  copilot  ·  chatgpt",
        zh:
          "接入方式各自不同：claude 走环境变量（ANTHROPIC_*）并附带 --mcp-config；codex / chatgpt 写 ~/.codex 的 profile 与模型目录；" +
          "opencode 用 OPENCODE_CONFIG_CONTENT；openclaw 写 ~/.openclaw/openclaw.json；hermes 写 ~/.hermes/config.yaml；pi 写 ~/.pi/agent/*.json；copilot 走环境变量。",
        en:
          "Each tool is wired differently: claude via environment (ANTHROPIC_*) plus --mcp-config; codex / chatgpt write a ~/.codex profile and model catalog; " +
          "opencode uses OPENCODE_CONFIG_CONTENT; openclaw writes ~/.openclaw/openclaw.json; hermes writes ~/.hermes/config.yaml; pi writes ~/.pi/agent/*.json; copilot uses environment variables.",
        notes: [
          {
            zh: "chatgpt 会改写 ~/.codex/config.toml（首次改写前备份到 ~/.codex/backup-omni/config.toml），然后打开桌面客户端；请先完全退出 ChatGPT（⌘Q）再让它重读配置。",
            en: "chatgpt rewrites ~/.codex/config.toml (backed up to ~/.codex/backup-omni/config.toml on first write) and opens the desktop app; quit ChatGPT fully (⌘Q) so it re-reads the config.",
          },
          {
            zh: "每次启动的模型 / 端点记录在 ~/.omni/launcher/<工具>.json，方便排查。",
            en: "Every launch records model and endpoint in ~/.omni/launcher/<tool>.json for troubleshooting.",
          },
        ],
      },
    ],
  },
  {
    id: "engine",
    titleZh: "引擎依赖、版本与手册",
    titleEn: "Engine deps, version, manual",
    descZh: "排查引擎二进制、检查更新、随时打印完整手册。",
    descEn: "Check engine binaries, look for updates, print the full manual.",
    entries: [
      {
        cmd: "omi install",
        zh: "检查 llama.cpp / vLLM / SGLang / MLX 是否可用，缺失时给出对应安装命令（MLX 只在 macOS 列出）。",
        en: "Check llama.cpp / vLLM / SGLang / MLX availability and print install commands for what is missing (MLX is macOS-only).",
      },
      {
        cmd: "omi version  ·  omi update",
        zh: "显示版本；检查 GitHub Releases 是否有新版本。",
        en: "Show the version; check GitHub Releases for updates.",
      },
      {
        cmd: "omi guide [--md] [--json] [--lang en]",
        zh: "打印这份完整手册：默认纯文本，--md 输出 Markdown，--json 输出结构化数据，--lang en 输出英文。",
        en: "Print this manual: plain text by default, --md for Markdown, --json for structured data, --lang en for English.",
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// 记忆接入片段（设置页 / 手册共用的可复制配置）
// ---------------------------------------------------------------------------

export const CLI_MEMORY_SNIPPETS: CliSnippet[] = [
  {
    id: "claude",
    titleZh: "Claude Code",
    titleEn: "Claude Code",
    descZh: "写进项目或用户的 MCP 配置即可；用 omi launch claude 启动时会自动带上等价配置。",
    descEn: "Drop into your project or user MCP config; omi launch claude passes the equivalent config automatically.",
    language: "json",
    code: `{
  "mcpServers": {
    "omni-memory": {
      "command": "omi",
      "args": ["memory", "mcp"]
    }
  }
}`,
  },
  {
    id: "codex",
    titleZh: "Codex / ChatGPT",
    titleEn: "Codex / ChatGPT",
    descZh: "追加到 ~/.codex/config.toml；omi launch codex 会把绝对路径写进 omni-launch profile。",
    descEn: "Append to ~/.codex/config.toml; omi launch codex writes the absolute path into the omni-launch profile.",
    language: "toml",
    code: `[mcp_servers.omni-memory]
command = "omi"
args = ["memory", "mcp"]`,
  },
  {
    id: "opencode",
    titleZh: "opencode",
    titleEn: "opencode",
    descZh: "加入 opencode.json 的顶层 mcp 字段（omi launch opencode 默认已挂载）。",
    descEn: "Add to the top-level mcp field of opencode.json (omi launch opencode mounts it by default).",
    language: "json",
    code: `{
  "mcp": {
    "omni-memory": {
      "type": "local",
      "command": ["omi", "memory", "mcp"],
      "enabled": true
    }
  }
}`,
  },
  {
    id: "http",
    titleZh: "任意 MCP 客户端（HTTP）",
    titleEn: "Any MCP client (HTTP)",
    descZh:
      "应用在运行时，网关同时提供 Streamable HTTP 的 MCP 服务端（知识库 kb_search / kb_list + 记忆 memory_*）。" +
      "设置了网关 Key 时需带 Authorization 头；浏览器打开同一地址可进入调试工作台。",
    descEn:
      "While the app runs, the gateway also serves MCP over Streamable HTTP (knowledge base kb_search / kb_list plus memory_*). " +
      "When a gateway key is set, send the Authorization header; opening the same URL in a browser gives you the debug playground.",
    language: "json",
    code: `{
  "mcpServers": {
    "omni-gateway": {
      "type": "http",
      "url": "{{GATEWAY_URL}}/mcp",
      "headers": { "Authorization": "Bearer {{GATEWAY_KEY}}" }
    }
  }
}`,
  },
  {
    id: "rest",
    titleZh: "REST（脚本 / 服务）",
    titleEn: "REST (scripts & services)",
    descZh: "网关另有 Mem0 风格的记忆接口，任何程序都能读写同一份记忆库。",
    descEn: "The gateway also exposes a Mem0-style memory API so any program can read and write the same store.",
    language: "bash",
    code: `# 检索
curl "{{GATEWAY_URL}}/v1/memories?q=关键词&limit=5" \\
  -H "Authorization: Bearer {{GATEWAY_KEY}}"

# 写入
curl -X POST "{{GATEWAY_URL}}/v1/memories" \\
  -H "Authorization: Bearer {{GATEWAY_KEY}}" \\
  -H "Content-Type: application/json" \\
  -d '{"content":"偏好用中文回答","category":"preference","tags":["偏好"]}'`,
  },
];

/** 手册用到的服务地址默认值（与设置键一致）。 */
export const CLI_DEFAULT_GATEWAY_URL = "http://127.0.0.1:10000";
export const CLI_DEFAULT_SERVER_URL = "http://127.0.0.1:8080";

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

/** `omi guide` 的纯文本输出。 */
export function cliDocText(lang: CliLang = "zh"): string {
  const L = (zh: string, en: string) => (lang === "zh" ? zh : en);
  const out: string[] = [];
  out.push(L(CLI_DOC_TITLE.zh, CLI_DOC_TITLE.en));
  out.push("");
  out.push(L(CLI_DOC_INTRO.zh, CLI_DOC_INTRO.en));
  for (const section of CLI_SECTIONS) {
    out.push("");
    out.push(`── ${L(section.titleZh, section.titleEn)} ${"─".repeat(2)}`);
    out.push(`   ${L(section.descZh, section.descEn)}`);
    for (const entry of section.entries) {
      out.push("");
      out.push(`  ${entry.cmd}`);
      out.push(`      ${L(entry.zh, entry.en)}`);
      for (const note of entry.notes ?? []) out.push(`      · ${L(note.zh, note.en)}`);
      for (const example of entry.examples ?? []) {
        out.push(`      $ ${example.cmd}`);
        out.push(`        ${L(example.zh, example.en)}`);
      }
    }
  }
  out.push("");
  out.push(`── ${L("记忆接入片段", "Memory wiring snippets")}`);
  for (const snippet of CLI_MEMORY_SNIPPETS) {
    out.push("");
    out.push(`  ${L(snippet.titleZh, snippet.titleEn)} — ${L(snippet.descZh, snippet.descEn)}`);
    for (const line of snippet.code.split("\n")) out.push(`      ${line}`);
  }
  out.push("");
  out.push(
    L(
      "更多：omi help <命令> 看单命令用法；文档 docs/omi-cli.md（本手册由 `omi guide --md` 生成）。",
      "More: omi help <command> for a single command; docs at docs/omi-cli.md (generated by `omi guide --md`).",
    ),
  );
  return out.join("\n");
}

/** `omi guide --md` 的 Markdown 输出，同时是 docs/omi-cli.md 的正文。 */
export function cliDocMarkdown(lang: CliLang = "zh"): string {
  const L = (zh: string, en: string) => (lang === "zh" ? zh : en);
  const out: string[] = [];
  out.push(`# ${L(CLI_DOC_TITLE.zh, CLI_DOC_TITLE.en)}`);
  out.push("");
  out.push(L(CLI_DOC_INTRO.zh, CLI_DOC_INTRO.en));
  for (const section of CLI_SECTIONS) {
    out.push("");
    out.push(`## ${L(section.titleZh, section.titleEn)}`);
    out.push("");
    out.push(L(section.descZh, section.descEn));
    for (const entry of section.entries) {
      out.push("");
      out.push("```bash");
      out.push(entry.cmd);
      out.push("```");
      out.push("");
      out.push(L(entry.zh, entry.en));
      for (const note of entry.notes ?? []) out.push(`- ${L(note.zh, note.en)}`);
      if (entry.examples?.length) {
        out.push("");
        for (const example of entry.examples) {
          out.push(`\`${example.cmd}\` — ${L(example.zh, example.en)}`);
        }
      }
    }
  }
  out.push("");
  out.push(`## ${L("记忆接入片段", "Memory wiring snippets")}`);
  for (const snippet of CLI_MEMORY_SNIPPETS) {
    out.push("");
    out.push(`### ${L(snippet.titleZh, snippet.titleEn)}`);
    out.push("");
    out.push(L(snippet.descZh, snippet.descEn));
    out.push("");
    out.push(`\`\`\`${snippet.language}`);
    out.push(snippet.code);
    out.push("```");
  }
  out.push("");
  out.push("---");
  out.push("");
  out.push(
    L(
      "本手册由 `omi guide --md` 生成（源数据：`apps/studio/src/shared/cli-docs.ts`）；设置页「工具 → 命令行」有同内容的可视化版本。",
      "Generated by `omi guide --md` (source: `apps/studio/src/shared/cli-docs.ts`); the in-app Settings → Tools → Command line page renders the same data.",
    ),
  );
  out.push("");
  return out.join("\n");
}

/** `omi guide --json`：给脚本 / 后续工具用的结构化数据。 */
export function cliDocJson() {
  return JSON.stringify(
    {
      title: CLI_DOC_TITLE,
      intro: CLI_DOC_INTRO,
      sections: CLI_SECTIONS,
      snippets: CLI_MEMORY_SNIPPETS,
    },
    null,
    2,
  );
}
