import { existsSync, realpathSync } from "fs";
import path from "path";

/**
 * 路径安全工具：所有"把外部传入的相对路径 / 名称拼到基准目录"的地方都必须走这里，
 * 避免 `..` / 绝对路径 / 软链接逃逸到数据目录之外（删文件、覆盖数据库、读任意文件）。
 */

/** target 是否位于 base 内部（base 自身不算"内部"，避免删掉整个基准目录）。 */
export function isInsideDir(base: string, target: string): boolean {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** target 是否位于 base 内部或就是 base 本身（用于"待创建文件的父目录"判断）。 */
function isInsideOrEqual(base: string, target: string): boolean {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * 判断一个已存在的路径在真实文件系统上是否仍在 base 内（解引用软链接）。
 * base 不存在时无法解引用（也谈不上越界）→ 返回 true，由 resolve 层的包含判断兜底；
 * 其他 realpath 失败场景同样放行，交给调用方按"待创建路径"处理。
 */
function realPathInside(root: string, target: string): boolean {
  try {
    if (!existsSync(root)) return true;
    const realRoot = realpathSync(root);
    if (existsSync(target)) {
      return isInsideOrEqual(realRoot, realpathSync(target));
    }
    // 目标待创建（或不存在）：校验其父目录（含软链接）不越界。
    // 注意这里允许"父目录 == 基准目录"—— 直接位于基目录下的文件是合法的，
    // 用 isInsideDir（把相等视为越界）会把它们误判成 403 而不是 404。
    const parent = path.dirname(target);
    if (!existsSync(parent)) return true;
    return isInsideOrEqual(realRoot, realpathSync(parent));
  } catch {
    return true;
  }
}

/**
 * 安全拼接：把相对路径 rel 拼到 base 下。越界（`..`、绝对路径、NUL、软链接逃逸）
 * 返回 null，调用方必须处理 null（拒绝该输入）。
 */
export function safeJoin(base: string, rel: string): string | null {
  if (typeof rel !== "string" || rel.length === 0 || rel.includes("\0")) return null;
  const root = path.resolve(base);
  const target = path.resolve(root, rel);
  if (!isInsideDir(root, target)) return null;
  if (!realPathInside(root, target)) return null;
  return target;
}

/** 单个文件 / 目录名（不含分隔符）校验；非法返回 null。 */
export function safeName(name: string): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") return null;
  if (/[/\\\0]/.test(trimmed)) return null;
  return trimmed;
}

/** 文件名净化：只取 basename 并去掉路径分隔符，用于"另存为"之类的目标名。 */
export function safeBaseName(name: string): string | null {
  if (typeof name !== "string" || name.includes("\0")) return null;
  const base = path.basename(name.replace(/\\/g, "/")).trim();
  if (!base || base === "." || base === "..") return null;
  return base;
}
