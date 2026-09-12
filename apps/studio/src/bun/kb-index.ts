/**
 * 知识库检索内核：倒排索引 + 常驻向量矩阵。
 *
 * 替换掉早期实现的两个扩展性瓶颈：
 * 1) 关键词侧原先是「每个分块一个 tf Map + 每次查询全表扫」，且任何一次写入都让
 *    整库索引作废、下次查询重新分词全库。现在是 term → postings 的倒排表
 *    （并排的 ids/tfs 数组，比 Map<id,tf> 省一个数量级内存且扫描更快），
 *    查询只触碰含查询词的 posting，写入按文档增量增删，不再全量重建。
 * 2) 向量侧原先每次查询把所有分块的 base64 向量解码一遍（万级分块 ≈ 每次查询
 *    几十 MB 的 base64 解码）。现在归一化 Float32 常驻内存、按槽位 O(1) 增删，
 *    查询退化为一次稠密点积扫描。
 *
 * 删除采用墓碑（tf 置 0）+ 阈值触发压缩：单块删除是 O(词元数)，
 * 文档级删除是一次全表扫描（重建索引的 1/10 成本），都远低于原先的整库重建。
 *
 * 内存边界：按库缓存并做 LRU（MAX_CACHED_KBS 个库），不活跃的库整块释放。
 */
import { eq } from "drizzle-orm";

import { db } from "./db";
import { knowledgeChunks, knowledgeDocs } from "./db/schema";
import { decodeEmbedding } from "./embeddings";
import { tokenize } from "./text-search";
import { contextText } from "./kb-chunk";

const BM25_K1 = 1.5;
const BM25_B = 0.75;
/** 标题路径命中的额外权重：标题是结构信息，比正文里偶然出现一次更可信。 */
const HEADING_WEIGHT = 1.5;
/** 同时缓存的库数量上限（每个库持整份倒排 + 向量）。 */
const MAX_CACHED_KBS = 4;
/** 墓碑占比超过这个比例就压缩一次倒排表。 */
const COMPACT_TOMBSTONE_RATIO = 0.25;
const COMPACT_MIN_TOMBSTONES = 512;

/** 平行数组形式的 posting 表：ids[i] 的词频是 tfs[i]；tf=0 表示墓碑。 */
type Posting = { ids: number[]; tfs: number[]; df: number };

export type IndexedChunkMeta = {
  docId: number;
  seq: number;
  /** 正文词元数（BM25 长度归一化用）。 */
  len: number;
  /** 该分块贡献的词元，删除时用来定位 posting（避免全表扫描）。 */
  terms: string[];
};

export type IndexableChunk = {
  id: number;
  docId: number;
  seq: number;
  content: string;
  headingPath: string | null;
  docName: string;
  embedding?: Float32Array | null;
};

function normalizeVector(vec: Float32Array): Float32Array | null {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i]! * vec[i]!;
  if (norm === 0) return null;
  const scale = 1 / Math.sqrt(norm);
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i]! * scale;
  return out;
}

/**
 * 单个知识库的检索索引。
 *
 * 标题路径单独一张倒排表并参与加权；向量按槽位稠密存放（swap-remove），
 * 维度由首个向量确定，随后不一致的向量被忽略（正常路径上 updateKb 换模型时
 * 已经清空旧向量，这里只是不信任脏数据）。
 */
export class KbSearchIndex {
  private postings = new Map<string, Posting>();
  private headingPostings = new Map<string, Posting>();
  private chunks = new Map<number, IndexedChunkMeta>();
  private byDoc = new Map<number, Set<number>>();
  private totalLen = 0;
  private tombstones = 0;

  /** 归一化向量与其持有的分块 id，槽位数组保证扫描连续。 */
  private slots: Float32Array[] = [];
  private slotOf = new Map<number, number>();
  private idOf: number[] = [];

  get size(): number {
    return this.chunks.size;
  }

  get vectorCount(): number {
    return this.slotOf.size;
  }

