/**
 * 知识库摄取管线多模态测试（真测试体，由 kb-ingest-multimodal.test.ts 子进程隔离跑）。
 *
 * 为什么套子进程 + mock.module：摄取管线串起 db / vllm(OCR) / embeddings(向量化)，
 * 而同批次的其他测试文件会对 ./db / ./db/settings 注册 mock.module（mock 注册表
 * 在同一批次跨文件共享，先例见 knowledge-multimodal.tests.ts 头注释），直接进批次
 * 会拿到别的文件桩出来的假模块。子进程里先注册自己的 mock 再动态 import 被测模块
 * （静态 import 会被提升到 mock 注册之前），顺序确定、无泄漏；bunfig 的
 * test-preload（临时数据目录）在子进程同样生效。
 *
 * 桩的口径：
 * - ./vllm：convertFileToImages 返回真实 Sharp 实例（媒体输入构造的 jpeg 重编码要
 *   真跑，断言 JPEG 魔数）；generate 按页序产 markdown、可注入单页失败；
 * - ./embeddings：callEmbeddings / callEmbeddingsMultimodal 记录入参并返回定长向量，
 *   断言「文本行批 32 / 媒体行逐条」的路由与 EmbeddingInput 形态。
 */
import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { and, eq, sql } from "drizzle-orm";
import sharp from "sharp";

// ---------------------------------------------------------------------------
// mock 先注册（必须在动态 import ./kb-ingest 之前）
// ---------------------------------------------------------------------------

let pdfPageCount = 1;
let ocrFailPages = new Set<number>();
let ocrCalls = 0;
let convertCalls = 0;
const convertPageRanges: (string | undefined)[] = [];
const embedTexts: string[][] = [];
const multimodalCalls: Record<string, unknown>[] = [];
let multimodalFail = false;

function resetMocks(): void {
  pdfPageCount = 1;
  ocrFailPages = new Set();
  ocrCalls = 0;
  convertCalls = 0;
  convertPageRanges.length = 0;
  embedTexts.length = 0;
  multimodalCalls.length = 0;
  multimodalFail = false;
}

async function fakePage(index: number) {
  // 宽度按页序错开，让各页 jpeg 字节天然不同
  const buf = await sharp({
    create: { width: 12 + index, height: 8, channels: 3, background: { r: 40, g: 90, b: 160 } },
  })
    .png()
    .toBuffer();
  return sharp(buf);
}

mock.module("./vllm", () => ({
  convertFileToImages: async (source: { name?: string | null }, config: { page_range?: string } = {}) => {
    convertCalls++;
    convertPageRanges.push(config.page_range);
    // 与真实 renderPdfPages 同口径：page_range 之外的页 continue（不渲染）
    const wanted = config.page_range?.trim()
      ? config.page_range
          .split(",")
          .map((s) => Number.parseInt(s.trim(), 10))
          .filter(Number.isFinite)
      : null;
    const count = source.name?.toLowerCase().endsWith(".pdf") ? pdfPageCount : 1;
    const images = [];
    for (let i = 0; i < count; i++) {
      if (wanted && !wanted.includes(i)) continue;
      images.push(await fakePage(i));
    }
    return images;
  },
  generate: async () => {
    // 页序取模：同一文档每页文本跨多次抽取保持稳定（doc 级指纹比较依赖这一点）
    const page = ocrCalls % pdfPageCount;
    ocrCalls++;
    if (ocrFailPages.has(page)) throw new Error("OCR 服务不可用");
    return [{ markdown: `OCR 第 ${page} 页`, error: null, errorMessage: null }];
  },
}));

const fakeVec = () => new Float32Array([0.1, 0.2, 0.3, 0.4]);

mock.module("./embeddings", () => ({
  globalEmbeddingDefaults: () => ({ model: "", base: "", apiKey: "" }),
  resolveEmbeddingBase: (cfg: { embeddingBase: string }) => cfg.embeddingBase.trim() || "http://127.0.0.1:9",
  embeddingHeaders: () => ({ "Content-Type": "application/json" }),
  callEmbeddings: async (_cfg: unknown, texts: string[]) => {
    embedTexts.push([...texts]);
    return texts.map(() => fakeVec());
  },
  callEmbeddingsMultimodal: async (_cfg: unknown, inputs: Record<string, unknown>[]) => {
    if (multimodalFail) {
      throw new Error('嵌入服务拒绝了多模态输入（content 形态 HTTP 500、data-URI 形态 HTTP 500）{"error":{}}');
    }
    for (const input of inputs) multimodalCalls.push({ ...input });
    return inputs.map(() => new Float32Array([0.5, 0.6, 0.7, 0.8]));
  },
  encodeEmbedding: (vec: Float32Array) => Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString("base64"),
  decodeEmbedding: (b64: string) => {
    const buf = Buffer.from(b64, "base64");
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  },
  cosine: () => 0,
}));

