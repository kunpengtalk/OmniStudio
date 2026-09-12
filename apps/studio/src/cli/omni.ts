#!/usr/bin/env bun
/**
 * omni — OmniStudio 命令行工具
 *
 * 直接复用 src/bun/ 的真实后端（模型库、推理服务器、网关、聊天、配置），
 * 而不是重写一套。独立进程无法读取打包应用里的 `Resources/version.json`
 * （electrobun 的 `Utils.paths.userData` 会抛错），所以这里先解析出数据目录
 * 并设置 `OMNI_DATA_DIR` / `OMNI_DB_PATH` 环境变量，再动态 import 后端模块
 * （静态 import 会被提升到 env 设置之前执行，必须用动态 import）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { basename, join, resolve } from "path";
import type { InferenceEngine } from "../shared/engines";

const APP_SUPPORT = "omni-studio.kunpengtalk.com";
const DB_FILE = "omni-studio.db";

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function fail(msg: string): never {
  console.error(`\x1b[31merror:\x1b[0m ${msg}`);
  process.exit(1);
}

function warn(msg: string) {
  console.error(`\x1b[33mwarning:\x1b[0m ${msg}`);
}

function fmtSize(bytes: number): string {
  if (!bytes) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)}${units[i]}`;
}

function readVersion(): string {
  // src/cli/omni.ts → 向上两级是 apps/studio/package.json，向上三级是仓库根。
  for (const rel of ["../../package.json", "../../../../package.json"]) {
    try {
      const v = JSON.parse(readFileSync(join(import.meta.dir, rel), "utf8")).version;
      if (typeof v === "string" && v) return v;
    } catch {
      // try next
    }
  }
  return "dev";
}

// ---------------------------------------------------------------------------
// 数据目录解析
// ---------------------------------------------------------------------------

/** 自动探测最“新”的 channel 数据目录（含 omni-studio.db 且 mtime 最新）。 */
function autoDetectDataDir(): string | undefined {
  const base = join(homedir(), "Library", "Application Support", APP_SUPPORT);
  try {
    const entries = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory());
    let best: { dir: string; mtime: number } | undefined;
    for (const e of entries) {
      const db = join(base, e.name, DB_FILE);
      if (!existsSync(db)) continue;
      const mtime = statSync(db).mtimeMs;
      if (!best || mtime > best.mtime) best = { dir: join(base, e.name), mtime };
    }
    return best?.dir;
  } catch {
    return undefined;
  }
}

const DEFAULT_DATA_DIR = join(homedir(), "Library", "Application Support", APP_SUPPORT, "stable");

/** 解析数据目录并设置环境变量（必须在动态 import 后端之前调用）。 */
function resolveDataDir(explicit?: string): string {
  const dir =
    explicit ??
    process.env.OMNI_DATA_DIR ??
    autoDetectDataDir() ??
    DEFAULT_DATA_DIR;
  process.env.OMNI_DATA_DIR = dir;
  process.env.OMNI_DB_PATH = join(dir, DB_FILE);
  return dir;
}

// ---------------------------------------------------------------------------
// 后端模块（动态加载，保证 env 已就位）
// ---------------------------------------------------------------------------

type Backend = {
  settings: typeof import("../bun/db/settings");
  modelStore: typeof import("../bun/model-store");
  serverManager: typeof import("../bun/server-manager");
  runtimes: typeof import("../bun/runtimes");
  gateway: typeof import("../bun/gateway");
  chat: typeof import("../bun/chat");
  chatModel: typeof import("../bun/chat-model");
};

async function loadBackend(): Promise<Backend> {
  return {
    settings: await import("../bun/db/settings"),
    modelStore: await import("../bun/model-store"),
    serverManager: await import("../bun/server-manager"),
    runtimes: await import("../bun/runtimes"),
    gateway: await import("../bun/gateway"),
    chat: await import("../bun/chat"),
    chatModel: await import("../bun/chat-model"),
  };
}

interface Ctx {
  json: boolean;
  dataDir: string;
  backend: Backend;
}

