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

  test("不存在的 chunkId：抛「分块不存在」", async () => {
    await expect(chunkMediaForRpc(4_000_000_000)).rejects.toThrow("分块不存在");
  });
});
