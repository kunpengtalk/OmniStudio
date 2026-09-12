import { existsSync, readdirSync, realpathSync, statSync, type Dirent } from "fs";
import path from "path";

import {
  fileKind,
  isModelWeightExt,
  type ModelFileKind,
  type ModelOrigin,
  type ModelSource,
} from "../shared/modelscope";
import { getModelsBaseDir } from "./modelscope";
import { getSetting, updateSettings } from "./db/settings";
import { isInsideDir } from "./path-safety";

/**
 * 本地模型扫描层。
 *
 * 三类来源都要能被识别、进入同一个"本地模型"列表：
 *   - managed:  应用下载目录（ModelScope / Hugging Face 的市场下载都落在同一个目录里）；
 *   - external: 用户自己指定的本地目录（MODEL_DIRS），目录结构随意；
 *   - hf-cache: Hugging Face 官方缓存（`~/.cache/huggingface/hub`），
 *               mlx-lm / hf_hub_download 拉下来的模型都在这里。
 *
 * 扫描不要求标准目录结构：任意深度的子目录里只要有权重文件就算数。
 * 每条记录额外给出 `runtimeTarget`：推理引擎真正该加载的路径（见下）。
 */

export type { ModelOrigin };

export type ScannedModel = {
  /** 展示用的仓库标识：managed/external 是相对目录，hf-cache 是 `org/repo`。 */
  repo: string;
  fileName: string;
  path: string;
  size: number;
  kind: ModelFileKind;
  origin: ModelOrigin;
  /**
   * 运行时加载目标。vLLM / SGLang / MLX 加载的是**仓库目录**（config.json + 权重分片），
   * 只有 llama.cpp 需要精确的 .gguf 文件，所以按"目录里有 config.json 就是目录"判定。
   */
  runtimeTarget: string;
  /** 整仓库条目（HF 缓存按仓库聚合成一行，path 指向 snapshot 目录）。 */
  isDir: boolean;
  /** 下载来源平台（应用下载的模型由 .vllm-meta.json 提供，HF 缓存固定是 huggingface）。 */
  source?: ModelSource;
};

/** 扫描深度上限：防止用户把模型目录指到 `/` 或主目录导致全盘遍历。 */
const MAX_DEPTH = 8;
/** 单次扫描的文件数上限，超出即停止（同样是为了不把 UI 卡死）。 */
const MAX_MODELS = 20_000;
/** 添加目录前的预览最多返回多少条。 */
const PREVIEW_LIMIT = 50;

/** Hugging Face 缓存根目录（hub 层）。尊重 huggingface_hub 自己的环境变量约定。 */
export function getHfHubCacheDir(): string {
  const explicit = process.env.HUGGINGFACE_HUB_CACHE?.trim();
  if (explicit) return path.resolve(explicit);
  const hfHome = process.env.HF_HOME?.trim();
  if (hfHome) return path.join(path.resolve(hfHome), "hub");
  const home = process.env.HOME ?? "";
  return path.join(home, ".cache", "huggingface", "hub");
}

/** 用户额外添加的模型目录（MODEL_DIRS，逗号分隔）。 */
export function getExtraModelDirs(): string[] {
  return getSetting("MODEL_DIRS")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
}

/** 全部待扫描目录：应用下载目录 + 用户目录 + HF 缓存。 */
export function getScanDirs(): { dir: string; origin: ModelOrigin }[] {
  const dirs: { dir: string; origin: ModelOrigin }[] = [
    { dir: getModelsBaseDir(), origin: "managed" },
  ];
  for (const d of getExtraModelDirs()) dirs.push({ dir: d, origin: "external" });
  dirs.push({ dir: getHfHubCacheDir(), origin: "hf-cache" });
  return dirs;
}

/**
 * 运行时该加载哪个路径：
 * - 目录里有 config.json（HF / vLLM 仓库布局）→ 加载目录（权重分片必须整目录一起加载）；
 * - 其他情况 → 加载文件本身（GGUF 是单文件模型）。
 */
export function resolveRuntimeTarget(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".gguf") || lower.endsWith(".ggml")) return filePath;
  try {
    const st = statSync(filePath);
    if (st.isDirectory()) return filePath;
    const dir = path.dirname(filePath);
    if (existsSync(path.join(dir, "config.json"))) return dir;
  } catch {
    // 文件不可读时按原样返回，交给上层报错
  }
  return filePath;
}

/**
 * 目录条目的权重格式：按目录里的文件判定（顶层 + 一层子目录足够区分
 * safetensors 仓库和 GGUF 仓库），用于选引擎。
 */