/** 把「模型路径 / 文件名 / slug」解析为已安装模型的实际路径。 */
function resolveModelRef(ref: string, backend: Backend): string | undefined {
  if (existsSync(ref)) return resolve(ref);
  const target = ref.toLowerCase();
  return backend.modelStore
    .listInstalledModels()
    .find(
      (m) =>
        m.path === ref ||
        m.fileName === ref ||
        basename(m.path).toLowerCase() === target ||
        backend.modelStore.slugModelFileName(m.fileName).toLowerCase() === target,
    )?.path;
}

/** 解析 -m / --model 之后的下一个参数（支持 `-m value` 和 `-m=value`）。 */
function takeModelFlag(args: string[]): { model?: string; rest: string[] } {
  const rest: string[] = [];
  let model: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-m" || a === "--model") {
      model = args[++i];
    } else if (a.startsWith("--model=")) {
      model = a.slice("--model=".length);
    } else if (a.startsWith("-m=")) {
      model = a.slice(3);
    } else {
      rest.push(a);
    }
  }
  return { model, rest };
}

/** 激活本地模型文件（-m 指向已安装模型时），返回服务端模型名。 */
function ensureActiveModel(model: string, backend: Backend): string {
  const path = resolveModelRef(model, backend);
  if (!path) return model; // 未匹配到本地文件 → 当作远端模型 id 透传
  const res = backend.modelStore.setActiveModel(path);
  if (!res.ok) fail(res.error ?? "激活模型失败");
  // 用与 setActiveModel 同一套解析：分批 GGUF 落到第一个分片、仓库目录落到目录，
  // 算出来的名字必须和服务器实际提供的模型 id 一致。
  return backend.modelStore.servedNameForModelPath(path);
}

// ---------------------------------------------------------------------------
// 命令：model
// ---------------------------------------------------------------------------

const MODEL_HELP = `用法: omni model <子命令> [选项]

子命令:
  list [--remote] [--json]        列出已安装模型（--remote 同时列出远端 API 模型）
  set <路径|文件名|slug>          激活模型（自动切换推理引擎）
  info <路径|文件名|slug> [--json] 查看模型详情
  delete <路径|文件名|slug> --yes  删除模型文件（需显式 --yes 确认）
  dirs                            显示模型目录`;

async function cmdModelList(args: string[], ctx: Ctx) {
  const { backend, json } = ctx;
  const models = backend.modelStore.listInstalledModels();
  const rows = models.map((m) => ({
    repo: m.repo,
    file: m.fileName,
    size: fmtSize(m.size),
    active: m.isActive,
    chat: m.isChatModel,
    category: m.category,
    path: m.path,
  }));

  if (json) {
    const payload: Record<string, unknown> = {
      dataDir: ctx.dataDir,
      engine: backend.settings.getSetting("INFERENCE_ENGINE"),
      activeModel: backend.settings.getSetting("LOCAL_MODEL_PATH"),
      models: models.map((m) => ({
        repo: m.repo,
        fileName: m.fileName,
        path: m.path,
        size: m.size,
        isActive: m.isActive,
        isChatModel: m.isChatModel,
        category: m.category,
        favorite: m.favorite,
      })),
    };
    if (args.includes("--remote")) {
      const { models: apiModels } = await backend.chatModel.listChatModels();
      payload.apiModels = apiModels
        .filter((m) => m.type === "api")
        .map((m) => ({ label: m.label, isActive: m.isActive, detail: m.detail }));
    }
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`数据目录: ${ctx.dataDir}`);
  console.log(`推理引擎: ${backend.settings.getSetting("INFERENCE_ENGINE")}`);
  if (models.length === 0) {
    console.log("没有已安装的模型。");
    return;
  }
  console.log();
  const sorted = [...rows].sort((a, b) => Number(b.active) - Number(a.active));
  const marker = (m: (typeof rows)[number]) => (m.active ? "●" : " ");
  console.log(`${marker(sorted[0]!)} 当前激活模型（●）`);
  for (const m of sorted) {
    const flags = [m.active ? "active" : "", m.chat ? "chat" : "", m.category]
      .filter(Boolean)
      .join(",");
    console.log(
      `  ${marker(m)} ${m.file.padEnd(48, " ")} ${m.size.padStart(9, " ")}  [${flags}]  ${m.repo}`,
    );
  }
}

