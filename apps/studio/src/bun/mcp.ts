import { eq } from "drizzle-orm";
import { Type } from "typebox";
import { db } from "./db";
import { mcpServers, type McpServerRow } from "./db/schema";
import { audit } from "./skills/audit";
import type { BuiltTool } from "./agent-tools";
import type { McpServerConfig, McpTransportType } from "../shared/mcp";

export type { McpServerConfig, McpTransportType } from "../shared/mcp";

/**
 * MCP（Model Context Protocol）客户端与管理器。
 *
 * 手写实现而不引入 @modelcontextprotocol/sdk：Electrobun 主进程是定制的 Bun 运行时，
 * SDK 的 node 兼容层有不可控风险；而客户端只需要 initialize → tools/list → tools/call
 * 三条消息，三种传输（stdio 换行分隔 JSON-RPC / Streamable HTTP / 旧版 SSE）都不复杂。
 */

export interface McpToolDef {
  name: string;
  description: string;
  /** JSON Schema（原样透传给模型的 tools[].function.parameters）。 */
  inputSchema: Record<string, unknown>;
}

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "OmniStudio", version: "1.0.0" };
const INIT_TIMEOUT_MS = 20_000;
const LIST_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 180_000;

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], details: { error: message } };
}

function parseJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(raw: string): Record<string, string> {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const out: Record<string, string> = {};
      for (const [k, val] of Object.entries(v)) {
        if (val !== null && val !== undefined) out[k] = String(val);
      }
      return out;
    }
  } catch {}
  return {};
}

export function rowToConfig(row: McpServerRow): McpServerConfig {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    command: row.command,
    args: parseJsonArray(row.args),
    url: row.url,
    headers: parseJsonObject(row.headers),
    env: parseJsonObject(row.env),
    enabled: row.enabled === 1,
  };
}

// ---------------------------------------------------------------------------
// SSE 事件流解析：feed 进 chunk，按空行切事件，回调 (event, data)
// ---------------------------------------------------------------------------

function createSseParser(onEvent: (event: string, data: string) => void) {
  let buf = "";
  return (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      const dataLines: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length > 0) onEvent(event, dataLines.join("\n"));
    }
  };
}

