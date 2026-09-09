import { getSetting } from "./db/settings";
import { getStatus as getInferenceStatus } from "./server-manager";
import * as TTSLocal from "./tts-local";
import * as Asr from "./asr";
import { getTTSProviderConfig } from "./voice";

/**
 * 本地 API 网关。
 *
 * 本地服务启动后默认在本机开一个 OpenAI 兼容的模型服务（默认 10000 端口），
 * 把本机各推理后端（llama.cpp / vLLM / SGLang、whisper-server、audio.cpp TTS）
 * 在同一个端口暴露出来，并自带 FastAPI 风格的接口文档：
 *   - GET  /docs          Swagger UI
 *   - GET  /redoc         ReDoc
 *   - GET  /openapi.json  OpenAPI 3.0 规范
 *   - GET  /v1/models     模型列表
 *   - POST /v1/chat/completions        对话补全（支持流式透传）
 *   - POST /v1/audio/speech            语音合成 TTS
 *   - POST /v1/audio/transcriptions    语音识别 ASR
 *   - POST /v1/images/generations      文本生图（预留）
 *   - GET  /health       健康检查
 */

export type GatewayStatus = "stopped" | "starting" | "running" | "error";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept",
};

type StatusListener = (status: GatewayStatus) => void;

let server: ReturnType<typeof Bun.serve> | null = null;
let status: GatewayStatus = "stopped";
let lastError = "";
let boundHost = "127.0.0.1";
let boundPort = 10000;
let boundConfiguredPort = 10000;

const statusListeners = new Set<StatusListener>();

function setStatus(next: GatewayStatus) {
  status = next;
  for (const cb of statusListeners) {
    try {
      cb(next);
    } catch {
      // ignore
    }
  }
}

export function onGatewayStatusChange(cb: StatusListener): () => void {
  statusListeners.add(cb);
  return () => statusListeners.delete(cb);
}

export function getGatewayStatus(): {
  status: GatewayStatus;
  host: string;
  port: number;
  configuredPort: number;
  url: string;
  error?: string;
  notice?: string;
} {
  return {
    status,
    host: boundHost,
    port: boundPort,
    configuredPort: boundConfiguredPort,
    url: `http://${boundHost}:${boundPort}`,
    error: lastError || undefined,
    notice:
      boundConfiguredPort !== boundPort
        ? `端口 ${boundConfiguredPort} 被其它程序占用，已自动改用 ${boundPort}`
        : undefined,
  };
}

export function isGatewayEnabled(): boolean {
  return getSetting("GATEWAY_ENABLED") !== "0";
}

/** 网关应绑定的地址/端口（从设置读取，用于展示）。 */
export function getGatewayConfig(): { host: string; port: number } {
  return {
    host: getSetting("GATEWAY_HOST") || "127.0.0.1",
    port: Number(getSetting("GATEWAY_PORT") || 10000),
  };
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extra },
  });
}

/** OpenAI 风格错误体：{ "error": { "message", "type", "code" } } */
function apiError(status: number, message: string, type = "invalid_request_error"): Response {
  return json({ error: { message, type, code: status } }, status);
}

function getUpstreamBase(): string {
  const host = getSetting("SERVER_HOST") || "127.0.0.1";
  const port = getSetting("SERVER_PORT") || "8080";
  return `http://${host}:${port}`;
}

function authHeaders(): Record<string, string> {
  const apiKey = getSetting("VLLM_API_KEY");
  return apiKey && apiKey !== "EMPTY" ? { Authorization: `Bearer ${apiKey}` } : {};
}

/** 把上游响应的错误转发为标准 OpenAI 风格错误。 */
async function forwardUpstreamError(res: Response, fallback: string): Promise<Response> {
  const body = await res.text().catch(() => "");
  if (body) {
    try {
      return json(JSON.parse(body), res.status);
    } catch {
      return json(
        { error: { message: body.slice(0, 300), type: "upstream_error", code: res.status } },
        res.status,
      );
    }
  }
  return apiError(res.status || 502, fallback, "upstream_error");
}

// ---------------------------------------------------------------------------
// 上游能力探测（决定 /v1/models 与 TTS/ASR 路由）
// ---------------------------------------------------------------------------

async function ttsBackendAvailable(): Promise<boolean> {
  const local = await TTSLocal.getTtsLocalStatus();
  if (local.active) return true;
  if (getTTSProviderConfig().base) return true;
  return false;
}

async function asrBackendAvailable(): Promise<boolean> {
  const asr = await Asr.getAsrStatus();
  if (asr.serverRunning) return true;
  if (Asr.getASRProviderConfig().base.trim()) return true;
  return false;
}

