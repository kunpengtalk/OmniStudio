/**
 * 知识库（本地 RAG）核心模块：
 * - 数据源摄取：本地文件（文本直读 / PDF·图片走 VLM OCR）/ 手写笔记 / 网页抓取；
 * - Markdown 感知切片（标题分节 + 段落贪心打包 + 超长硬切带重叠）；
 * - 可选向量化：OpenAI 兼容 /v1/embeddings，向量以 Float32 base64 存 chunk 行；
 * - 混合检索：BM25 关键词（CJK 二元 + 拉丁词元）与余弦向量各自排序后 RRF 融合。
 * 不依赖外部向量库 / FTS 扩展，个人知识库规模（万级分块）下纯 JS 即可。
 */
import { existsSync, readdirSync } from "fs";
import path from "path";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import * as cheerio from "cheerio";

import { db } from "./db";
import { knowledgeBases, knowledgeDocs, knowledgeChunks } from "./db/schema";
import type { KnowledgeBaseRow, KnowledgeDocRow } from "./db/schema";
import { getSetting, getActiveServerPort } from "./db/settings";
import { convertFileToImages, generate, type ModelEndpoint } from "./vllm";
import { getLocalModelName } from "./vllm/model";
import type { KbCitation, KbHit, KbDocKind } from "../shared/knowledge";

// ---------------------------------------------------------------------------
// 视图类型（RPC 直接返回给 mainview）
// ---------------------------------------------------------------------------

export type KbView = {
  id: number;
  name: string;
  description: string | null;
  embeddingModel: string;
  embeddingBase: string;
  embeddingApiKey: string;
  embeddingDim: number | null;
  rerankModel: string;
  rerankBase: string;
  rerankApiKey: string;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
  docCount: number;
  chunkCount: number;
  embeddedCount: number;
  createdAt: number | null;
  updatedAt: number | null;
};

export type KbDocView = {
  id: number;
  kbId: number;
  name: string;
  kind: KbDocKind;
  sourcePath: string | null;
  url: string | null;
  sizeBytes: number | null;
  charCount: number | null;
  chunkCount: number;
  embeddedCount: number;
  status: KnowledgeDocRow["status"];
  error: string | null;
  createdAt: number | null;
  updatedAt: number | null;
};

export type KbChunkView = {
  id: number;
  seq: number;
  charCount: number;
  embedded: boolean;
  content: string;
};

export type KbUpdatePatch = Partial<{
  name: string;
  description: string;
  embeddingModel: string;
  embeddingBase: string;
  embeddingApiKey: string;
  rerankModel: string;
  rerankBase: string;
  rerankApiKey: string;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
}>;

const KB_TEXT_FILE_RE =
  /\.(txt|md|markdown|json|csv|tsv|log|xml|yml|yaml|html?|htm|js|jsx|ts|tsx|mjs|cjs|css|scss|less|py|rb|rs|go|java|kt|swift|c|h|cpp|hpp|cs|php|sh|bash|zsh|toml|ini|cfg|conf|sql|vue|svelte|graphql|proto)$/i;
const KB_TEXT_MAX_BYTES = 16 * 1024 * 1024;

/** 目录导入时接受的扩展名（文本 + PDF/图片）。 */
const KB_FOLDER_FILE_RE =
  /\.(txt|md|markdown|json|csv|tsv|log|xml|yml|yaml|html?|htm|pdf|png|jpg|jpeg|webp|tiff|bmp|heic|heif)$/i;
const KB_FOLDER_IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  ".next",
  ".nuxt",
  ".turbo",
  "dist",
  "build",
  "out",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".DS_Store",
]);
const KB_FOLDER_MAX_FILES = 300;

/** 知识库变化事件（摄取进度/删除/向量补齐），rpc 层订阅后转发到 webview。 */
export type KnowledgeChangePayload = { kbId?: number; docId?: number };
type KnowledgeChangeListener = (payload: KnowledgeChangePayload) => void;
const changeListeners = new Set<KnowledgeChangeListener>();

export function onKnowledgeChanged(cb: KnowledgeChangeListener): () => void {
  changeListeners.add(cb);
  return () => {
    changeListeners.delete(cb);
  };
}