const { db } = await import("./db");
const { kbEvents, kbIngestJobs, knowledgeBases, knowledgeChunks, knowledgeDocs } = await import("./db/schema");
const { enqueueDoc, awaitKbIdle, dropDocJob, textContentHash } = await import("./kb-ingest");
const { invalidateKbIndex } = await import("./kb-index");
const { handleMcpRequest } = await import("./kb-mcp");
const { buildAgentTools } = await import("./agent-tools");

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function createKbRow(opts: { embedImage?: number; embedAudio?: number; embedVideo?: number; embeddingModel?: string }): number {
  const row = db
    .insert(knowledgeBases)
    .values({
      name: `ingest-mm-${Math.random().toString(36).slice(2, 8)}`,
      embeddingModel: opts.embeddingModel ?? "test-embed-model",
      embedImage: opts.embedImage ?? 0,
      embedAudio: opts.embedAudio ?? 0,
      embedVideo: opts.embedVideo ?? 0,
    })
    .returning()
    .get();
  return row!.id;
}

function createDocRow(kbId: number, name: string, sourcePath: string): number {
  const row = db
    .insert(knowledgeDocs)
    .values({ kbId, name, kind: "file", sourcePath, status: "pending" })
    .returning()
    .get();
  return row!.id;
}

function tempMediaDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function chunkRows(docId: number) {
  return db.select().from(knowledgeChunks).where(eq(knowledgeChunks.docId, docId)).all();
}

/** 轮询作业的 lastError（第一次尝试失败即返回，不等满 3 次退避重试）。 */
async function waitForJobError(docId: number, substr: string, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = db.select().from(kbIngestJobs).where(eq(kbIngestJobs.docId, docId)).get();
    if (job?.lastError?.includes(substr)) return job.lastError;
    if (Date.now() > deadline) throw new Error(`等待作业错误超时（lastError: ${job?.lastError ?? "空"}）`);
    await Bun.sleep(20);
  }
}

// ---------------------------------------------------------------------------
// 摄取分流：音视频 / 图片
// ---------------------------------------------------------------------------

