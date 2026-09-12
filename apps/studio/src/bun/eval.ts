/**
 * 大模型能力评测引擎。四个主流套件：
 * - MMLU：英文综合知识（57 科目，四选一，同科目 5 条示例）
 * - CMMLU：中文综合知识（67 科目，四选一，同科目 5 条示例）
 * - GSM8K：小学数学应用题（思维链作答，末行 `#### 数字` 为最终答案）
 * - MMLU-Pro：高难综合（十选一，直接作答，长输出预算）
 *
 * 题库为 HuggingFace 公开数据集（cais/mmlu、haonan-li/cmmlu、openai/gsm8k、
 * TIGER-Lab/MMLU-Pro）的 JSONL 打包镜像，首次使用时下载到
 * `<userData>/eval-data/` 并做字节数校验，此后离线可用。抽样采用固定
 * 种子的类别配额制，同一套件同一题数的前后两次评测面对同一批题，
 * 结果可以直接对比。
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { getDataDir } from "./paths";

export type EvalSuiteId = "mmlu" | "cmmlu" | "gsm8k" | "mmlu_pro";

export type EvalCategoryRow = {
  category: string;
  correct: number;
  total: number;
  accuracy: number;
};

export type EvalSuiteInfo = {
  id: EvalSuiteId;
  /** 需要的题库文件（下载状态由调用方查 isFileReady）。 */
  files: { name: string; sizeBytes: number; downloaded: boolean }[];
  totalSizeBytes: number;
  /** 推荐抽样题数；0 / 空表示全量。 */
  quickSize: number;
  /** 全量题数（展示用常量）。 */
  totalQuestions: number;
};

const DATA_MIRRORS = [
  "https://cdn.jsdelivr.net/gh/jundot/omlx@main/omlx/eval/data/",
  "https://raw.githubusercontent.com/jundot/omlx/main/omlx/eval/data/",
];

// 各文件的期望字节数，下载完成后逐一核对，防止截断文件混进题库。
const SUITE_FILES: Record<EvalSuiteId, { name: string; sizeBytes: number }[]> = {
  mmlu: [
    { name: "mmlu_test.jsonl", sizeBytes: 7_510_640 },
    { name: "mmlu_dev.jsonl", sizeBytes: 136_428 },
  ],
  cmmlu: [
    { name: "cmmlu_test.jsonl", sizeBytes: 3_374_841 },
    { name: "cmmlu_dev.jsonl", sizeBytes: 10_855 },
  ],
  gsm8k: [{ name: "gsm8k_test.jsonl", sizeBytes: 748_933 }],
  mmlu_pro: [{ name: "mmlu_pro_test.jsonl", sizeBytes: 9_574_914 }],
};

export const EVAL_SUITES: Record<EvalSuiteId, {
  /** 前端「快速模式」的默认抽样题数。 */
  defaultSample: number;
  /** 单题作答的输出 token 上限（数学/高难题需要更长）。 */
  maxTokens: number;
  /** 是否按科目统计得分。 */
  bySubject: boolean;
  /** 全量题数（展示用）。 */
  totalQuestions: number;
}> = {
  mmlu: { defaultSample: 300, maxTokens: 128, bySubject: true, totalQuestions: 14_042 },
  cmmlu: { defaultSample: 300, maxTokens: 128, bySubject: true, totalQuestions: 11_528 },
  gsm8k: { defaultSample: 100, maxTokens: 512, bySubject: false, totalQuestions: 1_319 },
  mmlu_pro: { defaultSample: 300, maxTokens: 2048, bySubject: true, totalQuestions: 12_032 },
};

// ---------------------------------------------------------------------------
// 题库文件
// ---------------------------------------------------------------------------

function dataFilePath(name: string): string {
  return getDataDir("eval-data", name);
}

function isFileReady(name: string, sizeBytes: number): boolean {
  try {
    return statSync(dataFilePath(name)).size === sizeBytes;
  } catch {
    return false;
  }
}

