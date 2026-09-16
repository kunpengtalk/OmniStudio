/**
 * 网页端（`/chat`、`/agent`）：把桌面端的**同一份 React 界面**搬到浏览器里跑。
 *
 * 做法不是"照着重画一个页面"，而是让浏览器加载应用自己的前端产物，只换掉传输层：
 *   - 静态资源：直接把构建出来的 webview（`views/mainview/`）当静态站点发出去；
 *   - 请求：浏览器里的 `lib/rpc.ts` 把 RPC 请求 POST 到 `/v1/web/rpc`，这里按
 *     `rpc/index.ts` 导出的**同一张处理器表**分发（界面同一套、实现同一份）；
 *   - 推送：给现有的 `init*Broadcast(win)` 喂一个"假窗口"，它们发出去的
 *     `win.webview.rpc.send.<name>(payload)` 全部转成 SSE 发给浏览器。
 *
 * 因此对话与 Agent 页面的每一像素、每条数据流都与桌面端同源；差别只有两处，
 * 都是刻意的：右侧工作面板（终端 / 浏览器 / 评审）不渲染，暴露面用白名单收口
 * （见 rpc/index.ts 的 REMOTE_METHODS）。
 *
 * 静态页面本身不需要 Key（同 /docs）；所有数据接口与媒体代理都要。
 */
import { existsSync, readFileSync, statSync } from "fs";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { join, resolve, sep } from "path";

import { IMAGE_SERVER_HOST, imageServerPort } from "../shared/server-info";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, x-api-key",
};

// ---------------------------------------------------------------------------
// 与主进程其余部分的接线（避免 gateway ↔ rpc 的循环依赖，由 index.ts 注入）
// ---------------------------------------------------------------------------

export type WebBridge = {
  /** 按同一张处理器表分发一个 RPC 请求，并附带白名单判定结果。 */
  dispatch: (method: string, params: unknown) => Promise<{ ok: boolean; payload?: unknown; error?: string }>;
  /** 把现有的一批 init*Broadcast 挂到假窗口上，推送经 broadcast 出去。 */
  initBroadcast: (broadcast: (name: string, payload: unknown) => void) => void;
  /** 新客户端连上时补推当前状态（推送只在变化时发，晚连的客户端会缺初始快照）。 */
  replayStatus: (send: (name: string, payload: unknown) => void) => void;
};

let bridge: WebBridge | null = null;

/**
 * 由主进程启动时注入（bun/index.ts）。
 *
 * 注入的同时就把推送接线挂上：那批 `init*Broadcast` 只是订阅全局事件、
 * 把 `send.<名字>` 接到我们的 SSE 出口 —— 不在这里调用，网页端就只有状态补推、
 * 看不到回合内的任何增量（对话与 Agent 会"发了没反应"）。
 */
export function installWebBridge(next: WebBridge): void {
  bridge = next;
  next.initBroadcast(broadcastToWebClients);
}

// ---------------------------------------------------------------------------
// 静态资源
// ---------------------------------------------------------------------------

/**
 * 前端产物的位置。
 *
 * 打包后主进程在 `Resources/app/bun/index.js`，视图在 `Resources/app/views/mainview/`；
 * 从源码跑（bun test / 未打包）时 vite 把产物写到 `apps/studio/dist/`。两处都试。
 */
export function resolveWebAppDir(): string | null {
  const candidates = [
    join(import.meta.dir, "..", "views", "mainview"),
    join(import.meta.dir, "..", "..", "dist"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "index.html"))) return dir;
  }
  return null;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