/** 任何 chunk 写路径后调用：失效内存索引 + 广播变化。 */
function notifyKb(kbId: number, docId?: number) {
  indexCache.delete(kbId);
  for (const cb of changeListeners) {
    try {
      cb({ kbId, docId });
    } catch {}
  }
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

function kbAgg(kbId: number): { docCount: number; chunkCount: number; embeddedCount: number } {
  const docs = db
    .select({ chunkCount: knowledgeDocs.chunkCount, embeddedCount: knowledgeDocs.embeddedCount })
    .from(knowledgeDocs)
    .where(eq(knowledgeDocs.kbId, kbId))
    .all();
  return {
    docCount: docs.length,
    chunkCount: docs.reduce((s, d) => s + d.chunkCount, 0),
    embeddedCount: docs.reduce((s, d) => s + d.embeddedCount, 0),
  };
}

function kbToView(row: KnowledgeBaseRow): KbView {
  return { ...row, ...kbAgg(row.id) };
}

export function listKnowledgeBases(): KbView[] {
  return db
    .select()
    .from(knowledgeBases)
    .orderBy(desc(knowledgeBases.updatedAt))
    .all()
    .map(kbToView);
}

export function getKb(id: number): KnowledgeBaseRow | null {
  return db.select().from(knowledgeBases).where(eq(knowledgeBases.id, id)).get() ?? null;
}

export function createKb(input: {
  name: string;
  description?: string;
  /** 嵌入模型（空 = 纯关键词检索）。 */
  embeddingModel?: string;
  /** 重排模型（空 = 不重排）。 */
  rerankModel?: string;
}): KbView {
  const name = input.name.trim() || "未命名知识库";
  const row = db
    .insert(knowledgeBases)
    .values({
      name,
      description: input.description?.trim() || null,
      embeddingModel: input.embeddingModel?.trim() ?? "",
      rerankModel: input.rerankModel?.trim() ?? "",
    })
    .returning()
    .get();
  notifyKb(row.id);
  return kbToView(row);
}

/**
 * 更新知识库配置。嵌入模型或接口变更时，旧向量与新模型不可比，
 * 清空该库全部向量（embeddedCount 归零），由用户在设置页手动重新向量化。
 */
export function updateKb(id: number, patch: KbUpdatePatch): { kb: KbView; embeddingsReset: boolean } {
  const kb = getKb(id);
  if (!kb) throw new Error("知识库不存在");

  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) set.name = patch.name.trim() || kb.name;
  if (patch.description !== undefined) set.description = patch.description.trim() || null;
  if (patch.embeddingModel !== undefined) set.embeddingModel = patch.embeddingModel.trim();
  if (patch.embeddingBase !== undefined) set.embeddingBase = patch.embeddingBase.trim();
  if (patch.embeddingApiKey !== undefined) set.embeddingApiKey = patch.embeddingApiKey.trim();
  if (patch.rerankModel !== undefined) set.rerankModel = patch.rerankModel.trim();
  if (patch.rerankBase !== undefined) set.rerankBase = patch.rerankBase.trim();
  if (patch.rerankApiKey !== undefined) set.rerankApiKey = patch.rerankApiKey.trim();
  if (patch.chunkSize !== undefined) set.chunkSize = clampInt(patch.chunkSize, 200, 4000, 800);
  if (patch.chunkOverlap !== undefined) set.chunkOverlap = clampInt(patch.chunkOverlap, 0, 1000, 120);
  if (patch.topK !== undefined) set.topK = clampInt(patch.topK, 1, 30, 6);

  const embeddingChanged =
    (patch.embeddingModel !== undefined && patch.embeddingModel.trim() !== kb.embeddingModel) ||
    (patch.embeddingBase !== undefined && patch.embeddingBase.trim() !== kb.embeddingBase);
  if (embeddingChanged) set.embeddingDim = null;

  db.update(knowledgeBases).set(set).where(eq(knowledgeBases.id, id)).run();

  if (embeddingChanged) {
    db.update(knowledgeChunks).set({ embedding: null }).where(eq(knowledgeChunks.kbId, id)).run();
    db.update(knowledgeDocs).set({ embeddedCount: 0 }).where(eq(knowledgeDocs.kbId, id)).run();
  }

  notifyKb(id);
  return { kb: kbToView(getKb(id)!), embeddingsReset: embeddingChanged };
}

export function deleteKb(id: number): void {
  db.delete(knowledgeChunks).where(eq(knowledgeChunks.kbId, id)).run();
  db.delete(knowledgeDocs).where(eq(knowledgeDocs.kbId, id)).run();
  db.delete(knowledgeBases).where(eq(knowledgeBases.id, id)).run();
  notifyKb(id);
}

// ---------------------------------------------------------------------------
// 切片：Markdown 感知
// ---------------------------------------------------------------------------

/**
 * 切分文本为分块：
 * 1) 按 Markdown 标题分节（标题跟内容走），代码围栏整体不拆；
 * 2) 节内按空行分段，贪心打包到 chunkSize；
 * 3) 单段超长（长文/代码）时按字符滑窗硬切，带 overlap 保证边界语义连续。
 */
export function splitIntoChunks(text: string, chunkSize = 800, overlap = 120): string[] {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!normalized) return [];
  const size = Math.max(200, chunkSize);
  const step = Math.max(1, size - Math.min(overlap, Math.floor(size / 2)));

  // 标题分节（代码围栏内的 # 不算标题）
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  for (const line of normalized.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence && /^#{1,6}\s+\S/.test(line) && current.length > 0) {
      blocks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length) blocks.push(current.join("\n"));

  const paragraphs: string[] = [];
  for (const block of blocks) {
    for (const p of block.split(/\n[ \t]*\n/)) {
      const seg = p.trim();
      if (seg) paragraphs.push(seg);
    }
  }

  const chunks: string[] = [];
  let buf = "";
  const flush = () => {
    const trimmed = buf.trim();
    if (trimmed) chunks.push(trimmed);
    buf = "";
  };
  for (const p of paragraphs) {
    if (p.length > size) {
      flush();
      const chars = Array.from(p);
      for (let i = 0; i < chars.length; i += step) {
        const piece = chars.slice(i, i + size).join("").trim();
        if (piece) chunks.push(piece);
        if (i + size >= chars.length) break;
      }
      continue;
    }
    if (buf && buf.length + p.length + 2 > size) flush();
    buf = buf ? `${buf}\n\n${p}` : p;
  }
  flush();
  return chunks;
}

// ---------------------------------------------------------------------------
// 分词与 BM25 索引（内存缓存，写路径统一失效）
// ---------------------------------------------------------------------------

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