async function pumpStream(
  stream: ReadableStream<Uint8Array>,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      onChunk(decoder.decode(value, { stream: true }));
    }
  } catch {
    // 流被取消 / 网络断开：静默结束
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC 请求关联
// ---------------------------------------------------------------------------

interface PendingEntry {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class RpcPeer {
  private nextId = 1;
  private pending = new Map<number, PendingEntry>();

  /** 收到一条消息（响应或通知），关联到等待中的请求。 */
  handleMessage(msg: unknown) {
    if (!msg || typeof msg !== "object") return;
    const m = msg as { id?: unknown; result?: unknown; error?: { message?: string }; method?: string };
    if (m.id === undefined || m.id === null || typeof m.id !== "number") return;
    const entry = this.pending.get(m.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(m.id);
    if (m.error) entry.reject(new Error(m.error.message ?? "MCP error"));
    else entry.resolve(m.result);
  }

  request(
    method: string,
    params: unknown,
    send: (payload: string) => Promise<void> | void,
    timeoutMs: number,
  ): Promise<any> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      Promise.resolve(send(payload)).catch((e) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  notify(method: string, params: unknown, send: (payload: string) => Promise<void> | void) {
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params });
    return Promise.resolve(send(payload)).catch(() => {});
  }

  failAll(reason: string) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }
}

// ---------------------------------------------------------------------------
// 传输层
// ---------------------------------------------------------------------------

interface McpConnection {
  connect(): Promise<void>;
  listTools(): Promise<McpToolDef[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  get alive(): boolean;
  close(): Promise<void>;
}

function formatCallResult(result: any): string {
  if (!result || !Array.isArray(result.content)) return JSON.stringify(result);
  const parts: string[] = [];
  for (const item of result.content) {
    if (item?.type === "text" && typeof item.text === "string") parts.push(item.text);
    else if (item?.type === "image") parts.push("[image]");
    else if (item?.type === "resource" && item?.resource?.text) parts.push(item.resource.text);
    else if (item?.type === "resource") parts.push(`[resource: ${item.resource?.uri ?? "?"}]`);
  }
  const text = parts.join("\n") || "(empty result)";
  return result.isError ? `Tool error: ${text}` : text;
}

/**
 * GUI 启动的进程 PATH 常缺少 Homebrew / nvm 等目录，stdio 服务器（npx/uvx/node）会找不到。
 * 与 agent-tools.ts 的 augmentPath 保持同样的补法。
 */
function augmentPath(): string {
  const extra = [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    `${process.env.HOME ?? ""}/.nvm/versions/node/*/bin`,
    `${process.env.HOME ?? ""}/.bun/bin`,
    `${process.env.HOME ?? ""}/.cargo/bin`,
  ];
  return [...extra, process.env.PATH ?? ""].join(":");
}

/**
 * 会劫持子进程加载器 / 注入代码的 env 键。MCP 配置由 webview 提交，
 * 允许覆盖这些键等于让配置方在每次启动时往任意 stdio 服务器进程里注入代码。
 * 业务变量（API Key 等）仍然放行。
 */
const BLOCKED_ENV_KEYS = new Set([
  "NODE_OPTIONS",
  "BUN_OPTIONS",
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "PYTHONHOME",
  "PERL5OPT",
  "RUBYOPT",
  "NODE_PATH",
]);

function sanitizeSpawnEnv(env?: Record<string, string>): {
  env: Record<string, string>;
  blocked: string[];
} {
  const out: Record<string, string> = {};
  const blocked: string[] = [];
  for (const [key, value] of Object.entries(env ?? {})) {
    const upper = key.toUpperCase();
    if (BLOCKED_ENV_KEYS.has(upper) || upper.startsWith("LD_") || upper.startsWith("DYLD_")) {
      blocked.push(key);
      continue;
    }
    out[key] = value;
  }
  return { env: out, blocked };
}

class StdioConnection implements McpConnection {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private rpc = new RpcPeer();
  private readLoop: Promise<void> = Promise.resolve();
  private closed = false;
  private lineBuf = "";

  constructor(private cfg: McpServerConfig) {}

  /** 消息以换行分隔，但网络 chunk 可能拦腰截断一行，这里做行缓冲。 */
  private feedLines = (text: string) => {
    this.lineBuf += text;
    let idx: number;
    while ((idx = this.lineBuf.indexOf("\n")) !== -1) {
      const line = this.lineBuf.slice(0, idx).trim();
      this.lineBuf = this.lineBuf.slice(idx + 1);
      if (!line) continue;
      try {
        this.rpc.handleMessage(JSON.parse(line));
      } catch {}
    }
  };

  async connect() {
    const { env, blocked } = sanitizeSpawnEnv(this.cfg.env);
    if (blocked.length > 0) {
      // 动态链接器 / 解释器注入类变量被忽略，仅记审计，不影响业务变量（API Key 等）。
      audit("mcp_env_blocked", `${this.cfg.name ?? this.cfg.command}: ${blocked.join(", ")}`);
    }
    // stdio 服务器等于执行任意命令：每次启动都留审计，便于事后追溯。
    audit("mcp_spawn", `${this.cfg.name ?? "server"}: ${[this.cfg.command, ...this.cfg.args].join(" ")}`);
    const proc = Bun.spawn([this.cfg.command, ...this.cfg.args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env, PATH: augmentPath() },
    });
    this.proc = proc;
    // stderr 仅排空防背压，内容丢给控制台便于排查服务器崩溃。
    void pumpStream(proc.stderr, () => {});
    this.readLoop = pumpStream(proc.stdout, this.feedLines);
    try {
      await this.rpc.request(
        "initialize",
        { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
        (payload) => {
          proc.stdin!.write(payload + "\n");
        },
        INIT_TIMEOUT_MS,
      );
    } catch (e) {
      await this.close().catch(() => {});
      throw e;
    }
    await this.rpc.notify(
      "notifications/initialized",
      {},
      (payload) => {
        proc.stdin!.write(payload + "\n");
      },
    );
  }

  /** stdin:"pipe" 时是 FileSink，类型上可能包含 fd 数字，收窄一下。 */
  private get stdin(): import("bun").FileSink | null {
    const stdin = this.proc?.stdin;
    return stdin && typeof stdin === "object" ? stdin : null;
  }

  private write(payload: string): Promise<void> {
    const stdin = this.stdin;
    if (!stdin || !this.alive) throw new Error("MCP server process is not running");
    void stdin.write(payload + "\n");
    return Promise.resolve();
  }

  async listTools() {
    const result = await this.rpc.request(
      "tools/list",
      {},
      (p) => this.write(p),
      LIST_TIMEOUT_MS,
    );
    return normalizeTools(result?.tools);
  }

  async callTool(name: string, args: Record<string, unknown>) {
    const result = await this.rpc.request(
      "tools/call",
      { name, arguments: args },
      (p) => this.write(p),
      CALL_TIMEOUT_MS,
    );
    return formatCallResult(result);
  }

  get alive() {
    return !this.closed && this.proc !== null && this.proc.exitCode === null;
  }

  async close() {
    this.closed = true;
    this.rpc.failAll("MCP server closed");
    try {
      this.stdin?.end();
    } catch {}
    try {
      this.proc?.kill();
    } catch {}
  }
}

/** Streamable HTTP（2025-03-26+）：单 POST 端点，响应是 JSON 或 SSE 流。 */
class HttpConnection implements McpConnection {
  private sessionId: string | null = null;
  private aborted = false;

  constructor(private cfg: McpServerConfig) {}

  private async post(payload: string): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.cfg.headers,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const res = await fetch(this.cfg.url, { method: "POST", headers, body: payload });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    return res;
  }

  /** 响应可能是 JSON，也可能是 SSE 流（取第一条对应消息）。 */
  private async readResponse(res: Response, wantId: number): Promise<any> {
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("text/event-stream") && res.body) {
      return await new Promise<any>((resolve, reject) => {
        const feed = createSseParser((event, data) => {
          if (event !== "message") return;
          try {
            const msg = JSON.parse(data);
            if (msg?.id === wantId) {
              if (msg.error) reject(new Error(msg.error.message ?? "MCP error"));
              else resolve(msg.result);
              void res.body!.cancel().catch(() => {});
            }
          } catch {}
        });
        void pumpStream(res.body!, feed).then(() =>
          reject(new Error("MCP SSE stream ended before response")),
        );
      });
    }
    const json = await res.json();
    if (json?.error) throw new Error(json.error.message ?? "MCP error");
    return json?.result;
  }

  private nextId = Math.floor(Math.random() * 1_000_000);

  private async requestRaw(method: string, params: unknown, timeoutMs: number) {
    const id = ++this.nextId;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return await Promise.race([
      (async () => {
        const res = await this.post(payload);
        return await this.readResponse(res, id);
      })(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`MCP ${method} timed out after ${timeoutMs / 1000}s`)),
          timeoutMs,
        ),
      ),
    ]);
  }

  async connect() {
    await this.requestRaw(
      "initialize",
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
      INIT_TIMEOUT_MS,
    );
    await this.post(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ).catch(() => {});
  }

  async listTools() {
    const result = await this.requestRaw("tools/list", {}, LIST_TIMEOUT_MS);
    return normalizeTools(result?.tools);
  }

  async callTool(name: string, args: Record<string, unknown>) {
    const result = await this.requestRaw(
      "tools/call",
      { name, arguments: args },
      CALL_TIMEOUT_MS,
    );
    return formatCallResult(result);
  }

  get alive() {
    return !this.aborted;
  }

  async close() {
    this.aborted = true;
  }
}

