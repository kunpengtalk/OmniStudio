// 必须最先导入：把 userData 目录写进 OMNI_DATA_DIR，供 ./db 定位数据库。
import "./user-data";
import "./canvas-polyfill";
import Electrobun, { Utils } from "electrobun/bun";
import { BrowserWindow, Updater } from "electrobun/bun";
import "./db";
import { startImageServer, onMediaServerStatusChange } from "./image-server";
import { closeAllTerminals } from "./terminal-sessions";
import { setWindowRef } from "./window";
import { appRPC, initServerBroadcast, initModelDownloadBroadcast, initTTSModelDownloadBroadcast, initGatewayBroadcast, initTunnelBroadcast, initEngineInstallBroadcast, initMlxInstallBroadcast, initMlxModelDownloadBroadcast, initMediaSetupBroadcast, initPpOcrBroadcast, initTessInstallBroadcast, initSkillsBroadcast, initBackupBroadcast, broadcastCurrentStatus, dispatchRemoteRpc, initRemoteBroadcast, replayRemoteStatus } from "./rpc";
import { installWebBridge } from "./gateway-web";
import { seedIfNeeded } from "./prompt-library";
import { initSkills, shutdownSkills } from "./skills";
import { APP_NAME } from "./config";
import { createMenu } from "./menu";
import { broadcastUpdateStatus, checkForUpdate, updateState } from "./updates";
import { isConfigured, getSetting } from "./db/settings";
import * as ServerManager from "./server-manager";
import { stopAllServed } from "./model-servers";
import { healDriftedChatConfig } from "./model-store";
import * as Gateway from "./gateway";
import * as Tunnel from "./tunnel";
import { stopAsr } from "./asr";
import { stopPpOcr } from "./ppocr";
import { startControlServer, stopControlServer } from "./control-server";
import { getAgentWorkspace } from "./agent";
import { runMemoryMaintenance } from "./memory";
import { runKbMaintenance } from "./knowledge";
import { notify } from "./notifications";
import { log, logEvent, mirrorConsole } from "./app-log";
import { installProxy } from "./proxy";

// 统一日志最先装好：从这一行之后，主进程的 console.* 与关键失败都会落到
// `<数据目录>/logs/app.log`（排查入口见 `omi logs` / `omi diag`）。
mirrorConsole("app");

// 代理（设置 → 偏好 → 通用）要在任何网络请求之前接上：这一行之后，云端模型、
// 模型/引擎下载、联网检索与子进程都会按设置走代理，回环与局域网直连。
installProxy();

// Check if Vite dev server is running for HMR
async function getMainViewUrl(): Promise<string> {
  const channel = await Updater.localInfo.channel();
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
initTessInstallBroadcast(mainWindow);
initSkillsBroadcast(mainWindow);
initBackupBroadcast(mainWindow);

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
  // 停掉**全部**已启动模型：推理进程是 detached 的，漏一个就留下占显存的孤儿。
  // 隧道同理：漏掉就是留一条公开入口，所以先同步掐掉它（不等 cloudflared 优雅退出）。
  Tunnel.stopTunnelSync();
  await Promise.all([stopAllServed(), stopAsr(), Gateway.stopGateway(), stopPpOcr()]);
  // 侧边面板里的终端 shell：跟着窗口一起收掉，别留下没人管的会话。
  closeAllTerminals();
  shutdownSkills();
  stopControlServer();
  Utils.quit();
});

// Cleanup on quit
Electrobun.events.on("before-quit", async () => {
  Tunnel.stopTunnelSync();
  await Promise.all([stopAllServed(), stopAsr(), Gateway.stopGateway(), stopPpOcr()]);
  closeAllTerminals();
  shutdownSkills();
  stopControlServer();
});

// Safety net for unexpected termination
process.on("SIGTERM", () => {
  logEvent({
    level: "warn",
    source: "app",
    event: "app.sigterm",
    message: "收到 SIGTERM，正在停止推理服务与子进程",
  });
  ServerManager.forceKill();
  Tunnel.stopTunnelSync();
  void Gateway.stopGateway();
  stopControlServer();
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
  ServerManager.forceKill();
  Tunnel.stopTunnelSync();
  void Gateway.stopGateway();
  stopControlServer();
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
  ServerManager.forceKill();
  Tunnel.stopTunnelSync();
  void Gateway.stopGateway();
  stopControlServer();
  process.exit(1);
});

log.info({ source: "app", event: "app.ready", message: `${APP_NAME} 已就绪（窗口与后台服务已启动）` });
console.log(`${APP_NAME} started!`);
