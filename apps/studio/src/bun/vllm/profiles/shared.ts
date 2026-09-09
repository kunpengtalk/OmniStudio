import crypto from "node:crypto";
import type { Sharp } from "sharp";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BBox = [number, number, number, number];

export type ParseHtmlOptions = {
  include_headers_footers?: boolean;
  include_images?: boolean;
};

export type ProcessedOutput = {
  markdown: string;
  images: Record<string, Sharp>;
};

// ---------------------------------------------------------------------------
// Processing args — shared defaults for all model profiles
// ---------------------------------------------------------------------------

export type RepeatDetectionArgs = {
  baseMaxRepeats: number;
  windowSize: number;
  cutFromEnd: number;
  scalingFactor: number;
};

export type ProcessingArgs = {
  imageDpi: number;
  minPdfImageDim: number;
  minImageDim: number;
  maxOutputTokens: number;
  bboxScale: number;
  temperature: number;
  topP: number;
  retryTempStep: number;
  retryTempMax: number;
  repeatDetection: RepeatDetectionArgs | null;
};

export const DEFAULT_PROCESSING_ARGS: ProcessingArgs = {
  imageDpi: 192,
  minPdfImageDim: 1024,
  minImageDim: 1536,
  maxOutputTokens: 12384,
  bboxScale: 1000,
  temperature: 0,
  topP: 0.1,
  retryTempStep: 0.2,
  retryTempMax: 0.8,
  repeatDetection: { baseMaxRepeats: 4, windowSize: 500, cutFromEnd: 50, scalingFactor: 3.0 },
};

// ---------------------------------------------------------------------------
// Image naming
// ---------------------------------------------------------------------------

const contentHashCache = new Map<string, string>();

function hashContent(content: string): string {
  const cached = contentHashCache.get(content);
  if (cached) return cached;
  const h = crypto.createHash("md5").update(content, "utf8").digest("hex");
  contentHashCache.set(content, h);
  return h;
}

export function getImageName(content: string, idx: number): string {
  return `${hashContent(content)}_${idx}_img.webp`;
}

// ---------------------------------------------------------------------------
// BBox parsing
// ---------------------------------------------------------------------------

export function parseBBoxAttr(raw: string | undefined | null): BBox {
  if (!raw) return [0, 0, 1, 1];

  const parts = raw.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 4 && parts.every((p) => Number.isFinite(Number(p)))) {
    return parts.map((p) => Math.round(Number(p))) as BBox;
  }

  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v) && v.length === 4 && v.every((x) => Number.isFinite(Number(x)))) {
      return v.map((x) => Math.round(Number(x))) as BBox;
    }
  } catch {
    // fall through
  }

  return [0, 0, 1, 1];
}

// ---------------------------------------------------------------------------
// Image cropping
// ---------------------------------------------------------------------------

export async function extractImageCrop(
  bbox: BBox,
  image: Sharp,
  bboxScale: number,
): Promise<Sharp | null> {
  const { width = 0, height = 0 } = await image.metadata();
  if (width === 0 || height === 0) return null;

  const wScale = width / bboxScale;
  const hScale = height / bboxScale;

  const [x0, y0, x1, y1] = bbox;
  const left = Math.max(0, Math.floor(x0 * wScale));
  const top = Math.max(0, Math.floor(y0 * hScale));
  const right = Math.min(Math.floor(x1 * wScale), width);
  const bottom = Math.min(Math.floor(y1 * hScale), height);
  const w = right - left;
  const h = bottom - top;

  if (w <= 0 || h <= 0) return null;

  try {
    return image.clone().extract({ left, top, width: w, height: h });
  } catch {
    return null;
  }
}