  get dimensions(): number {
    return this.slots[0]?.length ?? 0;
  }

  get docCount(): number {
    return this.byDoc.size;
  }

  get termCount(): number {
    return this.postings.size;
  }

  private tokenizeHead(chunk: IndexableChunk): Map<string, number> {
    const tf = new Map<string, number>();
    for (const tk of tokenize(contextText(chunk.docName, chunk.headingPath, ""))) {
      tf.set(tk, (tf.get(tk) ?? 0) + 1);
    }
    return tf;
  }

  addChunk(chunk: IndexableChunk): void {
    if (this.chunks.has(chunk.id)) this.dropChunks(new Set([chunk.id]));
    const table = new Map<string, number>();
    for (const tk of tokenize(chunk.content)) table.set(tk, (table.get(tk) ?? 0) + 1);
    const headTf = this.tokenizeHead(chunk);

    for (const [term, tf] of table) {
      let pl = this.postings.get(term);
      if (!pl) this.postings.set(term, (pl = { ids: [], tfs: [], df: 0 }));
      pl.ids.push(chunk.id);
      pl.tfs.push(tf);
      pl.df++;
    }
    for (const [term, tf] of headTf) {
      let pl = this.headingPostings.get(term);
      if (!pl) this.headingPostings.set(term, (pl = { ids: [], tfs: [], df: 0 }));
      // 同一词元在正文里已存在时，标题命中不重复计入 df（只补一份加权词频）
      pl.ids.push(chunk.id);
      pl.tfs.push(tf);
      pl.df++;
    }

    const len = [...table.values()].reduce((s, n) => s + n, 0) || 1;
    this.chunks.set(chunk.id, { docId: chunk.docId, seq: chunk.seq, len, terms: [...table.keys()] });
    this.totalLen += len;
    let docSet = this.byDoc.get(chunk.docId);
    if (!docSet) this.byDoc.set(chunk.docId, (docSet = new Set()));
    docSet.add(chunk.id);
    if (chunk.embedding) this.setVector(chunk.id, chunk.embedding);
  }

  removeChunk(id: number): void {
    this.dropChunks(new Set([id]));
  }

  /** 用新的一批分块整体替换某文档的旧分块（重新摄取/增量重索引）。 */
  replaceDoc(docId: number, chunks: IndexableChunk[]): void {
    this.removeDoc(docId);
    for (const chunk of chunks) this.addChunk(chunk);
  }

  removeDoc(docId: number): void {
    const ids = this.byDoc.get(docId);
    if (!ids || ids.size === 0) return;
    this.dropChunks(new Set(ids));
  }

  /** 批量删除：每个分块只用它自己的词元表去定位 posting，不做全表扫描。 */
  private dropChunks(ids: Set<number>): void {
    for (const id of ids) {
      const meta = this.chunks.get(id);
      if (!meta) continue;
      for (const term of meta.terms) {
        const pl = this.postings.get(term);
        if (!pl) continue;
        for (let i = 0; i < pl.ids.length; i++) {
          if (pl.ids[i] === id && pl.tfs[i] !== 0) {
            pl.tfs[i] = 0;
            pl.df--;
            this.tombstones++;
            break;
          }
        }
      }
      this.chunks.delete(id);
      this.totalLen -= meta.len;
      const docSet = this.byDoc.get(meta.docId);
      if (docSet) {
        docSet.delete(id);
        if (docSet.size === 0) this.byDoc.delete(meta.docId);
      }
      this.deleteVector(id);
    }
    this.maybeCompact();
  }

  private maybeCompact(): void {
    const live = this.chunks.size;
    const threshold = Math.max(COMPACT_MIN_TOMBSTONES, live * COMPACT_TOMBSTONE_RATIO);
    if (this.tombstones < threshold) return;
    for (const table of [this.postings, this.headingPostings]) {
      for (const [term, pl] of table) {
        let write = 0;
        for (let read = 0; read < pl.ids.length; read++) {
          if (pl.tfs[read] === 0) continue;
          pl.ids[write] = pl.ids[read]!;
          pl.tfs[write] = pl.tfs[read]!;
          write++;
        }
        pl.ids.length = write;
        pl.tfs.length = write;
        if (write === 0) table.delete(term);
      }
    }
    this.tombstones = 0;
  }

