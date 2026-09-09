import type { Sharp } from "sharp";
import sharp from "sharp";

type Size2D = [number, number];

const MAX_SIZE: Size2D = [3072, 2048];
const MIN_SIZE: Size2D = [1792, 28];
const GRID_SIZE = 28;

/**
 * Grid-aligned pixel-budget resize.
 * Snaps dimensions to multiples of gridSize, then refines to stay under
 * maxPixels while preserving aspect ratio as closely as possible.
 */
export async function scaleToFit(
  img: Sharp,
  maxSize: Size2D = MAX_SIZE,
  minSize: Size2D = MIN_SIZE,
  gridSize: number = GRID_SIZE,
): Promise<Sharp> {
  const { width = 0, height = 0 } = await img.metadata();
  if (width <= 0 || height <= 0) return img;

  const originalAr = width / height;
  const currentPixels = width * height;
  const maxPixels = maxSize[0] * maxSize[1];
  const minPixels = minSize[0] * minSize[1];

  let scale = 1.0;
  if (currentPixels > maxPixels) {
    scale = Math.sqrt(maxPixels / currentPixels);
  } else if (currentPixels < minPixels) {
    scale = Math.sqrt(minPixels / currentPixels);
  }

  let wBlocks = Math.max(1, Math.round((width * scale) / gridSize));
  let hBlocks = Math.max(1, Math.round((height * scale) / gridSize));

  while (wBlocks * hBlocks * gridSize * gridSize > maxPixels) {
    if (wBlocks === 1 && hBlocks === 1) break;
    if (wBlocks === 1) {
      hBlocks -= 1;
      continue;
    }
    if (hBlocks === 1) {
      wBlocks -= 1;
      continue;
    }
    const arWLoss = Math.abs((wBlocks - 1) / hBlocks - originalAr);
    const arHLoss = Math.abs(wBlocks / (hBlocks - 1) - originalAr);
    if (arWLoss < arHLoss) {
      wBlocks -= 1;
    } else {
      hBlocks -= 1;
    }
  }

  const newWidth = wBlocks * gridSize;
  const newHeight = hBlocks * gridSize;

  if (newWidth === width && newHeight === height) return img;

  return img.clone().resize(newWidth, newHeight, {
    kernel: sharp.kernel.lanczos3,
    withoutEnlargement: false,
  });
}

/**
 * Resize so the longest dimension is at most maxDim.
 * Preserves aspect ratio. Returns the original if already within bounds.
 */
export async function scaleToMaxDim(img: Sharp, maxDim: number): Promise<Sharp> {
  const { width = 0, height = 0 } = await img.metadata();
  if (width === 0 || height === 0) return img;

  const longest = Math.max(width, height);
  if (longest <= maxDim) return img;

  const scale = maxDim / longest;
  return img.clone().resize(Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale)), {
    kernel: sharp.kernel.lanczos3,
  });
}

const DEFAULT_BASE_MAX_REPEATS = 4;
const DEFAULT_WINDOW_SIZE = 500;
const DEFAULT_SCALING_FACTOR = 3.0;

/**
 * Detect degenerate repetition loops in model output.
 * Returns true when the tail of the text repeats beyond threshold.
 */
export function detectRepeatToken(
  text: string,
  baseMaxRepeats = DEFAULT_BASE_MAX_REPEATS,
  windowSize = DEFAULT_WINDOW_SIZE,
  cutFromEnd = 0,
  scalingFactor = DEFAULT_SCALING_FACTOR,
): boolean {
  let tokens = text;

  if (cutFromEnd > 0) {
    tokens = tokens.slice(0, Math.max(0, tokens.length - cutFromEnd));
  }

  const maxSeqLen = Math.floor(windowSize / 2);

  for (let seqLen = 1; seqLen <= maxSeqLen; seqLen++) {
    if (tokens.length < seqLen) continue;
    const candidate = tokens.slice(tokens.length - seqLen);
    const maxRepeats = Math.floor(baseMaxRepeats * (1 + scalingFactor / seqLen));

    let repeatCount = 0;
    let pos = tokens.length - seqLen;

    while (pos >= 0) {
      if (tokens.slice(pos, pos + seqLen) === candidate) {
        repeatCount += 1;
        pos -= seqLen;
      } else {
        break;
      }
    }

    if (repeatCount > maxRepeats) return true;
  }

  return false;
}

export async function imageToBase64(image: Sharp): Promise<string> {
  const buf = await image.png().toBuffer();
  return buf.toString("base64");
}

export type GenerationResult = {
  raw: string;
  token_count: number;
  error?: boolean;
  errorMessage?: string;
};

export type BatchOutputItem = {
  markdown: string;
  raw: string;
  page_box: number[];
  token_count: number;
  images: Record<string, Sharp>;
  error?: boolean;
  errorMessage?: string;
};
