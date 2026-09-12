/**
 * 知识库摄取管道 + 持久化作业队列。
 *
 * 早期实现是 `void ingestDoc(id)` 的 fire-and-forget：进程退出或崩溃后文档永久
 * 卡在 parsing/chunking/embedding；目录导入会一次性并发几百个请求打爆本地推理
 * 服务；失败没有重试，只能人工发现再点「重新处理」。这里把摄取变成一个真正的
 * 作业系统：
 *
 * - 作业落库（kb_ingest_jobs），重启后 `recoverIngestJobs()` 把 running 的作业
 *   重新排队、给卡在中间态的文档补建作业；
 * - 并发上限（本地推理服务通常只扛得住一两个并行请求）+ 指数退避重试；
 * - 断点续跑：分块已落库、只差向量时（kind=embed）跳过抽取与切片，
 *   不为了补向量去重新 OCR 一遍 PDF；
 * - 单文档级「内容哈希未变则跳过」，重新索引时按分块哈希复用旧向量；
 * - 分块写入放在一个事务里，中途失败回滚到旧分块，不会留下半截索引。
 *
 * 本模块不 import knowledge.ts（避免环）：变化通知走 onKbDataChanged，
 * 索引增量维护走 kb-index 的 peekKbIndex。
 */
import { existsSync } from "fs";
import path from "path";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import * as cheerio from "cheerio";

import { db } from "./db";
import { kbIngestJobs, knowledgeBases, knowledgeChunks, knowledgeDocs } from "./db/schema";
import type { KnowledgeBaseRow, KnowledgeDocRow } from "./db/schema";
import { callEmbeddings, decodeEmbedding, encodeEmbedding, type EmbeddingConfig } from "./embeddings";
import { chunkContentHash, contextText, splitIntoChunksWithMeta } from "./kb-chunk";
import { peekKbIndex } from "./kb-index";
import { recordKbEvent } from "./kb-events";
import { getSetting, getActiveServerPort } from "./db/settings";
import { convertFileToImages, generate, type ModelEndpoint } from "./vllm";
import { getLocalModelName } from "./vllm/model";
import type { KbIngestJobView } from "../shared/knowledge";

// ---------------------------------------------------------------------------
// 变化通知（knowledge.ts 订阅后转发到 webview / 失效缓存）
// ---------------------------------------------------------------------------

export type KbDataChange = { kbId: number; docId?: number; kind: "chunks" | "status" | "doc" };

const listeners = new Set<(payload: KbDataChange) => void>();