  setVector(id: number, vec: Float32Array): void {
    if (!this.chunks.has(id)) return;
    const normalized = normalizeVector(vec);
    if (!normalized) return;
    const dim = this.dimensions;
    if (dim !== 0 && normalized.length !== dim) return;
    const existing = this.slotOf.get(id);
    if (existing != null) {
      this.slots[existing] = normalized;
      return;
    }
    this.slots.push(normalized);
    this.slotOf.set(id, this.slots.length - 1);
    this.idOf.push(id);
  }

  private deleteVector(id: number): void {
    const slot = this.slotOf.get(id);
    if (slot == null) return;
    const last = this.slots.length - 1;
    if (slot !== last) {
      const movedId = this.idOf[last]!;
      this.slots[slot] = this.slots[last]!;
      this.idOf[slot] = movedId;
      this.slotOf.set(movedId, slot);
    }
    this.slots.pop();
    this.idOf.pop();
    this.slotOf.delete(id);
  }

  private avgLen(): number {
    const n = this.chunks.size;
    return n > 0 ? this.totalLen / n : 1;
  }

  /**
   * BM25 检索：查询按空白/标点切成子句分别打分求和（"部署 bun" 命中任一词都能排上来），
   * 子句内部 CJK 仍按二元组匹配。只遍历命中词元的 posting，不扫全库。
   */
  bm25Rank(query: string, limit: number): { id: number; score: number }[] {
    const clauses = query
      .split(/[\s,，、;；|/]+/)
      .map((c) => c.trim())
      .filter(Boolean);
    if (clauses.length === 0 || this.chunks.size === 0) return [];

    const N = this.chunks.size;
    const avgLen = this.avgLen();
    const acc = new Map<number, number>();

    for (const clause of clauses) {
      const counts = new Map<string, number>();
      for (const tk of tokenize(clause)) counts.set(tk, (counts.get(tk) ?? 0) + 1);
      for (const [term, qf] of counts) {
        for (const [table, weight] of [
          [this.postings, 1],
          [this.headingPostings, HEADING_WEIGHT],
        ] as const) {
          const pl = table.get(term);
          if (!pl || pl.df === 0) continue;
          const idf = Math.log(1 + (N - pl.df + 0.5) / (pl.df + 0.5));
          for (let i = 0; i < pl.ids.length; i++) {
            const tf = pl.tfs[i]!;
            if (tf === 0) continue;
            const id = pl.ids[i]!;
            const meta = this.chunks.get(id);
            if (!meta) continue;
            const norm = 1 - BM25_B + BM25_B * (meta.len / avgLen);
            const termScore = idf * ((qf * tf * (BM25_K1 + 1)) / (qf + BM25_K1 * norm));
            acc.set(id, (acc.get(id) ?? 0) + weight * termScore);
          }
        }
      }
    }

    const scored = [...acc.entries()].map(([id, score]) => ({ id, score }));
    scored.sort((a, b) => b.score - a.score || a.id - b.id);
    return scored.slice(0, limit);
  }

  /** 向量检索：查询与全部常驻向量做点积（双方已归一化，点积即余弦）。 */
  vectorRank(query: Float32Array, limit: number, minScore = -Infinity): { id: number; score: number }[] {
    const dim = this.dimensions;
    if (dim === 0 || query.length !== dim) return [];
    const q = normalizeVector(query);
    if (!q) return [];

    const scored: { id: number; score: number }[] = [];
    for (let slot = 0; slot < this.slots.length; slot++) {
      const vec = this.slots[slot]!;
      let dot = 0;
      for (let i = 0; i < dim; i++) dot += q[i]! * vec[i]!;
      if (dot >= minScore) scored.push({ id: this.idOf[slot]!, score: dot });
    }
    scored.sort((a, b) => b.score - a.score || a.id - b.id);
    return scored.slice(0, limit);
  }

