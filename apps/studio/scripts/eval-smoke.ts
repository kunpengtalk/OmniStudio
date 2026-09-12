/**
 * 能力评测（MMLU/GSM8K 协议）smoke：伪造小题库 + fake 问答服务器，
 * 走 startBenchmark(mode=eval) → 轮询 → 落库 → getEvalSuites 全流程，
 * 外加答案提取函数的单元断言。不依赖网络。
 * 跑法：cd apps/studio && bun scripts/eval-smoke.ts
 *
 * 注意：OMNI_DATA_DIR 必须先于项目模块的动态 import 设置。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "omni-eval-smoke-"));
process.env.OMNI_DATA_DIR = dataDir;
process.env.OMNI_DB_PATH = join(dataDir, "sqlite.db");

let failed = false;
const check = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failed = true;
    console.error(`FAIL  ${name}`, detail ?? "");
  }
};

// fake 问答服务器：数学题回固定数字，选择题回固定字母 C，代码题回可执行的正确实现。
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as { messages?: { content?: string }[] };
    const prompt = body.messages?.[0]?.content ?? "";
    let content: string;
    if (prompt.includes("math problem")) {
      content = "Let me think... #### 18";
    } else if (prompt.includes("Complete the Python function below")) {
      content = "```python\ndef add(a, b):\n    return a + b\n```";
    } else {
      content = "The answer is C";
    }
    return Response.json({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
  },
});

try {
  const evalMod = await import("../src/bun/eval");
  const bench = await import("../src/bun/benchmark");
  const { updateSettings } = await import("../src/bun/db/settings");
  updateSettings({ SERVER_MODE: "local", INFERENCE_ENGINE: "llama.cpp", SERVER_PORT: String(server.port) });

  // ---- 1. 提取函数单元断言 ----
  check("extractNumericAnswer #### 优先", evalMod.extractNumericAnswer("step\n#### 72") === "72");
  check("extractNumericAnswer 回退最后数字", evalMod.extractNumericAnswer("a 3 b 42.") === "42");
  check("extractNumericAnswer 千分位", evalMod.extractNumericAnswer("#### 1,234") === "1234");
  check("normalizeNumber 6.0→6", evalMod.normalizeNumber("6.0") === "6");
  check("extractMcAnswer answer is", evalMod.extractMcAnswer("The answer is B", ["A", "B", "C", "D"]) === "B");
  check("extractMcAnswer 中文答案", evalMod.extractMcAnswer("答案是：A", ["A", "B", "C", "D"]) === "A");
  check("extractMcAnswer 最后字母回退", evalMod.extractMcAnswer("I think D then A", ["A", "B", "C", "D"]) === "A");
  check("extractMcAnswer 首字符", evalMod.extractMcAnswer("C. something", ["A", "B", "C", "D"]) === "C");
  check("stripThinkTags 完整块", evalMod.stripThinkTags("<think>x</think>Answer: A") === "Answer: A");
  check("stripThinkTags 仅闭合", evalMod.stripThinkTags("reasoning</think>Answer: A") === "Answer: A");

  // ---- 2. 伪造 MMLU 题库（20 题 / 3 科，C 正确 10 题）----
  const mkMc = (subject: string, idx: number, answer: number) => ({
    question: `${subject} question ${idx}?`,
    choices: ["a1", "b2", "c3", "d4"],
    answer,
    subject,
  });
  const testItems = [
    ...Array.from({ length: 8 }, (_, i) => mkMc("math", i, i % 4)), // C(index 2) 对 2 题
    ...Array.from({ length: 6 }, (_, i) => mkMc("history", i, 2)), // C 对 6 题
    ...Array.from({ length: 6 }, (_, i) => mkMc("physics", i, i % 3)), // C 对 2 题
  ];
  const devItems = Array.from({ length: 15 }, (_, i) => mkMc(["math", "history", "physics"][i % 3]!, i, 0));
  evalMod.writeEvalDataFileForTest("mmlu_test.jsonl", testItems.map((x) => JSON.stringify(x)).join("\n"));
  evalMod.writeEvalDataFileForTest("mmlu_dev.jsonl", devItems.map((x) => JSON.stringify(x)).join("\n"));

  // ---- 3. getEvalSuites 反映下载状态 ----
  const suites = evalMod.listEvalSuites();
  const mmluSuite = suites.find((s) => s.id === "mmlu");
  check("getEvalSuites mmlu 就绪", mmluSuite?.files.every((f) => f.downloaded) === true, mmluSuite);
  check("getEvalSuites gsm8k 未就绪", suites.find((s) => s.id === "gsm8k")?.files[0]?.downloaded === false);

  // ---- 4. MMLU 全链路（fake 回 C → 10/20 = 50%）----
  const started = bench.startBenchmark({ model: "fake-model", mode: "eval", suite: "mmlu", sampleSize: 0, concurrency: 4 });
  check("startBenchmark eval 返回 runId", "runId" in started, started);
  if (!("runId" in started)) throw new Error("no runId");
  let run = bench.getBenchmarkRun(started.runId);
  for (let i = 0; i < 200 && run?.status === "running"; i++) {
    await Bun.sleep(50);
    run = bench.getBenchmarkRun(started.runId);
  }
  check("eval run done", run?.status === "done", run?.status);
  check("eval kind", run?.kind === "eval", run?.kind);
  check("实时 eval 进度完整", run?.eval?.done === 20 && run?.eval?.total === 20, run?.eval);
  check("准确率 50%", run?.eval?.accuracy === 50, run?.eval?.accuracy);
  const cats = run?.evalRows ?? [];
  check("类别行 3 条", cats.length === 3, cats.map((c) => c.category));
  check("类别按得分排序", cats[0]?.category === "history" && cats[0]?.accuracy === 100, cats);
  check("math 类别 25%", cats.find((c) => c.category === "math")?.accuracy === 25, cats);
  check("summary.eval 落库字段", run?.summary?.eval?.accuracy === 50 && run?.summary?.eval?.correctCount === 10, run?.summary?.eval);

  const records = bench.listBenchmarkRecords();
  const rec = records.find((r) => r.id === run?.recordId);
  check("eval 记录落库 kind", rec?.kind === "eval", rec?.kind);
  check("eval 记录类别行回读", rec ? (rec.rows as { category: string }[]).length === 3 : false, rec?.rows);
  check("eval 记录 params", rec?.params?.suite === "mmlu", rec?.params);

  // ---- 5. GSM8K 协议（数字提取 + 判分，不走网络）----
  const gsmItems = [
    { question: "q1", answer: "calc #### 18" },
    { question: "q2", answer: "calc #### 1,234" },
  ];
  evalMod.writeEvalDataFileForTest("gsm8k_test.jsonl", gsmItems.map((x) => JSON.stringify(x)).join("\n"));
  const gsm = evalMod.loadEvalSuite("gsm8k", 0);
  check("gsm8k 金标提取", gsm.items[0]?.answer === "18" && gsm.items[1]?.answer === "1234", gsm.items.map((i) => i.answer));
  const gsmStarted = bench.startBenchmark({ model: "fake-model", mode: "eval", suite: "gsm8k", sampleSize: 2, concurrency: 2 });
  if ("runId" in gsmStarted) {
    let gRun = bench.getBenchmarkRun(gsmStarted.runId);
    for (let i = 0; i < 100 && gRun?.status === "running"; i++) {
      await Bun.sleep(50);
      gRun = bench.getBenchmarkRun(gsmStarted.runId);
    }
    check("gsm8k fake(#### 18) 得 50%", gRun?.eval?.accuracy === 50, gRun?.eval);
  } else {
    check("gsm8k start", false, gsmStarted);
  }

  // ---- 6. IFEval 校验器单元断言 ----
  check(
    "ifeval 校验集合（no_comma / 字数 / 存在词）",
    evalMod.verifyIfevalInstructions(
      ["punctuation:no_comma", "length_constraints:number_words", "keywords:existence"],
      [{}, { relation: "at least", num_words: 3 }, { keywords: ["alpha"] }],
      "alpha beta gamma delta",
    ) === true,
  );
  check(
    "ifeval no_comma 拒绝逗号",
    evalMod.verifyIfevalInstructions(["punctuation:no_comma"], [{}], "a, b") === false,
  );
  check(
    "ifeval json_format",
    evalMod.verifyIfevalInstructions(["detectable_format:json_format"], [{}], '{"k": 1}') === true,
  );
  check(
    "ifeval two_responses",
    evalMod.verifyIfevalInstructions(["combination:two_responses"], [{}], "first part\n***\nsecond part") === true,
  );

  // ---- 7. 代码沙箱判分（伪造 HumanEval 题，fake 回正确实现）----
  evalMod.writeEvalDataFileForTest(
    "humaneval.jsonl",
    [
      JSON.stringify({
        task_id: "HumanEval/999",
        prompt: "def add(a, b):\n    \"\"\"Return the sum.\"\"\"\n",
        test: "def check(candidate):\n    assert candidate(1, 2) == 3\n    assert candidate(-1, 1) == 0\n",
        entry_point: "add",
      }),
    ].join("\n"),
  );
  const heStarted = bench.startBenchmark({ model: "fake-model", mode: "eval", suite: "humaneval", sampleSize: 0, concurrency: 1 });
  if ("runId" in heStarted) {
    let heRun = bench.getBenchmarkRun(heStarted.runId);
    for (let i = 0; i < 100 && heRun?.status === "running"; i++) {
      await Bun.sleep(80);
      heRun = bench.getBenchmarkRun(heStarted.runId);
    }
    check("humaneval 沙箱执行 pass@1 = 100%", heRun?.eval?.accuracy === 100, heRun?.eval ?? heRun?.error);
  } else {
    check("humaneval start", false, heStarted);
  }

  // ---- 8. 长文多针合成与判分 ----
  const lc = evalMod.loadEvalSuite("longctx", 5);
  check("longctx 合成 5 题", lc.items.length === 5, lc.items.length);
  const sample = lc.items[0]!;
  check("longctx 题面含针问句", sample.question.includes("special magic numbers for") && sample.question.length > 10_000, {
    len: sample.question.length,
  });
  check("longctx 正确答案命中", (await evalMod.gradeEvalAnswer("longctx", `The number is ${sample.answer}.`, sample)) === true);
  check("longctx 错误答案不命中", (await evalMod.gradeEvalAnswer("longctx", "deadbeef", sample)) === false);
  const depths = new Set(lc.items.map((i) => i.subject));
  check("longctx 深度分档有效", depths.size >= 2, [...depths]);
} catch (e) {
  failed = true;
  console.error("smoke crashed:", e);
} finally {
  server.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(failed ? "\nEVAL SMOKE FAILED" : "\neval smoke passed ✅");
process.exit(failed ? 1 : 0);
