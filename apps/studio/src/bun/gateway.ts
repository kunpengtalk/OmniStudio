import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import { getSetting, updateSettings, getActiveServerPort } from "./db/settings";
import * as ServerManager from "./server-manager";
import * as TTSLocal from "./tts-local";
import * as Asr from "./asr";
import { getTTSProviderConfig, listProviderModels, runTTSEdge } from "./voice";
import { listInstalledModels, slugModelFileName } from "./model-store";
import * as Memory from "./memory";
import type { MemoryCategory } from "../shared/memory";
import { handleMcpRequest } from "./kb-mcp";
import * as Img from "./gateway-images";
import { isLocalOrigin, isLoopbackHost } from "../shared/server-info";

/**
 * 本地 API 网关。
 *
 * 本地服务启动后默认在本机开一个统一模型服务（默认 10000 端口），
 * 把本机各推理后端（llama.cpp / vLLM / SGLang、whisper-server、audio.cpp TTS）
 * 以及已配置的云端 OpenAI 兼容 API 在同一个端口聚合代理，并自带接口文档：
 *   - GET  /docs          Swagger UI
 *   - GET  /redoc         ReDoc
 *   - GET  /openapi.json  OpenAPI 3.0 规范
 *   - GET  /v1/models     模型列表（本地 + 云端 + TTS/ASR 能力模型）
 *   - POST /v1/chat/completions        OpenAI Chat Completions（流式透传）
 *   - POST /v1/responses               OpenAI Responses API（流式 + 非流式）
 *   - POST /v1/messages                Anthropic Messages API（流式 + 非流式）
 *   - POST /v1/audio/speech            语音合成 TTS（本地 → 推理服务器 → 云端 provider → Edge 在线）
 *   - POST /v1/audio/transcriptions    语音识别 ASR（whisper-server → 远端 ASR）
 *   - POST /v1/images/generations      文本生图（MLX 本地引擎 → OpenAI 兼容 API → ComfyUI）
 *   - GET  /health       健康检查
 *
 * 鉴权：设置 GATEWAY_API_KEY 后，所有 /v1/* 端点需要
 * `Authorization: Bearer <key>` 或 `x-api-key: <key>`（兼容 Anthropic 客户端）。
 */

export type GatewayStatus = "stopped" | "starting" | "running" | "error";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, x-api-key, anthropic-version",
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
// API Key 鉴权
// ---------------------------------------------------------------------------

export function getGatewayApiKey(): string {
  return (getSetting("GATEWAY_API_KEY") || "").trim();
}

/** 生成新的网关 API Key 并持久化，返回新 Key。 */
export function generateGatewayApiKey(): string {
  const key = `osk-${randomBytes(18).toString("base64url")}`;
  updateSettings({ GATEWAY_API_KEY: key });
  return key;
}

function authOk(req: Request): boolean {
  const key = getGatewayApiKey();
  if (!key) return true;
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const xApiKey = req.headers.get("x-api-key") ?? "";

  return bearer === key || xApiKey === key;
}

/**
 * 浏览器来源防护：网关无 Key 时对任何本地进程开放（curl / agent 不带 Origin），
 * 但外部网页一律拒绝 —— 否则用户随便打开一个网页，页面里的 fetch 就能读记忆库、
 * 写持久记忆（等于注入 Agent 提示词）、或用用户配置的云端 Key 跑推理。
 * 外部页面只有在配置了 Key 且带上正确 Key 时才放行（等于用户显式授权）。
 */
function browserOriginAllowed(req: Request): boolean {
  const origin = (req.headers.get("origin") ?? "").trim();
  if (!origin) return true; // 非浏览器请求
  if (isLocalOrigin(origin)) return true;
  return getGatewayApiKey().length > 0 && authOk(req);
}

/**
 * Host 头校验：绑在回环时只接受回环 Host，挡住 DNS rebinding
 * （网页把自己的域名解析到 127.0.0.1，Host 仍是攻击者域名）。
 * 用户显式把 GATEWAY_HOST 绑到非回环地址时视为有意对外服务，不做限制。
 */
function hostHeaderAllowed(req: Request): boolean {
  const host = req.headers.get("host");
  if (!host) return true;
  if (isLoopbackHost(host)) return true;
  return !isLoopbackHost(boundHost);
}

