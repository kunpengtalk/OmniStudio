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
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getDataDir } from "./paths";

export type EvalSuiteId =
  | "mmlu"
  | "cmmlu"
  | "gsm8k"
  | "mmlu_pro"
  | "humaneval"
  | "mbpp"
  | "ifeval"
  | "longctx";

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
  /** 套件垂类（代码 / 写作 / 长文 / …），前端据此显示附加说明。 */
  kind: "knowledge" | "math" | "code" | "writing" | "long-context";
};

/** 社区维护的 HuggingFace 数据集 JSONL 打包镜像（通用源）。 */
const DATA_MIRRORS = [
  "https://cdn.jsdelivr.net/gh/jundot/omlx@main/omlx/eval/data/",
  "https://raw.githubusercontent.com/jundot/omlx/main/omlx/eval/data/",
];
/** IFEval 官方数据文件走 HF 原站 + 国内镜像。 */
const HF_IFEVAL_MIRRORS = [
  "https://huggingface.co/datasets/google/IFEval/resolve/main/",
  "https://hf-mirror.com/datasets/google/IFEval/resolve/main/",
];

// 各文件的期望字节数，下载完成后逐一核对，防止截断文件混进题库。
// mirrors 缺省用 DATA_MIRRORS。
const SUITE_FILES: Record<EvalSuiteId, { name: string; sizeBytes: number; mirrors?: string[] }[]> = {
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
  humaneval: [{ name: "humaneval.jsonl", sizeBytes: 179_055 }],
  mbpp: [{ name: "mbpp.jsonl", sizeBytes: 175_257 }],
  ifeval: [{ name: "ifeval_input_data.jsonl", sizeBytes: 207_111, mirrors: HF_IFEVAL_MIRRORS }],
  // 长文多针检索在本地合成，无题库文件。
  longctx: [],
};

export const EVAL_SUITES: Record<EvalSuiteId, {
  /** 前端「快速模式」的默认抽样题数。 */
  defaultSample: number;
  /** 单题作答的输出 token 上限（代码 / 长文需要更长）。 */
  maxTokens: number;
  /** 是否按科目（或自定义维度）统计得分。 */
  bySubject: boolean;
  /** 全量题数（展示用）。 */
  totalQuestions: number;
  /** 套件的一句话定位（前端徽章用）。 */
  kind: "knowledge" | "math" | "code" | "writing" | "long-context";
}> = {
  mmlu: { defaultSample: 300, maxTokens: 128, bySubject: true, totalQuestions: 14_042, kind: "knowledge" },
  cmmlu: { defaultSample: 300, maxTokens: 128, bySubject: true, totalQuestions: 11_528, kind: "knowledge" },
  gsm8k: { defaultSample: 100, maxTokens: 512, bySubject: false, totalQuestions: 1_319, kind: "math" },
  mmlu_pro: { defaultSample: 300, maxTokens: 2048, bySubject: true, totalQuestions: 12_032, kind: "knowledge" },
  humaneval: { defaultSample: 80, maxTokens: 2048, bySubject: false, totalQuestions: 164, kind: "code" },
  mbpp: { defaultSample: 150, maxTokens: 2048, bySubject: false, totalQuestions: 500, kind: "code" },
  ifeval: { defaultSample: 150, maxTokens: 1024, bySubject: false, totalQuestions: 540, kind: "writing" },
  longctx: { defaultSample: 10, maxTokens: 64, bySubject: true, totalQuestions: 30, kind: "long-context" },
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
      kind: EVAL_SUITES[id].kind,
    };
  });
}

