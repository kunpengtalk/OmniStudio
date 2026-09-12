/**
 * 知识库（本地 RAG）核心模块：
 * - 数据源摄取：本地文件（文本直读 / PDF·图片走 VLM OCR）/ 手写笔记 / 网页抓取，
 *   由 kb-ingest 的持久化作业队列驱动（重试 / 断点续跑 / 并发受控）；
 * - Markdown 感知切片 + 溯源（标题路径、字符偏移），见 kb-chunk；
 * - 检索：倒排索引 BM25 与常驻向量余弦各自排序后 RRF 融合，可选重排与邻块合并，
 *   见 kb-index；
 * - 治理：写入/删除/配置/检索全部落 kb_events 审计流水，支持整库导出与导入。
 * 不依赖外部向量库 / FTS 扩展，纯 JS 即可；规模与内存占用见 kb-index 的 LRU 约定。
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "fs";
import path from "path";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "./db";
import { kbIngestJobs, knowledgeBases, knowledgeChunks, knowledgeDocs } from "./db/schema";
import type { KnowledgeBaseRow, KnowledgeDocRow } from "./db/schema";
import { callEmbeddings, embeddingHeaders, resolveEmbeddingBase, type EmbeddingConfig } from "./embeddings";
import { getKbIndex, invalidateKbIndex, kbIndexStats, peekKbIndex, type KbSearchIndex } from "./kb-index";
import {
  awaitKbIdle,
  docJobs,
  dropDocJob,
  enqueueDoc,
  ingestQueueStats,
  onKbDataChanged,
  recoverIngestJobs,
  retryDoc as enqueueRetry,
} from "./kb-ingest";
import { kbEventCounts, listKbEvents, pruneKbEvents, recordKbEvent, type KbEventAction } from "./kb-events";
import { splitIntoChunks, splitIntoChunksWithMeta } from "./kb-chunk";
import { tokenJaccard, tokenSet, tokenize } from "./text-search";
import { getDataDir } from "./paths";
import { getSetting } from "./db/settings";
import type {
  KbCitation,
  KbDocKind,
  KbEventEntry,
  KbHit,
  KbIndexStats,
  KbIngestJobView,
} from "../shared/knowledge";

export { splitIntoChunks, splitIntoChunksWithMeta, tokenize };

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
  minScore: number;
  expandNeighbors: boolean;
  mcpExposed: boolean;
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
  /** 内容指纹：源文件没变时不会重复重建索引。 */
  contentHash: string | null;
  indexedAt: number | null;
  createdAt: number | null;
  updatedAt: number | null;
  /** 摄取队列里的状态（排队中 / 第几次重试 / 下次重试时间）。 */
  job: KbIngestJobView | null;
};

export type KbChunkView = {
  id: number;
  seq: number;
  charCount: number;
  embedded: boolean;
  content: string;
  headingPath: string | null;
  /** 在来源正文中的字符偏移（引用可精确回位）。 */
  charStart: number | null;
  charEnd: number | null;
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
  minScore: number;
  expandNeighbors: boolean;
  mcpExposed: boolean;
}>;

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

// ---------------------------------------------------------------------------
// 变化广播：摄取层的变化（进度/切片完成）统一转成 webview 事件
// ---------------------------------------------------------------------------

type KnowledgeChangePayload = { kbId?: number; docId?: number };
type KnowledgeChangeListener = (payload: KnowledgeChangePayload) => void;
const changeListeners = new Set<KnowledgeChangeListener>();

export function onKnowledgeChanged(cb: KnowledgeChangeListener): () => void {
  changeListeners.add(cb);
  return () => {
    changeListeners.delete(cb);
  };
}

function notifyKb(kbId: number, docId?: number) {
  for (const cb of changeListeners) {
    try {
      cb({ kbId, docId });
    } catch {}
  }
}

onKbDataChanged((payload) => notifyKb(payload.kbId, payload.docId));

function clampInt(value: number, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clamp01(value: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/** 库级统计：两条聚合查询搞定，不随文档数展开成相关子查询。 */
function kbAgg(kbId: number): { docCount: number; chunkCount: number; embeddedCount: number } {
  const docs = db
    .select({ c: sql<number>`count(*)` })
    .from(knowledgeDocs)
    .where(eq(knowledgeDocs.kbId, kbId))
    .get();
  const chunks = db
    .select({
      total: sql<number>`count(*)`,
      embedded: sql<number>`count(${knowledgeChunks.embedding})`,
    })
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.kbId, kbId))
    .get();
  return {
    docCount: Number(docs?.c ?? 0),
    chunkCount: Number(chunks?.total ?? 0),
    embeddedCount: Number(chunks?.embedded ?? 0),
  };
}

