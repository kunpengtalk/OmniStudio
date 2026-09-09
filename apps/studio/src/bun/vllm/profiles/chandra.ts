import * as cheerio from "cheerio";
import { gfm } from "@truto/turndown-plugin-gfm";
import TurndownService from "turndown";
import type { Sharp } from "sharp";

import { DEFAULT_PROCESSING_ARGS, extractImageCrop, getImageName, parseBBoxAttr } from "./shared";
import type { BBox, ParseHtmlOptions } from "./shared";
import type { ModelProfile } from "../model-profile";
import { scaleToFit } from "../utils";

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function buildUserPrompt(_bboxScale: number): string {
  return `
OCR this image to HTML, arranged as layout blocks. Each layout block should be a div with the data-bbox attribute representing the bounding box of the block in x0 y0 x1 y1 format. Bboxes are normalized 0-1000. The data-label attribute is the label for the block.

Use the following labels:
- Caption
- Footnote
- Equation-Block
- List-Group
- Page-Header
- Page-Footer
- Image
- Section-Header
- Table
- Text
- Complex-Block
- Code-Block
- Form
- Table-Of-Contents
- Figure
- Chemical-Block
- Diagram
- Bibliography
- Blank-Page

Only use these tags math, br, i, b, u, del, sup, sub, table, tr, td, p, th, div, pre, h1, h2, h3, h4, h5, ul, ol, li, input, a, span, img, hr, tbody, small, caption, strong, thead, big, code, chem, and these attributes class, colspan, rowspan, display, checked, type, border, value, style, href, alt, align, data-bbox, data-label.

Guidelines:
* Return HTML only. First non-whitespace token must be <div.
* Inline math: Surround math with <math>...</math> tags. Math expressions should be rendered in KaTeX-compatible LaTeX. Use display for block math.
* Tables: Use colspan and rowspan attributes to match table structure.
* Formatting: Maintain consistent formatting with the image, including spacing, indentation, subscripts/superscripts, and special characters.
* Images: Include a description of any images in the alt attribute of an <img> tag. Do not fill out the src property. Describe in detail inside the div tag. Also convert charts to high fidelity data, and convert diagrams to mermaid.
* Forms: Mark checkboxes and radio buttons properly.
* Text: join lines together properly into paragraphs using <p>...</p>. Use <br> tags for line breaks within paragraphs, but only when absolutely necessary to maintain meaning.
* Chemistry: Use <chem>...</chem> tags for chemical formulas with reactive SMILES.
* Lists: Preserve indents and proper list markers.
* Use the simplest possible HTML structure that accurately represents the content of the block.
* Make sure the text is accurate and easy for a human to read and interpret. Reading order should be correct and natural.
`.trim();
}

// ---------------------------------------------------------------------------
// Math shielding — HTML parsers mangle LaTeX inside <math> tags.
// Encode content as base64 so it survives cheerio and Turndown untouched.
// ---------------------------------------------------------------------------

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&apos;": "'",
};
const ENTITY_RE = new RegExp(Object.keys(HTML_ENTITIES).join("|"), "gi");

function decodeEntities(s: string): string {
  return s.replace(ENTITY_RE, (m) => HTML_ENTITIES[m.toLowerCase()] ?? m);
}

