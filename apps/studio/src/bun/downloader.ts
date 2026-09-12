import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "fs";
import path from "path";

export type DownloadProgress = {
  received: number;
  total: number | null;
  percent: number | null;
};

export type DownloadOptions = {
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
  /**
   * 远端总大小（市场列表里已经有 `MarketFile.size`）。给了就不再发探测请求，
   * 少一次往返、也少一个能卡住的点。
   */
  total?: number | null;
  /** 连接空闲多久算卡死（毫秒）。默认 30s；测试注入小值。 */
  idleTimeoutMs?: number;
  /** 每个文件的并行连接数覆盖值。 */
  parts?: number;
  /** 每片最多尝试次数（含首次）。 */
  partAttempts?: number;
  /** 每片失败后的退避上限（毫秒）。 */
  maxBackoffMs?: number;
  /** 整套下载的重试轮数（分片级重试之外的兜底）。 */
  rounds?: number;
  /** 测试用：记录每次 Range 请求，服务于并发/续传断言。 */
  onRangeRequest?: (info: { partIndex: number; start: number; end: number }) => void;
};

/** 单个文件并发连接数：8 路在 ModelScope 上会偶发 500，4 路更稳。 */
const DEFAULT_PARTS = 4;
/** 小于该大小不分片，直接单流。 */
const PARALLEL_MIN_TOTAL = 4 * 1024 * 1024;
/** 每片最少字节：文件越大片越多，但不超过并发上限。 */
const PART_MIN_BYTES = 8 * 1024 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_PART_ATTEMPTS = 3;
const DEFAULT_MAX_BACKOFF_MS = 15_000;
const DEFAULT_ROUNDS = 2;
/** 搬分片进最终文件时的读缓冲。 */
const FLUSH_CHUNK_BYTES = 4 * 1024 * 1024;
/** 探测总大小的超时。没有它，服务器不响应会让任务永远卡在「等待中」。 */
const PROBE_TIMEOUT_MS = 15_000;
/** 判定「磁盘进度还能用」的大小容差（远端可能被重新上传但大小接近）。 */
const SIZE_TOLERANCE = 4096;

/** 可重试的 HTTP 状态：限流与服务端瞬时故障。404/403 重试没意义。 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

type PartRecord = {
  index: number;
  start: number;
  /** 结束偏移（不含）。 */
  end: number;
  /** 旁路分片文件里已有的字节数。 */
  have: number;
};

