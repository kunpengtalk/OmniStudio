/**
 * 备份归档的加密外壳：AES-256-GCM + scrypt，流式（内存占用与文件大小无关）。
 *
 * 容器格式（所有整数字段为 big-endian）：
 *
 * ```
 * 0..7    魔数 "OMNBKP01"
 * 8       容器版本 = 1
 * 9       KDF = 1（scrypt）
 * 10..13  scrypt N     14..17  r      18..21  p
 * 22      压缩标志（0 = 无压缩，1 = gzip）—— 加密后无法嗅探魔数，必须显式记录
 * 23..38  salt(16)
 * 39..50  iv(12)
 * 51..82  keyCheck(32) = HMAC-SHA256(派生密钥, "omnibackup-keycheck-v1")
 * 83..-17 密文
 * 末尾 16  GCM 认证标签
 * ```
 *
 * 为什么要有 keyCheck：预览（`inspect`）只读归档开头的一小段，流没走到结尾就不会
 * 触发 GCM 校验 —— 密码错了只会解析出乱码 JSON。keyCheck 让"密码不对"在打开时
 * 立刻以明确错误返回，而不是让人对着 "Unexpected token" 猜。
 * 它不泄露密钥（HMAC 的前提是要先做完整 scrypt 派生），也不降低暴力破解成本。
 *
 * 头部整体作为 AAD 参与认证：改压缩标志 / KDF 参数会让解密失败，而不是解出错数据。
 */
import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { Transform, type TransformCallback } from "node:stream";

export const ENCRYPTED_MAGIC = "OMNBKP01";
export const CONTAINER_VERSION = 1;
export const KDF_SCRYPT = 1;
/** scrypt 参数：N=2^15、r=8、p=1 ≈ 32 MB 内存、单次派生百毫秒量级。 */
export const SCRYPT_DEFAULTS = { N: 1 << 15, r: 8, p: 1 } as const;
/**
 * 接受 scrypt 参数的边界。
 *
 * 这三个值写在归档头部里，而归档是外部输入：`unlock()` 直接把它们喂给
 * `scryptSync`，而 `maxmem` 又是按 N*r 算出来的，所以内置的护栏永远不会触发 ——
 * 一个 147 字节的文件声明 `N=2^30, r=8` 就能让进程去申请 1 TiB 内存，
 * `N=2^28` 直接把线程挂死。上限按「派生一次 ≤ 256 MB 内存」定，
 * 既堵住 DoS，也给未来调强默认参数留了 8 倍余量。
 */
const MAX_KDF_MEMORY = 256 * 1024 * 1024;
const MAX_KDF_N = 1 << 18;
const MIN_KDF_N = 1 << 10;
const MAX_KDF_R = 32;
const MAX_KDF_P = 16;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const CHECK_BYTES = 32;
const KEY_CHECK_LABEL = "omnibackup-keycheck-v1";
export const HEADER_BYTES = 8 + 1 + 1 + 4 + 4 + 4 + 1 + SALT_BYTES + IV_BYTES + CHECK_BYTES;

export interface EncryptedHeader {
  version: number;
  kdf: number;
  N: number;
  r: number;
  p: number;
  /** true = 明文侧是 gzip（本应用的默认），false = 未压缩 tar。 */
  compressed: boolean;
  salt: Buffer;
  iv: Buffer;
  keyCheck: Buffer;
  /** 头部原始字节，解密时作为 AAD。 */
  raw: Buffer;
}

/** 密码不对 / 文件被改过 / 头部损坏，统一这类错误，便于上层映射成用户可读文案。 */
export class BackupPasswordError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BackupPasswordError";
  }
}

export function isBackupPasswordError(err: unknown): err is BackupPasswordError {
  return err instanceof BackupPasswordError || (err instanceof Error && err.name === "BackupPasswordError");
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return Buffer.from(String(chunk));
}

/**
 * 校验归档头部里的 scrypt 参数，拒绝会让进程吃光内存 / 挂死的取值。
 * 返回值可直接交给 `deriveKey`。
 */
