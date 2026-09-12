/**
 * 已安装模型列表的展示层小工具。
 *
 * 列表里既有"一条 = 一个文件"的条目（GGUF 量化），也有"一条 = 一个仓库"的目录条目
 * （vLLM / SGLang / MLX 的 safetensors 仓库、HF 缓存条目、分批 GGUF 的整组）。
 * 市场页的"这个文件下过没有"要按**文件名**判断，所以必须把目录条目里的成员文件摊平。
 */

/** 已安装列表 → 本地已有的权重文件名集合。 */
export function installedFileNames(
  models: readonly { fileName: string; files?: string[] | undefined }[],
): Set<string> {
  const out = new Set<string>();
  for (const m of models) {
    if (m.files && m.files.length > 0) {
      for (const name of m.files) out.add(name);
    } else {
      out.add(m.fileName);
    }
  }
  return out;
}