/** 旧版 SSE（HTTP 传输，2024-11-05）：GET 事件流 + endpoint 事件给出的 POST 地址。 */
class SseConnection implements McpConnection {
  private rpc = new RpcPeer();
  private ctrl = new AbortController();
  private endpoint: string | null = null;
  private endpointWaiter: (() => void) | null = null;

  constructor(private cfg: McpServerConfig) {}

  private async waitForEndpoint(timeoutMs: number) {
    if (this.endpoint) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("MCP SSE: no endpoint event")), timeoutMs);
      this.endpointWaiter = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  async connect() {
    const headers: Record<string, string> = {
      accept: "text/event-stream",
      ...this.cfg.headers,
    };
    const res = await fetch(this.cfg.url, { headers, signal: this.ctrl.signal });
    if (!res.ok || !res.body) {
      throw new Error(`MCP SSE connect failed: HTTP ${res.status} ${res.statusText}`);
    }
    const feed = createSseParser((event, data) => {
      if (event === "endpoint") {
        this.endpoint = new URL(data, this.cfg.url).toString();
        this.endpointWaiter?.();
        this.endpointWaiter = null;
      } else if (event === "message") {
        try {
          this.rpc.handleMessage(JSON.parse(data));
        } catch {}
      }
    });
    void pumpStream(res.body, feed, this.ctrl.signal).then(() => {
      this.rpc.failAll("MCP SSE stream closed");
    });
    await this.waitForEndpoint(INIT_TIMEOUT_MS);
    await this.rpc.request(
      "initialize",
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
      async (payload) => {
        const r = await fetch(this.endpoint!, {
          method: "POST",
          headers: { "content-type": "application/json", ...this.cfg.headers },
          body: payload,
        });
        if (!r.ok) throw new Error(`MCP SSE POST failed: HTTP ${r.status}`);
      },
      INIT_TIMEOUT_MS,
    );
    await this.rpc.notify(
      "notifications/initialized",
      {},
      async (payload) => {
        await fetch(this.endpoint!, {
          method: "POST",
          headers: { "content-type": "application/json", ...this.cfg.headers },
          body: payload,
        }).catch(() => {});
      },
    );
  }

  private async post(payload: string) {
    if (!this.endpoint) throw new Error("MCP SSE: not connected");
    const r = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.cfg.headers },
      body: payload,
    });
    if (!r.ok) throw new Error(`MCP SSE POST failed: HTTP ${r.status}`);
  }

  async listTools() {
    const result = await this.rpc.request("tools/list", {}, (p) => this.post(p), LIST_TIMEOUT_MS);
    return normalizeTools(result?.tools);
  }

  async callTool(name: string, args: Record<string, unknown>) {
    const result = await this.rpc.request(
      "tools/call",
      { name, arguments: args },
      (p) => this.post(p),
      CALL_TIMEOUT_MS,
    );
    return formatCallResult(result);
  }

  get alive() {
    return !this.ctrl.signal.aborted;
  }

  async close() {
    this.ctrl.abort();
    this.rpc.failAll("MCP server closed");
  }
}

