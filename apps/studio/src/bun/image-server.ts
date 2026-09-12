import { existsSync, mkdirSync, renameSync, statSync } from "fs";
import path from "path";
import { IMAGE_SERVER_HOST, IMAGE_SERVER_PORT, isLocalOrigin, isLoopbackHost } from "../shared/server-info";
import { getDataDir } from "./paths";
import { safeJoin } from "./path-safety";

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
  const base = getDataDir("images");
  migrateLegacyCwdDir("vllm-studio-images", base);
  migrateLegacyCwdDir("kunpengtalk-studio-images", base);
  migrateLegacyCwdDir("omni-studio-images", base);
  return base;
}

/**
 * 提示词库媒体素材根目录：seed 数据里的 `/prompt-library/...` 路径指向
 * vibedesign 仓库 `frontend/public/prompt-library`（图片/视频封面，未打进本应用包）。
 * 目录不存在时返回 null，由本地缓存 / 云端直链兜底。
 *
 * 注意返回的是**素材根目录本身**（含 prompt-library 这一段）：`/prompt-library/`
 * 路由会把前缀之后的部分接在它下面，与下载缓存目录（<dataDir>/prompt-media/
 * prompt-library）保持同一语义。此前少了一层，导致开发机上的本地素材一律 404
 * （被云端直链兜底掩盖，路由测试也一直是失败的、被人为跳过）。
 */
export function getPromptLibraryMediaBase(): string | null {
  const base = path.join(
    process.env.HOME || "/Users/jwangkun",
    "ai",
    "vibedesign",
    "frontend",
    "public",
    "prompt-library",
  );
  return existsSync(base) ? base : null;
}

/**
 * 提示词库媒体本地缓存目录：云端直链加载失败时由 `ensurePromptMedia` 惰性
 * 下载到这里，之后 `/prompt-library/...` 路由直接读缓存（离线也能看）。
 */
export function getPromptLibraryCacheBase(): string {
  return path.join(getDataDir("prompt-media"), "prompt-library");
}

/** 提示词库媒体相对路径（如 `awesome/case544.jpg`）对应的本地缓存 URL。 */
export function promptLibraryLocalUrl(rel: string): string {
  return `http://${IMAGE_SERVER_HOST}:${IMAGE_SERVER_PORT}/prompt-library/${rel}`;
}

export function getUploadsBaseDir(): string {
  const base = getDataDir("uploads");
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
  // 视频容器（AI 视频生成的成片由 <video> 元素播放，MIME 必须是 video/*）
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
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
    // 只监听回环：服务无鉴权，绑全网卡等于把文档/图片/音频暴露给同网段。
    hostname: IMAGE_SERVER_HOST,
    async fetch(req) {
      const url = new URL(req.url);

      // DNS rebinding / 外部网页防护：Host 必须是回环，Origin 必须是本机或本应用。
      if (!isLoopbackHost(req.headers.get("host")) || !isLocalOrigin(req.headers.get("origin"))) {
        return new Response("Forbidden", { status: 403 });
      }

      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      // 提示词库媒体：优先 vibedesign 的 public 目录，其次本地下载缓存
      // （seed 里的 /prompt-library/... 路径；缓存目录见 getPromptLibraryCacheBase）
      if (url.pathname.startsWith("/prompt-library/")) {
        const rel = decodeURIComponent(url.pathname.slice("/prompt-library/".length));
        for (const mediaBase of [getPromptLibraryMediaBase(), getPromptLibraryCacheBase()]) {
          if (!mediaBase) continue;
          const mediaPath = safeJoin(mediaBase, rel);
          if (!mediaPath) return new Response("Forbidden", { status: 403 });
          if (!existsSync(mediaPath)) continue;
          const mediaSize = statSync(mediaPath).size;
          return fileResponse(mediaPath, mediaSize, req.headers.get("range"));
        }
        return new Response("Not found", { status: 404 });
      }

      const filePath = safeJoin(baseDir, decodeURIComponent(url.pathname));
      if (!filePath) {
        return new Response("Forbidden", { status: 403 });
      }

      if (!existsSync(filePath)) {
        return new Response("Not found", { status: 404 });
      }

      const size = statSync(filePath).size;
      return fileResponse(filePath, size, req.headers.get("range"));
    },
  });

  console.log(`Image server running on http://${IMAGE_SERVER_HOST}:${IMAGE_SERVER_PORT}`);
}

export function imageUrl(docId: number, filename: string): string {
  return `http://${IMAGE_SERVER_HOST}:${IMAGE_SERVER_PORT}/${docId}/${filename}`;
}

// Chat images are stored under images/<...> with a ref like "chat/<convId>/<file>".
// The ref is relative to the images base dir so it can be persisted in messages.
export { chatImageUrl } from "../shared/server-info";

export function chatImageDir(conversationId: number): string {
  return path.join(getImagesBaseDir(), "chat", String(conversationId));
}
