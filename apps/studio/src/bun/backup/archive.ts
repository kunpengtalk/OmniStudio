/**
 * 归档的读写组合层：tar（`tar.ts`）→ [gzip] → [AES 外壳（`crypto.ts`）]。
 *
 * 三层顺序固定，读取时按魔数判断实际形态：
 *
 * | 形态 | 头部 | 说明 |
 * | --- | --- | --- |
 * | 明文 + gzip（默认） | `1f 8b` | 最早的形式，系统 tar 可直接解开 |
 * | 明文未压缩 | `ustar` / 文件名 | `--no-compress`，系统 tar 也能解 |
 * | 加密 | `OMNBKP01` | 密文内部是上面两者之一，压缩标志写在加密头里 |
 *
 * 加密文件的外部特征刻意保持"什么都没有"：文件名、体积、内部作用域都不可见，
 * 只有提供密码才能读出清单。
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline as pipelineCb, Readable } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

import {
  BackupPasswordError,
  HEADER_BYTES,
  createEncryptedWriter,
  decryptTransform,
  isBackupPasswordError,
  isEncryptedFile,
  parseHeader,
  readHeader,
  unlock,
} from "./crypto";
import { BACKUP_PASSWORD_REQUIRED_HINT } from "../../shared/backup";
import { readTarEntries, tarChunks, type ArchiveEntry, type ReadOptions, type TarSource } from "./tar";

export type { ArchiveEntry, TarSource } from "./tar";
export { isBackupPasswordError, BackupPasswordError } from "./crypto";

/** 归档外部形态（只看开头几个字节）。 */
export interface ArchiveFormat {
  encrypted: boolean;
  /** 明文侧是否 gzip（加密文件从加密头里读，未加密文件按魔数嗅探）。 */
  compressed: boolean;
}

const GZIP_MAGIC = [0x1f, 0x8b] as const;
const PEEK_BYTES = Math.max(2, HEADER_BYTES);

export async function detectArchiveFormat(path: string): Promise<ArchiveFormat> {
  const head = Buffer.alloc(PEEK_BYTES);
  const handle = await open(path, "r");
  let read = 0;
  try {
    read = (await handle.read(head, 0, PEEK_BYTES, 0)).bytesRead;
  } finally {
    await handle.close();
  }
  const encrypted = parseHeader(read >= HEADER_BYTES ? head : Buffer.alloc(0));
  if (encrypted) return { encrypted: true, compressed: encrypted.compressed };
  return {
    encrypted: false,
    compressed: read >= 2 && head[0] === GZIP_MAGIC[0] && head[1] === GZIP_MAGIC[1],
  };
}

export interface WriteArchiveOptions {
  /** gzip 压缩，默认 true。 */
  gzip?: boolean;
  /** 设置后写出加密归档（AES-256-GCM）。 */
  password?: string;
  onBytes?: (n: number) => void;
  signal?: AbortSignal;
  /** scrypt 参数覆盖（测试用；生产走默认值）。 */
  kdfParams?: { N?: number; r?: number; p?: number };
}

/**
 * 写归档。先写 `<outPath>.part`，成功后再改名 —— 中断 / 失败不会留下
 * 一个"看起来像备份、其实是半截"的文件。
 */
export async function writeArchive(
  outPath: string,
  entries: AsyncIterable<TarSource>,
  opts?: WriteArchiveOptions,
): Promise<{ bytes: number; encrypted: boolean; compressed: boolean }> {
  const gzip = opts?.gzip !== false;
  const signal = opts?.signal;
  const partPath = `${outPath}.part`;
  await mkdir(dirname(outPath), { recursive: true });
  const source = Readable.from(tarChunks(entries, opts?.onBytes));
  const out = createWriteStream(partPath);
  try {
    if (opts?.password) {
      const writer = createEncryptedWriter(opts.password, { compressed: gzip, params: opts.kdfParams });
      // 加密头必须明文写在最前面（salt / iv / 压缩标志给解密方用），
      // 因此它不能进 gzip 与加密变换 —— 那两段只作用于 tar 正文。
      await new Promise<void>((resolve, reject) => {
        out.write(writer.header.raw, (err) => (err ? reject(err) : resolve()));
      });
      if (gzip) await pipeline(source, createGzip({ level: 6 }), writer.transform, out, { signal });
      else await pipeline(source, writer.transform, out, { signal });
    } else if (gzip) {
      await pipeline(source, createGzip({ level: 6 }), out, { signal });
    } else {
      await pipeline(source, out, { signal });
    }
  } catch (err) {
    await unlink(partPath).catch(() => {});
    throw err;
  }
  await rename(partPath, outPath);
  return { bytes: (await stat(outPath)).size, encrypted: !!opts?.password, compressed: gzip };
}

export interface ReadArchiveOptions extends ReadOptions {
  /** 加密归档必须提供。 */
  password?: string;
}

