// 必须最先导入：把 userData 目录写进 OMNI_DATA_DIR，供 ./db 定位数据库。
import "./user-data";
import "./canvas-polyfill";
import Electrobun, { Utils } from "electrobun/bun";
import { BrowserWindow, Updater } from "electrobun/bun";
import "./db";
import { startImageServer } from "./image-server";
import { setWindowRef } from "./window";
import { appRPC, initServerBroadcast, initModelDownloadBroadcast, initTTSModelDownloadBroadcast, initGatewayBroadcast, initMlxInstallBroadcast, initMlxModelDownloadBroadcast, initPpOcrBroadcast, initTessInstallBroadcast, initSkillsBroadcast, broadcastCurrentStatus } from "./rpc";
import { seedIfNeeded } from "./prompt-library";
import { initSkills, shutdownSkills } from "./skills";
import { APP_NAME } from "./config";
import { createMenu } from "./menu";
import { broadcastUpdateStatus, checkForUpdate } from "./updates";
import { isConfigured, getSetting } from "./db/settings";
import * as ServerManager from "./server-manager";
import * as Gateway from "./gateway";
import { stopAsr } from "./asr";
import { stopPpOcr } from "./ppocr";
import { startControlServer, stopControlServer } from "./control-server";
import { getAgentWorkspace } from "./agent";

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
try {
  startImageServer();
} catch (e) {
  // 已有一个实例占用端口（EADDRINUSE）时，图片由那个实例继续服务；
  // 这里不能因为一个可降级的服务让整个主进程启动即崩溃。
  console.warn("Image server failed to start (port already in use?)", e);
}
createMenu();

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
initMlxInstallBroadcast(mainWindow);
initMlxModelDownloadBroadcast(mainWindow);
initPpOcrBroadcast(mainWindow);
initTessInstallBroadcast(mainWindow);
initSkillsBroadcast(mainWindow);

mainWindow.webview.on("dom-ready", () => {
  broadcastUpdateStatus();
  // 刷新 / HMR 后 store 会重置，这里补推一次服务器与网关的当前状态。
  broadcastCurrentStatus(mainWindow);
});

// CLI 控制通道（Unix socket），供 `omi` 命令唤醒/导航/管理。
void startControlServer();

// Check for updates on startup（"关于我们 → 自动更新" 开关可关闭，仅手动检查）
if (getSetting("AUTO_UPDATE") !== "0") {
  checkForUpdate();
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
      console.error("Failed to start API gateway:", result.error);
    }
  });
}

// Handle window close
mainWindow.on("close", async () => {
  await Promise.all([ServerManager.stopServer(), stopAsr(), Gateway.stopGateway(), stopPpOcr()]);
  shutdownSkills();
  stopControlServer();
  Utils.quit();
});

// Cleanup on quit
Electrobun.events.on("before-quit", async () => {
  await Promise.all([ServerManager.stopServer(), stopAsr(), Gateway.stopGateway(), stopPpOcr()]);
  shutdownSkills();
  stopControlServer();
});

// Safety net for unexpected termination
process.on("SIGTERM", () => {
  ServerManager.forceKill();
  void Gateway.stopGateway();
  stopControlServer();
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  ServerManager.forceKill();
  void Gateway.stopGateway();
  stopControlServer();
});

console.log(`${APP_NAME} started!`);