export function shieldMathTags(html: string): string {
  return html.replace(/<math(\s[^>]*)?>([^]*?)<\/math>/gi, (_, attrs = "", content: string) => {
    const isBlock = /display\s*=\s*["']block["']/i.test(attrs);
    const latex = decodeEntities(content.replace(/<[^>]+>/g, "")).trim();
    const encoded = Buffer.from(latex).toString("base64");
    return `<span data-math-latex="${encoded}" data-math-display="${isBlock}">\u200B</span>`;
  });
}

// ---------------------------------------------------------------------------
// HTML cleanup
// ---------------------------------------------------------------------------

function getTopLevelDivs($: cheerio.CheerioAPI) {
  const body = $("body");
  const candidates = body.length ? body.children("div") : $.root().children("div");
  return candidates.length > 0
    ? candidates
    : $("div").filter((_, el) => $(el).parents("div").length === 0);
}

export function parseHtml(html: string, opts: ParseHtmlOptions = {}): string {
  const includeHeadersFooters = opts.include_headers_footers ?? false;
  const includeImages = opts.include_images ?? true;

  html = shieldMathTags(html);

  // @ts-expect-error decodeEntities is a legacy cheerio option
  const $ = cheerio.load(html, { decodeEntities: false });
  const body = $("body");
  const topLevelChildren = body.length ? body.children() : $.root().children();

  let outHtml = "";
  let divIdx = 0;

  topLevelChildren.each((_, el) => {
    const node = $(el);

    if (!node.is("div")) {
      outHtml += $.html(el);
      return;
    }

    divIdx += 1;
    const label = node.attr("data-label");

    if (label === "Blank-Page") return;
    if (!includeHeadersFooters && (label === "Page-Header" || label === "Page-Footer")) return;
    if (!includeImages && (label === "Image" || label === "Figure")) return;

    if (label === "Image" || label === "Figure") {
      const imgSrc = getImageName(html, divIdx);
      const img = node.find("img").first();
      if (img.length) {
        img.attr("src", imgSrc);
      } else {
        node.append(`<img src="${imgSrc}"/>`);
      }
    }

    if (label === "Text") {
      const inner = (node.html() ?? "").trim();
      if (!/<.+>/.test(inner)) {
        node.html(`<p>${inner}</p>`);
      }
    }

    if (label === "Diagram") {
      node.find("pre").each((_, pre) => {
        const preEl = $(pre);
        if (!preEl.find("code").length) {
          preEl.html(`<code class="language-mermaid">${preEl.html()}</code>`);
        }
      });
    }

    node.find("[data-bbox]").removeAttr("data-bbox");

    outHtml += node.html() ?? "";
  });

  return outHtml;
}

// ---------------------------------------------------------------------------
// HTML → Markdown conversion
// ---------------------------------------------------------------------------

function escapeLinkText(text: string): string {
  return text.replace(/([[\]()])/g, "\\$1");
}

function escapeDollarsOutsideMathAndCode(md: string): string {
  const enum State {
    Normal,
    InlineCode,
    FencedCode,
    InlineMath,
    BlockMath,
  }

  let state: State = State.Normal;
  let out = "";
  let i = 0;

  while (i < md.length) {
    if (
      state !== State.InlineCode &&
      state !== State.InlineMath &&
      state !== State.BlockMath &&
      md.startsWith("```", i)
    ) {
      out += "```";
      i += 3;
      state = state === State.FencedCode ? State.Normal : State.FencedCode;
      continue;
    }
    if (state === State.FencedCode) {
      out += md[i++];
      continue;
    }

    if (state !== State.InlineMath && state !== State.BlockMath && md[i] === "`") {
      out += "`";
      i += 1;
      state = state === State.InlineCode ? State.Normal : State.InlineCode;
      continue;
    }
    if (state === State.InlineCode) {
      out += md[i++];
      continue;
    }

    if (md.startsWith("$$", i)) {
      out += "$$";
      i += 2;
      state = state === State.BlockMath ? State.Normal : State.BlockMath;
      continue;
    }
    if (state === State.BlockMath) {
      out += md[i++];
      continue;
    }

    if (md[i] === "$") {
      out += "$";
      i += 1;
      state = state === State.InlineMath ? State.Normal : State.InlineMath;
      continue;
    }
    if (state === State.InlineMath) {
      out += md[i++];
      continue;
    }

    out += md[i++];
  }

  return out;
}

function createMarkdownConverter(): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    strongDelimiter: "**",
  });
  service.use(gfm);

  service.addRule("math", {
    filter: (node) => !!(node as Element).getAttribute?.("data-math-latex"),
    replacement: (_content, node) => {
      const el = node as Element;
      const latex = Buffer.from(el.getAttribute("data-math-latex") ?? "", "base64").toString(
        "utf8",
      );
      return el.getAttribute("data-math-display") === "true" ? `\n$$${latex}$$\n` : ` $${latex}$ `;
    },
  });

  service.addRule("barePreBlock", {
    filter: (node) => node.nodeName === "PRE" && !node.querySelector("code"),
    replacement: (_content, node) => {
      const text = (node as Element).textContent ?? "";
      return `\n\n\`\`\`\n${text}\n\`\`\`\n\n`;
    },
  });

  service.addRule("aEscapedText", {
    filter: (node) => node.nodeName === "A",
    replacement: (content, node) => {
      const el = node as HTMLAnchorElement;
      const href = (el.getAttribute("href") ?? "").trim();
      const title = (el.getAttribute("title") ?? "").trim();
      const text = escapeLinkText((content ?? "").trim() || href);
      if (!href) return text;
      const titlePart = title ? ` "${title.replace(/"/g, '\\"')}"` : "";
      return `[${text}](${href}${titlePart})`;
    },
  });

  const originalEscape = service.escape.bind(service);
  service.escape = (str: string) => originalEscape(str).replace(/\s+/g, " ");

  return service;
}

const converter = createMarkdownConverter();

export function parseMarkdown(html: string): string {
  try {
    const markdown = converter.turndown(html);
    return escapeDollarsOutsideMathAndCode(markdown.trim()).trim();
  } catch (e) {
    console.error(`Error converting HTML to Markdown: ${e}`);
    return "";
  }
}

// ---------------------------------------------------------------------------
// Image extraction from HTML bbox divs
// ---------------------------------------------------------------------------

async function extractImages(
  html: string,
  image: Sharp,
  bboxScale: number,
): Promise<Record<string, Sharp>> {
  // @ts-expect-error decodeEntities is a legacy cheerio option
  const $ = cheerio.load(html, { decodeEntities: false });
  const topLevelDivs = getTopLevelDivs($);

  type CropJob = { imgName: string; bbox: BBox };
  const jobs: CropJob[] = [];
  let divIdx = 0;

  topLevelDivs.each((_, el) => {
    divIdx += 1;
    const div = $(el);
    const label = div.attr("data-label");
    if (label === "Blank-Page") return;
    if (label !== "Image" && label !== "Figure") return;
    jobs.push({ imgName: getImageName(html, divIdx), bbox: parseBBoxAttr(div.attr("data-bbox")) });
  });

  const images: Record<string, Sharp> = {};
  await Promise.all(
    jobs.map(async ({ imgName, bbox }) => {
      const cropped = await extractImageCrop(bbox, image, bboxScale);
      if (cropped) images[imgName] = cropped;
    }),
  );

  return images;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export const profile: ModelProfile = {
  id: "chandra",
  label: "Chandra OCR",
  rawFormat: "html_bbox",
  rawLabel: "HTML",
  rawOnly: false,
  processingArgs: { ...DEFAULT_PROCESSING_ARGS },
  preprocessImage: (img) => scaleToFit(img, [3072, 2048], [1792, 28], 28),
  buildUserPrompt,
  async processRawOutput(raw, image, opts, bboxScale) {
    const cleanedHtml = parseHtml(raw, opts);
    return {
      markdown: parseMarkdown(cleanedHtml),
      images: await extractImages(raw, image, bboxScale),
    };
  },
};