async function cmdModel(ctx: Ctx, args: string[]) {
  const sub = args[0];
  const rest = args.slice(1);
  const { backend, json } = ctx;

  if (sub === "--help" || sub === "-h" || sub === "help") {
    console.log(MODEL_HELP);
    return;
  }

  switch (sub) {
    case "list":
      return cmdModelList(rest, ctx);

    case "set": {
      const ref = rest[0];
      if (!ref) fail("用法: omni model set <路径|文件名|slug>");
      const path = resolveModelRef(ref, backend);
      if (!path) fail(`找不到模型「${ref}」。先 \`omni model list\` 看可用的文件名。`);
      const res = backend.modelStore.setActiveModel(path);
      if (!res.ok) fail(res.error ?? "激活失败");
      const slug = backend.modelStore.servedNameForModelPath(path);
      json
        ? console.log(JSON.stringify({ ok: true, path, model: slug }, null, 2))
        : console.log(`已激活: ${slug}\n路径: ${path}`);
      return;
    }

    case "info": {
      const ref = rest[0];
      if (!ref) fail("用法: omni model info <路径|文件名|slug>");
      const path = resolveModelRef(ref, backend);
      if (!path) fail(`找不到模型「${ref}」。`);
      const m = backend.modelStore.listInstalledModels().find((x) => x.path === path);
      if (!m) fail(`找不到模型「${ref}」。`);
      const info = {
        file: m.fileName,
        repo: m.repo,
        path: m.path,
        size: m.size,
        category: m.category,
        active: m.isActive,
        chatModel: m.isChatModel,
        favorite: m.favorite,
        engine: backend.settings.getSetting("INFERENCE_ENGINE"),
        command: backend.serverManager.getLaunchCommand(m.path).command,
      };
      json
        ? console.log(JSON.stringify(info, null, 2))
        : console.log(
            [
              `文件:   ${info.file}`,
              `仓库:   ${info.repo}`,
              `路径:   ${info.path}`,
              `大小:   ${fmtSize(info.size)}`,
              `类别:   ${info.category}`,
              `状态:   ${info.active ? "激活" : "未激活"}${info.chatModel ? "（对话模型）" : ""}`,
              ``,
              `启动命令:`,
              `  ${info.command}`,
            ].join("\n"),
          );
      return;
    }

    case "delete": {
      const ref = rest.find((a) => !a.startsWith("-"));
      if (!ref) fail("用法: omni model delete <路径|文件名|slug> --yes");
      if (!rest.includes("--yes") && !rest.includes("-y"))
        fail("删除会移除模型文件，请显式加 --yes 确认。");
      const path = resolveModelRef(ref, backend);
      if (!path) fail(`找不到模型「${ref}」。`);
      backend.modelStore.deleteLocalModel(path);
      json
        ? console.log(JSON.stringify({ ok: true, deleted: path }, null, 2))
        : console.log(`已删除: ${path}`);
      return;
    }

    case "dirs": {
      const dirs = backend.modelStore.getModelsDirs();
      json
        ? console.log(JSON.stringify({ dirs }, null, 2))
        : dirs.forEach((d) => console.log(d));
      return;
    }

    default:
      console.log(MODEL_HELP);
      if (sub) fail(`未知 model 子命令: ${sub}`);
      process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// 命令：chat
// ---------------------------------------------------------------------------

const CHAT_HELP = `用法: omni chat "<文本>" [选项]

选项:
  -m <模型>        指定模型：已安装模型的文件名/slug（自动激活并切换引擎），
                   或远端 OpenAI 兼容 API 的模型 id
  --no-stream      一次性返回完整回答（默认流式打印）
  --reasoning      输出推理模型的思考过程
  --system <内容>  附加一条 system 消息`;

function timeSystemMessage(): { role: string; content: string } {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = now.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    timeZone: tz,
  });
  const time = now.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: tz,
  });
  return { role: "system", content: `当前时间是 ${date} ${time}（${tz}）。回答涉及“今天/最新/最近”的时间相关问题时以此为准。` };
}