function kbToView(row: KnowledgeBaseRow): KbView {
  return {
    ...row,
    expandNeighbors: row.expandNeighbors !== 0,
    mcpExposed: row.mcpExposed !== 0,
    ...kbAgg(row.id),
  };
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
  actor?: string;
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
  recordKbEvent({ kbId: row.id, action: "kb_created", detail: { name }, actor: input.actor });
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
  if (patch.minScore !== undefined) set.minScore = clamp01(patch.minScore, 0);
  if (patch.expandNeighbors !== undefined) set.expandNeighbors = patch.expandNeighbors ? 1 : 0;
  if (patch.mcpExposed !== undefined) set.mcpExposed = patch.mcpExposed ? 1 : 0;

  const embeddingChanged =
    (patch.embeddingModel !== undefined && patch.embeddingModel.trim() !== kb.embeddingModel) ||
    (patch.embeddingBase !== undefined && patch.embeddingBase.trim() !== kb.embeddingBase);
  if (embeddingChanged) set.embeddingDim = null;

  db.update(knowledgeBases).set(set).where(eq(knowledgeBases.id, id)).run();

  if (embeddingChanged) {
    db.update(knowledgeChunks).set({ embedding: null }).where(eq(knowledgeChunks.kbId, id)).run();
    db.update(knowledgeDocs).set({ embeddedCount: 0 }).where(eq(knowledgeDocs.kbId, id)).run();
    // 内存索引里还留着旧模型的向量，必须整块失效
    invalidateKbIndex(id);
  }

  recordKbEvent({
    kbId: id,
    action: "kb_config",
    detail: { fields: Object.keys(patch), embeddingsReset: embeddingChanged },
  });
  notifyKb(id);
  return { kb: kbToView(getKb(id)!), embeddingsReset: embeddingChanged };
}

export function deleteKb(id: number): void {
  const kb = getKb(id);
  db.delete(knowledgeChunks).where(eq(knowledgeChunks.kbId, id)).run();
  db.delete(knowledgeDocs).where(eq(knowledgeDocs.kbId, id)).run();
  db.delete(knowledgeBases).where(eq(knowledgeBases.id, id)).run();
  db.delete(kbIngestJobs).where(eq(kbIngestJobs.kbId, id)).run();
  invalidateKbIndex(id);
  recordKbEvent({ kbId: null, action: "kb_deleted", detail: { id, name: kb?.name ?? null } });
  notifyKb(id);
}

// ---------------------------------------------------------------------------
// 数据源
// ---------------------------------------------------------------------------

/** 文档行 → 视图（剔除笔记正文等大字段）。 */
function toDocView(row: KnowledgeDocRow, job: KbIngestJobView | null = null): KbDocView {
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
    contentHash: row.contentHash,
    indexedAt: row.indexedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    job,
  };
}

/**
 * 添加本地文件。同一个来源路径已在库中且大小/修改时间都没变时跳过，
 * 内容变了则就地重建索引（而不是堆出第二份同名文档）。
 */
export function addFileDocs(kbId: number, paths: string[]): KbDocView[] {
  if (!getKb(kbId)) throw new Error("知识库不存在");
  const created: KbDocView[] = [];
  const jobs = docJobs(kbId);
  for (const p of paths) {
    if (!p || !existsSync(p)) continue;
    const stat = statSync(p);
    const size = Number(stat.size) || null;
    const mtime = Math.floor(stat.mtimeMs);
    const existing = db
      .select()
      .from(knowledgeDocs)
      .where(and(eq(knowledgeDocs.kbId, kbId), eq(knowledgeDocs.sourcePath, p)))
      .get();
    if (existing && existing.sizeBytes === size && existing.sourceMtime === mtime && existing.status === "ready") {
      recordKbEvent({ kbId, docId: existing.id, action: "doc_skipped", detail: { name: existing.name, reason: "源文件未变化" } });
      continue;
    }
    if (existing) {
      db.update(knowledgeDocs)
        .set({ status: "pending", error: null, sizeBytes: size, sourceMtime: mtime })
        .where(eq(knowledgeDocs.id, existing.id))
        .run();
      recordKbEvent({ kbId, docId: existing.id, action: "doc_reingested", detail: { name: existing.name, reason: "源文件已变化" } });
      enqueueDoc(existing.id, { kind: "ingest", resetAttempts: true });
      created.push(toDocView({ ...existing, status: "pending", error: null, sizeBytes: size, sourceMtime: mtime }, jobs.get(existing.id) ?? null));
      continue;
    }
    const row = db
      .insert(knowledgeDocs)
      .values({
        kbId,
        name: path.basename(p),
        kind: "file",
        sourcePath: p,
        sizeBytes: size,
        sourceMtime: mtime,
        status: "pending",
      })
      .returning()
      .get();
    recordKbEvent({ kbId, docId: row.id, action: "doc_added", detail: { name: row.name, kind: "file", size } });
    created.push(toDocView(row));
    enqueueDoc(row.id, { kind: "ingest" });
  }
  notifyKb(kbId);
  return created;
}

