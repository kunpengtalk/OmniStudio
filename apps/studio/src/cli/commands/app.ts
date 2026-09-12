import type { ParsedArgs } from "../args";
import { optBool, optString } from "../args";
import { controlRequest, ensureAppRunning } from "../client";
import type { ControlResult } from "../client";
import { getAllSettingsFallback } from "../db";
import { availableEngines } from "../../shared/engines";
import { helpFor } from "../help";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// start / stop / restart
// ---------------------------------------------------------------------------

export async function cmdStart(parsed: ParsedArgs) {
  const appPath = optString(parsed.options, "app-path");
  const withServer = optBool(parsed.options, "server");
  const goModels = optBool(parsed.options, "model");
  const goCloud = optBool(parsed.options, "cloud");

  const connected = await ensureAppRunning({ appPath });
  if (!connected) fail("未能连接应用（control socket）。请确认应用安装路径或使用 --app-path。");
  console.log("OmniStudio 已启动。");

  if (goCloud) {
    await controlRequest("navigate", { path: "settings" });
    console.log("已在应用里打开“设置 → 云端”配置页。");
  } else if (goModels) {
    await controlRequest("navigate", { path: "models" });
    console.log("已在应用里打开模型列表，请选择模型。");
  }

  if (withServer) {
    console.log("正在启动推理服务器…");
    const r = await controlRequest("serverStart", undefined, 120_000);
    if (!r.ok) fail(r.error ?? "启动推理服务器失败");
    const status = await waitServerRunning(15_000);
    if (status) {
      console.log(
        `推理服务器已就绪：${status.host}:${status.port}（${status.engine}，pid ${status.pid ?? "-"}）`,
      );
    } else {
      console.log("推理服务器正在启动中…运行 `omi status` 查看。");
    }
  } else {
    const status = await controlRequest("status", undefined, 5000);
    if (status.ok && status.data?.server?.status === "running") {
      console.log(
        `推理服务器已在运行：${status.data.server.host}:${status.data.server.port}（${status.data.server.engine}）`,
      );
    } else {
      console.log("推理服务器未运行。本地推理可用 `omi start --server` 启动。");
    }
  }
}

async function waitServerRunning(timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await controlRequest("status", undefined, 5000);
    if (r.ok && r.data?.server?.status === "running") return r.data.server;
    await sleep(500);
  }
  return null;
}

export async function cmdStop(parsed: ParsedArgs) {
  const name = parsed.positionals[0];
  if (name) {
    // 当前只有一个本地推理服务器；多引擎切换只是换引擎，不是并存多服务器。
    console.log(`注意：当前只有一台本地推理服务器（由引擎设置决定），${name} 会被忽略。`);
  }
  const r = await controlRequest("serverStop", undefined, 20_000);
  if (!r.connected) fail("应用未运行。先运行 `omi start`。");
  if (!r.ok) fail(r.error ?? "停止失败");
  console.log("推理服务器已停止。");
}

export async function cmdRestart() {
  const r = await controlRequest("serverRestart", undefined, 120_000);
  if (!r.connected) fail("应用未运行。先运行 `omi start`。");
  if (!r.ok) fail(r.error ?? "重启失败");
  console.log("推理服务器已重启。");
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export async function cmdStatus() {
  const r = await controlRequest("status", undefined, 15_000);
  if (r.connected && r.ok) {
    return printStatus(r);
  }
  if (r.connected) fail(r.error ?? "查询状态失败");
  // 应用未运行：探测推理端口 + 打印设置里的地址。
  const settings = await getAllSettingsFallback().catch(() => ({} as Record<string, string>));
  const base = `http://${settings.SERVER_HOST || "127.0.0.1"}:${settings.SERVER_PORT || "8080"}`;
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
    console.log(`应用未运行，但检测到推理服务器在 ${base}（HTTP ${res.status}）。`);
  } catch {
    console.log("应用未运行（无控制 socket），也没有检测到推理服务器。使用 `omi start` 启动。");
  }
}

function printStatus(r: ControlResult) {
  const { server, gateway, mode, version } = r.data ?? {};
  const line = (label: string, value: string) => console.log(`  ${label.padEnd(10)} ${value}`);
  console.log(`OmniStudio ${version ?? ""}  模式：${mode === "remote" ? "云端" : "本地"}`);
  console.log("推理服务器");
  line("引擎", server?.engine ?? "-");
  line("状态", server?.status ?? "-");
  line("PID", String(server?.pid ?? "-"));
  line("地址", server ? `${server.host}:${server.port}` : "-");
  if (server?.error) console.log(`  错误：${server.error}`);
  console.log("网关");
  line("状态", gateway?.status ?? "-");
  line("地址", gateway?.url ?? "-");
  if (gateway?.notice) console.log(`  提示：${gateway.notice}`);
}

// ---------------------------------------------------------------------------
// server 子命令
// ---------------------------------------------------------------------------

export async function cmdServer(parsed: ParsedArgs) {
  const [action, name] = parsed.positionals;
  if (action === "help" || (!action && parsed.options.help)) {
    // `omi server help <action>` / `omi help server <action>`。
    console.log(helpFor(["server", action === "help" ? name : undefined]));
    return;
  }
  if (!action) {
    console.log(helpFor(["server"]));
    return;
  }
  switch (action) {
    case "list": {
      const engines = availableEngines();
      const settings = await getAllSettingsFallback().catch(() => ({} as Record<string, string>));
      const active = settings.INFERENCE_ENGINE || "llama.cpp";
      console.log("可用推理引擎：");
      for (const engine of engines) {
        console.log(`  ${engine === active ? "●" : "○"} ${engine}${engine === active ? "（活动）" : ""}`);
      }
      break;
    }
    case "start": {
      const r = await controlRequest("serverStart", undefined, 120_000);
      if (!r.connected) fail("应用未运行。先运行 `omi start`。");
      if (!r.ok) fail(r.error ?? "启动失败");
      console.log("推理服务器启动中…运行 `omi status` 查看就绪状态。");
      break;
    }
    case "stop":
      await cmdStop(parsed);
      break;
    case "restart":
      await cmdRestart();
      break;
    case "info": {
      const r = await controlRequest("status", undefined, 10_000);
      if (!r.connected) fail("应用未运行。先运行 `omi start`。");
      if (r.ok) {
        const s = r.data.server;
        console.log(`引擎：${s.engine}`);
        console.log(`状态：${s.status}`);
        console.log(`PID：${s.pid ?? "-"}`);
        console.log(`地址：${s.host}:${s.port}`);
        if (s.error) console.log(`错误：${s.error}`);
      }
      break;
    }
    case "logs": {
      const r = await controlRequest("serverLogs", undefined, 10_000);
      if (!r.connected) fail("应用未运行。先运行 `omi start`。");
      if (!r.ok) fail(r.error ?? "读取日志失败");
      // http 状态需要 info/status 里取端口
      const lines = (r.data?.logs ?? "").split("\n").filter(Boolean);
      console.log(lines.slice(-200).join("\n"));
      break;
    }
    default:
      if (name) console.log(`注意：当前只有一个本地推理服务器，${action} ${name} 中 "${name}" 会被忽略。`);
      console.error(`未知操作：${action}\n`);
      console.log(helpFor(["server"]));
      process.exitCode = 1;
  }
}