function unauthorized(): Response {
  return json(
    {
      error: {
        message: "Invalid or missing API key. Provide Authorization: Bearer <key> or x-api-key: <key>.",
        type: "authentication_error",
        code: "invalid_api_key",
      },
    },
    401,
    { "WWW-Authenticate": "Bearer" },
  );
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

/** Anthropic 风格错误体：{ "type": "error", "error": { "type", "message" } } */
function anthropicError(status: number, message: string, type = "api_error"): Response {
  return json({ type: "error", error: { type, message } }, status);
}

function uid(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function getUpstreamBase(): string {
  const host = getSetting("SERVER_HOST") || "127.0.0.1";
  const port = getActiveServerPort();
  return `http://${host}:${port}`;
}

function authHeaders(): Record<string, string> {
  const apiKey = getSetting("VLLM_API_KEY");
  return apiKey && apiKey !== "EMPTY" ? { Authorization: `Bearer ${apiKey}` } : {};
}

/** 云端（OpenAI 兼容）API 基地址；未配置时返回空串。归一化掉结尾的 /v1。 */
function cloudChatBase(): string {
  const raw = (getSetting("VLLM_API_BASE") || "").trim().replace(/\/+$/, "");
  return raw.replace(/\/v1$/i, "");
}

function cloudAuthHeaders(): Record<string, string> {
  const apiKey = getSetting("VLLM_API_KEY");
  return apiKey && apiKey !== "EMPTY" ? { Authorization: `Bearer ${apiKey}` } : {};
}

/**
 * 判断上游地址是否指向网关自身。
 * 网关会代理 /v1/models、/v1/chat/completions、/v1/audio/* 等端点，
 * 若云端 / TTS / ASR Provider 误配置为网关自身地址，聚合与代理会对自身无限递归，
 * 请求永远等不到返回。识别为自身时上层应跳过该上游。
 */
function isSelfBase(base: string): boolean {
  if (!base || !boundPort) return false;
  try {
    const u = new URL(base);
    if ((u.port || (u.protocol === "https:" ? "443" : "80")) !== String(boundPort)) return false;
    const host = u.hostname.toLowerCase();
    const selfHost = boundHost.toLowerCase();
    return host === selfHost || host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
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
// 对话后端路由：本地推理服务器 + 云端 OpenAI 兼容 API
// ---------------------------------------------------------------------------

export type ChatBackend = {
  kind: "local" | "cloud";
  base: string;
  headers: Record<string, string>;
};

/** 上游 /v1/models 原始条目。 */
type UpstreamModel = { id?: string; [k: string]: unknown };

async function fetchModelsFromBase(base: string, headers: Record<string, string>): Promise<UpstreamModel[]> {
  try {
    const res = await fetch(`${base}/v1/models`, { headers, signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const body = (await res.json().catch(() => null)) as { data?: unknown[] } | null;
    return Array.isArray(body?.data) ? (body!.data as UpstreamModel[]) : [];
  } catch {
    return [];
  }
}

let localModelCache: { at: number; ids: Set<string> } | null = null;
const LOCAL_MODEL_TTL_MS = 15_000;

// 推理服务重启/停止后模型列表会变，清掉缓存。（测试里 server-manager 的桩可能没提供该导出，需运行时守卫。）
if (typeof ServerManager.onStatusChange === "function") {
  ServerManager.onStatusChange(() => {
    localModelCache = null;
  });
}

async function localModelIds(): Promise<Set<string>> {
  if (localModelCache && Date.now() - localModelCache.at < LOCAL_MODEL_TTL_MS) return localModelCache.ids;
  const models = await fetchModelsFromBase(getUpstreamBase(), authHeaders());
  const ids = new Set(models.map((m) => m?.id).filter((id): id is string => typeof id === "string" && !!id));
  localModelCache = { at: Date.now(), ids };
  return ids;
}

/** 路由失败（本地模型但服务器未运行 / 没有任何可用后端）时抛出。 */
class ChatRouteError extends Error {}

let installedSlugCache: { at: number; slugs: Set<string> } | null = null;
const INSTALLED_SLUG_TTL_MS = 15_000;

/** 已装本地模型的 canonical slug 全集。离线可得：推理服务器没在跑也能识别本地模型名。 */
async function installedModelSlugs(): Promise<Set<string>> {
  if (installedSlugCache && Date.now() - installedSlugCache.at < INSTALLED_SLUG_TTL_MS) {
    return installedSlugCache.slugs;
  }
  const slugs = new Set(listInstalledModels().map((m) => slugModelFileName(m.fileName)));
  installedSlugCache = { at: Date.now(), slugs };
  return slugs;
}

/** 清空模型路由缓存（本地列表 / 已装 slug）。测试在改变桩数据后调用；生产代码无需使用。 */
export function resetModelRouteCaches(): void {
  localModelCache = null;
  installedSlugCache = null;
}

/**
 * 按模型 ID 选择对话后端：
 * - 明确是本地已装模型 → 只走本地推理服务器；服务器未运行则抛 ChatRouteError。
 *   本地模型名绝不转发给云端 —— 否则会出现「本地模型被云 API 拒绝」的误导性错误；
 * - 本地推理服务器运行时，模型在本地列表里 → 本地；否则（且配置了云端）→ 云端；
 * - 本地未运行 → 云端（若配置）；都没有后端 → 抛 ChatRouteError。
 */
async function resolveChatBackend(model: string): Promise<ChatBackend> {
  const localRunning = ServerManager.getStatus() === "running";
  // 云端配成网关自身地址时按“未配置云端”处理，避免对话请求对自身无限递归。
  const rawCloud = cloudChatBase();
  const cloud = rawCloud && !isSelfBase(rawCloud) ? rawCloud : "";
  const local: ChatBackend = { kind: "local", base: getUpstreamBase(), headers: authHeaders() };

  if (model) {
    const installed = await installedModelSlugs();
    if (installed.has(model)) {
      if (!localRunning) {
        throw new ChatRouteError(
          `本地模型 ${model} 需要本地推理服务器，但服务器当前未运行。` +
            `请先在应用里启动推理服务器，或运行 \`omi launch <agent> --model ${model}\`（会自动拉起服务器）。`,
        );
      }
      return local;
    }
  }

  if (localRunning) {
    if (!cloud) return local;
    if (!model) return local;
    const ids = await localModelIds();
    return ids.size === 0 || ids.has(model) ? local : { kind: "cloud", base: cloud, headers: cloudAuthHeaders() };
  }
  if (cloud) return { kind: "cloud", base: cloud, headers: cloudAuthHeaders() };
  throw new ChatRouteError("没有可用的对话后端：请先启动本地推理服务器或配置云端 API。");
}

/** 上游 chat completions 调用失败（网络或 HTTP 错误）时抛出。 */
class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function callUpstreamChat(backend: ChatBackend, params: Record<string, unknown>): Promise<Response> {
  return await fetch(`${backend.base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...backend.headers },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(600_000),
  });
}

async function upstreamErrorMessage(res: Response, fallback: string): Promise<string> {
  const body = await res.text().catch(() => "");
  if (!body) return `${fallback} (${res.status})`;
  try {
    return (JSON.parse(body)?.error?.message as string | undefined) ?? body.slice(0, 300);
  } catch {
    return body.slice(0, 300);
  }
}

/** OpenAI 工具调用（非流式 message.tool_calls / 流式 delta.tool_calls 的元素）。 */
type OAIToolCall = {
  /** 流式增量里的工具调用序号。 */
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

/** 把上游返回的 arguments JSON 字符串解析成对象；失败时原样兜底。 */
function parseToolArguments(args?: string): unknown {
  if (!args) return {};
  try {
    return JSON.parse(args);
  } catch {
    return { _raw_arguments: args };
  }
}

/** 非流式调用上游，解析出 OpenAI Chat 结果。失败抛 UpstreamError。 */
type OpenAIChatResult = {
  content: string;
  finishReason: string | null;
  toolCalls: OAIToolCall[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

async function runChatNonStream(backend: ChatBackend, params: Record<string, unknown>): Promise<OpenAIChatResult> {
  let res: Response;
  try {
    res = await callUpstreamChat(backend, { ...params, stream: false });
  } catch (e) {
    throw new UpstreamError(`转发到上游失败：${errMsg(e)}`, 502);
  }
  if (!res.ok) {
    throw new UpstreamError(await upstreamErrorMessage(res, "上游推理服务返回错误"), res.status);
  }
  const data = (await res.json().catch(() => null)) as {
    choices?: {
      message?: { content?: unknown; tool_calls?: OAIToolCall[] };
      finish_reason?: string | null;
    }[];
    usage?: OpenAIChatResult["usage"];
  } | null;
  const content = data?.choices?.[0]?.message?.content;
  return {
    content: typeof content === "string" ? content : content ? JSON.stringify(content) : "",
    finishReason: data?.choices?.[0]?.finish_reason ?? null,
    toolCalls: data?.choices?.[0]?.message?.tool_calls ?? [],
    usage: data?.usage,
  };
}

/** 迭代上游 SSE 流中的 OpenAI chunk（取文本增量 / 工具调用增量 / finish_reason / usage）。 */
async function* iterUpstreamChatStream(res: Response): AsyncGenerator<{
  delta: string;
  toolCalls?: OAIToolCall[];
  finish?: string | null;
  usage?: OpenAIChatResult["usage"];
}> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          const chunk = JSON.parse(data) as {
            choices?: {
              delta?: { content?: unknown; reasoning_content?: unknown; tool_calls?: OAIToolCall[] };
              finish_reason?: string | null;
            }[];
            usage?: OpenAIChatResult["usage"];
          };
          // 不少云端模型（如 DeepSeek）把思考内容放在 reasoning_content 里流式返回；
          // content 为空时把 reasoning_content 也当作文本增量透传，避免流式时"空转"。
          const d = chunk.choices?.[0]?.delta;
          const content = typeof d?.content === "string" && d.content ? d.content : undefined;
          const reasoning = typeof d?.reasoning_content === "string" ? d.reasoning_content : undefined;
          yield {
            delta: content ?? reasoning ?? "",
            toolCalls: d?.tool_calls,
            finish: chunk.choices?.[0]?.finish_reason,
            usage: chunk.usage,
          };
        } catch {
          // 心跳 / 非 JSON 行，忽略
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

/** 把一个 async 生成器包成 SSE Response。send(event, data) 写一条 `event:` + `data:` 帧。 */
function sseStream(generate: (send: (event: string, data: unknown) => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        await generate(send);
      } catch (e) {
        try {
          send("error", { type: "error", error: { type: "api_error", message: errMsg(e) } });
        } catch {
          // ignore
        }
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // ignore
        }
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...CORS },
  });
}

// ---------------------------------------------------------------------------
// Anthropic Messages 协议（/v1/messages）
// ---------------------------------------------------------------------------

type OAIMessage = {
  role: string;
  content: unknown;
  /** assistant 消息携带的工具调用。 */
  tool_calls?: OAIToolCall[];
  /** role:tool 消息对应的工具调用 ID。 */
  tool_call_id?: string;
};

function blockToPart(block: unknown): { text?: string; imageUrl?: string } | null {
  if (typeof block === "string") return { text: block };
  if (!block || typeof block !== "object") return null;
  const b = block as Record<string, any>;
  if (b.type === "text") return { text: typeof b.text === "string" ? b.text : "" };
  if (b.type === "image") {
    const src = b.source;
    if (src?.type === "base64" && src.media_type && src.data) {
      return { imageUrl: `data:${src.media_type};base64,${src.data}` };
    }
    if (src?.type === "url" && typeof src.url === "string") return { imageUrl: src.url };
  }
  return null; // tool_use / tool_result 等暂不支持
}

/** tool_result 的 content（字符串 / 文本块数组）拍平成纯文本。 */
function toolResultToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (b?.type === "text" && typeof b.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(content);
}

function anthropicToOAIMessages(body: Record<string, any>): OAIMessage[] {
  const out: OAIMessage[] = [];

  const sys = body.system;
  let sysText = "";
  if (typeof sys === "string") sysText = sys;
  else if (Array.isArray(sys)) {
    sysText = sys
      .map((b: unknown) => (typeof b === "string" ? b : blockToPart(b)?.text ?? ""))
      .filter(Boolean)
      .join("\n");
  }
  if (sysText.trim()) out.push({ role: "system", content: sysText });

  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;

    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) continue;

    if (m.role === "assistant") {
      const toolCalls: OAIToolCall[] = [];
      let text = "";
      for (const b of m.content) {
        const part = blockToPart(b);
        if (part?.text) text += (text ? "\n" : "") + part.text;
        const bb = b as Record<string, any>;
        if (bb?.type === "tool_use" && typeof bb.name === "string") {
          toolCalls.push({
            id: typeof bb.id === "string" && bb.id ? bb.id : uid("toolu"),
            type: "function",
            function: { name: bb.name, arguments: JSON.stringify(bb.input ?? {}) },
          });
        }
      }
      if (toolCalls.length === 0) {
        if (text) out.push({ role: "assistant", content: text });
        continue;
      }
      out.push({ role: "assistant", content: text || null, tool_calls: toolCalls });
      continue;
    }

    // user 消息：文本 / 图片块合成一条 user；tool_result 块拆成独立的 role:tool 消息。
    const images: { type: "image_url"; image_url: { url: string } }[] = [];
    let text = "";
    const toolResults: { tool_call_id: string; content: string }[] = [];
    for (const b of m.content) {
      const part = blockToPart(b);
      if (part) {
        if (part.text) text += (text ? "\n" : "") + part.text;
        if (part.imageUrl) images.push({ type: "image_url", image_url: { url: part.imageUrl } });
        continue;
      }
      const bb = b as Record<string, any>;
      if (bb?.type === "tool_result" && typeof bb.tool_use_id === "string") {
        toolResults.push({ tool_call_id: bb.tool_use_id, content: toolResultToText(bb.content) });
      }
    }
    if (text || images.length > 0) {
      out.push({ role: "user", content: images.length ? [{ type: "text", text }, ...images] : text });
    }
    for (const tr of toolResults) {
      out.push({ role: "tool", tool_call_id: tr.tool_call_id, content: tr.content });
    }
  }
  return out;
}

/** Anthropic tools → OpenAI tools。 */
function anthropicToolsToOAI(tools: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out: Record<string, unknown>[] = [];
  for (const t of tools) {
    if (!t || typeof t !== "object" || typeof t.name !== "string" || !t.name) continue;
    out.push({
      type: "function",
      function: {
        name: t.name,
        ...(typeof t.description === "string" && t.description ? { description: t.description } : {}),
        parameters: t.input_schema ?? { type: "object", properties: {} },
      },
    });
  }
  return out.length ? out : undefined;
}

/** Anthropic tool_choice → OpenAI tool_choice。 */
function anthropicToolChoiceToOAI(tc: unknown): string | { type: "function"; function: { name: string } } | undefined {
  if (!tc || typeof tc !== "object") return undefined;
  const c = tc as Record<string, any>;
  if (c.type === "auto") return "auto";
  if (c.type === "any") return "required";
  if (c.type === "tool" && typeof c.name === "string") return { type: "function", function: { name: c.name } };
  return undefined;
}

function anthropicStopReason(finish: string | null): string {
  if (finish === "length") return "max_tokens";
  if (finish === "tool_calls") return "tool_use";
  return "end_turn";
}

/** 非流式：把 OpenAI 结果转成 Anthropic content 块数组（text + tool_use）。 */
function anthropicContentBlocks(result: OpenAIChatResult): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  if (result.content) blocks.push({ type: "text", text: result.content });
  for (const tc of result.toolCalls) {
    blocks.push({
      type: "tool_use",
      id: tc?.id ?? uid("toolu"),
      name: tc?.function?.name ?? "",
      input: parseToolArguments(tc?.function?.arguments),
    });
  }
  return blocks;
}

function toAnthropicUpstreamError(e: unknown): Response {
  if (e instanceof UpstreamError) {
    return anthropicError(
      e.status >= 500 ? 502 : e.status,
      e.message,
      e.status < 500 ? "invalid_request_error" : "api_error",
    );
  }
  return anthropicError(500, errMsg(e), "api_error");
}

async function handleMessages(req: Request): Promise<Response> {
  let body: Record<string, any>;
  try {
    body = (await req.json()) as Record<string, any>;
  } catch {
    return anthropicError(400, "Request body must be valid JSON", "invalid_request_error");
  }

  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!model) return anthropicError(400, `"model" is required`, "invalid_request_error");
  const messages = anthropicToOAIMessages(body);
  if (messages.length === 0) {
    return anthropicError(400, `"messages" is required and must not be empty`, "invalid_request_error");
  }

  const params: Record<string, unknown> = {
    model,
    messages,
    max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : 4096,
  };
  if (typeof body.temperature === "number") params.temperature = body.temperature;
  if (typeof body.top_p === "number") params.top_p = body.top_p;
  if (typeof body.top_k === "number") params.top_k = body.top_k;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) params.stop = body.stop_sequences;
  const toolsOAI = anthropicToolsToOAI(body.tools);
  if (toolsOAI) params.tools = toolsOAI;
  const toolChoiceOAI = anthropicToolChoiceToOAI(body.tool_choice);
  if (toolChoiceOAI) params.tool_choice = toolChoiceOAI;

  let backend: ChatBackend;
  try {
    backend = await resolveChatBackend(model);
  } catch (e) {
    return anthropicError(503, errMsg(e), "api_error");
  }

  if (body.stream) {
    return sseStream(async (send) => {
      const msgId = uid("msg");
      send("message_start", {
        type: "message_start",
        message: {
          id: msgId,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });

      // 内容块按需惰性开启：首个文本增量 / 每个上游 tool_call 依次分配块 index。
      let textStarted = false;
      let textBlockIdx = 0;
      let nextBlockIdx = 0;
      const toolBlocks = new Map<number, { blockIdx: number }>();

      let res: Response;
      try {
        res = await callUpstreamChat(backend, { ...params, stream: true });
      } catch (e) {
        send("error", { type: "error", error: { type: "api_error", message: `Forward failed: ${errMsg(e)}` } });
        send("message_stop", { type: "message_stop" });
        return;
      }
      if (!res.ok) {
        const message = await upstreamErrorMessage(res, "upstream error");
        send("error", { type: "error", error: { type: "api_error", message } });
        send("message_stop", { type: "message_stop" });
        return;
      }

      let finish: string | null = null;
      let inTokens: number | undefined;
      let outTokens: number | undefined;
      for await (const chunk of iterUpstreamChatStream(res)) {
        if (chunk.delta) {
          if (!textStarted) {
            textStarted = true;
            textBlockIdx = nextBlockIdx++;
            send("content_block_start", {
              type: "content_block_start",
              index: textBlockIdx,
              content_block: { type: "text", text: "" },
            });
          }
          send("content_block_delta", {
            type: "content_block_delta",
            index: textBlockIdx,
            delta: { type: "text_delta", text: chunk.delta },
          });
        }
        for (const tc of chunk.toolCalls ?? []) {
          const oi = typeof tc.index === "number" ? tc.index : 0;
          let entry = toolBlocks.get(oi);
          if (!entry) {
            entry = { blockIdx: nextBlockIdx++ };
            toolBlocks.set(oi, entry);
            send("content_block_start", {
              type: "content_block_start",
              index: entry.blockIdx,
              content_block: {
                type: "tool_use",
                id: tc.id ?? uid("toolu"),
                name: tc.function?.name ?? "",
                input: {},
              },
            });
          }
          if (tc.function?.arguments) {
            send("content_block_delta", {
              type: "content_block_delta",
              index: entry.blockIdx,
              delta: { type: "input_json_delta", partial_json: tc.function.arguments },
            });
          }
        }
        if (chunk.finish) finish = chunk.finish;
        if (chunk.usage) {
          inTokens = chunk.usage.prompt_tokens;
          outTokens = chunk.usage.completion_tokens;
        }
      }

      if (textStarted) send("content_block_stop", { type: "content_block_stop", index: textBlockIdx });
      for (const entry of toolBlocks.values()) {
        send("content_block_stop", { type: "content_block_stop", index: entry.blockIdx });
      }
      send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: anthropicStopReason(finish), stop_sequence: null },
        usage: { input_tokens: inTokens ?? 0, output_tokens: outTokens ?? 0 },
      });
      send("message_stop", { type: "message_stop" });
    });
  }

  try {
    const result = await runChatNonStream(backend, params);
    return json({
      id: uid("msg"),
      type: "message",
      role: "assistant",
      model,
      content: anthropicContentBlocks(result),
      stop_reason: anthropicStopReason(result.finishReason),
      stop_sequence: null,
      usage: {
        input_tokens: result.usage?.prompt_tokens ?? 0,
        output_tokens: result.usage?.completion_tokens ?? 0,
      },
    });
  } catch (e) {
    return toAnthropicUpstreamError(e);
  }
}

// ---------------------------------------------------------------------------
// OpenAI Responses 协议（/v1/responses）
// ---------------------------------------------------------------------------

function responsesToOAIMessages(body: Record<string, any>): OAIMessage[] {
  const out: OAIMessage[] = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) {
    out.push({ role: "system", content: body.instructions });
  }

  const input = body.input;
  const items: unknown[] =
    typeof input === "string" ? [{ type: "message", role: "user", content: input }] : Array.isArray(input) ? input : [];

  // 连续的 function_call 项合并为一条带 tool_calls 的 assistant 消息（OpenAI 要求如此）。
  let pendingCalls: OAIToolCall[] = [];
  const flushCalls = () => {
    if (pendingCalls.length) {
      out.push({ role: "assistant", content: null, tool_calls: pendingCalls });
      pendingCalls = [];
    }
  };

  for (const rawItem of items) {
    if (typeof rawItem === "string") {
      flushCalls();
      out.push({ role: "user", content: rawItem });
      continue;
    }
    if (!rawItem || typeof rawItem !== "object") continue;
    const item = rawItem as Record<string, any>;

    if (item.type === "function_call") {
      pendingCalls.push({
        id:
          typeof item.call_id === "string" && item.call_id
            ? item.call_id
            : typeof item.id === "string" && item.id
              ? item.id
              : uid("call"),
        type: "function",
        function: {
          name: typeof item.name === "string" ? item.name : "",
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
        },
      });
      continue;
    }

    flushCalls();

    if (item.type === "function_call_output") {
      out.push({
        role: "tool",
        tool_call_id: typeof item.call_id === "string" ? item.call_id : "",
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
      });
      continue;
    }

    if (item.type && item.type !== "message") continue;
    const role = item.role === "developer" || item.role === "system" ? "system" : item.role;
    if (role !== "user" && role !== "assistant" && role !== "system") continue;

    if (typeof item.content === "string") {
      out.push({ role, content: item.content });
      continue;
    }
    if (!Array.isArray(item.content)) continue;
    const images: { type: "image_url"; image_url: { url: string } }[] = [];
    let text = "";
    for (const p of item.content) {
      if (!p || typeof p !== "object") continue;
      if (p.type === "input_text" || p.type === "output_text" || p.type === "text") {
        if (typeof p.text === "string") text += (text ? "\n" : "") + p.text;
      } else if (p.type === "input_image" || p.type === "image_url") {
        const url = p.image_url?.url ?? p.url;
        if (typeof url === "string") images.push({ type: "image_url", image_url: { url } });
      }
    }
    if (!text && images.length === 0) continue;
    out.push({ role, content: images.length ? [{ type: "text", text }, ...images] : text });
  }
  flushCalls();
  return out;
}

/** OpenAI tool_calls → Responses 输出项（function_call）。 */
function responsesFunctionCallItems(toolCalls: OAIToolCall[]): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  for (const tc of toolCalls) {
    items.push({
      type: "function_call",
      id: uid("fc"),
      call_id: tc?.id ?? "",
      name: tc?.function?.name ?? "",
      arguments: tc?.function?.arguments ?? "",
    });
  }
  return items;
}

function responsesMessage(
  content: string,
  statusItem: "completed" | "in_progress",
): {
  type: string;
  id: string;
  status: string;
  role: string;
  content: { type: string; text: string; annotations: unknown[] }[];
} {
  return {
    type: "message",
    id: uid("msg"),
    status: statusItem,
    role: "assistant",
    content: [{ type: "output_text", text: content, annotations: [] }],
  };
}

function responsesEnvelope(
  model: string,
  body: Record<string, any>,
  resp: { status: string; output: unknown[]; usage?: Record<string, unknown> },
): Record<string, unknown> {
  return {
    id: uid("resp"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: resp.status,
    error: null,
    incomplete_details: null,
    instructions: typeof body.instructions === "string" ? body.instructions : null,
    max_output_tokens: body.max_output_tokens ?? body.max_completion_tokens ?? null,
    model,
    output: resp.output,
    parallel_tool_calls: null,
    previous_response_id: null,
    reasoning: null,
    safety_identifier: null,
    tool_choice: "auto",
    tools: Array.isArray(body.tools) ? body.tools : null,
    top_p: null,
    truncation: null,
    temperature: typeof body.temperature === "number" ? body.temperature : null,
    user: null,
    metadata: null,
    usage: resp.usage ?? {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      input_tokens_details: null,
      output_tokens_details: null,
    },
  };
}

function responsesUsage(usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) {
  const input = usage?.prompt_tokens ?? 0;
  const output = usage?.completion_tokens ?? 0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: usage?.total_tokens ?? input + output,
    input_tokens_details: null,
    output_tokens_details: null,
  };
}

/** Responses 风格的函数工具（type/name/parameters 扁平）→ Chat Completions 风格（function 嵌套）。 */
function responsesToolsToOAI(tools: unknown): { type: string; function: Record<string, unknown> }[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out: { type: string; function: Record<string, unknown> }[] = [];
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    const tool = t as Record<string, any>;
    if (tool.type !== "function") continue; // web_search 等内置工具 Chat Completions 上游不支持，丢弃
    const fn: Record<string, unknown> = { name: tool.name };
    if (tool.description !== undefined) fn.description = tool.description;
    if (tool.parameters !== undefined) fn.parameters = tool.parameters;
    if (tool.strict !== undefined) fn.strict = tool.strict;
    out.push({ type: "function", function: fn });
  }
  return out.length ? out : undefined;
}

/** Responses 风格的 tool_choice（对象 {type,name}）→ Chat Completions 风格（function 嵌套）。 */
function responsesToolChoiceToOAI(choice: unknown): unknown {
  if (!choice || typeof choice !== "object") return choice;
  const c = choice as Record<string, any>;
  if (c.type === "function" && typeof c.name === "string") {
    return { type: "function", function: { name: c.name } };
  }
  return choice;
}

async function handleResponses(req: Request): Promise<Response> {
  let body: Record<string, any>;
  try {
    body = (await req.json()) as Record<string, any>;
  } catch {
    return apiError(400, "请求体必须是合法 JSON");
  }

  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!model) return apiError(400, "`model` 必填");
  const messages = responsesToOAIMessages(body);
  if (messages.length === 0) return apiError(400, "`input` 必填且不能为空");

  const params: Record<string, unknown> = { model, messages };
  const maxTokens = body.max_output_tokens ?? body.max_completion_tokens;
  if (typeof maxTokens === "number") params.max_tokens = maxTokens;
  if (typeof body.temperature === "number") params.temperature = body.temperature;
  if (typeof body.top_p === "number") params.top_p = body.top_p;
  // 工具调用：Responses 的 tools / tool_choice 是扁平格式（type/name/parameters），Chat
  // Completions 要求 function 嵌套。必须转换，否则 llama.cpp / DeepSeek 会因 tools[0] 缺
  // function 字段而 400（codex 等 Responses 客户端会直接报错）。
  const toolsOAI = responsesToolsToOAI(body.tools);
  if (toolsOAI) params.tools = toolsOAI;
  if (body.tool_choice !== undefined) params.tool_choice = responsesToolChoiceToOAI(body.tool_choice);

  let backend: ChatBackend;
  try {
    backend = await resolveChatBackend(model);
  } catch (e) {
    return apiError(503, errMsg(e), "server_error");
  }

  if (body.stream) {
    return sseStream(async (send) => {
      const failedSend = (errMessage: string) => {
        const failed = responsesEnvelope(model, body, { status: "failed", output: [] });
        failed.error = { code: "upstream_error", message: errMessage };
        send("response.failed", { type: "response.failed", response: failed });
      };

      send("response.created", {
        type: "response.created",
        response: responsesEnvelope(model, body, { status: "in_progress", output: [] }),
      });

      // 输出项按需惰性开启：首个文本增量开启 message 项，
      // 每个上游 tool_call 开启一个 function_call 项。
      let message: ReturnType<typeof responsesMessage> | null = null;
      let messageOutputIndex = -1;
      let full = "";
      type FcState = { itemId: string; callId: string; name: string; args: string; outputIndex: number };
      const fcItems = new Map<number, FcState>();
      let nextOutputIndex = 0;

      let res: Response;
      try {
        res = await callUpstreamChat(backend, { ...params, stream: true });
      } catch (e) {
        failedSend(`Forward failed: ${errMsg(e)}`);
        return;
      }
      if (!res.ok) {
        failedSend(await upstreamErrorMessage(res, "upstream error"));
        return;
      }

      let inTokens: number | undefined;
      let outTokens: number | undefined;
      for await (const chunk of iterUpstreamChatStream(res)) {
        if (chunk.delta) {
          if (!message) {
            message = responsesMessage("", "in_progress");
            messageOutputIndex = nextOutputIndex++;
            send("response.output_item.added", {
              type: "response.output_item.added",
              output_index: messageOutputIndex,
              item: message,
            });
            send("response.content_part.added", {
              type: "response.content_part.added",
              item_id: message.id,
              output_index: messageOutputIndex,
              content_index: 0,
              part: message.content[0],
            });
          }
          full += chunk.delta;
          send("response.output_text.delta", {
            type: "response.output_text.delta",
            item_id: message.id,
            output_index: messageOutputIndex,
            content_index: 0,
            delta: chunk.delta,
          });
        }
        for (const tc of chunk.toolCalls ?? []) {
          const oi = typeof tc.index === "number" ? tc.index : 0;
          let fc = fcItems.get(oi);
          if (!fc) {
            fc = {
              itemId: uid("fc"),
              callId: tc.id ?? "",
              name: tc.function?.name ?? "",
              args: "",
              outputIndex: nextOutputIndex++,
            };
            fcItems.set(oi, fc);
            send("response.output_item.added", {
              type: "response.output_item.added",
              output_index: fc.outputIndex,
              item: { type: "function_call", id: fc.itemId, call_id: fc.callId, name: fc.name, arguments: "" },
            });
          }
          if (tc.function?.arguments) {
            fc.args += tc.function.arguments;
            send("response.function_call_arguments.delta", {
              type: "response.function_call_arguments.delta",
              item_id: fc.itemId,
              output_index: fc.outputIndex,
              delta: tc.function.arguments,
            });
          }
        }
        if (chunk.usage) {
          inTokens = chunk.usage.prompt_tokens;
          outTokens = chunk.usage.completion_tokens;
        }
      }

      const doneItems: { item: Record<string, unknown>; idx: number }[] = [];
      if (message) {
        const doneMessage = responsesMessage(full, "completed");
        send("response.output_text.done", {
          type: "response.output_text.done",
          item_id: message.id,
          output_index: messageOutputIndex,
          content_index: 0,
          text: full,
        });
        send("response.content_part.done", {
          type: "response.content_part.done",
          item_id: message.id,
          output_index: messageOutputIndex,
          content_index: 0,
          part: doneMessage.content[0],
        });
        send("response.output_item.done", {
          type: "response.output_item.done",
          output_index: messageOutputIndex,
          item: doneMessage,
        });
        doneItems.push({ item: doneMessage, idx: messageOutputIndex });
      }
      for (const fc of fcItems.values()) {
        const doneFc: Record<string, unknown> = {
          type: "function_call",
          id: fc.itemId,
          call_id: fc.callId,
          name: fc.name,
          arguments: fc.args,
        };
        send("response.function_call_arguments.done", {
          type: "response.function_call_arguments.done",
          item_id: fc.itemId,
          output_index: fc.outputIndex,
          arguments: fc.args,
        });
        send("response.output_item.done", {
          type: "response.output_item.done",
          output_index: fc.outputIndex,
          item: doneFc,
        });
        doneItems.push({ item: doneFc, idx: fc.outputIndex });
      }
      doneItems.sort((a, b) => a.idx - b.idx);
      send("response.completed", {
        type: "response.completed",
        response: responsesEnvelope(model, body, {
          status: "completed",
          output: doneItems.map((d) => d.item),
          usage: responsesUsage({ prompt_tokens: inTokens, completion_tokens: outTokens }),
        }),
      });
    });
  }

  try {
    const result = await runChatNonStream(backend, params);
    const output: Record<string, unknown>[] = [];
    if (result.content) output.push(responsesMessage(result.content, "completed"));
    output.push(...responsesFunctionCallItems(result.toolCalls));
    return json(
      responsesEnvelope(model, body, {
        status: "completed",
        output,
        usage: responsesUsage(result.usage),
      }),
    );
  } catch (e) {
    if (e instanceof UpstreamError) {
      return apiError(e.status >= 500 ? 502 : e.status, e.message, e.status < 500 ? "invalid_request_error" : "upstream_error");
    }
    return apiError(500, errMsg(e), "server_error");
  }
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions（流式透传）
// ---------------------------------------------------------------------------

async function handleChatCompletions(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return apiError(400, "请求体必须是合法 JSON");
  }

  const model = typeof body.model === "string" ? body.model : "";
  if (model.startsWith("omni-")) {
    return apiError(400, `模型 ${model} 不是对话模型（TTS/ASR 请使用对应的 /v1/audio/* 端点）`);
  }

  let backend: ChatBackend;
  try {
    backend = await resolveChatBackend(model);
  } catch (e) {
    return apiError(503, errMsg(e), "server_error");
  }

  let upstream: Response;
  try {
    upstream = await callUpstreamChat(backend, body);
  } catch (e) {
    return apiError(502, `转发失败：${errMsg(e)}`, "upstream_error");
  }
  if (!upstream.ok) return forwardUpstreamError(upstream, "推理服务器返回错误");

  const contentType = upstream.headers.get("content-type") ?? "application/json";
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "Content-Type": contentType, ...CORS },
  });
}

// ---------------------------------------------------------------------------
// TTS / ASR
// ---------------------------------------------------------------------------

function localTtsModelIds(): Set<string> {
  return new Set(TTSLocal.listTtsLocalModels().map((m) => m.id));
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

  // 1) 本地 audio.cpp 引擎（优先；指定了本地 TTS 模型 ID 时直接用它）
  const local = await TTSLocal.getTtsLocalStatus();
  if (local.active && local.activeModelId) {
    const requested = body.model?.trim() ?? "";
    const useModel = localTtsModelIds().has(requested) ? requested : undefined;
    try {
      const record = await TTSLocal.runTTSLocal({
        text,
        voice: body.voice,
        model: useModel,
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
      // 本地引擎失败时继续回退到下一后端。
      console.warn(`gateway: local TTS failed: ${errMsg(e)}`);
    }
  }

  // 2) 本地推理服务器（vLLM 等可托管 TTS 模型）
  if (ServerManager.getStatus() === "running") {
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
        // 上游不支持 TTS，继续回退。
      } else {
        return forwardUpstreamError(res, "上游 TTS 返回错误");
      }
    } catch (e) {
      console.warn(`gateway: upstream TTS failed: ${errMsg(e)}`);
    }
  }

  // 3) 三方 TTS Provider（TTS 页配置）；指向网关自身时跳过（避免自递归）。
  const provider = getTTSProviderConfig();
  if (provider.base && !isSelfBase(provider.base)) {
    try {
      const res = await fetch(`${provider.base.replace(/\/+$/, "")}/audio/speech`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: body.model?.trim() || provider.model || undefined,
          input: text,
          voice: body.voice,
          response_format: body.response_format === "mp3" ? "mp3" : "wav",
          ...(typeof body.speed === "number" ? { speed: body.speed } : {}),
        }),
        signal: AbortSignal.timeout(600_000),
      });
      if (res.ok) {
        return new Response(res.body, {
          status: res.status,
          headers: {
            "Content-Type": res.headers.get("content-type") ?? (body.response_format === "mp3" ? "audio/mpeg" : "audio/wav"),
            ...CORS,
          },
        });
      }
      if (res.status < 500) {
        return forwardUpstreamError(res, "三方 TTS 服务返回错误");
      }
      console.warn(`gateway: TTS provider returned ${res.status}, falling back to Edge TTS`);
    } catch (e) {
      console.warn(`gateway: TTS provider failed: ${errMsg(e)}, falling back to Edge TTS`);
    }
  }

  // 4) Edge 在线 TTS（免费、无需 Key，最终兜底；输出为 mp3）
  try {
    const record = await runTTSEdge({ text, voice: body.voice ?? "" });
    if (!record.audioUrl) return apiError(500, "Edge TTS 完成但无法定位音频文件", "tts_error");
    const audio = await fetch(record.audioUrl, { signal: AbortSignal.timeout(120_000) });
    if (!audio.ok) return apiError(502, `Edge TTS 音频读取失败 (${audio.status})`, "tts_error");
    const buf = await audio.arrayBuffer();
    return new Response(buf, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Disposition": 'inline; filename="speech.mp3"',
        ...CORS,
      },
    });
  } catch (e) {
    return apiError(502, `Edge TTS 合成失败：${errMsg(e)}`, "tts_error");
  }
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
      return apiError(502, `whisper-server 请求失败：${errMsg(e)}`, "upstream_error");
    }
  }

  // 2) 远端 ASR Provider（指向网关自身时跳过，避免自递归）
  const provider = Asr.getASRProviderConfig();
  if ((provider.base ?? "").trim() && !isSelfBase(provider.base)) {
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
      return apiError(502, `远端 ASR 请求失败：${errMsg(e)}`, "upstream_error");
    }
  }

  return apiError(501, "没有可用的 ASR 后端：请先启动 whisper-server 或配置远端 ASR 服务", "not_implemented");
}

// ---------------------------------------------------------------------------
// 文本生图（/v1/images/generations，OpenAI Images API）
// ---------------------------------------------------------------------------

/** OpenAI 生图响应里的 data 项：url 或 b64_json 二选一。 */
type ImageGenDataItem = Record<string, string>;

/**
 * 解析 size 字符串（OpenAI 格式 "1024x1024"）为宽高；非法时返回 null。
 */
function parseImageSize(size: string): { width: number; height: number } | null {
  const m = /^\s*(\d+)\s*[xX]\s*(\d+)\s*$/.exec(size);
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

/** 从 imageUrl 逆向出 images 根目录下的相对路径（chatImageUrl 的 ref）。 */
function refFromImageUrl(imageUrl: string): string | null {
  const m = /^https?:\/\/[^/]+\/(.+)$/.exec(imageUrl);
  return m ? decodeURIComponent(m[1]!) : null;
}

async function handleImageGeneration(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return apiError(400, "请求体必须是合法 JSON", "invalid_request_error");
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return apiError(400, "缺少 prompt 字段（文生图提示词）", "invalid_request_error");

  const rawModel = typeof body.model === "string" ? body.model.trim() : "";
  const n = typeof body.n === "number" && Number.isFinite(body.n) ? Math.max(1, Math.min(Math.floor(body.n), 8)) : 1;
  const size = typeof body.size === "string" ? body.size : "1024x1024";
  const parsedSize = parseImageSize(size);
  if (!parsedSize) return apiError(400, `无效的 size：${size}（应为 WxH，如 1024x1024）`, "invalid_request_error");
  const responseFormat = body.response_format === "b64_json" ? "b64_json" : "url";
  const negativePrompt = typeof body.negative_prompt === "string" ? body.negative_prompt.trim() : undefined;
  const seed = typeof body.seed === "number" && Number.isFinite(body.seed) && body.seed >= 0 ? body.seed : undefined;
  const steps = typeof body.steps === "number" && Number.isFinite(body.steps) ? body.steps : undefined;

  // 模型路由：
  // - omni-image 别名 / 空 → 走已配置的生图后端（IMG_BACKEND + IMG_MODEL，即“当前模型”）；
  // - 明确的 MLX 模型 id → 强制 mlx 后端；
  // - 其它模型 id → 透传给已配置后端（api / comfyui 的模型名 / checkpoint）。
  const cfg = Img.getImageGenConfig();
  let backend: Img.ImageGenBackend = cfg.backend;
  let model: string | undefined;
  if (rawModel && rawModel !== "omni-image" && Img.lookupMlxModel(rawModel)) {
    backend = "mlx";
    model = rawModel;
  } else if (rawModel && rawModel !== "omni-image") {
    model = rawModel;
  } else {
    model = cfg.model || undefined;
  }

  const result = await Img.generateImage({
    prompt,
    negativePrompt,
    width: parsedSize.width,
    height: parsedSize.height,
    count: n,
    seed,
    steps,
    model,
    config: { ...cfg, backend, model: model ?? cfg.model },
    // 网关不落盘配置，避免 API 调用改写用户保存的生图设置。
    persistConfig: false,
  });

  if (result.error) {
    return apiError(502, result.error, "image_generation_error");
  }

  const created = Math.floor(Date.now() / 1000);
  const data: ImageGenDataItem[] = [];
  for (const record of result.records) {
    if (responseFormat === "b64_json" && record.imagePath) {
      const abs = path.join(Img.imagesBaseDir(), record.imagePath);
      try {
        data.push({ b64_json: readFileSync(abs).toString("base64") });
        continue;
      } catch {
        // 文件缺失时回退到 url（若可用）。
      }
    }
    if (record.imageUrl) data.push({ url: record.imageUrl });
  }

  if (data.length === 0) {
    return apiError(502, "生图完成但未拿到可返回的图片", "image_generation_error");
  }
  return json({ created, data });
}

// ---------------------------------------------------------------------------
// 模型列表（本地 + 云端 + TTS/ASR 能力模型）
// ---------------------------------------------------------------------------

type ModelEntry = { id: string; object: string; owned_by: string; task?: string; [k: string]: unknown };

async function handleListModels(): Promise<Response> {
  const localRunning = ServerManager.getStatus() === "running";
  const cloud = cloudChatBase();

  const ttsProvider = getTTSProviderConfig();
  const asrProvider = Asr.getASRProviderConfig();
  // 防自引用：云端 / TTS Provider 指向网关自身时跳过拉取，
  // 否则 /v1/models 会对自身无限递归（网关自己也提供 /v1/models）。
  const cloudIsSelf = cloud ? isSelfBase(cloud) : false;
  const ttsIsSelf = ttsProvider.base ? isSelfBase(ttsProvider.base) : false;

  const [localModels, cloudModels, ttsStatus, asrStatus, ttsProviderModels] = await Promise.all([
    localRunning ? fetchModelsFromBase(getUpstreamBase(), authHeaders()) : Promise.resolve([] as UpstreamModel[]),
    cloud && !cloudIsSelf ? fetchModelsFromBase(cloud, cloudAuthHeaders()) : Promise.resolve([] as UpstreamModel[]),
    TTSLocal.getTtsLocalStatus().catch(() => null),
    Asr.getAsrStatus().catch(() => null),
    ttsProvider.base && !ttsIsSelf
      ? listProviderModels(ttsProvider.base, ttsProvider.apiKey).catch(() => [] as string[])
      : Promise.resolve([] as string[]),
  ]);

  const seen = new Set<string>();
  const data: ModelEntry[] = [];
  const add = (id: string, owned_by: string, task: string, extra: Record<string, unknown> = {}) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    data.push({ id, object: "model", owned_by, task, ...extra });
  };

  // 1) 本地推理服务器对话模型（优先，云端同名模型去重）
  for (const m of localModels) {
    if (typeof m?.id === "string") add(m.id, "omni-studio-local", "chat");
  }
  // 2) 云端 OpenAI 兼容 API 对话模型
  for (const m of cloudModels) {
    if (typeof m?.id === "string") add(m.id, "omni-studio-cloud", "chat");
  }
  // 3) 本地 audio.cpp TTS 已下载模型
  if (ttsStatus?.active) {
    for (const m of TTSLocal.listTtsLocalModels()) {
      if (m.downloaded) add(m.id, "audio.cpp", "text-to-speech", { name: m.name, languages: m.languages });
    }
  }
  // 4) 三方 TTS Provider 模型
  for (const id of ttsProviderModels) add(id, "tts-provider", "text-to-speech");
  // 5) 本地 whisper-server 活动模型
  if (asrStatus?.serverRunning && asrStatus.activeModel) {
    add(asrStatus.activeModel, "whisper-server", "automatic-speech-recognition");
  }
  // 6) 远端 ASR Provider 模型
  if ((asrProvider.base ?? "").trim() && asrProvider.model) {
    add(asrProvider.model, "asr-provider", "automatic-speech-recognition");
  }

  // 7) 网关能力别名（客户端可用固定 ID 调用）
  add("omni-tts", "omni-studio", "text-to-speech", { description: "TTS 自动路由：本地 audio.cpp → 推理服务器 → 三方 provider → Edge 在线" });
  if (asrStatus?.serverRunning || (asrProvider.base ?? "").trim()) {
    add("omni-asr", "omni-studio", "automatic-speech-recognition", {
      description: "ASR 自动路由：whisper-server → 远端 ASR 服务",
    });
  }
  // 文生图后端：MLX 本地模型（mflux）+ 能力别名。始终声明，客户端可据此发现/调用。
  for (const m of Img.IMAGE_MODELS) {
    add(m.id, "omni-studio", "text-to-image", {
      name: m.label,
      description: `${m.description}；本地 MLX（mflux），调用 /v1/images/generations`,
    });
  }
  add("omni-image", "omni-studio", "text-to-image", {
    description: "文生图自动路由：MLX 本地引擎 → OpenAI 兼容 API → ComfyUI（走已配置的 IMG_BACKEND / IMG_MODEL）",
  });

  return json({ object: "list", data });
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
      version: "1.1.0",
      description:
        "OmniStudio 统一模型网关。聚合本机推理后端（llama.cpp / vLLM / SGLang、whisper-server、audio.cpp TTS）" +
        "与已配置的云端 OpenAI 兼容 API，提供 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 三套对话协议，" +
        "以及 TTS / ASR 端点。设置 GATEWAY_API_KEY 后 /v1/* 端点需要 Bearer Token 或 x-api-key 鉴权。",
    },
    servers: [{ url: `http://${host}:${port}` }],
    security: [{ bearerAuth: [] }],
    paths: {
      "/health": {
        get: {
          summary: "健康检查",
          description: "网关自身健康状态，并附带上游推理服务与云端 API 的运行状态（无需鉴权）。",
          responses: { "200": { description: "OK" } },
        },
      },
      "/v1/models": {
        get: {
          summary: "列出可用模型",
          description: "聚合返回本地推理服务器、云端 API、本地/三方 TTS、ASR 的全部可用模型及网关能力别名（omni-tts / omni-asr / omni-image）。",
          responses: { "200": { description: "模型列表" } },
        },
      },
      "/v1/memories": {
        get: {
          summary: "检索共享记忆",
          description: "按关键词检索（`q`，命中累计热度）或按分类列出（`category`）。所有 Agent（OmniStudio 内置 / CLI / MCP 接入方）共享同一份记忆库。",
          parameters: [
            { name: "q", in: "query", schema: { type: "string" }, description: "关键词（与 category 二选一）" },
            { name: "category", in: "query", schema: { type: "string", enum: ["fact", "preference", "experience", "skill", "other"] } },
            { name: "limit", in: "query", schema: { type: "integer", default: 20 } },
          ],
          responses: { "200": { description: "记忆列表" } },
        },
        post: {
          summary: "写入一条记忆",
          description: "写入共享记忆库（source 标记为 agent；重复内容自动合并）。供外部程序写回记忆的主通道。",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["content"],
                  properties: {
                    content: { type: "string", description: "记忆内容，一句话" },
                    category: { type: "string", enum: ["fact", "preference", "experience", "skill", "other"] },
                    tags: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
          responses: { "201": { description: "已创建" } },
        },
      },
      "/v1/memories/{id}": {
        delete: {
          summary: "删除一条记忆",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: { "200": { description: "已删除" } },
        },
      },
      "/mcp": {
        post: {
          summary: "OmniStudio MCP 端点（Streamable HTTP）",
          description: "JSON-RPC 2.0：initialize / tools/list / tools/call。工具：kb_search / kb_list（知识库检索）+ memory_search / memory_save / memory_list（共享记忆读写）。任何 MCP 客户端把本端点配置为远程（type=http）服务器即可使用；浏览器直接打开（GET）为调试工作台。",
          responses: { "200": { description: "JSON-RPC 响应" } },
        },
      },
      "/v1/chat/completions": {
        post: {
          summary: "对话补全（OpenAI Chat Completions）",
          description: "OpenAI 兼容 Chat Completions；按模型 ID 自动路由到本地推理服务器或云端 API；`stream: true` 时以 SSE 流式透传。",
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
            "503": { description: "没有可用的对话后端" },
          },
        },
      },
      "/v1/responses": {
        post: {
          summary: "对话补全（OpenAI Responses API）",
          description: "OpenAI Responses 协议：`input` 支持字符串或消息数组（含 function_call / function_call_output 项），`instructions` 映射为 system；支持 tools / tool_choice 工具调用，输出 function_call 项；流式返回 response.* SSE 事件。",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["model"],
                  properties: {
                    model: { type: "string" },
                    input: {
                      oneOf: [{ type: "string" }, { type: "array", description: "message 项数组" }],
                    },
                    instructions: { type: "string", description: "系统指令" },
                    stream: { type: "boolean", default: false },
                    temperature: { type: "number" },
                    max_output_tokens: { type: "integer" },
                    tools: {
                      type: "array",
                      description: "OpenAI 风格函数工具 [{type:\"function\", name, description, parameters}]",
                      items: { type: "object" },
                    },
                    tool_choice: { description: "\"auto\" | \"none\" | \"required\" 或 {type:\"function\", function:{name}}" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "response 对象（流式为 SSE 事件）" },
            "503": { description: "没有可用的对话后端" },
          },
        },
      },
      "/v1/messages": {
        post: {
          summary: "对话补全（Anthropic Messages API）",
          description:
            "Anthropic Messages 协议：支持 system / 文本与图片 content block / stop_sequences / 工具调用" +
            "（tools + tool_choice；响应 content 含 tool_use 块，stop_reason=tool_use；tool_result 回传）；" +
            "流式返回 message_start → content_block_*（text_delta / input_json_delta）→ message_delta → message_stop 事件。鉴权可用 x-api-key 头。",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["model", "messages"],
                  properties: {
                    model: { type: "string" },
                    system: { oneOf: [{ type: "string" }, { type: "array" }] },
                    messages: { type: "array", items: { type: "object" } },
                    max_tokens: { type: "integer", default: 4096 },
                    stream: { type: "boolean", default: false },
                    temperature: { type: "number" },
                    top_p: { type: "number" },
                    top_k: { type: "number" },
                    stop_sequences: { type: "array", items: { type: "string" } },
                    tools: {
                      type: "array",
                      description: "Anthropic 风格工具 [{name, description, input_schema}]",
                      items: { type: "object" },
                    },
                    tool_choice: {
                      description: "{type:\"auto\"} | {type:\"any\"} | {type:\"tool\", name}",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "message 对象（流式为 SSE 事件）" },
            "503": { description: "没有可用的对话后端" },
          },
        },
      },
      "/v1/audio/speech": {
        post: {
          summary: "文本转语音（TTS）",
          description: "OpenAI 兼容语音合成。自动路由：本地 audio.cpp 引擎 → 推理服务器 → 三方 TTS provider → Edge 在线 TTS（兜底，返回 mp3）。",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SpeechRequest" },
              },
            },
          },
          responses: {
            "200": { description: "合成音频（audio/wav 或 audio/mpeg）" },
          },
        },
      },
      "/v1/audio/transcriptions": {
        post: {
          summary: "语音识别（ASR）",
          description: "OpenAI 兼容语音转写（multipart/form-data，字段 `file`）。自动路由：whisper-server → 远端 ASR 服务。",
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
          summary: "文本生图（OpenAI Images API）",
          description:
            "OpenAI 兼容文生图接口。模型自动路由：明确的 MLX 模型 id（z-image-turbo / flux-schnell / flux2-klein-9b / flux-dev）走本地 MLX 引擎，" +
            "omni-image 别名或留空走已配置的生图后端（IMG_BACKEND + IMG_MODEL），其它模型 id 透传已配置的 API / ComfyUI 后端。" +
            "response_format 支持 url（默认）与 b64_json。",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ImageGenerationRequest" },
              },
            },
          },
          responses: {
            "200": { description: "生成的图片（created + data[]，url 或 b64_json）" },
            "400": { description: "缺少 prompt / size 非法" },
            "502": { description: "生图后端不可用或生成失败" },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "GATEWAY_API_KEY；未设置时开放访问" },
      },
      schemas: {
        ChatCompletionRequest: {
          type: "object",
          required: ["messages"],
          properties: {
            model: { type: "string", description: "模型 ID（本地或云端，网关按 ID 自动路由）" },
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
        ImageGenerationRequest: {
          type: "object",
          required: ["prompt"],
          properties: {
            model: {
              type: "string",
              description:
                "生图模型。omni-image 或留空=当前配置的后端模型（IMG_BACKEND+IMG_MODEL）；MLX 模型 id（z-image-turbo 等）走本地引擎；其它透传已配置后端",
            },
            prompt: { type: "string", description: "文生图提示词" },
            negative_prompt: { type: "string", description: "反向提示词（可选）" },
            n: { type: "integer", minimum: 1, maximum: 8, default: 1, description: "生成数量" },
            size: { type: "string", default: "1024x1024", description: "输出尺寸 WxH，如 1024x1024 / 512x512" },
            response_format: { type: "string", enum: ["url", "b64_json"], default: "url" },
            seed: { type: "integer", description: "随机种子（可选）" },
            steps: { type: "integer", description: "采样步数（可选，MLX 后端）" },
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
// 路由
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// 记忆 REST / MCP 端点：任何程序经网关即可读写共享记忆（REST 服务开发者，
// MCP 服务 Agent —— 与 OpenMemory/Mem0 的对外形式一致）。
// ---------------------------------------------------------------------------

function handleMemoryList(url: URL): Response {
  const q = url.searchParams.get("q") ?? url.searchParams.get("query") ?? "";
  const category = (url.searchParams.get("category") ?? undefined) as MemoryCategory | undefined;
  const limit = Number(url.searchParams.get("limit") ?? 0) || undefined;
  let memories = q
    ? Memory.searchMemories(q, limit ?? 20)
    : Memory.listMemories(category ? { category } : undefined);
  if (limit && memories.length > limit) memories = memories.slice(0, limit);
  return json({ memories, count: memories.length });
}

async function handleMemoryCreate(req: Request): Promise<Response> {
  let body: { content?: unknown; category?: unknown; tags?: unknown };
  try {
    body = await req.json();
  } catch {
    return apiError(400, "请求体必须是 JSON", "invalid_request_error");
  }
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) return apiError(400, "content is required", "invalid_request_error");
  const memory = Memory.saveAgentMemory(
    content,
    typeof body.category === "string" ? (body.category as MemoryCategory) : undefined,
    Array.isArray(body.tags) ? body.tags.map(String) : undefined,
  );
  return json({ memory }, 201);
}

async function route(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(req.url);
  const path = url.pathname;

  // 浏览器来源 / DNS rebinding 防护（在鉴权之前，未配置 Key 时同样生效）。
  if (!browserOriginAllowed(req) || !hostHeaderAllowed(req)) {
    return apiError(
      403,
      "该请求来自外部网页。网关只接受本机进程调用，或在配置 GATEWAY_API_KEY 后携带正确 Key 调用。",
      "forbidden",
    );
  }

  // API Key 鉴权：/v1/* 与 /mcp 端点需要（元信息端点保持开放）。
  // 例外：浏览器 GET /mcp 返回静态调试工作台（无秘密，页面里的调用仍需 Key）。
  const mcpPlaygroundGet = req.method === "GET" && path === "/mcp";
  if ((path.startsWith("/v1/") || (path === "/mcp" && !mcpPlaygroundGet)) && !authOk(req)) {
    return unauthorized();
  }

  switch (path) {
    case "/":
      return json({
        name: "OmniStudio Local Gateway",
        docs: "/docs",
        redoc: "/redoc",
        openapi: "/openapi.json",
        auth: getGatewayApiKey()
          ? "API key required: Authorization: Bearer <key> or x-api-key: <key>"
          : "API key not set: open access",
        endpoints: [
          "GET  /v1/models",
          "POST /v1/chat/completions",
          "POST /v1/responses",
          "POST /v1/messages",
          "POST /v1/audio/speech",
          "POST /v1/audio/transcriptions",
          "POST /v1/images/generations",
          "POST /mcp (knowledge base MCP server)",
          "GET  /health",
        ],
      });
    case "/health":
      return json({
        status: "ok",
        gateway: true,
        auth: getGatewayApiKey() ? "required" : "open",
        upstream: ServerManager.getStatus(),
        cloud: cloudChatBase() || null,
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
    case "/v1/responses":
      if (req.method !== "POST") return apiError(405, "Method Not Allowed");
      return handleResponses(req);
    case "/v1/messages":
      if (req.method !== "POST") return apiError(405, "Method Not Allowed");
      return handleMessages(req);
    case "/v1/audio/speech":
      if (req.method !== "POST") return apiError(405, "Method Not Allowed");
      return handleSpeech(req);
    case "/v1/audio/transcriptions":
      if (req.method !== "POST") return apiError(405, "Method Not Allowed");
      return handleTranscriptions(req);
    case "/v1/images/generations":
      if (req.method !== "POST") return apiError(405, "Method Not Allowed");
      return handleImageGeneration(req);
    // 共享记忆 REST（Mem0 风格）：任何程序经网关读写记忆库。
    case "/v1/memories":
      if (req.method === "GET") return handleMemoryList(url);
      if (req.method === "POST") return handleMemoryCreate(req);
      return apiError(405, "Method Not Allowed");
    // OmniStudio MCP 服务（Streamable HTTP）：知识库检索 + 共享记忆读写。
    case "/mcp":
      return handleMcpRequest(req);
    default: {
      // /v1/memories/{id} DELETE
      const memMatch = path.match(/^\/v1\/memories\/(\d+)$/);
      if (memMatch) {
        if (req.method !== "DELETE") return apiError(405, "Method Not Allowed");
        Memory.deleteMemory(Number(memMatch[1]));
        return json({ ok: true });
      }
      return apiError(404, `未知路径 ${path}`, "not_found");
    }
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
        }${getGatewayApiKey() ? " (API key enabled)" : ""}`,
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
