// 必须最先导入：启动守卫要在任何会抛错的模块（尤其 ./db 的迁移）之前注册好监听器，
// 否则一次迁移失败就是"图标闪一下、窗口都没出"——用户看不到任何原因。
import "./startup-guard";
// 必须最先导入：把 userData 目录写进 OMNI_DATA_DIR，供 ./db 定位数据库。
import "./user-data";
import "./canvas-polyfill";
import Electrobun, { Utils } from "electrobun/bun";
import { BrowserWindow } from "electrobun/bun";
import "./db";
import { startImageServer, onMediaServerStatusChange } from "./image-server";
import { setWindowRef } from "./window";
import { appRPC, initServerBroadcast, initModelDownloadBroadcast, initTTSModelDownloadBroadcast, initGatewayBroadcast, initTunnelBroadcast, initEngineInstallBroadcast, initMlxInstallBroadcast, initMlxModelDownloadBroadcast, initMediaSetupBroadcast, initPpOcrBroadcast, initTessInstallBroadcast, initSkillsBroadcast, initBackupBroadcast, initCanvasBroadcast, initSystemOneBroadcast, broadcastCurrentStatus, dispatchRemoteRpc, initRemoteBroadcast, replayRemoteStatus } from "./rpc";
import { installWebBridge } from "./gateway-web";
import { seedIfNeeded } from "./prompt-library";
import { initSkills } from "./skills";
import { APP_NAME } from "./config";
import { createMenu } from "./menu";
import { broadcastUpdateStatus, checkForUpdate, localVersionSafe, recordBootVersion, updateState } from "./updates";
import { markStartupReady } from "./startup-guard";
import { teardownServices, teardownServicesSync } from "./shutdown";
import { isConfigured, getSetting } from "./db/settings";
import * as ServerManager from "./server-manager";
import { healDriftedChatConfig } from "./model-store";
import * as Gateway from "./gateway";
import * as Tunnel from "./tunnel";
import { startControlServer } from "./control-server";
import { getAgentWorkspace } from "./agent";
import { runMemoryMaintenance } from "./memory";
import { runKbMaintenance } from "./knowledge";
import { notify } from "./notifications";
import { log, logEvent, mirrorConsole } from "./app-log";
import { installProxy } from "./proxy";

// 统一日志最先装好：从这一行之后，主进程的 console.* 与关键失败都会落到
// `<数据目录>/logs/app.log`（排查入口见 `omi logs` / `omi diag`）。
mirrorConsole("app");

// 代理（设置 → 通用）要在任何网络请求之前接上：这一行之后，云端模型、
// 模型/引擎下载、联网检索与子进程都会按设置走代理，回环与局域网直连。
installProxy();

// Check if Vite dev server is running for HMR
async function getMainViewUrl(): Promise<string> {
  // 渠道读不出来时按打包版处理（views:// 一定可用）—— 这个查询是 cwd 相对读取
  // version.json，升级后由 Updater 重新 open 时路径未必一致，不能让它把启动带崩。
  const { channel } = await localVersionSafe();
  if (channel === "dev") {
    const DEV_SERVER_PORT = 5173;
    const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;
    try {
      await fetch(DEV_SERVER_URL, { method: "HEAD" });
      console.log(`HMR enabled: Using Vite dev server at ${DEV_SERVER_URL}`);
      return DEV_SERVER_URL;
    } catch {
      console.log("Vite dev server not running. Run 'bun run dev:hmr' for HMR support.");
    }
  }
  return "views://mainview/index.html";
}

// 数据库连接在 ./db 打开时已跑过迁移；这里只做首次提示词种子灌入（幂等）。
seedIfNeeded();

// 确保 Agent 的默认工作区存在（~/.omnistudio/workspace），用当前用户权限创建。
getAgentWorkspace();

// Skills 中央库（默认 ~/.agents/skills）：建目录、清安装残留、收编已有技能、启动监听。
initSkills();

// MCP 服务器预热：后台连接已启用的服务器，首次 Agent 对话不用现场握手。
// 失败静默（设置页与 Agent 运行时会按需重连并展示错误）。
void import("./mcp")
  .then((m) => m.connectEnabledServers())
  .catch(() => {});

