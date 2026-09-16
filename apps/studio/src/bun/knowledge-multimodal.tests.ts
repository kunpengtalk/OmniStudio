/**
 * 知识库多模态数据层测试（真测试体，由 knowledge-multimodal.test.ts 子进程隔离跑）。
 *
 * 为什么套子进程：本文件直接用真实 ./db（bunfig test-preload 已把数据目录指到临时目录），
 * 不做任何 mock —— 同批次里其他测试文件（如 embedding-defaults.test.ts）会对 ./db /
 * ./db/settings 注册 mock.module，而 mock 注册表在同一批次跨文件共享，直接 import 会拿到
 * 别的文件桩出来的假模块（先例见 model-store.embedding.test.ts 头注释）。子进程里既没有
 * 泄漏进来的 mock，结果也确定；bunfig 的 test-preload 在子进程同样生效。
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { db } from "./db";
import { kbIngestJobs, knowledgeBases, knowledgeChunks, knowledgeDocs } from "./db/schema";
import { eq } from "drizzle-orm";
import { invalidateKbIndex } from "./kb-index";
import {
  exportKb,
  importKb,
  createKb,
  updateKb,
  recall,
  buildChatContext,
  listChunks,
  listDocs,
  KB_EXPORT_FORMAT,
  KB_EXPORT_VERSION,
  type KbExportPayload,
} from "./knowledge";
import type { KbModality } from "../shared/knowledge";
import { kbFileModality, KB_AUDIO_EXT, KB_IMAGE_EXT, KB_VIDEO_EXT } from "../shared/knowledge";

// ---------------------------------------------------------------------------
// 纯函数：kbFileModality（UI accept / 目录白名单 / 摄取路由的单一来源）
// ---------------------------------------------------------------------------

describe("kbFileModality", () => {
  test("图片：png/jpg/jpeg/webp/tiff/bmp/heic/heif/pdf（大小写不敏感）", () => {
    for (const name of ["photo.png", "a.jpg", "a.jpeg", "pic.webp", "scan.tiff", "x.bmp", "p.heic", "p.heif", "doc.PDF"]) {
      expect(kbFileModality(name)).toBe("image");
    }
    expect(KB_IMAGE_EXT).toContain("pdf");
  });

  test("音频：mp3/wav/flac/m4a/ogg/opus/aac；视频：mp4/mov/mkv/webm/avi/m4v", () => {
    for (const ext of ["mp3", "wav", "flac", "m4a", "ogg", "opus", "aac"] as const) {
      expect((KB_AUDIO_EXT as readonly string[]).includes(ext)).toBe(true);
      expect(kbFileModality(`s.${ext}`)).toBe("audio");
    }
    for (const ext of ["mp4", "mov", "mkv", "webm", "avi", "m4v"] as const) {
      expect((KB_VIDEO_EXT as readonly string[]).includes(ext)).toBe(true);
      expect(kbFileModality(`v.${ext}`)).toBe("video");
    }
  });

  test("其余一律 text（含无扩展名）", () => {
    for (const name of ["notes.txt", "a.md", "data.json", "page.html", "page.htm", "noext", "a.xyz"]) {
      expect(kbFileModality(name)).toBe("text");
    }
  });
});

// ---------------------------------------------------------------------------
// 三布尔：建库快照 / 更新不重置向量
// ---------------------------------------------------------------------------

describe("createKb/updateKb 模态三布尔", () => {
  test("createKb 显式传入（缺省 false，不从全局继承）；kbToView int→bool", () => {
    const kb1 = createKb({ name: "模态快照库", embedImage: true, embedAudio: true });
    expect(kb1.embedImage).toBe(true);
    expect(kb1.embedAudio).toBe(true);
    expect(kb1.embedVideo).toBe(false);

    const kb2 = createKb({ name: "缺省库" });
    expect(kb2.embedImage).toBe(false);
    expect(kb2.embedAudio).toBe(false);
    expect(kb2.embedVideo).toBe(false);

    // 行内落的是 int（0/1），与 mcpExposed 同款
    const row = db.select().from(knowledgeBases).where(eq(knowledgeBases.id, kb1.id)).get()!;
    expect(row.embedImage).toBe(1);
    expect(row.embedAudio).toBe(1);
    expect(row.embedVideo).toBe(0);
  });

  test("updateKb 改模态勾选：视图更新、embeddingsReset=false、已有向量原样保留", () => {
    const kb = createKb({ name: "勾选变更库", embedImage: true });
    const doc = db
      .insert(knowledgeDocs)
      .values({ kbId: kb.id, name: "doc1", kind: "note", content: "正文", chunkCount: 1, embeddedCount: 1, status: "ready" })
      .returning()
      .get();
    db.insert(knowledgeChunks)
      .values({ kbId: kb.id, docId: doc.id, seq: 1, content: "x", charCount: 1, embedding: "dummy-vector" })
      .run();

    const before = db.select().from(knowledgeChunks).where(eq(knowledgeChunks.docId, doc.id)).get()!;
    const r = updateKb(kb.id, { embedImage: false, embedAudio: true, embedVideo: true });
    expect(r.embeddingsReset).toBe(false);
    expect(r.kb.embedImage).toBe(false);
    expect(r.kb.embedAudio).toBe(true);
    expect(r.kb.embedVideo).toBe(true);

    const after = db.select().from(knowledgeChunks).where(eq(knowledgeChunks.docId, doc.id)).get()!;
    expect(after.embedding).toBe(before.embedding);
    expect(after.embedding).toBe("dummy-vector");
    const docAfter = db.select().from(knowledgeDocs).where(eq(knowledgeDocs.id, doc.id)).get()!;
    expect(docAfter.embeddedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// listChunks 透传媒体三列
// ---------------------------------------------------------------------------

describe("listChunks 媒体列透传", () => {
  test("媒体块带 modality/mediaPath/mediaIndex，文本块为 null", () => {
    const kb = createKb({ name: "分块视图库" });
    const doc = db
      .insert(knowledgeDocs)
      .values({ kbId: kb.id, name: "mix.pdf", kind: "file", status: "ready" })
      .returning()
      .get();
    db.insert(knowledgeChunks)
      .values([
        { kbId: kb.id, docId: doc.id, seq: 1, content: "文字块", charCount: 3 },
        { kbId: kb.id, docId: doc.id, seq: 2, content: "", charCount: 0, modality: "image", mediaPath: "/tmp/mix.png", mediaIndex: 0 },
        { kbId: kb.id, docId: doc.id, seq: 3, content: "", charCount: 0, modality: "video", mediaPath: "/tmp/mix.mp4", mediaIndex: 0 },
      ])
      .run();

    // main 侧给 listChunks 加了分页信封 { chunks, total }，这里取内层数组
    const chunks = listChunks(doc.id).chunks;
    expect(chunks).toHaveLength(3);
    const text = chunks.find((c) => c.seq === 1)!;
    const image = chunks.find((c) => c.seq === 2)!;
    const video = chunks.find((c) => c.seq === 3)!;
    expect(text.modality).toBeNull();
    expect(text.mediaPath).toBeNull();
    expect(text.mediaIndex).toBeNull();
    expect(image.modality).toBe("image");
    expect(image.mediaPath).toBe("/tmp/mix.png");
    expect(image.mediaIndex).toBe(0);
    expect(video.modality).toBe("video");
  });
});

// ---------------------------------------------------------------------------
// listDocs: firstImageChunkId 派生（行内缩略图入口，读时派生不落库）
// ---------------------------------------------------------------------------

describe("listDocs firstImageChunkId 派生", () => {
  /**
   * 造三份文档：A = 文本块在前 + 两个图片块在后（首图必须是图片块里的 min id，
   * 不是全块 min id）；B = 纯文本块；C = 纯音视频块。返回各 doc id 与 A 的首图块 id。
   */
  function setupThumbKb(name: string): { kbId: number; docA: number; docB: number; docC: number; firstImageChunkId: number } {
    const kb = createKb({ name });
    const docA = db
      .insert(knowledgeDocs)
      .values({ kbId: kb.id, name: "photo.pdf", kind: "file", status: "ready" })
      .returning()
      .get();
    const docB = db
      .insert(knowledgeDocs)
      .values({ kbId: kb.id, name: "notes.md", kind: "note", status: "ready" })
      .returning()
      .get();
    const docC = db
      .insert(knowledgeDocs)
      .values({ kbId: kb.id, name: "clip.mp4", kind: "file", status: "ready" })
      .returning()
      .get();
    const aChunks = db
      .insert(knowledgeChunks)
      .values([
        { kbId: kb.id, docId: docA.id, seq: 1, content: "文字块", charCount: 3 },
        { kbId: kb.id, docId: docA.id, seq: 2, content: "", charCount: 0, modality: "image", mediaPath: "/tmp/photo-2.png", mediaIndex: 0 },
        { kbId: kb.id, docId: docA.id, seq: 3, content: "修正后的文本", charCount: 6, modality: "image", mediaPath: "/tmp/photo-3.png", mediaIndex: 1 },
      ])
      .returning({ id: knowledgeChunks.id })
      .all();
    // A 的首图 = 两个图片块里 id 较小者（seq 2），文本块 id 更小但不算
    const firstImageChunkId = aChunks[1]!.id;
    expect(firstImageChunkId).toBeLessThan(aChunks[2]!.id);

    // B：纯文本块
    db.insert(knowledgeChunks)
      .values({ kbId: kb.id, docId: docB.id, seq: 1, content: "纯文本", charCount: 3 })
      .run();
    // C：纯音视频块（modality 过滤不误选）
    db.insert(knowledgeChunks)
      .values([
        { kbId: kb.id, docId: docC.id, seq: 1, content: "", charCount: 0, modality: "audio", mediaPath: "/tmp/clip.mp3", mediaIndex: 0 },
        { kbId: kb.id, docId: docC.id, seq: 2, content: "", charCount: 0, modality: "video", mediaPath: "/tmp/clip.mp4", mediaIndex: 0 },
      ])
      .run();

    return { kbId: kb.id, docA: docA.id, docB: docB.id, docC: docC.id, firstImageChunkId };
  }

  test("多图片块文档 = min(图片块 id)（文本块 id 更小也不误选）", () => {
    const { kbId, docA, firstImageChunkId } = setupThumbKb("首图库A");
    const docs = listDocs(kbId).docs;
    const byId = new Map(docs.map((d) => [d.id, d]));
    expect(byId.get(docA)!.firstImageChunkId).toBe(firstImageChunkId);
  });

  test("纯文本/无块文档 → null；纯音视频块文档 → null（modality 过滤不误选）", () => {
    const { kbId, docB, docC } = setupThumbKb("首图库BC");
    const docs = listDocs(kbId).docs;
    const byId = new Map(docs.map((d) => [d.id, d]));
    expect(byId.get(docB)!.firstImageChunkId).toBeNull();
    expect(byId.get(docC)!.firstImageChunkId).toBeNull();
  });

  test("跨库隔离：他库图片块不串扰（kb_id 过滤走 kbIdx 索引）", () => {
    const { kbId, docA, firstImageChunkId } = setupThumbKb("首图库隔离");
    // 另一个库插入带图片块的文档
    const kb2 = createKb({ name: "另一个库" });
    const docD = db
      .insert(knowledgeDocs)
      .values({ kbId: kb2.id, name: "other.png", kind: "file", status: "ready" })
      .returning()
      .get();
    db.insert(knowledgeChunks)
      .values({ kbId: kb2.id, docId: docD.id, seq: 1, content: "", charCount: 0, modality: "image", mediaPath: "/tmp/other.png", mediaIndex: 0 })
      .run();

    // 本库结果不受他库影响
    const docs = listDocs(kbId).docs;
    const byId = new Map(docs.map((d) => [d.id, d]));
    expect(byId.get(docA)!.firstImageChunkId).toBe(firstImageChunkId);

    // 他库自己的文档能取到首图
    const docs2 = listDocs(kb2.id).docs;
    expect(docs2).toHaveLength(1);
    expect(docs2[0]!.firstImageChunkId).not.toBeNull();
    expect(docs2[0]!.firstImageChunkId).not.toBe(firstImageChunkId);
  });
});

