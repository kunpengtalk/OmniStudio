/**
 * 接入层冒烟：目录导入 + Agent 工具注册 + MCP 端到端（网关 /mcp）。
 * 跑法：bun scripts/kb-access-smoke.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

process.env.OMNI_DATA_DIR = mkdtempSync(path.join(tmpdir(), "kb-access-smoke-"));
process.env.NODE_ENV = "production";

// MCP 端到端要起网关：挑一个独立测试端口，避免与真机网关冲突。
process.env.BEFORE_GW = "1";

let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const GW_PORT = 18990;

try {
  const K = await import("../src/bun/knowledge");
  const { updateSettings } = await import("../src/bun/db/settings");

  // ---- 1. 目录导入 ----
  console.log("[1] addFolderDocs");
  {
    const kb = K.createKb({ name: "目录导入库" });
    const root = path.join(process.env.OMNI_DATA_DIR!, "docs-tree");
    mkdirSync(path.join(root, "sub"), { recursive: true });
    mkdirSync(path.join(root, ".git"), { recursive: true });
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    writeFileSync(path.join(root, "a.md"), "# A\n\n目录导入的根文件。");
    writeFileSync(path.join(root, "sub", "b.txt"), "子目录的文本文件，包含独特关键词凤梨酥。");
    writeFileSync(path.join(root, "sub", "c.bin"), "binary-ish");
    writeFileSync(path.join(root, ".git", "d.md"), "# 隐藏目录文件");
    writeFileSync(path.join(root, "node_modules", "e.md"), "# 应被跳过");

    const res = K.addFolderDocs(kb.id, root);
    check("仅导入白名单文件", res.docs.length === 2, `docs=${res.docs.map((d) => d.name).join(",")}`);
    check("跳过计数正确", res.skipped === 1, `skipped=${res.skipped}`);

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const docs = K.listDocs(kb.id);
      if (docs.length === 2 && docs.every((d) => d.status === "ready")) break;
      await Bun.sleep(200);
    }
    const docs = K.listDocs(kb.id);
    check("全部摄取就绪", docs.every((d) => d.status === "ready"), JSON.stringify(docs.map((d) => [d.name, d.status, d.error])));

    const hit = await K.recall([kb.id], "凤梨酥是什么");
    check("子目录文件可检索", hit.hits.length > 0 && hit.hits[0]!.docName === "b.txt", hit.hits[0]?.docName);
  }

  // ---- 2. Agent 工具注册 ----
  console.log("[2] agent tools");
  {
    const Agent = await import("../src/bun/agent");
    const tools = await Agent.listAgentTools("agent");
    const names = tools.map((t) => t.name);
    check("knowledge_search 已注册", names.includes("knowledge_search"), names.join(","));
    const planTools = await Agent.listAgentTools("plan");
    check("Plan 模式也可用", planTools.some((t) => t.name === "knowledge_search"));
  }

  // ---- 3. MCP 端到端 ----
  console.log("[3] MCP over gateway");
  updateSettings({
    GATEWAY_ENABLED: "1",
    GATEWAY_HOST: "127.0.0.1",
    GATEWAY_PORT: String(GW_PORT),
    GATEWAY_API_KEY: "smoke-key",
  });
  const Gateway = await import("../src/bun/gateway");
  const started = await Gateway.startGateway();
  check("网关启动", started.ok, started.error);

  const base = `http://127.0.0.1:${started.port ?? GW_PORT}`;
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: "Bearer smoke-key",
  };
  const post = async (body: unknown) => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  };

  const noAuth = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  check("未带密钥被拒绝", noAuth.status === 401, `status=${noAuth.status}`);

  const init = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
  });
  check("initialize 返回工具能力", init.json?.result?.capabilities?.tools != null, JSON.stringify(init.json));

  const notif = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  check("通知无响应体", notif.status === 202, `status=${notif.status}`);

  const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const toolNames = (list.json?.result?.tools ?? []).map((t: { name: string }) => t.name);
  check("暴露 kb_search / kb_list", toolNames.includes("kb_search") && toolNames.includes("kb_list"), toolNames.join(","));

  const search = await post({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "kb_search", arguments: { query: "凤梨酥" } },
  });
  const text = search.json?.result?.content?.[0]?.text ?? "";
  check("kb_search 返回命中", text.includes("b.txt"), text.slice(0, 120));

  const kbList = await post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "kb_list", arguments: {} } });
  check("kb_list 列出知识库", (kbList.json?.result?.content?.[0]?.text ?? "").includes("目录导入库"));

  const badTool = await post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope", arguments: {} } });
  check("未知工具报错", badTool.json?.error?.code === -32602, JSON.stringify(badTool.json));

  await Gateway.stopGateway();
  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
} finally {
  try {
    rmSync(process.env.OMNI_DATA_DIR!, { recursive: true, force: true });
  } catch {}
}

process.exit(failed === 0 ? 0 : 1);