/** 补齐缺失的题库文件：镜像轮询（文件可指定专属源），流式落盘（.tmp 原子改名），大小不符即重试下一源。 */
export async function ensureEvalData(
  suite: EvalSuiteId,
  onProgress: (received: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  mkdirSync(getDataDir("eval-data"), { recursive: true });
  for (const { name, sizeBytes, mirrors } of SUITE_FILES[suite]) {
    if (isFileReady(name, sizeBytes)) continue;
    let lastError: unknown = null;
    for (const mirror of mirrors ?? DATA_MIRRORS) {
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
  /** 套件专属判分数据：代码测试脚本 / 指令校验参数 / 长文针值等。 */
  meta?: Record<string, unknown>;
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
    case "humaneval": {
      const all: EvalItem[] = readJsonl("humaneval.jsonl").map((raw) => ({
        question: String(raw.prompt ?? ""),
        choices: [],
        labels: [],
        answer: "",
        subject: "code",
        meta: { test: String(raw.test ?? ""), entryPoint: String(raw.entry_point ?? "") },
      }));
      return {
        items: sampleSize > 0 ? sampleFlat(all, sampleSize) : all,
        fewShot: new Map(),
        datasetTotal: all.length,
      };
    }
    case "mbpp": {
      const all: EvalItem[] = readJsonl("mbpp.jsonl")
        .filter((raw) => Array.isArray(raw.test_list) && (raw.test_list as unknown[]).length > 0)
        .map((raw) => ({
          question: String(raw.prompt ?? ""),
          choices: [],
          labels: [],
          answer: "",
          subject: "code",
          meta: {
            testList: (raw.test_list as unknown[]).map(String),
            setupCode: String(raw.test_setup_code ?? ""),
          },
        }));
      return {
        items: sampleSize > 0 ? sampleFlat(all, sampleSize) : all,
        fewShot: new Map(),
        datasetTotal: all.length,
      };
    }
    case "ifeval": {
      const all: EvalItem[] = readJsonl("ifeval_input_data.jsonl").map((raw) => ({
        question: String(raw.prompt ?? ""),
        choices: [],
        labels: [],
        answer: "",
        subject: "writing",
        meta: {
          instructionIds: Array.isArray(raw.instruction_id_list) ? (raw.instruction_id_list as unknown[]).map(String) : [],
          kwargsList: Array.isArray(raw.kwargs) ? (raw.kwargs as unknown[]) : [],
        },
      }));
      return {
        items: sampleSize > 0 ? sampleFlat(all, sampleSize) : all,
        fewShot: new Map(),
        datasetTotal: all.length,
      };
    }
    case "longctx": {
      const all = synthesizeLongContext(Math.min(sampleSize > 0 ? sampleSize : 30, 30));
      return { items: all, fewShot: new Map(), datasetTotal: 30 };
    }
  }
}

// ---------------------------------------------------------------------------
// 长文多针检索（本地合成）：把若干「关键词 → 魔数」的针句埋进长噪声文
// 的不同深度，提问其中一支。能测的是上下文中段的信息保真（lost in the
// middle），按针深度分档统计得分。
// ---------------------------------------------------------------------------

const LONGCTX_TARGET_CHARS = 32_768; // ≈ 8k tokens，多数本地模型的默认窗口内
const LONGCTX_MAX_ITEMS = 30;
const LONGCTX_KEYS = [
  "blue orchid", "crimson kite", "silver lantern", "amber river", "jade compass",
  "ivory bell", "copper meadow", "cobalt ferry", "walnut bridge", "pearl canyon",
];
const LONGCTX_FILLER = [
  "The valley archive records another quiet season of measured rainfall and slow sediment.",
  "Committees reviewed the ledger twice before sealing the annual wool and timber accounts.",
  "A traveling surveyor sketched the aqueduct, noting repairs deferred until autumn.",
  "The night watch logged three lantern signals and a slow barge passing the eastern weir.",
  "Gardeners rotated the clover beds while apprentices repainted the greenhouse frames.",
  "The harbor master filed tide tables alongside complaints about drifting marker buoys.",
  "An old almanac marginal note disputed the dating of a comet seen two winters past.",
  "Merchants haggled politely over saffron lots as the afternoon bell rang nine times.",
];

/** 每题埋 5 针（深度 0.1–0.9 均布），问其中 1 支；答案为 8 位十六进制魔数。 */
function synthesizeLongContext(count: number): EvalItem[] {
  const rng = seededRandom(42);
  const blockCount = 40;
  const items: EvalItem[] = [];
  for (let i = 0; i < Math.min(count, LONGCTX_MAX_ITEMS); i++) {
    const keys = pickReproducible(rng, LONGCTX_KEYS, 5);
    const needles = keys.map((key, idx) => ({
      key,
      value: Array.from({ length: 8 }, () => "0123456789abcdef"[Math.floor(rng() * 16)]!).join(""),
      slot: Math.round((0.1 + idx * 0.2) * blockCount),
    }));
    // 针槽冲突时顺延，保证 5 针互不覆盖。
    const needleAtSlot = new Map<number, (typeof needles)[number]>();
    for (const n of needles) {
      let slot = n.slot;
      while (needleAtSlot.has(slot)) slot += 1;
      needleAtSlot.set(slot, n);
    }

    const parts: string[] = [];
    let chars = 0;
    for (let block = 0; block < blockCount && chars < LONGCTX_TARGET_CHARS; block++) {
      for (let s = 0; s < 3; s++) {
        const sentence = LONGCTX_FILLER[Math.floor(rng() * LONGCTX_FILLER.length)]!;
        parts.push(sentence);
        chars += sentence.length;
      }
      const needle = needleAtSlot.get(block + 1);
      if (needle) {
        parts.push(`One of the special magic numbers for ${needle.key} is: ${needle.value}.`);
      }
    }

    const asked = needles[Math.floor(rng() * needles.length)]!;
    const depthBucket = asked.slot / blockCount <= 0.3 ? "≤30%" : asked.slot / blockCount <= 0.6 ? "31–60%" : "≥61%";
    items.push({
      question: parts.join(" "),
      choices: [],
      labels: [],
      answer: asked.value,
      subject: depthBucket,
      meta: { askedKey: asked.key },
    });
  }
  return items;
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
  if (suite === "humaneval") {
    return [
      "Complete the Python function below. Output the full implementation only — no prose, no markdown fences.",
      "",
      item.question,
    ].join("\n");
  }
  if (suite === "mbpp") {
    const tests = ((item.meta?.testList as string[]) ?? []).slice(0, 3).join("\n");
    return [
      "Implement a Python function for the problem below. Output the complete function only — no prose, no markdown fences.",
      "",
      `Problem: ${item.question}`,
      "",
      "Expected behavior (for reference):",
      tests,
    ].join("\n");
  }
  if (suite === "ifeval") {
    // 题面自带约束指令（"写 300 词以上、禁用逗号…"），原样下发即可。
    return item.question;
  }
  if (suite === "longctx") {
    const askedKey = String(item.meta?.askedKey ?? "");
    return [
      item.question,
      "",
      `Question: What is the special magic number for ${askedKey} mentioned in the passage above? Reply with the number only.`,
    ].join("\n");
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
// 代码类判分：提取生成代码 → 本机 python3 沙箱执行（超时 + 临时文件即删）。
// 单用户本地场景、被测代码来自用户自己的模型；Bun.spawn 无 rlimit 能力，
// 以 15 秒墙钟超时兜底。若本机无 python3，任务以错误结束并提示。
// ---------------------------------------------------------------------------

const CODE_EXEC_TIMEOUT_MS = 15_000;

/** 提取回复中的 Python 代码：```python 围栏 → 任意围栏 → 从 def/class/import 行起收集 → 原文。 */
export function extractPythonCode(response: string): string {
  const fenced = [...response.matchAll(/```python\s*\n([\s\S]*?)```/g)].map((m) => m[1]!.trim());
  if (fenced.length > 0) return fenced[fenced.length - 1]!;
  const generic = [...response.matchAll(/```\s*\n([\s\S]*?)```/g)].map((m) => m[1]!.trim());
  if (generic.length > 0) return generic[generic.length - 1]!;
  const lines: string[] = [];
  let inCode = false;
  for (const line of response.split("\n")) {
    if (!inCode && /^(def |class |import |from |@)/.test(line)) inCode = true;
    if (inCode) lines.push(line);
  }
  return lines.length > 0 ? lines.join("\n") : response.trim();
}

/** 函数补全形态的修复：只回了函数体时拼回原签名；缺 import 时从题面补。 */
function assembleHumanevalSolution(code: string, item: EvalItem): string {
  const prompt = item.question;
  let out = code;
  if (!/\bdef\s+\w/.test(out)) out = `${prompt}\n${out}`;
  if (!/^\s*(import|from)\s/m.test(out)) {
    const imports = prompt
      .split("\n")
      .filter((l) => /^(import|from)\s/.test(l))
      .join("\n");
    if (imports) out = `${imports}\n${out}`;
  }
  return out;
}

let pythonAvailable: boolean | null = null;

async function hasPython3(): Promise<boolean> {
  if (pythonAvailable !== null) return pythonAvailable;
  try {
    const proc = Bun.spawn(["python3", "--version"], { stdout: "ignore", stderr: "ignore" });
    pythonAvailable = (await proc.exited) === 0;
  } catch {
    pythonAvailable = false;
  }
  return pythonAvailable;
}

/** 临时脚本落盘 → python3 执行 → 退出码 0 判过。 */
export async function runPythonForTest(script: string): Promise<boolean> {
  if (!(await hasPython3())) {
    throw new Error("本机未找到 python3，代码类评测无法执行判分");
  }
  const dir = mkdtempSync(join(tmpdir(), "omni-eval-code-"));
  const file = join(dir, "solution.py");
  writeFileSync(file, script);
  try {
    const proc = Bun.spawn(["python3", file], {
      stdout: "ignore",
      stderr: "ignore",
      signal: AbortSignal.timeout(CODE_EXEC_TIMEOUT_MS),
    });
    return (await proc.exited) === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// IFEval 校验器：每条指令一个纯函数校验。判分口径为 strict（全部指令通过
// 才算对）；词数 / 句数用空白与标点切分的近似计数（非 nltk 分词）。
// ---------------------------------------------------------------------------

type IfevalKwargs = Record<string, unknown>;

const num = (v: unknown, fallback = 0) => (typeof v === "number" ? v : Number(v) || fallback);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

function countWords(text: string): number {
  return (text.match(/\S+/g) ?? []).length;
}

function countSentences(text: string): number {
  return (text.match(/[.!?]+(?=\s|$)/g) ?? []).length;
}

function countParagraphs(text: string): number {
  return text.split(/\n\s*\n/).filter((p) => p.trim().length > 0).length;
}

function splitOnStars(text: string): string[] {
  return text.split(/\*{3,}/).filter((p) => p.trim().length > 0);
}

function relationOk(actual: number, relation: string, target: number): boolean {
  return relation === "less than" ? actual < target : actual >= target;
}

/** 响应语言粗判：按主要文字系统占比。覆盖常见目标语言，识别不了判不过。 */
function detectLanguage(text: string): string {
  const counts = { latin: 0, cjk: 0, kana: 0, hangul: 0, cyrillic: 0, arabic: 0, devanagari: 0 };
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x41 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f)) counts.latin++;
    else if (c >= 0x4e00 && c <= 0x9fff) counts.cjk++;
    else if (c >= 0x3040 && c <= 0x30ff) counts.kana++;
    else if (c >= 0xac00 && c <= 0xd7af) counts.hangul++;
    else if (c >= 0x400 && c <= 0x4ff) counts.cyrillic++;
    else if (c >= 0x600 && c <= 0x6ff) counts.arabic++;
    else if (c >= 0x900 && c <= 0x97f) counts.devanagari++;
  }
  const letters = Object.values(counts).reduce((a, b) => a + b, 0);
  if (letters === 0) return "en";
  const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]![0];
  const map: Record<string, string> = {
    latin: "en",
    cjk: "zh",
    kana: "ja",
    hangul: "ko",
    cyrillic: "ru",
    arabic: "ar",
    devanagari: "hi",
  };
  // 中文题面里常夹少量拉丁词，按占比校正。
  if (dominant === "latin" && counts.cjk / letters > 0.2) return "zh";
  return map[dominant] ?? "en";
}

function verifyInstruction(id: string, kw: IfevalKwargs, response: string, prompt: string): boolean {
  switch (id) {
    case "punctuation:no_comma":
      return !response.includes(",");
    case "length_constraints:number_words":
      return relationOk(countWords(response), String(kw.relation ?? ""), num(kw.num_words));
    case "length_constraints:number_sentences":
      return relationOk(countSentences(response), String(kw.relation ?? ""), num(kw.num_sentences));
    case "length_constraints:number_paragraphs":
      return relationOk(countParagraphs(response), String(kw.relation ?? ""), num(kw.num_paragraphs));
    case "length_constraints:nth_paragraph_first_word": {
      const paras = splitOnStars(response);
      const nth = num(kw.nth_paragraph, 1);
      const para = paras[nth - 1];
      if (!para) return false;
      const first = (para.match(/\S+/) ?? [])[0]?.replace(/[^\w']/g, "") ?? "";
      return first.toLowerCase() === String(kw.first_word ?? "").toLowerCase();
    }
    case "keywords:existence":
      return strList(kw.keywords).every((k) =>
        new RegExp(`(^|[^a-zA-Z])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-zA-Z]|$)`, "i").test(response),
      );
    case "keywords:frequency": {
      const target = String(kw.keyword ?? "");
      const occurrences = (response.match(new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")) ?? []).length;
      return relationOk(occurrences, String(kw.relation ?? ""), num(kw.frequency, num(kw.num)));
    }
    case "keywords:forbidden_words":
      return strList(kw.keywords).every(
        (k) => !new RegExp(`(^|[^a-zA-Z])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-zA-Z]|$)`, "i").test(response),
      );
    case "keywords:letter_frequency": {
      const letter = String(kw.letter ?? "");
      let occurrences = 0;
      for (const ch of response.toLowerCase()) if (ch === letter.toLowerCase()) occurrences++;
      return relationOk(occurrences, String(kw.relation ?? ""), num(kw.let_frequency, num(kw.num)));
    }
    case "language:response_language":
      return detectLanguage(response) === String(kw.language ?? "en");
    case "startend:quotation": {
      const s = response.trim();
      const quotes = ['"', "'", "“", "”", "‘", "’"];
      return s.length >= 2 && quotes.includes(s[0]!) && quotes.includes(s[s.length - 1]!);
    }
    case "startend:end_checker":
      return response.trim().toLowerCase().endsWith(String(kw.end_phrase ?? "").toLowerCase());
    case "change_case:english_lowercase":
      return response === response.toLowerCase();
    case "change_case:english_capital":
      return response === response.toUpperCase();
    case "change_case:capital_word_frequency": {
      const words = response.match(/[A-Za-z]+/g) ?? [];
      const caps = words.filter((w) => w === w.toUpperCase()).length;
      return relationOk(caps, String(kw.relation ?? ""), num(kw.capital_frequency, num(kw.capital_word_frequency)));
    }
    case "detectable_content:number_placeholders": {
      const placeholders = response.match(/\[[^\[\]]+\]/g) ?? [];
      return placeholders.length >= num(kw.num_placeholders);
    }
    case "detectable_content:postscript": {
      const marker = String(kw.postscript_marker ?? "P.S.");
      return new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\./g, "."), "i").test(response);
    }
    case "detectable_format:number_bullet_lists":
      return (response.match(/^\s*(?:\*|-)\s+/gm) ?? []).length >= num(kw.num_bullets);
    case "detectable_format:constrained_response": {
      const options = [
        "My answer is yes.",
        "My answer is no.",
        "My answer is maybe.",
      ];
      const cleaned = response.trim().toLowerCase().replace(/[.。!！?？]/g, "");
      return options.some((o) => cleaned === o.toLowerCase().replace(/\./g, ""));
    }
    case "detectable_format:number_highlighted_sections":
      return (response.match(/\*[^*\n]+\*/g) ?? []).length >= num(kw.num_highlights);
    case "detectable_format:multiple_sections":
      return (response.match(/Section\s+\d+/g) ?? []).length >= num(kw.num_sections);
    case "detectable_format:json_format": {
      const stripped = response.trim().replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "");
      try {
        JSON.parse(stripped);
        return true;
      } catch {
        return false;
      }
    }
    case "combination:two_responses": {
      const parts = splitOnStars(response);
      return parts.length === 2;
    }
    case "combination:repeat_prompt": {
      const toRepeat = String(kw.prompt_to_repeat ?? prompt);
      return response.includes(toRepeat);
    }
    default:
      // 未知指令类型按未通过处理，避免虚高分数。
      return false;
  }
}

function gradeIfevalItem(item: EvalItem, response: string): boolean {
  const ids = (item.meta?.instructionIds as string[]) ?? [];
  const kwargsList = (item.meta?.kwargsList as IfevalKwargs[]) ?? [];
  return ids.every((id, i) => verifyInstruction(id, kwargsList[i] ?? {}, response, item.question));
}

/** 供 smoke / 调试直接校验一组 IFEval 指令。 */
export function verifyIfevalInstructions(
  ids: string[],
  kwargsList: IfevalKwargs[],
  response: string,
  prompt = "",
): boolean {
  return ids.every((id, i) => verifyInstruction(id, kwargsList[i] ?? {}, response, prompt));
}

/**
 * 统一判分入口。选择 / 数字类是纯函数；代码类需要沙箱执行（异步）；
 * IFEval 跑指令校验器；长文检索做子串匹配。
 */
export async function gradeEvalAnswer(suite: EvalSuiteId, response: string, item: EvalItem): Promise<boolean> {
  switch (suite) {
    case "humaneval": {
      const test = String(item.meta?.test ?? "");
      const entryPoint = String(item.meta?.entryPoint ?? "");
      if (!test || !entryPoint) return false;
      const code = assembleHumanevalSolution(extractPythonCode(response), item);
      return runPythonForTest(`${code}\n${test}\ncheck(${entryPoint})\n`);
    }
    case "mbpp": {
      const testList = (item.meta?.testList as string[]) ?? [];
      const setupCode = String(item.meta?.setupCode ?? "");
      if (testList.length === 0) return false;
      const code = extractPythonCode(response);
      return runPythonForTest(`${setupCode}\n${code}\n${testList.join("\n")}\n`);
    }
    case "ifeval":
      return gradeIfevalItem(item, response);
    case "longctx":
      return response.toLowerCase().includes(item.answer.toLowerCase());
    default:
      return checkEvalAnswer(suite, extractEvalAnswer(suite, response, item), item);
  }
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
  // 代码套件依赖本机 python3 执行判分，缺环境时直接失败整个任务（错误透出到 UI）。
  if ((suite === "humaneval" || suite === "mbpp") && !(await hasPython3())) {
    throw new Error("本机未找到 python3，代码类评测无法执行判分（请安装 Python 3 后重试）");
  }
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
      } else if (await gradeEvalAnswer(suite, reply, item)) {
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
