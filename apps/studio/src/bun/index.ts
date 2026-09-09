import "./canvas-polyfill";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import Electrobun, { Utils } from "electrobun/bun";
import { BrowserWindow, Updater } from "electrobun/bun";
import { db } from "./db";
import { join } from "path";
import { startImageServer } from "./image-server";
import { setWindowRef } from "./window";
import { appRPC, initServerBroadcast, initModelDownloadBroadcast, initTTSModelDownloadBroadcast, initGatewayBroadcast, initMlxInstallBroadcast } from "./rpc";
import { APP_NAME } from "./config";
import { createMenu } from "./menu";
import { broadcastUpdateStatus, checkForUpdate } from "./updates";
import { isConfigured, getSetting } from "./db/settings";
import * as ServerManager from "./server-manager";
import * as Gateway from "./gateway";
import { stopAsr } from "./asr";

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

// run migrations
migrate(db, { migrationsFolder: join(import.meta.dir, "db/migrations") });

// serve extracted images over HTTP for the webview
startImageServer();
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

mainWindow.webview.on("dom-ready", () => {
  broadcastUpdateStatus();
});

// Check for updates on startup
checkForUpdate();

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

  // 本地模式下默认启动 API 网关（OpenAI 兼容 + /docs 接口文档）。
  if (Gateway.isGatewayEnabled()) {
    Gateway.startGateway().then((result) => {
      if (result.ok) {
        console.log("API gateway started successfully");
      } else {
        console.error("Failed to start API gateway:", result.error);
      }
    });
  }
}

// Handle window close
mainWindow.on("close", async () => {
  await Promise.all([ServerManager.stopServer(), stopAsr(), Gateway.stopGateway()]);
  Utils.quit();
});

// Cleanup on quit
Electrobun.events.on("before-quit", async () => {
  await Promise.all([ServerManager.stopServer(), stopAsr(), Gateway.stopGateway()]);
});

// Safety net for unexpected termination
process.on("SIGTERM", () => {
  ServerManager.forceKill();
  void Gateway.stopGateway();
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  ServerManager.forceKill();
  void Gateway.stopGateway();
});

console.log(`${APP_NAME} started!`);