type Sidecar = {
  url: string;
  total: number;
  etag: string | null;
  /**
   * 已经搬进最终文件的字节数（从 0 开始的连续前缀）。这是进度的权威记录 ——
   * 不能再从最终文件长度推断：文件会被预分配到完整大小，长度不再等于已下字节。
   */
  flushed: number;
  parts: PartRecord[];
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/** 同时下载几个文件（download-manager 用）。 */
export function concurrentFileLimit(): number {
  return envInt("OMNI_DOWNLOAD_FILES", 2);
}

export function partCountFor(total: number, override?: number): number {
  const parts = override ?? envInt("OMNI_DOWNLOAD_PARTS", DEFAULT_PARTS);
  return Math.max(1, Math.min(parts, Math.ceil(total / PART_MIN_BYTES)));
}

function sidecarPath(destPath: string): string {
  return `${destPath}.download.json`;
}

function partPath(destPath: string, index: number): string {
  return `${destPath}.part${index}`;
}

function sizeOf(p: string): number {
  try {
    return existsSync(p) ? statSync(p).size : 0;
  } catch {
    return 0;
  }
}

/**
 * 把最终文件预分配到目标大小。
 *
 * 下载过程中我们会往文件中间定位写，不预分配的话文件会有空洞、长度也不等于
 * 目标大小（后面 flush 再截断就靠它）。长度一旦确定，进度就不能再看它了 ——
 * 见 Sidecar.flushed。
 */
function preallocate(destPath: string, total: number): void {
  const fd = ensureOpenRw(destPath);
  try {
    ftruncateSync(fd, total);
  } finally {
    closeSync(fd);
  }
}

/**
 * 以「读写 + 定位写」方式打开，必要时先创建。
 * 定位写（writeSync 的 position）要求文件已存在，所以不能直接 open(r+)。
 */
function ensureOpenRw(destPath: string): number {
  if (!existsSync(destPath)) {
    const created = openSync(destPath, "a");
    closeSync(created);
  }
  return openSync(destPath, "r+");
}

function partFilesOnDisk(destPath: string): string[] {
  try {
    const dir = path.dirname(destPath);
    const base = path.basename(destPath);
    return readdirSync(dir)
      .filter((n) => n.startsWith(`${base}.part`))
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

function loadSidecar(destPath: string): Sidecar | null {
  try {
    const parsed = JSON.parse(readFileSync(sidecarPath(destPath), "utf8")) as Partial<Sidecar>;
    if (
      typeof parsed.total !== "number" ||
      !(parsed.total > 0) ||
      !Array.isArray(parsed.parts) ||
      parsed.parts.length === 0 ||
      !parsed.parts.every(
        (p) =>
          p &&
          Number.isFinite(p.start) &&
          Number.isFinite(p.end) &&
          Number.isFinite(p.have) &&
          p.end > p.start,
      )
    ) {
      return null;
    }
    return {
      url: typeof parsed.url === "string" ? parsed.url : "",
      total: parsed.total,
      etag: typeof parsed.etag === "string" ? parsed.etag : null,
      flushed: Number.isFinite(parsed.flushed) ? Math.max(0, Math.min(parsed.flushed!, parsed.total)) : 0,
      parts: parsed.parts.map((p, index) => ({
        index: Number.isFinite(p.index) ? p.index : index,
        start: p.start,
        end: p.end,
        have: Math.max(0, Math.min(p.have, p.end - p.start)),
      })),
    };
  } catch {
    return null;
  }
}

function saveSidecar(destPath: string, sidecar: Sidecar): void {
  try {
    writeFileSync(sidecarPath(destPath), JSON.stringify(sidecar));
  } catch {
    // 落盘失败只丢进度记忆，不影响本次下载。
  }
}

function cleanupSidecar(destPath: string): void {
  rmSync(sidecarPath(destPath), { force: true });
}

function removeParts(destPath: string, parts: readonly PartRecord[]): void {
  for (const p of parts) rmSync(partPath(destPath, p.index), { force: true });
}

/**
 * 磁盘上已下载的字节（最终文件里已就位的 + 分片里的），不发任何请求。
 * 市场列表用它显示「继续下载（已 1.2/4.5 GB）」。
 */
export function partialBytesFor(destPath: string, total?: number | null): number {
  const sidecar = loadSidecar(destPath);
  if (!sidecar) {
    // 没有侧车：只有老版本留下的半成品最终文件（长度就是进度）。
    return sizeOf(destPath);
  }
  if (total != null && Math.abs(sidecar.total - total) > SIZE_TOLERANCE) return 0;
  let inParts = 0;
  for (const part of sidecar.parts) inParts += part.have;
  // 不能用最终文件长度：它一开始就被预分配到完整大小了。
  return Math.min(sidecar.total, sidecar.flushed + inParts);
}

/** 清理某个文件的全部旁路数据（取消下载用）。 */
export function removePartialFiles(destPath: string): void {
  rmSync(destPath, { force: true });
  cleanupSidecar(destPath);
  rmSync(`${destPath}.merge`, { force: true });
  for (const p of partFilesOnDisk(destPath)) rmSync(p, { force: true });
}

/** [start, end) 均分 total。 */
function partRanges(total: number, count: number): { start: number; end: number }[] {
  return Array.from({ length: count }, (_, i) => ({
    start: Math.floor((total * i) / count),
    end: i === count - 1 ? total : Math.floor((total * (i + 1)) / count),
  }));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (!signal) {
      setTimeout(resolve, ms);
      return;
    }
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function partsComplete(sidecar: Sidecar): boolean {
  return sidecar.parts.every((p) => p.have >= p.end - p.start);
}

function abortError(): Error {
  return new DOMException("Aborted", "AbortError");
}

/** 指数退避 + 抖动；服务端给了 Retry-After 就听它的（上限 60s）。 */
function backoffMs(attempt: number, retryAfter: number | null, maxMs: number): number {
  if (retryAfter != null) return Math.min(60_000, retryAfter);
  const base = Math.min(maxMs, 1000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.7 + Math.random() * 0.6));
}

function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : null;
}

function parseContentLength(res: Response): number | null {
  const v = res.headers.get("content-length");
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 解析 `Content-Range: bytes 0-499/1234`（end 含）。 */
function parseContentRange(
  value: string | null,
): { start: number; end: number; total: number } | null {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+)$/.exec((value ?? "").trim());
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]), total: Number(m[3]) };
}

