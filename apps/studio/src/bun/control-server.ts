import { existsSync, unlinkSync, chmodSync } from "fs";
import { controlSocketPath } from "./paths";
import { getWindowRef } from "./window";
import * as ServerManager from "./server-manager";
import * as Gateway from "./gateway";
import { getSetting, updateSettings, getAllSettings } from "./db/settings";
import { listInstalledModels, setActiveModel, getActiveModelPath, slugModelFileName } from "./model-store";
import { updateState } from "./updates";
import * as Memory from "./memory";

/**
 * `omi` CLI 与应用的本地控制通道（Unix domain socket）。
 *
 * 参照 omlx 的 `control.sock` 设计：socket 文件即"应用是否在运行"的标志，
 * CLI 先尝试连接，失败才用 `open` 拉起应用。协议为 HTTP over unix socket，
 * POST JSON `{ cmd, payload }`，响应 `{ ok, data | error }`。
 * 只监听本机用户目录下的 socket，权限 0600，无网络暴露。
 */

type ControlRequest = { cmd: string; payload?: Record<string, unknown> };

export type ControlResponse = { ok: boolean; data?: unknown; error?: string };

let server: ReturnType<typeof Bun.serve> | undefined;

function cloudModelsFromSettings(): unknown[] {
  try {
    const raw = getAllSettings().CLOUD_MODELS ?? "";
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function handle(req: ControlRequest): Promise<ControlResponse> {
  const payload = req.payload ?? {};
  const win = () => getWindowRef();

  switch (req.cmd) {
    case "ping":
      return { ok: true, data: { version: updateState.currentVersion, pid: process.pid } };

    case "activate":
      win()?.show();
      return { ok: true };

    case "navigate": {
      const path = String(payload.path ?? "");
      if (!path) return { ok: false, error: "缺少 path" };
      win()?.show();
      try {
        win().webview.rpc?.send.navigate({ path });
      } catch (err) {
        return { ok: false, error: String(err) };
      }
      return { ok: true };
    }

    case "status": {
      const gateway = Gateway.getGatewayStatus();
      return {
        ok: true,
        data: {
          server: {
            status: ServerManager.getStatus(),
            pid: ServerManager.getPid(),
            host: getSetting("SERVER_HOST") || "127.0.0.1",
            port: Number(getSetting("SERVER_PORT") || 8080),
            engine: getSetting("INFERENCE_ENGINE") || "llama.cpp",
            logs: ServerManager.getLogs().slice(-8000),
            error: ServerManager.getLastError() || undefined,
          },
          gateway: { ...gateway },
          mode: getSetting("SERVER_MODE"),
          version: updateState.currentVersion,
        },
      };
    }

    case "serverStart": {
      const result = await ServerManager.startServer();
      return {
        ok: result.ok,
        error: result.error,
        data: { status: ServerManager.getStatus(), pid: ServerManager.getPid() },
      };
    }

    case "serverStop": {
      await ServerManager.stopServer();
      return { ok: true, data: { status: ServerManager.getStatus() } };
    }

    case "serverRestart": {
      const result = await ServerManager.restartServer();
      return {
        ok: result.ok,
        error: result.error,
        data: { status: ServerManager.getStatus(), pid: ServerManager.getPid() },
      };
    }

    case "serverLogs":
      return { ok: true, data: { logs: ServerManager.getLogs() } };

    case "serverClearLogs": {
      ServerManager.clearLogs();
      return { ok: true };
    }

    case "launchCommand": {
      const modelOverride = typeof payload.model === "string" ? payload.model : undefined;
      const result = ServerManager.getLaunchCommand(modelOverride);
      return { ok: true, data: result };
    }

    case "checkBinary":
      return { ok: true, data: ServerManager.checkBinaryExists() };

    case "gatewayStart": {
      const result = await Gateway.startGateway();
      return { ok: result.ok, error: result.error, data: { ...Gateway.getGatewayStatus() } };
    }

    case "gatewayStop": {
      await Gateway.stopGateway();
      return { ok: true, data: { ...Gateway.getGatewayStatus() } };
    }

    case "gatewayRestart": {
      const result = await Gateway.restartGateway();
      return { ok: result.ok, error: result.error, data: { ...Gateway.getGatewayStatus() } };
    }

    case "gatewayStatus":
      return { ok: true, data: { ...Gateway.getGatewayStatus(), apiKey: Gateway.getGatewayApiKey() } };

    // 记忆写回通道：omi memory add / omi-memory MCP 桥接在应用运行时走这里，
    // 与应用内 Agent 工具写的是同一个库。
    case "memoryAdd": {
      const content = typeof payload.content === "string" ? payload.content : "";
      if (!content.trim()) return { ok: false, error: "content is required" };
      const category = typeof payload.category === "string" ? payload.category : undefined;
      const tags = Array.isArray(payload.tags) ? payload.tags.map(String) : undefined;
      const memory = Memory.saveAgentMemory(content, category as never, tags);
      return { ok: true, data: { memory } };
    }
    case "memorySearch": {
      const query = typeof payload.query === "string" ? payload.query : "";
      const limit = typeof payload.limit === "number" ? payload.limit : 8;
      return { ok: true, data: { memories: Memory.searchMemories(query, limit) } };
    }
    case "memoryList": {
      return { ok: true, data: { memories: Memory.listMemories() } };
    }

    case "models": {
      const activePath = getActiveModelPath();
      const installed = listInstalledModels().map((m) => ({
        ...m,
        servedName: slugModelFileName(m.fileName),
        isActive: m.path === activePath,
      }));
      return {
        ok: true,
        data: {
          installed,
          cloud: cloudModelsFromSettings(),
          cloudProvider: getAllSettings().CLOUD_PROVIDER ?? "",
          mode: getSetting("SERVER_MODE"),
          activePath,
        },
      };
    }

    case "setActiveModel": {
      const path = String(payload.path ?? "");
      const result = setActiveModel(path);
      return { ok: result.ok, error: result.error };
    }

    case "getSettings":
      return { ok: true, data: getAllSettings() };

    case "updateSettings": {
      const values = payload.settings;
      if (!values || typeof values !== "object") {
        return { ok: false, error: "缺少 settings 对象" };
      }
      updateSettings(values as Record<string, string>);
      return { ok: true };
    }

    default:
      return { ok: false, error: `unknown command: ${req.cmd}` };
  }
}

/** Probe whether something is already listening on the socket (another instance). */
async function isSocketLive(sockPath: string): Promise<boolean> {
  if (!existsSync(sockPath)) return false;
  try {
    const res = await fetch("http://control", {
      unix: sockPath,
      method: "POST",
      body: JSON.stringify({ cmd: "ping" }),
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function startControlServer(): Promise<void> {
  const sockPath = controlSocketPath();
  if (await isSocketLive(sockPath)) {
    // 已有一个实例在监听 —— 不抢锁，直接复用（单实例语义）。
    console.log(`Control server already listening at ${sockPath}`);
    return;
  }
  if (existsSync(sockPath)) {
    try {
      unlinkSync(sockPath); // 残留的 stale socket
    } catch {
      // ignore
    }
  }
  try {
    server = Bun.serve({
      unix: sockPath,
      fetch: async (req) => {
        if (req.method !== "POST") {
          return new Response("method not allowed", { status: 405 });
        }
        let body: ControlRequest;
        try {
          body = (await req.json()) as ControlRequest;
        } catch {
          return Response.json({ ok: false, error: "invalid json body" }, { status: 400 });
        }
        const response = await handle(body);
        return Response.json(response);
      },
    });
    chmodSync(sockPath, 0o600);
    console.log(`Control server listening at ${sockPath}`);
  } catch (err) {
    console.error("Failed to start control server:", err);
  }
}

export function stopControlServer(): void {
  try {
    server?.stop(true);
  } catch {
    // ignore
  }
  server = undefined;
  const sockPath = controlSocketPath();
  if (existsSync(sockPath)) {
    try {
      unlinkSync(sockPath);
    } catch {
      // ignore
    }
  }
}