type IndexedChunk = {
  id: number;
  tf: Map<string, number>;
  len: number;
};

type KbIndex = {
  chunks: IndexedChunk[];
  df: Map<string, number>;
  avgLen: number;
};

const indexCache = new Map<number, KbIndex>();

function buildIndex(kbId: number): KbIndex | null {
  const cached = indexCache.get(kbId);
  if (cached) return cached;

  const rows = db
    .select({ id: knowledgeChunks.id, content: knowledgeChunks.content })
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.kbId, kbId))
    .all();
  if (rows.length === 0) return null;

  const chunks: IndexedChunk[] = [];
  const df = new Map<string, number>();
  let totalLen = 0;
  for (const r of rows) {
    const tokens = tokenize(r.content);
    const tf = new Map<string, number>();
    for (const tk of tokens) tf.set(tk, (tf.get(tk) ?? 0) + 1);
    for (const tk of tf.keys()) df.set(tk, (df.get(tk) ?? 0) + 1);
    totalLen += tokens.length;
    chunks.push({ id: r.id, tf, len: tokens.length });
  }
  const index: KbIndex = { chunks, df, avgLen: totalLen / chunks.length };
  indexCache.set(kbId, index);
  return index;
}

/** BM25（k1=1.5 b=0.75），返回 chunkId → 得分，按得分降序截断。 */
function bm25Rank(index: KbIndex, query: string, limit: number): { id: number; score: number }[] {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  const qCounts = new Map<string, number>();
  for (const tk of qTokens) qCounts.set(tk, (qCounts.get(tk) ?? 0) + 1);

  const N = index.chunks.length;
  const k1 = 1.5;
  const b = 0.75;
  const scored: { id: number; score: number }[] = [];
  for (const c of index.chunks) {
    let score = 0;
    for (const [tk, qf] of qCounts) {
      const f = c.tf.get(tk);
      if (!f) continue;
      const n = index.df.get(tk) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((qf * f * (k1 + 1)) / (qf + k1 * (1 - b + b * (c.len / index.avgLen))));
    }
    if (score > 0) scored.push({ id: c.id, score });
  }
  scored.sort((a, b2) => b2.score - a.score);
  return scored.slice(0, limit);
}

// ---------------------------------------------------------------------------
// 向量：编解码 / 调用 / 余弦
// ---------------------------------------------------------------------------

type EmbeddingConfig = {
  embeddingModel: string;
  embeddingBase: string;
  embeddingApiKey: string;
  embeddingDim: number | null;
};

/** 解析嵌入请求的 base（不带 /v1）：显式配置 > 云服务商槽位 > 本地推理服务。 */
function resolveEmbeddingBase(cfg: Pick<EmbeddingConfig, "embeddingBase">): string {
  const trimBase = (v: string) => v.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  if (cfg.embeddingBase.trim()) return trimBase(cfg.embeddingBase);
  if (getSetting("SERVER_MODE") === "remote") return trimBase(getSetting("VLLM_API_BASE"));
  const host = getSetting("SERVER_HOST") || "127.0.0.1";
  return `http://${host}:${getActiveServerPort()}`;
}

function embeddingHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = apiKey.trim() || getSetting("VLLM_API_KEY");
  if (key && key !== "EMPTY") headers.Authorization = `Bearer ${key}`;
  return headers;
}