class RangeMismatch extends Error {}
/** 磁盘上的字节数与预期不符（通常是调用方给的 total 过期）。 */
class SizeMismatch extends Error {}
class HttpStatusError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly retryAfter: number | null,
  ) {
    super(message);
  }
}

function isRetryable(e: unknown): boolean {
  if (e instanceof HttpStatusError) return e.retryable;
  // RangeMismatch（服务器忽略/给错区间）重试同一地址也没用，交给上层回退或报错。
  if (e instanceof RangeMismatch) return false;
  // SizeMismatch（远端大小与预期不符）必须立刻上报，由外层按真实大小重排分片；
  // 当成可重试错误会继续沿用旧布局，把区间拉长后拼出坏文件。
  if (e instanceof SizeMismatch) return false;
  return true;
}

/**
 * 探测远端总大小与 ETag：`Range: bytes=0-0` 读 Content-Range；不支持 Range
 * 时退回 content-length。带超时，绝不无限等。
 */
async function probeRemote(
  url: string,
  signal?: AbortSignal,
): Promise<{ total: number | null; etag: string | null }> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Range: "bytes=0-0" },
      redirect: "follow",
      signal: controller.signal,
    });
    const etag = res.headers.get("etag");
    const range = parseContentRange(res.headers.get("content-range"));
    const total = range?.total ?? (res.status === 200 ? parseContentLength(res) : null);
    await res.body?.cancel();
    return { total, etag };
  } catch {
    return { total: null, etag: null };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * 带 Range 的单流下载（文件小、或服务器不支持 Range 时）。从头写还是续写由
 * 磁盘上的大小决定；每读一段都重置空闲看门狗，连接活着但不下数据就掐掉重连。
 */
async function downloadSingle(
  url: string,
  destPath: string,
  opts: DownloadOptions,
  totals: { total: number | null },
  onReceived: (bytes: number) => void,
): Promise<void> {
  const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const attempts = opts.partAttempts ?? DEFAULT_PART_ATTEMPTS;
  const maxBackoff = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

  for (let attempt = 1; ; attempt++) {
    if (opts.signal?.aborted) throw abortError();
    let existing = sizeOf(destPath);
    // 磁盘上比预期还长：大概率是调用方给的 total 过期（远端换过文件），
    // 别在末尾接一段新内容，清掉从头下。
    if (totals.total != null && existing > totals.total + SIZE_TOLERANCE) {
      rmSync(destPath, { force: true });
      existing = 0;
    }
    if (totals.total != null && existing >= totals.total) return;

    const headers: Record<string, string> = {};
    if (existing > 0) headers["Range"] = `bytes=${existing}-`;

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    let idleTimer: ReturnType<typeof setTimeout> | null = setTimeout(
      () => controller.abort(new Error("stalled")),
      idleMs,
    );
    const bumpIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(new Error("stalled")), idleMs);
    };

    let fd: number | null = null;
    try {
      const res = await fetch(url, { headers, redirect: "follow", signal: controller.signal });
      if (res.status === 416) {
        // 服务端认为已到末尾：磁盘上的就是全部。
        totals.total = existing;
        return;
      }
      if (!res.ok) {
        throw new HttpStatusError(
          `Download failed: ${res.status}`,
          res.status,
          RETRYABLE_STATUS.has(res.status),
          retryAfterMs(res),
        );
      }

      const isResume = res.status === 206 && existing > 0;
      if (isResume) {
        const range = parseContentRange(res.headers.get("content-range"));
        if (range && range.start !== existing) {
          throw new RangeMismatch(`续传区间不符：请求 ${existing}，服务端给了 ${range.start}`);
        }
      }
      const contentLength = parseContentLength(res);
      if (totals.total == null && contentLength != null) {
        totals.total = isResume ? existing + contentLength : contentLength;
      }

      const stream = res.body;
      if (!stream) throw new Error("No response body");

      fd = ensureOpenRw(destPath);
      const reader = stream.getReader();
      let position = isResume ? existing : 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        writeSync(fd, value, 0, value.byteLength, position);
        position += value.byteLength;
        onReceived(value.byteLength);
        bumpIdle();
      }
      if (totals.total != null && position < totals.total) {
        throw new Error(`下载中断（${position}/${totals.total} 字节）`);
      }
      return;
    } catch (e) {
      if (opts.signal?.aborted) throw abortError();
      if (!isRetryable(e) || attempt >= attempts) throw e;
      await sleep(
        backoffMs(attempt, e instanceof HttpStatusError ? e.retryAfter : null, maxBackoff),
        opts.signal,
      );
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (fd != null) {
        try {
          closeSync(fd);
        } catch {
          // ignore
        }
      }
    }
  }
}