export function listEvalSuites(): EvalSuiteInfo[] {
  return (Object.keys(SUITE_FILES) as EvalSuiteId[]).map((id) => {
    const files = SUITE_FILES[id].map((f) => ({ ...f, downloaded: isFileReady(f.name, f.sizeBytes) }));
    return {
      id,
      files,
      totalSizeBytes: files.reduce((s, f) => s + f.sizeBytes, 0),
      quickSize: EVAL_SUITES[id].defaultSample,
      totalQuestions: EVAL_SUITES[id].totalQuestions,
    };
  });
}

/** 补齐缺失的题库文件：镜像轮询，流式落盘（.tmp 原子改名），大小不符即重试下一源。 */
export async function ensureEvalData(
  suite: EvalSuiteId,
  onProgress: (received: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  mkdirSync(getDataDir("eval-data"), { recursive: true });
  for (const { name, sizeBytes } of SUITE_FILES[suite]) {
    if (isFileReady(name, sizeBytes)) continue;
    let lastError: unknown = null;
    for (const mirror of DATA_MIRRORS) {
      try {
        const res = await fetch(mirror + name, { signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const tmp = dataFilePath(`${name}.tmp`);
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.byteLength;
          onProgress(received, sizeBytes);
        }
        if (received !== sizeBytes) throw new Error(`size mismatch: ${received} != ${sizeBytes}`);
        writeFileSync(tmp, Buffer.concat(chunks));
        renameSync(tmp, dataFilePath(name));
        lastError = null;
        break;
      } catch (e) {
        if (signal?.aborted) throw e;
        lastError = e;
      }
    }
    if (lastError) {
      throw new Error(
        `下载题库 ${name} 失败：${lastError instanceof Error ? lastError.message : String(lastError)}`,
      );
    }
  }
}

function readJsonl(name: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of readFileSync(dataFilePath(name), "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed) out.push(JSON.parse(trimmed));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 可复现抽样
// ---------------------------------------------------------------------------

/** 32 位确定性伪随机（mulberry32）：种子固定则序列固定，抽样结果可复现。 */
function seededRandom(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 从数组无放回抽 n 条（部分 Fisher-Yates，保持选中项原相对顺序）。 */
function pickReproducible<T>(rng: () => number, pool: T[], n: number): T[] {
  const copy = [...pool];
  for (let i = 0; i < n && i < copy.length; i++) {
    const j = i + Math.floor(rng() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, n);
}

/**
 * 类别配额抽样：目标 n 条按各类占比分配，配额用四舍五入 + 余额回填
 * （占比大者优先补足），每类保底 1 条。类别与种子都固定，同一数据集
 * 抽出的题集恒定，不同题数之间是包含关系弱化的近似子集。
 */
function sampleByCategory<T extends Record<string, unknown>>(items: T[], n: number, key: string): T[] {
  if (n >= items.length) return items;
  const byCat = new Map<string, T[]>();
  for (const item of items) {
    const cat = String(item[key] ?? "unknown");
    const bucket = byCat.get(cat);
    if (bucket) bucket.push(item);
    else byCat.set(cat, [item]);
  }
  const cats = [...byCat.keys()].sort();
  const rng = seededRandom(42);

  // 第一轮：按占比四舍五入分配，先到先得记下差额。
  const quotas = new Map<string, number>();
  let assigned = 0;
  for (const cat of cats) {
    const share = Math.max(1, Math.round((byCat.get(cat)!.length / items.length) * n));
    const capped = Math.min(share, byCat.get(cat)!.length, n - assigned);
    quotas.set(cat, capped);
    assigned += capped;
  }
  // 第二轮：还有余额时，优先补给占比最大的类别（它舍入损失的绝对量最大）。
  let leftover = n - assigned;
  while (leftover > 0) {
    const sorted = cats
      .filter((c) => quotas.get(c)! < byCat.get(c)!.length)
      .sort((a, b) => byCat.get(b)!.length - byCat.get(a)!.length);
    if (sorted.length === 0) break;
    const cat = sorted[0]!;
    quotas.set(cat, quotas.get(cat)! + 1);
    leftover -= 1;
  }

  const picked: T[] = [];
  for (const cat of cats) {
    picked.push(...pickReproducible(rng, byCat.get(cat)!, quotas.get(cat)!));
  }
  return picked;
}

/** 无类别维度的确定性抽样（数学题等整卷混排的场景）。 */
function sampleFlat<T>(items: T[], n: number): T[] {
  if (n >= items.length) return items;
  return pickReproducible(seededRandom(42), items, n);
}

// ---------------------------------------------------------------------------
// 答案提取
// ---------------------------------------------------------------------------

/** 推理模型的思考段剥离：完整 `<think>…</think>` 块删掉；模板把开标签留在
 *  prompt 里的情形（输出只有 `…</think>答案`），取闭合标签之后的部分。 */
export function stripThinkTags(text: string): string {
  if (text.includes("<think>")) {
    return text.replace(/<think>.*?<\/think>/gs, "").trim();
  }
  const close = text.indexOf("</think>");
  if (close >= 0) {
    return text.slice(close + "</think>".length).trim();
  }
  return text.trim();
}

// 「答案」的显式表述：英文 answer (is|:) 或中文 答案(是|：|:)，后跟选项字母。
const EXPLICIT_ANSWER_RE = /[（(]?(?:answer|答案)\s*(?:is|是|：|:)?\s*[）)]?\s*([A-J])\b/gi;

/**
 * 选择题作答提取。模型不一定守规矩只回一个字母，按可靠度依次尝试：
 * 1. 显式表述（「答案是 B」/「answer is C」），多次出现取最后一次
 *    （排除思考过程中的草稿答案）；
 * 2. 全文最后出现的独立选项字母（长解释结尾点名的常见形态）；
 * 3. 回复首字符。
 */
export function extractMcAnswer(response: string, validLetters: string[]): string {
  const valid = new Set(validLetters.map((l) => l.toUpperCase()));
  const upper = response.toUpperCase();

  let explicit = "";
  for (const m of response.matchAll(EXPLICIT_ANSWER_RE)) {
    if (valid.has(m[1]!.toUpperCase())) explicit = m[1]!.toUpperCase();
  }
  if (explicit) return explicit;

  let lastStandalone = "";
  for (const m of upper.matchAll(/\b([A-Z])\b/g)) {
    if (valid.has(m[1]!)) lastStandalone = m[1]!;
  }
  if (lastStandalone) return lastStandalone;

  const first = response.trim().slice(0, 1).toUpperCase();
  return valid.has(first) ? first : "";
}

/** 带千分位逗号与小数的有符号整数/小数（两端的 \\d 锚定避免把孤立逗号当数字）。 */
const NUMBER_RE = /-?\d(?:[\d,]*\d)?(?:\.\d+)?/g;
const TAGGED_NUMBER_RE = /####\s*(-?\d(?:[\d,]*\d)?(?:\.\d+)?)/;

/**
 * 数学题答案提取：优先取 `####` 标记后的数字（作答约定），没有标记则取
 * 全文最后一个数字（推理结尾即结论的常见形态）。
 */
export function extractNumericAnswer(text: string): string {
  const tagged = TAGGED_NUMBER_RE.exec(text);
  if (tagged) return tagged[1]!.replace(/,/g, "");
  const all = text.match(NUMBER_RE);
  return all && all.length > 0 ? all[all.length - 1]!.replace(/,/g, "") : "";
}

/** 数字归一：去千分位、整数化（"6.0" 与 "6" 视为同一个答案）。 */
export function normalizeNumber(s: string): string {
  const cleaned = s.replace(/,/g, "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? String(n) : cleaned;
}

// ---------------------------------------------------------------------------
// 套件题面
// ---------------------------------------------------------------------------

type EvalItem = {
  question: string;
  choices: string[];
  labels: string[];
  answer: string;
  subject: string;
};

const ABCD = ["A", "B", "C", "D"] as const;

/** 兼容数据导出把数组序列化成字符串的脏行。 */
function choicesOf(field: unknown): string[] {
  if (Array.isArray(field)) return field.map(String);
  if (typeof field === "string") {
    try {
      const parsed = JSON.parse(field.replace(/'/g, '"'));
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // 维持原样走空数组
    }
  }
  return [];
}

function mcBlock(question: string, choices: string[], labels: readonly string[]): string {
  const lines = [question];
  choices.forEach((c, i) => lines.push(`${labels[i]}. ${c}`));
  return lines.join("\n");
}

type RawItem = Record<string, unknown>;

/** 四选一套件（mmlu / cmmlu）共用：answer 字段可能是序号（mmlu）或字母（cmmlu）。 */
function toMcItem(raw: RawItem, indexAsAnswer: boolean): EvalItem {
  const answer = indexAsAnswer
    ? ABCD[Number(raw.answer ?? 0)] ?? String(raw.answer)
    : String(raw.answer ?? "A");
  return {
    question: String(raw.question ?? ""),
    choices: choicesOf(raw.choices),
    labels: [...ABCD],
    answer,
    subject: String(raw.subject ?? "unknown"),
  };
}

/** 每个科目积累至多 5 条作答示例（取 dev 集里该科目最先出现的几条）。 */
function collectSubjectExamples(dev: RawItem[], indexAsAnswer: boolean): Map<string, EvalItem[]> {
  const bySubject = new Map<string, EvalItem[]>();
  for (const raw of dev) {
    const subject = String(raw.subject ?? "unknown");
    const list = bySubject.get(subject);
    if (list && list.length >= 5) continue;
    const item = toMcItem(raw, indexAsAnswer);
    if (list) list.push(item);
    else bySubject.set(subject, [item]);
  }
  return bySubject;
}

function prettySubject(subject: string): string {
  return subject.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// GSM8K 的作答示例：官方题集里的代表性题目，示范「分步推理 + #### 结论」格式。
const GSM8K_EXAMPLES: { q: string; a: string }[] = [
  {
    q: "There are 15 trees in the grove. Grove workers will plant trees in the grove today. After they are done, there will be 21 trees. How many trees did the grove workers plant today?",
    a: "The grove starts with 15 trees and ends with 21, so 21 - 15 = 6 trees were planted. #### 6",
  },
  {
    q: "If there are 3 cars in the parking lot and 2 more cars arrive, how many cars are in the parking lot?",
    a: "3 cars at first, then 2 arrive: 3 + 2 = 5 cars. #### 5",
  },
  {
    q: "Leah had 32 chocolates and her sister had 42. If they ate 35, how many pieces do they have left in total?",
    a: "Together they had 32 + 42 = 74 pieces. After eating 35, 74 - 35 = 39 remain. #### 39",
  },
  {
    q: "Jason had 20 lollipops. He gave Denny some lollipops. Now Jason has 12 lollipops. How many lollipops did Jason give to Denny?",
    a: "Jason went from 20 down to 12, so he gave away 20 - 12 = 8 lollipops. #### 8",
  },
  {
    q: "Shawn has five toys. For Christmas, he got two toys each from his mom and dad. How many toys does he have now?",
    a: "He received 2 + 2 = 4 more toys, on top of the 5 he had: 5 + 4 = 9. #### 9",
  },
];

/** 加载套件题目（含各科目示例表）。调用前须 ensureEvalData。 */
export function loadEvalSuite(suite: EvalSuiteId, sampleSize: number): {
  items: EvalItem[];
  fewShot: Map<string, EvalItem[]>;
  datasetTotal: number;
} {
  switch (suite) {
    case "mmlu":
    case "cmmlu": {
      const prefix = suite === "mmlu" ? "mmlu" : "cmmlu";
      const indexAsAnswer = suite === "mmlu";
      const all = readJsonl(`${prefix}_test.jsonl`).map((raw) => toMcItem(raw, indexAsAnswer));
      const fewShot = collectSubjectExamples(readJsonl(`${prefix}_dev.jsonl`), indexAsAnswer);
      return {
        items: sampleSize > 0 ? sampleByCategory(all, sampleSize, "subject") : all,
        fewShot,
        datasetTotal: all.length,
      };
    }
    case "gsm8k": {
      const all: EvalItem[] = readJsonl("gsm8k_test.jsonl").map((raw) => ({
        question: String(raw.question ?? ""),
        choices: [],
        labels: [],
        answer: extractNumericAnswer(String(raw.answer ?? "")),
        subject: "math",
      }));
      return {
        items: sampleSize > 0 ? sampleFlat(all, sampleSize) : all,
        fewShot: new Map(),
        datasetTotal: all.length,
      };
    }
    case "mmlu_pro": {
      const all: EvalItem[] = readJsonl("mmlu_pro_test.jsonl")
        .filter((raw) => Array.isArray(raw.choices) && Array.isArray(raw.labels) && (raw.choices as unknown[]).length > 0)
        .map((raw) => ({
          question: String(raw.question ?? ""),
          choices: (raw.choices as unknown[]).map(String),
          labels: (raw.labels as unknown[]).map(String),
          answer: String(raw.answer ?? ""),
          subject: String(raw.subject ?? "general"),
        }));
      return {
        items: sampleSize > 0 ? sampleByCategory(all, sampleSize, "subject") : all,
        fewShot: new Map(),
        datasetTotal: all.length,
      };
    }
  }
}

/** 单题题面（一条 user 消息）。指令要求直接给选项字母 / #### 数字，判分才稳。 */
export function formatEvalPrompt(suite: EvalSuiteId, item: EvalItem, fewShot: Map<string, EvalItem[]>): string {
  if (suite === "mmlu") {
    const blocks: string[] = [
      `Multiple-choice questions about ${prettySubject(item.subject)} follow. Reply with the option letter only (A, B, C or D).\n`,
    ];
    for (const ex of fewShot.get(item.subject) ?? []) {
      blocks.push(mcBlock(ex.question, ex.choices, ABCD), `Answer: ${ex.answer}\n`);
    }
    blocks.push(mcBlock(item.question, item.choices, ABCD), "Answer:");
    return blocks.join("\n");
  }
  if (suite === "cmmlu") {
    const blocks: string[] = [
      `下面是关于${prettySubject(item.subject)}的单项选择题，直接给出选项字母（A/B/C/D）即可。\n`,
    ];
    for (const ex of fewShot.get(item.subject) ?? []) {
      blocks.push(mcBlock(ex.question, ex.choices, ABCD), `答案：${ex.answer}\n`);
    }
    blocks.push(mcBlock(item.question, item.choices, ABCD), "答案：");
    return blocks.join("\n");
  }
  if (suite === "gsm8k") {
    const blocks: string[] = [
      "Work through each math problem step by step, then finish with #### and the final numeric answer.\n",
    ];
    for (const ex of GSM8K_EXAMPLES) {
      blocks.push(`Question: ${ex.q}`, `Answer: ${ex.a}\n`);
    }
    blocks.push(`Question: ${item.question}`, "Answer:");
    return blocks.join("\n");
  }
  // mmlu_pro：十选一直接作答，选项字母沿用题库 labels。
  const blocks = ["Answer the question below with the option letter only.\n", `Question: ${item.question}\n`];
  item.choices.forEach((choice, i) => blocks.push(`${item.labels[i]}. ${choice}`));
  blocks.push("\nAnswer:");
  return blocks.join("\n");
}

/** 从模型回复里提取该套件的预测答案。 */
export function extractEvalAnswer(suite: EvalSuiteId, response: string, item: EvalItem): string {
  if (suite === "gsm8k") return extractNumericAnswer(response);
  const valid = suite === "mmlu_pro" && item.labels.length > 0 ? item.labels : [...ABCD];
  return extractMcAnswer(response, valid);
}

export function checkEvalAnswer(suite: EvalSuiteId, predicted: string, item: EvalItem): boolean {
  if (!predicted) return false;
  if (suite === "gsm8k") return normalizeNumber(predicted) === normalizeNumber(item.answer);
  return predicted === item.answer;
}

// ---------------------------------------------------------------------------
// 并发跑题
// ---------------------------------------------------------------------------

export type EvalRunOutcome = {
  accuracy: number;
  correctCount: number;
  totalQuestions: number;
  datasetTotal: number;
  failures: number;
  categories: EvalCategoryRow[];
};

export async function runEvalQuestions(opts: {
  /** 由调用方注入的问答函数（复用 benchmark 的 chatFetch 云参数兼容）。 */
  ask: (prompt: string, maxTokens: number) => Promise<string | null>;
  suite: EvalSuiteId;
  items: EvalItem[];
  fewShot: Map<string, EvalItem[]>;
  datasetTotal: number;
  concurrency: number;
  cancel: AbortSignal;
  onProgress: (done: number, total: number, correct: number) => void;
}): Promise<EvalRunOutcome> {
  const { suite, items, fewShot, cancel } = opts;
  const maxTokens = EVAL_SUITES[suite].maxTokens;
  const bySubject = EVAL_SUITES[suite].bySubject;
  let done = 0;
  let correct = 0;
  let failures = 0;
  const perSubject = new Map<string, { correct: number; total: number }>();
  const pending = [...items.entries()];

  const scoreOne = async (entry: [number, EvalItem]) => {
    const item = entry[1];
    const bucket = bySubject ? (perSubject.get(item.subject) ?? { correct: 0, total: 0 }) : null;
    if (bucket) {
      bucket.total += 1;
      perSubject.set(item.subject, bucket);
    }
    try {
      const reply = await opts.ask(formatEvalPrompt(suite, item, fewShot), maxTokens);
      if (reply === null) {
        failures += 1;
      } else if (checkEvalAnswer(suite, extractEvalAnswer(suite, reply, item), item)) {
        correct += 1;
        if (bucket) bucket.correct += 1;
      }
    } catch {
      if (cancel.aborted) return;
      failures += 1;
    }
    done += 1;
    opts.onProgress(done, items.length, correct);
  };

  const worker = async () => {
    while (true) {
      const entry = pending.shift();
      if (!entry || cancel.aborted) return;
      await scoreOne(entry);
    }
  };
  await Promise.all(Array.from({ length: Math.max(opts.concurrency, 1) }, worker));

  const categories = [...perSubject.entries()]
    .map(([category, s]) => ({
      category,
      correct: s.correct,
      total: s.total,
      accuracy: s.total > 0 ? Number(((s.correct / s.total) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.accuracy - a.accuracy || a.category.localeCompare(b.category));

  return {
    accuracy: done > 0 ? Number(((correct / done) * 100).toFixed(1)) : 0,
    correctCount: correct,
    totalQuestions: done,
    datasetTotal: opts.datasetTotal,
    failures,
    categories,
  };
}

/** 供 smoke / 调试直接检查题库文件是否就绪。 */
export function evalDataReady(suite: EvalSuiteId): boolean {
  return SUITE_FILES[suite].every((f) => isFileReady(f.name, f.sizeBytes));
}

/** 供 smoke 往测试数据目录写伪造题库（按期望大小补空行，绕过下载）。 */
export function writeEvalDataFileForTest(name: string, content: string): void {
  mkdirSync(getDataDir("eval-data"), { recursive: true });
  const expected = evalDataFileSizeExpectation(name);
  let out = content;
  if (expected > 0 && Buffer.byteLength(out) < expected) {
    out += "\n".repeat(expected - Buffer.byteLength(out));
  }
  writeFileSync(dataFilePath(name), out);
}

export function evalDataFileSizeExpectation(name: string): number {
  for (const files of Object.values(SUITE_FILES)) {
    const hit = files.find((f) => f.name === name);
    if (hit) return hit.sizeBytes;
  }
  return -1;
}