function normalizeTools(tools: unknown): McpToolDef[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((t) => t && typeof t === "object")
    .map((t: any) => ({
      name: String(t.name ?? ""),
      description: String(t.description ?? ""),
      inputSchema:
        t.inputSchema && typeof t.inputSchema === "object"
          ? (t.inputSchema as Record<string, unknown>)
          : { type: "object", properties: {} },
    }))
    .filter((t) => t.name.length > 0);
}

function createConnection(cfg: McpServerConfig): McpConnection {
  if (cfg.type === "stdio") return new StdioConnection(cfg);
  if (cfg.type === "sse") return new SseConnection(cfg);
  return new HttpConnection(cfg);
}

// ---------------------------------------------------------------------------
// 服务器 CRUD
// ---------------------------------------------------------------------------

export function listMcpServers(): McpServerConfig[] {
  return db.select().from(mcpServers).all().map(rowToConfig);
}

export function upsertMcpServer(cfg: McpServerConfig): McpServerConfig {
  const values = {
    name: cfg.name.trim(),
    type: cfg.type,
    command: cfg.command.trim(),
    args: JSON.stringify(cfg.args.map((a) => a.trim()).filter(Boolean)),
    url: cfg.url.trim(),
    headers: JSON.stringify(cfg.headers),
    env: JSON.stringify(cfg.env),
    enabled: cfg.enabled ? 1 : 0,
    updatedAt: Date.now(),
  };
  if (cfg.id) {
    db.update(mcpServers).set(values).where(eq(mcpServers.id, cfg.id)).run();
    invalidateConnection(cfg.id);
    return { ...cfg, name: values.name };
  }
  const row = db.insert(mcpServers).values(values).returning().get();
  return rowToConfig(row!);
}

export function deleteMcpServer(id: number) {
  db.delete(mcpServers).where(eq(mcpServers.id, id)).run();
  invalidateConnection(id);
}

export function setMcpServerEnabled(id: number, enabled: boolean) {
  db.update(mcpServers)
    .set({ enabled: enabled ? 1 : 0, updatedAt: Date.now() })
    .where(eq(mcpServers.id, id))
    .run();
  if (!enabled) invalidateConnection(id);
}

/**
 * 解析 Claude Desktop / Cursor 风格的 mcp.json：
 * { "mcpServers": { 名称: { command, args, env } | { url, headers } } }
 */
export function parseMcpJson(text: string): McpServerConfig[] {
  const parsed = JSON.parse(text);
  const servers =
    parsed && typeof parsed === "object"
      ? ((parsed as any).mcpServers ?? (parsed as any).servers ?? parsed)
      : null;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error("Missing mcpServers object");
  }
  const out: McpServerConfig[] = [];
  for (const [name, def] of Object.entries(servers as Record<string, any>)) {
    if (!def || typeof def !== "object") continue;
    const isStdio = typeof def.command === "string" && def.command.trim().length > 0;
    const isRemote = typeof def.url === "string" && def.url.trim().length > 0;
    if (!isStdio && !isRemote) continue;
    out.push({
      name: String(name),
      type: isStdio ? "stdio" : "http",
      command: isStdio ? def.command.trim() : "",
      args: Array.isArray(def.args) ? def.args.map(String) : [],
      url: isRemote ? def.url.trim() : "",
      headers: def.headers && typeof def.headers === "object" ? stringifyMap(def.headers) : {},
      env: def.env && typeof def.env === "object" ? stringifyMap(def.env) : {},
      enabled: true,
    });
  }
  return out;
}