export function checkedScryptParams(header: { N: number; r: number; p: number }): { N: number; r: number; p: number } {
  const { N, r, p } = header;
  const bad = () =>
    new BackupPasswordError("加密备份的密钥派生参数不合法（文件可能已损坏或被伪造）");
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) throw bad();
  // scrypt 要求 N 是大于 1 的 2 的幂。
  if (N < MIN_KDF_N || N > MAX_KDF_N || (N & (N - 1)) !== 0) throw bad();
  if (r < 1 || r > MAX_KDF_R) throw bad();
  if (p < 1 || p > MAX_KDF_P) throw bad();
  if (128 * N * r > MAX_KDF_MEMORY) throw bad();
  return { N, r, p };
}

export function deriveKey(password: string, salt: Buffer, params?: { N?: number; r?: number; p?: number }): Buffer {
  const N = params?.N ?? SCRYPT_DEFAULTS.N;
  const r = params?.r ?? SCRYPT_DEFAULTS.r;
  const p = params?.p ?? SCRYPT_DEFAULTS.p;
  // maxmem 必须大于 128 * N * r，否则 Node 直接拒绝参数。
  const maxmem = Math.max(64 * 1024 * 1024, 256 * N * r);
  return scryptSync(password, salt, KEY_BYTES, { N, r, p, maxmem });
}

function keyCheckOf(key: Buffer): Buffer {
  return createHmac("sha256", key).update(KEY_CHECK_LABEL).digest();
}

function buildHeader(opts: { compressed: boolean; salt: Buffer; iv: Buffer; key: Buffer; N: number; r: number; p: number }): Buffer {
  const head = Buffer.alloc(HEADER_BYTES);
  head.write(ENCRYPTED_MAGIC, 0, 8, "ascii");
  head.writeUInt8(CONTAINER_VERSION, 8);
  head.writeUInt8(KDF_SCRYPT, 9);
  head.writeUInt32BE(opts.N, 10);
  head.writeUInt32BE(opts.r, 14);
  head.writeUInt32BE(opts.p, 18);
  head.writeUInt8(opts.compressed ? 1 : 0, 22);
  opts.salt.copy(head, 23);
  opts.iv.copy(head, 39);
  keyCheckOf(opts.key).copy(head, 51);
  return head;
}

export function parseHeader(raw: Buffer): EncryptedHeader | null {
  if (raw.length < HEADER_BYTES) return null;
  if (raw.subarray(0, 8).toString("ascii") !== ENCRYPTED_MAGIC) return null;
  return {
    version: raw.readUInt8(8),
    kdf: raw.readUInt8(9),
    N: raw.readUInt32BE(10),
    r: raw.readUInt32BE(14),
    p: raw.readUInt32BE(18),
    compressed: raw.readUInt8(22) === 1,
    salt: raw.subarray(23, 39),
    iv: raw.subarray(39, 51),
    keyCheck: raw.subarray(51, 83),
    raw: raw.subarray(0, HEADER_BYTES),
  };
}

/** 文件是否是加密备份（只看魔数，不碰内容）。 */
export async function isEncryptedFile(path: string): Promise<boolean> {
  const head = Buffer.alloc(8);
  const handle = await open(path, "r");
  try {
    const { bytesRead } = await handle.read(head, 0, 8, 0);
    return bytesRead === 8 && head.toString("ascii") === ENCRYPTED_MAGIC;
  } finally {
    await handle.close();
  }
}

/** 读出并校验头部（不校验密码）。 */
export async function readHeader(path: string): Promise<EncryptedHeader> {
  const head = Buffer.alloc(HEADER_BYTES);
  const handle = await open(path, "r");
  try {
    const { bytesRead } = await handle.read(head, 0, HEADER_BYTES, 0);
    if (bytesRead < HEADER_BYTES) throw new BackupPasswordError("加密备份文件不完整（头部被截断）");
  } finally {
    await handle.close();
  }
  const parsed = parseHeader(head);
  if (!parsed) throw new BackupPasswordError("不是本应用的加密备份文件");
  if (parsed.version > CONTAINER_VERSION) {
    throw new BackupPasswordError(`加密备份由更新版本的应用创建（容器 v${parsed.version}），请先升级 OmniStudio`);
  }
  if (parsed.kdf !== KDF_SCRYPT) throw new BackupPasswordError(`不支持的密钥派生算法：${parsed.kdf}`);
  // 打开时就挡住离谱的 KDF 参数：调用方（预览 / 列表）拿到 header 后才会 unlock，
  // 不该让一个 100 多字节的文件把进程拖进几百 MB 的内存分配。
  checkedScryptParams(parsed);
  return parsed;
}

