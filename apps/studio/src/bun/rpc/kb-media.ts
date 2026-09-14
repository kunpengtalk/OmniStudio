/**
 * 知识库分块的媒体表示（RPC `kbChunkMedia` 的实现体）。
 *
 * 独立成文件而非内联在 rpc/index.ts：后者 import 期就会初始化 electrobun 运行时
 * （BrowserView.defineRPC），在 `bun test` 里直接 import 它会挂住事件循环；拆出
 * 只依赖 db + sharp 的实现体后，RPC handler 只做一行转发，测试走
 * knowledge-multimodal 同款子进程隔离（kb-media.test.ts / kb-media.tests.ts）。
 */
import { eq } from "drizzle-orm";
import { statSync } from "fs";
import path from "path";
import sharp from "sharp";

import { db } from "../db";
import { knowledgeChunks } from "../db/schema";
import type { KbModality } from "../../shared/knowledge";

/** 缩略图最长边（引用浮层 / 分块列表展示足够，base64 体积可控）。 */
const THUMB_MAX_EDGE = 512;
const THUMB_JPEG_QUALITY = 80;
/** 输入侧护栏：超过 64MB 的「图片」不进 sharp（缩略图场景无意义，防读入内存尖峰）。 */
const THUMB_MAX_INPUT_BYTES = 64 * 1024 * 1024;
/** sharp 解码像素上限（约 100MP；默认 268MP 的解码峰值过大）。 */
const THUMB_LIMIT_INPUT_PIXELS = 100_000_000;

export type KbChunkMediaView = {
  /** 图片 = `data:image/jpeg;base64,...` 缩略图；音视频/文本/文件缺失为 null（UI 走图标兜底）。 */
  dataUrl: string | null;
  /** 文本块为 null。 */
  modality: KbModality | null;
  /** = basename(mediaPath)；文本块为 ""。 */
  fileName: string;
};

/**
 * 取一个分块的媒体表示：图片 → sharp 缩略成 data URL；音视频只回元信息
 * （不回字节，打开原文件复用既有 openPath）；文本块/文件缺失/超大文件
 * （>64MB）/解码失败统一降级为 null dataUrl，元信息（modality/fileName）
 * 仍返回，UI 兜底显示图标。
 */
export async function chunkMediaForRpc(chunkId: number): Promise<KbChunkMediaView> {
  const row = db
    .select({ modality: knowledgeChunks.modality, mediaPath: knowledgeChunks.mediaPath })
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.id, chunkId))
    .get();
  if (!row) throw new Error("分块不存在");

  const fileName = row.mediaPath ? path.basename(row.mediaPath) : "";
  const fallback: KbChunkMediaView = { dataUrl: null, modality: row.modality, fileName };
  // 文本块（无 modality）：没有可展示的媒体，元信息照样给
  if (!row.modality || !row.mediaPath) return fallback;
  // 音视频：不回字节，UI 显示图标 + 文件名
  if (row.modality !== "image") return fallback;

  // stat 预检：文件缺失（statSync 抛错）/ 超大文件（>64MB）都不进 sharp，直接图标兜底
  let inputBytes: number;
  try {
    inputBytes = statSync(row.mediaPath).size;
    if (inputBytes > THUMB_MAX_INPUT_BYTES) return fallback;
  } catch {
    return fallback;
  }

  try {
    const thumb = await sharp(row.mediaPath, {
      failOnError: false,
      limitInputPixels: THUMB_LIMIT_INPUT_PIXELS,
      sequentialRead: true,
    })
      .rotate() // 按 EXIF 摆正，竖拍照片的缩略图不横着
      .resize({ width: THUMB_MAX_EDGE, height: THUMB_MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: THUMB_JPEG_QUALITY })
      .toBuffer();
    return { dataUrl: `data:image/jpeg;base64,${thumb.toString("base64")}`, modality: row.modality, fileName };
  } catch {
    // 损坏/无法解码的图片：降级为图标兜底，不拖垮整个分块列表
    return fallback;
  }
}
