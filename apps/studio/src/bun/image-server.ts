import { existsSync, mkdirSync, renameSync, statSync } from "fs";
import path from "path";
import { createHash } from "crypto";
import {
  IMAGE_SERVER_HOST,
  imageServerPort,
  isLocalOrigin,
  isLoopbackHost,
} from "../shared/server-info";
import { getDataDir } from "./paths";
import { safeJoin } from "./path-safety";
import { logEvent } from "./app-log";

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
 * 把 `images/` 下的相对 ref 解析成绝对路径，**限制在该目录内**。
 *
 * ref 会从 RPC / 控制套接字 / 小应用一路传进来，`../../omni-studio.db` 这类输入
 * 能指到数据目录里的任意文件，所以穿越校验必须在这里做一次、且只有一次。
 * 放在 image-server 而不是各功能模块里：这里只依赖 paths/fs，不碰数据库，
 * 任何媒体相关模块都能直接引；此前 image-gen / video-gen / ocr 各写了一份，
 * 新增功能再抄一份就是第四份了。ocr.ts 的 `resolveOcrImage` 现在转调这里。
 */
export function resolveImageRef(ref: string): string | null {
  if (!ref || typeof ref !== "string") return null;
  const base = getImagesBaseDir();
  const resolved = path.resolve(base, ref);
  // 用 `base + sep` 前缀判定，避免 `/images-evil/...` 这种同前缀不同目录混进来。
  if (!resolved.startsWith(base + path.sep)) return null;
  return existsSync(resolved) ? resolved : null;
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
  return `http://${IMAGE_SERVER_HOST}:${imageServerPort()}/prompt-library/${rel}`;
}

export function getUploadsBaseDir(): string {
  const base = getDataDir("uploads");
  migrateLegacyCwdDir("vllm-studio-uploads", base);
  migrateLegacyCwdDir("kunpengtalk-studio-uploads", base);
  migrateLegacyCwdDir("omni-studio-uploads", base);
  return base;
}

/**
 * 本实例媒体目录的指纹（不泄露路径本身）。
 *
 * 媒体服务端口是固定的，而 dev / canary / 正式版各有自己的数据目录：端口被别人占用时，
 * 必须能分辨"占用者是同一份数据的另一个实例"（共用无害）还是"另一个数据目录"
 * （请求会打到别人的文件上，必须报警）。见 startImageServer。
 */
export function mediaServerId(): string {
  return createHash("sha1").update(path.resolve(getImagesBaseDir())).digest("hex").slice(0, 12);
}

/** 实例身份路由：探测端口的占用者是不是本应用、服务的是哪份数据目录。 */
const MEDIA_ID_PATH = "/__omni/media-id";

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
 * 产出物 / 工作区文件预览用的文本类型（HTML 要在右侧面板里当网页打开，
 * 所以 MIME 必须是 text/html，而不是当二进制下载）。
 */
const WEB_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
};

/**
 * 产出物路径解析钩子：由主进程启动时注入（rpc 侧查 DB）。
 * 放在钩子里是为了让 image-server 不依赖数据库——它要能在备份/迁移等场景独立起服务。
 */
let artifactResolver: ((id: number) => string | null) | null = null;

export function setArtifactResolver(resolve: (id: number) => string | null): void {
  artifactResolver = resolve;
}

/**
 * 工作区根目录白名单：只服务主进程登记过的目录。
 * 请求里只能带目录 id，带不了路径——预览地址因此无法被用来读工作区之外的文件。
 */
const workspaceRoots = new Map<string, string>();

export function registerWorkspaceRoot(root: string): string {
  const resolved = path.resolve(root);
  const id = createHash("sha1").update(resolved).digest("hex").slice(0, 12);
  workspaceRoots.set(id, resolved);
  return id;
}

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
  const contentType = WEB_MIME[ext] ?? MIME[ext] ?? "application/octet-stream";
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

