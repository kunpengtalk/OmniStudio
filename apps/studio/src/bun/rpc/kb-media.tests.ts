/**
 * RPC kbChunkMedia 测试（真测试体，由 kb-media.test.ts 子进程隔离跑）。
 *
 * 子进程里没有泄漏进来的 mock，bunfig 的 test-preload 把数据目录指到临时目录；
 * 本文件只 import 安全模块（./kb-media → db + sharp），不 import rpc/index.ts
 * （后者 import 期初始化 electrobun 运行时，会把事件循环挂住）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { eq } from "drizzle-orm";
import sharp from "sharp";

import { chunkMediaForRpc } from "./kb-media";
import { db } from "../db";
import { knowledgeChunks, knowledgeDocs } from "../db/schema";
import { createKb } from "../knowledge";

/** 建库 + 建文档，返回 { kbId, docId }（chunk 行由各用例自行落库）。 */
function setupDoc(name: string): { kbId: number; docId: number } {
  const kb = createKb({ name });
  const doc = db
    .insert(knowledgeDocs)
    .values({ kbId: kb.id, name: "media.png", kind: "file", status: "ready" })
    .returning().get();
  return { kbId: kb.id, docId: doc.id };
}

/** 落一个分块行，返回 chunk id。 */
function insertChunk(
  kbId: number,
  docId: number,
  values: { seq: number; content?: string; modality?: "image" | "audio" | "video" | null; mediaPath?: string | null },
): number {
  const row = db
    .insert(knowledgeChunks)
    .values({
      kbId,
      docId,
      seq: values.seq,
      content: values.content ?? "",
      charCount: (values.content ?? "").length,
      modality: values.modality ?? null,
      mediaPath: values.mediaPath ?? null,
    })
    .returning()
    .get();
  return row!.id;
}

