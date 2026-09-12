import { existsSync, unlinkSync, chmodSync } from "fs";
import { controlSocketPath } from "./paths";
import { getWindowRef } from "./window";
import * as ServerManager from "./server-manager";
import * as Gateway from "./gateway";
import { getSetting, updateSettings, getAllSettings, getActiveServerPort } from "./db/settings";
import { listInstalledModels, setActiveModel, getActiveModelPath, slugModelFileName } from "./model-store";
import { downloadManager } from "./download-manager";
import { updateState } from "./updates";
import * as Memory from "./memory";
import * as CloudProviders from "./cloud-providers";
import {
  startBenchmark,
  getBenchmarkRun,
  cancelBenchmark,
  listBenchmarkRecords,
} from "./benchmark";

/**
 * `omi` CLI 与应用的本地控制通道（Unix domain socket）。
 *
 * socket 文件即"应用是否在运行"的标志：CLI 先尝试连接，失败才用 `open`
 * 拉起应用。协议为 HTTP over unix socket，POST JSON `{ cmd, payload }`，
 * 响应 `{ ok, data | error }`。只监听本机用户目录下的 socket，权限 0600，
 * 无网络暴露。
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
            // 多实例下活动模型的端口未必等于引擎设置端口（见 model-servers.ts）。
            port: Number(getActiveServerPort()),
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

    case "downloadsList":
      return { ok: true, data: { tasks: downloadManager.list() } };

    case "downloadsResume": {
      // 把所有 paused / failed 的下载任务重新入队（磁盘空间恢复后可一键续传）。
      const tasks = downloadManager.list();
      const resumed: string[] = [];
      for (const t of tasks) {
        if ((t.status === "paused" || t.status === "failed") && downloadManager.resume(t.id)) {
          resumed.push(t.fileName);
        }
      }
      return { ok: true, data: { resumed, total: tasks.length } };
    }

    case "downloadsStart": {
      const repo = String(payload.repo ?? "");
      const fileName = String(payload.fileName ?? "");
      if (!repo || !fileName) return { ok: false, error: "缺少 repo / fileName" };
      const sizeHint = Number(payload.size);
      const task = downloadManager.start(
        repo,
        fileName,
        typeof payload.category === "string" ? (payload.category as never) : undefined,
        (payload.source as "modelscope" | "huggingface") ?? "modelscope",
        {
          size: Number.isFinite(sizeHint) && sizeHint > 0 ? sizeHint : null,
          explicit: payload.explicit === true,
        },
      );
      return { ok: true, data: { task } };
    }

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

    // 记忆写回通道：omi memory add / omni-memory MCP 桥接在应用运行时走这里，
    // 与应用内 Agent 工具写的是同一个库。
    case "memoryAdd": {
      const content = typeof payload.content === "string" ? payload.content : "";
      if (!content.trim()) return { ok: false, error: "content is required" };
      const outcome = await Memory.saveAgentMemory({
        content,
        category: typeof payload.category === "string" ? (payload.category as never) : undefined,
        tags: Array.isArray(payload.tags) ? payload.tags.map(String) : undefined,
        sourceRef: typeof payload.sourceRef === "string" ? payload.sourceRef : "cli",
      });
      if (!outcome.ok) return { ok: false, error: outcome.error };
      return { ok: true, data: { memory: outcome.result.memory, action: outcome.result.action } };
    }
    case "memorySearch": {
      const query = typeof payload.query === "string" ? payload.query : "";
      const limit = typeof payload.limit === "number" ? payload.limit : 8;
      const hits = await Memory.searchMemories(query, { limit, scope: "all" });
      return { ok: true, data: { memories: hits } };
    }
    case "memoryList": {
      const status = typeof payload.status === "string" ? (payload.status as never) : "open";
      return { ok: true, data: { memories: Memory.listMemories({ status, scope: "all" }) } };
    }
    case "memoryStats":
      return { ok: true, data: Memory.memoryStats() as unknown as Record<string, unknown> };
    case "memoryMaintain": {
      const result = await Memory.runMemoryMaintenance();
      return { ok: true, data: { ...result } };
    }
    case "memoryForget": {
      const id = Number(payload.id ?? 0);
      if (!Number.isFinite(id) || id <= 0) return { ok: false, error: "id is required" };
      return { ok: true, data: { deleted: Memory.deleteMemory(id) } };
    }
    case "memorySetStatus": {
      const id = Number(payload.id ?? 0);
      const status = String(payload.status ?? "");
      if (!Number.isFinite(id) || id <= 0) return { ok: false, error: "id is required" };
      if (!["active", "pending", "archived", "superseded"].includes(status)) return { ok: false, error: "invalid status" };
      Memory.setMemoryStatus(id, status as never);
      return { ok: true, data: { id, status } };
    }
    case "memoryPending":
      return { ok: true, data: { memories: Memory.pendingMemories() } };
    case "memoryExport":
      return { ok: true, data: Memory.exportMemories() as unknown as Record<string, unknown> };
    case "memoryImport": {
      const result = await Memory.importMemories(payload.payload);
      return { ok: true, data: { ...result, errors: result.errors.slice(0, 5) } };
    }

    // 基准测速：omi benchmark 走这里（应用内 UI 与 CLI 共用同一任务单例与历史表）。
    case "benchmark": {
      const contexts = Array.isArray(payload.contexts)
        ? payload.contexts.map(Number).filter((n) => Number.isFinite(n))
        : undefined;
      const result = startBenchmark({
        model: typeof payload.model === "string" ? payload.model : "",
        providerId: typeof payload.providerId === "string" ? payload.providerId : undefined,
        genLength: Number(payload.genLength) || undefined,
        batchSize: Number(payload.batchSize) || undefined,
        temperature: Number.isFinite(Number(payload.temperature)) ? Number(payload.temperature) : undefined,
        contexts,
      });
      if ("error" in result) return { ok: false, error: result.error };
      return { ok: true, data: { runId: result.runId } };
    }
    case "benchmarkRun": {
      return { ok: true, data: { run: getBenchmarkRun(String(payload.runId ?? "")) } };
    }
    case "benchmarkCancel": {
      return { ok: true, data: cancelBenchmark(String(payload.runId ?? "")) };
    }
    case "benchmarkRecords": {
      return { ok: true, data: { records: listBenchmarkRecords() } };
    }
    // --cloud 服务商解析用：完整 cloud_providers 表（"models" 只回激活槽位）。
    case "cloudProviders": {
      return { ok: true, data: CloudProviders.listCloudProviders() };
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
