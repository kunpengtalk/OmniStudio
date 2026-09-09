import type { Sharp } from "sharp";

import { DEFAULT_PROCESSING_ARGS, getImageName, parseBBoxAttr } from "./shared";
import type { BBox } from "./shared";
import type { ModelProfile } from "../model-profile";
import { scaleToMaxDim } from "../utils";

// ---------------------------------------------------------------------------
// Markdown image bbox parsing
//
// LightOnOCR-bbox emits:  ![alt](any_name.png)x0,y0,x1,y1
// Coordinates are normalized to [0, 1000].
// ---------------------------------------------------------------------------

const MARKDOWN_IMAGE_BBOX_RE = /!\[([^\]]*)\]\(([^)\s]+)\)\s*([0-9]+(?:\s*,\s*[0-9]+){3})/g;

type MarkdownImageRef = {
  full: string;
  alt: string;
  bbox: BBox;
  imageName: string;
};

function parseMarkdownImageRefs(markdown: string): MarkdownImageRef[] {
  const refs: MarkdownImageRef[] = [];
  for (const match of markdown.matchAll(MARKDOWN_IMAGE_BBOX_RE)) {
    refs.push({
      full: match[0],
      alt: match[1] ?? "",
      bbox: parseBBoxAttr(match[3]),
      imageName: getImageName(markdown, refs.length + 1),
    });
  }
  return refs;
}

export function normalizeMarkdownImageBBoxes(markdown: string): string {
  let normalized = markdown.trim();
  for (const ref of parseMarkdownImageRefs(markdown)) {
    normalized = normalized.replace(ref.full, `![${ref.alt}](${ref.imageName})`);
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Image cropping — LightOnOCR-specific
//
// Coords are [0, 1000] normalized per-axis (x scaled by width, y by height).
// ---------------------------------------------------------------------------

const BBOX_NORM = 1000;
const BBOX_PADDING = 10;

async function cropBBox(bbox: BBox, image: Sharp): Promise<Sharp | null> {
  const { width = 0, height = 0 } = await image.metadata();
  if (width === 0 || height === 0) return null;

  const [x0, y0, x1, y1] = bbox;
  const left = Math.max(0, Math.floor(x0 * width / BBOX_NORM) - BBOX_PADDING);
  const top = Math.max(0, Math.floor(y0 * height / BBOX_NORM) - BBOX_PADDING);
  const right = Math.min(Math.floor(x1 * width / BBOX_NORM) + BBOX_PADDING, width);
  const bottom = Math.min(Math.floor(y1 * height / BBOX_NORM) + BBOX_PADDING, height);
  const w = right - left;
  const h = bottom - top;

  if (w <= 0 || h <= 0) return null;

  try {
    return image.clone().extract({ left, top, width: w, height: h });
  } catch {
    return null;
  }
}

async function extractMarkdownImages(
  markdown: string,
  image: Sharp,
): Promise<Record<string, Sharp>> {
  const refs = parseMarkdownImageRefs(markdown);
  const images: Record<string, Sharp> = {};

  await Promise.all(
    refs.map(async (ref) => {
      const cropped = await cropBBox(ref.bbox, image);
      if (cropped) images[ref.imageName] = cropped;
    }),
  );

  return images;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export const profile: ModelProfile = {
  id: "lightonocr",
  label: "LightOnOCR",
  rawFormat: "markdown_image_bbox",
  rawLabel: "Markdown",
  rawOnly: false,
  processingArgs: {
    ...DEFAULT_PROCESSING_ARGS,
    temperature: 0.2,
    topP: 0.9,
    maxOutputTokens: 4096,
  },
  preprocessImage: (img) => scaleToMaxDim(img, 1540),
  buildUserPrompt: () => "",
  async processRawOutput(raw, image) {
    return {
      markdown: normalizeMarkdownImageBBoxes(raw),
      images: await extractMarkdownImages(raw, image),
    };
  },
};