/** 调 OpenAI 兼容 /v1/embeddings，批大小 32，全部成功才返回。 */
async function callEmbeddings(cfg: EmbeddingConfig, texts: string[]): Promise<Float32Array[]> {
  const model = cfg.embeddingModel.trim();
  if (!model) throw new Error("未配置嵌入模型");
  const base = resolveEmbeddingBase(cfg);
  if (!base) throw new Error("未配置嵌入服务地址");

  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 32) {
    const batch = texts.slice(i, i + 32);
    const res = await fetch(`${base}/v1/embeddings`, {
      method: "POST",
      headers: embeddingHeaders(cfg.embeddingApiKey),
      body: JSON.stringify({ model, input: batch }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`嵌入请求失败（HTTP ${res.status}）${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as { data?: { embedding?: number[]; index?: number }[] };
    const data = json.data ?? [];
    if (data.length !== batch.length) throw new Error("嵌入服务返回数量与输入不一致");
    const ordered = new Map<number, number[]>();
    for (const d of data) {
      if (!Array.isArray(d.embedding)) throw new Error("嵌入服务返回格式异常");
      ordered.set(d.index ?? ordered.size, d.embedding);
    }
    for (let j = 0; j < batch.length; j++) {
      const vec = ordered.get(j);
      if (!vec) throw new Error("嵌入服务返回缺少向量");
      const arr = new Float32Array(vec);
      if (cfg.embeddingDim != null && arr.length !== cfg.embeddingDim) {
        throw new Error(`向量维度不一致（${arr.length} ≠ ${cfg.embeddingDim}），请检查嵌入模型`);
      }
      out.push(arr);
    }
  }
  return out;
}

function encodeEmbedding(vec: Float32Array): string {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString("base64");
}

function decodeEmbedding(b64: string): Float32Array {
  const buf = Buffer.from(b64, "base64");
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 测试嵌入配置可用性：嵌入 "ping" 并返回维度。 */
export async function testEmbedding(input: {
  base?: string;
  apiKey?: string;
  model: string;
}): Promise<{ ok: boolean; dim?: number; error?: string }> {
  try {
    const cfg: EmbeddingConfig = {
      embeddingModel: input.model,
      embeddingBase: input.base ?? "",
      embeddingApiKey: input.apiKey ?? "",
      embeddingDim: null,
    };
    const [vec] = await callEmbeddings(cfg, ["ping"]);
    return { ok: true, dim: vec?.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 嵌入模型候选：目标接口的 /v1/models + 已配置云厂商模型，合并去重。 */
export async function suggestEmbeddingModels(input?: {
  base?: string;
  apiKey?: string;
}): Promise<string[]> {
  const models = new Set<string>();
  try {
    const raw = getSetting("CLOUD_MODELS");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      for (const m of parsed) {
        const id =
          typeof m === "string"
            ? m
            : typeof m === "object" && m && "id" in m
              ? String((m as { id: unknown }).id)
              : "";
        if (id) models.add(id);
      }
    }
  } catch {}
  try {
    const base = resolveEmbeddingBase({ embeddingBase: input?.base ?? "" });
    const res = await fetch(`${base}/v1/models`, {
      headers: embeddingHeaders(input?.apiKey ?? ""),
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) {
      const json = (await res.json()) as { data?: { id?: string }[] };
      for (const m of json.data ?? []) {
        if (m.id) models.add(m.id);
      }
    }
  } catch {}
  return [...models].sort();
}

// ---------------------------------------------------------------------------
// 重排：Jina / SiliconFlow / Cohere 兼容的 /v1/rerank 二次排序
// ---------------------------------------------------------------------------

type RerankConfig = Pick<KnowledgeBaseRow, "rerankModel" | "rerankBase" | "rerankApiKey" | "embeddingBase">;

/** 重排服务 base：显式配置 > 嵌入服务地址（常见同厂商）> 云服务商槽位 / 本地推理。 */
function resolveRerankBase(cfg: RerankConfig): string {
  const trimBase = (v: string) => v.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  if (cfg.rerankBase.trim()) return trimBase(cfg.rerankBase);
  return resolveEmbeddingBase({ embeddingBase: cfg.embeddingBase });
}

/**
 * 调 /v1/rerank：query 对候选文档打相关性分。
 * 返回 chunkId → relevance_score（0-1）；服务端截断 top_n，未返回的候选视为被淘汰。
 */
async function callRerank(
  cfg: RerankConfig,
  query: string,
  docs: { id: number; text: string }[],
  topN: number,
): Promise<Map<number, number>> {
  const model = cfg.rerankModel.trim();
  if (!model) throw new Error("未配置重排模型");
  const base = resolveRerankBase(cfg);
  if (!base) throw new Error("未配置重排服务地址");

  const res = await fetch(`${base}/v1/rerank`, {
    method: "POST",
    headers: embeddingHeaders(cfg.rerankApiKey),
    body: JSON.stringify({
      model,
      query,
      documents: docs.map((d) => ({ id: d.id, text: d.text.slice(0, 2000) })),
      top_n: topN,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`重排请求失败（HTTP ${res.status}）${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    results?: { index?: number; relevance_score?: number; document?: { id?: unknown } }[];
  };
  const byTextIndex = new Map<number, number>();
  docs.forEach((d, i) => byTextIndex.set(i, d.id));

  const scores = new Map<number, number>();
  for (const r of json.results ?? []) {
    // 主流实现返回 index（documents 数组下标）；个别直接回带 id 的 document
    const id = typeof r.index === "number" ? byTextIndex.get(r.index) : Number(r.document?.id);
    const score = Number(r.relevance_score);
    if (id != null && Number.isFinite(id) && Number.isFinite(score)) {
      scores.set(id, Math.max(0, Math.min(1, score)));
    }
  }
  return scores;
}

/** 测试重排配置可用性（两个微型文档打分）。 */
export async function testRerank(input: {
  base?: string;
  apiKey?: string;
  model: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const cfg = {
      rerankModel: input.model,
      rerankBase: input.base ?? "",
      rerankApiKey: input.apiKey ?? "",
      embeddingBase: "",
    };
    const scores = await callRerank(
      cfg,
      "apple",
      [
        { id: 1, text: "An apple is a fruit." },
        { id: 2, text: "The stock market fell today." },
      ],
      2,
    );
    if (scores.size === 0) throw new Error("服务未返回打分结果");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 重排模型候选：优先名字带 rerank 的模型，没有则退回全量列表。 */
export async function suggestRerankModels(input?: {
  base?: string;
  apiKey?: string;
}): Promise<string[]> {
  const all = await suggestEmbeddingModels(input);
  const rerankOnly = all.filter((m) => /rerank/i.test(m));
  return rerankOnly.length > 0 ? rerankOnly : all;
}

// ---------------------------------------------------------------------------
// 数据源摄取
// ---------------------------------------------------------------------------

/** PDF/图片走 VLM OCR：优先 OCR 页配置的远程服务，其次全局（本地推理/云服务商）。 */
function ocrEndpoint(): ModelEndpoint {
  const ocrBase = (getSetting("OCR_PROVIDER_BASE") || "").trim();
  if (ocrBase) {
    return {
      base: ocrBase,
      apiKey: (getSetting("OCR_PROVIDER_API_KEY") || "").trim(),
      model: (getSetting("OCR_PROVIDER_MODEL") || "").trim() || undefined,
    };
  }
  if (getSetting("SERVER_MODE") === "remote") {
    return { base: getSetting("VLLM_API_BASE"), apiKey: getSetting("VLLM_API_KEY"), model: undefined };
  }
  return { base: `http://localhost:${getActiveServerPort()}/v1`, model: getLocalModelName() };
}

async function extractFileText(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  if (KB_TEXT_FILE_RE.test(ext)) {
    const file = Bun.file(filePath);
    if (file.size > KB_TEXT_MAX_BYTES) {
      throw new Error(`文件过大（${(file.size / 1024 / 1024).toFixed(1)}MB，上限 16MB）`);
    }
    return await file.text();
  }
  // PDF / 图片：复用文档管道的 VLM OCR（include 默认关，正文优先）
  const images = await convertFileToImages(Bun.file(filePath));
  if (images.length === 0) throw new Error("无法解析该文件");
  const endpoint = ocrEndpoint();
  const parts: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const results = await generate([images[i]!], {}, endpoint);
    const r = results[0]!;
    if (r.error) throw new Error(r.errorMessage ?? "OCR 识别失败");
    if (r.markdown.trim()) parts.push(r.markdown);
  }
  if (parts.length === 0) throw new Error("OCR 未识别出内容");
  return parts.join("\n\n");
}

async function extractWebText(url: string): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 OmniStudio/1.0",
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`网页请求失败（HTTP ${res.status}）`);
  const html = await res.text();
  const $ = cheerio.load(html);
  $("script, style, noscript, template, nav, footer, header, aside, iframe, svg, form").remove();
  const title = $("title").first().text().trim() || $("h1").first().text().trim();
  const main = $("article, main, [role='main']").first();
  const source = main.length > 0 ? main : $("body");
  const text = source
    .text()
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) throw new Error("网页未提取到正文");
  return title ? `# ${title}\n\n${text}` : text;
}

function webDocName(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return last ? `${u.hostname}/${decodeURIComponent(last).slice(0, 40)}` : u.hostname;
  } catch {
    return url.slice(0, 60);
  }
}

