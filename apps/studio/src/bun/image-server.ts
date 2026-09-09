import { existsSync, mkdirSync, renameSync, statSync } from "fs";
import path from "path";
import { Utils } from "electrobun/bun";
import { IMAGE_SERVER_PORT } from "../shared/server-info";

// Dev builds run with the process CWD inside the app bundle, which electrobun
// regenerates on every rebuild — a CWD-relative data dir (and the audio/images
// it contains) would be wiped. Always use userData so data survives rebuilds.

function migrateLegacyCwdDir(legacyName: string, dest: string): void {
  try {
    const legacy = path.resolve(legacyName);
    if (legacy === dest || !existsSync(legacy) || existsSync(dest)) return;
    mkdirSync(path.dirname(dest), { recursive: true });
    renameSync(legacy, dest);
  } catch {
    // ignore
  }
}

export function getImagesBaseDir(): string {
  const base = path.join(Utils.paths.userData, "images");
  migrateLegacyCwdDir("vllm-studio-images", base);
  migrateLegacyCwdDir("kunpengtalk-studio-images", base);
  migrateLegacyCwdDir("omni-studio-images", base);
  return base;
}

export function getUploadsBaseDir(): string {
  const base = path.join(Utils.paths.userData, "uploads");
  migrateLegacyCwdDir("vllm-studio-uploads", base);
  migrateLegacyCwdDir("kunpengtalk-studio-uploads", base);
  migrateLegacyCwdDir("omni-studio-uploads", base);
  return base;
}

const MIME: Record<string, string> = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".webm": "audio/webm",
  ".mp4": "audio/mp4",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

/**
 * 解析单个 Range 头部为 [start, end]（闭区间），不合法返回 null。
 * 支持 bytes=start-end / bytes=start- / bytes=-suffix。
 */
function parseRange(range: string | null, size: number): [number, number] | null {
  if (!range) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m) return null;
  const startStr = m[1]!;
  const endStr = m[2]!;
  if (!startStr && !endStr) return null;
  if (startStr === "") {
    // 后缀长度：最后 N 字节。
    const suffix = Number(endStr);
    if (suffix <= 0) return null;
    const start = Math.max(0, size - suffix);
    return [start, size - 1];
  }
  const start = Number(startStr);
  if (!Number.isFinite(start) || start < 0 || start >= size) return null;
  const end = endStr === "" ? size - 1 : Math.min(Number(endStr), size - 1);
  if (end < start) return null;
  return [start, end];
}

/** 用 Range 支持返回文件内容（媒体播放器需要 206 才能稳定播放/拖动）。 */
function fileResponse(filePath: string, size: number, rangeHeader: string | null): Response {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] ?? "application/octet-stream";
  const baseHeaders: Record<string, string> = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    ...CORS_HEADERS,
  };

  const range = parseRange(rangeHeader, size);
  if (rangeHeader && !range) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${size}`, ...baseHeaders },
    });
  }

  if (!range) {
    return new Response(Bun.file(filePath), { headers: baseHeaders });
  }

  const [start, end] = range;
  const file = Bun.file(filePath);
  const sliced = file.slice(start, end + 1);
  return new Response(sliced, {
    status: 206,
    headers: {
      ...baseHeaders,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": String(end - start + 1),
    },
  });
}

export function startImageServer() {
  const baseDir = getImagesBaseDir();

  Bun.serve({
    port: IMAGE_SERVER_PORT,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      const filePath = path.join(baseDir, decodeURIComponent(url.pathname));

      if (!filePath.startsWith(baseDir)) {
        return new Response("Forbidden", { status: 403 });
      }

      if (!existsSync(filePath)) {
        return new Response("Not found", { status: 404 });
      }

      const size = statSync(filePath).size;
      return fileResponse(filePath, size, req.headers.get("range"));
    },
  });

  console.log(`Image server running on http://localhost:${IMAGE_SERVER_PORT}`);
}

export function imageUrl(docId: number, filename: string): string {
  return `http://localhost:${IMAGE_SERVER_PORT}/${docId}/${filename}`;
}

// Chat images are stored under images/<...> with a ref like "chat/<convId>/<file>".
// The ref is relative to the images base dir so it can be persisted in messages.
export { chatImageUrl } from "../shared/server-info";

export function chatImageDir(conversationId: number): string {
  return path.join(getImagesBaseDir(), "chat", String(conversationId));
}
