import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { homedir } from "os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ParsedArgs } from "../args";
import { optBool, optString } from "../args";
import { controlRequest, ensureAppRunning } from "../client";
import {
  getAllSettingsFallback,
  setActiveModelFallback,
  updateSettingsFallback,
} from "../db";
import { formatBytes, slugModelFileName } from "../format";
import { pickNumbered } from "../tui";
import { getInstalledModels } from "./models";
import { DEFAULT_INFERENCE_PORT } from "../../shared/server-info";
import { resolveDataDir } from "../data-dir";

type ToolKind = "anthropic" | "openai" | "generic";

const TOOL_SPECS: Record<string, ToolKind> = {
  claude: "anthropic",
  codex: "openai",
  opencode: "openai",
  openclaw: "openai",
  copilot: "openai",
  hermes: "generic",
  pi: "generic",
};

/** 工具 → 设置键（把选中的模型写回设置，GUI 设置页能看到）。 */
const TOOL_SETTING_KEY: Record<string, string> = {
  claude: "LAUNCHER_CLAUDE_SONNET",
  codex: "LAUNCHER_CODEX_MODEL",
  opencode: "LAUNCHER_OPENCODE_MODEL",
  openclaw: "LAUNCHER_OPENCLAW_MODEL",
  hermes: "LAUNCHER_HERMES_MODEL",
  pi: "LAUNCHER_PI_MODEL",
  copilot: "LAUNCHER_COPILOT_MODEL",
};

const LAUNCHER_CONFIG_DIR = join(homedir(), ".omni", "launcher");

/** 控制通道 gatewayStatus / gatewayStart 返回的网关信息（真实绑定端口可能回退）。 */
type GatewayStatusData = {
  status: string;
  host: string;
  port: number;
  url: string;
  notice?: string;
};

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 记忆注入：启动时刷新目标工具上下文文件里的托管区块（Agent 自动读到），
// 并给支持 MCP 的工具挂上 omni-memory 服务器（Agent 可用 memory_save 实时写回）。
// ---------------------------------------------------------------------------

/** MCP 桥接进程的启动描述：用绝对路径（bun + omi 入口脚本），不依赖 PATH。 */
function omniMemoryMcpSpec(): { command: string; args: string[] } {
  return { command: process.execPath, args: [Bun.main, "memory", "mcp"] };
}

/** 刷新工具上下文文件（CLAUDE.md / AGENTS.md）的记忆区块。独立进程直读主库。 */
async function injectMemoryContext(tool: string): Promise<void> {
  try {
    process.env.OMNI_DATA_DIR ??= resolveDataDir();
    const { syncMemoryToTools, MEMORY_SYNC_TARGETS } = await import("../../bun/memory-sync");
    if (!MEMORY_SYNC_TARGETS.some((t) => t.tool === tool)) return;
    const results = syncMemoryToTools([tool]);
    if (results[0]?.ok) console.log("已同步共享记忆到工具上下文文件（写回：omi memory add / omni-memory MCP）。");
  } catch {
    // 记忆注入失败不阻塞启动
  }
}

/** claude：--mcp-config 指向常驻配置文件（每次启动覆盖写，保持最新）。 */
function writeClaudeMcpConfig(): string {
  const spec = omniMemoryMcpSpec();
  mkdirSync(LAUNCHER_CONFIG_DIR, { recursive: true });
  const file = join(LAUNCHER_CONFIG_DIR, "claude-mcp.json");
  writeFileSync(
    file,
    JSON.stringify(
      { mcpServers: { "omni-memory": { command: spec.command, args: spec.args } } },
      null,
      2,
    ),
  );
  return file;
}

