/**
 * 重排链路冒烟：配置重排模型 → 检索命中带重排标记/分数 → 重排服务不可达时降级融合排序。
 * 跑法：bun scripts/kb-rerank-smoke.ts（自起 fake-embed-server）
 */
import { spawn } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

process.env.OMNI_DATA_DIR = mkdtempSync(path.join(tmpdir(), "kb-rerank-smoke-"));
process.env.NODE_ENV = "production";

const fakeServer = spawn("bun", ["scripts/fake-embed-server.ts"], {
  cwd: import.meta.dir + "/..",
  stdio: ["ignore", "pipe", "pipe"],
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

async function waitFor(cond: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await Bun.sleep(200);
  }
  return false;
}

try {
  const K = await import("../src/bun/knowledge");

  // 数据：两个文档，关键词/向量都把"干扰文档"排前面，重排应把正确文档提到第一
  // 注意：先配好嵌入/重排服务地址再导数据（创建时留空 = 跟随当前服务商，
  // 测试机本地可能跑着不支持 embeddings 的推理服务）。
  const kb = K.createKb({ name: "重排测试库" });
  K.updateKb(kb.id, {
    embeddingModel: "fake-embed",
    embeddingBase: "http://127.0.0.1:18777",
    rerankModel: "fake-rerank",
    rerankBase: "http://127.0.0.1:18777",
  });
  K.addNoteDoc(
    kb.id,
    "干扰文档",
    [
      "退款 退款 退款 退款 退款：本页是常见问题索引，反复提到退款两个字，但没有任何具体政策内容。",
      "这里是目录页。",
    ].join("\n\n"),
  );
  K.addNoteDoc(
    kb.id,
    "退款政策",
    ["# 退款政策", "自购买之日起 7 天内可申请无理由退款，30 天内质量问题可部分退款。"].join("\n\n"),
  );

  const ready = await waitFor(() => K.listDocs(kb.id).every((d) => d.status === "ready"));
  check("摄取+嵌入完成", ready, JSON.stringify(K.listDocs(kb.id).map((d) => [d.name, d.status, d.error])));

  const testR = await K.testRerank({ base: "http://127.0.0.1:18777", model: "fake-rerank" });
  check("重排连通测试", testR.ok, JSON.stringify(testR));

  const res = await K.recall([kb.id], "退款政策具体是怎么规定的");
  check("重排后有结果", res.hits.length > 0);
  check("命中带重排标记", res.hits.every((h) => h.reranked === true), JSON.stringify(res.hits.map((h) => [h.docName, h.reranked, h.rerankScore])));
  check("分数来自重排", res.hits.every((h) => h.rerankScore != null));
  check("无降级提示", res.notes.length === 0, res.notes.join(";"));

  // 降级：把重排服务指向不存在的端口
  K.updateKb(kb.id, { rerankBase: "http://127.0.0.1:1" });
  const degraded = await K.recall([kb.id], "退款政策具体是怎么规定的");
  check("降级仍有结果", degraded.hits.length > 0);
  check("降级无重排标记", degraded.hits.every((h) => h.reranked !== true));
  check("降级带提示", degraded.notes.some((n) => n.includes("重排失败")), degraded.notes.join(";"));

  // 关闭重排：沿用融合序
  K.updateKb(kb.id, { rerankModel: "" });
  const plain = await K.recall([kb.id], "退款政策具体是怎么规定的");
  check("关闭重排正常检索", plain.hits.length > 0 && plain.hits.every((h) => h.reranked !== true));

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
} finally {
  fakeServer.kill();
  try {
    rmSync(process.env.OMNI_DATA_DIR!, { recursive: true, force: true });
  } catch {}
}

process.exit(failed === 0 ? 0 : 1);