/** 单个分片：从 `part.have` 续传，带退避重试与卡死重连。 */
async function fetchPart(
  url: string,
  destPath: string,
  part: PartRecord,
  opts: DownloadOptions,
  totals: { total: number | null },
  onReceived: (bytes: number) => void,
): Promise<void> {
  const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const attempts = opts.partAttempts ?? DEFAULT_PART_ATTEMPTS;
  const maxBackoff = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const length = part.end - part.start;
  const p = partPath(destPath, part.index);

  for (let attempt = 1; ; attempt++) {
    if (opts.signal?.aborted) throw abortError();
    if (part.have >= length) return;

    const wantStart = part.start + part.have;
    const wantEnd = part.end - 1;
    opts.onRangeRequest?.({ partIndex: part.index, start: wantStart, end: wantEnd });

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    let idleTimer: ReturnType<typeof setTimeout> | null = setTimeout(
      () => controller.abort(new Error("stalled")),
      idleMs,
    );
    const bumpIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(new Error("stalled")), idleMs);
    };

    let fd: number | null = null;
    try {
      const res = await fetch(url, {
        headers: { Range: `bytes=${wantStart}-${wantEnd}` },
        redirect: "follow",
        signal: controller.signal,
      });
      if (res.status === 200) {
        // 服务器忽略了 Range → 并行不可行，交给单流。
        await res.body?.cancel();
        throw new RangeMismatch("服务器忽略 Range");
      }
      if (res.status === 416) {
        await res.body?.cancel();
        throw new RangeMismatch(`分片 ${part.index} 越界（416）`);
      }
      if (!res.ok) {
        throw new HttpStatusError(
          `Range download failed: ${res.status}`,
          res.status,
          RETRYABLE_STATUS.has(res.status),
          retryAfterMs(res),
        );
      }
      const range = parseContentRange(res.headers.get("content-range"));
      if (range && range.start !== wantStart) {
        // 必须不写：写下去就是静默损坏。
        await res.body?.cancel();
        throw new RangeMismatch(`分片区间不符：请求 ${wantStart}，服务端给了 ${range.start}`);
      }
      if (range && totals.total != null && range.total !== totals.total) {
        // Content-Range 里的总长是权威值（HTTP 对 206 是强制的）：与预期不符说明
        // 调用方给的 total 过期了。先把权威值记下来再抛（注意别先覆盖再比较，
        // 那样永远相等、检查形同虚设 —— 这里踩过一次），由外层按真实大小重排。
        await res.body?.cancel();
        const expected = totals.total;
        totals.total = range.total;
        throw new SizeMismatch(`远端大小 ${range.total} 与预期 ${expected} 不符`);
      }
      const stream = res.body;
      if (!stream) throw new Error("No response body");

      fd = openSync(p, "a");
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        writeSync(fd, value);
        part.have = Math.min(length, part.have + value.byteLength);
        onReceived(value.byteLength);
        bumpIdle();
      }
      if (part.have < length) {
        throw new Error(`分片 ${part.index} 提前结束（${part.have}/${length} 字节）`);
      }
      return;
    } catch (e) {
      if (opts.signal?.aborted) throw abortError();
      if (!isRetryable(e) || attempt >= attempts) throw e;
      await sleep(
        backoffMs(attempt, e instanceof HttpStatusError ? e.retryAfter : null, maxBackoff),
        opts.signal,
      );
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (fd != null) {
        try {
          closeSync(fd);
        } catch {
          // ignore
        }
      }
    }
  }
}

