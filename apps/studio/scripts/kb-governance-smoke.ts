/**
 * 知识库治理与可靠性冒烟（独立进程，不依赖 electrobun / 窗口）：
 * 1. 摄取队列：失败按指数退避重新排队；重启把遗留 running 作业捡回来
 * 2. 重复导入：源文件未变化则跳过，变化了就地在原文档上重建
 * 3. 增量向量化：未变化的分块复用旧向量，不重新调嵌入服务
 * 4. 检索质量开关：标题路径溯源、相邻分块合并、召回分数下限
 * 5. 治理：审计流水、整库导出、导入后可直接检索（向量随导出迁移）
 * 6. MCP 可见性开关：关掉的库不出现在 MCP 的 kb_list / kb_search
 *
 * 跑法：bun scripts/kb-governance-smoke.ts（脚本自己拉起假 embedding 服务并回收）
 */
import { spawn } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { eq } from "drizzle-orm";

process.env.OMNI_DATA_DIR = mkdtempSync(path.join(tmpdir(), "kb-gov-smoke-"));
process.env.NODE_ENV = "production";

const EMBED_BASE = "http://127.0.0.1:18778";
const fakeServer = spawn("bun", ["scripts/fake-embed-server.ts"], {
  cwd: import.meta.dir + "/..",
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, FAKE_EMBED_PORT: "18778" },
});
await new Promise<void>((resolve) => {
  fakeServer.stdout!.on("data", () => resolve());
});

let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await Bun.sleep(100);
  }
  return false;
}

/** 每节都撑到分块预算（800 默认，这里用 200）之上，一节一块。 */
function section(level: number, title: string, body: string): string {
  return `${"#".repeat(level)} ${title}\n${body}${"补充说明文字".repeat(20)}`;
}