  /** 某个分块在当前索引里的元信息（重排/去冗时用，避免再查库）。 */
  meta(id: number): IndexedChunkMeta | undefined {
    return this.chunks.get(id);
  }
}

// ---------------------------------------------------------------------------
// 按库缓存（LRU）：查询路径懒加载，写路径增量维护
// ---------------------------------------------------------------------------

export type LoadedKbIndex = {
  index: KbSearchIndex;
  /** 分块 → 文档名（命中展示与引用用）。 */
  docNames: Map<number, string>;
  builtAt: number;
};

const cache = new Map<number, LoadedKbIndex>();

/** 已加载的索引（不触发加载）；摄取路径用它做增量更新。 */
export function peekKbIndex(kbId: number): KbSearchIndex | null {
  return cache.get(kbId)?.index ?? null;
}

function touch(kbId: number, entry: LoadedKbIndex): void {
  cache.delete(kbId);
  cache.set(kbId, entry);
  while (cache.size > MAX_CACHED_KBS) {
    const oldest = cache.keys().next().value;
    if (oldest == null) break;
    cache.delete(oldest);
  }
}

/** 从库里整份加载（重启后首次查询、或缓存被淘汰后）。 */
function loadKbIndex(kbId: number): LoadedKbIndex | null {
  const docRows = db
    .select({ id: knowledgeDocs.id, name: knowledgeDocs.name })
    .from(knowledgeDocs)
    .where(eq(knowledgeDocs.kbId, kbId))
    .all();
  const docNames = new Map(docRows.map((d) => [d.id, d.name]));
  if (docRows.length === 0) return null;

  const chunkRows = db
    .select({
      id: knowledgeChunks.id,
      docId: knowledgeChunks.docId,
      seq: knowledgeChunks.seq,
      content: knowledgeChunks.content,
      headingPath: knowledgeChunks.headingPath,
      embedding: knowledgeChunks.embedding,
    })
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.kbId, kbId))
    .all();
  if (chunkRows.length === 0) return null;

  const index = new KbSearchIndex();
  for (const row of chunkRows) {
    index.addChunk({
      id: row.id,
      docId: row.docId,
      seq: row.seq,
      content: row.content,
      headingPath: row.headingPath,
      docName: docNames.get(row.docId) ?? `#${row.docId}`,
      embedding: row.embedding ? decodeEmbedding(row.embedding) : null,
    });
  }
  return { index, docNames, builtAt: Date.now() };
}

/** 取库索引：命中缓存直接返回，未命中则整份加载。 */
export function getKbIndex(kbId: number): LoadedKbIndex | null {
  const cached = cache.get(kbId);
  if (cached) {
    touch(kbId, cached);
    return cached;
  }
  const loaded = loadKbIndex(kbId);
  if (!loaded) return null;
  touch(kbId, loaded);
  return loaded;
}

/** 整库失效（删除库、换嵌入模型等结构性变更；增量维护覆盖不到的场合）。 */
export function invalidateKbIndex(kbId: number): void {
  cache.delete(kbId);
}

/** 索引诊断（知识库运维信息，供 UI/CLI 观察内存占用与规模）。 */
export function kbIndexStats(): {
  kbId: number;
  chunks: number;
  vectors: number;
  dimensions: number;
  terms: number;
  bytes: number;
  builtAt: number;
}[] {
  return [...cache.entries()].map(([kbId, entry]) => ({
    kbId,
    chunks: entry.index.size,
    vectors: entry.index.vectorCount,
    dimensions: entry.index.dimensions,
    terms: entry.index.termCount,
    bytes: entry.index.vectorCount * entry.index.dimensions * 4,
    builtAt: entry.builtAt,
  }));
}