// serve extracted images over HTTP for the webview
// 端口被占的情况由 startImageServer 自己处理（探身份 / 报状态 / 等对方退出后接管），
// 这里只兜住其它意外，不让一个可降级的服务把主进程启动搞崩。
//
// 监听要先挂上：绑定失败时探测结论是异步来的，晚挂会漏掉那次事件。
// 媒体服务被别的实例（另一个数据目录）挡着时，图片 / 音频预览会失败或串到对方的数据上：
// 顶栏会亮告警，这里再落一条通知，恢复时补一条，免得用户对着报错猜。
let mediaWasBlocked = false;
onMediaServerStatusChange((status) => {
  if (status.state === "blocked") {
    mediaWasBlocked = true;
    notify({
      kind: "error",
      title: "媒体服务未启动：端口被占用",
      body:
        "图片 / 音频预览可能加载失败。通常是同一个应用的另一个实例（dev / canary / 正式版之一）" +
        "正在运行且数据目录不同——关掉它，本窗口会在几秒内自动接管，无需重启。",
    });
    return;
  }
  if (mediaWasBlocked && status.state === "serving") {
    mediaWasBlocked = false;
    notify({ kind: "info", title: "媒体服务已恢复", body: "图片 / 音频预览恢复正常。" });
  }
});

try {
  startImageServer();
} catch (e) {
  console.warn("Image server failed to start", e);
}
createMenu();

// 先对齐"我这一版是几"，再打启动日志 —— 否则 app.start 里永远是 0.0.0（版本要等
// checkForUpdate 才填），事后根本分不清是哪一版写的日志。顺带在版本变化时记一条
// `update.applied from→to`，让"升级后起不来"这类问题能直接对上时间线。
await recordBootVersion();

logEvent({
  level: "info",
  source: "app",
  event: "app.start",
  message: `${APP_NAME} 主进程启动`,
  detail: {
    version: updateState.currentVersion,
    dataDir: Utils.paths.userData,
    platform: `${process.platform}/${process.arch}`,
    pid: process.pid,
    bun: Bun.version,
  },
});

const mainWindow = new BrowserWindow({
  title: APP_NAME,
  url: await getMainViewUrl(),
  rpc: appRPC,
  titleBarStyle: "hiddenInset",
  styleMask: {
    FullSizeContentView: true,
    Titled: true,
    Closable: true,
    Resizable: true,
    Miniaturizable: true,
  },
  frame: {
    width: 900,
    height: 700,
    x: 200,
    y: 200,
  },
});

setWindowRef(mainWindow);
initServerBroadcast(mainWindow);
initModelDownloadBroadcast(mainWindow);
initTTSModelDownloadBroadcast(mainWindow);
initGatewayBroadcast(mainWindow);
initTunnelBroadcast(mainWindow);
initEngineInstallBroadcast(mainWindow);
initMlxInstallBroadcast(mainWindow);
initMlxModelDownloadBroadcast(mainWindow);
initMediaSetupBroadcast(mainWindow);
initPpOcrBroadcast(mainWindow);
// JEV 的安装日志 / 权重下载进度：**桌面窗口这一份别漏** —— 只接到网页端那份 fake window
// 上时，桌面端点「下载」什么都看不到（状态查询是拉取、装完才知道，进度是推的）。
initSystemOneBroadcast(mainWindow);
initTessInstallBroadcast(mainWindow);
initSkillsBroadcast(mainWindow);
initBackupBroadcast(mainWindow);
initCanvasBroadcast(mainWindow);

mainWindow.webview.on("dom-ready", () => {
  broadcastUpdateStatus();
  // 刷新 / HMR 后 store 会重置，这里补推一次服务器与网关的当前状态。
  broadcastCurrentStatus(mainWindow);
});

// 网页端（/chat、/agent）：把 RPC 处理器表与推送总线接到网关上。
// 界面是同一份前端产物，所以这里注入的也是同一批实现（白名单在 rpc/index.ts）。
installWebBridge({
  dispatch: dispatchRemoteRpc,
  initBroadcast: initRemoteBroadcast,
  replayStatus: replayRemoteStatus,
});

// CLI 控制通道（Unix socket），供 `omi` 命令唤醒/导航/管理。
void startControlServer();

// Check for updates on startup（"关于我们 → 自动更新" 开关可关闭，仅手动检查）
if (getSetting("AUTO_UPDATE") !== "0") {
  checkForUpdate();
}

// 受管子进程扫尾：上次进程被强杀（SIGKILL / 崩溃 / 任务管理器）时会把
// llama.cpp / vLLM / SGLang / MLX / whisper / OCR 等推理进程留成带显存的孤儿，
// 占端口、吃显存。这里在数据目录与日志就绪之后、启动推理服务之前，把上次
// 遗留的受管子进程清掉（先核对身份再杀，核对不上宁可漏杀）。失败不挡启动。
void import("./child-registry")
  .then((m) => m.reapRecordedChildren())
  .catch((e) => {
    log.warn({
      source: "app",
      event: "child_reap.failed",
      message: `启动扫尾失败（不影响启动）：${e instanceof Error ? e.message : String(e)}`,
      detail: { error: e instanceof Error ? e.message : String(e) },
    });
  });