export async function cmdLaunch(parsed: ParsedArgs) {
  if (optBool(parsed.options, "list")) {
    console.log("可用编码工具：");
    for (const [tool, kind] of Object.entries(TOOL_SPECS)) {
      const protocol = kind === "anthropic" ? "Anthropic" : kind === "openai" ? "OpenAI" : "CLI";
      console.log(`  ${tool.padEnd(10)} ${protocol} 兼容`);
    }
    return;
  }

  const tool = parsed.positionals[0];
  if (!tool) {
    fail(
      `缺少工具名。可用：${Object.keys(TOOL_SPECS).join(" / ")}\n运行 'omi launch --list' 查看详情。`,
    );
  }
  const kind = TOOL_SPECS[tool];
  if (!kind) {
    fail(`未知工具「${tool}」。可用：${Object.keys(TOOL_SPECS).join(" / ")}`);
  }

  // 1. 确保应用在运行（读配置 / 起服务器都要走控制通道）。
  const connected = await ensureAppRunning({ appPath: optString(parsed.options, "app-path") });

  // 2. 读取设置（网关地址 / 鉴权）。
  const settings = connected
    ? (await controlRequest("getSettings", undefined, 15_000)).data ?? {}
    : await getAllSettingsFallback();

  // 3. 选模型（可能改活动模型 → 变更会触发本地服务器重启）。
  const model = await resolveModel(parsed, connected);

  // 端点由「选中的模型」决定而不是 SERVER_MODE：本地模型 → 本地推理服务器，
  // 云端模型 ID → 云端 API。集成页选的就是模型名，本地模型绝不该发到云端。
  const modelIsLocal = !!model.path;
  const cloudBase = (settings.VLLM_API_BASE ?? "").replace(/\/+$/, "").replace(/\/v1$/, "");
  const baseUrl = modelIsLocal
    ? `http://${settings.SERVER_HOST || "127.0.0.1"}:${settings.SERVER_PORT || DEFAULT_INFERENCE_PORT}`
    : cloudBase;
  const apiKey = modelIsLocal ? "EMPTY" : (settings.VLLM_API_KEY || "EMPTY");
  if (!modelIsLocal && !cloudBase) fail("云端模型需要先配置云端 API：`omi cloud --set ...`");

  // 统一走本地 API 网关：网关负责协议翻译（Anthropic ↔ OpenAI）并按模型 ID 路由本地/云端。
  // 网关可能因配置端口被占用而回退到下一个空闲端口（如 10000 被其它程序占用 → 10001），
  // 所以以控制通道返回的真实 URL 为准，而不是设置里的 GATEWAY_PORT；未连接时回退设置值。
  let gatewayBase = `http://${settings.GATEWAY_HOST || "127.0.0.1"}:${Number(settings.GATEWAY_PORT || 10000) || 10000}`;
  let gatewayNotice = "";
  if (connected) {
    const g = await controlRequest("gatewayStatus", undefined, 10_000);
    const gw = (g.ok ? g.data : undefined) as GatewayStatusData | undefined;
    if (gw?.url) gatewayBase = gw.url;
    if (gw?.notice) gatewayNotice = gw.notice;
    if (gw && gw.status !== "running") {
      console.log("API 网关未运行，正在启动…");
      const started = await controlRequest("gatewayStart", undefined, 15_000);
      const startGw = (started.ok ? started.data : undefined) as GatewayStatusData | undefined;
      if (startGw?.url) gatewayBase = startGw.url;
      if (startGw?.notice) gatewayNotice = startGw.notice;
    }
  }
  const gatewayKey = ((settings.GATEWAY_API_KEY as string | undefined) ?? "").trim();
  const agentKey = gatewayKey || apiKey;

  // 4. 本地模型：确保推理服务器在线且加载的就是选中的模型（与 SERVER_MODE 无关）。
  if (modelIsLocal) {
    if (connected) {
      const st = await controlRequest("status", undefined, 10_000);
      if (st.ok && st.data?.server?.status === "running") {
        if (model.changed) {
          console.log("活动模型已变更，正在重启推理服务器…");
          const restarted = await controlRequest("serverRestart", undefined, 120_000);
          if (!restarted.ok) fail(restarted.error ?? "重启推理服务器失败");
        }
      } else {
        console.log("推理服务器未运行，正在启动…");
        const started = await controlRequest("serverStart", undefined, 120_000);
        if (!started.ok) fail(started.error ?? "启动推理服务器失败");
      }
    } else {
      console.log("提示：应用未运行，无法确保推理服务器在线。请先运行 `omi start --server`。");
    }
  }

  // 5. 写配置：把模型写回设置（GUI 集成页可见）+ 本地配置文件。
  const settingKey = TOOL_SETTING_KEY[tool];
  const opusModel = optString(parsed.options, "opus");
  const haikuModel = optString(parsed.options, "haiku");
  if (settingKey) {
    const patch: Record<string, string> = { [settingKey]: model.name };
    if (tool === "claude") {
      patch.LAUNCHER_CLAUDE_MODE = modelIsLocal ? "local" : "cloud";
      if (opusModel) patch.LAUNCHER_CLAUDE_OPUS = opusModel;
      if (haikuModel) patch.LAUNCHER_CLAUDE_HAIKU = haikuModel;
    }
    if (connected) {
      await controlRequest("updateSettings", { settings: patch }, 15_000);
    } else {
      await updateSettingsFallback(patch);
    }
  }
  writeToolConfig(tool, model.name, baseUrl);

  // 记忆总开关开启时：刷新上下文区块 + 给支持 MCP 的工具挂 omni-memory（写回通道）。
  const memoryOn = (settings.MEMORY_ENABLED ?? "1") !== "0";
  if (memoryOn) await injectMemoryContext(tool);

  console.log(
    `启动 ${tool}（模型：${model.name}，接口：${gatewayBase}${agentKey ? "，已鉴权" : ""}）` +
      (gatewayNotice ? `\n提示：${gatewayNotice}` : ""),
  );

  // 6. 构造环境变量 / 参数并拉起工具。
  const toolBin = tool === "claude" ? "claude" : tool;
  const binPath = Bun.which(toolBin);
  if (!binPath) {
    fail(
      `未找到可执行文件「${toolBin}」。请先安装该工具（npx/brew），或确认它已在 PATH 中。`,
    );
  }

  const env: Record<string, string> = {};
  const extraArgs: string[] = [...parsed.rest];

  // 每个 Agent 按自己的方式指向本机端点：能走配置文件的写配置文件（保留用户原有配置），
  // 其余的用各自约定的环境变量。整体照搬 Ollama `launch <agent>` 的设计。
  switch (tool) {
    case "claude": {
      env.ANTHROPIC_BASE_URL = gatewayBase;
      env.ANTHROPIC_API_KEY = "";
      env.ANTHROPIC_AUTH_TOKEN = agentKey;
      env.ANTHROPIC_MODEL = model.name;
      // 所有档位（Opus/Sonnet/Haiku/子智能体）都指向该模型；--opus / --haiku 可单独覆盖。
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = opusModel ?? model.name;
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = model.name;
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = haikuModel ?? model.name;
      env.CLAUDE_CODE_SUBAGENT_MODEL = model.name;
      // 关掉遥测/反馈提示（照搬 Ollama launch claude）。
      env.CLAUDE_CODE_ATTRIBUTION_HEADER = "0";
      env.CLAUDE_CODE_TOTAL_TOKENS_REMINDER = "off";
      env.DISABLE_ERROR_REPORTING = "1";
      env.DISABLE_FEEDBACK_COMMAND = "1";
      env.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY = "1";
      extraArgs.unshift("--model", model.name);
      if (memoryOn) {
        // 挂载 omni-memory MCP：Claude Code 会话里可直接 memory_search / memory_save。
        extraArgs.unshift("--mcp-config", writeClaudeMcpConfig());
      }
      break;
    }
    case "codex": {
      configureCodex(`${gatewayBase}/v1/`, model.name, memoryOn);
      env.OPENAI_API_KEY = agentKey;
      extraArgs.unshift("--profile", CODEX_PROFILE_NAME, "-m", model.name);
      break;
    }
    case "opencode": {
      env.OPENCODE_CONFIG_CONTENT = buildOpenCodeConfig(`${gatewayBase}/v1`, agentKey, model.name, memoryOn);
      writeOpenCodeState(model.name);
      break;
    }
    case "openclaw": {
      configureOpenClaw(`${gatewayBase}/v1`, agentKey, model.name);
      if (extraArgs.length === 0) extraArgs.unshift("tui");
      break;
    }
    case "copilot": {
      env.COPILOT_PROVIDER_BASE_URL = `${gatewayBase}/v1`;
      env.COPILOT_PROVIDER_API_KEY = agentKey;
      env.COPILOT_PROVIDER_WIRE_API = "responses";
      env.COPILOT_MODEL = model.name;
      extraArgs.unshift("--model", model.name);
      break;
    }
    case "pi": {
      await configurePiProvider(`${gatewayBase}/v1`, agentKey, model.name);
      extraArgs.unshift("--provider", PI_PROVIDER_NAME, "--model", model.name);
      break;
    }
    case "hermes": {
      await configureHermesProvider(`${gatewayBase}/v1`, agentKey, model.name);
      extraArgs.unshift("--model", model.name);
      break;
    }
    default:
      fail(`未知工具「${tool}」。可用：${Object.keys(TOOL_SPECS).join(" / ")}`);
  }

  console.log(`\n$ ${tool} ${extraArgs.join(" ")}`.trimEnd());
  const proc = Bun.spawn([binPath, ...extraArgs], {
    env: { ...process.env, ...env },
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.exit((await proc.exited) ?? 0);
}

/** 把本次启动参数记到 ~/.omni/launcher/<tool>.json（“写配置文件”）。 */
function writeToolConfig(tool: string, model: string, baseUrl: string): void {
  try {
    mkdirSync(LAUNCHER_CONFIG_DIR, { recursive: true });
    writeFileSync(
      join(LAUNCHER_CONFIG_DIR, `${tool}.json`),
      JSON.stringify(
        { tool, model, baseUrl, updatedAt: new Date().toISOString() },
        null,
        2,
      ),
    );
  } catch {
    // 写配置文件失败不阻塞启动
  }
}

function readJSONFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJSONFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

/** pi 的 managed provider 名（写在 ~/.pi/agent/models.json 里，不碰用户自建 provider）。 */
const PI_CONFIG_DIR = join(homedir(), ".pi", "agent");
const PI_MODELS_FILE = join(PI_CONFIG_DIR, "models.json");
const PI_SETTINGS_FILE = join(PI_CONFIG_DIR, "settings.json");
const PI_PROVIDER_NAME = "omni";

/**
 * 把端点和模型注册进 pi 的 provider 配置（照搬 Ollama launch pi 的做法）：
 * - models.json：providers.omni 写 baseUrl/api/models；launch 管理的模型带 `_launch` 标记，
 *   用户手写的模型（无标记）原样保留；
 * - settings.json：defaultProvider/defaultModel 指向 omni 与本次模型，之后裸 `pi` 也能直接用。
 */
async function configurePiProvider(baseURL: string, apiKey: string, model: string): Promise<void> {
  const config = readJSONFile<Record<string, any>>(PI_MODELS_FILE) ?? {};
  const providers = (config.providers as Record<string, any> | undefined) ?? {};
  const provider = (providers[PI_PROVIDER_NAME] as Record<string, any> | undefined) ?? {};

  provider.baseUrl = baseURL;
  provider.api = provider.api ?? "openai-completions";
  provider.apiKey = apiKey;

  const existing = Array.isArray(provider.models) ? (provider.models as any[]) : [];
  // 保留用户自建的模型（无 _launch 标记），替换/新增 launch 管理的这条。
  const userModels = existing.filter((m) => m?._launch !== true);
  const base = userModels.filter((m) => m?.id !== model);
  base.push({ id: model, _launch: true, input: ["text"], reasoning: false });
  provider.models = base;

  providers[PI_PROVIDER_NAME] = provider;
  config.providers = providers;
  writeJSONFile(PI_MODELS_FILE, config);

  const settings = readJSONFile<Record<string, any>>(PI_SETTINGS_FILE) ?? {};
  settings.defaultProvider = PI_PROVIDER_NAME;
  settings.defaultModel = model;
  writeJSONFile(PI_SETTINGS_FILE, settings);
}

/** hermes 的 managed provider 键（写在 ~/.hermes/config.yaml 里）。 */
const HERMES_CONFIG_FILE = join(homedir(), ".hermes", "config.yaml");
const HERMES_PROVIDER_KEY = "omni-launch";

/**
 * 把端点与模型写进 hermes 的 config.yaml（照搬 Ollama launch hermes 的做法）：
 * model.provider/default/base_url/api_key 指向 managed provider，providers 里登记端点，
 * 之后 `hermes` 会按这个默认模型走自定义端点。
 */
async function configureHermesProvider(
  baseURL: string,
  apiKey: string,
  model: string,
): Promise<void> {
  let cfg: Record<string, any> = {};
  try {
    const parsed = parseYaml(readFileSync(HERMES_CONFIG_FILE, "utf8"));
    if (parsed && typeof parsed === "object") cfg = parsed as Record<string, any>;
  } catch {
    // 配置不存在或不可解析时从空开始
  }

  const modelSection = (cfg.model as Record<string, any> | undefined) ?? {};
  modelSection.provider = HERMES_PROVIDER_KEY;
  modelSection.default = model;
  modelSection.base_url = baseURL;
  modelSection.api_key = apiKey;
  cfg.model = modelSection;

  const providers = (cfg.providers as Record<string, any> | undefined) ?? {};
  providers[HERMES_PROVIDER_KEY] = {
    name: "OmniStudio",
    api: baseURL,
    default_model: model,
    models: [model],
  };
  cfg.providers = providers;

  // 清掉 managed 的自定义 provider 条目，避免与 providers 重复；用户自建的其他条目保留。
  const customProviders = (cfg.custom_providers as Record<string, any> | undefined) ?? {};
  delete customProviders[HERMES_PROVIDER_KEY];
  if (Object.keys(customProviders).length === 0) delete cfg.custom_providers;
  else cfg.custom_providers = customProviders;

  mkdirSync(dirname(HERMES_CONFIG_FILE), { recursive: true });
  writeFileSync(HERMES_CONFIG_FILE, stringifyYaml(cfg));
}

/** codex：写 model.json 模型目录 + omni-launch.config.toml profile（照搬 Ollama launch codex）。 */
const CODEX_DIR = join(homedir(), ".codex");
const CODEX_PROFILE_NAME = "omni-launch";

function configureCodex(baseURL: string, model: string, memoryOn: boolean): void {
  mkdirSync(CODEX_DIR, { recursive: true });

  const catalogPath = join(CODEX_DIR, "model.json");
  const catalog = {
    models: [
      {
        slug: model,
        display_name: model,
        context_window: 128_000,
        shell_type: "default",
        visibility: "list",
        supported_in_api: true,
        priority: 0,
        truncation_policy: { mode: "tokens", limit: 10000 },
        input_modalities: ["text"],
        base_instructions: "",
        support_verbosity: true,
        default_verbosity: "low",
        supports_parallel_tool_calls: false,
        supported_reasoning_levels: [],
        experimental_supported_tools: [],
      },
    ],
  };
  writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));

  const profilePath = join(CODEX_DIR, `${CODEX_PROFILE_NAME}.config.toml`);
  const textLines = [
    `model = ${JSON.stringify(model)}`,
    `model_provider = ${JSON.stringify(CODEX_PROFILE_NAME)}`,
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    "",
    `[model_providers.${CODEX_PROFILE_NAME}]`,
    `name = ${JSON.stringify("OmniStudio")}`,
    `base_url = ${JSON.stringify(baseURL)}`,
    `wire_api = "responses"`,
    "",
  ];
  if (memoryOn) {
    const spec = omniMemoryMcpSpec();
    textLines.push(
      `[mcp_servers.omni-memory]`,
      `command = ${JSON.stringify(spec.command)}`,
      `args = ${JSON.stringify(spec.args)}`,
      "",
    );
  }
  writeFileSync(profilePath, textLines.join("\n"));
}