export function dirModelKind(dir: string): ModelFileKind {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return "other";
  }
  const kinds = new Set<ModelFileKind>();
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      kinds.add(dirModelKind(full));
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (ext === ".gguf" || ext === ".ggml") kinds.add("gguf");
    else if (ext === ".safetensors") kinds.add("safetensors");
  }
  if (kinds.has("gguf")) return "gguf";
  if (kinds.has("safetensors")) return "safetensors";
  return "other";
}

/** statSync 跟随符号链接：HF 缓存的 snapshot 文件全是指向 blobs 的软链。 */
function statOrNull(p: string): { size: number; isDir: boolean } | null {
  try {
    const st = statSync(p);
    return { size: st.size, isDir: st.isDirectory() };
  } catch {
    return null;
  }
}

/** realpath 作为去重键（HF 缓存里同一个 blob 会被多个 snapshot 引用）。 */
function realKey(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

type WalkHit = { path: string; size: number };

/** 递归收集一个目录下的权重文件；任意深度，符号链接也认，带成环与规模保护。 */
function walkWeights(root: string): { files: WalkHit[]; truncated: boolean } {
  const out: WalkHit[] = [];
  const seenReal = new Set<string>();
  let truncated = false;

  const visit = (dir: string, depth: number) => {
    if (truncated || depth > MAX_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_MODELS) {
        truncated = true;
        return;
      }
      const name = entry.name;
      // 隐藏文件/目录一律跳过（.git / .no_exist / .incomplete / .cache 等）。
      if (name.startsWith(".")) continue;
      const full = path.join(dir, name);
      const st = statOrNull(full);
      if (!st) continue;
      if (st.isDir) {
        const real = realKey(full);
        if (seenReal.has(real)) continue;
        seenReal.add(real);
        visit(full, depth + 1);
      } else if (isModelWeightExt(name)) {
        out.push({ path: full, size: st.size });
      }
    }
  };

  visit(root, 0);
  return { files: out, truncated };
}

/** repo 标签：相对扫描根目录的目录名；根目录下的文件用根目录名。 */
function repoLabel(root: string, filePath: string): string {
  const rel = path.relative(root, path.dirname(filePath));
  if (!rel || rel === ".") return path.basename(root);
  return rel.split(path.sep).join("/");
}

/** 扫描一个普通目录（应用下载目录 / 用户目录），逐文件一行。 */
export function scanPlainDir(root: string, origin: ModelOrigin): ScannedModel[] {
  const { files } = walkWeights(root);
  return files.map((f) => {
    const fileName = path.basename(f.path);
    return {
      repo: repoLabel(root, f.path),
      fileName,
      path: f.path,
      size: f.size,
      kind: fileKind(fileName),
      origin,
      runtimeTarget: resolveRuntimeTarget(f.path),
      isDir: false,
    };
  });
}

/**
 * 扫描 Hugging Face 缓存。
 *
 * 布局：`<hub>/models--<org>--<repo>/{blobs,snapshots/<rev>/...}`，snapshot 里的文件
 * 是指向 `blobs/<sha>` 的软链接（尺寸要 stat 跟随链接后的真实文件）。
 * 一个仓库聚合成一行（path = snapshot 目录）：MLX / vLLM 这类模型本来就是"整目录"，
 * 逐个分片列出来既看不出是什么模型，也没法单独加载。
 */
