import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import sharp from "sharp";

import { normalizeMarkdownImageBBoxes, profile } from "../src/bun/vllm/profiles/lightonocr";
import { getImageName } from "../src/bun/vllm/profiles/shared";

const SAMPLE_PNG = join(import.meta.dir, "sample.png");
/** Golden crop (Transformer Fig. 2 region). Re-save after intentional crop changes: run profile.processRawOutput on sample.png + bbox, then `png(GOLDEN_PNG_OPTS).toFile(...)`. */
const GOLDEN_CROP_PNG = join(
  import.meta.dir,
  "fixtures",
  "lightonocr-crop-sample-230-87-788-298.png",
);

/** Deterministic PNG encode so golden file bytes match across runs. */
const GOLDEN_PNG_OPTS = { compressionLevel: 9, effort: 10 } as const;

/** Mirrors `cropBBox` in lightonocr.ts (norm 1000 + padding). */
function expectedCropRect(
  width: number,
  height: number,
  bbox: readonly [number, number, number, number],
) {
  const norm = 1000;
  const pad = 10;
  const [x0, y0, x1, y1] = bbox;
  const left = Math.max(0, Math.floor((x0 * width) / norm) - pad);
  const top = Math.max(0, Math.floor((y0 * height) / norm) - pad);
  const right = Math.min(Math.floor((x1 * width) / norm) + pad, width);
  const bottom = Math.min(Math.floor((y1 * height) / norm) + pad, height);
  return { left, top, width: right - left, height: bottom - top };
}

describe("LightOnOCR markdown bbox", () => {
  test("normalizes inline image bbox refs to valid markdown images", () => {
    const raw = `
# Page

Intro text.

![chart](image_1.png)230,87,787,298
    `.trim();

    const normalized = normalizeMarkdownImageBBoxes(raw);

    expect(normalized).toContain("# Page");
    expect(normalized).toContain("Intro text.");
    expect(normalized).toContain("![chart](");
    expect(normalized).not.toContain("image_1.png)230,87,787,298");
    expect(normalized).not.toContain(",87,");
  });

  test("leaves markdown unchanged when no bbox refs exist", () => {
    const raw = `# Page\n\nPlain markdown only.`;
    expect(normalizeMarkdownImageBBoxes(raw)).toBe(raw);
  });
});

// Bbox 230,87,788,298: normalized [0–1000] region over Transformer Fig. 2 (sample.png).
const SAMPLE_BBOX = [230, 87, 788, 298] as const;

describe("LightOnOCR image crop (sample.png)", () => {
  test("crop matches golden PNG (fixtures/lightonocr-crop-sample-230-87-788-298.png)", async () => {
    const raw = `![Scaled Dot-Product / Multi-Head Attention](page.png)230,87,788,298`;
    const img = sharp(SAMPLE_PNG);
    const { width = 0, height = 0 } = await img.metadata();
    expect(width).toBe(1106);
    expect(height).toBe(1428);

    const out = await profile.processRawOutput(raw, img, {}, 1000);
    const key = getImageName(raw, 1);
    const cropped = out.images[key];
    expect(cropped).toBeDefined();

    const exp = expectedCropRect(width, height, SAMPLE_BBOX);
    const { data: actual, info } = await cropped!
      .png(GOLDEN_PNG_OPTS)
      .toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(exp.width);
    expect(info.height).toBe(exp.height);
    expect(info.format).toBe("png");

    const golden = await readFile(GOLDEN_CROP_PNG);
    expect(Buffer.compare(actual, golden)).toBe(0);

    expect(out.markdown).toContain("![Scaled Dot-Product / Multi-Head Attention](");
    expect(out.markdown).toContain(key);
    expect(out.markdown).not.toMatch(/230\s*,\s*87\s*,\s*788\s*,\s*298/);
  });

  test("accepts bbox with spaces after commas", async () => {
    const raw = `![fig](x.png)230, 87, 788, 298`;
    const img = sharp(SAMPLE_PNG);
    const { width = 0, height = 0 } = await img.metadata();
    const out = await profile.processRawOutput(raw, img, {}, 1000);
    const key = getImageName(raw, 1);
    const exp = expectedCropRect(width, height, SAMPLE_BBOX);
    const { info } = await out.images[key]!.webp().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(exp.width);
    expect(info.height).toBe(exp.height);
  });

  test("preprocessed page (max dim 1540) crops consistently", async () => {
    const raw = `![fig](p.png)230,87,788,298`;
    const preprocessed = await profile.preprocessImage!(sharp(SAMPLE_PNG));
    const { width = 0, height = 0 } = await preprocessed.metadata();
    const out = await profile.processRawOutput(raw, preprocessed, {}, 1000);
    const key = getImageName(raw, 1);
    const exp = expectedCropRect(width, height, SAMPLE_BBOX);
    const { info } = await out.images[key]!.webp().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(exp.width);
    expect(info.height).toBe(exp.height);
  });
});
