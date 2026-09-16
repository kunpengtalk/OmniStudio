// 体积口径统一到 @lib/format（十进制 1000 进位，模型/下载量通用）。
export { formatBytes } from "@lib/format";

export function formatParams(params: number): string {
  if (!params) return "";
  if (params >= 1e9) return `${(params / 1e9).toFixed(1)}B`;
  if (params >= 1e6) return `${(params / 1e6).toFixed(0)}M`;
  return String(params);
}

/** 加载必需的配套文件（config / tokenizer / chat template 等）。 */
export const SUPPORT_FILE_RE = /\.(json|model|txt|jinja|spm|ya?ml)$/i;

/**
 * 按体积升序：整仓库下载时小文件（config / tokenizer / index）先下完，模型目录
 * 立刻具备可读性，几个 GB 的权重分片排最后。后端队列还会再按体积兜一次底。
 */
export function sortBySizeAsc<T extends { size: number; name: string }>(files: readonly T[]): T[] {
  return [...files].sort((a, b) => a.size - b.size || a.name.localeCompare(b.name));
}