export function scanHfCache(hubDir: string): ScannedModel[] {
  if (!existsSync(hubDir)) return [];
  const out: ScannedModel[] = [];

  let entries: Dirent[];
  try {
    entries = readdirSync(hubDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (out.length >= MAX_MODELS) break;
    if (!entry.isDirectory() || !entry.name.startsWith("models--")) continue;
    const repo = entry.name.slice("models--".length).replace(/--/g, "/");
    const snapshotsDir = path.join(hubDir, entry.name, "snapshots");
    if (!existsSync(snapshotsDir)) continue;

    // 多个 revision 时取权重最全的一个（按权重总大小、再按 mtime）。
    const revisions: { dir: string; files: WalkHit[]; total: number; mtime: number }[] = [];
    let revs: Dirent[];
    try {
      revs = readdirSync(snapshotsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const rev of revs) {
      if (!rev.isDirectory()) continue;
      const dir = path.join(snapshotsDir, rev.name);
      const { files } = walkWeights(dir);
      if (files.length === 0) continue;
      let mtime = 0;
      try {
        mtime = statSync(dir).mtimeMs;
      } catch {
        // ignore
      }
      revisions.push({ dir, files, total: files.reduce((sum, f) => sum + f.size, 0), mtime });
    }
    if (revisions.length === 0) continue;
    revisions.sort((a, b) => b.total - a.total || b.mtime - a.mtime);
    const best = revisions[0]!;

    const kinds = new Set(best.files.map((f) => fileKind(path.basename(f.path))));
    const kind: ModelFileKind = kinds.has("safetensors")
      ? "safetensors"
      : kinds.has("gguf")
        ? "gguf"
        : "other";

    out.push({
      repo,
      fileName: repo.split("/").pop() || repo,
      path: best.dir,
      size: best.total,
      kind,
      origin: "hf-cache",
      runtimeTarget: best.dir,
      isDir: true,
      source: "huggingface",
    });
  }

  return out;
}

/** 全量扫描：应用下载目录 + 用户目录 + HF 缓存（按真实路径去重）。 */
export function scanModelSources(): ScannedModel[] {
  const out: ScannedModel[] = [];
  const seen = new Set<string>();

  const push = (models: ScannedModel[]) => {
    for (const m of models) {
      const key = realKey(m.path);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(m);
    }
  };

  for (const { dir, origin } of getScanDirs()) {
    if (!existsSync(dir)) continue;
    push(origin === "hf-cache" ? scanHfCache(dir) : scanPlainDir(dir, origin));
  }

  return out;
}

/** 校验一个待添加的目录：存在、是目录、不是应用自己的目录、不是 HF 缓存、未重复。 */
export function validateModelDir(dir: string): { ok: true; dir: string } | { ok: false; error: string } {
  const abs = path.resolve(dir);
  if (!existsSync(abs) || !statOrNull(abs)?.isDir) return { ok: false, error: "目录不存在或不是目录" };
  if (isInsideDir(getModelsBaseDir(), abs)) {
    return { ok: false, error: "该目录在应用下载目录内，已在扫描范围里" };
  }
  const hub = getHfHubCacheDir();
  if (abs === hub || isInsideDir(hub, abs)) {
    return { ok: false, error: "Hugging Face 缓存已默认扫描，无需手动添加" };
  }
  if (getExtraModelDirs().some((d) => path.resolve(d) === abs)) {
    return { ok: false, error: "该目录已在列表中" };
  }
  return { ok: true, dir: abs };
}

/** 预览：添加前先看看这个目录里能认出多少模型。 */
export function previewModelDir(dir: string): {
  ok: boolean;
  error?: string;
  count: number;
  totalSize: number;
  files: { name: string; repo: string; size: number; kind: ModelFileKind }[];
} {
  const valid = validateModelDir(dir);
  if (!valid.ok) return { ok: false, error: valid.error, count: 0, totalSize: 0, files: [] };
  const models = scanPlainDir(valid.dir, "external");
  return {
    ok: true,
    count: models.length,
    totalSize: models.reduce((sum, m) => sum + m.size, 0),
    files: models
      .slice(0, PREVIEW_LIMIT)
      .map((m) => ({ name: m.fileName, repo: m.repo, size: m.size, kind: m.kind })),
  };
}

/** 添加目录：校验 + 至少认出一个模型才写入 MODEL_DIRS。 */
export function addModelDir(dir: string): { ok: boolean; error?: string; count?: number } {
  const preview = previewModelDir(dir);
  if (!preview.ok) return { ok: false, error: preview.error };
  if (preview.count === 0) {
    return {
      ok: false,
      error: "该目录下没有找到模型文件（支持 gguf / safetensors / bin / pt / pth / ckpt / onnx / ggml）",
    };
  }
  const valid = validateModelDir(dir);
  if (!valid.ok) return { ok: false, error: valid.error };
  updateSettings({ MODEL_DIRS: [...getExtraModelDirs(), valid.dir].join(",") });
  return { ok: true, count: preview.count };
}

/** 移除目录：只从列表里摘掉，不动磁盘上的文件。 */
export function removeModelDir(dir: string): { ok: boolean; error?: string } {
  const abs = path.resolve(dir);
  const current = getExtraModelDirs();
  const next = current.filter((d) => path.resolve(d) !== abs);
  if (next.length === current.length) return { ok: false, error: "目录不在列表中" };
  updateSettings({ MODEL_DIRS: next.join(",") });
  return { ok: true };
}

/** HF 缓存的汇总信息（模型数 / 总占用）。 */
export function describeHfCache(): { exists: boolean; count: number; size: number } {
  const dir = getHfHubCacheDir();
  if (!existsSync(dir)) return { exists: false, count: 0, size: 0 };
  const models = scanHfCache(dir);
  return { exists: true, count: models.length, size: models.reduce((sum, m) => sum + m.size, 0) };
}

/** 扫描目录自身的信息（用于"本地模型目录"列表里的模型数与占用）。 */
export function describeModelDir(dir: string): { exists: boolean; count: number; size: number } {
  if (!existsSync(dir)) return { exists: false, count: 0, size: 0 };
  const models = scanPlainDir(dir, "external");
  return {
    exists: true,
    count: models.length,
    size: models.reduce((sum, m) => sum + m.size, 0),
  };
}
