/**
 * 记忆功能冒烟：临时数据目录 → 迁移 → CRUD → 判重合并 → 检索排序 → 检索质量回归
 * → 注入预算 → 生命周期 → Agent 工具 → 同步区块 → MCP 桥接 → 网关 REST/MCP。
 * 跑法：bun run scripts/memory-smoke.ts（或 OMNI_DATA_DIR=… 指定目录保留现场）
 */
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

// 每次运行用独立目录：固定目录名会让第二轮运行的计数断言读到上一轮残留数据而失败
// —— 冒烟脚本必须可重复运行。
const providedDataDir = process.env.OMNI_DATA_DIR;
const dataDir = providedDataDir ?? mkdtempSync(path.join(tmpdir(), "omni-memory-smoke-"));
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
check("列表 2 条", memory.listMemories().length === 2);
memory.setMemoryPinned(m2.id, true);
check("置顶排序在最前", memory.listMemories()[0]?.id === m2.id);
check("置顶抬高重要度", memory.listMemories()[0]!.importance >= 0.85);
const edited = memory.saveMemory({ id: m1.id, content: "用户偏好简洁的中文回复（更新）", category: "preference", tags: ["偏好"] });
check("编辑保留 id", edited.id === m1.id && edited.content.includes("更新"));

// 2. 检索：排序 + 热度 + 分类过滤
const hits = await memory.searchMemories("部署");
check("按内容检索命中", hits.length === 1 && hits[0]?.id === m2.id);
check("检索结果带分数拆解", hits[0]!.score > 0 && hits[0]!.relevance > 0 && hits[0]!.matched === "keyword");
// 命中计数延迟批量落库（合并 2 秒窗口），验证前先手动 flush。
memory.flushAccessCounts();
check("检索累计使用次数", memory.listMemories().find((m) => m.id === m2.id)!.usageCount === 1);
const tagHits = await memory.searchMemories("偏好");
check("按标签检索命中", tagHits.some((m) => m.id === m1.id));
check("分类过滤生效", (await memory.searchMemories("偏好", { category: "fact" })).length === 0);

// 3. 检索质量回归：等价改写 / 标签主题 / 干扰项排序
const corpus: { content: string; tag: string }[] = [
  { content: "项目用 bun workspace 管理依赖，不要引入 pnpm", tag: "构建" },
  { content: "生产环境部署在东京机房，走 SSH 隧道", tag: "运维" },
  { content: "回答时保持简洁，不要客套话", tag: "沟通" },
  { content: "用户在做本地大模型桌面应用 OmniStudio", tag: "项目" },
  { content: "周五下午不要安排发布", tag: "流程" },
];
for (const item of corpus) await memory.saveAgentMemory({ content: item.content, tags: [item.tag] });
const qualityCases: { query: string; expect: string }[] = [
  { query: "构建工具", expect: "bun workspace" },
  { query: "部署", expect: "东京机房" },
  { query: "回复风格", expect: "简洁" },
  { query: "OmniStudio", expect: "OmniStudio" },
  { query: "发布窗口", expect: "周五" },
];
let qualityHits = 0;
for (const c of qualityCases) {
  const ranked = await memory.searchMemories(c.query, { limit: 3 });
  if (ranked.slice(0, 2).some((h) => h.content.includes(c.expect))) qualityHits++;
  else console.log(`    · 召回未命中：${c.query} → ${ranked.map((h) => h.content).join(" | ")}`);
}
check(`检索质量：前 2 命中 ${qualityHits}/${qualityCases.length}`, qualityHits === qualityCases.length, `${qualityHits}/${qualityCases.length}`);