/** 文档行 → 视图（剔除笔记正文等大字段）。 */
function toDocView(row: KnowledgeDocRow): KbDocView {
  return {
    id: row.id,
    kbId: row.kbId,
    name: row.name,
    kind: row.kind,
    sourcePath: row.sourcePath,
    url: row.url,
    sizeBytes: row.sizeBytes,
    charCount: row.charCount,
    chunkCount: row.chunkCount,
    embeddedCount: row.embeddedCount,
    status: row.status,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function addFileDocs(kbId: number, paths: string[]): KbDocView[] {
  if (!getKb(kbId)) throw new Error("知识库不存在");
  const created: KbDocView[] = [];
  for (const p of paths) {
    if (!p || !existsSync(p)) continue;
    const size = Number(Bun.file(p).size) || null;
    const row = db
      .insert(knowledgeDocs)
      .values({
        kbId,
        name: path.basename(p),
        kind: "file",
        sourcePath: p,
        sizeBytes: size,
        status: "pending",
      })
      .returning()
      .get();
    created.push(toDocView(row));
    void ingestDoc(row.id);
  }
  notifyKb(kbId);
  return created;
}

/** 目录导入：递归收集白名单文件（跳过 node_modules/.git 等与隐藏目录），批量入库。 */
export function addFolderDocs(
  kbId: number,
  dirPath: string,
): { docs: KbDocView[]; skipped: number } {
  if (!getKb(kbId)) throw new Error("知识库不存在");
  if (!existsSync(dirPath)) throw new Error("目录不存在");

  const files: string[] = [];
  let skipped = 0;
  const walk = (dir: string, depth: number) => {
    if (files.length >= KB_FOLDER_MAX_FILES || depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= KB_FOLDER_MAX_FILES) {
        skipped++;
        continue;
      }
      if (entry.name.startsWith(".") || KB_FOLDER_IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        if (KB_FOLDER_FILE_RE.test(entry.name)) files.push(full);
        else skipped++;
      }
    }
  };
  walk(dirPath, 0);

  if (files.length === 0) {
    throw new Error("目录里没有可导入的文件（支持文本 / Markdown / PDF / 图片）");
  }
  const docs = addFileDocs(kbId, files);
  return { docs, skipped };
}

export function addNoteDoc(kbId: number, title: string, content: string): KbDocView {
  if (!getKb(kbId)) throw new Error("知识库不存在");
  if (!content.trim()) throw new Error("笔记内容为空");
  const row = db
    .insert(knowledgeDocs)
    .values({
      kbId,
      name: title.trim() || `笔记 ${new Date().toLocaleString("zh-CN")}`,
      kind: "note",
      content,
      charCount: content.length,
      status: "pending",
    })
    .returning()
    .get();
  notifyKb(kbId);
  void ingestDoc(row.id);
  return toDocView(row);
}

export function addWebDoc(kbId: number, url: string): KbDocView {
  if (!getKb(kbId)) throw new Error("知识库不存在");
  const clean = url.trim();
  if (!/^https?:\/\//i.test(clean)) throw new Error("请输入 http(s) 网页地址");
  const row = db
    .insert(knowledgeDocs)
    .values({ kbId, name: webDocName(clean), kind: "web", url: clean, status: "pending" })
    .returning()
    .get();
  notifyKb(kbId);
  void ingestDoc(row.id);
  return toDocView(row);
}

export function reingestDoc(id: number): void {
  void ingestDoc(id);
}

export function deleteDoc(id: number): void {
  const doc = db.select().from(knowledgeDocs).where(eq(knowledgeDocs.id, id)).get();
  if (!doc) return;
  db.delete(knowledgeChunks).where(eq(knowledgeChunks.docId, id)).run();
  db.delete(knowledgeDocs).where(eq(knowledgeDocs.id, id)).run();
  notifyKb(doc.kbId, id);
}

export function listDocs(kbId: number): KbDocView[] {
  return db
    .select()
    .from(knowledgeDocs)
    .where(eq(knowledgeDocs.kbId, kbId))
    .orderBy(desc(knowledgeDocs.updatedAt))
    .all()
    .map(toDocView);
}

export function listChunks(docId: number): KbChunkView[] {
  return db
    .select({
      id: knowledgeChunks.id,
      seq: knowledgeChunks.seq,
      charCount: knowledgeChunks.charCount,
      embedding: knowledgeChunks.embedding,
      content: knowledgeChunks.content,
    })
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.docId, docId))
    .all()
    .map((r) => ({
      id: r.id,
      seq: r.seq,
      charCount: r.charCount,
      embedded: r.embedding != null,
      content: r.content,
    }));
}

