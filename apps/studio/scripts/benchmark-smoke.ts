/**
 * 基准测试链路 smoke：临时数据目录 + fake OpenAI 兼容服务器，
 * 走 startBenchmark → 轮询 → 落库 → list/delete/clear 全流程。
 * 跑法：cd apps/studio && bun scripts/benchmark-smoke.ts
 *
 * 注意：OMNI_DATA_DIR 必须先于项目模块的动态 import 设置
 * （静态 import 会在模块提升阶段连上真实库）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "omni-bench-smoke-"));
process.env.OMNI_DATA_DIR = dataDir;
process.env.OMNI_DB_PATH = join(dataDir, "sqlite.db");

type ChatBody = {
  stream?: boolean;
  messages?: { content?: string }[];
  max_tokens?: number;
};

// fake OpenAI 兼容服务器：流式按 max_tokens 发 delta + 末尾 usage chunk；非流式返回 usage。
const FAKE_GEN_TOKENS = 24;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
    const body = (await req.json()) as ChatBody;
    const promptTokens = Math.floor((body.messages?.[0]?.content ?? "").length / 4);
    if (!body.stream) {
      return Response.json({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: promptTokens, completion_tokens: 1 },
      });
    }
    const gen = Math.max(body.max_tokens ?? FAKE_GEN_TOKENS, 1);
    const chunks: string[] = [];
    for (let i = 0; i < gen; i++) {
      chunks.push(JSON.stringify({ choices: [{ delta: { content: "x" } }] }));
    }
    chunks.push(JSON.stringify({ choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: gen } }));
    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        for (const c of chunks) {
          controller.enqueue(enc.encode(`data: ${c}\n\n`));
          await Bun.sleep(2);
        }
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  },
});

let failed = false;
const check = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failed = true;
    console.error(`FAIL  ${name}`, detail ?? "");
  }
};

try {
  const mod = await import("../src/bun/benchmark");
  const { updateSettings } = await import("../src/bun/db/settings");

  updateSettings({ SERVER_MODE: "local", INFERENCE_ENGINE: "llama.cpp", SERVER_PORT: String(server.port) });

  // 1. 启动任务
  const started = mod.startBenchmark({
    model: "fake-model",
    genLength: 32,
    batchSize: 2,
    contexts: [512, 1024],
  });
  check("startBenchmark returns runId", "runId" in started, started);
  if (!("runId" in started)) throw new Error("no runId");
  const runId = started.runId;

  // 2. 轮询到结束
  let run = mod.getBenchmarkRun(runId);
  for (let i = 0; i < 200 && run?.status === "running"; i++) {
    await Bun.sleep(50);
    run = mod.getBenchmarkRun(runId);
  }
  check("run finishes", run?.status === "done", run?.status);
  check("two context rows", run?.rows.length === 2, run?.rows.length);
  const row = run?.rows[0];
  check("promptTokens from usage", (row?.promptTokens ?? 0) > 0, row?.promptTokens);
  check("tokens = gen*batch", row?.tokens === 64, row?.tokens);
  check("ttft > 0", (row?.ttftMs ?? 0) > 0, row?.ttftMs);
  check("tps > 0", (row?.tps ?? 0) > 0, row?.tps);
  check("aggTps ≈ 2×tps（并发聚合）", Math.abs((row?.aggTps ?? 0) - 2 * (row?.tps ?? 0)) < 2 * (row?.tps ?? 0) * 0.05, {
    aggTps: row?.aggTps,
    tps: row?.tps,
  });
  check("prefillTps > 0", (row?.prefillTps ?? 0) > 0, row?.prefillTps);
  check("summary present", !!run?.summary && run.summary.avgTps > 0, run?.summary);
  check("durationMs recorded", (run?.durationMs ?? 0) > 0, run?.durationMs);

  // 3. 落库与历史 CRUD
  const records = mod.listBenchmarkRecords();
  check("record persisted", records.length === 1, records.length);
  const rec = records[0];
  check("recordId matches", rec?.id === run?.recordId, { rec: rec?.id, run: run?.recordId });
  check("record model", rec?.model === "fake-model", rec?.model);
  check("record rows round-trip", rec?.rows?.length === 2, rec?.rows?.length);
  check("record status done", rec?.status === "done", rec?.status);

  mod.deleteBenchmarkRecord(rec!.id);
  check("delete removes record", mod.listBenchmarkRecords().length === 0);

  // 4. 取消路径：启动后立即取消，部分完成的档位仍应可用
  const cancelRun = mod.startBenchmark({ model: "fake-model", genLength: 64, batchSize: 1, contexts: [512] });
  if ("runId" in cancelRun) {
    mod.cancelBenchmark(cancelRun.runId);
    let cRun = mod.getBenchmarkRun(cancelRun.runId);
    for (let i = 0; i < 100 && cRun?.status === "running"; i++) {
      await Bun.sleep(50);
      cRun = mod.getBenchmarkRun(cancelRun.runId);
    }
    check("cancel ends run", cRun?.status === "cancelled", cRun?.status);
  } else {
    check("cancel-path start", false, cancelRun);
  }

  mod.clearBenchmarkRecords();
  check("clear empties records", mod.listBenchmarkRecords().length === 0);

  // 5. 重复启动保护
  const a = mod.startBenchmark({ model: "fake-model", contexts: [512] });
  if ("runId" in a) {
    const b = mod.startBenchmark({ model: "fake-model", contexts: [512] });
    check("second start rejected", "error" in b, b);
    mod.cancelBenchmark(a.runId);
    await Bun.sleep(300);
  }
} catch (e) {
  failed = true;
  console.error("smoke crashed:", e);
} finally {
  server.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(failed ? "\nBENCH SMOKE FAILED" : "\nbench smoke passed ✅");
process.exit(failed ? 1 : 0);
