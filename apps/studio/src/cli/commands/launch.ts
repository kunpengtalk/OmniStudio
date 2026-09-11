import { existsSync, mkdirSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { homedir } from "os";
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
  codex: "LAUNCHER_CODEX_MODEL",
  opencode: "LAUNCHER_OPENCODE_MODEL",
  openclaw: "LAUNCHER_OPENCLAW_MODEL",
  hermes: "LAUNCHER_HERMES_MODEL",
  pi: "LAUNCHER_PI_MODEL",
  copilot: "LAUNCHER_COPILOT_MODEL",
};

const LAUNCHER_CONFIG_DIR = join(homedir(), ".omni", "launcher");

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
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

  // 2. 读取设置，确定 baseUrl + apiKey（与设置页 launcherCommand 的规则一致）。
  const settings = connected
    ? (await controlRequest("getSettings", undefined, 15_000)).data ?? {}
    : await getAllSettingsFallback();
  const isLocal = (settings.SERVER_MODE ?? "local") !== "remote";

  let baseUrl: string;
  let apiKey: string;
  if (isLocal) {
    baseUrl = `http://${settings.SERVER_HOST || "127.0.0.1"}:${settings.SERVER_PORT || "8080"}`;
    apiKey = "EMPTY";
  } else {
    baseUrl = (settings.VLLM_API_BASE ?? "").replace(/\/+$/, "").replace(/\/v1$/, "");
    apiKey = settings.VLLM_API_KEY || "EMPTY";
    if (!baseUrl) fail("云端模式缺少 Base URL，请先配置：`omi cloud --set ...`");
  }

  // 3. 选模型（可能改活动模型 → 变更会触发本地服务器重启）。
  const model = await resolveModel(parsed, connected, apiKey);

  // 4. 确保本地服务器在线且加载的就是选中的模型。
  if (isLocal) {
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
  if (settingKey) {
    const patch: Record<string, string> = { [settingKey]: model.name };
    if (tool === "claude") patch.LAUNCHER_CLAUDE_MODE = isLocal ? "local" : "cloud";
    if (connected) {
      await controlRequest("updateSettings", { settings: patch }, 15_000);
    } else {
      await updateSettingsFallback(patch);
    }
  }
  writeToolConfig(tool, model.name, baseUrl);

  console.log(`启动 ${tool}（模型：${model.name}，接口：${baseUrl}${apiKey !== "EMPTY" ? "，API Key 已设置" : ""}）`);

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
  if (kind === "anthropic") {
    env.ANTHROPIC_BASE_URL = baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = apiKey;
    env.ANTHROPIC_MODEL = model.name;
  } else if (kind === "openai") {
    env.OPENAI_BASE_URL = `${baseUrl}/v1`;
    env.OPENAI_API_KEY = apiKey;
    env.OPENAI_MODEL = model.name;
  } else {
    // generic：hermes / pi 用命令行参数
    extraArgs.unshift("--model", model.name, "--base-url", `${baseUrl}/v1`);
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

async function resolveModel(
  parsed: ParsedArgs,
  connected: boolean,
  apiKey: string,
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
