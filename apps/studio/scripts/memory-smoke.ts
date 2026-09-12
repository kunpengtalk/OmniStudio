/**
 * 记忆功能冒烟：临时数据目录 → 迁移 → CRUD → 检索热度 → Agent 工具 → 系统提示注入 → 开关。
 * 跑法：OMNI_DATA_DIR=/tmp/omni-memory-smoke bun run scripts/memory-smoke.ts
 */
import { mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const dataDir = process.env.OMNI_DATA_DIR ?? path.join(tmpdir(), "omni-memory-smoke");
mkdirSync(dataDir, { recursive: true });
process.env.OMNI_DATA_DIR = dataDir;

const memory = await import("../src/bun/memory");
const { updateSettings } = await import("../src/bun/db/settings");

let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — ${detail ?? ""}`}`);
  if (!ok) failed++;
};

// 1. 手工 CRUD
const m1 = memory.saveMemory({ content: "用户偏好简洁的中文回复", category: "preference", tags: ["偏好", "语言"] });
const m2 = memory.saveMemory({ content: "部署走 bun，不用 npm", category: "experience", tags: ["部署"] });
check("插入拿到 id", m1.id > 0 && m2.id > m1.id);
check("列表 2 条、置顶优先", memory.listMemories().length === 2);
memory.setMemoryPinned(m2.id, true);
check("置顶排序在最前", memory.listMemories()[0].id === m2.id);
const edited = memory.saveMemory({ id: m1.id, content: "用户偏好简洁的中文回复（更新）", category: "preference", tags: ["偏好"] });
check("编辑保留 id", edited.id === m1.id && edited.content.includes("更新"));

// 2. 检索（内容 + 标签）与热度
const hits = memory.searchMemories("部署");
check("按内容检索命中", hits.length === 1 && hits[0].id === m2.id);
check("检索累计使用次数", memory.listMemories().find((m) => m.id === m2.id)!.usageCount === 1);
const tagHits = memory.searchMemories("偏好");
check("按标签检索命中", tagHits.some((m) => m.id === m1.id));

// 3. Agent 工具（所有模型共享同一对工具）
const tools = memory.buildMemoryAgentTools();
const search = tools.find((t) => t.name === "memory_search");
const save = tools.find((t) => t.name === "memory_save");
check("提供 memory_search / memory_save", Boolean(search && save));
if (search && save) {
  const res = await search.execute("c1", { query: "偏好" });
  const text = (res.content as { type: string; text: string }[])[0].text;
  check("memory_search 返回记忆", text.includes("简洁的中文回复"), text);
  await save.execute("c2", { content: "用户的项目是 OmniStudio", category: "fact", tags: ["项目"] });
  check("memory_save 落库（source=agent）", memory.listMemories().some((m) => m.source === "agent" && m.content.includes("OmniStudio")));
  await save.execute("c3", { content: "用户的项目是 OmniStudio" });
  check("重复保存合并不重复", memory.listMemories().filter((m) => m.content.includes("OmniStudio")).length === 1);
}

// 4. 系统提示注入
const section = memory.memoryPromptSection();
check("提示注入包含置顶记忆", Boolean(section && section.includes("部署走 bun") && section.includes("置顶")), section ?? "(null)");

// 5. 总开关
updateSettings({ MEMORY_ENABLED: "0" });
check("关闭后不再注入", memory.memoryPromptSection() === null);
check("关闭后工具不受 buildMemoryAgentTools 影响（由 agent.ts 按 memoryEnabled 过滤）", memory.buildMemoryAgentTools().length === 2);
updateSettings({ MEMORY_ENABLED: "1" });
check("重新开启恢复注入", memory.memoryPromptSection() !== null);

// 6. 删除
memory.deleteMemory(m1.id);
check("删除后剩 2 条", memory.listMemories().length === 2);

// 7. 同步到外部 Agent（baseDir 指到临时 home，不碰真实文件）
const { mkdirSync: mk, writeFileSync: wf, readFileSync: rf } = await import("fs");
const syncMod = await import("../src/bun/memory-sync");
const tmpHome = path.join(dataDir, "fake-home");
mk(path.join(tmpHome, ".claude"), { recursive: true });
wf(path.join(tmpHome, ".claude", "CLAUDE.md"), "# 我的私有笔记\n\n别动我。\n");
const syncRes = syncMod.syncMemoryToTools(["claude"], tmpHome);
check("同步返回成功", syncRes[0]?.ok === true, JSON.stringify(syncRes));
const md = rf(path.join(tmpHome, ".claude", "CLAUDE.md"), "utf8");
check("区块写入且保留用户内容", md.includes("别动我。") && md.includes("部署走 bun") && md.includes("omni-memory:start"));
check("区块含写回指引", md.includes("omi memory add"));
// 记忆变化后重新同步 → 原地替换（marker 只有一对）
memory.saveMemory({ content: "新记忆：测试同步刷新", category: "fact" });
syncMod.syncMemoryToTools(["claude"], tmpHome);
const md2 = rf(path.join(tmpHome, ".claude", "CLAUDE.md"), "utf8");
check("重复同步原地替换", md2.includes("测试同步刷新") && md2.split("omni-memory:start").length === 2 && md2.includes("别动我。"));
const status = syncMod.memorySyncStatus(tmpHome);
check("状态回报 hasBlock", status.find((s) => s.tool === "claude")?.hasBlock === true);
syncMod.removeMemoryFromTools(["claude"], tmpHome);
const md3 = rf(path.join(tmpHome, ".claude", "CLAUDE.md"), "utf8");
check("移除区块后用户内容保留", !md3.includes("omni-memory:start") && md3.includes("别动我。"));

