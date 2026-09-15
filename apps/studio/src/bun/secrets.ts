import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "fs";
import { join } from "path";
import { getDataDir } from "./paths";

/**
 * 本地密钥加密（AES-256-GCM）。
 *
 * 用途：把落盘的敏感值（模型云服务商 API Key 等）从明文改成密文，避免
 * 「拷走 SQLite 直接读明文」和日志 / 备份泄露密钥。
 *
 * 密钥存 `<dataDir>/secrets.key`（仅当前用户可读，0600）。这是"钥匙和锁同屋"
 * 的折衷：值不能被廉价翻读，但拿到那台机器 + 用户权限的人仍能解。真正的
 * 系统级隔离（Keychain / DPAPI / libsecret）留给以后按需补。
 *
 * 密文格式：`v1:` + base64(iv · authTag · ciphertext)。版本前缀便于以后换算法
 * 做渐进迁移。解密时若值不带 `v1:` 前缀，按旧明文透传 —— 所以老数据天然兼容，
 * 无需一次性迁移，下次写入自动加密。
 *
 * 注意：本模块只依赖 paths + node:crypto，不 import electrobun，供主进程与
 * 独立进程（omi CLI / backup）复用。
 */

const PREFIX = "v1:";
const KEY_FILE = "secrets.key";
/** 密文里需要暴露给调用方判断"这是否已加密"的标记。 */
export const SECRET_ENCRYPTED_PREFIX = PREFIX;

/** 幂等获取（必要时生成）主密钥。失败时返回 null 并退出（不进 catch 外的流程）。 */
function getMasterKey(): Buffer {
  const dir = getDataDir();
  const file = join(dir, KEY_FILE);
  if (existsSync(file)) {
    const raw = readFileSync(file);
    if (raw.length === 32) return raw;
    // 密钥文件损坏：直接抛错，不自动重建（重建会让旧密文全部不可解）。
    throw new Error(`secrets.key 长度异常（${raw.length}），拒绝重建；请检查数据目录。`);
  }
  mkdirSync(dir, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(file, key, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows 下 chmod 意义不大，忽略
  }
  return key;
}

/** 加密：返回 `v1:` 前缀的密文。空串 / 纯空白原样返回空串（不制造密文）。 */
export function encryptSecret(plain: string): string {
  const value = plain ?? "";
  if (!value) return "";
  const key = getMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString("base64");
}

/**
 * 解密 `encryptSecret` 产生的密文。非 `v1:` 前缀（旧明文）原样透传，保证兼容。
 * 密文损坏 / 密钥不匹配时抛错（不静默吞掉：否则会把坏值当明文用出去）。
 */
export function decryptSecret(cipherText: string): string {
  const value = cipherText ?? "";
  if (!value || !value.startsWith(PREFIX)) return value;
  try {
    const buf = Buffer.from(value.slice(PREFIX.length), "base64");
    // 布局：iv(12) · tag(16) · ciphertext(rest)
    if (buf.length < 28) return value; // 过短，非合法密文，按明文透传保守处理
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const key = getMasterKey();
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch (e) {
    throw new Error(`密钥解密失败: ${String(e)}`);
  }
}

/** 判断一个值是否已是加密形式（用于启用时统一迁移 / 幂等加密）。 */
export function isEncryptedSecret(value: string): boolean {
  return !!value && value.startsWith(PREFIX);
}
