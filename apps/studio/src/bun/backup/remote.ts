/**
 * 远端备份：S3 兼容对象存储（AWS / Cloudflare R2 / MinIO / 阿里云 OSS / 腾讯云 COS）
 * 与 WebDAV（坚果云 / Nextcloud / 群晖 / Box）。
 *
 * 刻意不引 SDK：两者都用 `fetch` 直连 —— S3 自己实现 AWS Signature V4
 * （只用到 PUT / GET / DELETE / ListObjectsV2），WebDAV 就是 Basic 认证的
 * HTTP 方法（PUT / GET / PROPFIND / DELETE）。少一个依赖，也就少一层
 * 在 Electrobun 自定义 Bun 运行时上的兼容风险。
 *
 * 上传用单次 PUT：S3 单请求上限 5 GB，超了直接给出明确错误（分片上传是后续话题）。
 * 凭据只存在本机数据库里，且备份自身会把它们剔除（见 shared/backup.ts 的密钥规则）。
 */
import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import type { BackupRemoteConfig, BackupRemoteEntry } from "../../shared/backup";

/** S3 单次 PUT 的上限；超过要走分片上传，这里先明确拒绝而不是半途失败。 */
const S3_MAX_PUT_BYTES = 5 * 1024 * 1024 * 1024;

export interface RemoteProgress {
  /** 已传输字节。 */
  transferred: number;
  total: number;
  percent: number;
}

export type ProgressSink = (p: RemoteProgress) => void;

/**
 * 请求超时。
 *
 * fetch 默认没有超时：对端不响应（网络黑洞 / 代理挂起）时，备份任务会永远挂着，
 * 用户只看到进度条不动。元数据操作给 60 秒，传文件给 20 分钟上限。
 */
const META_TIMEOUT_MS = 60_000;
const TRANSFER_TIMEOUT_MS = 20 * 60_000;

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return cause ? `${err.message}（${String(cause)}）` : err.message;
  }
  return String(err);
}

// ---------------------------------------------------------------------------
// 配置校验
// ---------------------------------------------------------------------------

