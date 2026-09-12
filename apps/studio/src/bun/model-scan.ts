import { existsSync, readdirSync, realpathSync, statSync, type Dirent } from "fs";
import path from "path";

import {
  fileKind,
  isModelWeightExt,
  modelDisplayName,
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
 * 但**粒度**要对：vLLM / SGLang / MLX 的仓库（config.json + 分片权重）是一个模型，
 * 列表里就必须是一条目录条目，而不是每个 `model-00001-of-00004.safetensors` 一条
 * （见 `isRepoModelDir`）。每条记录额外给出 `runtimeTarget`：推理引擎真正该加载的路径。
 */

export type { ModelOrigin };

export type ScannedModel = {
  /** 展示用的仓库标识：managed/external 是相对目录，hf-cache 是 `org/repo`。 */
  repo: string;
  /** 展示名：目录条目是仓库名（`Qwen__Qwen3.5-4B` → `Qwen3.5-4B`），文件条目是文件名。 */
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
  /** 整仓库条目（仓库目录 / HF 缓存条目聚合成一行，path 指向该目录）。 */
  isDir: boolean;
  /**
   * 条目包含的权重文件名（整仓库条目是仓库里的全部权重，分批 GGUF 是它的各个分片）。
   * 市场页靠它判断"这个文件是不是已经下过了"——目录条目只有一个记录，
   * 只比对 `fileName` 会把仓库里的文件都当成没下载。
   */
  files?: string[];
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
  if (lower.endsWith(".gguf") || lower.endsWith(".ggml")) {
    // 分批 GGUF 交给 llama.cpp 时也要给第一个分片，给中间某片是加载不了的
    return firstSplitShardPath(filePath) ?? filePath;
  }
  try {
    const st = statSync(filePath);
    if (st.isDirectory()) return filePath;
    const dir = path.dirname(filePath);
    if (isRepoModelDir(dir)) return dir;
  } catch {
    // 文件不可读时按原样返回，交给上层报错
  }
  return filePath;
}

/** 分片权重的命名：`model-00001-of-00004.safetensors`（HF 分片仓库的统一命名）。 */
const SHARD_WEIGHT_RE = /-\d{5}-of-\d{5}\.(safetensors|bin|pt)$/i;

/** 分批 GGUF 的分片命名：`GLM-5.2-UD-Q3_K_M-00003-of-00009.gguf`。 */
const SPLIT_GGUF_RE = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;

/**
 * 分批 GGUF 的展示名（`GLM-5.2-UD-Q3_K_M-00003-of-00009.gguf` → `GLM-5.2-UD-Q3_K_M.gguf`）；
 * 不是分片时返回 null。llama.cpp 只认第一个分片，分片名不该出现在模型名里。
 */
export function splitGgufBaseName(fileName: string): string | null {
  const m = SPLIT_GGUF_RE.exec(fileName);
  if (!m) return null;
  return `${m[1]}.gguf`;
}

/**
 * 一个 gguf 分片对应的**第一个分片**路径；只有第一个分片能加载（其余分片由
 * llama.cpp 顺序读入）。不是分片、或第一个分片不在磁盘上（下载不完整）时返回 null。
 */
export function firstSplitShardPath(filePath: string): string | null {
  const m = SPLIT_GGUF_RE.exec(path.basename(filePath));
  if (!m || m[2] === "00001") return null;
  const first = path.join(path.dirname(filePath), `${m[1]}-00001-of-${m[3]}.gguf`);
  return existsSync(first) ? first : null;
}

/**
 * 加载目标路径的展示名（服务名 slug 的来源）：分批 GGUF 指向第一个分片，
 * 名字不该带 `-00001-of-00009`；目录 / 普通文件就是自己的名字。
 */
export function modelNameForPath(target: string): string {
  const base = path.basename(target);
  return splitGgufBaseName(base) ?? base;
}

/**
 * 目录是不是"整仓库"模型目录 —— vLLM / SGLang / MLX 加载的是整个目录，
 * 单独拿一个分片文件是加载不了的，所以列表里必须按目录聚成一条，
 * 而不是把 `model-00001-of-00004.safetensors` 这类分片名当成模型名摆出来。
 *
 * 判定依据是仓库布局本身，不是猜名字：
 *   - 顶层有分片命名权重；
 *   - 顶层有分片索引（`model.safetensors.index.json` / `pytorch_model.bin.index.json`）；
 *   - 顶层有 `config.json`（HF 仓库根的标志）+ 非 GGUF 权重。
 * 纯 GGUF 仓库（`unsloth/xxx-GGUF` 这类 config.json + 多个量化文件）**不算**：
 * 每个量化都是能单独加载的模型，聚成一条用户就没法挑量化了。
 */
export function isRepoModelDir(dir: string): boolean {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  if (names.some((n) => isModelWeightExt(n) && SHARD_WEIGHT_RE.test(n))) return true;
  if (names.some((n) => n.toLowerCase().endsWith(".index.json"))) return true;
  const nonGgufWeight = names.some(
    (n) => fileKind(n) === "safetensors" || /\.(bin|pt|pth|ckpt)$/i.test(n),
  );
  return names.includes("config.json") && nonGgufWeight;
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

/**
 * 扫描一棵目录树，产出两类结果：
 *   - `repos`：整仓库模型目录（vLLM / SGLang / MLX 加载的粒度），一条 = 一个模型；
 *   - `files`：能单独加载的权重文件（GGUF 量化、`.bin` / `.pt` 这类单文件模型）。
 * 命中仓库目录后不再往下走：里面的分片和子目录都属于同一个模型。
 */
function walkModelTree(root: string): {
  repos: { dir: string; files: WalkHit[] }[];
  files: WalkHit[];
  truncated: boolean;
} {
  const repos: { dir: string; files: WalkHit[] }[] = [];
  const files: WalkHit[] = [];
  const seenReal = new Set<string>();
  let truncated = false;

  const visit = (dir: string, depth: number) => {
    if (truncated || depth > MAX_DEPTH) return;
    if (isRepoModelDir(dir)) {
      const found = walkWeights(dir);
      // 有 config.json 但没有权重（只下了 tokenizer 之类）时不聚合，继续往下走
      if (found.files.length > 0) {
        truncated ||= found.truncated;
        repos.push({ dir, files: found.files });
        return;
      }
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length + repos.length >= MAX_MODELS) {
        truncated = true;
        return;
      }
      const name = entry.name;
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
        files.push({ path: full, size: st.size });
      }
    }
  };

  visit(root, 0);
  return { repos, files, truncated };
}