async function listUpstreamModels(): Promise<unknown[]> {
  const base = getUpstreamBase();
  try {
    const res = await fetch(`${base}/v1/models`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return [];
    const body = (await res.json().catch(() => null)) as { data?: unknown[] } | null;
    return body?.data ?? [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// OpenAPI 文档
// ---------------------------------------------------------------------------

function openApiSpec(): Record<string, unknown> {
  const { host, port } = getGatewayConfig();
  return {
    openapi: "3.0.2",
    info: {
      title: "OmniStudio Local Gateway",
      version: "1.0.0",
      description:
        "OmniStudio 本地 OpenAI 兼容模型服务。聚合本机推理后端（对话、TTS、ASR），" +
        "支持流式对话、语音合成、语音识别。默认端口 10000。",
    },
    servers: [{ url: `http://${host}:${port}` }],
    paths: {
      "/health": {
        get: {
          summary: "健康检查",
          description: "网关自身健康状态，并附带上游推理服务的运行状态。",
          responses: { "200": { description: "OK" } },
        },
      },
      "/v1/models": {
        get: {
          summary: "列出可用模型",
          description: "返回本机可用的模型列表（含上游推理服务器模型与网关能力模型）。",
          responses: { "200": { description: "模型列表" } },
        },
      },
      "/v1/chat/completions": {
        post: {
          summary: "对话补全",
          description: "OpenAI 兼容 Chat Completions，转发到本地推理服务器；`stream: true` 时以 SSE 流式返回。",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ChatCompletionRequest" },
              },
            },
          },
          responses: {
            "200": { description: "补全结果（非流式为 JSON，流式为 SSE）" },
            "503": { description: "推理服务器未运行" },
          },
        },
      },
      "/v1/audio/speech": {
        post: {
          summary: "文本转语音（TTS）",
          description: "OpenAI 兼容语音合成。优先使用本地 audio.cpp 引擎，其次转发到推理服务器 / 远端 TTS 服务。",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SpeechRequest" },
              },
            },
          },
          responses: {
            "200": { description: "合成音频（audio/wav）" },
            "501": { description: "没有可用的 TTS 后端" },
          },
        },
      },
      "/v1/audio/transcriptions": {
        post: {
          summary: "语音识别（ASR）",
          description: "OpenAI 兼容语音转写（multipart/form-data，字段 `file`）。优先使用 whisper-server，其次远端 ASR 服务。",
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  properties: {
                    file: { type: "string", format: "binary", description: "音频文件（wav / mp3 / m4a 等）" },
                    model: { type: "string" },
                    response_format: { type: "string", enum: ["json", "text", "verbose_json"] },
                  },
                  required: ["file"],
                },
              },
            },
          },
          responses: {
            "200": { description: "转写结果" },
            "501": { description: "没有可用的 ASR 后端" },
          },
        },
      },
      "/v1/images/generations": {
        post: {
          summary: "文本生图（预留）",
          description: "文生图接口，后端尚未接入，当前返回 501。",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    model: { type: "string" },
                    prompt: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "501": { description: "尚未实现" },
          },
        },
      },
    },
    components: {
      schemas: {
        ChatCompletionRequest: {
          type: "object",
          required: ["messages"],
          properties: {
            model: { type: "string", description: "模型 ID" },
            messages: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  role: { type: "string", enum: ["system", "user", "assistant"] },
                  content: { type: "string" },
                },
              },
            },
            stream: { type: "boolean", description: "SSE 流式返回", default: false },
            temperature: { type: "number" },
            max_tokens: { type: "integer" },
          },
        },
        SpeechRequest: {
          type: "object",
          required: ["input"],
          properties: {
            model: { type: "string", description: "TTS 模型 / 音色 ID（可选）" },
            input: { type: "string", description: "要合成的文本" },
            voice: { type: "string", description: "音色（可选）" },
            response_format: { type: "string", enum: ["wav", "mp3"], default: "wav" },
            speed: { type: "number", default: 1 },
          },
        },
      },
    },
  };
}

function swaggerUiHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>OmniStudio Local Gateway — API Docs</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css"/>
  <style>body { margin: 0; }</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.onload = function () {
      window.ui = SwaggerUIBundle({
        url: "/openapi.json",
        dom_id: "#swagger-ui",
        deepLinking: true,
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
        layout: "BaseLayout"
      });
    };
  </script>
</body>
</html>`;
}

function redocHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>OmniStudio Local Gateway — ReDoc</title>
  <style>body { margin: 0; padding: 0; }</style>
</head>
<body>
  <redoc spec-url="/openapi.json"></redoc>
  <script src="https://cdn.jsdelivr.net/npm/redoc@next/bundles/redoc.standalone.js"></script>
</body>
</html>`;
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", ...CORS },
  });
}

// ---------------------------------------------------------------------------
// 各端点实现
// ---------------------------------------------------------------------------