try {
  const K = await import("../src/bun/knowledge");
  const Ingest = await import("../src/bun/kb-ingest");
  const { db } = await import("../src/bun/db");
  const { kbIngestJobs, knowledgeDocs } = await import("../src/bun/db/schema");
  const MCP = await import("../src/bun/kb-mcp");

  const kb = K.createKb({ name: "治理冒烟库" });
  K.updateKb(kb.id, { chunkSize: 200, chunkOverlap: 0 });

  // ---- 1. 队列：失败退避 + 崩溃恢复 ----
  console.log("[1] ingest queue（失败退避 / 崩溃恢复）");
  {
    const broken = db
      .insert(knowledgeDocs)
      .values({
        kbId: kb.id,
        name: "缺失文件.md",
        kind: "file",
        sourcePath: path.join(process.env.OMNI_DATA_DIR!, "does-not-exist.md"),
        status: "pending",
      })
      .returning()
      .get();
    Ingest.enqueueDoc(broken.id, { kind: "ingest" });
    const job = () => db.select().from(kbIngestJobs).where(eq(kbIngestJobs.docId, broken.id)).get();
    const retried = await waitFor(() => {
      const j = job();
      return !!j && j.state === "queued" && j.attempts >= 1 && !!j.lastError;
    }, 20_000);
    check("失败后按退避重新排队", retried, JSON.stringify(job() ?? null));
    check("退避时间排在将来", (job()?.nextRunAt ?? 0) > 0 && !!(job()?.lastError ?? "").includes("源文件不存在"));

    // 伪造「上次进程被杀」：running 作业必须在启动恢复时被捡回来
    db.update(kbIngestJobs).set({ state: "running", lockedAt: Date.now() }).where(eq(kbIngestJobs.docId, broken.id)).run();
    const recovered = Ingest.recoverIngestJobs();
    // 恢复后作业会被泵立刻重新认领，所以「回到队列或有在执行」都算被捡回来
    check(
      "遗留 running 作业被重新排队",
      recovered.requeued >= 1 && ["queued", "running"].includes(job()?.state ?? ""),
      JSON.stringify(recovered),
    );
    check("重试次数不会被恢复清零", (job()?.attempts ?? 0) >= 1);

    K.deleteDoc(broken.id);
    check("删除文档同时清掉它的作业", job() === undefined);
  }

  // ---- 2. 重复导入与就地重建 ----
  console.log("[2] re-import（未变化跳过 / 变化就地重建）");
  K.updateKb(kb.id, { embeddingModel: "fake-embed", embeddingBase: EMBED_BASE });
  const specFile = path.join(process.env.OMNI_DATA_DIR!, "spec.md");
  const v1 = [
    section(1, "退款政策", "自购买之日起 7 天内可申请无理由退款。"),
    section(2, "部分退款", "超过 7 天但在 30 天内，有质量问题的可申请部分退款。"),
    section(1, "保修条款", "整机保修一年，配件保修 90 天。"),
    section(1, "发票说明", "电子发票在订单完成后自动开具。"),
  ].join("\n\n");
  writeFileSync(specFile, v1);

  const added = K.addFileDocs(kb.id, [specFile]);
  check("首次导入建立文档", added.length === 1);
  const ready = await waitFor(() => K.listDocs(kb.id).every((d) => d.status === "ready" && d.chunkCount > 0));
  check("摄取完成", ready, JSON.stringify(K.listDocs(kb.id).map((d) => [d.name, d.status, d.error])));
  const docAfterEmbed = K.listDocs(kb.id)[0]!;
  check("全部分块已向量化", docAfterEmbed.embeddedCount === docAfterEmbed.chunkCount, JSON.stringify(docAfterEmbed));

  const reskip = K.addFileDocs(kb.id, [specFile]);
  check(
    "源文件未变化时不重复导入",
    reskip.length === 0 && K.listDocs(kb.id).length === 1,
    `added=${reskip.length} docs=${K.listDocs(kb.id).length}`,
  );

  // 改一节：内容变了但大小也变，确保 mtime/size 判定一定命中
  const v2 = v1.replace("整机保修一年，配件保修 90 天。", "整机保修两年，配件保修 180 天，以发票日期为准。");
  await fetch(`${EMBED_BASE}/stats/reset`);
  writeFileSync(specFile, v2);
  const reimported = K.addFileDocs(kb.id, [specFile]);
  check("源文件变化时就地重建（不新增文档）", reimported.length === 1 && K.listDocs(kb.id).length === 1);
  const ready2 = await waitFor(() => K.listDocs(kb.id).every((d) => d.status === "ready" && d.chunkCount > 0));
  check("重建后摄取完成", ready2, JSON.stringify(K.listDocs(kb.id).map((d) => [d.name, d.status, d.error])));

  // ---- 3. 增量向量化：只有变化的分块重新嵌入 ----
  console.log("[3] incremental embedding（未变化分块复用向量）");
  {
    const doc = K.listDocs(kb.id)[0]!;
    const stats = (await (await fetch(`${EMBED_BASE}/stats`)).json()) as { embedInputs: number };
    check("全部分块都有向量", doc.embeddedCount === doc.chunkCount, JSON.stringify(doc));
    check(
      "只重新嵌入了变化的分块",
      stats.embedInputs > 0 && stats.embedInputs < doc.chunkCount,
      `embedInputs=${stats.embedInputs} chunks=${doc.chunkCount}`,
    );
  }

  // ---- 4. 检索质量开关 ----
  console.log("[4] retrieval（溯源 / 邻块合并 / 分数下限）");
  {
    const note = K.addNoteDoc(
      kb.id,
      "长文档",
      Array.from({ length: 6 }, (_, i) =>
        section(1, `退款流程第 ${i + 1} 部分`, `退款流程第 ${i + 1} 部分的说明，含所需材料与时效。`),
      ).join("\n\n"),
    );
    await waitFor(() => K.listDocs(kb.id).find((d) => d.id === note.id)?.status === "ready");
    const chunks = K.listChunks(note.id);
    check("分块带标题路径与字符偏移", chunks.every((c) => !!c.headingPath && c.charStart != null && c.charEnd != null));

    // 先关掉合并，看原始命中粒度：多路召回都有信号，才能验证分数下限确实在筛
    K.updateKb(kb.id, { expandNeighbors: false });
    const hits = await K.recall([kb.id], "退款流程的说明", 12);
    check("召回有结果", hits.hits.length >= 3, `hits=${hits.hits.length}`);
    check("命中带标题路径", hits.hits.some((h) => !!h.headingPath), JSON.stringify(hits.hits.map((h) => h.headingPath)));
    check(
      "命中带字符偏移（引用可回位）",
      hits.hits.every((h) => typeof h.charStart === "number" && typeof h.charEnd === "number"),
    );

    const before = hits.hits.length;
    K.updateKb(kb.id, { minScore: 0.99 });
    const filtered = await K.recall([kb.id], "退款流程的说明", 12);
    check("分数下限筛掉长尾", filtered.hits.length > 0 && filtered.hits.length < before, `before=${before} after=${filtered.hits.length}`);
    K.updateKb(kb.id, { minScore: 0 });

    K.updateKb(kb.id, { expandNeighbors: true });
    const merged = await K.recall([kb.id], "退款流程的说明", 12);
    check(
      "相邻分块被合并成一条",
      merged.hits.some((h) => (h.mergedSeqs?.length ?? 0) > 1),
      JSON.stringify(merged.hits.map((h) => h.mergedSeqs)),
    );
    check("合并后命中数变少（同文档去冗）", merged.hits.length < before, `merged=${merged.hits.length} before=${before}`);
  }

  // ---- 5. 治理：审计 / 导出 / 导入 ----
  console.log("[5] governance（审计 / 导出 / 导入）");
  {
    const events = K.kbEvents({ kbId: kb.id, limit: 300 });
    const actions = new Set(events.map((e) => e.action));
    check("审计记录导入", actions.has("doc_added"), [...actions].join(","));
    check("审计记录跳过", actions.has("doc_skipped"));
    check("审计记录摄取完成", actions.has("doc_ingested"));
    check("审计记录重新处理", actions.has("doc_reingested"));
    check("审计记录配置变更", actions.has("kb_config"));
    check("审计记录检索", actions.has("recall"), [...actions].join(","));

    const exported = K.exportKb(kb.id, { includeEmbeddings: true });
    check("导出载荷版本化", exported.payload.format === "omnistudio.kb" && exported.payload.version === 1);
    const imported = K.importKb(JSON.parse(exported.json));
    check("导入文档数一致", imported.docs === K.listDocs(kb.id).length, `${imported.docs}`);
    check("导入带向量（无需重新向量化）", imported.embedded > 0, JSON.stringify(imported));
    const importedHits = await K.recall([imported.kb.id], "退款政策", 5);
    check("导入库可直接检索", importedHits.hits.length > 0, JSON.stringify(importedHits.hits.length));

    let rejected = false;
    try {
      K.importKb({ format: "something-else" });
    } catch {
      rejected = true;
    }
    check("非本应用导出文件被拒绝", rejected);

    const file = K.exportKbToFile(kb.id, { includeEmbeddings: false });
    check("导出到数据目录", file.path.includes("kb-exports") && file.bytes > 0);
  }

  // ---- 6. MCP 可见性 ----
  console.log("[6] MCP exposure（可见性开关）");
  {
    const callKbList = async () => {
      const res = await MCP.handleMcpRequest(
        new Request("http://127.0.0.1:1/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "kb_list", arguments: {} } }),
        }),
      );
      const json = (await res.json()) as { result?: { content?: { text?: string }[] } };
      return json.result?.content?.[0]?.text ?? "";
    };

    K.updateKb(kb.id, { mcpExposed: false });
    const hidden = await callKbList();
    check("关闭后 MCP 看不到该库", !hidden.includes(`id=${kb.id}`), hidden.slice(0, 160));

    K.updateKb(kb.id, { mcpExposed: true });
    const shown = await callKbList();
    check("开启后 MCP 能看到该库", shown.includes(`id=${kb.id}`), shown.slice(0, 160));
  }

  // ---- 7. 维护 ----
  console.log("[7] maintenance");
  {
    const maint = K.runKbMaintenance();
    check("维护跑通并返回统计", typeof maint.reconciled === "number" && typeof maint.pruned === "number", JSON.stringify(maint));
    const indexes = K.kbIndexStatsAll();
    check("索引诊断可读", indexes.every((i) => i.chunks > 0 && i.dimensions > 0), JSON.stringify(indexes));
  }

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
} finally {
  fakeServer.kill();
  try {
    rmSync(process.env.OMNI_DATA_DIR!, { recursive: true, force: true });
  } catch {}
}

process.exit(failed === 0 ? 0 : 1);
