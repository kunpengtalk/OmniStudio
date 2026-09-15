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
/** full 档最长边（系统查看原图体验，体积仍可控）。 */
const FULL_MAX_EDGE = 2048;
const FULL_JPEG_QUALITY = 85;
/** 输入侧护栏：超过 64MB 的「图片」不进 sharp（缩略图场景无意义，防读入内存尖峰）。 */
const THUMB_MAX_INPUT_BYTES = 64 * 1024 * 1024;
/** sharp 解码像素上限（约 100MP；默认 268MP 的解码峰值过大）。 */
const THUMB_LIMIT_INPUT_PIXELS = 100_000_000;

export type KbChunkMediaView = {
  /** 图片 = `data:image/jpeg;base64,...`（尺寸随 size 档位）；音视频/文本/文件缺失为 null（UI 走图标兜底）。 */
  dataUrl: string | null;
  /** 文本块为 null。 */
  modality: KbModality | null;
  /** = basename(mediaPath)；文本块为 ""。 */
  fileName: string;
  /** = media_path 列（原文件路径，系统打开用）；缺失为 null。 */
  mediaPath: string | null;
  /** 块 content 列（图片块 = OCR 文本；纯媒体块合法为空串）。 */
  text: string | null;
};

/**
 * 取一个分块的媒体表示：图片 → sharp 按 size 档位缩放成 data URL（"thumb" 512/80，
 * "full" 2048/85；缺省 = "thumb"，行为与历史版本一致）；音视频只回元信息（不回字节，
 * 打开原文件复用既有 openPath）；文本块/文件缺失/超大文件（>64MB）/解码失败统一降级
 * 为 null dataUrl，元信息（modality/fileName/mediaPath/text）仍返回，UI 兜底显示图标。
 */
export async function chunkMediaForRpc(
  chunkId: number,
  size: "thumb" | "full" = "thumb",
): Promise<KbChunkMediaView> {
  const row = db
    .select({
      modality: knowledgeChunks.modality,
      mediaPath: knowledgeChunks.mediaPath,
      content: knowledgeChunks.content,
    })
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.id, chunkId))
    .get();
  if (!row) throw new Error("分块不存在");

  const fileName = row.mediaPath ? path.basename(row.mediaPath) : "";
  const fallback: KbChunkMediaView = {
    dataUrl: null,
    modality: row.modality,
    fileName,
    mediaPath: row.mediaPath,
    text: row.content,
  };
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
    const maxEdge = size === "full" ? FULL_MAX_EDGE : THUMB_MAX_EDGE;
    const jpegQuality = size === "full" ? FULL_JPEG_QUALITY : THUMB_JPEG_QUALITY;
    const thumb = await sharp(row.mediaPath, {
      failOnError: false,
      limitInputPixels: THUMB_LIMIT_INPUT_PIXELS,
      sequentialRead: true,
    })
      .rotate() // 按 EXIF 摆正，竖拍照片的缩略图不横着
      .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: jpegQuality })
      .toBuffer();
    return {
      dataUrl: `data:image/jpeg;base64,${thumb.toString("base64")}`,
      modality: row.modality,
      fileName,
      mediaPath: row.mediaPath,
      text: row.content,
    };
  } catch {
    // 损坏/无法解码的图片：降级为图标兜底，不拖垮整个分块列表
    return fallback;
  }
}