// 4. 判重合并 / 取代 / 敏感内容拦截
await memory.saveAgentMemory({ content: "项目用 bun workspace 管理依赖，不要引入 pnpm" });
check("完全重复合并不新增", memory.listMemories({ status: "all" }).filter((m) => m.content.includes("bun workspace")).length === 1);
const merged = await memory.saveAgentMemory({ content: "项目用 bun workspace 管理依赖，不要引入 pnpm，也不要 yarn" });
check("近似改写合并取更完整正文", merged.ok && merged.result.action === "merged" && merged.result.memory.content.includes("yarn"));
const oldFact = await memory.saveAgentMemory({ content: "生产环境部署在香港机房" });
const replaced = await memory.saveAgentMemory({
  content: "生产环境部署在东京机房，走 SSH 隧道（2026 年 9 月迁移完成）",
  supersedes: oldFact.ok ? [oldFact.result.memory.id] : [],
});
check("supersedes 取代旧记忆", replaced.ok && (replaced.result.superseded?.length ?? 0) === 1);
check("被取代的记忆退出默认列表", !memory.listMemories().some((m) => m.content.includes("香港机房")));
check("被取代的记忆仍可追溯", memory.listMemories({ status: "superseded" }).some((m) => m.content.includes("香港机房")));
const blocked = await memory.saveAgentMemory({ content: "生产 key: sk-abcdefghijklmnopqrstuvwxyz" });
check("拦截疑似密钥", !blocked.ok && memory.memoryStats().blocked === 1, JSON.stringify(blocked));

// 5. 注入：核心块预算 + 按需召回
const section = memory.memoryPromptSection();
check("提示注入包含置顶记忆", Boolean(section && section.includes("部署走 bun") && section.includes("置顶")), section ?? "(null)");
const sectionLines = (section ?? "").split("\n").filter((l) => l.startsWith("- "));
check("核心块受条数预算约束", sectionLines.length <= 8, `${sectionLines.length} 行`);
const recall = await memory.memoryRecallSection("OmniStudio 是什么项目");
check("按需召回命中相关记忆", Boolean(recall && recall.includes("OmniStudio")), recall ?? "(null)");

// 6. 开关
updateSettings({ MEMORY_ENABLED: "0" });
check("关闭后不再注入", memory.memoryPromptSection() === null);
check("关闭后工具集不受影响（由 agent.ts 按 memoryEnabled 过滤）", memory.buildMemoryAgentTools().length === 3);
updateSettings({ MEMORY_ENABLED: "1" });
check("重新开启恢复注入", memory.memoryPromptSection() !== null);

// 7. 删除 + 审计
const beforeDelete = memory.listMemories({ status: "all" }).length;
memory.deleteMemory(m1.id);
check("删除减少一条", memory.listMemories({ status: "all" }).length === beforeDelete - 1);
check("删除留审计流水", memory.listMemoryEvents(20).some((e) => e.action === "forgotten" && e.memoryId === m1.id));

// 8. Agent 工具（所有模型共享同一组工具）
const tools = memory.buildMemoryAgentTools({ scope: "/tmp/smoke-workspace", sourceRef: "agent:conv-smoke" });
const search = tools.find((t) => t.name === "memory_search");
const save = tools.find((t) => t.name === "memory_save");
const forget = tools.find((t) => t.name === "memory_forget");
check("提供 memory_search / memory_save / memory_forget", Boolean(search && save && forget));
if (search && save && forget) {
  const res = await search.execute("c1", { query: "部署" });
  const text = (res.content as { type: string; text: string }[])[0]?.text ?? "";
  check("memory_search 返回记忆", text.includes("部署走 bun"), text);
  await save.execute("c2", { content: "这个工作区用 bun test 跑单测", category: "fact", tags: ["测试"] });
  const savedRow = memory.listMemories({ status: "all" }).find((m) => m.content.includes("bun test"))!;
  check("memory_save 落库（source=agent）", savedRow.source === "agent");
  check("Agent 写入带项目作用域与来源", savedRow.scope === "/tmp/smoke-workspace" && savedRow.sourceRef === "agent:conv-smoke");
  await forget.execute("c3", { id: savedRow.id, reason: "冒烟清理" });
  check("memory_forget 删除", !memory.listMemories({ status: "all" }).some((m) => m.id === savedRow.id));
}

