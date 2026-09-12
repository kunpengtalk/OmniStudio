/**
 * 纯文本检索原语：知识库（chunk 检索）与记忆库（memory_search）共用。
 *
 * 刻意保持零依赖（不 import db / 网络 / electrobun）：`omi` CLI 在应用未运行时
 * 直连 SQLite 跑检索，这条路径不能被动依赖拖进主进程的重模块。
 */

/** 拉丁/数字按词元，CJK 按二元组（单字短语退化为单字）。 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9]+/g)) tokens.push(m[0]);
  for (const m of lower.matchAll(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/g)) {
    const run = Array.from(m[0]);
    if (run.length === 1) {
      tokens.push(run[0]!);
    } else {
      for (let i = 0; i + 1 < run.length; i++) tokens.push(run[i]! + run[i + 1]!);
    }
  }
  return tokens;
}

/**
 * 归一化：小写、全角转半角、去掉所有标点与空白。
 * 用于「同一句话的不同写法」判定（"用户偏好：中文。" ≡ "用户偏好中文"）。
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

/** 归一化后的词元集合（去重，保持可比性）。 */
export function tokenSet(text: string): Set<string> {
  return new Set(tokenize(normalizeText(text)));
}

/**
 * 包含度：|A∩B| / min(|A|,|B|)，0..1。
 * 短句被长句完整覆盖时为 1 —— 正是「新记忆是旧记忆的细化」这种情况。
 */
export function tokenContainment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const tk of small) if (large.has(tk)) inter++;
  return inter / small.size;
}

/**
 * Jaccard 相似度：|A∩B| / |A∪B|，0..1。
 * 与包含度相反，它双向要求覆盖：两段大体相同、只在少数词上分岔的文本相似度会显著下降。
 * 召回去冗要用它而不是包含度 —— 否则「同一个模板套不同实体」的分块会被误判成重复
 * （模板占九成时包含度接近 1，丢掉的恰恰是有区别的那一成）。
 */
export function tokenJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const tk of small) if (large.has(tk)) inter++;
  return inter / (a.size + b.size - inter);
}

// ---------------------------------------------------------------------------
// BM25（内存索引，写路径统一失效重算）
// ---------------------------------------------------------------------------

export type IndexedDoc = {
  id: number;
  /** 正文词频。 */
  tf: Map<string, number>;
  /** 标签词频（单独加权，命中标签 ≈ 命中主题）。 */
  tagTf: Map<string, number>;
  len: number;
};

export type Bm25Index = {
  docs: IndexedDoc[];
  df: Map<string, number>;
  avgLen: number;
};

const BM25_K1 = 1.5;
const BM25_B = 0.75;
/** 标签命中权重：标签是人工/模型提炼的主题词，比正文里偶然出现一次更可信。 */
const TAG_WEIGHT = 2;

export function buildBm25Index(docs: { id: number; text: string; tags?: string[] }[]): Bm25Index {
  const indexed: IndexedDoc[] = [];
  const df = new Map<string, number>();
  let totalLen = 0;

  for (const d of docs) {
    const tf = new Map<string, number>();
    for (const tk of tokenize(d.text)) tf.set(tk, (tf.get(tk) ?? 0) + 1);
    const tagTf = new Map<string, number>();
    for (const tag of d.tags ?? []) {
      for (const tk of tokenize(tag)) tagTf.set(tk, (tagTf.get(tk) ?? 0) + 1);
    }
    const terms = new Set([...tf.keys(), ...tagTf.keys()]);
    for (const tk of terms) df.set(tk, (df.get(tk) ?? 0) + 1);
    const len = [...tf.values()].reduce((s, n) => s + n, 0) || 1;
    totalLen += len;
    indexed.push({ id: d.id, tf, tagTf, len });
  }

  return { docs: indexed, df, avgLen: indexed.length > 0 ? totalLen / indexed.length : 1 };
}

function idf(index: Bm25Index, term: string): number {
  const n = index.df.get(term) ?? 0;
  return Math.log(1 + (index.docs.length - n + 0.5) / (n + 0.5));
}

function termScore(
  index: Bm25Index,
  doc: IndexedDoc,
  qCounts: Map<string, number>,
  field: "tf" | "tagTf",
): number {
  let score = 0;
  for (const [term, qf] of qCounts) {
    const f = doc[field].get(term);
    if (!f) continue;
    const norm = 1 - BM25_B + BM25_B * (doc.len / index.avgLen);
    score += idf(index, term) * ((qf * f * (BM25_K1 + 1)) / (qf + BM25_K1 * norm));
  }
  return score;
}

/**
 * 查询词按空白切成子句，分别打分后取和：查询 "部署 bun" 时
 * 命中「部署」和命中「bun」的记忆都能排上来，而不是要求整串出现。
 * 子句内部的 CJK 仍按二元组匹配（"部署方式" 命中 "部署"）。
 */
export function bm25Rank(index: Bm25Index, query: string, limit: number): { id: number; score: number }[] {
  const clauses = query
    .split(/[\s,，、;；|/]+/)
    .map((c) => c.trim())
    .filter(Boolean);
  if (clauses.length === 0) return [];

  const perClause = clauses.map((clause) => {
    const counts = new Map<string, number>();
    for (const tk of tokenize(clause)) counts.set(tk, (counts.get(tk) ?? 0) + 1);
    return counts;
  });

  const scored: { id: number; score: number }[] = [];
  for (const doc of index.docs) {
    let score = 0;
    for (const counts of perClause) {
      if (counts.size === 0) continue;
      score += termScore(index, doc, counts, "tf") + TAG_WEIGHT * termScore(index, doc, counts, "tagTf");
    }
    if (score > 0) scored.push({ id: doc.id, score });
  }
  scored.sort((a, b) => b.score - a.score || a.id - b.id);
  return scored.slice(0, limit);
}