// 8. MCP 桥接端到端：子进程跑 omi memory mcp，JSON-RPC 握手 → 枚举 → 写回
const omiEntry = path.join(import.meta.dir, "..", "bin", "omi.ts");
const mcp = Bun.spawn(["bun", "run", omiEntry, "memory", "mcp"], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, OMNI_DATA_DIR: dataDir },
});
const send = (obj: unknown) => mcp.stdin!.write(JSON.stringify(obj) + "\n");
const replies: any[] = [];
void (async () => {
  const decoder = new TextDecoder();
  let buf = "";
  const reader = mcp.stdout!.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) {
        try { replies.push(JSON.parse(line)); } catch {}
      }
    }
  }
})();
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_save", arguments: { content: "MCP 桥接写入的记忆", category: "fact" } } });
send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "memory_search", arguments: { query: "桥接" } } });
await new Promise((r) => setTimeout(r, 2500));
const byId = (id: number) => replies.find((m) => m.id === id);
check("MCP initialize 握手", byId(1)?.result?.serverInfo?.name === "omni-memory", JSON.stringify(byId(1)));
const toolNames = (byId(2)?.result?.tools ?? []).map((t: any) => t.name);
check("MCP 工具枚举", toolNames.includes("memory_search") && toolNames.includes("memory_save") && toolNames.includes("memory_list"), JSON.stringify(toolNames));
check("MCP memory_save 写回", String(byId(3)?.result?.content?.[0]?.text ?? "").includes("Saved memory #"));
check("MCP memory_search 检索", String(byId(4)?.result?.content?.[0]?.text ?? "").includes("MCP 桥接写入的记忆"));
check("桥接写入落到同一库", memory.listMemories().some((m) => m.content === "MCP 桥接写入的记忆"));
mcp.kill();

// 9. CLI 直连写回（应用未运行 → 走 fallback）
const cli = Bun.spawn(["bun", "run", omiEntry, "memory", "add", "CLI 写回的记忆", "--category", "experience"], {
  stdin: "ignore", stdout: "pipe", stderr: "pipe",
  env: { ...process.env, OMNI_DATA_DIR: dataDir },
});
await cli.exited;
check("omi memory add 写入同一库", memory.listMemories().some((m) => m.content === "CLI 写回的记忆" && m.source === "agent"));

// 10. 网关 REST + MCP 端点（独立起网关；配置端口被占会自动回退，以实际 URL 为准）
const gateway = await import("../src/bun/gateway");
const started = await gateway.startGateway();
check("网关启动", started.ok === true, started.error);
if (started.ok) {
  const status = gateway.getGatewayStatus();
  const base = `http://${status.host}:${status.port}`;

  const post = await fetch(`${base}/v1/memories`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "REST 写入的记忆", category: "fact", tags: ["rest"] }),
  });
  const created = await post.json();
  check("REST POST /v1/memories", post.status === 201 && created.memory?.content === "REST 写入的记忆", JSON.stringify(created));

  const got = await fetch(`${base}/v1/memories?q=REST`).then((r) => r.json());
  check("REST GET 检索", (got.memories ?? []).some((m: any) => m.content === "REST 写入的记忆"));

  const del = await fetch(`${base}/v1/memories/${created.memory.id}`, { method: "DELETE" });
  check("REST DELETE", del.ok === true);

  const mcpInit = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } }),
  }).then((r) => r.json());
  check("网关 /mcp initialize", mcpInit.result?.serverInfo?.name === "omnistudio", JSON.stringify(mcpInit));

  const mcpTools = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
  }).then((r) => r.json());
  const mcpToolNames = (mcpTools.result?.tools ?? []).map((t: any) => t.name);
  check("/mcp 工具含 kb + memory", mcpToolNames.includes("kb_search") && mcpToolNames.includes("memory_save"), JSON.stringify(mcpToolNames));

  const mcpCall = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_save", arguments: { content: "MCP HTTP 写入的记忆" } } }),
  }).then((r) => r.json());
  check("网关 /mcp tools/call 写回", String(mcpCall.result?.content?.[0]?.text ?? "").includes("Saved memory #"), JSON.stringify(mcpCall));
  check("MCP HTTP 写入落库", memory.listMemories().some((m) => m.content === "MCP HTTP 写入的记忆"));

  // 浏览器 GET（Accept: text/html）返回调试工作台；MCP 客户端 GET 仍 405。
  const pg = await fetch(`${base}/mcp`, { headers: { accept: "text/html,application/xhtml+xml" } });
  const pgText = await pg.text();
  check("GET /mcp 浏览器返回工作台", pg.status === 200 && pgText.includes("OmniStudio MCP Playground"), `HTTP ${pg.status}`);
  const mcpGet = await fetch(`${base}/mcp`, { headers: { accept: "text/event-stream" } });
  check("GET /mcp 非浏览器仍 405", mcpGet.status === 405);

  const spec = await fetch(`${base}/openapi.json`).then((r) => r.json());
  check("OpenAPI 含记忆端点", spec.paths?.["/v1/memories"] && spec.paths?.["/mcp"]);

  await gateway.stopGateway();
}

console.log(failed === 0 ? "\nMemory smoke 全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