/**
 * 打开归档并按条目顺序迭代。
 *
 * 加密归档在打开时就用 keyCheck 校验密码：预览只读开头一小段、流不会走到
 * 结尾触发 GCM 校验，所以"密码错了"必须在这里就报出来。
 *
 * **尾部校验**：tar 的结束标记在文件末尾，如果消费方读到结束标记就停手，
 * gzip 的 CRC 与 GCM 的认证标签都不会被执行 —— 被截断 / 篡改的归档会"读成功"。
 * 所以正常读完后会显式把流推到底触发校验；而消费方主动 break（如 `inspect`
 * 只取开头清单）时不会 drain，避免为了校验把几个 GB 全部解一遍。
 */
export async function* openArchive(path: string, opts?: ReadArchiveOptions): AsyncGenerator<ArchiveEntry> {
  const file = createReadStream(path, { highWaterMark: 1 << 20 });
  let body: ReturnType<typeof createReadStream> | null = null;
  let terminalError: Error | null = null;
  const noteError = (err: unknown) => {
    if (!terminalError) terminalError = err instanceof Error ? err : new Error(String(err));
  };
  try {
    let encrypted = false;
    let compressed: boolean;
    /** 读侧第一段：明文（或解密后的）字节流。每一段都挂 error 监听，避免"无人接管的 error 事件"直接崩进程。 */
    let input: Readable = file;
    file.on("error", noteError);
    if (await isEncryptedFile(path)) {
      encrypted = true;
      const header = await readHeader(path);
      if (!opts?.password) {
        throw new BackupPasswordError(`该备份已加密，${BACKUP_PASSWORD_REQUIRED_HINT}`);
      }
      // 密文从头部之后开始，末尾 16 字节是 GCM 标签（由解密流扣住校验）。
      body = createReadStream(path, { start: header.raw.length, highWaterMark: 1 << 20 });
      body.on("error", noteError);
      const key = unlock(path, header, opts.password);
      const decryptStream = decryptTransform(key, header);
      decryptStream.on("error", noteError);
      input = linkStages([body, decryptStream], noteError);
      compressed = header.compressed;
    } else {
      compressed = (await detectArchiveFormat(path)).compressed;
    }
    const plain: Readable = compressed ? linkStages([input, createGunzip()], noteError) : input;

    try {
      yield* readTarEntries(plain, opts);
    } catch (err) {
      const readFailed = !!terminalError || (err instanceof Error && err.message.startsWith("归档数据不完整"));
      throw mapReadError(err, { encrypted, readFailed, signal: opts?.signal });
    }

    // 走到这里说明 tar 正常收尾，尾部校验已在读取侧执行完（见 tar.ts 的 drainTail）。
    if (terminalError) {
      throw mapReadError(terminalError, { encrypted, readFailed: true, signal: opts?.signal });
    }
  } finally {
    // 提前退出（消费方 break / 抛错）时立刻释放文件句柄。
    file.destroy();
    body?.destroy();
  }
}

/**
 * 读取侧错误的统一口径：加密归档在流走完前无法做 GCM 校验，中间被改动时
 * 先炸的往往是解压或 tar 解析 —— 这些错误对用户是同一件事（密码不对或文件坏了）。
 * 消费方的错误（磁盘写满、用户取消）必须原样抛出，不能伪装成密码问题。
 */
function mapReadError(
  err: unknown,
  ctx: { encrypted: boolean; readFailed: boolean; signal?: AbortSignal },
): unknown {
  if (!ctx.encrypted || !ctx.readFailed || ctx.signal?.aborted || isBackupPasswordError(err)) return err;
  return new BackupPasswordError("解密失败：密码错误或文件已损坏（校验不通过）", { cause: err });
}

/**
 * 串起读取链的若干段，并让任一阶段的错误传播到整条链。
 *
 * 不能用 `pipe()`：上游出错时它只是解除管道，下游永远等不到结束 —— 消费方会挂死。
 * `pipeline` 会在任一阶段出错时销毁全部阶段，错误从末尾那段的迭代器抛给消费方。
 */
function linkStages(stages: Readable[], onError: (err: unknown) => void): Readable {
  const last = stages[stages.length - 1]!;
  for (const stage of stages) stage.on("error", onError);
  const run = pipelineCb as unknown as (
    ...args: [...Readable[], (err: NodeJS.ErrnoException | null) => void]
  ) => void;
  run(...stages, (err) => {
    if (err) onError(err);
  });
  return last;
}

/** 只扫一遍归档头，收集条目名与体积（用于预览 / 测试）。 */
export async function listArchive(
  path: string,
  opts?: ReadArchiveOptions,
): Promise<{ name: string; size: number }[]> {
  const out: { name: string; size: number }[] = [];
  for await (const entry of openArchive(path, opts)) {
    out.push({ name: entry.name, size: entry.size });
  }
  return out;
}