// 自愈被老版本写脏的聊天活动状态（老版本启动嵌入模型曾把 LOCAL_MODEL_PATH /
// CHAT_MODEL 写成嵌入模型）：三把键是 auto-start 找目标的依据，不清理的话会只
// 拉起嵌入实例、聊天没有模型可用。必须在 auto-start 之前跑。
const healed = healDriftedChatConfig();
if (healed.healed) {
  log.warn({
    source: "server",
    event: "chat_config.heal_drifted",
    message: `检测到聊天配置指向嵌入模型，已重置聊天模型配置：${healed.path ?? ""}`,
    detail: { path: healed.path },
  });
}

// Auto-start local server if configured and enabled
if (
  isConfigured() &&
  getSetting("SERVER_MODE") === "local" &&
  getSetting("AUTO_START_SERVER") !== "0"
) {
  ServerManager.startServer().then((result) => {
    if (result.ok) {
      console.log("Inference server started successfully");
    } else {
      log.error({
        source: "server",
        event: "server.start.failed",
        message: result.error ?? "推理服务器启动失败",
        detail: { trigger: "auto_start", engine: getSetting("INFERENCE_ENGINE") },
      });
      console.error("Failed to start inference server:", result.error);
    }
  });
}

// API 网关默认随应用启动（本地/云端都起）：统一对外提供 OpenAI / Anthropic / Responses
// 协议，按模型 ID 把请求路由到本地推理服务器或云端 API，供集成 CLI 与客户端使用。
if (Gateway.isGatewayEnabled()) {
  Gateway.startGateway().then((result) => {
    if (result.ok) {
      console.log("API gateway started successfully");
    } else {
      log.error({
        source: "gateway",
        event: "gateway.start.failed",
        message: result.error ?? "API 网关启动失败",
        detail: { trigger: "auto_start" },
      });
      console.error("Failed to start API gateway:", result.error);
    }
  });
}

// 内网穿透（可选，默认关）：按用户的期望状态恢复上次开着的隧道。
// 上一次进程被强杀时可能留下一条**没人管的公开隧道**，先清残留再对账。
Tunnel.cleanupStaleTunnel();
Tunnel.initTunnelGatewayBinding();
void Tunnel.reconcileTunnel("startup");

// 记忆库维护（启动后台跑一次）：补内容哈希、归档过期/长期未用的低价值记忆、补向量。
// 知识库维护：恢复上次进程遗留的摄取作业、对账分块计数、修剪审计流水。
// 都不阻塞窗口显示，也不影响首屏；失败只记日志。
void runMemoryMaintenance().catch((e) => {
  log.warn({
    source: "memory",
    event: "memory.maintenance.failed",
    message: e instanceof Error ? e.message : String(e),
    detail: { error: e },
  });
  console.error("Memory maintenance failed:", e instanceof Error ? e.message : String(e));
});
void Promise.resolve()
  .then(() => runKbMaintenance())
  .catch((e) => {
    log.warn({
      source: "kb",
      event: "kb.maintenance.failed",
      message: e instanceof Error ? e.message : String(e),
      detail: { error: e },
    });
    console.error("Knowledge base maintenance failed:", e instanceof Error ? e.message : String(e));
  });

// Handle window close
mainWindow.on("close", async () => {
  await teardownServices();
  Utils.quit();
});

// Cleanup on quit
Electrobun.events.on("before-quit", async () => {
  await teardownServices();
});

// Safety net for unexpected termination
process.on("SIGTERM", () => {
  logEvent({
    level: "warn",
    source: "app",
    event: "app.sigterm",
    message: "收到 SIGTERM，正在停止推理服务与子进程",
  });
  teardownServicesSync();
});
process.on("uncaughtException", (err) => {
  // 现场先落盘再退出：崩溃前最后一条 app.log 往往就是根因。
  logEvent({
    level: "error",
    source: "app",
    event: "app.uncaught_exception",
    message: err instanceof Error ? err.message : String(err),
    detail: { error: err, name: err instanceof Error ? err.name : undefined },
  });
  console.error("Uncaught exception:", err);
  teardownServicesSync();
});
// Bun 默认把未处理的 rejection 视为致命（打印后以非 0 退出）；这里显式接管，
// 保持同样的退出语义，但先把现场写进统一日志 —— 否则打包应用里什么都看不到。
process.on("unhandledRejection", (reason) => {
  logEvent({
    level: "error",
    source: "app",
    event: "app.unhandled_rejection",
    message: reason instanceof Error ? reason.message : String(reason),
    detail: { reason },
  });
  console.error("Unhandled rejection:", reason);
  teardownServicesSync();
  process.exit(1);
});

// 到这里启动已经走完：告诉启动守卫可以"交班"了 —— 之后再出异常由上面那几个
// 处理器按运行时语义处理，不再当成"起不来"去弹框。
markStartupReady();

log.info({ source: "app", event: "app.ready", message: `${APP_NAME} 已就绪（窗口与后台服务已启动）` });
console.log(`${APP_NAME} started!`);