// 9. 项目作用域：同项目检索优先
await memory.saveAgentMemory({ content: "启动命令用 bun run dev --watch", scope: "/tmp/smoke-workspace" });
await memory.saveAgentMemory({ content: "启动命令用 docker compose up", scope: "/tmp/other-workspace" });
const scoped = await memory.searchMemories("启动命令", { scope: "/tmp/smoke-workspace" });
check("同项目记忆优先召回", scoped[0]?.content.includes("bun run dev") === true, scoped.map((h) => h.content).join(" | "));
check("其他项目记忆不默认参与检索", scoped.every((h) => !h.content.includes("docker compose")));

// 10. 生命周期维护：补哈希 / 归档过期
const expiredId = memory.saveMemory({ content: "限时：本次冒烟用完即弃", validUntil: Date.now() - 1000 }).id;
const maintenance = await memory.runMemoryMaintenance();
check("维护归档过期记忆", maintenance.expired >= 1 && memory.listMemories({ status: "archived" }).some((m) => m.id === expiredId));
check("归档记忆默认不注入", !(memory.memoryPromptSection() ?? "").includes("用完即弃"));

// 11. 导出 / 导入（幂等）
const dump = memory.exportMemories();
check("导出包含全部记忆", dump.memories.length === memory.listMemories({ status: "all" }).length);
const reimport = await memory.importMemories(dump);
check("重复导入全部合并、不新增", reimport.imported === 0 && reimport.merged === dump.memories.length, JSON.stringify(reimport));

// 12. 统计
const stats = memory.memoryStats();
check(
  "统计覆盖条数与检索指标",
  stats.total > 0 && stats.searches > 0 && stats.hitSearches > 0 && stats.merges > 0 && stats.blocked === 1,
  JSON.stringify({ total: stats.total, searches: stats.searches, merges: stats.merges, blocked: stats.blocked }),
);

// 13. 同步到外部 Agent（baseDir 指到临时 home，不碰真实文件）
const { mkdirSync: mk, writeFileSync: wf, readFileSync: rf } = await import("fs");
const syncMod = await import("../src/bun/memory-sync");
const tmpHome = path.join(dataDir, "fake-home");
mk(path.join(tmpHome, ".claude"), { recursive: true });
wf(path.join(tmpHome, ".claude", "CLAUDE.md"), "# 我的私有笔记\n\n别动我。\n");
const syncRes = syncMod.syncMemoryToTools(["claude"], tmpHome);
check("同步返回成功", syncRes[0]?.ok === true, JSON.stringify(syncRes));
const md = rf(path.join(tmpHome, ".claude", "CLAUDE.md"), "utf8");
check("区块写入且保留用户内容", md.includes("别动我。") && md.includes("部署走 bun") && md.includes("omni-memory:start"));
check("区块含写回指引", md.includes("omi memory add") && md.includes("memory_save") && md.includes("memory_forget"));
check("区块不包含被取代 / 归档的记忆", !md.includes("香港机房") && !md.includes("用完即弃"));
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

// 14. MCP 桥接端到端：子进程跑 omi memory mcp，JSON-RPC 握手 → 枚举 → 写回
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
send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "memory_list", arguments: { limit: 5 } } });
const byId = (id: number) => replies.find((m) => m.id === id);
// 等子进程把 5 条请求都答完（固定 sleep 在慢机器上会偶发失败）。
for (let i = 0; i < 80 && !byId(5); i++) await new Promise((r) => setTimeout(r, 100));
check("MCP initialize 握手", byId(1)?.result?.serverInfo?.name === "omni-memory", JSON.stringify(byId(1)));
const toolNames = (byId(2)?.result?.tools ?? []).map((t: any) => t.name);
check(
  "MCP 工具枚举（search / save / forget / list）",
  ["memory_search", "memory_save", "memory_forget", "memory_list"].every((n) => toolNames.includes(n)),
  JSON.stringify(toolNames),
);
check("MCP memory_save 写回", String(byId(3)?.result?.content?.[0]?.text ?? "").includes("Saved memory #"), JSON.stringify(byId(3)));
check("MCP memory_search 检索", String(byId(4)?.result?.content?.[0]?.text ?? "").includes("MCP 桥接写入的记忆"));
check("MCP memory_list 带编号", String(byId(5)?.result?.content?.[0]?.text ?? "").includes("#"));
check("桥接写入落到同一库", memory.listMemories({ status: "all" }).some((m) => m.content === "MCP 桥接写入的记忆"));
mcp.kill();

