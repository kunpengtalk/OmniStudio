/**
 * OmniStudio MCP 服务（挂在本地网关的 /mcp 端点上，Streamable HTTP 传输）：
 * 让 Claude Code / Cursor 等任意 MCP 客户端把 OmniStudio 的本地能力当作
 * 外部工具来用。当前提供两组工具：
 * - 知识库：kb_search / kb_list（检索本地导入的文档资料）；
 * - 记忆：memory_search / memory_save / memory_list（所有 Agent 共享的长期记忆，
 *   与内置 Agent 工具、`omi memory` CLI 读写同一个库）。
 *
 * 鉴权与 /v1/* 一致：设置 GATEWAY_API_KEY 后需要 Bearer Token / x-api-key；
 * 未设置时本机开放访问。
 *
 * 无状态实现：每个 POST 独立处理（不做 session 跟踪），响应直接回 JSON，
 * 这是 Streamable HTTP 规范允许的模式，主流客户端均可连接。
 */
import { listKnowledgeBases, recall } from "./knowledge";
import { mcpPlaygroundHtml } from "./mcp-playground";
import { MEMORY_MCP_TOOLS, handleMemoryMcpCall, isMemoryMcpTool } from "./memory-api";

const PROTOCOL_VERSION = "2025-03-26";
const SERVER_INFO = { name: "omnistudio", version: "1.0.0" };

const TOOL_SEARCH = {
  name: "kb_search",
  description:
    "Search the user's local knowledge bases (imported documents / notes / web pages) " +
    "for content relevant to a query. Returns ranked chunks with source document names. " +
    "Use this whenever the task mentions materials the user may have stored locally.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Search query (natural language ok)." },
      kb: {
        type: "string",
        description: "Optional: knowledge base name or id. Omit to search all bases.",
      },
      top_k: { type: "number", description: "Optional: max chunks to return (default 6)." },
    },
    required: ["query"],
  },
};

const TOOL_LIST = {
  name: "kb_list",
  description: "List the user's local knowledge bases with document/chunk counts.",
  inputSchema: { type: "object" as const, properties: {}, required: [] as string[] },
};

function rpcResult(id: unknown, result: unknown): Response {
  return Response.json(
    { jsonrpc: "2.0", id, result },
    { headers: { "MCP-Protocol-Version": PROTOCOL_VERSION } },
  );
}

function rpcError(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } });
}

function textContent(text: string) {
  return { content: [{ type: "text", text }] };
}

function truncate(text: string, max = 700): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** kb_search 工具实现：解析目标库 → 混合检索 → 排版为可读文本。 */
async function toolSearch(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? "").trim();
  if (!query) return "错误：query 不能为空。";
  const topK = Number(args.top_k) > 0 ? Math.min(30, Math.floor(Number(args.top_k))) : undefined;

  // 只有标记为可对外暴露的库参与 MCP 检索：私人资料库不该因为网关开着就漏出去
  const kbs = listKnowledgeBases().filter((k) => k.mcpExposed);
  if (kbs.length === 0) {
    return "没有可经 MCP 访问的知识库（库的「MCP 可见」开关都是关闭的，或尚未创建）。";
  }

  let targets = kbs;
  const kbArg = args.kb == null ? "" : String(args.kb).trim();
  if (kbArg) {
    const lowered = kbArg.toLowerCase();
    targets = kbs.filter((k) => String(k.id) === kbArg || k.name.toLowerCase() === lowered);
    if (targets.length === 0) {
      return (
        `没有找到名为/id 为「${kbArg}」的知识库。可用知识库：\n` +
        kbs.map((k) => `- ${k.name}（id=${k.id}）`).join("\n")
      );
    }
  }

  const { hits, notes } = await recall(
    targets.map((k) => k.id),
    query,
    topK,
    { actor: "mcp" },
  );
  if (hits.length === 0) {
    return "没有检索到相关内容。可以换个问法，或提示用户补充资料。";
  }

  const lines = hits.map(
    (h, i) =>
      `[${i + 1}] 《${h.docName}》分块 ${h.seq} · ${h.kbName} · 相关度 ${h.score.toFixed(2)}\n` +
      truncate(h.content),
  );
  const header = `在 ${targets.map((t) => t.name).join("、")} 中找到 ${hits.length} 条相关片段：\n\n`;
  return header + lines.join("\n\n") + (notes.length ? `\n\n注意：${notes.join("；")}` : "");
}