async function handleChatCompletions(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return apiError(400, "请求体必须是合法 JSON");
  }

  if (getInferenceStatus() !== "running") {
    return apiError(503, "推理服务器未运行，请先在应用内启动模型", "server_error");
  }

  const upstream = fetch(`${getUpstreamBase()}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600_000),
  });

  try {
    const res = await upstream;
    if (!res.ok) return forwardUpstreamError(res, "推理服务器返回错误");

    const contentType = res.headers.get("content-type") ?? "application/json";
    return new Response(res.body, {
      status: res.status,
      headers: { "Content-Type": contentType, ...CORS },
    });
  } catch (e) {
    return apiError(502, `转发失败：${e instanceof Error ? e.message : String(e)}`, "upstream_error");
  }
}

async function handleSpeech(req: Request): Promise<Response> {
  let body: { model?: string; input?: string; voice?: string; response_format?: string; speed?: number } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return apiError(400, "请求体必须是合法 JSON");
  }
  const text = (body.input ?? "").trim();
  if (!text) return apiError(400, "缺少 input 字段");

  // 1) 本地 audio.cpp 引擎（优先）
  const local = await TTSLocal.getTtsLocalStatus();
  if (local.active && local.activeModelId) {
    try {
      const record = await TTSLocal.runTTSLocal({
        text,
        voice: body.voice,
        model: body.model,
      });
      if (record.audioUrl) {
        const audio = await fetch(record.audioUrl, { signal: AbortSignal.timeout(120_000) });
        if (audio.ok) {
          const buf = await audio.arrayBuffer();
          return new Response(buf, {
            headers: {
              "Content-Type": "audio/wav",
              "Content-Disposition": 'inline; filename="speech.wav"',
              ...CORS,
            },
          });
        }
      }
      return apiError(500, "本地合成完成但无法读取音频文件", "tts_error");
    } catch (e) {
      return apiError(500, e instanceof Error ? e.message : String(e), "tts_error");
    }
  }

  // 2) 推理服务器（vLLM 等可托管 TTS 模型）
  if (getInferenceStatus() === "running") {
    try {
      const res = await fetch(`${getUpstreamBase()}/v1/audio/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(600_000),
      });
      if (res.ok) {
        return new Response(res.body, {
          status: res.status,
          headers: { "Content-Type": res.headers.get("content-type") ?? "audio/wav", ...CORS },
        });
      }
      if (res.status === 404 || res.status === 501) {
        return apiError(501, "推理服务器不支持 /v1/audio/speech，且本地 TTS 引擎未启用", "not_implemented");
      }
      return forwardUpstreamError(res, "上游 TTS 返回错误");
    } catch (e) {
      return apiError(502, `转发失败：${e instanceof Error ? e.message : String(e)}`, "upstream_error");
    }
  }

  return apiError(501, "没有可用的 TTS 后端：请先启用本地 audio.cpp 引擎或启动推理服务器", "not_implemented");
}

/** 把 multipart 请求原样转发给上游 ASR 端点（保留 boundary）。body 必须是可复用对象（如 Blob）。 */
async function proxyAsr(body: Blob, contentType: string | null, base: string, path = "/v1/audio/transcriptions"): Promise<Response> {
  const headers: Record<string, string> = {};
  if (contentType) headers["Content-Type"] = contentType;
  return fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(600_000),
  });
}

async function handleTranscriptions(req: Request): Promise<Response> {
  if (!req.body) return apiError(400, "缺少请求体");

  const contentType = req.headers.get("content-type");
  if (!contentType || !contentType.startsWith("multipart/form-data")) {
    return apiError(415, "需要 multipart/form-data（字段 file）", "invalid_request_error");
  }

  // 先把请求体完整读入内存（可能需要 404 后回退 /inference，流只能消费一次）。
  const body = new Blob([await req.arrayBuffer()]);

  // 1) whisper-server（本地）
  const asr = await Asr.getAsrStatus();
  if (asr.serverRunning) {
    const base = `http://127.0.0.1:${asr.port}`;
    try {
      let res = await proxyAsr(body, contentType, base, "/v1/audio/transcriptions");
      // 新版 whisper.cpp 移除了 OpenAI 兼容端点，回退 /inference。
      if (res.status === 404) {
        res = await proxyAsr(body, contentType, base, "/inference");
      }
      if (res.ok) {
        return new Response(res.body, {
          status: res.status,
          headers: { "Content-Type": res.headers.get("content-type") ?? "application/json", ...CORS },
        });
      }
      return forwardUpstreamError(res, "whisper-server 转写失败");
    } catch (e) {
      return apiError(502, `whisper-server 请求失败：${e instanceof Error ? e.message : String(e)}`, "upstream_error");
    }
  }

  // 2) 远端 ASR Provider
  const provider = Asr.getASRProviderConfig();
  if ((provider.base ?? "").trim()) {
    try {
      const res = await proxyAsr(body, contentType, provider.base.replace(/\/+$/, ""), "/v1/audio/transcriptions");
      if (res.ok) {
        return new Response(res.body, {
          status: res.status,
          headers: { "Content-Type": res.headers.get("content-type") ?? "application/json", ...CORS },
        });
      }
      return forwardUpstreamError(res, "远端 ASR 服务转写失败");
    } catch (e) {
      return apiError(502, `远端 ASR 请求失败：${e instanceof Error ? e.message : String(e)}`, "upstream_error");
    }
  }

  return apiError(501, "没有可用的 ASR 后端：请先启动 whisper-server 或配置远端 ASR 服务", "not_implemented");
}