/** 只服务前端产物目录内的文件：解析后的路径必须还在目录里（挡 `../` 逃逸）。 */
function serveAssetFile(root: string, relative: string): Response | null {
  const normalized = relative.replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0")) return null;
  const full = resolve(root, normalized);
  if (full !== root && !full.startsWith(root + sep)) return null;
  if (!existsSync(full)) return null;
  let stat;
  try {
    stat = statSync(full);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const ext = full.slice(full.lastIndexOf(".")).toLowerCase();
  const type = CONTENT_TYPES[ext] ?? "application/octet-stream";
  // 带内容哈希的产物可以长缓存（隧道那头的客户下次打开就快）；入口 HTML 不能缓存。
  const immutable = ext !== ".html" && /-[A-Za-z0-9_]{8,}\./.test(full);
  try {
    return new Response(readFileSync(full), {
      headers: {
        "Content-Type": type,
        "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
        ...CORS,
      },
    });
  } catch {
    return null;
  }
}

/** `/chat`、`/agent` 共用同一份入口 HTML，由前端按 pathname 决定渲染哪个窗口。 */
export function serveWebAppPage(): Response {
  const root = resolveWebAppDir();
  const html = root ? serveAssetFile(root, "index.html") : null;
  if (html) return html;
  return new Response(
    "<!doctype html><meta charset=utf-8><title>OmniStudio</title>" +
      "<p style='font:14px system-ui;padding:24px'>前端产物未找到：请先构建界面（<code>bun run build</code>），" +
      "或在桌面端里打开一次窗口后再试。</p>",
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", ...CORS } },
  );
}

export function serveWebAsset(pathname: string): Response | null {
  const root = resolveWebAppDir();
  if (!root) return null;
  if (pathname === "/favicon.ico" || pathname === "/favicon.svg") {
    return serveAssetFile(root, pathname);
  }
  if (!pathname.startsWith("/assets/")) return null;
  return serveAssetFile(root, pathname);
}

// ---------------------------------------------------------------------------
// 媒体代理的会话票据
// ---------------------------------------------------------------------------

/**
 * `<img src>` / `<video src>` 不会带 Authorization 头，而这些地址又要能远程访问。
 * 于是：RPC 桥鉴权通过时下发一枚签名 Cookie，媒体路由认 Cookie 或 Header 两者之一。
 * 票据 = HMAC(进程密钥, 过期时间)，不需要存服务端状态；进程重启即全部失效。
 */
const MEDIA_COOKIE = "omni_media";
const MEDIA_TICKET_TTL_MS = 12 * 60 * 60 * 1000;
const ticketSecret = randomBytes(32);

function signTicket(expiresAt: number): string {
  const mac = createHmac("sha256", ticketSecret).update(String(expiresAt)).digest("base64url");
  return `${expiresAt}.${mac}`;
}

export function issueMediaCookie(): string {
  const expiresAt = Date.now() + MEDIA_TICKET_TTL_MS;
  return `${MEDIA_COOKIE}=${signTicket(expiresAt)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(
    MEDIA_TICKET_TTL_MS / 1000,
  )}`;
}

/** 媒体路由的放行判定：带 Key 的调用方，或已经拿到票据 Cookie 的浏览器。 */
export function mediaTicketValid(req: Request): boolean {
  const raw = (req.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${MEDIA_COOKIE}=`));
  if (!raw) return false;
  const value = raw.slice(MEDIA_COOKIE.length + 1);
  const [expiresRaw, mac] = value.split(".");
  const expiresAt = Number(expiresRaw);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now() || !mac) return false;
  const expected = signTicket(expiresAt).split(".")[1] ?? "";
  try {
    return timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 事件流
// ---------------------------------------------------------------------------

type WebClient = { send: (name: string, payload: unknown) => void };

const clients = new Set<WebClient>();

/** 给所有已连接的网页端推一条消息（名字与桌面端 RPC 的推送同名）。 */
export function broadcastToWebClients(name: string, payload: unknown): void {
  for (const client of clients) {
    try {
      client.send(name, payload);
    } catch {
      clients.delete(client);
    }
  }
}

/**
 * 事件流的**主通道是 WebSocket**（`/v1/web/ws`），不是 SSE。
 *
 * 原因：Cloudflare 隧道会把 SSE 响应整段缓冲住 —— 实测隧道域名下 40 秒内 0 字节
 * （心跳、2KB 开场填充都试过，回环直连正常），表现就是"回复都出来了，界面还停在
 * 处理中"，因为 chunk / chatDone 根本没送达。WebSocket 是 Cloudflare 明确支持的
 * 长连接，握手会带 Cookie，所以用 RPC 桥下发的那枚票据做鉴权即可。
 */

/** WebSocket 客户端的存活登记（open 时挂上，close 时摘掉）。 */
export function webSocketOpened(ws: { send: (data: string) => void }): () => void {
  const client: WebClient = {
    send(name, payload) {
      ws.send(JSON.stringify({ name, payload }));
    },
  };
  clients.add(client);
  client.send("ready", {});
  // 新连上的客户端补推一次当前状态（推送是"变化时发"，晚连的会缺初始快照）。
  bridge?.replayStatus((name, payload) => client.send(name, payload));
  return () => clients.delete(client);
}

/** WebSocket 握手鉴权：票据 Cookie（RPC 桥下发）或 `?key=`（curl / 脚本用）。 */
export function webSocketAuthorized(req: Request, url: URL): boolean {
  return mediaTicketValid(req) || Boolean(url.searchParams.get("key"));
}

export function isWebSocketPath(path: string): boolean {
  return path === "/v1/web/ws";
}

function eventStream(): Response {
  const encoder = new TextEncoder();
  let alive = true;
  let ping: ReturnType<typeof setInterval> | null = null;
  let client: WebClient | null = null;

  const stop = () => {
    alive = false;
    if (ping) clearInterval(ping);
    ping = null;
    if (client) clients.delete(client);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      client = {
        send(name, payload) {
          if (!alive) return;
          try {
            controller.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`));
          } catch {
            stop();
          }
        },
      };
      clients.add(client);
      // 开场先灌一段注释填充再发 ready：有些反代/边缘会把"看起来不像流"的响应先缓冲
      // 起来（回环直连不受影响，所以只有真跑一遍隧道才发现）。
      controller.enqueue(encoder.encode(`: ${" ".repeat(2048)}\n\n`));
      controller.enqueue(encoder.encode("event: ready\ndata: {}\n\n"));
      if (client) {
        const current = client;
        bridge?.replayStatus((name, payload) => current.send(name, payload));
      }
      // 心跳：Bun 默认 10 秒空闲就关连接，隧道/CDN 也各有空闲超时。带填充是为了
      // 让边缘别把它攒在缓冲里。
      ping = setInterval(() => {
        if (!alive) return;
        try {
          controller.enqueue(encoder.encode(`: ${" ".repeat(512)}\n\n`));
        } catch {
          stop();
        }
      }, 5_000);
    },
    cancel() {
      stop();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...CORS,
    },
  });
}

