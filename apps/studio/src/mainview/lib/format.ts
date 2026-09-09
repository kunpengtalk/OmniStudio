const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

export function looksLikeHtml(raw: string): boolean {
  return /^\s*</.test(raw) && /<([a-z][a-z0-9-]*)(\s|>)/i.test(raw);
}

export function formatHtml(html: string): string {
  let out = "";
  let indent = 0;
  let i = 0;

  while (i < html.length) {
    if (html[i] === "<") {
      const end = html.indexOf(">", i);
      if (end === -1) {
        out += html.slice(i);
        break;
      }

      const tag = html.slice(i, end + 1);
      const isClosing = tag.startsWith("</");
      const isSelfClosing = tag.endsWith("/>");
      const tagNameMatch = tag.match(/^<\/?([a-zA-Z][a-zA-Z0-9-]*)/);
      const tagName = tagNameMatch?.[1]?.toLowerCase() ?? "";
      const isVoid = VOID_TAGS.has(tagName);

      if (isClosing) indent = Math.max(0, indent - 1);
      out += `${"  ".repeat(indent)}${tag}\n`;
      if (!isClosing && !isSelfClosing && !isVoid) indent++;

      i = end + 1;
    } else {
      const nextTag = html.indexOf("<", i);
      const text = (nextTag === -1 ? html.slice(i) : html.slice(i, nextTag)).trim();
      if (text) out += `${"  ".repeat(indent)}${text}\n`;
      i = nextTag === -1 ? html.length : nextTag;
    }
  }

  return out.trimEnd();
}

export function formatRaw(raw: string): string {
  return looksLikeHtml(raw) ? formatHtml(raw) : raw.trim();
}

export function getRawLanguage(raw: string): "html" | "markdown" {
  return looksLikeHtml(raw) ? "html" : "markdown";
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function friendlyType(mime: string): string {
  if (mime.includes("pdf")) return "PDF";
  if (mime.includes("png")) return "PNG";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "JPEG";
  if (mime.includes("webp")) return "WebP";
  if (mime.includes("tiff")) return "TIFF";
  if (mime.includes("bmp")) return "BMP";
  return mime.split("/").pop()?.toUpperCase() ?? mime;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
}