/** 目录导入：递归收集白名单文件（跳过 node_modules/.git 等与隐藏目录），批量入库。 */
export function addFolderDocs(kbId: number, dirPath: string): { docs: KbDocView[]; skipped: number } {
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
  const before = files.length;
  const docs = addFileDocs(kbId, files);
  return { docs, skipped: skipped + (before - docs.length) };
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
  recordKbEvent({ kbId, docId: row.id, action: "doc_added", detail: { name: row.name, kind: "note", chars: content.length } });
  notifyKb(kbId);
  enqueueDoc(row.id, { kind: "ingest" });
  return toDocView(row);
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

export function addWebDoc(kbId: number, url: string): KbDocView {
  if (!getKb(kbId)) throw new Error("知识库不存在");
  const clean = url.trim();
  if (!/^https?:\/\//i.test(clean)) throw new Error("请输入 http(s) 网页地址");
  const row = db
    .insert(knowledgeDocs)
    .values({ kbId, name: webDocName(clean), kind: "web", url: clean, status: "pending" })
    .returning()
    .get();
  recordKbEvent({ kbId, docId: row.id, action: "doc_added", detail: { name: row.name, kind: "web", url: clean } });
  notifyKb(kbId);
  enqueueDoc(row.id, { kind: "ingest" });
  return toDocView(row);
}

/** 重新处理：默认强制重跑（用户点它就是要重建），失败计数清零。 */
export function reingestDoc(id: number, opts: { force?: boolean } = { force: true }): void {
  const row = db.select().from(knowledgeDocs).where(eq(knowledgeDocs.id, id)).get();
  if (!row) return;
  if (opts.force) {
    // 清掉内容指纹，让管道不因「内容未变」直接跳过
    db.update(knowledgeDocs).set({ contentHash: null, status: "pending", error: null }).where(eq(knowledgeDocs.id, id)).run();
  }
  recordKbEvent({ kbId: row.kbId, docId: id, action: "doc_reingested", detail: { name: row.name, force: !!opts.force } });
  enqueueDoc(id, { kind: "ingest", resetAttempts: true });
}

/** 失败文档重新入队（能续跑就续跑，不强制重建索引）。 */
export function retryDoc(id: number): void {
  const row = db.select().from(knowledgeDocs).where(eq(knowledgeDocs.id, id)).get();
  if (!row) return;
  recordKbEvent({ kbId: row.kbId, docId: id, action: "doc_reingested", detail: { name: row.name, retry: true } });
  enqueueRetry(id);
}

export function deleteDoc(id: number): void {
  const doc = db.select().from(knowledgeDocs).where(eq(knowledgeDocs.id, id)).get();
  if (!doc) return;
  db.delete(knowledgeChunks).where(eq(knowledgeChunks.docId, id)).run();
  db.delete(knowledgeDocs).where(eq(knowledgeDocs.id, id)).run();
  dropDocJob(id);
  peekKbIndex(doc.kbId)?.removeDoc(id);
  recordKbEvent({ kbId: doc.kbId, docId: id, action: "doc_deleted", detail: { name: doc.name } });
  notifyKb(doc.kbId, id);
}

export function listDocs(kbId: number): KbDocView[] {
  const jobs = docJobs(kbId);
  return db
    .select()
    .from(knowledgeDocs)
    .where(eq(knowledgeDocs.kbId, kbId))
    .orderBy(desc(knowledgeDocs.updatedAt))
    .all()
    .map((row) => toDocView(row, jobs.get(row.id) ?? null));
}

export function listChunks(docId: number): KbChunkView[] {
  return db
    .select({
      id: knowledgeChunks.id,
      seq: knowledgeChunks.seq,
      charCount: knowledgeChunks.charCount,
      embedding: knowledgeChunks.embedding,
      content: knowledgeChunks.content,
      headingPath: knowledgeChunks.headingPath,
      charStart: knowledgeChunks.charStart,
      charEnd: knowledgeChunks.charEnd,
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
      headingPath: r.headingPath,
      charStart: r.charStart,
      charEnd: r.charEnd,
    }));
}

// ---------------------------------------------------------------------------
// 向量化：补齐缺失向量（走同一个作业队列，避免与自动摄取并发抢同一文档）
// ---------------------------------------------------------------------------

export async function embedMissing(kbId: number): Promise<{
  ok: boolean;
  embedded?: number;
  error?: string;
}> {
  const kb = getKb(kbId);
  if (!kb) return { ok: false, error: "知识库不存在" };
  if (!kb.embeddingModel) return { ok: false, error: "未配置嵌入模型" };

  const missing = () =>
    Number(
      db
        .select({ c: sql<number>`count(*)` })
        .from(knowledgeChunks)
        .where(and(eq(knowledgeChunks.kbId, kbId), sql`${knowledgeChunks.embedding} is null`))
        .get()?.c ?? 0,
    );
  const before = missing();
  if (before === 0) return { ok: true, embedded: 0 };

  const docIds = [
    ...new Set(
      db
        .select({ docId: knowledgeChunks.docId })
        .from(knowledgeChunks)
        .where(and(eq(knowledgeChunks.kbId, kbId), sql`${knowledgeChunks.embedding} is null`))
        .all()
        .map((r) => r.docId),
    ),
  ];
  for (const docId of docIds) enqueueDoc(docId, { kind: "embed" });
  const drained = await awaitKbIdle(kbId, 300_000);
  const remaining = missing();
  if (drained && remaining > 0) {
    const failed = db
      .select({ error: knowledgeDocs.error, name: knowledgeDocs.name })
      .from(knowledgeDocs)
      .where(and(eq(knowledgeDocs.kbId, kbId), eq(knowledgeDocs.status, "failed")))
      .get();
    return { ok: false, embedded: before - remaining, error: failed?.error ?? "向量化未完成" };
  }
  invalidateKbIndex(kbId);
  notifyKb(kbId);
  return { ok: true, embedded: before - remaining };
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
// 混合检索：BM25 + 向量余弦 → RRF 融合 → 重排 → 邻块合并 → 去冗
// ---------------------------------------------------------------------------

const RRF_K = 60;
const CANDIDATE_POOL = 50;
/** 配置了重排时，RRF 先取这么多候选交给重排模型打分，再截 topK。 */
const RERANK_POOL = 24;
/** 邻块合并后单条命中的字符上限（相对 chunkSize 的倍数）。 */
const MERGE_BUDGET_FACTOR = 2;
/**
 * 去冗阈值：只在同一文档内、且 Jaccard ≥ 此值时才判定为重复。
 *
 * 门槛刻意定得很高（0.95）且限同文档：目标是「同一段话被相邻块各切了一半」，
 * 而不是「两段结构相似的文本」。模板占九成、只差一个序号的步骤条目（SOP / FAQ）
 * 相似度约 0.87，属于必须都留下的内容；跨文档的相似段落更是不同来源的佐证。
 */
const DEDUPE_JACCARD = 0.95;

type RankedHit = { id: number; score: number };

/** RRF 融合两路排序（关键词序 × 向量序），返回有序 chunkId 与各自原始分。 */
function fuseRrf(keywordRank: RankedHit[], vectorRank: RankedHit[]) {
  const fused = new Map<number, { rrf: number; kw: number | null; vec: number | null }>();
  const add = (rank: RankedHit[], field: "kw" | "vec") => {
    rank.forEach((r, i) => {
      const cur = fused.get(r.id) ?? { rrf: 0, kw: null, vec: null };
      cur.rrf += 1 / (RRF_K + i + 1);
      cur[field] = r.score;
      fused.set(r.id, cur);
    });
  };
  add(keywordRank, "kw");
  add(vectorRank, "vec");
  return fused;
}

/**
 * 相邻分块合并：检索粒度与送进上下文的粒度解耦（小块召回准、合并后上下文全）。
 * 同一文档里序号相邻的命中并成一条，正文按序号顺序拼接，总长受预算约束。
 */
function mergeNeighbors(hits: KbHit[], budgetChars: number): KbHit[] {
  type Group = { head: KbHit; parts: { seq: number; content: string; charStart?: number | null; charEnd?: number | null }[] };
  const groups: Group[] = [];
  for (const hit of hits) {
    const target = groups.find((g) => {
      if (g.head.docId !== hit.docId) return false;
      const seqs = g.parts.map((p) => p.seq);
      const adjacent = seqs.includes(hit.seq - 1) || seqs.includes(hit.seq + 1);
      const size = g.parts.reduce((s, p) => s + p.content.length, 0) + hit.content.length;
      return adjacent && size <= budgetChars;
    });
    if (target) {
      target.parts.push({ seq: hit.seq, content: hit.content, charStart: hit.charStart, charEnd: hit.charEnd });
    } else {
      groups.push({ head: hit, parts: [{ seq: hit.seq, content: hit.content, charStart: hit.charStart, charEnd: hit.charEnd }] });
    }
  }
  return groups.map((g) => {
    if (g.parts.length === 1) return g.head;
    const parts = [...g.parts].sort((a, b) => a.seq - b.seq);
    const starts = parts.map((p) => p.charStart).filter((v): v is number => typeof v === "number");
    const ends = parts.map((p) => p.charEnd).filter((v): v is number => typeof v === "number");
    return {
      ...g.head,
      content: parts.map((p) => p.content).join("\n\n"),
      charCount: parts.reduce((s, p) => s + p.content.length, 0),
      charStart: starts.length > 0 ? Math.min(...starts) : g.head.charStart,
      charEnd: ends.length > 0 ? Math.max(...ends) : g.head.charEnd,
      mergedSeqs: parts.map((p) => p.seq),
    };
  });
}

/** 文本去冗：保留第一条，丢弃同文档内近乎重复的命中。 */
function dedupeByOverlap(hits: KbHit[]): KbHit[] {
  const kept: KbHit[] = [];
  const seen: { docId: number; tokens: Set<string> }[] = [];
  for (const hit of hits) {
    const tokens = tokenSet(hit.content);
    if (seen.some((s) => s.docId === hit.docId && tokenJaccard(s.tokens, tokens) >= DEDUPE_JACCARD)) continue;
    kept.push(hit);
    seen.push({ docId: hit.docId, tokens });
  }
  return kept;
}

/**
 * 单库检索：关键词与向量各自排前 CANDIDATE_POOL 条，RRF 融合；
 * 配置重排模型时取前 RERANK_POOL 条二次打分后截 topK，重排失败退回 RRF 序。
 * 无嵌入配置/无向量/查询嵌入失败时自动退化为纯关键词。
 */
async function recallKb(
  kb: KnowledgeBaseRow,
  index: KbSearchIndex,
  docNames: Map<number, string>,
  query: string,
): Promise<{ hits: KbHit[]; notes: string[] }> {
  const notes: string[] = [];
  const keywordRank = index.bm25Rank(query, CANDIDATE_POOL);
  let vectorRank: RankedHit[] = [];

  if (kb.embeddingModel && index.vectorCount > 0) {
    try {
      const cfg: EmbeddingConfig = {
        embeddingModel: kb.embeddingModel,
        embeddingBase: kb.embeddingBase,
        embeddingApiKey: kb.embeddingApiKey,
        embeddingDim: kb.embeddingDim,
      };
      const [queryVec] = await callEmbeddings(cfg, [query]);
      if (queryVec) vectorRank = index.vectorRank(queryVec, CANDIDATE_POOL);
    } catch (e) {
      notes.push(`向量检索失败（${e instanceof Error ? e.message : String(e)}），已退化为关键词检索`);
    }
  }

  const fused = fuseRrf(keywordRank, vectorRank);
  const pool = kb.rerankModel ? Math.min(RERANK_POOL, kb.topK * 3) : kb.topK;
  const ordered = [...fused.entries()].sort((a, b) => b[1].rrf - a[1].rrf).slice(0, Math.max(pool, kb.topK));
  if (ordered.length === 0) return { hits: [], notes };

  // 候选池的正文一次取回：重排要拿它打分，最终命中也要拿它组装
  const metas = chunkRows(ordered.map(([id]) => id));
  const maxRrf = ordered[0]![1].rrf || 1;

  let finalOrder = ordered;
  let rerankScores = new Map<number, number>();
  let rerankApplied = false;
  if (kb.rerankModel && ordered.length > 1) {
    try {
      const scores = await callRerank(
        kb,
        query,
        ordered.map(([id]) => ({ id, text: metas.get(id)?.content ?? "" })),
        kb.topK,
      );
      if (scores.size > 0) {
        rerankScores = scores;
        rerankApplied = true;
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
  if (rerankApplied && finalOrder.length === 0) return { hits: [], notes };

  const ranked: KbHit[] = [];
  for (const [id, s] of finalOrder) {
    const meta = index.meta(id);
    const row = metas.get(id);
    if (!meta || !row) continue;
    const rerankScore = rerankScores.get(id);
    ranked.push({
      kbId: kb.id,
      kbName: kb.name,
      docId: meta.docId,
      docName: docNames.get(meta.docId) ?? `#${meta.docId}`,
      chunkId: id,
      seq: meta.seq,
      content: row.content,
      charCount: row.charCount,
      score: rerankScore != null ? Math.round(rerankScore * 1000) / 1000 : Math.round((s.rrf / maxRrf) * 1000) / 1000,
      method: s.kw != null && s.vec != null ? "both" : s.vec != null ? "vector" : "keyword",
      keywordScore: s.kw,
      vectorScore: s.vec,
      reranked: rerankScore != null,
      rerankScore: rerankScore ?? null,
      headingPath: row.headingPath,
      charStart: row.charStart,
      charEnd: row.charEnd,
    });
  }

  const merged = kb.expandNeighbors ? mergeNeighbors(ranked, kb.chunkSize * MERGE_BUDGET_FACTOR) : ranked;
  const deduped = dedupeByOverlap(merged);
  const thresholded = kb.minScore > 0 ? deduped.filter((h) => h.score >= kb.minScore) : deduped;
  return { hits: thresholded.slice(0, kb.topK), notes };
}

/** 按 chunkId 批量取正文与溯源字段。 */
function chunkRows(ids: number[]): Map<
  number,
  {
    content: string;
    charCount: number;
    headingPath: string | null;
    charStart: number | null;
    charEnd: number | null;
  }
> {
  if (ids.length === 0) return new Map();
  return new Map(
    db
      .select({
        id: knowledgeChunks.id,
        content: knowledgeChunks.content,
        charCount: knowledgeChunks.charCount,
        headingPath: knowledgeChunks.headingPath,
        charStart: knowledgeChunks.charStart,
        charEnd: knowledgeChunks.charEnd,
      })
      .from(knowledgeChunks)
      .where(inArray(knowledgeChunks.id, ids))
      .all()
      .map((r) => [
        r.id,
        { content: r.content, charCount: r.charCount, headingPath: r.headingPath, charStart: r.charStart, charEnd: r.charEnd },
      ]),
  );
}

/** 多库检索 + 合并截断（聊天注入与召回测试共用入口）。 */
export async function recall(
  kbIds: number[],
  query: string,
  topK?: number,
  opts: { actor?: string } = {},
): Promise<{ hits: KbHit[]; notes: string[] }> {
  const q = query.trim();
  if (!q || kbIds.length === 0) return { hits: [], notes: [] };
  const started = Date.now();
  const kbs = db
    .select()
    .from(knowledgeBases)
    .where(inArray(knowledgeBases.id, kbIds))
    .all();
  if (kbs.length === 0) return { hits: [], notes: [] };

  const notes: string[] = [];
  const all: KbHit[] = [];
  for (const kb of kbs) {
    const loaded = getKbIndex(kb.id);
    if (!loaded) continue;
    const { hits, notes: kbNotes } = await recallKb(kb, loaded.index, loaded.docNames, q);
    for (const n of kbNotes) notes.push(`${kb.name}：${n}`);
    all.push(...hits);
  }
  all.sort((a, b) => b.score - a.score);
  const limit = topK ?? Math.max(...kbs.map((k) => k.topK));
  const hits = all.slice(0, limit);
  recordKbEvent({
    kbId: kbs.length === 1 ? kbs[0]!.id : null,
    action: "recall",
    detail: { query: q.slice(0, 200), kbIds, hits: hits.length, ms: Date.now() - started },
    actor: opts.actor ?? "ui",
  });
  return { hits, notes };
}

// ---------------------------------------------------------------------------
// 聊天上下文构建
// ---------------------------------------------------------------------------

/** 检索结果组装为 system 注入文本 + 引用列表（编号与正文 [n] 对应）。 */
export async function buildChatContext(
  kbIds: number[],
  query: string,
  opts: { actor?: string } = {},
): Promise<{ system: string | null; citations: KbCitation[]; notes: string[] }> {
  const { hits, notes } = await recall(kbIds, query, undefined, opts);
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
    .map((h, i) => {
      const loc = h.headingPath ? `${h.docName} › ${h.headingPath}` : h.docName;
      return `[${i + 1}] 来源：${loc}（分块 ${h.seq}）\n${h.content}`;
    })
    .join("\n\n");
  const system =
    "已从用户选择的知识库检索到以下参考资料（按与最新提问的相关度排序）。回答要求：\n" +
    "- 优先依据资料内容回答；资料未覆盖的部分可用你已有的知识，并说明非来自资料\n" +
    "- 引用资料时在对应句末标注编号，如 [1]、[2][4]\n" +
    "- 与问题无关的资料不要强行引用\n\n" +
    body;
  return { system, citations, notes };
}

// ---------------------------------------------------------------------------
// 治理：审计查询 / 导出导入 / 维护
// ---------------------------------------------------------------------------

/** 审计流水（治理页与 CLI 共用）。 */
export function kbEvents(opts: { kbId?: number; limit?: number; action?: KbEventAction } = {}): KbEventEntry[] {
  return listKbEvents(opts);
}

export function kbAuditSummary(kbId?: number): Record<string, number> {
  return kbEventCounts(kbId);
}

export function kbQueueStats(): { queued: number; running: number; failed: number } {
  return ingestQueueStats();
}

export function kbIndexStatsAll(): KbIndexStats[] {
  return kbIndexStats();
}

/** 导出载荷版本：字段演进时按 version 决定兼容策略。 */
export const KB_EXPORT_FORMAT = "omnistudio.kb";
export const KB_EXPORT_VERSION = 1;

export type KbExportPayload = {
  format: string;
  version: number;
  exportedAt: number;
  kb: {
    name: string;
    description: string | null;
    embeddingModel: string;
    embeddingBase: string;
    embeddingDim: number | null;
    rerankModel: string;
    chunkSize: number;
    chunkOverlap: number;
    topK: number;
    minScore: number;
    expandNeighbors: boolean;
  };
  docs: {
    name: string;
    kind: KbDocKind;
    sourcePath: string | null;
    url: string | null;
    content: string | null;
    sizeBytes: number | null;
    charCount: number | null;
    contentHash: string | null;
  }[];
  chunks: {
    /** docs 数组下标。 */
    doc: number;
    seq: number;
    content: string;
    charCount: number;
    headingPath: string | null;
    charStart: number | null;
    charEnd: number | null;
    contentHash: string | null;
    /** 向量（Float32 base64），includeEmbeddings 时才有。 */
    embedding?: string;
  }[];
};

/**
 * 整库导出：元数据 + 文档 + 分块（可选向量）。
 * 带向量导出 ≈ 一份可直接迁移/归档的库；不带向量则体积小，导入后重新向量化。
 */
export function exportKb(kbId: number, opts: { includeEmbeddings?: boolean } = {}): {
  payload: KbExportPayload;
  json: string;
} {
  const kb = getKb(kbId);
  if (!kb) throw new Error("知识库不存在");
  const docs = db.select().from(knowledgeDocs).where(eq(knowledgeDocs.kbId, kbId)).orderBy(knowledgeDocs.id).all();
  const docIndex = new Map(docs.map((d, i) => [d.id, i]));
  const chunks = db
    .select()
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.kbId, kbId))
    .orderBy(knowledgeChunks.docId, knowledgeChunks.seq)
    .all();

  const payload: KbExportPayload = {
    format: KB_EXPORT_FORMAT,
    version: KB_EXPORT_VERSION,
    exportedAt: Date.now(),
    kb: {
      name: kb.name,
      description: kb.description,
      embeddingModel: kb.embeddingModel,
      embeddingBase: kb.embeddingBase,
      embeddingDim: kb.embeddingDim,
      rerankModel: kb.rerankModel,
      chunkSize: kb.chunkSize,
      chunkOverlap: kb.chunkOverlap,
      topK: kb.topK,
      minScore: kb.minScore,
      expandNeighbors: kb.expandNeighbors !== 0,
    },
    docs: docs.map((d) => ({
      name: d.name,
      kind: d.kind,
      sourcePath: d.sourcePath,
      url: d.url,
      content: d.content,
      sizeBytes: d.sizeBytes,
      charCount: d.charCount,
      contentHash: d.contentHash,
    })),
    chunks: chunks.map((c) => ({
      doc: docIndex.get(c.docId) ?? 0,
      seq: c.seq,
      content: c.content,
      charCount: c.charCount,
      headingPath: c.headingPath,
      charStart: c.charStart,
      charEnd: c.charEnd,
      contentHash: c.contentHash,
      ...(opts.includeEmbeddings && c.embedding ? { embedding: c.embedding } : {}),
    })),
  };
  recordKbEvent({
    kbId,
    action: "export",
    detail: { docs: docs.length, chunks: chunks.length, withEmbeddings: !!opts.includeEmbeddings },
  });
  return { payload, json: JSON.stringify(payload) };
}

/** 导出目录（数据目录下，避免任意路径写入）。 */
export function kbExportDir(): string {
  const dir = path.join(getDataDir(), "kb-exports");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** 导出到数据目录下的 kb-exports/（不写用户指定路径，避免任意路径写入）。 */
export function exportKbToFile(kbId: number, opts: { includeEmbeddings?: boolean } = {}): {
  path: string;
  bytes: number;
  docs: number;
  chunks: number;
} {
  const { payload, json } = exportKb(kbId, opts);
  const dir = kbExportDir();
  const slug = payload.kb.name.replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 40) || "kb";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${slug}-${stamp}.json`);
  writeFileSync(file, json, "utf8");
  return { path: file, bytes: Buffer.byteLength(json), docs: payload.docs.length, chunks: payload.chunks.length };
}

/** 导入：始终新建一个库（不覆盖既有数据），带向量时直接复用，不带则排队重新向量化。 */
export function importKb(payload: unknown, opts: { name?: string } = {}): {
  kb: KbView;
  docs: number;
  chunks: number;
  embedded: number;
} {
  const data = payload as Partial<KbExportPayload> | null;
  if (!data || typeof data !== "object" || data.format !== KB_EXPORT_FORMAT) {
    throw new Error("不是 OmniStudio 知识库导出文件");
  }
  if (typeof data.version !== "number" || data.version > KB_EXPORT_VERSION) {
    throw new Error(`导出文件版本过新（${String(data.version)}），请先升级应用`);
  }
  if (!Array.isArray(data.docs) || !Array.isArray(data.chunks)) throw new Error("导出文件缺少文档或分块");

  const src = data.kb ?? ({} as KbExportPayload["kb"]);
  const kb = createKb({
    name: opts.name?.trim() || `${src.name ?? "导入的知识库"}（导入）`,
    description: src.description ?? undefined,
    actor: "import",
  });
  const kbId = kb.id;
  db.update(knowledgeBases)
    .set({
      embeddingModel: src.embeddingModel ?? "",
      embeddingBase: src.embeddingBase ?? "",
      embeddingDim: src.embeddingDim ?? null,
      rerankModel: src.rerankModel ?? "",
      chunkSize: src.chunkSize ?? 800,
      chunkOverlap: src.chunkOverlap ?? 120,
      topK: src.topK ?? 6,
      minScore: src.minScore ?? 0,
      expandNeighbors: src.expandNeighbors === false ? 0 : 1,
    })
    .where(eq(knowledgeBases.id, kbId))
    .run();

  const docIds: number[] = [];
  let embedded = 0;
  for (const doc of data.docs) {
    const row = db
      .insert(knowledgeDocs)
      .values({
        kbId,
        name: String(doc?.name ?? "未命名"),
        kind: (doc?.kind ?? "note") as KbDocKind,
        sourcePath: doc?.sourcePath ?? null,
        url: doc?.url ?? null,
        content: doc?.content ?? null,
        sizeBytes: doc?.sizeBytes ?? null,
        charCount: doc?.charCount ?? null,
        contentHash: doc?.contentHash ?? null,
        status: "pending",
      })
      .returning()
      .get();
    docIds.push(row.id);
  }

  const byDoc = new Map<number, KbExportPayload["chunks"]>();
  for (const chunk of data.chunks) {
    const docId = docIds[chunk?.doc ?? -1];
    if (docId == null) continue;
    const list = byDoc.get(docId) ?? [];
    list.push(chunk);
    byDoc.set(docId, list);
  }

  for (const [docId, list] of byDoc) {
    const rows = list
      .filter((c) => typeof c?.content === "string")
      .sort((a, b) => a.seq - b.seq)
      .map((c, i) => ({
        kbId,
        docId,
        seq: i + 1,
        content: c.content,
        charCount: c.charCount ?? c.content.length,
        headingPath: c.headingPath ?? null,
        charStart: c.charStart ?? null,
        charEnd: c.charEnd ?? null,
        contentHash: c.contentHash ?? null,
        embedding: typeof c.embedding === "string" ? c.embedding : null,
      }));
    if (rows.length === 0) continue;
    db.transaction((tx) => {
      for (const row of rows) tx.insert(knowledgeChunks).values(row).run();
    });
    const withVector = rows.filter((r) => r.embedding).length;
    embedded += withVector;
    db.update(knowledgeDocs)
      .set({ chunkCount: rows.length, embeddedCount: withVector, status: "ready", indexedAt: Date.now() })
      .where(eq(knowledgeDocs.id, docId))
      .run();
  }

  // 没有随导出带向量的文档，排队重新向量化（有嵌入模型时）
  for (const docId of docIds) {
    const row = db
      .select({ chunkCount: knowledgeDocs.chunkCount, embeddedCount: knowledgeDocs.embeddedCount })
      .from(knowledgeDocs)
      .where(eq(knowledgeDocs.id, docId))
      .get();
    if (!row) continue;
    if (row.chunkCount > 0 && row.embeddedCount === row.chunkCount) continue;
    enqueueDoc(docId, { kind: row.chunkCount > 0 ? "embed" : "ingest" });
  }

  recordKbEvent({
    kbId,
    action: "import",
    detail: { docs: docIds.length, chunks: data.chunks.length, embedded, sourceName: src.name ?? null },
  });
  notifyKb(kbId);
  return { kb: kbToView(getKb(kbId)!), docs: docIds.length, chunks: data.chunks.length, embedded };
}

/**
 * 启动维护（与记忆库维护同一时机调用）：
 * 1) 恢复上次进程遗留的摄取作业；
 * 2) 修剪审计流水；
 * 3) 对账文档的分块计数（历史版本或异常中断留下的漂移）。
 */
export function runKbMaintenance(): {
  requeued: number;
  adopted: number;
  pruned: number;
  reconciled: number;
} {
  const { requeued, adopted } = recoverIngestJobs();
  const pruned = pruneKbEvents();
  let reconciled = 0;
  const drift = db
    .select({
      id: knowledgeDocs.id,
      chunkCount: knowledgeDocs.chunkCount,
      actual: sql<number>`(select count(*) from ${knowledgeChunks} where ${knowledgeChunks.docId} = ${knowledgeDocs.id})`,
      embedded: sql<number>`(select count(*) from ${knowledgeChunks} where ${knowledgeChunks.docId} = ${knowledgeDocs.id} and ${knowledgeChunks.embedding} is not null)`,
    })
    .from(knowledgeDocs)
    .all();
  for (const doc of drift) {
    const actual = Number(doc.actual);
    const embedded = Number(doc.embedded);
    if (doc.chunkCount === actual || actual === 0) continue;
    db.update(knowledgeDocs).set({ chunkCount: actual, embeddedCount: embedded }).where(eq(knowledgeDocs.id, doc.id)).run();
    reconciled++;
  }
  if (requeued > 0 || adopted > 0 || pruned > 0 || reconciled > 0) {
    recordKbEvent({
      kbId: null,
      action: "maintenance",
      detail: { requeued, adopted, pruned, reconciled },
    });
  }
  return { requeued, adopted, pruned, reconciled };
}