/** 非法百分号编码（如 `/%E0%A4%A`）不能把 handler 抛崩，当作无效请求处理。 */
function decodePath(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * 媒体请求失败（403 越界 / 404 文件不在）写统一日志，按「状态码 + 首段路径」节流。
 *
 * 这类失败过去完全静默：媒体直链 403 那次，所有预览（生成图、聊天图、OCR 页图、TTS 音频）
 * 都拿不到内容，界面上一片破图，`logs/app.log` 里一个字都没有——只能靠翻文件系统反推。
 * 节流是必须的：一整屏预览坏掉时几秒内就是几百条请求，2MB 的日志会被冲掉，
 * 反而把真正的现场埋了（被压掉的条数记在 `suppressedSinceLastLog` 里）。
 */
const MEDIA_FAILURE_LOG_INTERVAL_MS = 60_000;
const mediaFailureLogged = new Map<string, { at: number; suppressed: number }>();

function logMediaFailure(status: 403 | 404, ref: string, reason: string, baseDir: string): void {
  const key = `${status}:${ref.split("/")[0] ?? ""}`;
  const now = Date.now();
  const prev = mediaFailureLogged.get(key);
  if (prev && now - prev.at < MEDIA_FAILURE_LOG_INTERVAL_MS) {
    prev.suppressed += 1;
    return;
  }
  logEvent({
    level: status === 403 ? "error" : "warn",
    source: "media-server",
    event: status === 403 ? "media.request.forbidden" : "media.request.not_found",
    message:
      status === 403
        ? `媒体请求被拒绝（路径越界）：${ref}`
        : `媒体文件不存在，预览会是破图：${ref}（${reason}）`,
    detail: {
      status,
      ref,
      reason,
      baseDir,
      suppressedSinceLastLog: prev?.suppressed ?? 0,
    },
  });
  mediaFailureLogged.set(key, { at: now, suppressed: 0 });
}

/** 立即占用端口开始服务；端口被占时 Bun.serve 直接抛（由 startImageServer 兜住）。 */
function bindMediaServer(): void {
  const baseDir = getImagesBaseDir();

  Bun.serve({
    port: imageServerPort(),
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

      // 实例身份：端口被占时，后启动的实例靠它判断"占着端口的是同一份数据目录还是另一份"。
      if (url.pathname === MEDIA_ID_PATH) {
        return Response.json({ id: mediaServerId(), pid: process.pid });
      }

      // 提示词库媒体：优先 vibedesign 的 public 目录，其次本地下载缓存
      // （seed 里的 /prompt-library/... 路径；缓存目录见 getPromptLibraryCacheBase）
      if (url.pathname.startsWith("/prompt-library/")) {
        const rel = decodePath(url.pathname.slice("/prompt-library/".length));
        if (rel === null) return new Response("Bad request", { status: 400 });
        for (const mediaBase of [getPromptLibraryMediaBase(), getPromptLibraryCacheBase()]) {
          if (!mediaBase) continue;
          const mediaPath = safeJoin(mediaBase, rel);
          if (!mediaPath) return new Response("Forbidden", { status: 403 });
          if (!existsSync(mediaPath)) continue;
          const mediaSize = statSync(mediaPath).size;
          return fileResponse(mediaPath, mediaSize, req.headers.get("range"));
        }
        // 本地没有：按需从上游取（图片经过的就是 `bun/proxy.ts` 包装过的 global fetch，
        // 用户的代理设置对这条链路生效）。这就是广场图**唯一**的取图路径 ——
        // 界面不再直接加载第三方 CDN，理由见 prompt-library.ts 的 mediaUrl 注释。
        // 动态 import：prompt-library 静态依赖本模块（取缓存目录 / 本地 URL），
        // 静态反向引用会成环；这里只在真正 miss 时才加载它。
        const { fetchPromptMediaUpstream } = await import("./prompt-library");
        const upstream = await fetchPromptMediaUpstream(rel);
        if (upstream) return upstream;
        return new Response("Not found", { status: 404 });
      }

      // 产出物预览：/artifact/<id>[/相对子路径]。
      // 只按登记过的 id 查路径（请求里给不了绝对路径），子路径相对产出物所在目录解析
      // —— 生成的 HTML 引用同目录的 css/js/图片时才能一起加载。
      if (url.pathname.startsWith("/artifact/")) {
        const rest = decodePath(url.pathname.slice("/artifact/".length));
        if (rest === null) return new Response("Bad request", { status: 400 });
        // 空段（`/artifact/7//a.css`）要丢掉：留下来会让子路径以 "/" 开头，
        // safeJoin 把它当绝对路径直接 403，看着像"文件不存在"。
        const [idPart, ...sub] = rest.split("/").filter((s) => s.length > 0);
        const id = Number(idPart);
        const absPath = Number.isInteger(id) && id > 0 ? artifactResolver?.(id) ?? null : null;
        if (!absPath) return new Response("Not found", { status: 404 });
        const target = sub.length > 0 ? safeJoin(path.dirname(absPath), sub.join("/")) : absPath;
        if (!target) return new Response("Forbidden", { status: 403 });
        if (!existsSync(target) || !statSync(target).isFile()) {
          return new Response("Not found", { status: 404 });
        }
        return fileResponse(target, statSync(target).size, req.headers.get("range"));
      }

      // 工作区文件预览：/workspace/<rootId>/<相对路径>（rootId 由主进程登记）。
      if (url.pathname.startsWith("/workspace/")) {
        const rest = decodePath(url.pathname.slice("/workspace/".length));
        if (rest === null) return new Response("Bad request", { status: 400 });
        const [rootId, ...sub] = rest.split("/").filter((s) => s.length > 0);
        const root = rootId ? workspaceRoots.get(rootId) : undefined;
        if (!root || sub.length === 0) return new Response("Not found", { status: 404 });
        const target = safeJoin(root, sub.join("/"));
        if (!target) return new Response("Forbidden", { status: 403 });
        if (!existsSync(target) || !statSync(target).isFile()) {
          return new Response("Not found", { status: 404 });
        }
        return fileResponse(target, statSync(target).size, req.headers.get("range"));
      }

      // 聊天图片 / 生成图 / OCR 页图 / TTS 音频：/<相对路径>。
      // pathname 一定带前导 "/"（"/audio/x.mp3"），而 safeJoin 把绝对路径视作越界，
      // 必须先剥掉再拼——否则这里会对每一个媒体请求回 403，音频预览直接显示「文件不存在」。
      const decoded = decodePath(url.pathname);
      if (decoded === null) return new Response("Bad request", { status: 400 });
      const rel = decoded.replace(/^\/+/, "");
      if (!rel) {
        return new Response("Not found", { status: 404 });
      }
      const filePath = safeJoin(baseDir, rel);
      if (!filePath) {
        logMediaFailure(403, rel, "safeJoin 判定越出数据目录", baseDir);
        return new Response("Forbidden", { status: 403 });
      }

      // 目录本身不是可预览对象（Bun.file 读目录会抛 EISDIR）。
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        logMediaFailure(404, rel, "文件不存在或不是普通文件", baseDir);
        return new Response("Not found", { status: 404 });
      }

      const size = statSync(filePath).size;
      return fileResponse(filePath, size, req.headers.get("range"));
    },
  });

  console.log(`Image server running on http://${IMAGE_SERVER_HOST}:${imageServerPort()}`);
}