/** 派生密钥并核对 keyCheck；密码不对立刻抛错，不用等到流结尾。 */
export function unlock(path: string, header: EncryptedHeader, password: string): Buffer {
  // 再校验一次：unlock 的 header 可能不是 readHeader 给的，而这里的结果直接进 scryptSync。
  const key = deriveKey(password, header.salt, checkedScryptParams(header));
  const expected = keyCheckOf(key);
  if (expected.length !== header.keyCheck.length || !timingSafeEqual(expected, header.keyCheck)) {
    throw new BackupPasswordError("密码错误（或该文件不是用这个密码加密的）");
  }
  return key;
}

/** 加密变换：密文透传，flush 时补上 GCM 认证标签。 */
export function encryptTransform(key: Buffer, header: EncryptedHeader): Transform {
  const cipher = createCipheriv("aes-256-gcm", key, header.iv);
  cipher.setAAD(header.raw);
  return new Transform({
    transform(chunk: unknown, _enc: BufferEncoding, cb: TransformCallback) {
      try {
        cb(null, cipher.update(toBuffer(chunk)));
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb: TransformCallback) {
      try {
        const tail = cipher.final();
        const tag = cipher.getAuthTag();
        cb(null, Buffer.concat([tail, tag]));
      } catch (err) {
        cb(err as Error);
      }
    },
  });
}

/**
 * 解密变换：扣住最后 16 字节（认证标签）直到流结束。
 * 标签必须等密文全部喂完再 setAuthTag + final()，所以只能流式扣尾。
 */
export function decryptTransform(key: Buffer, header: EncryptedHeader): Transform {
  const decipher = createDecipheriv("aes-256-gcm", key, header.iv);
  decipher.setAAD(header.raw);
  let held: Buffer = Buffer.alloc(0);
  return new Transform({
    transform(chunk: unknown, _enc: BufferEncoding, cb: TransformCallback) {
      try {
        const buf = Buffer.concat([held, toBuffer(chunk)]);
        if (buf.length <= TAG_BYTES) {
          held = buf;
          cb();
          return;
        }
        held = buf.subarray(buf.length - TAG_BYTES);
        cb(null, decipher.update(buf.subarray(0, buf.length - TAG_BYTES)));
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb: TransformCallback) {
      try {
        if (held.length !== TAG_BYTES) {
          cb(new BackupPasswordError("加密备份文件不完整（缺少认证标签）"));
          return;
        }
        decipher.setAuthTag(held);
        const tail = decipher.final();
        cb(null, tail);
      } catch (err) {
        // GCM 校验失败：密码不对，或文件在传输 / 存储中被改动过。
        cb(new BackupPasswordError("解密失败：密码错误或文件已损坏（校验不通过）", { cause: err }));
      }
    },
  });
}

export interface EncryptedWriter {
  header: EncryptedHeader;
  transform: Transform;
}

/** 生成头部 + 加密变换（写侧）。 */
export function createEncryptedWriter(password: string, opts: { compressed: boolean; params?: { N?: number; r?: number; p?: number } }): EncryptedWriter {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const N = opts.params?.N ?? SCRYPT_DEFAULTS.N;
  const r = opts.params?.r ?? SCRYPT_DEFAULTS.r;
  const p = opts.params?.p ?? SCRYPT_DEFAULTS.p;
  const key = deriveKey(password, salt, { N, r, p });
  const header = parseHeader(buildHeader({ compressed: opts.compressed, salt, iv, key, N, r, p }))!;
  return { header, transform: encryptTransform(key, header) };
}

/** 创建需要的"明文侧压缩标志"：加密头里显式记录，读取时不必嗅探。 */
export function compressionFlagOf(gzip: boolean): boolean {
  return gzip;
}

/** 文件 SHA-256（十六进制）——S3 签名用，流式读取。 */
export async function sha256File(path: string): Promise<{ hex: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { hex: hash.digest("hex"), bytes };
}

export const EMPTY_SHA256 = createHash("sha256").digest("hex");