describe("chunkMediaForRpc", () => {
  test("图片：缩略成 ≤512px 的 JPEG dataUrl，文件名取 basename", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-media-"));
    const photoPath = join(dir, "photo.png");
    await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 100, b: 50 } } })
      .png()
      .toFile(photoPath);

    const { kbId, docId } = setupDoc("媒体 RPC 图片库");
    const chunkId = insertChunk(kbId, docId, { seq: 1, modality: "image", mediaPath: photoPath });

    const view = await chunkMediaForRpc(chunkId);
    expect(view.modality).toBe("image");
    expect(view.fileName).toBe("photo.png");
    expect(view.dataUrl).toStartWith("data:image/jpeg;base64,");

    // base64 可解码，且解码后确实是最长边 ≤512 的 JPEG（800×600 → 512×384）
    const b64 = view.dataUrl!.slice("data:image/jpeg;base64,".length);
    const meta = await sharp(Buffer.from(b64, "base64")).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(384);

    rmSync(dir, { recursive: true, force: true });
  });

  test("小图不放大：100×80 原样尺寸重编码为 JPEG", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-media-"));
    const smallPath = join(dir, "small.png");
    await sharp({ create: { width: 100, height: 80, channels: 3, background: { r: 10, g: 120, b: 240 } } })
      .png()
      .toFile(smallPath);

    const { kbId, docId } = setupDoc("媒体 RPC 小图库");
    const chunkId = insertChunk(kbId, docId, { seq: 1, modality: "image", mediaPath: smallPath });

    const view = await chunkMediaForRpc(chunkId);
    const b64 = view.dataUrl!.slice("data:image/jpeg;base64,".length);
    const meta = await sharp(Buffer.from(b64, "base64")).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(80);

    rmSync(dir, { recursive: true, force: true });
  });

  test("音视频：dataUrl=null，modality/fileName 照常返回", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-media-"));
    const clipPath = join(dir, "clip.mp3");
    writeFileSync(clipPath, "not-really-audio");

    const { kbId, docId } = setupDoc("媒体 RPC 音频库");
    const chunkId = insertChunk(kbId, docId, { seq: 1, modality: "audio", mediaPath: clipPath });

    const view = await chunkMediaForRpc(chunkId);
    expect(view.dataUrl).toBeNull();
    expect(view.modality).toBe("audio");
    expect(view.fileName).toBe("clip.mp3");

    rmSync(dir, { recursive: true, force: true });
  });

  test("文本块：dataUrl=null、modality=null、fileName 空", async () => {
    const { kbId, docId } = setupDoc("媒体 RPC 文本库");
    const chunkId = insertChunk(kbId, docId, { seq: 1, content: "纯文字" });

    const view = await chunkMediaForRpc(chunkId);
    expect(view.dataUrl).toBeNull();
    expect(view.modality).toBeNull();
    expect(view.fileName).toBe("");
  });

  test("图片文件缺失：dataUrl=null，modality/fileName 仍返回", async () => {
    const missingPath = "/nonexistent/kb-media/shot.png";
    const { kbId, docId } = setupDoc("媒体 RPC 缺文件库");
    const chunkId = insertChunk(kbId, docId, { seq: 1, modality: "image", mediaPath: missingPath });

    const view = await chunkMediaForRpc(chunkId);
    expect(view.dataUrl).toBeNull();
    expect(view.modality).toBe("image");
    expect(view.fileName).toBe("shot.png");
  });

  test("超大文件（>64MB，稀疏文件）：dataUrl=null 不抛错，不进 sharp", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-media-"));
    const bigPath = join(dir, "huge.png");
    // 稀疏文件：先建空文件再 truncate，不写数据、瞬间得到 stat 大小 64MB+1（超过 THUMB_MAX_INPUT_BYTES）
    writeFileSync(bigPath, "");
    truncateSync(bigPath, 64 * 1024 * 1024 + 1);
    expect(statSync(bigPath).size).toBe(64 * 1024 * 1024 + 1);

    const { kbId, docId } = setupDoc("媒体 RPC 超大图库");
    const chunkId = insertChunk(kbId, docId, { seq: 1, modality: "image", mediaPath: bigPath });

    const view = await chunkMediaForRpc(chunkId);
    expect(view.dataUrl).toBeNull();
    expect(view.modality).toBe("image");
    expect(view.fileName).toBe("huge.png");

    rmSync(dir, { recursive: true, force: true });
  });

  test("full 档：输出最长边 2048（>512），thumb 缺省仍 512", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-media-"));
    const bigPath = join(dir, "big.png");
    await sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 50, g: 150, b: 250 } } })
      .png()
      .toFile(bigPath);

    const { kbId, docId } = setupDoc("媒体 RPC full 档库");
    const chunkId = insertChunk(kbId, docId, { seq: 1, modality: "image", mediaPath: bigPath });

    // 缺省（= "thumb"）与显式 "thumb" 一致：最长边 512
    const defaultView = await chunkMediaForRpc(chunkId);
    const explicitThumbView = await chunkMediaForRpc(chunkId, "thumb");
    for (const view of [defaultView, explicitThumbView]) {
      const b64 = view.dataUrl!.slice("data:image/jpeg;base64,".length);
      const meta = await sharp(Buffer.from(b64, "base64")).metadata();
      expect(meta.format).toBe("jpeg");
      expect(meta.width).toBe(512);
      expect(meta.height).toBe(341); // 3000×2000 → 512×341
    }

    // full 档：最长边 2048（>512 且 ≤2048）
    const fullView = await chunkMediaForRpc(chunkId, "full");
    const b64 = fullView.dataUrl!.slice("data:image/jpeg;base64,".length);
    const meta = await sharp(Buffer.from(b64, "base64")).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(2048);
    expect(meta.height).toBe(1365); // 3000×2000 → 2048×1365

    rmSync(dir, { recursive: true, force: true });
  });

  test("新字段 mediaPath/text：图片块回 OCR 文本与原路径，纯媒体块 text 为空串", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-media-"));
    const photoPath = join(dir, "scan.png");
    await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 20, g: 20, b: 20 } } })
      .png()
      .toFile(photoPath);

    const { kbId, docId } = setupDoc("媒体 RPC 新字段库");
    const ocrChunkId = insertChunk(kbId, docId, {
      seq: 1,
      content: "OCR 识别的文本",
      modality: "image",
      mediaPath: photoPath,
    });
    const pureMediaChunkId = insertChunk(kbId, docId, { seq: 2, content: "", modality: "image", mediaPath: photoPath });

    const ocrView = await chunkMediaForRpc(ocrChunkId);
    expect(ocrView.mediaPath).toBe(photoPath);
    expect(ocrView.text).toBe("OCR 识别的文本");

    // 纯媒体块：content 列 NOT NULL，合法为空串 —— text 应为 "" 而非 null
    const pureView = await chunkMediaForRpc(pureMediaChunkId);
    expect(pureView.mediaPath).toBe(photoPath);
    expect(pureView.text).toBe("");

    rmSync(dir, { recursive: true, force: true });
  });

  test("PDF 文件：sharp 解不了 → dataUrl null 降级，元信息照常（页块行为不变）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-media-"));
    const pdfPath = join(dir, "page.pdf");
    // 最小可识别 PDF：魔数 + 头部，正文残缺 —— 预编译 libvips 不支持 PDF 解码，
    // 只验证「解码失败 → catch 兜底」这条降级链路
    writeFileSync(
      pdfPath,
      "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\ntrailer<</Root 1 0 R/Size 3>>\n%%EOF\n",
      "utf8",
    );

    const { kbId, docId } = setupDoc("媒体 RPC PDF 库");
    // PDF 页块与图片块同为 image modality：页块走同一链路，降级行为必须一致
    const chunkId = insertChunk(kbId, docId, { seq: 1, content: "页 OCR 文本", modality: "image", mediaPath: pdfPath });

    const view = await chunkMediaForRpc(chunkId);
    expect(view.dataUrl).toBeNull();
    expect(view.modality).toBe("image");
    expect(view.fileName).toBe("page.pdf");
    expect(view.mediaPath).toBe(pdfPath);
    expect(view.text).toBe("页 OCR 文本");

    rmSync(dir, { recursive: true, force: true });
  });

  test("音视频 full 档：同样 null 降级（既有行为回归）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-media-"));
    const clipPath = join(dir, "clip.mp4");
    writeFileSync(clipPath, "not-really-video");

    const { kbId, docId } = setupDoc("媒体 RPC 视频库");
    const chunkId = insertChunk(kbId, docId, { seq: 1, modality: "video", mediaPath: clipPath });

    const view = await chunkMediaForRpc(chunkId, "full");
    expect(view.dataUrl).toBeNull();
    expect(view.modality).toBe("video");
    expect(view.fileName).toBe("clip.mp4");

    rmSync(dir, { recursive: true, force: true });
  });

  test("不存在的 chunkId：抛「分块不存在」", async () => {
    await expect(chunkMediaForRpc(4_000_000_000)).rejects.toThrow("分块不存在");
  });
});