export function onKbDataChanged(cb: (payload: KbDataChange) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function emitKbDataChanged(payload: KbDataChange): void {
  for (const cb of listeners) {
    try {
      cb(payload);
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// 正文抽取
// ---------------------------------------------------------------------------

const KB_TEXT_FILE_RE =
  /\.(txt|md|markdown|json|csv|tsv|log|xml|yml|yaml|html?|htm|js|jsx|ts|tsx|mjs|cjs|css|scss|less|py|rb|rs|go|java|kt|swift|c|h|cpp|hpp|cs|php|sh|bash|zsh|toml|ini|cfg|conf|sql|vue|svelte|graphql|proto)$/i;
const KB_TEXT_MAX_BYTES = 16 * 1024 * 1024;

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

/** 正文内容 SHA-256（判断源是否真的变了）。 */
export function textContentHash(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function embeddingConfigOf(kb: KnowledgeBaseRow): EmbeddingConfig {
  return {
    embeddingModel: kb.embeddingModel,
    embeddingBase: kb.embeddingBase,
    embeddingApiKey: kb.embeddingApiKey,
    embeddingDim: kb.embeddingDim,
  };
}

function countChunks(docId: number): number {
  const row = db
    .select({ c: sql<number>`count(*)` })
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.docId, docId))
    .get();
  return Number(row?.c ?? 0);
}

function countMissingVectors(docId: number): number {
  const row = db
    .select({ c: sql<number>`count(*)` })
    .from(knowledgeChunks)
    .where(and(eq(knowledgeChunks.docId, docId), isNull(knowledgeChunks.embedding)))
    .get();
  return Number(row?.c ?? 0);
}

// ---------------------------------------------------------------------------
// 单文档管道
// ---------------------------------------------------------------------------

export type IngestKind = "ingest" | "embed";

/**
 * 处理一个文档。
 *
 * kind=ingest：抽取 → 切片（复用未变化分块的向量）→ 向量化 → ready。
 * kind=embed ：只补缺失向量，跳过抽取与切片（「补齐向量」路径，不重跑 OCR）。
 *
 * 抛出异常表示本次失败，由队列决定重试还是置 failed。
 */
async function processDoc(docId: number, kind: IngestKind): Promise<void> {
  const doc = db.select().from(knowledgeDocs).where(eq(knowledgeDocs.id, docId)).get();
  if (!doc) return;
  const kb = db.select().from(knowledgeBases).where(eq(knowledgeBases.id, doc.kbId)).get();
  if (!kb) throw new Error("知识库不存在");

  const setStatus = (status: KnowledgeDocRow["status"], extra: Record<string, unknown> = {}) => {
    db.update(knowledgeDocs)
      .set({ status, error: null, ...extra })
      .where(eq(knowledgeDocs.id, docId))
      .run();
    emitKbDataChanged({ kbId: doc.kbId, docId, kind: "status" });
  };

  if (kind === "ingest") {
    setStatus("parsing");
    let text: string;
    if (doc.kind === "note") text = doc.content ?? "";
    else if (doc.kind === "web") text = await extractWebText(doc.url ?? "");
    else {
      if (!doc.sourcePath || !existsSync(doc.sourcePath)) {
        throw new Error("源文件不存在（可能已被移动或删除）");
      }
      text = await extractFileText(doc.sourcePath);
    }
    if (!text.trim()) throw new Error("未提取到正文内容");

    const textHash = textContentHash(text);
    const existingChunks = countChunks(docId);
    const fullyEmbedded = !kb.embeddingModel || existingChunks - countMissingVectors(docId) === existingChunks;
    if (doc.contentHash === textHash && existingChunks > 0 && doc.status === "ready" && fullyEmbedded) {
      recordKbEvent({
        kbId: doc.kbId,
        docId,
        action: "doc_skipped",
        detail: { name: doc.name, reason: "内容未变化" },
      });
      return;
    }

    setStatus("chunking", { charCount: text.length, contentHash: textHash });
    const pieces = splitIntoChunksWithMeta(text, kb.chunkSize, kb.chunkOverlap);
    if (pieces.length === 0) throw new Error("切片结果为空");

    // 未变化的分块直接沿用旧向量：改一个段落不必为整篇文档重新付费嵌入
    const reusable = new Map<string, string>();
    const oldRows = db
      .select({ hash: knowledgeChunks.contentHash, embedding: knowledgeChunks.embedding })
      .from(knowledgeChunks)
      .where(and(eq(knowledgeChunks.docId, docId), isNotNull(knowledgeChunks.embedding)))
      .all();
    for (const row of oldRows) {
      if (row.hash && row.embedding) reusable.set(row.hash, row.embedding);
    }

    const rows = pieces.map((piece, i) => {
      const hash = chunkContentHash(piece.content);
      return {
        kbId: doc.kbId,
        docId,
        seq: i + 1,
        content: piece.content,
        charCount: piece.content.length,
        headingPath: piece.headingPath,
        charStart: piece.charStart,
        charEnd: piece.charEnd,
        contentHash: hash,
        embedding: reusable.get(hash) ?? null,
      };
    });
    const reused = rows.filter((r) => r.embedding).length;

    // 先删后插放在一个事务里：中途失败回滚到旧分块，不会留下半截索引
    db.transaction((tx) => {
      tx.delete(knowledgeChunks).where(eq(knowledgeChunks.docId, docId)).run();
      for (const row of rows) tx.insert(knowledgeChunks).values(row).run();
    });
    db.update(knowledgeDocs)
      .set({ chunkCount: rows.length, embeddedCount: reused, indexedAt: Date.now() })
      .where(eq(knowledgeDocs.id, docId))
      .run();
    syncDocIndex(doc);
    emitKbDataChanged({ kbId: doc.kbId, docId, kind: "chunks" });
  } else if (countChunks(docId) === 0) {
    throw new Error("分块为空，无法只补向量");
  }

  if (!kb.embeddingModel) {
    setStatus("ready", { indexedAt: Date.now() });
    recordKbEvent({ kbId: doc.kbId, docId, action: "doc_ingested", detail: { name: doc.name, mode: "keyword" } });
    return;
  }

  setStatus("embedding");
  const embedded = await embedDocChunks(kb, doc.kbId, docId, embeddingConfigOf(kb));
  setStatus("ready", { indexedAt: Date.now() });
  recordKbEvent({
    kbId: doc.kbId,
    docId,
    action: "doc_ingested",
    detail: { name: doc.name, chunks: countChunks(docId), embedded },
  });
}

/** 把该文档最新的分块灌进已加载的索引（没加载就跳过，下次查询整份加载）。 */
function syncDocIndex(doc: KnowledgeDocRow): void {
  const index = peekKbIndex(doc.kbId);
  if (!index) return;
  const rows = db
    .select({
      id: knowledgeChunks.id,
      seq: knowledgeChunks.seq,
      content: knowledgeChunks.content,
      headingPath: knowledgeChunks.headingPath,
      embedding: knowledgeChunks.embedding,
    })
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.docId, doc.id))
    .all();
  index.replaceDoc(
    doc.id,
    rows.map((row) => ({
      id: row.id,
      docId: doc.id,
      seq: row.seq,
      content: row.content,
      headingPath: row.headingPath,
      docName: doc.name,
      embedding: row.embedding ? decodeEmbedding(row.embedding) : null,
    })),
  );
}

/**
 * 补齐一个文档里缺向量的分块。嵌入文本用「文档名 › 标题路径 + 正文」的
 * 上下文增强形式（与查询侧一致），逐批更新进度并把新向量增量灌进索引。
 */
async function embedDocChunks(
  kb: KnowledgeBaseRow,
  kbId: number,
  docId: number,
  cfgIn: EmbeddingConfig,
): Promise<number> {
  const cfg: EmbeddingConfig = { ...cfgIn };
  const docName = db.select({ name: knowledgeDocs.name }).from(knowledgeDocs).where(eq(knowledgeDocs.id, docId)).get()?.name ?? "";
  let embedded = 0;
  while (true) {
    const batch = db
      .select({ id: knowledgeChunks.id, content: knowledgeChunks.content, headingPath: knowledgeChunks.headingPath })
      .from(knowledgeChunks)
      .where(and(eq(knowledgeChunks.docId, docId), isNull(knowledgeChunks.embedding)))
      .limit(32)
      .all();
    if (batch.length === 0) break;

    const vectors = await callEmbeddings(
      cfg,
      batch.map((b) => contextText(docName, b.headingPath, b.content)),
    );
    const index = peekKbIndex(kbId);
    for (let i = 0; i < batch.length; i++) {
      const vec = vectors[i]!;
      db.update(knowledgeChunks)
        .set({ embedding: encodeEmbedding(vec) })
        .where(eq(knowledgeChunks.id, batch[i]!.id))
        .run();
      index?.setVector(batch[i]!.id, vec);
    }
    embedded += batch.length;
    // embeddedCount 必须按「总量 − 仍缺向量数」算：复用旧向量的分块不在 embedded 里，
    // 用 max(旧值, embedded) 会把复用计数丢掉（重新索引时数字对不上）。
    db.update(knowledgeDocs)
      .set({ embeddedCount: countChunks(docId) - countMissingVectors(docId) })
      .where(eq(knowledgeDocs.id, docId))
      .run();
    emitKbDataChanged({ kbId, docId, kind: "status" });

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

// ---------------------------------------------------------------------------
// 作业队列
// ---------------------------------------------------------------------------

const MAX_CONCURRENCY = 2;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 60_000;
const RETRY_JITTER = 0.25;
const WAKE_MAX_MS = 30_000;

let runningCount = 0;
let wakeTimer: ReturnType<typeof setTimeout> | null = null;

function nextDueAt(): number | null {
  const row = db
    .select({ t: sql<number | null>`min(${kbIngestJobs.nextRunAt})` })
    .from(kbIngestJobs)
    .where(eq(kbIngestJobs.state, "queued"))
    .get();
  return row?.t == null ? null : Number(row.t);
}

/**
 * 入队（幂等）：同一文档已有作业时复用该行，默认不清零 attempts
 * （避免「崩溃 → 重启 → 重试次数被重置」形成无限重试）。
 */
export function enqueueDoc(docId: number, opts: { kind?: IngestKind; resetAttempts?: boolean } = {}): void {
  const doc = db.select({ kbId: knowledgeDocs.kbId }).from(knowledgeDocs).where(eq(knowledgeDocs.id, docId)).get();
  if (!doc) return;
  const existing = db.select().from(kbIngestJobs).where(eq(kbIngestJobs.docId, docId)).get();
  if (existing) {
    if (existing.state === "running") return;
    db.update(kbIngestJobs)
      .set({
        state: "queued",
        kind: opts.kind ?? existing.kind,
        nextRunAt: 0,
        lockedAt: null,
        ...(opts.resetAttempts ? { attempts: 0, lastError: null } : {}),
      })
      .where(eq(kbIngestJobs.id, existing.id))
      .run();
  } else {
    db.insert(kbIngestJobs)
      .values({
        kbId: doc.kbId,
        docId,
        kind: opts.kind ?? "ingest",
        state: "queued",
        attempts: 0,
        maxAttempts: MAX_ATTEMPTS,
        nextRunAt: 0,
      })
      .run();
  }
  pump();
}

/**
 * 失败后重试：能续跑就续跑。
 *
 * 已经切完片、只差向量的文档按 kind=embed 续跑，不为了补向量去重新 OCR 一遍 PDF；
 * 卡在解析/切片阶段（或没有分块）才从头跑。与「重新处理」的区别是后者会清掉内容
 * 指纹强制重建，这里只是把失败的作业重新交回队列。
 */
export function retryDoc(docId: number): void {
  const doc = db
    .select({ status: knowledgeDocs.status })
    .from(knowledgeDocs)
    .where(eq(knowledgeDocs.id, docId))
    .get();
  if (!doc) return;
  const resumable = doc.status === "embedding" && countChunks(docId) > 0;
  enqueueDoc(docId, { kind: resumable ? "embed" : "ingest", resetAttempts: true });
}

/** 删除文档时清掉它的作业，避免重启后为一个不存在的文档反复重试。 */
export function dropDocJob(docId: number): void {
  db.delete(kbIngestJobs).where(eq(kbIngestJobs.docId, docId)).run();
}

export function docJobs(kbId: number): Map<number, KbIngestJobView> {
  const rows = db.select().from(kbIngestJobs).where(eq(kbIngestJobs.kbId, kbId)).all();
  return new Map(
    rows.map((r) => [
      r.docId,
      {
        docId: r.docId,
        state: r.state,
        attempts: r.attempts,
        maxAttempts: r.maxAttempts,
        nextRunAt: r.nextRunAt,
        lastError: r.lastError,
      },
    ]),
  );
}

export function ingestQueueStats(): { queued: number; running: number; failed: number } {
  const rows = db
    .select({ state: kbIngestJobs.state, c: sql<number>`count(*)` })
    .from(kbIngestJobs)
    .groupBy(kbIngestJobs.state)
    .all();
  const get = (state: string) => Number(rows.find((r) => r.state === state)?.c ?? 0);
  return { queued: get("queued"), running: runningCount || get("running"), failed: get("failed") };
}

function claimNext(): (typeof kbIngestJobs.$inferSelect) | null {
  const now = Date.now();
  const job = db
    .select()
    .from(kbIngestJobs)
    .where(and(eq(kbIngestJobs.state, "queued"), sql`${kbIngestJobs.nextRunAt} <= ${now}`))
    .orderBy(asc(kbIngestJobs.nextRunAt), asc(kbIngestJobs.id))
    .limit(1)
    .get();
  if (!job) return null;
  db.update(kbIngestJobs)
    .set({ state: "running", lockedAt: now, attempts: job.attempts + 1 })
    .where(eq(kbIngestJobs.id, job.id))
    .run();
  return { ...job, attempts: job.attempts + 1 };
}

function backoffMs(attempts: number): number {
  const base = Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);
  return Math.round(base * (1 + RETRY_JITTER * Math.random()));
}

async function runJob(job: typeof kbIngestJobs.$inferSelect): Promise<void> {
  try {
    await processDoc(job.docId, job.kind);
    db.update(kbIngestJobs)
      .set({ state: "done", lastError: null, lockedAt: null })
      .where(eq(kbIngestJobs.id, job.id))
      .run();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const exhausted = job.attempts >= job.maxAttempts;
    if (exhausted) {
      db.update(kbIngestJobs)
        .set({ state: "failed", lastError: message, lockedAt: null })
        .where(eq(kbIngestJobs.id, job.id))
        .run();
      db.update(knowledgeDocs)
        .set({ status: "failed", error: message })
        .where(eq(knowledgeDocs.id, job.docId))
        .run();
      emitKbDataChanged({ kbId: job.kbId, docId: job.docId, kind: "status" });
      recordKbEvent({
        kbId: job.kbId,
        docId: job.docId,
        action: "doc_failed",
        detail: { attempts: job.attempts, error: message },
      });
    } else {
      db.update(kbIngestJobs)
        .set({ state: "queued", lastError: message, nextRunAt: Date.now() + backoffMs(job.attempts), lockedAt: null })
        .where(eq(kbIngestJobs.id, job.id))
        .run();
    }
  }
}

function scheduleWake(): void {
  if (wakeTimer) return;
  const due = nextDueAt();
  if (due == null) return;
  const delay = Math.min(Math.max(due - Date.now(), 30), WAKE_MAX_MS);
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    pump();
  }, delay);
  (wakeTimer as { unref?: () => void }).unref?.();
}