/** repo 标签：相对扫描根目录的路径；根目录下的文件用根目录名。 */
function repoLabel(root: string, target: string): string {
  const rel = path.relative(root, path.dirname(target));
  if (!rel || rel === ".") return path.basename(root);
  return rel.split(path.sep).join("/");
}

/** 仓库目录条目的 repo 标签：相对扫描根的目录本身（不是它的父目录）。 */
function repoDirLabel(root: string, dir: string): string {
  const rel = path.relative(root, dir);
  if (!rel || rel === ".") return path.basename(root);
  return rel.split(path.sep).join("/");
}

/**
 * 扫描一个普通目录（应用下载目录 / 用户目录）。
 *
 * 仓库目录聚成一条（`LiquidAI/LFM2-1.2B-4bit` → 一条，而不是 4 条分片），
 * 其余能单独加载的权重逐文件一条（GGUF 量化、`.bin` / `.pt` 单文件模型）。
 */
export function scanPlainDir(root: string, origin: ModelOrigin): ScannedModel[] {
  const { repos, files } = walkModelTree(root);

  const out: ScannedModel[] = repos.map((r) => ({
    repo: repoDirLabel(root, r.dir),
    // 目录名可能是 safeRepoId 编码过的（`Qwen__Qwen3.5-4B`），展示名取仓库名那一段
    fileName: modelDisplayName(path.basename(r.dir)),
    path: r.dir,
    size: r.files.reduce((sum, f) => sum + f.size, 0),
    // 与 setActiveModel / getLaunchCommand 用同一个判定，保证列表徽标与实际加载的引擎一致
    kind: dirModelKind(r.dir),
    origin,
    runtimeTarget: r.dir,
    isDir: true,
    files: r.files.map((f) => path.basename(f.path)),
  }));

  for (const e of fileEntries(files)) {
    out.push({
      repo: repoLabel(root, e.path),
      fileName: e.fileName,
      path: e.path,
      size: e.size,
      kind: fileKind(e.fileName),
      origin,
      runtimeTarget: resolveRuntimeTarget(e.path),
      isDir: false,
      files: e.members,
    });
  }

  return out;
}

/**
 * 权重文件 → 待展示的条目。
 *
 * 分批 GGUF 的分片合成一条：同一个量化被切成 N 片时只有第一个分片能加载
 * （其余由 llama.cpp 顺序读入），N 个分片各算一个"模型"既没意义、选错了还启动不了。
 * 第一个分片不在磁盘上（下载不完整）时保留逐片展示，免得把残缺的分片当成完整模型。
 */
function fileEntries(files: WalkHit[]): { path: string; fileName: string; size: number; members: string[] }[] {
  const out: { path: string; fileName: string; size: number; members: string[] }[] = [];
  const buckets = new Map<string, WalkHit[]>();
  for (const f of files) {
    const m = SPLIT_GGUF_RE.exec(path.basename(f.path));
    if (!m) {
      out.push({
        path: f.path,
        fileName: path.basename(f.path),
        size: f.size,
        members: [path.basename(f.path)],
      });
      continue;
    }
    const key = `${path.dirname(f.path)}\0${m[1]}\0${m[3]}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(f);
    else buckets.set(key, [f]);
  }
  for (const bucket of buckets.values()) {
    const names = bucket.map((f) => path.basename(f.path));
    const first = bucket.find((f) => SPLIT_GGUF_RE.exec(path.basename(f.path))?.[2] === "00001");
    if (!first) {
      for (const f of bucket) {
        out.push({
          path: f.path,
          fileName: path.basename(f.path),
          size: f.size,
          members: [path.basename(f.path)],
        });
      }
      continue;
    }
    out.push({
      path: first.path,
      fileName: splitGgufBaseName(path.basename(first.path)) ?? path.basename(first.path),
      size: bucket.reduce((sum, f) => sum + f.size, 0),
      // 成员是磁盘上真实的分片名（`X.gguf` 只是展示名，别拿它去比对"下过没有"）
      members: names,
    });
  }
  return out;
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
      files: best.files.map((f) => path.basename(f.path)),
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