/**
 * 单文档摄取管道：parsing（提取正文）→ chunking（切片落库）→
 * embedding（有嵌入配置才走，逐批更新进度）→ ready。失败写 error。
 */
async function ingestDoc(id: number): Promise<void> {
  const doc = db.select().from(knowledgeDocs).where(eq(knowledgeDocs.id, id)).get();
  if (!doc) return;
  const kb = getKb(doc.kbId);
  if (!kb) return;

  const setStatus = (status: KbDocView["status"], extra: Record<string, unknown> = {}) => {
    db.update(knowledgeDocs)
      .set({ status, error: null, ...extra })
      .where(eq(knowledgeDocs.id, id))
      .run();
    notifyKb(doc.kbId, id);
  };

  try {
    setStatus("parsing");
    let text: string;
    if (doc.kind === "note") {
      text = doc.content ?? "";
    } else if (doc.kind === "web") {
      text = await extractWebText(doc.url ?? "");
    } else {
      if (!doc.sourcePath || !existsSync(doc.sourcePath)) {
        throw new Error("源文件不存在（可能已被移动或删除）");
      }
      text = await extractFileText(doc.sourcePath);
    }
    if (!text.trim()) throw new Error("未提取到正文内容");

    setStatus("chunking", { charCount: text.length });
    const chunks = splitIntoChunks(text, kb.chunkSize, kb.chunkOverlap);
    if (chunks.length === 0) throw new Error("切片结果为空");

    db.delete(knowledgeChunks).where(eq(knowledgeChunks.docId, id)).run();
    const rows = chunks.map((content, i) => ({
      kbId: doc.kbId,
      docId: id,
      seq: i + 1,
      content,
      charCount: content.length,
    }));
    for (const row of rows) db.insert(knowledgeChunks).values(row).run();
    notifyKb(doc.kbId, id);

    const cfg: EmbeddingConfig = {
      embeddingModel: kb.embeddingModel,
      embeddingBase: kb.embeddingBase,
      embeddingApiKey: kb.embeddingApiKey,
      embeddingDim: kb.embeddingDim,
    };

    if (!cfg.embeddingModel) {
      db.update(knowledgeDocs)
        .set({ status: "ready", chunkCount: rows.length, embeddedCount: 0, error: null })
        .where(eq(knowledgeDocs.id, id))
        .run();
      notifyKb(doc.kbId, id);
      return;
    }

    setStatus("embedding", { chunkCount: rows.length, embeddedCount: 0 });
    await embedDocChunks(kb, doc.kbId, id, cfg);
    db.update(knowledgeDocs)
      .set({ status: "ready", error: null })
      .where(eq(knowledgeDocs.id, id))
      .run();
    notifyKb(doc.kbId, id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    db.update(knowledgeDocs)
      .set({ status: "failed", error: msg })
      .where(eq(knowledgeDocs.id, id))
      .run();
    notifyKb(doc.kbId, id);
  }
}

/** 把一个文档内未向量化的分块补齐向量（摄取与手动补齐共用），逐批更新进度。 */
async function embedDocChunks(
  kb: KnowledgeBaseRow,
  kbId: number,
  docId: number,
  cfgIn: EmbeddingConfig,
): Promise<number> {
  // 摄取过程中 kb.embeddingDim 可能被本函数写入，取最新行避免后续批次校验用旧值
  const cfg: EmbeddingConfig = { ...cfgIn };
  let embedded = 0;
  while (true) {
    const batch = db
      .select({ id: knowledgeChunks.id, content: knowledgeChunks.content })
      .from(knowledgeChunks)
      .where(and(eq(knowledgeChunks.docId, docId), isNull(knowledgeChunks.embedding)))
      .limit(32)
      .all();
    if (batch.length === 0) break;

    const vectors = await callEmbeddings(cfg, batch.map((b) => b.content));
    for (let i = 0; i < batch.length; i++) {
      db.update(knowledgeChunks)
        .set({ embedding: encodeEmbedding(vectors[i]!) })
        .where(eq(knowledgeChunks.id, batch[i]!.id))
        .run();
    }
    embedded += batch.length;
    const doc = db
      .select({ embeddedCount: knowledgeDocs.embeddedCount })
      .from(knowledgeDocs)
      .where(eq(knowledgeDocs.id, docId))
      .get();
    db.update(knowledgeDocs)
      .set({ embeddedCount: Math.max(doc?.embeddedCount ?? 0, embedded) })
      .where(eq(knowledgeDocs.id, docId))
      .run();
    notifyKb(kbId, docId);

    // 首批成功后记录维度（后续批次据此校验）
    if (kb.embeddingDim == null) {
      const dim = vectors[0]!.length;
      db.update(knowledgeBases).set({ embeddingDim: dim }).where(eq(knowledgeBases.id, kbId)).run();
      kb.embeddingDim = dim;
      cfg.embeddingDim = dim;
    }
  }
  return embedded;
}

/** 手动补齐整个知识库缺失的向量（设置页「重新向量化」）。 */
export async function embedMissing(kbId: number): Promise<{
  ok: boolean;
  embedded?: number;
  error?: string;
}> {
  const kb = getKb(kbId);
  if (!kb) return { ok: false, error: "知识库不存在" };
  if (!kb.embeddingModel) return { ok: false, error: "未配置嵌入模型" };

  const cfg: EmbeddingConfig = {
    embeddingModel: kb.embeddingModel,
    embeddingBase: kb.embeddingBase,
    embeddingApiKey: kb.embeddingApiKey,
    embeddingDim: kb.embeddingDim,
  };

  const docIds = [
    ...new Set(
      db
        .select({ docId: knowledgeChunks.docId })
        .from(knowledgeChunks)
        .where(and(eq(knowledgeChunks.kbId, kbId), isNull(knowledgeChunks.embedding)))
        .all()
        .map((r) => r.docId),
    ),
  ];

  let embedded = 0;
  try {
    for (const docId of docIds) {
      const fresh = getKb(kbId)!;
      embedded += await embedDocChunks(fresh, kbId, docId, {
        ...cfg,
        embeddingDim: fresh.embeddingDim,
      });
    }
    notifyKb(kbId);
    return { ok: true, embedded };
  } catch (e) {
    return { ok: false, embedded, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// 混合检索：BM25 + 向量余弦 → RRF 融合
// ---------------------------------------------------------------------------

const RRF_K = 60;
const CANDIDATE_POOL = 50;
/** 配置了重排时，RRF 先取这么多候选交给重排模型打分，再截 topK。 */
const RERANK_POOL = 24;

/** 单库检索：关键词与向量各自排前 CANDIDATE_POOL 条，RRF 融合；
 *  配置重排模型时取前 RERANK_POOL 条二次打分后截 topK，重排失败退回 RRF 序。
 *  无嵌入配置/无向量/查询嵌入失败时自动退化为纯关键词。 */
async function recallKb(
  kb: KnowledgeBaseRow,
  query: string,
  docNames: Map<number, string>,
): Promise<{ hits: KbHit[]; notes: string[] }> {
  const notes: string[] = [];
  const index = buildIndex(kb.id);
  if (!index) return { hits: [], notes };

  const keywordRank = bm25Rank(index, query, CANDIDATE_POOL);
  let vectorRank: { id: number; score: number }[] = [];

  if (kb.embeddingModel) {
    const hasVectors =
      db
        .select({ id: knowledgeChunks.id })
        .from(knowledgeChunks)
        .where(and(eq(knowledgeChunks.kbId, kb.id), isNotNull(knowledgeChunks.embedding)))
        .limit(1)
        .all()
        .length > 0;
    if (hasVectors) {
      try {
        const cfg: EmbeddingConfig = {
          embeddingModel: kb.embeddingModel,
          embeddingBase: kb.embeddingBase,
          embeddingApiKey: kb.embeddingApiKey,
          embeddingDim: kb.embeddingDim,
        };
        const [queryVec] = await callEmbeddings(cfg, [query]);
        if (queryVec) {
          const candidates = db
            .select({ id: knowledgeChunks.id, embedding: knowledgeChunks.embedding })
            .from(knowledgeChunks)
            .where(and(eq(knowledgeChunks.kbId, kb.id), isNotNull(knowledgeChunks.embedding)))
            .all();
          const scored = candidates.map((c) => ({
            id: c.id,
            score: cosine(queryVec, decodeEmbedding(c.embedding!)),
          }));
          scored.sort((a, b) => b.score - a.score);
          vectorRank = scored.slice(0, CANDIDATE_POOL);
        }
      } catch (e) {
        notes.push(`向量检索失败（${e instanceof Error ? e.message : String(e)}），已退化为关键词检索`);
      }
    }
  }

  // RRF 融合两路排序
  const fused = new Map<number, { rrf: number; kw: number | null; vec: number | null }>();
  keywordRank.forEach((r, i) => {
    const cur = fused.get(r.id) ?? { rrf: 0, kw: null, vec: null };
    cur.rrf += 1 / (RRF_K + i + 1);
    cur.kw = r.score;
    fused.set(r.id, cur);
  });
  vectorRank.forEach((r, i) => {
    const cur = fused.get(r.id) ?? { rrf: 0, kw: null, vec: null };
    cur.rrf += 1 / (RRF_K + i + 1);
    cur.vec = r.score;
    fused.set(r.id, cur);
  });

  const pool = kb.rerankModel ? Math.min(RERANK_POOL, kb.topK * 3) : kb.topK;
  const ordered = [...fused.entries()].sort((a, b) => b[1].rrf - a[1].rrf).slice(0, Math.max(pool, kb.topK));
  if (ordered.length === 0) return { hits: [], notes };

  const metas = db
    .select({
      id: knowledgeChunks.id,
      docId: knowledgeChunks.docId,
      seq: knowledgeChunks.seq,
      content: knowledgeChunks.content,
      charCount: knowledgeChunks.charCount,
    })
    .from(knowledgeChunks)
    .where(inArray(knowledgeChunks.id, ordered.map(([id]) => id)))
    .all();
  const metaMap = new Map(metas.map((m) => [m.id, m]));
  const maxRrf = ordered[0]![1].rrf || 1;

  // 重排：RRF 候选交给重排模型打分，返回序为准；失败/未配置沿用 RRF 序
  let finalOrder = ordered;
  let rerankScores = new Map<number, number>();
  if (kb.rerankModel && ordered.length > 1) {
    try {
      const scores = await callRerank(
        kb,
        query,
        ordered.map(([id]) => ({ id, text: metaMap.get(id)?.content ?? "" })),
        kb.topK,
      );
      if (scores.size > 0) {
        rerankScores = scores;
        finalOrder = ordered
          .filter(([id]) => scores.has(id))
          .sort((a, b) => (scores.get(b[0]) ?? 0) - (scores.get(a[0]) ?? 0));
      } else {
        notes.push("重排服务未返回有效结果，已沿用融合排序");
      }
    } catch (e) {
      notes.push(`重排失败（${e instanceof Error ? e.message : String(e)}），已沿用融合排序`);
    }
  }

  const hits: KbHit[] = [];
  for (const [id, s] of finalOrder.slice(0, kb.topK)) {
    const meta = metaMap.get(id);
    if (!meta) continue;
    const rerankScore = rerankScores.get(id);
    hits.push({
      kbId: kb.id,
      kbName: kb.name,
      docId: meta.docId,
      docName: docNames.get(meta.docId) ?? `#${meta.docId}`,
      chunkId: id,
      seq: meta.seq,
      content: meta.content,
      charCount: meta.charCount,
      score:
        rerankScore != null
          ? Math.round(rerankScore * 1000) / 1000
          : Math.round((s.rrf / maxRrf) * 1000) / 1000,
      method: s.kw != null && s.vec != null ? "both" : s.vec != null ? "vector" : "keyword",
      keywordScore: s.kw,
      vectorScore: s.vec,
      reranked: rerankScore != null,
      rerankScore: rerankScore ?? null,
    });
  }
  return { hits, notes };
}

/** 多库检索 + 合并截断（聊天注入与召回测试共用入口）。 */
export async function recall(
  kbIds: number[],
  query: string,
  topK?: number,
): Promise<{ hits: KbHit[]; notes: string[] }> {
  const q = query.trim();
  if (!q || kbIds.length === 0) return { hits: [], notes: [] };
  const kbs = db
    .select()
    .from(knowledgeBases)
    .where(inArray(knowledgeBases.id, kbIds))
    .all();
  if (kbs.length === 0) return { hits: [], notes: [] };

  const docRows = db
    .select({ id: knowledgeDocs.id, name: knowledgeDocs.name })
    .from(knowledgeDocs)
    .where(inArray(knowledgeDocs.kbId, kbIds))
    .all();
  const docNames = new Map(docRows.map((d) => [d.id, d.name]));

  const notes: string[] = [];
  const all: KbHit[] = [];
  for (const kb of kbs) {
    const { hits, notes: kbNotes } = await recallKb(kb, q, docNames);
    for (const n of kbNotes) notes.push(`${kb.name}：${n}`);
    all.push(...hits);
  }
  all.sort((a, b) => b.score - a.score);
  const limit = topK ?? Math.max(...kbs.map((k) => k.topK));
  return { hits: all.slice(0, limit), notes };
}

// ---------------------------------------------------------------------------
// 聊天上下文构建
// ---------------------------------------------------------------------------

/** 检索结果组装为 system 注入文本 + 引用列表（编号与正文 [n] 对应）。 */
export async function buildChatContext(
  kbIds: number[],
  query: string,
): Promise<{ system: string | null; citations: KbCitation[]; notes: string[] }> {
  const { hits, notes } = await recall(kbIds, query);
  if (hits.length === 0) return { system: null, citations: [], notes };

  const citations: KbCitation[] = hits.map((h, i) => ({
    n: i + 1,
    kbId: h.kbId,
    kbName: h.kbName,
    docId: h.docId,
    docName: h.docName,
    seq: h.seq,
    snippet: h.content.replace(/\s+/g, " ").slice(0, 120),
  }));
  const body = hits
    .map((h, i) => `[${i + 1}] 来源：${h.docName}（分块 ${h.seq}）\n${h.content}`)
    .join("\n\n");
  const system =
    "已从用户选择的知识库检索到以下参考资料（按与最新提问的相关度排序）。回答要求：\n" +
    "- 优先依据资料内容回答；资料未覆盖的部分可用你已有的知识，并说明非来自资料\n" +
    "- 引用资料时在对应句末标注编号，如 [1]、[2][4]\n" +
    "- 与问题无关的资料不要强行引用\n\n" +
    body;
  return { system, citations, notes };
}
