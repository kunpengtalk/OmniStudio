/**
 * 知识库全链路冒烟测试（独立进程跑，不依赖 electrobun / 窗口）：
 * 1. 切片器：标题分节 / 超长硬切 / 重叠
 * 2. 建库 → 添加笔记 + 文本文件 → 等待摄取 → 纯关键词召回
 * 3. 配置嵌入（指向假 embedding 服务）→ 补齐向量 → 混合召回
 * 4. 聊天上下文构建（system 注入 + 引用编号）
 * 5. 嵌入配置变更 → 向量清空校验
 *
 * 跑法：bun scripts/kb-smoke.ts（脚本自己拉起假 embedding 服务并回收）
 */
import { spawn } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

process.env.OMNI_DATA_DIR = mkdtempSync(path.join(tmpdir(), "kb-smoke-"));
process.env.NODE_ENV = "production";

const fakeServer = spawn("bun", ["scripts/fake-embed-server.ts"], {
  cwd: import.meta.dir + "/..",
  stdio: ["ignore", "pipe", "pipe"],
});
const waitServerOutput = new Promise<void>((resolve) => {
  fakeServer.stdout!.on("data", () => resolve());
});
await waitServerOutput;

let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await Bun.sleep(200);
  }
  return false;
}

try {
  const K = await import("../src/bun/knowledge");

  // ---- 1. 切片器 ----
  console.log("[1] splitIntoChunks");
  {
    const md = [
      "# 项目背景",
      ...Array.from({ length: 12 }, (_, i) => `这是项目背景的第${i}段介绍文字，讲述整体来龙去脉。`),
      "# 使用说明",
      ...Array.from({ length: 6 }, (_, i) => `使用说明第${i}步：安装并配置参数。`),
    ].join("\n\n");
    const chunks = K.splitIntoChunks(md, 150, 30);
    check("切出多个分块", chunks.length >= 3, `got ${chunks.length}`);
    check("标题跟内容走", chunks.some((c) => c.startsWith("#")));

    const long = Array.from({ length: 400 }, (_, i) => `token${i}`).join(" ");
    const hard = K.splitIntoChunks(long, 200, 40);
    check("超长文本硬切", hard.length >= 3, `got ${hard.length}`);
    const fence = "```python\n" + Array.from({ length: 500 }, (_, i) => `x${i}=1`).join("\n") + "\n```";
    const codeChunks = K.splitIntoChunks(fence, 200, 40);
    check("代码围栏作为长段处理", codeChunks.length >= 2);
  }

  // ---- 2. 建库 + 关键词召回 ----
  console.log("[2] create + ingest + keyword recall");
  const kb = K.createKb({ name: "冒烟测试库", description: "smoke" });
  check("建库成功", kb.id > 0 && kb.docCount === 0);

  K.addNoteDoc(
    kb.id,
    "退款政策",
    [
      "# 退款政策",
      "自购买之日起 7 天内可申请无理由退款。",
      "超过 7 天但在 30 天内，若商品存在质量问题，可凭发票申请部分退款。",
      "虚拟商品一经激活，原则上不予退款。",
    ].join("\n\n"),
  );
  const tmpFile = path.join(process.env.OMNI_DATA_DIR!, "warranty.md");
  writeFileSync(
    tmpFile,
    ["# 保修条款", "整机保修一年，配件保修 90 天。", "进水、摔落等人为损坏不在保修范围内。"].join("\n\n"),
  );
  const files = K.addFileDocs(kb.id, [tmpFile]);
  check("添加数据源", files.length === 1);

  const docsReady = await waitFor(() => {
    const docs = K.listDocs(kb.id);
    return docs.length === 2 && docs.every((d) => d.status === "ready");
  }, 15_000);
  check("摄取完成（笔记+文件）", docsReady, JSON.stringify(K.listDocs(kb.id).map((d) => [d.name, d.status, d.error])));

  const kw = await K.recall([kb.id], "退款政策是怎样的");
  check("关键词召回有结果", kw.hits.length > 0, JSON.stringify(kw));
  check("命中文档正确", kw.hits[0]?.docName === "退款政策", `got ${kw.hits[0]?.docName}`);
  check("无嵌入时方法为关键词", kw.hits.every((h) => h.method === "keyword" || h.method === "both"));

  // ---- 3. 嵌入 + 混合召回 ----
  console.log("[3] embedding + hybrid recall");
  const testConn = await K.testEmbedding({ base: "http://127.0.0.1:18777", model: "fake-embed" });
  check("嵌入连通测试", testConn.ok && testConn.dim === 32, JSON.stringify(testConn));

  const updated = K.updateKb(kb.id, { embeddingModel: "fake-embed", embeddingBase: "http://127.0.0.1:18777" });
  check("配置变更标记清空", updated.embeddingsReset === true);

  const embedRes = await K.embedMissing(kb.id);
  check("补齐向量成功", embedRes.ok && (embedRes.embedded ?? 0) > 0, JSON.stringify(embedRes));

  const kbAfter = K.listKnowledgeBases().find((k) => k.id === kb.id)!;
  check("embeddedCount=chunkCount", kbAfter.embeddedCount === kbAfter.chunkCount && kbAfter.chunkCount > 0,
    `embedded=${kbAfter.embeddedCount} chunks=${kbAfter.chunkCount}`);
  check("维度已记录", kbAfter.embeddingDim === 32);

  const hyb = await K.recall([kb.id], "买了东西想退钱怎么办理");
  check("混合召回有结果", hyb.hits.length > 0);
  check("含向量信号", hyb.hits.some((h) => h.method !== "keyword"), JSON.stringify(hyb.hits.map((h) => [h.docName, h.method])));

  // ---- 4. 聊天上下文 ----
  console.log("[4] buildChatContext");
  const ctx = await K.buildChatContext([kb.id], "保修多久");
  check("system 注入非空", !!ctx.system);
  check("引用带编号与来源", ctx.citations.length > 0 && ctx.citations[0]!.n === 1 && !!ctx.citations[0]!.docName);
  check("system 含来源标注", ctx.system!.includes("[1] 来源："));

  // ---- 5. 嵌入配置再变更 → 向量清空 ----
  console.log("[5] reset on config change");
  K.updateKb(kb.id, { embeddingModel: "fake-embed-v2" });
  const kbReset = K.listKnowledgeBases().find((k) => k.id === kb.id)!;
  check("向量已清空", kbReset.embeddedCount === 0 && kbReset.embeddingDim === null,
    `embedded=${kbReset.embeddedCount} dim=${kbReset.embeddingDim}`);
  const kwOnly = await K.recall([kb.id], "退款政策是怎样的");
  check("清空后退化关键词", kwOnly.hits.length > 0 && kwOnly.hits.every((h) => h.method === "keyword"));

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
} finally {
  fakeServer.kill();
  try {
    rmSync(process.env.OMNI_DATA_DIR!, { recursive: true, force: true });
  } catch {}
}

process.exit(failed === 0 ? 0 : 1);