function stringifyMap(v: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (val !== null && val !== undefined) out[k] = String(val);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 连接缓存 + Agent 工具注入
// ---------------------------------------------------------------------------

interface CachedConnection {
  key: string;
  conn: McpConnection;
  tools: McpToolDef[];
  connectedAt: number;
}

const connections = new Map<number, CachedConnection>();

function configKey(cfg: McpServerConfig): string {
  return JSON.stringify([cfg.type, cfg.command, cfg.args, cfg.url, cfg.headers, cfg.env]);
}

function invalidateConnection(id: number) {
  const cached = connections.get(id);
  connections.delete(id);
  if (cached) void cached.conn.close().catch(() => {});
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 24) || "server";
}

function toolId(serverName: string, toolName: string): string {
  const raw = `mcp_${slug(serverName)}_${toolName}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  return raw.slice(0, 64);
}

export interface ConnectedServer {
  cfg: McpServerConfig;
  tools: McpToolDef[];
  error?: string;
}

/** 连接所有启用的服务器（配置未变的复用缓存），失败的服务器不阻塞其余。 */
export async function connectEnabledServers(): Promise<ConnectedServer[]> {
  const rows = db.select().from(mcpServers).where(eq(mcpServers.enabled, 1)).all();
  return Promise.all(
    rows.map(async (row): Promise<ConnectedServer> => {
      const cfg = rowToConfig(row);
      const key = configKey(cfg);
      const cached = connections.get(row.id);
      if (cached && cached.key === key && cached.conn.alive) {
        return { cfg, tools: cached.tools };
      }
      if (cached) invalidateConnection(row.id);
      try {
        const conn = createConnection(cfg);
        await conn.connect();
        const tools = await conn.listTools();
        connections.set(row.id, { key, conn, tools, connectedAt: Date.now() });
        return { cfg, tools };
      } catch (e) {
        return { cfg, tools: [], error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
}

/** 供测试连接与 UI 展示：连接单个服务器并列出工具。cfg.id 存在时优先用库里的配置。 */
export async function testMcpServer(cfg: McpServerConfig): Promise<{
  ok: boolean;
  tools: McpToolDef[];
  error?: string;
}> {
  if (cfg.id) {
    const row = db.select().from(mcpServers).where(eq(mcpServers.id, cfg.id)).get();
    if (row) cfg = rowToConfig(row);
  }
  if (cfg.id) invalidateConnection(cfg.id);
  try {
    const conn = createConnection(cfg);
    await conn.connect();
    const tools = await conn.listTools();
    if (cfg.id) {
      connections.set(cfg.id, { key: configKey(cfg), conn, tools, connectedAt: Date.now() });
    } else {
      void conn.close().catch(() => {});
    }
    return { ok: true, tools };
  } catch (e) {
    return { ok: false, tools: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** 连接状态（给设置页徽标）：缓存里活着才算已连接。 */
export function mcpConnectionStatus(): Record<number, { connected: boolean; toolCount: number }> {
  const out: Record<number, { connected: boolean; toolCount: number }> = {};
  for (const [id, cached] of connections) {
    out[id] = { connected: cached.conn.alive, toolCount: cached.tools.length };
  }
  return out;
}

/**
 * 把启用服务器的工具转成 Pi Agent 的 BuiltTool。
 * 工具名加 `mcp_<服务器>_<工具>` 前缀避免与内置工具撞名；MCP 的 JSON Schema
 * 用 Type.Unsafe 包装（pi-ai 会把 parameters 原样发给模型）。
 */
export async function buildMcpAgentTools(): Promise<BuiltTool[]> {
  const connected = await connectEnabledServers();
  const out: BuiltTool[] = [];
  const usedNames = new Set<string>();
  for (const { cfg, tools } of connected) {
    for (const tool of tools) {
      let name = toolId(cfg.name, tool.name);
      while (usedNames.has(name)) name = `${name}_x`.slice(0, 64);
      usedNames.add(name);
      const serverId = cfg.id!;
      const serverName = cfg.name;
      out.push({
        name,
        label: `${serverName} · ${tool.name}`,
        description: tool.description || `Tool ${tool.name} from MCP server ${serverName}`,
        parameters: Type.Unsafe(tool.inputSchema) as any,
        execute: async (_toolCallId, params: any) => {
          const cached = connections.get(serverId);
          if (!cached || !cached.conn.alive) {
            return errorResult(`MCP server "${serverName}" is not connected`);
          }
          try {
            const text = await cached.conn.callTool(tool.name, params ?? {});
            return textResult(text);
          } catch (e) {
            return errorResult(
              `MCP tool ${serverName}/${tool.name} failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        },
      });
    }
  }
  return out;
}
