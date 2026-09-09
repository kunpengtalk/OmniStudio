import { createCanvas } from "@napi-rs/canvas";
import convert from "heic-convert";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import type { Sharp } from "sharp";
import sharp from "sharp";

import { getCurrentModelProfile } from "./model-profile";

const PDF_DPI_BASE = 72;
const PDF_CONTENT_TYPES = ["application/pdf", "application/vnd.pdf"];
const HEIC_CONTENT_TYPES = ["image/heic", "image/heif"];

// ---------------------------------------------------------------------------
// Page range parser — "0-2,5" → [0,1,2,5] (0-based)
// ---------------------------------------------------------------------------

function parsePageRange(rangeStr: string): number[] {
  const pages: number[] = [];

  for (const part of rangeStr
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (part.includes("-")) {
      const [startStr, endStr] = part.split("-").map((s) => s.trim());
      const start = Number.parseInt(startStr!, 10);
      const end = Number.parseInt(endStr!, 10);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

      const lo = Math.min(start, end);
      const hi = Math.max(start, end);
      for (let p = lo; p <= hi; p++) pages.push(p);
    } else {
      const p = Number.parseInt(part, 10);
      if (Number.isFinite(p)) pages.push(p);
    }
  }

  return [...new Set(pages)].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Image normalization
// ---------------------------------------------------------------------------

async function ensureSRGB(img: Sharp): Promise<Sharp> {
  const { space } = await img.metadata();
  if (space === "srgb" || space === "rgb") return img;
  return img.toColourspace("srgb");
}

async function loadImage(
  buffer: ArrayBuffer,
  minDim = getCurrentModelProfile().processingArgs.minImageDim,
): Promise<Sharp> {
  const img = await ensureSRGB(sharp(buffer, { failOnError: false }));
  const { width = 0, height = 0 } = await img.metadata();

  if (width > 0 && height > 0 && (width < minDim || height < minDim)) {
    const scale = minDim / Math.min(width, height);
    const buf = await img
      .resize(Math.round(width * scale), Math.round(height * scale), {
        kernel: sharp.kernel.lanczos3,
        withoutEnlargement: false,
      })
      .toBuffer();
    return sharp(buf);
  }

  return img;
}

// ---------------------------------------------------------------------------
// PDF rendering
// ---------------------------------------------------------------------------

async function renderPdfPages(
  buffer: ArrayBuffer,
  pageRange: number[] = [],
  dpi = getCurrentModelProfile().processingArgs.imageDpi,
  minDim = getCurrentModelProfile().processingArgs.minPdfImageDim,
): Promise<Sharp[]> {
  const pdf = await pdfjsLib.getDocument(buffer).promise;
  const wantedPages = pageRange.length > 0 ? new Set(pageRange) : null;
  const images: Sharp[] = [];

  for (let idx = 0; idx < pdf.numPages; idx++) {
    if (wantedPages && !wantedPages.has(idx)) continue;

    const page = await pdf.getPage(idx + 1);
    const baseViewport = page.getViewport({ scale: 1 });
    const minPageDim = Math.min(baseViewport.width, baseViewport.height);

    const scaleDpi = Math.max((minDim / minPageDim) * PDF_DPI_BASE, dpi);
    const viewport = page.getViewport({ scale: scaleDpi / PDF_DPI_BASE });

    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));

    await page.render({
      canvas: null,
      canvasContext: canvas.getContext("2d") as unknown as CanvasRenderingContext2D,
      viewport,
      annotationMode: pdfjsLib.AnnotationMode.ENABLE,
    }).promise;

    images.push(await ensureSRGB(sharp(canvas.toBuffer("image/png"))));
  }

  await pdf.destroy();
  return images;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

type LoadFileConfig = {
  /** 0-based page range string, e.g. "0-2,5" */
  page_range?: string;
};

export async function convertFileToImages(
  source: string | Bun.BunFile,
  config: LoadFileConfig = {},
): Promise<Sharp[]> {
  let buffer: ArrayBuffer;
  let contentType: string;

  if (typeof source === "string") {
    const response = await fetch(source);
    buffer = await response.arrayBuffer();
    contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  } else {
    buffer = await source.arrayBuffer();
    contentType = source.type;
  }

  if (PDF_CONTENT_TYPES.includes(contentType)) {
    const pageRange = config.page_range?.trim() ? parsePageRange(config.page_range) : [];
    return renderPdfPages(buffer, pageRange);
  }

  if (HEIC_CONTENT_TYPES.includes(contentType)) {
    const jpeg = await convert({ buffer: Buffer.from(buffer), format: "JPEG", quality: 0.95 });
    return [await loadImage(jpeg.buffer as ArrayBuffer)];
  }

  return [await loadImage(buffer)];
}