async function handleListModels(): Promise<Response> {
  const [upstream, tts, asrAvail] = await Promise.all([
    listUpstreamModels(),
    ttsBackendAvailable(),
    asrBackendAvailable(),
  ]);

  const extra: { id: string; object: string; owned_by: string; task?: string }[] = [];
  if (tts) {
    extra.push({ id: "omni-tts", object: "model", owned_by: "omni-studio", task: "text-to-speech" });
  }
  if (asrAvail) {
    extra.push({ id: "omni-asr", object: "model", owned_by: "omni-studio", task: "automatic-speech-recognition" });
  }
  // 文生图后端预留：始终声明，客户端可据此判断能力（调用后返回 501）。
  extra.push({ id: "omni-image", object: "model", owned_by: "omni-studio", task: "text-to-image" });

  return json({ object: "list", data: [...upstream, ...extra] });
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

async function route(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(req.url);
  const path = url.pathname;

  switch (path) {
    case "/":
      return json({
        name: "OmniStudio Local Gateway",
        docs: "/docs",
        redoc: "/redoc",
        openapi: "/openapi.json",
        endpoints: [
          "GET  /v1/models",
          "POST /v1/chat/completions",
          "POST /v1/audio/speech",
          "POST /v1/audio/transcriptions",
          "POST /v1/images/generations",
          "GET  /health",
        ],
      });
    case "/health":
      return json({
        status: "ok",
        gateway: true,
        upstream: getInferenceStatus(),
        timestamp: Date.now(),
      });
    case "/openapi.json":
      return json(openApiSpec());
    case "/docs":
      return htmlResponse(swaggerUiHtml());
    case "/redoc":
      return htmlResponse(redocHtml());
    case "/v1/models":
      if (req.method !== "GET") return apiError(405, "Method Not Allowed");
      return handleListModels();
    case "/v1/chat/completions":
      if (req.method !== "POST") return apiError(405, "Method Not Allowed");
      return handleChatCompletions(req);
    case "/v1/audio/speech":
      if (req.method !== "POST") return apiError(405, "Method Not Allowed");
      return handleSpeech(req);
    case "/v1/audio/transcriptions":
      if (req.method !== "POST") return apiError(405, "Method Not Allowed");
      return handleTranscriptions(req);
    case "/v1/images/generations":
      return apiError(501, "文本生图后端尚未接入", "not_implemented");
    default:
      return apiError(404, `未知路径 ${path}`, "not_found");
  }
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

export async function startGateway(): Promise<{ ok: boolean; error?: string; port?: number }> {
  if (status === "running") return { ok: true };
  if (!isGatewayEnabled()) {
    return { ok: false, error: "网关已禁用（GATEWAY_ENABLED=0）" };
  }

  const { host, port: configuredPort } = getGatewayConfig();
  if (!Number.isFinite(configuredPort) || configuredPort <= 0 || configuredPort > 65535) {
    return { ok: false, error: `无效的网关端口：${configuredPort}` };
  }

  lastError = "";
  setStatus("starting");

  // 配置端口可能被本机其它程序占用（10000 常被网盘类软件占用）。
  // 依次顺延到空闲端口，并把真实端口记下来供界面展示。
  for (let i = 0; i < 20; i++) {
    const port = configuredPort + i;
    if (port > 65535) break;
    try {
      server = Bun.serve({ hostname: host, port, fetch: route });
      boundHost = host;
      boundPort = port;
      boundConfiguredPort = configuredPort;
      setStatus("running");
      console.log(
        `Gateway running on http://${host}:${port}${
          port !== configuredPort ? ` (configured ${configuredPort} busy)` : ""
        }`,
      );
      return { ok: true, port };
    } catch {
      // 端口被占用，尝试下一个。
    }
  }

  lastError = `端口 ${configuredPort}~${Math.min(configuredPort + 19, 65535)} 均被占用`;
  setStatus("error");
  return { ok: false, error: lastError };
}

export async function stopGateway(): Promise<void> {
  if (server) {
    try {
      server.stop();
    } catch {
      // already stopped
    }
    server = null;
  }
  setStatus("stopped");
}

export async function restartGateway(): Promise<{ ok: boolean; error?: string }> {
  await stopGateway();
  return startGateway();
}