// ---------------------------------------------------------------------------
// 启动 / 端口争用
// ---------------------------------------------------------------------------

/**
 * 媒体服务状态：
 * - `serving`：本实例占着端口，自己的数据自己服务。
 * - `shared`：端口被**同一个数据目录**的另一个实例占着（同频道开了两个）——效果等同正常。
 * - `blocked`：端口被别的进程（另一个频道的实例、或不相干的软件）占着——媒体 URL 会打到
 *   别人的数据目录上，预览要么取不到、要么取到别人的同名文件，必须让用户看到。
 */
export type MediaServerState = "serving" | "shared" | "blocked";

export type MediaServerStatus = {
  state: MediaServerState;
  /** blocked 时：占用者进程号（探到身份才有）。 */
  holderPid?: number;
  /** blocked 时：占用者是本应用的另一个实例（数据目录不同）。 */
  otherInstance?: boolean;
};

/** 端口被占时的重试间隔：另一个实例退出后本实例自动接管，不用重启应用。 */
const MEDIA_RETRY_MS = 5_000;

/**
 * 初始值取"最坏情况"：绑定成功会立刻改成 serving，绑定失败则由探测结论覆盖。
 * 宁可短暂地少报"正常"，也不要让界面以为媒体服务在跑（那正是这次要修的坑）。
 */
let mediaStatus: MediaServerStatus = { state: "blocked" };
let retryTimer: ReturnType<typeof setInterval> | null = null;
const mediaStatusListeners = new Set<(status: MediaServerStatus) => void>();

export function getMediaServerStatus(): MediaServerStatus {
  return mediaStatus;
}

export function onMediaServerStatusChange(cb: (status: MediaServerStatus) => void): () => void {
  mediaStatusListeners.add(cb);
  return () => {
    mediaStatusListeners.delete(cb);
  };
}

function setMediaStatus(next: MediaServerStatus, force = false): void {
  if (
    !force &&
    next.state === mediaStatus.state &&
    next.holderPid === mediaStatus.holderPid &&
    next.otherInstance === mediaStatus.otherInstance
  ) {
    return;
  }
  mediaStatus = next;
  for (const cb of mediaStatusListeners) cb(next);
}

