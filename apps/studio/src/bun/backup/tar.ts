/**
 * 极简 tar（ustar + GNU longname）读写原语 —— 只认字节流，不碰压缩与加密
 * （那是 `archive.ts` 的职责：gzip 与 AES 外壳都在它那里串起来）。
 *
 * 为什么不直接用 `Bun.Archive`：当前 Bun 1.4.2 的实现在这里有三处硬伤 ——
 * `Bun.file()` 作为条目内容会被写成 0 字节、`blob("gzip")` 不做压缩、
 * 从文件句柄读归档直接报 "Unrecognized archive format"。备份是"唯一一份副本"，
 * 不能建立在这种行为上，因此自己写一个只做需要的子集、可流式、可断言的实现。
 *
 * 只做顺序读 / 顺序写，内容全程流式（内存里最多保留一个块），
 * 所以几百 MB 的媒体文件不会把主进程撑爆。
 */
import { mkdir, open, stat } from "node:fs/promises";
import { dirname } from "node:path";

const BLOCK = 512;
const EMPTY = Buffer.alloc(0);
/** 单块读取上限：媒体文件逐块拷贝，避免一次性读进内存。 */
const CHUNK = 1 << 20;
const NUL = "\u0000";

/** 取到第一个 NUL 为止（tar 的字符串字段以 NUL 结尾，后面是填充）。 */
function untilNul(text: string): string {
  const end = text.indexOf(NUL);
  return end === -1 ? text : text.slice(0, end);
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

/** 归档条目：要么给源文件路径（流式），要么给内存数据（清单这类小文件）。 */
export type TarSource =
  | { name: string; source: string; size?: number; mtimeMs?: number; mode?: number }
  | { name: string; data: Uint8Array; mtimeMs?: number; mode?: number };

function octal(value: number, digits: number): string {
  return value.toString(8).padStart(digits, "0");
}

/**
 * 组装 512 字节头。长路径优先用 ustar 的 prefix 字段切分，
 * 切不下再退化成 GNU longname（`././@LongLink`），由本模块的读取侧解析。
 */
function buildHeader(opts: {
  name: string;
  size: number;
  mtimeMs: number;
  mode: number;
  typeflag: "0" | "5" | "L";
  linkName?: string;
}): { header: Buffer | null; longName?: Buffer } {
  const header = Buffer.alloc(BLOCK);
  const nameBuf = Buffer.from(opts.name, "utf8");
  let prefix = "";
  let name = opts.name;
  let longName: Buffer | undefined;

  if (nameBuf.length > 100) {
    const bytes = Buffer.byteLength;
    let split = -1;
    for (let i = opts.name.length - 1; i > 0; i--) {
      if (opts.name[i] !== "/") continue;
      const head = opts.name.slice(0, i);
      const tail = opts.name.slice(i + 1);
      if (bytes(tail) <= 100 && bytes(head) <= 155) {
        split = i;
        break;
      }
    }
    if (split > 0) {
      prefix = opts.name.slice(0, split);
      name = opts.name.slice(split + 1);
    } else {
      // 连 prefix 也放不下：先写一条 GNU longname 条目，再写真实条目
      // （真实条目里的名字只是占位，读取侧会用 longname 覆盖）。
      longName = Buffer.concat([Buffer.from(opts.name, "utf8"), Buffer.alloc(1)]);
      name = opts.name.slice(0, 100);
    }
  }

  header.write(name, 0, 100, "utf8");
  // 100~255 字节的路径靠 ustar 的 prefix 字段承载（否则读回来会只剩文件名那一截）。
  if (prefix) header.write(prefix, 345, 155, "utf8");
  header.write(octal(opts.mode & 0o7777, 7) + "\0", 100, "ascii");
  header.write(octal(0, 7) + "\0", 108, "ascii"); // uid
  header.write(octal(0, 7) + "\0", 116, "ascii"); // gid
  header.write(octal(opts.size, 11) + "\0", 124, "ascii");
  header.write(octal(Math.max(0, Math.floor(opts.mtimeMs / 1000)), 11) + "\0", 136, "ascii");
  header.write("        ", 148, "ascii"); // 校验和字段先填空格
  header.write(opts.typeflag, 156, "ascii");
  if (opts.linkName) header.write(opts.linkName, 157, 100, "ascii");
  if (opts.typeflag !== "L") {
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    header.write("omni", 265, "ascii"); // uname
    header.write("omni", 297, "ascii"); // gname
  }

  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(octal(sum, 6) + "\0 ", 148, "ascii");
  return { header, longName };
}

function padToBlock(size: number): number {
  return (BLOCK - (size % BLOCK)) % BLOCK;
}

/** 把条目序列写成 tar 字节流（不压缩、不加密）。 */
export async function* tarChunks(
  entries: AsyncIterable<TarSource>,
  onBytes?: (n: number) => void,
): AsyncGenerator<Buffer> {
  for await (const entry of entries) {
    const data = "data" in entry ? entry.data : undefined;
    const srcPath = "source" in entry ? entry.source : undefined;
    // 头里的 size 必须与后续写入的字节数完全一致，否则后面的条目会全部错位：
    // 内存条目按实际长度，路径条目优先用调用方给的值，否则现场 stat。
    const size = data ? data.byteLength : ((entry as { size?: number }).size ?? (await stat(srcPath!)).size);
    const mtimeMs = entry.mtimeMs ?? Date.now();
    const mode = entry.mode ?? (entry.name.endsWith("/") ? 0o755 : 0o644);

    const { header, longName } = buildHeader({
      name: entry.name,
      size,
      mtimeMs,
      mode,
      typeflag: entry.name.endsWith("/") ? "5" : "0",
    });
    if (longName) {
      const long = buildHeader({
        name: "././@LongLink",
        size: longName.length,
        mtimeMs,
        mode: 0o644,
        typeflag: "L",
      });
      yield long.header!;
      yield longName;
      const pad = padToBlock(longName.length);
      if (pad) yield Buffer.alloc(pad);
    }
    yield header!;
    onBytes?.(BLOCK);

    if (!data && size > 0) {
      // 流式拷贝：从源文件读一块、写一块，内存占用与文件大小无关。
      const handle = await open(srcPath!, "r");
      try {
        const buf = Buffer.alloc(Math.min(CHUNK, Math.max(size, 1)));
        let remaining = size;
        while (remaining > 0) {
          const want = Math.min(buf.length, remaining);
          const { bytesRead } = await handle.read(buf, 0, want, null);
          if (bytesRead <= 0) break;
          const chunk = buf.subarray(0, bytesRead);
          yield chunk;
          onBytes?.(bytesRead);
          remaining -= bytesRead;
        }
      } finally {
        await handle.close();
      }
    } else if (data) {
      yield Buffer.from(data);
      onBytes?.(data.byteLength);
    }

    const pad = padToBlock(size);
    if (pad) yield Buffer.alloc(pad);
  }
  // 结束标记：两个全零块
  yield Buffer.alloc(BLOCK * 2);
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

/** 顺序字节读取器：在异步迭代器之上提供"精确取 N 字节 / 跳过 N 字节"。 */
class ByteReader {
  private buf: Buffer = EMPTY;
  private ended = false;

  constructor(private readonly src: AsyncIterator<Uint8Array>) {}

  private async fill(min: number): Promise<boolean> {
    while (this.buf.length < min && !this.ended) {
      const next = await this.src.next();
      if (next.done) {
        this.ended = true;
        break;
      }
      const chunk = Buffer.from(next.value);
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    }
    return this.buf.length >= min;
  }

  /** 读取最多 n 字节（流末尾可能更少）。 */
  async read(n: number): Promise<Buffer> {
    if (n <= 0) return EMPTY;
    await this.fill(Math.min(n, 1));
    if (this.buf.length <= n) {
      const out = this.buf;
      this.buf = EMPTY;
      return out;
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** 精确读取 n 字节；流提前结束返回 null。 */
  async readExact(n: number): Promise<Buffer | null> {
    if (n === 0) return EMPTY;
    const ok = await this.fill(n);
    if (!ok) return null;
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  async skip(n: number): Promise<void> {
    let remaining = n;
    while (remaining > 0) {
      const chunk = await this.read(Math.min(remaining, CHUNK));
      if (chunk.length === 0) return;
      remaining -= chunk.length;
    }
  }

  /**
   * 把剩余字节读完（丢弃内容）。
   *
   * tar 的结束标记在文件末尾，读到它之后流里通常还剩 gzip 的尾部校验与
   * 加密的认证标签 —— 不读到底，这些校验就不会执行，被截断的归档会被
   * 当成读取成功。只能通过迭代器本身推进：流被迭代器占用时 resume() 无效。
   */
  async drain(): Promise<void> {
    while (!this.ended) {
      const next = await this.src.next();
      if (next.done) {
        this.ended = true;
        break;
      }
    }
    this.buf = EMPTY;
  }

  /**
   * 释放底层流的异步迭代器锁（会销毁流）。
   * 用于消费方提前收手的场景：不需要尾部校验，只求立刻还回资源。
   */
  async close(): Promise<void> {
    try {
      await this.src.return?.();
    } catch {
      // 关闭时的错误无关紧要：真正的读取错误已经在读取路径上抛过了
    }
  }
}

export interface ArchiveEntry {
  name: string;
  size: number;
  mtimeMs: number;
  /** 落盘（自动建父目录）。 */
  saveTo(destPath: string): Promise<void>;
  /** 读进内存 —— 只给清单 / 小文件用。 */
  read(): Promise<Buffer>;
  /** 丢弃本条内容（跳过不需要的条目）。 */
  discard(): Promise<void>;
}

function parseNumeric(field: Buffer): number {
  const text = untilNul(field.toString("ascii")).trim();
  if (!text) return 0;
  // GNU 的 base-256 编码（超大文件 / 超范围时间戳）
  if (field[0]! & 0x80) {
    let value = 0;
    for (const byte of field) value = value * 256 + byte;
    return value;
  }
  const parsed = parseInt(text, 8);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

export interface ReadOptions {
  signal?: AbortSignal;
  /**
   * tar 正常收尾后是否把剩余字节读完（触发 gzip CRC / 解密认证校验），默认 true。
   * 消费方主动提前中断时不会 drain —— 只取开头清单的预览不该为了校验把整个归档解一遍。
   */
  drainTail?: boolean;
}

/**
 * 从字节流里顺序读出 tar 条目。未消费完的条目内容会被自动跳过，
 * 因此调用方可以只取需要的条目（恢复时按作用域过滤就靠这个）。
 */
export async function* readTarEntries(
  source: AsyncIterable<Uint8Array>,
  opts?: ReadOptions,
): AsyncGenerator<ArchiveEntry> {
  const reader = new ByteReader(source[Symbol.asyncIterator]());
  let pendingLongName: string | null = null;
  let reachedEnd = false;

  try {
    for (;;) {
      if (opts?.signal?.aborted) throw new Error("已取消");
      const block = await reader.readExact(BLOCK);
      if (!block) break;
      // 结束标记：两个全零块，后面只有记录边界的补零，直接收尾。
      if (isZeroBlock(block)) break;

      const typeflag = String.fromCharCode(block[156]!);
      const size = parseNumeric(block.subarray(124, 136));
      const rawName = untilNul(block.subarray(0, 100).toString("utf8"));
      const prefix = untilNul(block.subarray(345, 500).toString("utf8"));
      const name = pendingLongName ?? (prefix ? `${prefix}/${rawName}` : rawName);
      const mtimeMs = parseNumeric(block.subarray(136, 148)) * 1000;

      if (typeflag === "L") {
        const data = await reader.readExact(size);
        if (!data) break;
        pendingLongName = untilNul(data.toString("utf8"));
        await reader.skip(padToBlock(size));
        continue;
      }

      const consumed = { done: false };
      const skipRest = async () => {
        if (consumed.done) return;
        consumed.done = true;
        await reader.skip(size + padToBlock(size));
      };

      if (typeflag !== "0" && typeflag !== "") {
        // 目录 / 软链 / pax 头等：本模块只写普通文件，其余一律跳过。
        await skipRest();
        pendingLongName = null;
        continue;
      }

      const entry: ArchiveEntry = {
        name,
        size,
        mtimeMs,
        async saveTo(destPath: string) {
          if (consumed.done) throw new Error(`归档条目已跳过：${name}`);
          consumed.done = true;
          await mkdir(dirname(destPath), { recursive: true });
          const handle = await open(destPath, "w");
          try {
            let remaining = size;
            while (remaining > 0) {
              const chunk = await reader.read(Math.min(remaining, CHUNK));
              if (chunk.length === 0) throw new Error(`归档数据不完整：${name}`);
              await handle.write(chunk);
              remaining -= chunk.length;
            }
          } finally {
            await handle.close();
          }
          await reader.skip(padToBlock(size));
        },
        async read() {
          if (consumed.done) throw new Error(`归档条目已跳过：${name}`);
          consumed.done = true;
          const data = await reader.readExact(size);
          // 截断 / 损坏必须报错：备份是唯一一份副本，静默返回半截数据比失败更糟。
          if (data === null) throw new Error(`归档数据不完整：${name}（期望 ${size} 字节）`);
          await reader.skip(padToBlock(size));
          return data;
        },
        async discard() {
          await skipRest();
        },
      };

      pendingLongName = null;
      yield entry;
      // 消费方没有取走内容时，这里兜底跳过，保证下一条目从正确位置继续。
      await skipRest();
  }
    reachedEnd = true;
  } finally {
    // 正常读到结束标记：把尾巴读完，让 gzip / GCM 的校验真正执行（截断的归档必须暴露）。
    // 抛错或消费方提前 break：不值得为校验把剩下的解一遍，直接还回资源。
    if (reachedEnd && opts?.drainTail !== false) await reader.drain();
    else await reader.close();
  }
}