// 15. CLI 直连写回（应用未运行 → 走 fallback）+ 统计 / 导出 / 删除
const runCli = async (...args: string[]) => {
  const proc = Bun.spawn(["bun", "run", omiEntry, "memory", ...args], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, OMNI_DATA_DIR: dataDir },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
};

const cliAdd = await runCli("add", "CLI 写回的记忆", "--category", "experience");
check("omi memory add 写入同一库", memory.listMemories({ status: "all" }).some((m) => m.content === "CLI 写回的记忆"));
check("omi memory add 输出可读", cliAdd.stdout.includes("已保存记忆"), cliAdd.stdout + cliAdd.stderr);
const cliDup = await runCli("add", "CLI 写回的记忆");
check("omi memory add 重复内容提示合并", cliDup.stdout.includes("已合并"), cliDup.stdout);
const cliStats = await runCli("stats");
check("omi memory stats 输出检索指标与向量状态", cliStats.stdout.includes("次命中") && cliStats.stdout.includes("向量："), cliStats.stdout);
const exportFile = path.join(dataDir, "memories-export.json");
const cliExport = await runCli("export", "--out", exportFile);
check("omi memory export 落盘", cliExport.exitCode === 0 && rf(exportFile, "utf8").includes("CLI 写回的记忆"));
const cliImport = await runCli("import", exportFile);
check("omi memory import 幂等合并", cliImport.stdout.includes("合并"), cliImport.stdout);
const cliSearch = await runCli("search", "桥接");
check("omi memory search 排序检索", cliSearch.stdout.includes("MCP 桥接写入的记忆"), cliSearch.stdout);
const cliForget = await runCli("forget", String(memory.listMemories({ status: "all" }).find((m) => m.content === "CLI 写回的记忆")!.id));
check("omi memory forget 删除", cliForget.stdout.includes("已删除记忆"));

// 16. 网关 REST + MCP 端点（独立起网关；配置端口被占会自动回退，以实际 URL 为准）
const gateway = await import("../src/bun/gateway");
const started = await gateway.startGateway();
check("网关启动", started.ok === true, started.error);
if (started.ok) {
  const status = await gateway.getGatewayStatus();
  const base = `http://${status.host}:${status.port}`;

  const post = await fetch(`${base}/v1/memories`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "REST 写入的记忆", category: "fact", tags: ["rest"] }),
  });
  const created = await post.json();
  check("REST POST /v1/memories", post.status === 201 && created.memory?.content === "REST 写入的记忆", JSON.stringify(created));

  const dupPost = await fetch(`${base}/v1/memories`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "REST 写入的记忆" }),
  });
  const dupBody = await dupPost.json();
  check("REST 重复写入合并", dupBody.action === "merged", JSON.stringify(dupBody));

  const rejected = await fetch(`${base}/v1/memories`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "key: sk-abcdefghijklmnopqrstuvwxyz" }),
  });
  check("REST 拒绝敏感内容", rejected.status === 400);

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
  check("MCP HTTP 写入落库", memory.listMemories({ status: "all" }).some((m) => m.content === "MCP HTTP 写入的记忆"));

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

// 只清理自己建的临时目录；调用方显式指定 OMNI_DATA_DIR 时保留现场。
if (!providedDataDir) {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {}
}

console.log(failed === 0 ? "\nMemory smoke 全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