// ---------------------------------------------------------------------------
// 相邻合并：媒体块单块成组；modality 经 chunkRows SELECT 到达 KbHit
// ---------------------------------------------------------------------------

/** 建一个纯关键词库并直接落一个「两个相邻文本块 + 一个媒体块」的文档。 */
function setupMergeKb(name: string): { kbId: number; docId: number } {
  const kb = createKb({ name });
  const doc = db
    .insert(knowledgeDocs)
    .values({ kbId: kb.id, name: "quantum.png", kind: "note", status: "ready" })
    .returning()
    .get();
  db.insert(knowledgeChunks)
    .values([
      { kbId: kb.id, docId: doc.id, seq: 1, content: "quantum alpha report", charCount: 20 },
      { kbId: kb.id, docId: doc.id, seq: 2, content: "quantum beta report", charCount: 19 },
      // 媒体块：空正文，靠文件名 token（headingPostings）被 "quantum" 命中
      { kbId: kb.id, docId: doc.id, seq: 3, content: "", charCount: 0, modality: "image", mediaPath: "/tmp/quantum.png", mediaIndex: 0 },
    ])
    .run();
  invalidateKbIndex(kb.id);
  return { kbId: kb.id, docId: doc.id };
}

describe("recall：相邻合并与媒体命中", () => {
  test("相邻文本块并组；媒体块单块成组且 modality 透传到 KbHit", async () => {
    const { kbId } = setupMergeKb("合并库");
    const { hits } = await recall([kbId], "quantum");
    expect(hits.length).toBe(2);

    const textHit = hits.find((h) => !h.modality)!;
    const mediaHit = hits.find((h) => h.modality)!;
    expect(textHit).toBeDefined();
    expect(mediaHit).toBeDefined();

    // 文本块 1+2 相邻合并
    expect([...(textHit.mergedSeqs ?? [])].sort((a, b) => a - b)).toEqual([1, 2]);
    expect(textHit.content).toContain("alpha");
    expect(textHit.content).toContain("beta");

    // 媒体块单块成组：不并入相邻文本块，也不产生 mergedSeqs
    expect(mediaHit.modality).toBe("image");
    expect(mediaHit.seq).toBe(3);
    expect(mediaHit.mergedSeqs).toBeUndefined();
    expect(mediaHit.content).toBe("");
    expect(typeof mediaHit.chunkId).toBe("number");
  });

  test("buildChatContext：空 content 媒体命中=编号引用行+空正文；citation 带 chunkId+modality", async () => {
    const { kbId } = setupMergeKb("注入库");
    const { system, citations } = await buildChatContext([kbId], "quantum");
    expect(system).not.toBeNull();

    // 文本命中：正文照常跟随标题行
    expect(system).toMatch(/（分块 1）\nquantum alpha/);
    // 媒体命中：标题行保留，正文行为空（后面不允许再跟非空正文）
    expect(system).toContain("来源：quantum.png（分块 3）");
    expect(system).not.toMatch(/（分块 3）\n\S/);

    const mediaCitation = citations.find((c) => c.modality === "image")!;
    expect(mediaCitation).toBeDefined();
    expect(typeof mediaCitation.chunkId).toBe("number");
    expect(mediaCitation.snippet).toBe("");
    const textCitation = citations.find((c) => !c.modality)!;
    expect(textCitation.modality).toBeNull();
    expect(textCitation.chunkId).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 导出导入：v2 往返无损 / 媒体缺失可见失败 / 媒体在场重新入队 / v1 兼容
// ---------------------------------------------------------------------------

/** 造一个带媒体块的最小库（doc+chunks 直接落库，避免经过摄取队列）。 */
function setupExportKb(mediaPath: string, withEmbedding: boolean): number {
  const kb = createKb({ name: "往返库", embedImage: true, embedVideo: true });
  const doc = db
    .insert(knowledgeDocs)
    .values({ kbId: kb.id, name: "clip.mp4", kind: "file", sourcePath: mediaPath, status: "ready" })
    .returning()
    .get();
  db.insert(knowledgeChunks).values([
    {
      kbId: kb.id,
      docId: doc.id,
      seq: 1,
      content: "正文块",
      charCount: 3,
      headingPath: "H",
      charStart: 0,
      charEnd: 3,
      contentHash: "hash-text",
      embedding: withEmbedding ? "dummy-vector-text" : null,
    },
    {
      kbId: kb.id,
      docId: doc.id,
      seq: 2,
      content: "",
      charCount: 0,
      modality: "video",
      mediaPath,
      mediaIndex: 0,
      contentHash: "hash-media",
      embedding: withEmbedding ? "dummy-vector-media" : null,
    },
  ]).run();
  db.update(knowledgeDocs)
    .set({ chunkCount: 2, embeddedCount: withEmbedding ? 2 : 0 })
    .where(eq(knowledgeDocs.id, doc.id))
    .run();
  return kb.id;
}

describe("导出导入往返（KB_EXPORT_VERSION v2）", () => {
  test("版本号提升为 2", () => {
    expect(KB_EXPORT_VERSION).toBe(2);
  });

  test("媒体三列 + KB 三布尔无损往返；带向量时不入队", () => {
    const mediaDir = mkdtempSync(join(tmpdir(), "kb-mm-rt-"));
    const mediaPath = join(mediaDir, "clip.mp4");
    writeFileSync(mediaPath, "fake-bytes");
    const kbId = setupExportKb(mediaPath, true);

    const { payload, json } = exportKb(kbId, { includeEmbeddings: true });
    expect(payload.version).toBe(KB_EXPORT_VERSION);
    expect(payload.kb.embedImage).toBe(true);
    expect(payload.kb.embedAudio).toBe(false);
    expect(payload.kb.embedVideo).toBe(true);
    const mediaChunk = payload.chunks.find((c) => c.modality === "video")!;
    expect(mediaChunk).toBeDefined();
    expect(mediaChunk.mediaPath).toBe(mediaPath);
    expect(mediaChunk.mediaIndex).toBe(0);
    // JSON 序列化往返不丢字段
    const reparsed = JSON.parse(json) as KbExportPayload;
    expect(reparsed.chunks.find((c) => c.modality === "video")?.mediaPath).toBe(mediaPath);

    const imported = importKb(reparsed);
    expect(imported.kb.embedImage).toBe(true);
    expect(imported.kb.embedAudio).toBe(false);
    expect(imported.kb.embedVideo).toBe(true);
    expect(imported.embedded).toBe(2);

    const newChunks = db.select().from(knowledgeChunks).where(eq(knowledgeChunks.kbId, imported.kb.id)).all();
    expect(newChunks).toHaveLength(2);
    const newMedia = newChunks.find((c) => c.modality === "video")!;
    expect(newMedia.mediaPath).toBe(mediaPath);
    expect(newMedia.mediaIndex).toBe(0);
    expect(newMedia.embedding).toBe("dummy-vector-media");

    // 全部块带向量 → 不入队
    const jobs = db.select().from(kbIngestJobs).where(eq(kbIngestJobs.kbId, imported.kb.id)).all();
    expect(jobs).toHaveLength(0);
    rmSync(mediaDir, { recursive: true, force: true });
  });

  test("媒体块缺向量 → 不自动入队：status 保持 ready、提示落 error，mediaPath 缺失也不再 failed", () => {
    const missingPath = "/nonexistent/kb-mm/photo.png";
    const payload: KbExportPayload = {
      format: KB_EXPORT_FORMAT,
      version: KB_EXPORT_VERSION,
      exportedAt: Date.now(),
      kb: {
        name: "缺媒体库",
        description: null,
        embeddingModel: "",
        embeddingBase: "",
        embeddingDim: null,
        rerankModel: "",
        chunkSize: 800,
        chunkOverlap: 120,
        topK: 6,
        minScore: 0,
        expandNeighbors: true,
        embedImage: true,
        embedAudio: false,
        embedVideo: false,
      },
      docs: [
        { name: "photo.png", kind: "file", sourcePath: missingPath, url: null, content: null, sizeBytes: 42, charCount: null, contentHash: "h1" },
      ],
      chunks: [
        { doc: 0, seq: 1, content: "", charCount: 0, headingPath: null, charStart: null, charEnd: null, modality: "image", mediaPath: missingPath, mediaIndex: 0, contentHash: null },
      ],
    };
    const imported = importKb(payload);
    expect(imported.kb.embedImage).toBe(true);

    const doc = db.select().from(knowledgeDocs).where(eq(knowledgeDocs.kbId, imported.kb.id)).get()!;
    // 安全契约：不自动入队 → 不 failed，status 保持 ready，温和提示落 error
    expect(doc.status).toBe("ready");
    expect(doc.error).toContain("手动补齐向量");
    expect(doc.error).not.toContain("媒体文件缺失");

    const jobs = db.select().from(kbIngestJobs).where(eq(kbIngestJobs.kbId, imported.kb.id)).all();
    expect(jobs).toHaveLength(0);

    // 三列照常落库（往返无损），补齐向量走手动「补齐向量」路径
    const chunk = db.select().from(knowledgeChunks).where(eq(knowledgeChunks.kbId, imported.kb.id)).get()!;
    expect(chunk.modality).toBe("image");
    expect(chunk.mediaPath).toBe(missingPath);
    expect(chunk.embedding).toBeNull();
  });

  test("媒体文件在场且缺向量 → 同样不自动入队（防 mediaPath 指向受害者本机任意文件）", () => {
    const mediaDir = mkdtempSync(join(tmpdir(), "kb-mm-ep-"));
    const mediaPath = join(mediaDir, "clip.mp4");
    writeFileSync(mediaPath, "fake-bytes");
    const payload: KbExportPayload = {
      format: KB_EXPORT_FORMAT,
      version: KB_EXPORT_VERSION,
      exportedAt: Date.now(),
      kb: {
        name: "补向量库",
        description: null,
        embeddingModel: "some-embed-model",
        embeddingBase: "http://attacker.example:9", // 载荷指定的 base 不会被自动调用
        embeddingDim: null,
        rerankModel: "",
        chunkSize: 800,
        chunkOverlap: 120,
        topK: 6,
        minScore: 0,
        expandNeighbors: true,
        embedImage: false,
        embedAudio: false,
        embedVideo: true,
      },
      docs: [
        { name: "clip.mp4", kind: "file", sourcePath: mediaPath, url: null, content: null, sizeBytes: 9, charCount: null, contentHash: "h2" },
      ],
      chunks: [
        { doc: 0, seq: 1, content: "", charCount: 0, headingPath: null, charStart: null, charEnd: null, modality: "video", mediaPath, mediaIndex: 0, contentHash: null },
      ],
    };
    const imported = importKb(payload);

    // 安全契约：媒体块缺向量 → 不自动入队，即便文件在场也不自动触发嵌入请求
    const job = db.select().from(kbIngestJobs).where(eq(kbIngestJobs.kbId, imported.kb.id)).get();
    expect(job).toBeUndefined();
    const doc = db.select().from(knowledgeDocs).where(eq(knowledgeDocs.kbId, imported.kb.id)).get()!;
    expect(doc.status).toBe("ready");
    expect(doc.error).toContain("手动补齐向量");
    rmSync(mediaDir, { recursive: true, force: true });
  });

  test("modality 白名单：乱值落 null（按文本块处理），不再被当媒体块", () => {
    const payload: KbExportPayload = {
      format: KB_EXPORT_FORMAT,
      version: KB_EXPORT_VERSION,
      exportedAt: Date.now(),
      kb: {
        name: "白名单库",
        description: null,
        embeddingModel: "",
        embeddingBase: "",
        embeddingDim: null,
        rerankModel: "",
        chunkSize: 800,
        chunkOverlap: 120,
        topK: 6,
        minScore: 0,
        expandNeighbors: true,
        embedImage: true,
        embedAudio: false,
        embedVideo: false,
      },
      docs: [
        { name: "evil.png", kind: "file", sourcePath: "/tmp/x.png", url: null, content: null, sizeBytes: null, charCount: null, contentHash: "h4" },
      ],
      chunks: [
        { doc: 0, seq: 1, content: "", charCount: 0, headingPath: null, charStart: null, charEnd: null, modality: "attacker-controlled" as unknown as KbModality, mediaPath: "/tmp/x.png", mediaIndex: 0, contentHash: null, embedding: "dummy-vector" },
      ],
    };
    const imported = importKb(payload);

    const chunk = db.select().from(knowledgeChunks).where(eq(knowledgeChunks.kbId, imported.kb.id)).get()!;
    expect(chunk.modality).toBeNull();
    // 乱值被白名单拦下后该块按文本块处理：不触发媒体提示，向量已带 → 也不入队
    const doc = db.select().from(knowledgeDocs).where(eq(knowledgeDocs.kbId, imported.kb.id)).get()!;
    expect(doc.status).toBe("ready");
    expect(doc.error).toBeNull();
  });

  test("v1 旧载荷兼容：缺新字段按 false/null 读取，可正常导入", () => {
    const payload = {
      format: KB_EXPORT_FORMAT,
      version: 1,
      exportedAt: Date.now(),
      kb: {
        name: "旧版库",
        description: null,
        embeddingModel: "",
        embeddingBase: "",
        embeddingDim: null,
        rerankModel: "",
        chunkSize: 800,
        chunkOverlap: 120,
        topK: 6,
        minScore: 0,
        expandNeighbors: true,
      },
      docs: [{ name: "n.md", kind: "note", sourcePath: null, url: null, content: "旧正文", sizeBytes: null, charCount: 3, contentHash: "h3" }],
      chunks: [
        { doc: 0, seq: 1, content: "旧正文", charCount: 3, headingPath: null, charStart: null, charEnd: null, contentHash: "h3", embedding: "dummy-old-vector" },
      ],
    };
    const imported = importKb(payload);
    expect(imported.kb.embedImage).toBe(false);
    expect(imported.kb.embedAudio).toBe(false);
    expect(imported.kb.embedVideo).toBe(false);
    const chunk = db.select().from(knowledgeChunks).where(eq(knowledgeChunks.kbId, imported.kb.id)).get()!;
    expect(chunk.modality).toBeNull();
    expect(chunk.mediaPath).toBeNull();
    expect(chunk.mediaIndex).toBeNull();
    expect(chunk.embedding).toBe("dummy-old-vector");

    const jobs = db.select().from(kbIngestJobs).where(eq(kbIngestJobs.kbId, imported.kb.id)).all();
    expect(jobs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 迁移：既有行回填默认值（0 / null）
// ---------------------------------------------------------------------------

/** 按journal顺序手工重放迁移 SQL（drizzle migrator 之外的最小实现，只用于测试）。 */
function replayMigrations(sqlite: Database, maxIdx: number, minIdx = 0): void {
  const migDir = join(import.meta.dir, "db/migrations");
  const journal = JSON.parse(readFileSync(join(migDir, "meta/_journal.json"), "utf8")) as {
    entries: { idx: number; tag: string }[];
  };
  for (const entry of journal.entries) {
    if (entry.idx > maxIdx || entry.idx < minIdx) continue;
    const raw = readFileSync(join(migDir, `${entry.tag}.sql`), "utf8");
    for (const stmt of raw.split("--> statement-breakpoint")) {
      if (stmt.trim()) sqlite.exec(stmt);
    }
  }
}

describe("迁移默认值", () => {
  test("旧库升级：既有 knowledge_bases 行三布尔回填 0，knowledge_chunks 行三列为 null", () => {
    const file = join(tmpdir(), `kb-mm-mig-${process.pid}-old.db`);
    rmSync(file, { force: true });
    const sqlite = new Database(file, { create: true });
    // 重放到 0028（新迁移之前）→ 造「既有行」→ 应用末条（多模态六列，合并 main 后重编号为 0032）
    replayMigrations(sqlite, 28);
    sqlite.exec("INSERT INTO knowledge_bases (name) VALUES ('旧库')");
    sqlite.exec("INSERT INTO knowledge_docs (kb_id, name, kind, status) VALUES (1, '旧文档', 'file', 'ready')");
    sqlite.exec("INSERT INTO knowledge_chunks (kb_id, doc_id, seq, content, char_count) VALUES (1, 1, 1, 'x', 1)");

    const newMigration = JSON.parse(
      readFileSync(join(import.meta.dir, "db/migrations/meta/_journal.json"), "utf8"),
    ) as { entries: { idx: number; tag: string }[] };
    const last = newMigration.entries[newMigration.entries.length - 1]!;
    // 多模态六列必须一直排在 journal 末位（合并 main 的 0029-0031 后由 0029 重编号为
    // 0032，再合并 v0.1.0 的 0032-0036 后重编号为 0037）：位置错了说明编号被别的迁移
    // 挤到前面，老库升级时会被时间戳比较静默跳过。
    expect(last.tag).toBe("0037_tired_vanisher");
    expect(last.idx).toBe(37);
    replayMigrations(sqlite, last.idx, last.idx);

    const kbRow = sqlite.query("SELECT embed_image, embed_audio, embed_video FROM knowledge_bases WHERE id = 1").get() as Record<string, number>;
    expect(kbRow.embed_image).toBe(0);
    expect(kbRow.embed_audio).toBe(0);
    expect(kbRow.embed_video).toBe(0);
    const chunkRow = sqlite.query("SELECT modality, media_path, media_index FROM knowledge_chunks WHERE id = 1").get() as Record<string, unknown>;
    expect(chunkRow.modality).toBeNull();
    expect(chunkRow.media_path).toBeNull();
    expect(chunkRow.media_index).toBeNull();
    sqlite.close();
    rmSync(file, { force: true });
  });

  test("新库：省略新列的插入落默认值（0 / null）", () => {
    const file = join(tmpdir(), `kb-mm-mig-${process.pid}-new.db`);
    rmSync(file, { force: true });
    const sqlite = new Database(file, { create: true });
    replayMigrations(sqlite, 37);
    sqlite.exec("INSERT INTO knowledge_bases (name) VALUES ('新库')");
    sqlite.exec("INSERT INTO knowledge_docs (kb_id, name, kind, status) VALUES (1, 'd', 'file', 'ready')");
    sqlite.exec("INSERT INTO knowledge_chunks (kb_id, doc_id, seq, content, char_count) VALUES (1, 1, 1, 'x', 1)");
    const kbRow = sqlite.query("SELECT embed_image, embed_audio, embed_video FROM knowledge_bases").get() as Record<string, number>;
    expect([kbRow.embed_image, kbRow.embed_audio, kbRow.embed_video]).toEqual([0, 0, 0]);
    const chunkRow = sqlite.query("SELECT modality, media_path, media_index FROM knowledge_chunks").get() as Record<string, unknown>;
    expect([chunkRow.modality, chunkRow.media_path, chunkRow.media_index]).toEqual([null, null, null]);
    sqlite.close();
    rmSync(file, { force: true });
  });
});
