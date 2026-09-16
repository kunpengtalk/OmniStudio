/**
 * 网页端运行时支持：同一份前端产物，在浏览器里跑时把传输层从 Electrobun 换成 HTTP。
 *
 * 桌面端由 Electrobun 的 WebSocket 桥连接主进程（`window.__electrobun` 由预加载脚本注入）；
 * 浏览器里没有那套桥，于是：
 *   - 请求：RPC 的 `send` 变成 POST `/v1/web/rpc`，返回后按 RPC 的响应格式喂回同一条链路；
 *   - 推送：`/v1/web/rpc/events` 是 SSE，帧名就是桌面端 `send.<名字>` 里那个名字。
 *
 * 这样上层（stores / 组件 / 处理器）一行都不用改 —— 换的只是管道。
 */
/**
 * RPC 传输层的最小形状（与 electrobun 的 `RPCTransport` 结构一致）。
 * 这里自己声明而不是 import：`electrobun/view` 没有导出那个类型，
 * 而结构类型已经足够让 `setTransport` 接受。
 */
export type HttpRpcTransport = {
  send: (data: unknown) => void;
  registerHandler?: (handler: (data: unknown) => void) => void;
  unregisterHandler?: () => void;
};

/**
 * 浏览器里跑的同一份界面（没有 Electrobun 预加载桥）。
 *
 * 判据必须排除测试环境：jsdom / happy-dom 里同样没有 `window.__electrobun`，
 * 但那不是网页端 —— 否则单测会跑成"远程版界面"，把桌面端的用例全带偏。
 */
export function isRemoteClient(): boolean {
  if (typeof window === "undefined") return false;
  if ((window as { __electrobun?: unknown }).__electrobun) return false;
  if (typeof process !== "undefined" && process.env?.NODE_ENV === "test") return false;
  return true;
}

const KEY_STORE = "omni-gateway-key";

export function getApiKey(): string {
  try {
    return localStorage.getItem(KEY_STORE) ?? "";
  } catch {
    return "";
  }
}

export function setApiKey(key: string): void {
  try {
    localStorage.setItem(KEY_STORE, key.trim());
  } catch {
    // 隐私模式下 localStorage 可能不可用：当次会话仍可用，刷新后要重填
  }
}

function authHeaders(): Record<string, string> {
  const key = getApiKey();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

export const UNAUTHORIZED_EVENT = "omni-remote-unauthorized";

/**
 * 收到 401 时判定"是不是真的该报密钥失效"。
 *
 * 必须比对**这次请求发出去时用的那把 Key**：首屏、重试、换密钥三种时刻会交叉 —— 一条
 * 没有 Key 的老请求（或它的重试）完全可能在用户刚粘完 Key 之后才返回 401，若不比对，
 * 就会把刚刚存好的 Key 当成错的清掉，用户看到的是"粘贴后又被弹回输入框"。
 */
function shouldReportUnauthorized(sentWith: string): boolean {
  const current = getApiKey();
  return Boolean(sentWith) && sentWith === current;
}

function notifyUnauthorized(): void {
  try {
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  } catch {
    // ignore
  }
}

/**
 * 事件流订阅：**WebSocket**。
 *
 * 为什么不是 SSE：Cloudflare 隧道会把 SSE 响应整段缓冲住（实测隧道域名下 40 秒
 * 0 字节，心跳与 2KB 开场填充都试过；回环直连却完全正常），后果是界面拿不到
 * chunk / chatDone —— 回复都显示完了还停在"处理中"。WS 是隧道明确支持的长连接。
 *
 * 鉴权：浏览器不能在 WS 握手上加 Authorization 头，所以走网关下发的那枚票据
 * Cookie（RPC 桥第一次鉴权成功时就种下了）。因此首连可能早于票据存在，失败要重试 ——
 * 退避最多 8 秒，票据一到位下一次就连上了。
 */
function subscribeMessages(handler: (data: unknown) => void): void {
  let attempt = 0;
  let stopped = false;

  const connect = () => {
    if (stopped) return;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${proto}//${window.location.host}/v1/web/ws`);
    let failed = false;

    socket.onopen = () => {
      attempt = 0;
    };
    socket.onmessage = (event) => {
      try {
        const frame = JSON.parse(String(event.data)) as { name?: string; payload?: unknown };
        if (frame?.name && frame.name !== "ready") {
          handler({ type: "message", id: frame.name, payload: frame.payload });
        }
      } catch {
        // 单帧解析失败不该打断整条流
      }
    };
    socket.onerror = () => {
      failed = true;
    };
    socket.onclose = () => {
      if (stopped) return;
      // 关得越快说明越可能是"票据还没到位"或网络刚断：退避重连。
      attempt += 1;
      const delay = failed ? Math.min(1000 * 2 ** Math.min(attempt, 3), 8000) : 1000;
      setTimeout(connect, delay);
    };
  };

  connect();
  window.addEventListener("pagehide", () => {
    stopped = true;
  });
}

/** 把 RPC 的传输层换成 HTTP + SSE。 */
export function createHttpTransport(): HttpRpcTransport {
  let handler: ((data: unknown) => void) | undefined;
  let subscribed = false;

  return {
    send(data: unknown) {
      const message = data as { type?: string; id?: number; method?: string; params?: unknown };
      if (message?.type !== "request") return; // 桌面端也没有 webview → bun 的 message，本期不需要
      const requestId = message.id ?? 0;
      const sentWith = getApiKey();
      void fetch("/v1/web/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ id: requestId, method: message.method, params: message.params }),
      })
        .then(async (res) => {
          const body = (await res.json().catch(() => null)) as
            | { ok?: boolean; payload?: unknown; error?: string }
            | null;
          if (res.status === 401) {
            if (shouldReportUnauthorized(sentWith)) notifyUnauthorized();
            handler?.({
              type: "response",
              id: requestId,
              success: false,
              error: "unauthorized",
            });
            return;
          }
          handler?.({
            type: "response",
            id: requestId,
            success: body?.ok === true,
            payload: body?.payload,
            error: body?.error,
          });
        })
        .catch((error) => {
          handler?.({
            type: "response",
            id: requestId,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    registerHandler(next: (data: unknown) => void) {
      handler = next;
      if (!subscribed) {
        subscribed = true;
        subscribeMessages((data) => handler?.(data));
      }
    },
  };
}