/** kb_list 工具实现。 */
function toolList(): string {
  const kbs = listKnowledgeBases().filter((k) => k.mcpExposed);
  if (kbs.length === 0) return "没有可经 MCP 访问的知识库。";
  return (
    `共 ${kbs.length} 个可用知识库：\n` +
    kbs
      .map(
        (k) =>
          `- ${k.name}（id=${k.id}）：${k.docCount} 个文档，${k.chunkCount} 个分块` +
          (k.embeddingModel ? `，嵌入模型 ${k.embeddingModel}` : "，纯关键词检索"),
      )
      .join("\n")
  );
}

function handleRpc(msg: {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}): Response | null {
  const { id, method } = msg;
  // notification（无 id）无需响应体
  if (id === undefined || id === null) {
    if (method?.startsWith("notifications/")) return new Response(null, { status: 202 });
    return null;
  }
  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: [TOOL_SEARCH, TOOL_LIST, ...MEMORY_MCP_TOOLS] });
    // tools/call 涉及异步检索，在 handleMcpRequest 入口单独处理，不会走到这里。
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** 网关路由入口：POST /mcp。浏览器 GET（Accept 含 text/html）返回调试工作台。 */
export async function handleMcpRequest(req: Request): Promise<Response> {
  if (req.method === "GET") {
    // 浏览器直接打开时给 FastMCP Playground 式的调试界面；
    // MCP 客户端的 GET（要 SSE 流）维持 405，符合无状态实现。
    const accept = req.headers.get("accept") ?? "";
    if (accept.includes("text/html")) {
      return new Response(mcpPlaygroundHtml(), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    return new Response("SSE streaming not supported; use POST", { status: 405 });
  }
  if (req.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return rpcError(null, -32700, "Parse error");
  }

  // tools/call 是异步的，单独走完整路径再进入 handleRpc 的同步分发
  const msgs = Array.isArray(body) ? body : [body];
  const single = !Array.isArray(body);
  const outputs: (Response | null)[] = [];
  for (const msg of msgs) {
    if (!msg || typeof msg !== "object") {
      outputs.push(rpcError(null, -32600, "Invalid Request"));
      continue;
    }
    const m = msg as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
    if (m.method === "tools/call" && m.id !== undefined && m.id !== null) {
      const name = String(m.params?.name ?? "");
      const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const text = name === "kb_search" ? await toolSearch(args) : name === "kb_list" ? toolList() : null;
        if (text === null && isMemoryMcpTool(name)) {
          const { text: memText, isError } = await handleMemoryMcpCall(name, args);
          outputs.push(
            rpcResult(m.id, {
              content: [{ type: "text", text: memText }],
              ...(isError ? { isError: true } : {}),
            }),
          );
        } else if (text === null) {
          outputs.push(rpcError(m.id, -32602, `Unknown tool: ${name}`));
        } else {
          outputs.push(rpcResult(m.id, textContent(text)));
        }
      } catch (e) {
        outputs.push(
          rpcResult(m.id, {
            content: [{ type: "text", text: `工具执行失败：${e instanceof Error ? e.message : String(e)}` }],
            isError: true,
          }),
        );
      }
      continue;
    }
    outputs.push(handleRpc(m));
  }

  const responses = outputs.filter((r): r is Response => r !== null);
  if (responses.length === 0) return new Response(null, { status: 202 });
  if (single) return responses[0]!;
  // 批量请求按规范逐条响应（简化：返回首个非空响应的 JSON 数组形式）
  const payloads = await Promise.all(
    responses.map(async (r) => (r.body ? await r.json() : null)),
  );
  return Response.json(payloads.filter(Boolean));
}

/** 生成给客户端用的接入配置示例（mcpServers JSON 片段）。 */
export function mcpClientConfig(host: string, port: number, apiKey: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        "omnistudio-kb": {
          type: "http",
          url: `http://${host}:${port}/mcp`,
          ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
        },
      },
    },
    null,
    2,
  );
}