export function validateRemoteConfig(config: BackupRemoteConfig): { ok: boolean; error?: string } {
  if (!config.endpoint.trim()) {
    return { ok: false, error: config.kind === "s3" ? "缺少 S3 服务地址" : "缺少 WebDAV 地址" };
  }
  try {
    const url = new URL(config.endpoint);
    if (url.protocol === "http:" || url.protocol === "https:") {
      // http 明文会泄露凭据：允许但由 UI 提示
    } else {
      return { ok: false, error: "地址必须以 http:// 或 https:// 开头" };
    }
  } catch {
    return { ok: false, error: "地址格式不正确（需要以 http:// 或 https:// 开头的完整地址）" };
  }
  if (!config.accessKey.trim()) return { ok: false, error: config.kind === "s3" ? "缺少 Access Key" : "缺少用户名" };
  if (!config.secretKey) return { ok: false, error: config.kind === "s3" ? "缺少 Secret Key" : "缺少密码" };
  if (config.kind === "s3") {
    if (!config.bucket.trim()) return { ok: false, error: "缺少 Bucket" };
    if (!config.region.trim()) return { ok: false, error: "缺少 Region" };
    if (!/^[a-zA-Z0-9._-]+$/.test(config.bucket.trim())) return { ok: false, error: "Bucket 名不合法" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// AWS Signature V4
// ---------------------------------------------------------------------------

/** RFC3986 编码：保留 A-Za-z0-9-_.~，其余大写百分号编码。 */
export function uriEncode(value: string, encodeSlash = true): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(ch)) out += ch;
    else if (ch === "/" && !encodeSlash) out += ch;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

export interface SignedRequest {
  headers: Record<string, string>;
  /** 便于测试与排错：中间产物。 */
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

/**
 * 计算 SigV4 签名头（header 签名方式）。
 *
 * 只支持 S3 需要的场景：无 body 或已知 payload 哈希、单值 header、
 * 查询串按 key 排序。`date` 可注入，测试才能对固定向量断言。
 */
export function signS3Request(opts: {
  method: string;
  /** 已编码好的路径（以 / 开头）。 */
  path: string;
  query?: Record<string, string>;
  host: string;
  region: string;
  accessKey: string;
  secretKey: string;
  payloadHash: string;
  headers?: Record<string, string>;
  /** `20130524T000000Z` 形式；缺省用当前时间。 */
  amzDate?: string;
}): SignedRequest {
  const amzDate = opts.amzDate ?? new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...(opts.headers ?? {}),
    host: opts.host,
    "x-amz-content-sha256": opts.payloadHash,
    "x-amz-date": amzDate,
  };

  const sortedNames = Object.keys(headers)
    .map((n) => n.toLowerCase())
    .sort();
  const canonicalHeaders = sortedNames
    .map((name) => `${name}:${String(headers[name] ?? headers[Object.keys(headers).find((k) => k.toLowerCase() === name)!]).trim()}\n`)
    .join("");
  const signedHeaders = sortedNames.join(";");

  const queryEntries = Object.entries(opts.query ?? {})
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const canonicalQuery = queryEntries.map(([k, v]) => `${k}=${v}`).join("&");

  const canonicalRequest = [
    opts.method.toUpperCase(),
    opts.path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    opts.payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${opts.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${opts.secretKey}`, dateStamp);
  const kRegion = hmac(kDate, opts.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  return {
    canonicalRequest,
    stringToSign,
    signature,
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

// ---------------------------------------------------------------------------
// 目标地址
// ---------------------------------------------------------------------------

export const EMPTY_SHA256 = sha256Hex("");

/** 远端对象名：`<prefix>/<文件名>`（去掉多余斜杠）。 */
export function objectKey(config: BackupRemoteConfig, fileName: string): string {
  const prefix = config.prefix.trim().replace(/^\/+|\/+$/g, "");
  return prefix ? `${prefix}/${fileName}` : fileName;
}

/** S3 请求 URL（path-style 或 virtual-host）。 */
export function s3Url(config: BackupRemoteConfig, key: string, query?: Record<string, string>): { url: URL; host: string; path: string } {
  const endpoint = new URL(config.endpoint.trim());
  const bucket = config.bucket.trim();
  const encodedKey = key
    .split("/")
    .map((seg) => uriEncode(seg))
    .join("/");
  if (config.forcePathStyle) {
    const basePath = endpoint.pathname.replace(/\/+$/, "");
    const path = `${basePath}/${uriEncode(bucket)}/${encodedKey}`;
    const url = new URL(endpoint.toString());
    url.pathname = path;
    url.search = "";
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.append(k, v);
    return { url, host: endpoint.host, path };
  }
  const host = `${bucket}.${endpoint.host}`;
  const path = `${endpoint.pathname.replace(/\/+$/, "")}/${encodedKey}`;
  const url = new URL(endpoint.toString());
  url.host = host;
  url.pathname = path;
  url.search = "";
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.append(k, v);
  return { url, host, path };
}

/** WebDAV 上的目标 URL（把文件名拼到目录地址后面）。 */
export function webdavUrl(config: BackupRemoteConfig, fileName: string): URL {
  const base = new URL(config.endpoint.trim());
  const prefix = config.prefix.trim().replace(/^\/+|\/+$/g, "");
  const basePath = base.pathname.replace(/\/+$/, "");
  base.pathname = `${basePath}/${prefix ? `${prefix.split("/").map((seg) => uriEncode(seg)).join("/")}/` : ""}${uriEncode(fileName)}`;
  return base;
}

function basicAuth(config: BackupRemoteConfig): string {
  return `Basic ${Buffer.from(`${config.accessKey}:${config.secretKey}`, "utf8").toString("base64")}`;
}

// ---------------------------------------------------------------------------
// 文件流（带进度）
// ---------------------------------------------------------------------------

/** 把文件包成"读一块、报一次进度"的流，交给 fetch 作为请求体（不整份读进内存）。 */
export function fileBodyWithProgress(
  filePath: string,
  total: number,
  onProgress?: ProgressSink,
): ReadableStream<Uint8Array> {
  const reader = createReadStream(filePath, { highWaterMark: 1 << 20 })[Symbol.asyncIterator]();
  let transferred = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.next();
      if (next.done) {
        controller.close();
        return;
      }
      const chunk = next.value as Buffer;
      transferred += chunk.length;
      onProgress?.({
        transferred,
        total,
        percent: total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : 0,
      });
      controller.enqueue(new Uint8Array(chunk));
    },
    async cancel(reason) {
      await reader.return?.(reason);
    },
  });
}

async function responseError(res: Response, what: string): Promise<string> {
  let detail = "";
  try {
    detail = (await res.text()).slice(0, 400).replace(/\s+/g, " ").trim();
  } catch {
    // 读不出正文就算了
  }
  const hint =
    res.status === 401 || res.status === 403
      ? "（凭据或权限不对）"
      : res.status === 404
        ? "（地址 / Bucket 不存在）"
        : res.status === 405
          ? "（该服务不允许这个方法）"
          : "";
  return `${what}失败：HTTP ${res.status}${hint}${detail ? ` · ${detail}` : ""}`;
}

// ---------------------------------------------------------------------------
// 上传 / 下载 / 列表 / 测试
// ---------------------------------------------------------------------------

export interface UploadResult {
  key: string;
  bytes: number;
  /** 可读的远端位置，便于展示 / 复制。 */
  location: string;
}

export async function uploadBackup(params: {
  config: BackupRemoteConfig;
  filePath: string;
  fileName: string;
  onProgress?: ProgressSink;
  signal?: AbortSignal;
}): Promise<UploadResult> {
  const { config, filePath, fileName } = params;
  const invalid = validateRemoteConfig(config);
  if (!invalid.ok) throw new Error(invalid.error);
  const size = (await stat(filePath)).size;

  if (config.kind === "s3") {
    if (size > S3_MAX_PUT_BYTES) {
      throw new Error(
        `备份文件 ${(size / 1024 ** 3).toFixed(2)} GB 超过 S3 单次上传上限 5 GB：请减少备份内容（例如排除媒体），或先传到本地再手动分片上传。`,
      );
    }
    const key = objectKey(config, fileName);
    const { url, host, path } = s3Url(config, key);
    const payloadHash = await sha256FileHex(filePath);
    const signed = signS3Request({
      method: "PUT",
      path,
      host,
      region: config.region.trim(),
      accessKey: config.accessKey.trim(),
      secretKey: config.secretKey,
      payloadHash,
      headers: { "content-length": String(size), "content-type": "application/octet-stream" },
    });
    const res = await fetch(url, {
      method: "PUT",
      headers: signed.headers,
      body: fileBodyWithProgress(filePath, size, params.onProgress),
      signal: withTimeout(params.signal, TRANSFER_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(await responseError(res, "上传到 S3"));
    params.onProgress?.({ transferred: size, total: size, percent: 100 });
    return { key, bytes: size, location: `${url.origin}/${config.bucket.trim()}/${key}` };
  }

  const url = webdavUrl(config, fileName);
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      authorization: basicAuth(config),
      "content-length": String(size),
      "content-type": "application/octet-stream",
    },
    body: fileBodyWithProgress(filePath, size, params.onProgress),
    signal: withTimeout(params.signal, TRANSFER_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(await responseError(res, "上传到 WebDAV"));
  params.onProgress?.({ transferred: size, total: size, percent: 100 });
  return { key: objectKey(config, fileName), bytes: size, location: url.toString() };
}

async function sha256FileHex(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function listRemoteBackups(params: {
  config: BackupRemoteConfig;
  signal?: AbortSignal;
}): Promise<BackupRemoteEntry[]> {
  const { config } = params;
  const invalid = validateRemoteConfig(config);
  if (!invalid.ok) throw new Error(invalid.error);
  const prefix = config.prefix.trim().replace(/^\/+|\/+$/g, "");
  if (config.kind === "s3") {
    const listPrefix = prefix ? `${prefix}/` : "";
    const { url, host, path } = s3Url(config, "", { "list-type": "2", prefix: listPrefix });
    // s3Url 会拼出一个尾部斜杠的 key，这里按前缀形式重建路径
    const listPath = path.replace(/\/$/, "");
    const signed = signS3Request({
      method: "GET",
      path: listPath,
      query: { "list-type": "2", prefix: listPrefix },
      host,
      region: config.region.trim(),
      accessKey: config.accessKey.trim(),
      secretKey: config.secretKey,
      payloadHash: EMPTY_SHA256,
    });
    const res = await fetch(url, { headers: signed.headers, signal: withTimeout(params.signal, META_TIMEOUT_MS) });
    if (!res.ok) throw new Error(await responseError(res, "列取 S3 备份"));
    const xml = await res.text();
    const entries: BackupRemoteEntry[] = [];
    for (const block of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const body = block[1]!;
      const key = xmlText(body, "Key");
      const name = key.split("/").pop() ?? "";
      if (!name.endsWith(".omnibackup")) continue;
      entries.push({
        name,
        bytes: Number(xmlText(body, "Size")) || 0,
        modifiedAt: Date.parse(xmlText(body, "LastModified")) || 0,
      });
    }
    return entries.sort((a, b) => b.modifiedAt - a.modifiedAt);
  }

  const base = new URL(config.endpoint.trim());
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/${prefix ? `${prefix.split("/").map((seg) => uriEncode(seg)).join("/")}/` : ""}`;
  const res = await fetch(base, {
    method: "PROPFIND",
    headers: { authorization: basicAuth(config), depth: "1", "content-type": "application/xml" },
    body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>',
    signal: withTimeout(params.signal, META_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(await responseError(res, "列取 WebDAV 备份"));
  const xml = await res.text();
  const entries: BackupRemoteEntry[] = [];
  for (const block of xml.matchAll(/<[a-z]*:?response[\s>][\s\S]*?<\/[a-z]*:?response>/gi)) {
    const body = block[0];
    const href = xmlText(body, "href");
    const name = decodeURIComponent(href.split("/").filter(Boolean).pop() ?? "");
    if (!name.endsWith(".omnibackup")) continue;
    entries.push({
      name,
      bytes: Number(xmlText(body, "getcontentlength")) || 0,
      modifiedAt: Date.parse(xmlText(body, "getlastmodified")) || 0,
    });
  }
  return entries.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

function xmlText(xml: string, tag: string): string {
  const match = new RegExp(`<[a-z]*:?${tag}[^>]*>([\\s\\S]*?)</[a-z]*:?${tag}>`, "i").exec(xml);
  if (!match) return "";
  return match[1]!
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .trim();
}

export async function downloadBackup(params: {
  config: BackupRemoteConfig;
  fileName: string;
  destPath: string;
  onProgress?: ProgressSink;
  signal?: AbortSignal;
}): Promise<{ bytes: number }> {
  const { config, fileName, destPath } = params;
  const invalid = validateRemoteConfig(config);
  if (!invalid.ok) throw new Error(invalid.error);

  let res: Response;
  if (config.kind === "s3") {
    const key = objectKey(config, fileName);
    const { url, host, path } = s3Url(config, key);
    const signed = signS3Request({
      method: "GET",
      path,
      host,
      region: config.region.trim(),
      accessKey: config.accessKey.trim(),
      secretKey: config.secretKey,
      payloadHash: EMPTY_SHA256,
    });
    res = await fetch(url, { headers: signed.headers, signal: withTimeout(params.signal, TRANSFER_TIMEOUT_MS) });
  } else {
    res = await fetch(webdavUrl(config, fileName), {
      headers: { authorization: basicAuth(config) },
      signal: withTimeout(params.signal, TRANSFER_TIMEOUT_MS),
    });
  }
  if (!res.ok) throw new Error(await responseError(res, "下载备份"));
  if (!res.body) throw new Error("下载失败：响应没有正文");

  const total = Number(res.headers.get("content-length")) || 0;
  let received = 0;
  const reader = res.body.getReader();
  const writer = Bun.file(destPath).writer();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        await writer.write(value);
        received += value.length;
        params.onProgress?.({
          transferred: received,
          total,
          percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0,
        });
      }
    }
  } finally {
    await writer.end();
  }
  return { bytes: received };
}

export async function deleteRemoteBackup(params: {
  config: BackupRemoteConfig;
  fileName: string;
  signal?: AbortSignal;
}): Promise<void> {
  const { config, fileName } = params;
  const invalid = validateRemoteConfig(config);
  if (!invalid.ok) throw new Error(invalid.error);
  if (config.kind === "s3") {
    const key = objectKey(config, fileName);
    const { url, host, path } = s3Url(config, key);
    const signed = signS3Request({
      method: "DELETE",
      path,
      host,
      region: config.region.trim(),
      accessKey: config.accessKey.trim(),
      secretKey: config.secretKey,
      payloadHash: EMPTY_SHA256,
    });
    const res = await fetch(url, { method: "DELETE", headers: signed.headers, signal: withTimeout(params.signal, META_TIMEOUT_MS) });
    if (!res.ok && res.status !== 404) throw new Error(await responseError(res, "删除远端备份"));
    return;
  }
  const res = await fetch(webdavUrl(config, fileName), {
    method: "DELETE",
    headers: { authorization: basicAuth(config) },
    signal: withTimeout(params.signal, META_TIMEOUT_MS),
  });
  if (!res.ok && res.status !== 404) throw new Error(await responseError(res, "删除远端备份"));
}

/**
 * 连通性测试：列一次目录（顺带验证签名 / 权限 / 前缀是否存在），
 * 比 HEAD bucket 更贴近真实使用（列出要读权限，上传要写权限，这里先验读）。
 */
export async function testRemote(params: {
  config: BackupRemoteConfig;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; error?: string; detail?: string; count?: number }> {
  const invalid = validateRemoteConfig(params.config);
  if (!invalid.ok) return { ok: false, error: invalid.error };
  try {
    const entries = await listRemoteBackups({ config: params.config, signal: params.signal });
    return {
      ok: true,
      count: entries.length,
      detail: entries.length
        ? `目录可访问，已有 ${entries.length} 份备份`
        : "目录可访问（远端还没有备份）",
    };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}