// ---------------------------------------------------------------------------
// 媒体代理
// ---------------------------------------------------------------------------

/**
 * 把媒体服务的文件透出去（`/media/<path>` → `127.0.0.1:19782/<path>`）。
 *
 * 媒体服务本身无鉴权且只绑回环，所以这里必须由网关自己把门：靠上面的会话票据或
 * Key。Range 头要原样转发（视频拖动、音频播放都依赖它），响应头里的
 * Content-Type / Content-Length / Accept-Ranges / Content-Range 也要带回去。
 */
async function proxyMedia(req: Request, url: URL): Promise<Response> {
  const target = `http://${IMAGE_SERVER_HOST}:${imageServerPort()}${url.pathname.slice("/media".length)}${url.search}`;
  const headers = new Headers();
  const range = req.headers.get("range");
  if (range) headers.set("Range", range);
  const ifNoneMatch = req.headers.get("if-none-match");
  if (ifNoneMatch) headers.set("If-None-Match", ifNoneMatch);

  let upstream: Response;
  try {
    upstream = await fetch(target, { method: req.method === "HEAD" ? "HEAD" : "GET", headers });
  } catch (error) {
    return new Response(`媒体服务不可用：${error instanceof Error ? error.message : String(error)}`, {
      status: 502,
      ...CORS,
    });
  }
  const passHeaders = new Headers(CORS);
  for (const name of ["content-type", "content-length", "accept-ranges", "content-range", "etag", "last-modified"]) {
    const value = upstream.headers.get(name);
    if (value) passHeaders.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: passHeaders });
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extra },
  });
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

/**
 * `/v1/web/*` 与 `/media/*` 的入口；返回 null 表示不归这里管。
 *
 * 鉴权不在这里做：这两条路径都在网关的 Key 校验之后（见 gateway.ts 的
 * `path.startsWith("/v1/") || path.startsWith("/media/")`），媒体路由额外认票据 Cookie。
 */
export async function handleWebRequest(req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname;

  if (path === "/v1/web/rpc" && req.method === "POST") {
    if (!bridge) return json({ error: { message: "网页端桥未就绪" } }, 503);
    const body = (await readJson(req)) as { id?: number; method?: string; params?: unknown } | null;
    const method = body?.method;
    if (!method) return json({ error: { message: "缺少 method" } }, 400);
    const result = await bridge.dispatch(method, body?.params);
    // 顺带下发媒体票据：之后 <img>/<video> 直接带 Cookie 就能取图，不必再塞 Key。
    return json({ id: body?.id ?? null, ...result }, 200, {
      "Set-Cookie": issueMediaCookie(),
    });
  }

  if (path === "/v1/web/rpc/events") {
    if (req.method !== "GET") return json({ error: { message: "Method Not Allowed" } }, 405);
    if (!bridge) return json({ error: { message: "网页端桥未就绪" } }, 503);
    return eventStream();
  }

  // WebSocket 的事件流由网关自己 upgrade（见 gateway.ts 的 websocket 处理），
  // 走到这里说明 upgrade 没成功。
  if (isWebSocketPath(path)) {
    return json({ error: { message: "WebSocket upgrade failed" } }, 400);
  }

  if (path.startsWith("/media/")) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return json({ error: { message: "Method Not Allowed" } }, 405);
    }
    return await proxyMedia(req, url);
  }

  return null;
}