async function postChat(base: string, body: Record<string, unknown>): Promise<Response> {
  const res = await fetch(`${base.replace(/\/+$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    fail(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return res;
}

/** 端口上是否已有可用的 OpenAI 兼容服务（应用开着时复用，避免端口冲突）。 */
async function probeServer(base: string): Promise<boolean> {
  const root = base.replace(/\/+$/, "");
  for (const path of ["/health", "/v1/models"]) {
    try {
      const res = await fetch(`${root}${path}`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return true;
    } catch {
      // try next
    }
  }
  return false;
}

/** 逐行解析 SSE，把 reasoning_content / content 原样写 stdout。 */
async function streamChat(base: string, body: Record<string, unknown>, showThinking: boolean) {
  const res = await postChat(base, body);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const W = process.stdout.write.bind(process.stdout);
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta ?? {};
        // 模型输出类 /think 包裹的推理过程时，正文里通常还会残留标签，一并清掉。
        if (showThinking && delta.reasoning_content) {
          W(`\x1b[2m[思考] ${delta.reasoning_content}\x1b[0m`);
        }
        if (delta.content) {
          W(delta.content.replace(/^\/think/gs, "").replace(/\/think$/gs, ""));
        }
      } catch {
        // 忽略无法解析的行
      }
    }
  }
}

async function cmdChat(args: string[], ctx: Ctx) {
  const { backend, json } = ctx;

  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    console.log(CHAT_HELP);
    return;
  }

  let noStream = false;
  let reasoning = false;
  let extraSystem = "";
  let model: string | undefined;
  const textArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-m" || a === "--model") {
      model = args[++i];
    } else if (a === "--no-stream") {
      noStream = true;
    } else if (a === "--reasoning" || a === "-r") {
      reasoning = true;
    } else if (a === "--system") {
      extraSystem = args[++i] ?? "";
    } else if (a === "--json") {
      // 已在全局解析，忽略
    } else {
      textArgs.push(a);
    }
  }

  const text = textArgs.join(" ").trim();
  if (!text) fail("chat 需要文本内容。用法: omni chat \"你好\" [选项]");

  const mode = backend.settings.getSetting("SERVER_MODE");

  let modelName = model;
  if (modelName) {
    modelName = ensureActiveModel(modelName, backend);
  } else {
    modelName = backend.chatModel.getChatModelName();
  }
  if (!modelName) fail("没有可用的对话模型：先 \`omni model set <模型>\`，或在设置里配置 VLLM_MODEL_NAME。");

  // 本地模式：确保推理服务器已就绪（CLI 没有控制台，按设置后台拉起）。
  const base = backend.chat.getChatBaseUrl();
  if (mode === "local") {
    const ready = await backend.chat.ensureServerReady({ autoStart: true });
    if (!ready.ok) {
      // 应用自身的推理服务器可能已占用同一端口（此时再拉起必然失败），
      // 探测到端口上有活着的 OpenAI 兼容服务就直接复用。
      if (!(await probeServer(base))) {
        fail(`推理服务器未就绪: ${ready.error}`);
      }
      warn("端口已有运行中的推理服务，直接复用（如需本 CLI 管理请先停掉其它实例）。");
    }
  }

  const messages = [timeSystemMessage()];
  if (extraSystem) messages.push({ role: "system", content: extraSystem });
  messages.push({ role: "user", content: text });
  const body: Record<string, unknown> = {
    model: modelName,
    messages,
    stream: !noStream,
  };

  if (noStream) {
    const res = await postChat(base, body);
    const data = (await res.json().catch(() => null)) as {
      choices?: { message?: { content?: string; reasoning_content?: string } }[];
    } | null;
    const choice = data?.choices?.[0]?.message;
    if (reasoning && choice?.reasoning_content) {
      console.log(`\x1b[2m[思考] ${choice.reasoning_content}\x1b[0m`);
    }
    console.log((choice?.content ?? "").replace(/^\/think/gs, "").replace(/\/think$/gs, ""));
    return;
  }

  if (json) warn("chat 流式模式下 --json 不生效（输出即为模型回复）。");
  await streamChat(base, body, reasoning);
  console.log();
}

// ---------------------------------------------------------------------------
// 命令：server / gateway / serve
// ---------------------------------------------------------------------------

const SERVER_HELP = `用法: omni server <start|stop|restart|kill|status> [选项]

选项:
  -m <模型>     start/restart 时先激活该模型再启动

说明:
  start / restart 是前台长驻命令：启动并等待健康检查通过后不会退出，
  推理服务器与 CLI 同生命周期，按 CTRL+C 优雅停止。
  status 会探测端口，应用自身已运行的推理服务器也能被识别。
  kill 强制结束本进程管理的服务，不优雅退出。`;

async function cmdServer(args: string[], ctx: Ctx) {
  const { backend, json } = ctx;
  const sub = args[0];
  const { model, rest } = takeModelFlag(args.slice(1));
  const help =
    sub === "--help" || sub === "-h" || sub === "help" ||
    rest.includes("--help") || rest.includes("-h");

  if (help || !sub) {
    console.log(SERVER_HELP);
    if (!sub) process.exit(0);
    return;
  }

  const activate = async () => {
    if (model) ensureActiveModel(model, backend);
  };

  const holdForeground = (name: string, onStop: () => Promise<void>) => {
    const shutdown = async () => {
      try {
        await onStop();
      } catch {
        // ignore
      }
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    console.log(`${name}为前台长驻服务，按 CTRL+C 优雅停止。`);
    return new Promise<never>(() => {});
  };

  switch (sub) {
    case "start": {
      await activate();
      const r = await backend.serverManager.startServer();
      json
        ? console.log(JSON.stringify({ ok: r.ok, error: r.error ?? undefined }, null, 2))
        : r.ok
          ? console.log(
              `推理服务器已启动 (${backend.runtimes.getActiveEngine()}, pid ${backend.serverManager.getPid()})`,
            )
          : fail(r.error ?? "启动失败");
      if (!r.ok) return;
      return holdForeground("推理服务器", () => backend.serverManager.stopServer());
    }
    case "stop":
      await backend.serverManager.stopServer();
      json
        ? console.log(JSON.stringify({ ok: true, status: "stopped" }))
        : console.log("推理服务器已停止");
      return;
    case "restart": {
      await activate();
      const r = await backend.serverManager.restartServer();
      json
        ? console.log(JSON.stringify({ ok: r.ok, error: r.error ?? undefined }, null, 2))
        : r.ok
          ? console.log("推理服务器已重启")
          : fail(r.error ?? "重启失败");
      if (!r.ok) return;
      return holdForeground("推理服务器", () => backend.serverManager.stopServer());
    }
    case "kill":
      backend.serverManager.forceKill();
      json
        ? console.log(JSON.stringify({ ok: true, status: "killed" }))
        : console.log("已强制结束推理服务器进程");
      return;
    case "status": {
      const engine = backend.runtimes.getActiveEngine();
      const status = backend.serverManager.getStatus();
      const pid = backend.serverManager.getPid();
      const launch = backend.serverManager.getLaunchCommand();
      const lastError = backend.serverManager.getLastError();
      // 端口探测：应用自身在跑的推理服务器（外部实例）也能被识别。
      const reachable = await probeServer(backend.chat.getChatBaseUrl());
      const live =
        status === "running" ? "running" : reachable ? `running (外部实例 @${backend.chat.getChatBaseUrl()})` : status;
      const out = {
        engine,
        status: live,
        pid,
        command: launch.command,
        error: lastError || undefined,
        reachable,
      };
      if (json) {
        console.log(JSON.stringify(out, null, 2));
      } else {
        console.log(`引擎:   ${engine}`);
        console.log(`状态:   ${live}${pid && reachable ? ` (pid ${pid})` : ""}`);
        console.log(`启动:   ${launch.command}`);
        if (lastError) console.log(`错误:   ${lastError}`);
      }
      return;
    }
    default:
      console.log(SERVER_HELP);
      fail(`未知 server 子命令: ${sub}`);
  }
}

const GATEWAY_HELP = `用法: omni gateway <start|stop|restart|status> [--json]

统一 API 网关（默认 http://127.0.0.1:10000），聚合本地推理后端与远端 API，
提供 /v1/chat/completions、/v1/models、/docs 等 OpenAI 兼容接口。

说明:
  start / restart 是前台长驻命令：网关与 CLI 同生命周期，按 CTRL+C 优雅停止。`;

async function cmdGateway(args: string[], ctx: Ctx) {
  const { backend, json } = ctx;
  const sub = args[0];
  const help = args.includes("--help") || args.includes("-h");
  if (help || !sub) {
    console.log(GATEWAY_HELP);
    if (!sub) process.exit(0);
    return;
  }

  const holdForeground = (onStop: () => Promise<void>) => {
    const shutdown = async () => {
      try {
        await onStop();
      } catch {
        // ignore
      }
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    console.log("网关为前台长驻服务，按 CTRL+C 优雅停止。");
    return new Promise<never>(() => {});
  };

  switch (sub) {
    case "start": {
      if (!backend.gateway.isGatewayEnabled()) warn("GATEWAY_ENABLED=0，网关被设置里禁用。");
      const r = await backend.gateway.startGateway();
      json
        ? console.log(JSON.stringify(r, null, 2))
        : r.ok
          ? console.log(`网关已启动: http://127.0.0.1:${r.port}`)
          : fail(r.error ?? "网关启动失败");
      if (!r.ok) return;
      return holdForeground(() => backend.gateway.stopGateway());
    }
    case "stop":
      await backend.gateway.stopGateway();
      json ? console.log(JSON.stringify({ ok: true, status: "stopped" })) : console.log("网关已停止");
      return;
    case "restart": {
      await backend.gateway.stopGateway();
      const r = await backend.gateway.startGateway();
      json
        ? console.log(JSON.stringify(r, null, 2))
        : r.ok
          ? console.log(`网关已重启: http://127.0.0.1:${r.port}`)
          : fail(r.error ?? "网关重启失败");
      if (!r.ok) return;
      return holdForeground(() => backend.gateway.stopGateway());
    }
    case "status": {
      const s = backend.gateway.getGatewayStatus();
      const enabled = backend.gateway.isGatewayEnabled();
      const out = { enabled, ...s };
      if (json) {
        console.log(JSON.stringify(out, null, 2));
      } else {
        console.log(`启用:   ${enabled ? "是" : "否（GATEWAY_ENABLED=0）"}`);
        console.log(`状态:   ${s.status}`);
        console.log(`地址:   ${s.url}`);
        console.log(`配置端口: ${s.configuredPort}`);
        if (s.notice) console.log(`提示:   ${s.notice}`);
        if (s.error) console.log(`错误:   ${s.error}`);
      }
      return;
    }
    default:
      console.log(GATEWAY_HELP);
      fail(`未知 gateway 子命令: ${sub}`);
  }
}

const SERVE_HELP = `用法: omni serve [-m <模型>]

确保本地推理服务器就绪并启动统一网关，两个长驻服务一次拉起。
本地模式下推理服务器未运行时自动启动。CTRL+C 优雅退出。`;

async function cmdServe(args: string[], ctx: Ctx) {
  const { backend } = ctx;
  const { model } = takeModelFlag(args);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(SERVE_HELP);
    return;
  }
  if (model) ensureActiveModel(model, backend);

  const mode = backend.settings.getSetting("SERVER_MODE");
  if (mode === "local") {
    console.log("正在确保本地推理服务器就绪…");
    const base = backend.chat.getChatBaseUrl();
    const ready = await backend.chat.ensureServerReady({ autoStart: true });
    if (!ready.ok && !(await probeServer(base))) {
      fail(`推理服务器未就绪: ${ready.error}`);
    }
    const engine = backend.runtimes.getActiveEngine();
    console.log(`推理服务器运行中 (${engine}, pid ${backend.serverManager.getPid() ?? "外部实例"})`);
  }

  const g = await backend.gateway.startGateway();
  if (!g.ok) fail(g.error ?? "网关启动失败");
  console.log(`统一网关运行中: http://127.0.0.1:${g.port}`);
  console.log("按 CTRL+C 退出。");

  const shutdown = async () => {
    try {
      await backend.gateway.stopGateway();
      await backend.serverManager.stopServer();
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {}); // 由网关/推理服务持有事件循环，这里仅防进程提前退出
}

// ---------------------------------------------------------------------------
// 命令：doctor / config
// ---------------------------------------------------------------------------

async function cmdDoctor(ctx: Ctx) {
  const { backend, json } = ctx;
  const checks: { name: string; ok: boolean; detail?: string }[] = [];

  // 数据目录 / 数据库
  const dbPath = join(ctx.dataDir, DB_FILE);
  checks.push({
    name: "数据目录",
    ok: existsSync(ctx.dataDir),
    detail: ctx.dataDir,
  });
  checks.push({
    name: "数据库",
    ok: existsSync(dbPath),
    detail: existsSync(dbPath) ? dbPath : `缺失（先运行一次应用或 omni config set SETUP_COMPLETE 1）`,
  });

  // 推理引擎二进制
  const engine = backend.settings.getSetting("INFERENCE_ENGINE") as InferenceEngine;
  const bin = await backend.runtimes.createRuntime(engine).checkBinary();
  checks.push({
    name: `引擎二进制 (${engine})`,
    ok: bin.found,
    detail: bin.found ? bin.path : "未找到，运行「模型管理 → 下载引擎」或手动安装",
  });

  // 服务状态
  const status = backend.serverManager.getStatus();
  checks.push({
    name: "推理服务器",
    ok: status !== "error",
    detail:
      status === "error"
        ? backend.serverManager.getLastError() || "error"
        : `${status}${backend.serverManager.getPid() ? `, pid ${backend.serverManager.getPid()}` : ""}`,
  });

  // 网关
  const gw = backend.gateway.getGatewayStatus();
  checks.push({
    name: "统一网关",
    ok: gw.status !== "error",
    detail: `${gw.status}${gw.status === "running" ? `, ${gw.url}` : ""}${gw.error ? `（${gw.error}）` : ""}`,
  });

  // 远端 API 配置
  const apiBase = backend.settings.getSetting("VLLM_API_BASE");
  const apiKey = backend.settings.getSetting("VLLM_API_KEY");
  checks.push({
    name: "云端 API",
    ok: Boolean(apiBase),
    detail: apiBase ? `${apiBase}${apiKey && apiKey !== "EMPTY" ? "（已配置 key）" : "（未配置 key）"}` : "未配置 VLLM_API_BASE",
  });

  if (json) {
    console.log(JSON.stringify({ dataDir: ctx.dataDir, checks }, null, 2));
  } else {
    for (const c of checks) {
      const mark = c.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
      console.log(`${mark} ${c.name}: ${c.detail ?? ""}`);
    }
  }

  if (checks.some((c) => !c.ok)) process.exitCode = 1;
}

const CONFIG_HELP = `用法: omni config <子命令> [选项]

子命令:
  list [--json]        列出全部设置
  get <key> [--json]   读取单个设置
  set <key> <value>    写入设置（直接写应用数据库，运行中的应用大部分 key 即时生效）
  path                 显示数据目录 / 数据库路径`;

function configKeys(backend: Backend): string[] {
  return Object.keys(backend.settings.getAllSettings()).sort();
}

async function cmdConfig(args: string[], ctx: Ctx) {
  const { backend, json } = ctx;
  const sub = args[0];
  const help = args.includes("--help") || args.includes("-h");
  if (help || !sub) {
    console.log(CONFIG_HELP);
    if (!sub) process.exit(0);
    return;
  }

  switch (sub) {
    case "path": {
      json
        ? console.log(JSON.stringify({ dataDir: ctx.dataDir, dbPath: join(ctx.dataDir, DB_FILE) }, null, 2))
        : console.log(`数据目录: ${ctx.dataDir}\n数据库:   ${join(ctx.dataDir, DB_FILE)}`);
      return;
    }
    case "list": {
      const all = backend.settings.getAllSettings();
      if (json) {
        console.log(JSON.stringify(all, null, 2));
      } else {
        for (const k of Object.keys(all).sort()) {
          const v = all[k] ?? "";
          const shown = v.length > 80 ? `${v.slice(0, 77)}…` : v;
          console.log(`${k}=${shown}`);
        }
      }
      return;
    }
    case "get": {
      const key = args[1];
      if (!key) fail("用法: omni config get <key>");
      const all = backend.settings.getAllSettings();
      if (!(key in all)) {
        const tip = configKeys(backend)
          .slice(0, 8)
          .join("、");
        fail(`未知设置项「${key}」。常用: ${tip} …`);
      }
      json
        ? console.log(JSON.stringify({ key, value: all[key] }))
        : console.log(all[key]);
      return;
    }
    case "set": {
      const key = args[1];
      const value = args[2];
      if (!key || value === undefined) fail("用法: omni config set <key> <value>");
      const all = backend.settings.getAllSettings();
      if (!(key in all)) {
        const tip = configKeys(backend)
          .slice(0, 8)
          .join("、");
        fail(`未知设置项「${key}」。常用: ${tip} …`);
      }
      backend.settings.updateSettings({ [key]: value });
      json
        ? console.log(JSON.stringify({ key, value }))
        : console.log(`已设置: ${key}=${value}`);
      return;
    }
    default:
      console.log(CONFIG_HELP);
      fail(`未知 config 子命令: ${sub}`);
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`omni ${readVersion()} — OmniStudio 命令行工具

用法: omni <命令> [选项]

命令:
  model list|set|info|delete|dirs   管理本地模型
  chat "<文本>"                     对话（本地/远端推理）
  server start|stop|restart|kill|status   推理服务器
  gateway start|stop|restart|status       统一 API 网关
  serve                              推理服务器 + 网关一体启动（长驻）
  doctor                             环境体检
  config list|get|set|path           读写应用设置
  help <命令>                        查看子命令帮助（等价于 <命令> --help）
  --version                          版本号
  --help, -h                         帮助

全局选项:
  --json                             输出 JSON
  --data-dir <目录>                  指定数据目录（默认自动探测最新 channel）

示例:
  omni model list
  omni model set Qwen2.5-7B.gguf
  omni chat "用一句话介绍量子计算" --reasoning
  omni server start && omni gateway start
  omni serve
  omni doctor
  omni config get INFERENCE_ENGINE
  omni config set SERVER_TEMP 0.8`);
}

async function main() {
  const argv = process.argv.slice(2);

  // 全局选项解析（只消费 --json / --data-dir，其余原样传给命令）
  let json = false;
  let explicitDataDir: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") json = true;
    else if (a === "--data-dir") explicitDataDir = argv[++i];
    else if (a.startsWith("--data-dir=")) explicitDataDir = a.slice("--data-dir=".length);
    else rest.push(a);
  }

  const [cmd, ...args] = rest;

  if (!cmd || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }
  if (cmd === "--version" || cmd === "-v") {
    console.log(readVersion());
    return;
  }

  // omni help [<命令>] —— 与 <命令> --help 相同
  const HELP_TEXTS: Record<string, string> = {
    model: MODEL_HELP,
    chat: CHAT_HELP,
    server: SERVER_HELP,
    gateway: GATEWAY_HELP,
    serve: SERVE_HELP,
    config: CONFIG_HELP,
    doctor: `用法: omni doctor [--json]

环境体检：数据目录 / 数据库 / 引擎二进制 / 推理服务器 / 网关 / 云端 API 配置。
有检查项不通过时退出码非零。`,
  };
  if (cmd === "help") {
    if (args[0] && HELP_TEXTS[args[0]]) {
      console.log(HELP_TEXTS[args[0]]);
    } else {
      printHelp();
    }
    return;
  }

  const dataDir = resolveDataDir(explicitDataDir);
  const backend = await loadBackend();
  const ctx: Ctx = { json, dataDir, backend };

  switch (cmd) {
    case "model":
      return cmdModel(ctx, args);
    case "chat":
      return cmdChat(args, ctx);
    case "server":
      return cmdServer(args, ctx);
    case "gateway":
      return cmdGateway(args, ctx);
    case "serve":
      return cmdServe(args, ctx);
    case "doctor":
      return cmdDoctor(ctx);
    case "config":
      return cmdConfig(args, ctx);
    default:
      fail(`未知命令「${cmd}」。用 \`omni --help\` 查看全部命令。`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