describe("媒体直嵌摄取分流", () => {
  test("音视频未勾对应模态 → 明确报错指引（语音 / 视频）", async () => {
    resetMocks();
    const dir = tempMediaDir("kb-ing-mm-av-");
    const kbId = createKbRow({});
    for (const [name, label] of [
      ["clip.mp3", "语音"],
      ["clip.mp4", "视频"],
    ] as const) {
      const p = join(dir, name);
      writeFileSync(p, "fake-bytes");
      const docId = createDocRow(kbId, name, p);
      enqueueDoc(docId, { kind: "ingest" });
      const err = await waitForJobError(docId, `未启用${label}直嵌`);
      expect(err).toContain(`该库未启用${label}直嵌（知识库设置 → 模态能力）`);
      dropDocJob(docId);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("勾选语音 → 单 unit、零 OCR、零转图，块行三列与 contentHash 语义；纯媒体块不触发空正文 throw", async () => {
    resetMocks();
    const dir = tempMediaDir("kb-ing-mm-audio-");
    const p = join(dir, "clip.mp3");
    writeFileSync(p, "fake-audio-bytes");
    const kbId = createKbRow({ embedAudio: 1 });
    const docId = createDocRow(kbId, "clip.mp3", p);

    enqueueDoc(docId, { kind: "ingest" });
    expect(await awaitKbIdle(kbId)).toBe(true);

    const rows = chunkRows(docId);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.modality).toBe("audio");
    expect(r.mediaPath).toBe(p);
    expect(r.mediaIndex).toBe(0);
    expect(r.content).toBe("");
    expect(r.charCount).toBe(0);
    expect(r.headingPath).toBeNull();
    expect(r.charStart).toBeNull();
    expect(r.charEnd).toBeNull();
    // contentHash = hash(modality|mediaPath|mediaIndex|text)
    expect(r.contentHash).toBe(textContentHash(`audio|${p}|0|`));
    // 零 OCR、零转图（音视频不走 OCR）
    expect(ocrCalls).toBe(0);
    expect(convertCalls).toBe(0);
    // 多模态嵌入逐条调用：音频 b64 + 扩展名 format，空正文无联合文本
    expect(multimodalCalls).toHaveLength(1);
    const input = multimodalCalls[0]! as Record<string, unknown>;
    expect(input.audioB64).toBe(Buffer.from("fake-audio-bytes").toString("base64"));
    expect(input.audioFormat).toBe("mp3");
    expect(input.text).toBeUndefined();
    expect(input.imageB64).toBeUndefined();
    // doc 就绪（content 为空但成功入库 —— 显式绕过「未提取到正文内容」的实证）
    const doc = db.select().from(knowledgeDocs).where(eq(knowledgeDocs.id, docId)).get()!;
    expect(doc.status).toBe("ready");
    expect(doc.chunkCount).toBe(1);
    expect(doc.embeddedCount).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  test("勾选图片：两页 PDF → 每页一块（mediaIndex 0/1），单页 OCR 失败降级空文本不阻断", async () => {
    resetMocks();
    pdfPageCount = 2;
    ocrFailPages = new Set([1]);
    const dir = tempMediaDir("kb-ing-mm-pdf-");
    const p = join(dir, "scan.pdf");
    writeFileSync(p, "%PDF-fake-bytes");
    const kbId = createKbRow({ embedImage: 1 });
    const docId = createDocRow(kbId, "scan.pdf", p);

    enqueueDoc(docId, { kind: "ingest" });
    expect(await awaitKbIdle(kbId)).toBe(true);

    const rows = chunkRows(docId).sort((a, b) => a.seq - b.seq);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.mediaIndex, r.content])).toEqual([
      [0, "OCR 第 0 页"],
      [1, ""],
    ]);
    expect(rows.every((r) => r.modality === "image" && r.mediaPath === p)).toBe(true);
    expect(rows.every((r) => r.headingPath === null && r.charStart === null && r.charEnd === null)).toBe(true);
    expect(rows[1]!.contentHash).toBe(textContentHash(`image|${p}|1|`));
    expect(ocrCalls).toBe(2);
    // M1：抽取全量渲染一次（无 page_range）；嵌入逐页只渲染目标页（page_range 单页），
    // 避免每个媒体行都全量渲染整份 PDF 的 O(N²)
    expect(convertPageRanges).toEqual([undefined, "0", "1"]);
    // 两页逐条多模态嵌入，图片输入是真实 jpeg 重编码（JPEG 魔数 FFD8），文本=OCR 联合
    expect(multimodalCalls).toHaveLength(2);
    for (const call of multimodalCalls) {
      const jpeg = Buffer.from(call.imageB64 as string, "base64");
      expect(jpeg[0]).toBe(0xff);
      expect(jpeg[1]).toBe(0xd8);
    }
    expect(multimodalCalls[0]!.text).toBe("scan.pdf\nOCR 第 0 页");
    expect(multimodalCalls[1]!.text).toBeUndefined();
    const doc = db.select().from(knowledgeDocs).where(eq(knowledgeDocs.id, docId)).get()!;
    expect(doc.status).toBe("ready");
    rmSync(dir, { recursive: true, force: true });
  });

  test("未勾图片 → 走 extractFileText 老路径：OCR 文本管线，块行无 modality（验收 ③）", async () => {
    resetMocks();
    const dir = tempMediaDir("kb-ing-mm-txt-");
    const p = join(dir, "photo.png");
    writeFileSync(p, "fake-png-bytes");
    const kbId = createKbRow({}); // embedImage = 0
    const docId = createDocRow(kbId, "photo.png", p);

    enqueueDoc(docId, { kind: "ingest" });
    expect(await awaitKbIdle(kbId)).toBe(true);

    // 老路径：extractFileText 的转图 + OCR 被调用；多模态客户端零调用
    expect(convertCalls).toBe(1);
    expect(ocrCalls).toBe(1);
    expect(multimodalCalls).toHaveLength(0);
    expect(embedTexts).toHaveLength(1);
    expect(embedTexts[0]![0]).toBe("photo.png\nOCR 第 0 页");
    const rows = chunkRows(docId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.modality).toBeNull();
    expect(rows[0]!.mediaPath).toBeNull();
    expect(rows[0]!.mediaIndex).toBeNull();
    expect(rows[0]!.content).toBe("OCR 第 0 页");
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// doc 级 skip：指纹 + mtime + size
// ---------------------------------------------------------------------------

describe("媒体 doc 级 skip 判定", () => {
  test("字节未变再摄取 → skip（块行原样）；字节替换而 OCR 巧合不变 → 必重建", async () => {
    resetMocks();
    pdfPageCount = 2;
    const dir = tempMediaDir("kb-ing-mm-skip-");
    const p = join(dir, "scan.pdf");
    writeFileSync(p, "original-bytes");
    const kbId = createKbRow({ embedImage: 1 });
    const docId = createDocRow(kbId, "scan.pdf", p);

    enqueueDoc(docId, { kind: "ingest" });
    expect(await awaitKbIdle(kbId)).toBe(true);

    const skippedCount = () =>
      Number(
        db
          .select({ c: sql<number>`count(*)` })
          .from(kbEvents)
          .where(and(eq(kbEvents.docId, docId), eq(kbEvents.action, "doc_skipped")))
          .get()!.c,
      );

    // 1) 文件不动、重新入队：抽取会复跑（与文本路径同架构），但指纹 + mtime/size 全同 → skip
    enqueueDoc(docId, { kind: "ingest", resetAttempts: true });
    expect(await awaitKbIdle(kbId)).toBe(true);
    expect(skippedCount()).toBe(1);

    // 2) 替换文件字节（mtime 变），OCR stub 输出巧合不变 → 必重建：skip 不再发生，
    //    writeMediaChunks 落库了新 mtime（skip 路径从不改 sourceMtime）
    writeFileSync(p, "REPLACED-bytes");
    utimesSync(p, new Date(), new Date(Date.now() + 10_000));
    enqueueDoc(docId, { kind: "ingest", resetAttempts: true });
    expect(await awaitKbIdle(kbId)).toBe(true);
    expect(skippedCount()).toBe(1); // 没有再次 skip
    const rebuilt = chunkRows(docId).sort((a, b) => a.seq - b.seq);
    expect(rebuilt).toHaveLength(2);
    expect(rebuilt[0]!.mediaIndex).toBe(0);
    const doc = db.select().from(knowledgeDocs).where(eq(knowledgeDocs.id, docId)).get()!;
    expect(doc.status).toBe("ready");
    expect(doc.sourceMtime).toBe(Math.floor((await import("fs")).statSync(p).mtimeMs));
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// embedDocChunks 混合批路由
// ---------------------------------------------------------------------------

describe("embedDocChunks 混合批路由", () => {
  test("34 文本块 + 1 图片块：文本行批 ≤32 走 callEmbeddings，媒体行逐条 multimodal（jpeg b64 + 联合文本）", async () => {
    resetMocks();
    const dir = tempMediaDir("kb-ing-mm-mix-");
    const p = join(dir, "photo.png");
    writeFileSync(p, "fake-png-bytes");
    const kbId = createKbRow({});
    const docId = createDocRow(kbId, "photo.png", p);

    const textRows = Array.from({ length: 34 }, (_, i) => ({
      kbId,
      docId,
      seq: i + 1,
      content: `文本段落 ${i}`,
      charCount: 6,
    }));
    // 媒体块插在最后：OCR 文本非空 → 联合文本 = contextText(docName, null, content)
    const mediaRow = {
      kbId,
      docId,
      seq: 35,
      content: "扫描页文字",
      charCount: 5,
      modality: "image",
      mediaPath: p,
      mediaIndex: 0,
    };
    db.insert(knowledgeChunks).values([...textRows, mediaRow]).run();
    db.update(knowledgeDocs).set({ chunkCount: 35, status: "ready" }).where(eq(knowledgeDocs.id, docId)).run();

    enqueueDoc(docId, { kind: "embed" });
    expect(await awaitKbIdle(kbId)).toBe(true);

    // 文本行走 callEmbeddings：总量 34、批 ≤32（>32 必然分多批）
    expect(embedTexts.reduce((n, b) => n + b.length, 0)).toBe(34);
    expect(embedTexts.every((b) => b.length <= 32)).toBe(true);
    expect(embedTexts.length).toBeGreaterThanOrEqual(2);
    // 媒体行逐条走多模态：图 = 真实 jpeg 重编码，text = contextText 联合文本
    expect(multimodalCalls).toHaveLength(1);
    const input = multimodalCalls[0]! as Record<string, unknown>;
    const jpeg = Buffer.from(input.imageB64 as string, "base64");
    expect(jpeg[0]).toBe(0xff);
    expect(jpeg[1]).toBe(0xd8);
    expect(input.text).toBe("photo.png\n扫描页文字");
    // 全部落向量
    expect(chunkRows(docId).every((r) => r.embedding)).toBe(true);
    const doc = db.select().from(knowledgeDocs).where(eq(knowledgeDocs.id, docId)).get()!;
    expect(doc.status).toBe("ready");
    expect(doc.embeddedCount).toBe(35);
    rmSync(dir, { recursive: true, force: true });
  });

  test("首个媒体行嵌入失败 → 错误前缀含「检查模态勾选」指引，底层细节保留", async () => {
    resetMocks();
    multimodalFail = true;
    const dir = tempMediaDir("kb-ing-mm-fail-");
    const p = join(dir, "photo.png");
    writeFileSync(p, "fake-png-bytes");
    const kbId = createKbRow({});
    const docId = createDocRow(kbId, "photo.png", p);
    db.insert(knowledgeChunks)
      .values({ kbId, docId, seq: 1, content: "页面文字", charCount: 4, modality: "image", mediaPath: p, mediaIndex: 0 })
      .run();
    db.update(knowledgeDocs).set({ chunkCount: 1, status: "ready" }).where(eq(knowledgeDocs.id, docId)).run();

    enqueueDoc(docId, { kind: "embed" });
    const err = await waitForJobError(docId, "检查该库的模态勾选");
    expect(err).toContain("嵌入服务拒绝了多模态输入，请检查该库的模态勾选与嵌入模型");
    expect(err).toContain("HTTP 500"); // 嵌入客户端自身的细节被保留
    dropDocJob(docId);
    rmSync(dir, { recursive: true, force: true });
  });

  test("embed 续跑时源文件被删 → 报「媒体文件缺失」（自身语义，不被误包成服务拒绝）", async () => {
    resetMocks();
    const dir = tempMediaDir("kb-ing-mm-del-");
    const p = join(dir, "gone.png");
    writeFileSync(p, "soon-deleted");
    const kbId = createKbRow({});
    const docId = createDocRow(kbId, "gone.png", p);
    db.insert(knowledgeChunks)
      .values({ kbId, docId, seq: 1, content: "", charCount: 0, modality: "image", mediaPath: p, mediaIndex: 0 })
      .run();
    db.update(knowledgeDocs).set({ chunkCount: 1, status: "ready" }).where(eq(knowledgeDocs.id, docId)).run();
    rmSync(p, { force: true }); // 续跑前文件被删

    enqueueDoc(docId, { kind: "embed" });
    const err = await waitForJobError(docId, "媒体文件缺失");
    expect(err).toContain("媒体文件缺失");
    expect(err).toContain(p);
    expect(err).not.toContain("检查该库的模态勾选");
    dropDocJob(docId);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// MCP / Agent 工具输出标记
// ---------------------------------------------------------------------------

describe("kb_search / knowledge_search 媒体命中标记", () => {
  /** 造一个纯关键词库：1 文本块 + 1 空正文图片块，靠文件名 token 命中媒体块。 */
  function setupKeywordKb(name: string): string {
    const kbName = `mcp-mm-${Math.random().toString(36).slice(2, 8)}`;
    const kbId = createKbRow({ embeddingModel: "" });
    db.update(knowledgeBases)
      .set({ name: kbName })
      .where(eq(knowledgeBases.id, kbId))
      .run();
    const doc = db
      .insert(knowledgeDocs)
      .values({ kbId, name, kind: "note", status: "ready" })
      .returning()
      .get();
    db.insert(knowledgeChunks)
      .values([
        { kbId, docId: doc!.id, seq: 1, content: "quantum alpha report", charCount: 20 },
        {
          kbId,
          docId: doc!.id,
          seq: 2,
          content: "",
          charCount: 0,
          modality: "image",
          mediaPath: join(tmpdir(), name),
          mediaIndex: 0,
        },
      ])
      .run();
    invalidateKbIndex(kbId);
    return kbName;
  }

  test("kb_search（MCP）：媒体命中行首带 [图片] 文件名标记，空正文不呈现空行", async () => {
    resetMocks();
    const kbName = setupKeywordKb("quantum.png");
    const res = await handleMcpRequest(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "kb_search", arguments: { query: "quantum", kb: kbName } },
        }),
      }),
    );
    const json = (await res.json()) as { result?: { content?: { text?: string }[] } };
    const text = json.result?.content?.[0]?.text ?? "";
    expect(text).toContain("[图片] quantum.png");
    expect(text).toContain("《quantum.png》分块 2");
  });

  test("knowledge_search（Agent 工具）：媒体命中带同款标记", async () => {
    resetMocks();
    const agentKbName = setupKeywordKb("beacon.png");
    const tools = buildAgentTools({ workspace: process.cwd(), allowShell: false });
    const tool = tools.find((t) => t.name === "knowledge_search");
    expect(tool).toBeDefined();
    const result = await tool!.execute("t1", { query: "beacon", kb: agentKbName }, undefined);
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(text).toContain("[图片] beacon.png");
  });
});
