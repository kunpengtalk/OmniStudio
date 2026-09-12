/**
 * MCP 功能冒烟：临时数据目录 → 迁移 → CRUD → stdio 连接 → 工具枚举/调用 → JSON 解析。
 * 跑法：OMNI_DATA_DIR=/tmp/mcp-smoke bun run scripts/mcp-smoke.ts
 * （原理同 skills-smoke：db/index.ts 自行计算数据目录，兼容源码运行。）
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

// 先准备环境再 import 业务模块（db 打开即跑迁移）。
// 每次运行用独立目录：固定目录名会让第二轮运行读到上一轮写入的服务器配置与
// echo-server.ts 残留 —— 冒烟脚本必须可重复运行。
const providedDataDir = process.env.OMNI_DATA_DIR;
const dataDir = providedDataDir ?? mkdtempSync(path.join(tmpdir(), "omni-mcp-smoke-"));
mkdirSync(dataDir, { recursive: true });
process.env.OMNI_DATA_DIR = dataDir;

// 一个最小的 stdio MCP 服务器：echo 工具。
const serverPath = path.join(dataDir, "echo-server.ts");
writeFileSync(
  serverPath,
  `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\\n");
rl.on("line", (line: string) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "smoke", version: "1.0.0" } } });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } });
  } else if (msg.method === "tools/call") {
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo: " + msg.params.arguments.text }] } });
  }
  // notifications/initialized 等通知不回复
});
`,
);

const { upsertMcpServer, listMcpServers, testMcpServer, buildMcpAgentTools, parseMcpJson, setMcpServerEnabled, deleteMcpServer } = await import("../src/bun/mcp");

let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — ${detail ?? ""}`}`);
  if (!ok) failed++;
};

// 1. CRUD
const saved = upsertMcpServer({
  name: "echo",
  type: "stdio",
  command: "bun",
  args: [serverPath],
  url: "",
  headers: {},
  env: {},
  enabled: true,
});
check("upsert 拿到 id", typeof saved.id === "number");
check("list 有 1 台", listMcpServers().length === 1);

// 2. 连接 + 枚举工具
const test = await testMcpServer(saved);
check("stdio 连接成功", test.ok, test.error);
check("枚举到 echo 工具", test.ok && test.tools.length === 1 && test.tools[0]?.name === "echo");

// 3. Agent 工具注入 + 调用
const tools = await buildMcpAgentTools();
const echoTool = tools.find((t) => t.name.startsWith("mcp_echo_"));
check("Agent 工具带 mcp_ 前缀", Boolean(echoTool), JSON.stringify(tools.map((t) => t.name)));
if (echoTool) {
  const res = await echoTool.execute("call-1", { text: "hi" });
  const text = (res.content as { type: string; text: string }[]).find((c) => c.type === "text")?.text;
  check("工具调用回显", text === "echo: hi", text);
}

// 4. 开关
setMcpServerEnabled(saved.id!, false);
check("停用后 Agent 工具为空", (await buildMcpAgentTools()).length === 0);
setMcpServerEnabled(saved.id!, true);
check("再启用恢复 1 个工具", (await buildMcpAgentTools()).length === 1);

// 5. JSON 解析（Claude Desktop 格式）
const parsed = parseMcpJson(
  JSON.stringify({
    mcpServers: {
      filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
      remote: { url: "https://example.com/mcp", headers: { Authorization: "Bearer x" } },
    },
  }),
);
check("json 解析 2 台", parsed.length === 2);
const p0 = parsed[0];
const p1 = parsed[1];
check("stdio 归类", p0?.type === "stdio" && p0.command === "npx" && p0.args.length === 3);
check("http 归类", p1?.type === "http" && p1.url === "https://example.com/mcp");

// 6. 删除
deleteMcpServer(saved.id!);
check("删除后列表为空", listMcpServers().length === 0);

// 7. Streamable HTTP 传输：本地起一个最小 MCP HTTP 服务器验证 HttpConnection。
const httpServer = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const msg = await req.json();
    const reply = (result: unknown, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), {
        headers: { "content-type": "application/json", ...extra },
      });
    if (msg.method === "initialize") {
      return reply(
        { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "http-smoke", version: "1" } },
        { "mcp-session-id": "sess-1" },
      );
    }
    if (msg.method === "tools/list") {
      return reply({
        tools: [
          { name: "add", description: "a + b", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } },
        ],
      });
    }
    if (msg.method === "tools/call") {
      return reply({ content: [{ type: "text", text: String(msg.params.arguments.a + msg.params.arguments.b) }] });
    }
    return new Response(null, { status: 202 });
  },
});
const httpSaved = upsertMcpServer({
  name: "math",
  type: "http",
  command: "",
  args: [],
  url: `http://127.0.0.1:${httpServer.port}/mcp`,
  headers: {},
  env: {},
  enabled: true,
});
const httpTest = await testMcpServer(httpSaved);
check("http 连接成功", httpTest.ok, httpTest.error);
check("http 枚举到 add 工具", httpTest.ok && httpTest.tools[0]?.name === "add");
const httpTools = await buildMcpAgentTools();
const addTool = httpTools.find((t) => t.name.startsWith("mcp_math_"));
if (addTool) {
  const res = await addTool.execute("call-2", { a: 2, b: 3 });
  const text = (res.content as { type: string; text: string }[]).find((c) => c.type === "text")?.text;
  check("http 工具调用 2+3=5", text === "5", text);
} else {
  check("http 工具注入", false);
}
deleteMcpServer(httpSaved.id!);
httpServer.stop(true);

// 只清理自己建的临时目录；调用方显式指定 OMNI_DATA_DIR 时保留现场。
if (!providedDataDir) {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {}
}

console.log(failed === 0 ? "\nMCP smoke 全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