/** 泵：在并发上限内尽量多认领作业；有未来到期的作业时排一个唤醒定时器。 */
export function pump(): void {
  while (runningCount < MAX_CONCURRENCY) {
    const job = claimNext();
    if (!job) break;
    runningCount++;
    void runJob(job)
      .catch(() => {})
      .finally(() => {
        runningCount--;
        pump();
      });
  }
  scheduleWake();
}

/**
 * 等待某个知识库的作业全部结束（同步语义的调用方：「补齐向量」）。
 *
 * 刻意只盯这一个库：队列是全库共享的，别的库正在退避重试时不该把调用方一起拖住。
 * 用轮询而不是事件等待，是为了对「作业被别处删掉/改状态」也保持正确。
 */
export async function awaitKbIdle(kbId: number, timeoutMs = 300_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = db
      .select({ c: sql<number>`count(*)` })
      .from(kbIngestJobs)
      .where(and(eq(kbIngestJobs.kbId, kbId), inArray(kbIngestJobs.state, ["queued", "running"])))
      .get();
    if (Number(row?.c ?? 0) === 0) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(150);
  }
}

/**
 * 启动恢复：
 * 1) 上次进程被杀时留下的 running 作业重新排队（attempts 保留，崩溃循环不会无限重试）；
 * 2) 状态停在中间态却没有作业的文档（旧版本数据 / 作业被清）补建作业。
 */
export function recoverIngestJobs(): { requeued: number; adopted: number } {
  const requeued = db
    .update(kbIngestJobs)
    .set({ state: "queued", lockedAt: null, nextRunAt: 0 })
    .where(eq(kbIngestJobs.state, "running"))
    .returning({ id: kbIngestJobs.id })
    .all().length;

  const stuck = db
    .select({ id: knowledgeDocs.id, status: knowledgeDocs.status })
    .from(knowledgeDocs)
    .where(inArray(knowledgeDocs.status, ["pending", "parsing", "chunking", "embedding"]))
    .all();
  let adopted = 0;
  for (const doc of stuck) {
    const has = db.select({ id: kbIngestJobs.id }).from(kbIngestJobs).where(eq(kbIngestJobs.docId, doc.id)).get();
    if (has) continue;
    enqueueDoc(doc.id, { kind: doc.status === "embedding" ? "embed" : "ingest" });
    adopted++;
  }
  pump();
  return { requeued, adopted };
}