/** opencode：内联 provider 配置走 OPENCODE_CONFIG_CONTENT，模型注册进状态文件（照搬 Ollama）。 */
function buildOpenCodeConfig(baseURL: string, apiKey: string, model: string, memoryOn: boolean): string {
  const options: Record<string, string> = { baseURL };
  if (apiKey && apiKey !== "EMPTY") options.apiKey = apiKey;
  const spec = omniMemoryMcpSpec();
  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      omni: {
        npm: "@ai-sdk/openai-compatible",
        name: "OmniStudio",
        options,
        models: { [model]: { name: model } },
      },
    },
    model: `omni/${model}`,
  };
  if (memoryOn) {
    config.mcp = {
      "omni-memory": { type: "local", command: [spec.command, ...spec.args], enabled: true },
    };
  }
  return JSON.stringify(config);
}

function writeOpenCodeState(model: string): void {
  const statePath = join(homedir(), ".local", "state", "opencode", "model.json");
  const state = readJSONFile<Record<string, any>>(statePath) ?? { recent: [], favorite: [], variant: {} };
  const recent = Array.isArray(state.recent) ? (state.recent as any[]) : [];
  const deduped = recent.filter((e) => !(e?.providerID === "omni" && e?.modelID === model));
  state.recent = [{ providerID: "omni", modelID: model }, ...deduped].slice(0, 10);
  writeJSONFile(statePath, state);
}