/**
 * 把「前缀分片」搬进最终文件（定位写，不整文件重写）。
 *
 * 只有从 0 开始连续就绪的分片才搬：最终文件的长相永远是 [0, N) 的连续前缀，
 * 没有空洞。下完的片立刻搬走并删掉，所以「靠前的片空着、后面的片已下载」不会
 * 造成最终文件中间有洞。
 */
function flushReadyParts(
  destPath: string,
  sidecar: Sidecar,
  onPlaced: (bytes: number) => void,
  truncateTo?: number,
): void {
  const fd = ensureOpenRw(destPath);
  try {
    for (const part of sidecar.parts) {
      if (part.have < part.end - part.start) break;
      const p = partPath(destPath, part.index);
      if (!existsSync(p)) break;
      const length = part.end - part.start;
      const fdPart = openSync(p, "r");
      try {
        const buf = Buffer.allocUnsafe(Math.max(1, Math.min(FLUSH_CHUNK_BYTES, length)));
        let offset = 0;
        while (offset < length) {
          const want = Math.min(buf.byteLength, length - offset);
          const n = readSync(fdPart, buf, 0, want, offset);
          if (n <= 0) break;
          writeSync(fd, buf, 0, n, part.start + offset);
          offset += n;
        }
        if (offset < length) break;
      } finally {
        closeSync(fdPart);
      }
      unlinkSync(p);
      sidecar.flushed = part.end;
      onPlaced(length);
    }
    // 只有确认过权威总长时才截断：拿可能过期的预期值截断会把文件削短。
    if (truncateTo != null && sizeOf(destPath) !== truncateTo) {
      ftruncateSync(fd, truncateTo);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * 把「已经躺在最终路径上的字节」认领进分片，避免重下。
 *
 * 两种情况：
 * 1. 老版本单流写进最终路径的半成品（没有 sidecar）—— 是干净前缀，可直接拆片；
 * 2. 本轮下载边下边搬留下的前缀（有 sidecar）—— parts 的 have 已经记着，不必动。
 *
 * 最终路径比目标还长说明文件被换过（或者上一轮预期不同），长度不可信 → 丢弃重下。
 */
function adoptExistingFinal(destPath: string, sidecar: Sidecar, mirror: boolean): void {
  const size = sizeOf(destPath);
  if (size <= 0) return;
  if (mirror || size > sidecar.total + SIZE_TOLERANCE) {
    // 镜像（上一轮已搬走的前缀，长度可能被截断/预分配改过）或超长的旧文件：
    // 内容都不可信，清掉重下 —— 不能把垃圾字节当成已下载进度。
    rmSync(destPath, { force: true });
    return;
  }
  const placed = Math.min(size, sidecar.total);
  const fd = ensureOpenRw(destPath);
  try {
    for (const part of sidecar.parts) {
      const length = part.end - part.start;
      const from = Math.min(part.end, placed);
      const have = Math.max(0, from - part.start);
      if (have <= 0) break;
      const buf = Buffer.allocUnsafe(have);
      let read = 0;
      while (read < have) {
        const n = readSync(fd, buf, read, have - read, part.start + read);
        if (n <= 0) break;
        read += n;
      }
      if (read !== have) break;
      writeFileSync(partPath(destPath, part.index), buf);
      part.have = Math.min(have, length);
      if (have < length) break;
    }
  } finally {
    closeSync(fd);
  }
  // 已经躺在最终路径上的前缀就是已搬走的进度。
  for (const part of sidecar.parts) {
    if (part.have < part.end - part.start) break;
    sidecar.flushed = part.end;
  }
}

/**
 * 断点续传 + 多路并发的文件下载。
 *
 * - 进度真的落盘：分片文件 + `.download.json` 旁路记录；进程被杀、应用重启后
 *   从断点接着下，不重下一字节。
 * - 远端文件变了（大小或 ETag 变化）→ 旧分片作废重下，绝不拼出坏文件。
 * - 最终文件只在有把握时写：Range 与请求不符直接丢弃重试，不写出损坏内容。
 * - 每片内部重试 `partAttempts` 次（退避 + 抖动 + Retry-After），30s 无字节
 *   掐线重连；文件级再兜 `rounds` 轮。仍失败则抛错，分片与侧车保留待续。
 * - 服务器不支持 Range → 自动回退单流（同样支持 Range 续传）。
 * - 调用方给的 `total` 过期（远端换过文件）→ 自动清掉重来，按真实大小重下一轮。
 */
export async function downloadWithResume(
  url: string,
  destPath: string,
  opts: DownloadOptions = {},
): Promise<{ path: string; size: number }> {
  try {
    return await downloadOnce(url, destPath, opts);
  } catch (e) {
    // 远端大小与预期对不上（调用方给的 total 过期）→ 丢弃提示、重新探测再来一轮。
    // 其它错误（网络故障、被取消）原样抛出。
    if (!(e instanceof SizeMismatch)) throw e;
    return downloadOnce(url, destPath, { ...opts, total: null });
  }
}

async function downloadOnce(
  url: string,
  destPath: string,
  opts: DownloadOptions = {},
): Promise<{ path: string; size: number }> {
  mkdirSync(path.dirname(destPath), { recursive: true });
  // 老版本的整文件合并临时产物，留着只会占空间。
  rmSync(`${destPath}.merge`, { force: true });

  const totals: { total: number | null } = { total: opts.total ?? null };
  let remoteEtag: string | null = null;
  const onProgress = opts.onProgress;
  const report = (received: number, total: number | null, force100 = false) => {
    if (total != null && total > 0) {
      onProgress?.({
        received: Math.min(received, total),
        total,
        percent: force100 ? 100 : Math.min(100, (received / total) * 100),
      });
      return;
    }
    onProgress?.({ received, total, percent: null });
  };

  if (totals.total == null) {
    const probed = await probeRemote(url, opts.signal);
    totals.total = probed.total;
    remoteEtag = probed.etag;
    if (opts.signal?.aborted) throw abortError();
  }

  const total = totals.total;
  const budget = total != null ? partCountFor(total, opts.parts) : 1;
  const useParts = total != null && total >= PARALLEL_MIN_TOTAL && budget > 1;

  // —— 单流（小文件 or 服务器不支持 Range）——
  if (!useParts) {
    // 单流也不拿 hint 当权威：total 由响应头（Content-Range / Content-Length）确定，
    // hint 只用来提前显示进度。
    totals.total = null;
    let received = sizeOf(destPath);
    report(received, total);
    const rounds = opts.rounds ?? DEFAULT_ROUNDS;
    let lastError: unknown = null;
    for (let round = 1; round <= rounds; round++) {
      try {
        await downloadSingle(url, destPath, opts, totals, (bytes) => {
          received += bytes;
          report(received, totals.total);
        });
        lastError = null;
        break;
      } catch (e) {
        if (opts.signal?.aborted) throw abortError();
        lastError = e;
        received = sizeOf(destPath);
        if (round < rounds) {
          await sleep(backoffMs(round, null, opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS), opts.signal);
        }
      }
    }
    if (lastError) throw lastError;
    const size = sizeOf(destPath);
    report(size, totals.total ?? size, true);
    return { path: destPath, size };
  }

  // —— 分片并行 ——
  let sidecar = loadSidecar(destPath);
  const hadSidecar = sidecar != null;
  const layoutMatches = sidecar != null && sidecar.parts.length === budget;
  const remoteChanged =
    sidecar != null &&
    (Math.abs(sidecar.total - total) > SIZE_TOLERANCE ||
      (remoteEtag != null && sidecar.etag != null && remoteEtag !== sidecar.etag));
  if (sidecar && layoutMatches && !remoteChanged) {
    // 续传：分片文件里的字节与侧车记录是权威进度，最终路径只是「已搬走前缀」的
    // 镜像，别再动它（它的长度可能因为上一轮截断/预分配而不可信）。
    saveSidecar(destPath, sidecar);
  } else {
    if (sidecar) {
      // 布局变了（并发数改动）或远端换了大小 → 旧分片作废重排，绝不拼坏文件。
      removeParts(destPath, sidecar.parts);
      cleanupSidecar(destPath);
    }
    if (hadSidecar) {
      // 之前那一轮的最终文件内容（含预分配的完整长度）与当前布局无关：
      // 留着会被当成「老版本半成品」重新认领，拼出坏文件。
      rmSync(destPath, { force: true });
    }
    sidecar = {
      url,
      total,
      etag: remoteEtag,
      flushed: 0,
      parts: partRanges(total, budget).map((r, index) => ({ index, ...r, have: 0 })),
    };
    // 走到这里说明最终文件只可能是「老版本单流留下的半成品」（没有侧车），
    // 认领成干净前缀接着下；有侧车的镜像已在上面清掉。
    adoptExistingFinal(destPath, sidecar, false);
    // 预分配到完整大小：定位写不再留下空洞，flush 才能安全截断。
    preallocate(destPath, total);
    saveSidecar(destPath, sidecar);
  }

  const receivedSoFar = () => sidecar!.flushed + sidecar!.parts.reduce((a, p) => a + p.have, 0);
  let received = receivedSoFar();
  report(received, total);

  const rounds = opts.rounds ?? DEFAULT_ROUNDS;
  let lastError: unknown = null;
  for (let round = 1; round <= rounds; round++) {
    try {
      await Promise.all(
        sidecar.parts.map((part) =>
          fetchPart(url, destPath, part, opts, totals, (bytes) => {
            received += bytes;
            report(received, total);
          }),
        ),
      );
      lastError = null;
      break;
    } catch (e) {
      lastError = e;
      saveSidecar(destPath, sidecar);
      // 远端大小变了：重试同一份布局没有意义，直接交给外层重新探测。
      if (e instanceof SizeMismatch) throw e;
      if (opts.signal?.aborted) {
        // 暂停/取消：把已就绪的前缀搬进最终文件，重启后接着下。
        flushReadyParts(destPath, sidecar, () => {}, total);
        saveSidecar(destPath, sidecar);
        throw abortError();
      }
      if (e instanceof SizeMismatch) {
        // 远端真的换了大小：这一轮的字节（分片、侧车、以及已经搬进最终文件的
        // 前缀）全都属于旧布局，必须一起清掉 —— 只清分片会把旧前缀当成
        // 「上一版的半成品」重新认领，拼出坏文件。
        removeParts(destPath, sidecar.parts);
        cleanupSidecar(destPath);
        rmSync(destPath, { force: true });
        throw e;
      }
      if (e instanceof RangeMismatch) {
        // 服务器根本不支持 Range（或区间不可满足）→ 清掉分片走单流。
        removeParts(destPath, sidecar.parts);
        cleanupSidecar(destPath);
        rmSync(destPath, { force: true });
        received = 0;
        report(0, totals.total);
        let singleReceived = 0;
        await downloadSingle(url, destPath, opts, totals, (bytes) => {
          singleReceived += bytes;
          report(singleReceived, totals.total);
        });
        const size = sizeOf(destPath);
        report(size, totals.total ?? size, true);
        return { path: destPath, size };
      }
      // 分片级已各自退避重试过，这里整体再等一轮（网络抖动）。
      if (round < rounds) {
        await sleep(backoffMs(round, null, opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS), opts.signal);
      }
    }
  }
  if (lastError) throw lastError;

  // totals.total 可能被 probe 或 Content-Range 校正过（hint 过期的情况）；
  // 只信「已确认」的远端大小，不拿未验证的 hint 当装配目标。
  const finalTotal = totals.total ?? total;
  if (!partsComplete(sidecar)) {
    // 文件长度不是完成判据：它一开始就被预分配成完整大小（还可能带空洞）。
    // 只有所有分片都下满、装配校验通过才算完成。
    saveSidecar(destPath, sidecar);
    throw new SizeMismatch(`分片未下满（${sidecar.parts.map((p) => p.have).join("/")}）`);
  }
  preallocate(destPath, finalTotal);
  flushReadyParts(destPath, sidecar, () => {}, finalTotal);
  const size = sizeOf(destPath);
  if (size !== finalTotal) {
    // 装配结果对不上：丢弃旁路数据后由外层重新探测重下，绝不把坏文件当成品留下。
    removeParts(destPath, sidecar.parts);
    cleanupSidecar(destPath);
    rmSync(destPath, { force: true });
    throw new SizeMismatch(`下载不完整（${size}/${finalTotal} 字节）`);
  }
  removeParts(destPath, sidecar.parts);
  cleanupSidecar(destPath);
  report(finalTotal, finalTotal, true);
  return { path: destPath, size };
}

export { PARALLEL_MIN_TOTAL, DEFAULT_PARTS, DEFAULT_IDLE_TIMEOUT_MS };