/** 问一句"端口上是谁"：同一份数据目录可以共用，别的数据目录必须报警。 */
async function probeMediaServer(): Promise<{ pid?: number; sameData: boolean } | null> {
  try {
    const res = await fetch(`http://${IMAGE_SERVER_HOST}:${imageServerPort()}${MEDIA_ID_PATH}`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as { id?: unknown; pid?: unknown } | null;
    if (!json || typeof json.id !== "string") return null;
    return {
      pid: typeof json.pid === "number" ? json.pid : undefined,
      sameData: json.id === mediaServerId(),
    };
  } catch {
    return null;
  }
}

/** 端口被占：探明占用者身份，并持续重试，等对方退出后接管。 */
async function acquireMediaServer(retryMs: number): Promise<void> {
  const holder = await probeMediaServer();
  const shared = !!holder?.sameData;
  // 初始值只是"还没探明"的占位，探测结论无论是否与它相同都要发出去（通知依赖这次事件）。
  setMediaStatus(
    shared ? { state: "shared" } : { state: "blocked", holderPid: holder?.pid, otherInstance: !!holder },
    true,
  );
  // blocked 是"这一整轮会话里所有预览都会取不到内容"的状态，必须落进统一日志：
  // 过去只有一行 console.warn，打包应用从 Finder 启动时没人接 stdout，等于没有线索。
  logEvent({
    level: shared ? "info" : "error",
    source: "media-server",
    event: shared ? "media.server.shared" : "media.server.blocked",
    message: shared
      ? `媒体服务端口 ${imageServerPort()} 由同一数据目录的另一个实例在服务（预览正常）`
      : `媒体服务端口 ${imageServerPort()} 被${
          holder ? `另一个实例占用（pid ${holder.pid}，数据目录不同）` : "其它进程占用"
        }：图片 / 音频预览会取不到内容，等它退出后本实例会自动接管`,
    detail: {
      port: imageServerPort(),
      holderPid: holder?.pid ?? null,
      otherInstance: !!holder,
      baseDir: getImagesBaseDir(),
    },
  });

  if (retryTimer) return;
  retryTimer = setInterval(() => {
    try {
      bindMediaServer();
    } catch {
      return; // 还被占着，下一轮再试
    }
    if (retryTimer) clearInterval(retryTimer);
    retryTimer = null;
    setMediaStatus({ state: "serving" }, true);
    logEvent({
      level: "info",
      source: "media-server",
      event: "media.server.serving",
      message: `媒体服务已接管端口 ${imageServerPort()}（原占用者已退出），预览恢复`,
      detail: { port: imageServerPort(), baseDir: getImagesBaseDir() },
    });
  }, retryMs);
  // 不能让重试定时器把进程（或测试进程）挂住。
  (retryTimer as unknown as { unref?: () => void }).unref?.();
}

/**
 * 启动媒体服务。端口被占不再默默降级——过去的写法是 catch 住 EADDRINUSE 就算了，
 * 于是第二个实例（另一个频道 / 另一个数据目录）整个会话都没有媒体服务，图片、音频预览
 * 全挂，只在控制台留一行 warn。现在探明占用者、暴露状态、并在对方退出后自动接管。
 */
export function startImageServer(opts: { retryMs?: number } = {}): void {
  try {
    bindMediaServer();
  } catch (e) {
    console.warn(`媒体服务端口 ${imageServerPort()} 被占用，稍后重试`, e);
    void acquireMediaServer(opts.retryMs ?? MEDIA_RETRY_MS);
    return;
  }
  setMediaStatus({ state: "serving" }, true);
  // 每次启动记一条：媒体服务服务的是哪份数据目录 —— 预览取不到内容时，
  // 第一个要排除的就是"URL 打到了别人的数据目录上"。
  logEvent({
    level: "info",
    source: "media-server",
    event: "media.server.serving",
    message: `媒体服务已就绪：http://${IMAGE_SERVER_HOST}:${imageServerPort()}`,
    detail: { port: imageServerPort(), baseDir: getImagesBaseDir() },
  });
}

export function imageUrl(docId: number, filename: string): string {
  return `http://${IMAGE_SERVER_HOST}:${imageServerPort()}/${docId}/${filename}`;
}

// Chat images are stored under images/<...> with a ref like "chat/<convId>/<file>".
// The ref is relative to the images base dir so it can be persisted in messages.
export { chatImageUrl } from "../shared/server-info";

export function chatImageDir(conversationId: number): string {
  return path.join(getImagesBaseDir(), "chat", String(conversationId));
}