/** openclaw：写 models.providers.omni + agents.defaults.model.primary（照搬 Ollama launch openclaw）。 */
const OPENCLAW_CONFIG_FILE = join(homedir(), ".openclaw", "openclaw.json");
const OPENCLAW_PROVIDER = "omni";

function configureOpenClaw(baseURL: string, apiKey: string, model: string): void {
  const config = readJSONFile<Record<string, any>>(OPENCLAW_CONFIG_FILE) ?? {};
  const modelsSection = (config.models as Record<string, any> | undefined) ?? {};
  const providers = (modelsSection.providers as Record<string, any> | undefined) ?? {};
  const provider = (providers[OPENCLAW_PROVIDER] as Record<string, any> | undefined) ?? {};

  provider.baseUrl = baseURL;
  provider.apiKey = apiKey;
  // openclaw 的 provider.api 是枚举：只认 openai-completions / openai-responses 等，
  // 写裸 "openai" 会直接拒绝启动（Config invalid）。
  provider.api = "openai-completions";
  provider.models = [
    {
      id: model,
      name: model,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  ];
  providers[OPENCLAW_PROVIDER] = provider;
  modelsSection.providers = providers;
  config.models = modelsSection;

  const agents = (config.agents as Record<string, any> | undefined) ?? {};
  const defaults = (agents.defaults as Record<string, any> | undefined) ?? {};
  const modelConfig = (defaults.model as Record<string, any> | undefined) ?? {};
  modelConfig.primary = `${OPENCLAW_PROVIDER}/${model}`;
  defaults.model = modelConfig;
  agents.defaults = defaults;
  config.agents = agents;

  writeJSONFile(OPENCLAW_CONFIG_FILE, config);
}

async function resolveModel(
  parsed: ParsedArgs,
  connected: boolean,
): Promise<{ name: string; path?: string; changed: boolean }> {
  const flag = optString(parsed.options, "model");
  const installed = await getInstalledModels();

  if (flag) {
    if (existsSync(flag)) {
      const active = installed.some((m) => m.path === flag && m.isActive);
      await setActive(connected, flag);
      return { name: slugModelFileName(basename(flag)), path: flag, changed: !active };
    }
    const match = installed.find(
      (m) => m.servedName === flag || m.fileName === flag || m.repo === flag,
    );
    if (match) {
      await setActive(connected, match.path);
      return {
        name: match.servedName || match.fileName,
        path: match.path,
        changed: !match.isActive,
      };
    }
    // 云端模型 ID 透传
    const cloud = await cloudModelIds();
    if (cloud.includes(flag)) return { name: flag, changed: false };
    fail(`未找到模型「${flag}」。运行 \`omi models\` 查看已装模型。`);
  }

  // 只有一个模型时自动选中（omlx 行为）
  if (installed.length === 1) {
    const only = installed[0]!;
    return { name: only.servedName || only.fileName, path: only.path, changed: false };
  }

  if (installed.length > 0 && process.stdin.isTTY) {
    const pick = await pickNumbered(
      "选择模型：",
      installed.map((m) => ({
        label: m.servedName || m.fileName,
        value: m.path,
        dim: `${formatBytes(m.size)} · ${m.category}`,
      })),
    );
    if (!pick) {
      console.log("已取消。");
      process.exit(0);
    }
    const chosen = installed.find((m) => m.path === pick)!;
    await setActive(connected, pick);
    return { name: chosen.servedName || chosen.fileName, path: pick, changed: !chosen.isActive };
  }

  // 非交互：唤起 GUI 模型列表让用户选择
  if (await ensureAppRunning()) {
    await controlRequest("navigate", { path: "models" });
    console.log("已在应用里打开模型列表，请选择模型后重试（或直接指定 --model <name>）。");
    process.exit(0);
  }
  fail("没有可用的本地模型。请先安装/导入模型，或指定 --model。");
}

async function setActive(connected: boolean, path: string): Promise<void> {
  if (connected) {
    const r = await controlRequest("setActiveModel", { path }, 15_000);
    if (!r.ok) fail(r.error ?? "设置活动模型失败");
    return;
  }
  const fb = await setActiveModelFallback(path);
  if (!fb.ok) fail(fb.error ?? "设置活动模型失败");
}

async function cloudModelIds(): Promise<string[]> {
  const r = await controlRequest("models", undefined, 15_000);
  if (r.connected && r.ok && Array.isArray(r.data?.cloud)) {
    return r.data.cloud.map((m: { id?: unknown }) => (typeof m?.id === "string" ? m.id : ""));
  }
  const settings = await getAllSettingsFallback().catch(() => ({} as Record<string, string>));
  try {
    const raw = JSON.parse(settings.CLOUD_MODELS ?? "[]");
    return Array.isArray(raw) ? raw.map((m: { id?: unknown }) => String((m as { id?: unknown })?.id ?? "")) : [];
  } catch {
    return [];
  }
}
