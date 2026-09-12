import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import path from "path";
import { getModelsBaseDir, safeRepoId, isModelWeightExt, modelDisplayName } from "./modelscope";
import {
  dirModelKind,
  getExtraModelDirs,
  getHfHubCacheDir,
  getScanDirs,
  modelNameForPath,
  resolveRuntimeTarget,
  scanModelSources,
} from "./model-scan";
import type { InstalledModel, ModelOrigin } from "../shared/modelscope";
import { getSetting, updateSettings } from "./db/settings";
import { isInsideDir } from "./path-safety";
import {
  engineForModelKind,
  engineSupports,
  fileKind,
  type InferenceEngine,
  type ModelCategory,
  type ModelFileKind,
  type ModelSource,
} from "../shared/modelscope";

// 类型真源在 shared（前端也用同一份），这里只做转出。
export type { InstalledModel };

const META_FILE = ".vllm-meta.json";

/** 每个仓库目录下的 `.vllm-meta.json`：记录分类与下载来源。 */
type RepoMeta = {
  category?: ModelCategory;
  source?: ModelSource;
};

export function getModelsBaseDirForRuntime(): string {
  return getModelsBaseDir();
}

/**
 * All model directories: the primary one first (download target), then any
 * extra directories from the MODEL_DIRS setting (comma-separated).
 */
export function getModelsDirs(): string[] {
  const primary = getModelsBaseDirForRuntime();
  const extra = getSetting("MODEL_DIRS")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  return [primary, ...extra];
}

/** Fallback classification from the file name when no persisted category exists. */
export function classifyInstalledFilename(fileName: string): ModelCategory {
  const name = fileName.toLowerCase();
  if (["cosyvoice", "sovits", "tts", "gpt-sovits"].some((k) => name.includes(k))) return "tts";
  if (["whisper", "sensevoice", "paraformer", "funasr"].some((k) => name.includes(k))) return "asr";
  if (["stable-diffusion", "sdxl", "kolors", "flux", "sd3", "schnell"].some((k) => name.includes(k))) return "image";
  if (["qwen", "llama", "chat", "instruct", "cogvlm", "glm", "deepseek", "mistral"].some((k) => name.includes(k))) return "chat";
  return "other";
}

const VALID_CATEGORIES: ModelCategory[] = ["chat", "tts", "asr", "image", "other"];
const VALID_SOURCES: ModelSource[] = ["modelscope", "huggingface"];

/**
 * 从权重文件 / 仓库目录往上找到最近的 `.vllm-meta.json`（分类 / 下载来源）。
 * 下载落盘时写在仓库顶层目录，嵌套子目录里的文件要靠向上查找才能命中；
 * 目录条目（整个仓库一行）直接从目录本身开始找。
 */
function readRepoMetaFor(target: string, root: string, isDir: boolean): RepoMeta {
  let dir = isDir ? target : path.dirname(target);
  const stop = path.resolve(root);
  // 最多向上 8 层，且不越过扫描根目录
  for (let i = 0; i < 8; i += 1) {
    const meta = readRepoMeta(dir);
    if (meta.category || meta.source) return meta;
    const parent = path.dirname(dir);
    if (parent === dir || !isInsideDir(stop, dir)) break;
    dir = parent;
  }
  return {};
}

function readRepoMeta(repoDir: string): RepoMeta {
  try {
    const metaPath = path.join(repoDir, META_FILE);
    if (existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as RepoMeta;
      return meta && typeof meta === "object" ? meta : {};
    }
  } catch {
    // fall through — 元数据损坏时退回按文件名分类
  }
  return {};
}

/**
 * 持久化下载出来的模型的分类与来源平台。
 * `.vllm-meta.json` 按仓库目录存一份：同一仓库的文件来自同一平台，写一次即可。
 * 老文件只有 `category` 字段，读到 source 为 undefined 时不显示来源标签。
 */
export function setModelMeta(repo: string, patch: RepoMeta) {
  const repoDir = path.join(getModelsBaseDir(), safeRepoId(repo));
  try {
    const meta = readRepoMeta(repoDir);
    if (patch.category && VALID_CATEGORIES.includes(patch.category)) meta.category = patch.category;
    if (patch.source && VALID_SOURCES.includes(patch.source)) meta.source = patch.source;
    writeFileSync(path.join(repoDir, META_FILE), JSON.stringify(meta, null, 2));
  } catch {
    // ignore
  }
}

function getFavorites(): Set<string> {
  try {
    const raw = getSetting("FAVORITE_MODELS") || "[]";
    const list = JSON.parse(raw) as string[];
    return new Set(Array.isArray(list) ? list : []);
  } catch {
    return new Set();
  }
}

function persistFavorites(favs: Set<string>) {
  updateSettings({ FAVORITE_MODELS: JSON.stringify([...favs]) });
}

export function isFavorite(pathToModel: string): boolean {
  return getFavorites().has(pathToModel);
}

export function toggleFavorite(pathToModel: string): void {
  const favs = getFavorites();
  if (favs.has(pathToModel)) {
    favs.delete(pathToModel);
  } else {
    favs.add(pathToModel);
  }
  persistFavorites(favs);
}

/**
 * 本地模型列表：应用下载目录 + 用户添加的目录 + Hugging Face 缓存。
 * 目录结构任意深度都能识别（见 model-scan.ts），不再要求 `<dir>/<repo>/<file>` 布局。
 */
export function listInstalledModels(): InstalledModel[] {
  const activePath = getSetting("LOCAL_MODEL_PATH");
  const chatModel = getSetting("CHAT_MODEL");
  const favorites = getFavorites();
  const roots = new Map(getScanDirs().map((d) => [d.origin, d.dir]));

  return scanModelSources().map((m) => {
    // 激活目标既可能是文件，也可能是目录（vLLM/SGLang/MLX 加载整个仓库目录）。
    const isActive = m.path === activePath || m.runtimeTarget === activePath;
    const meta =
      m.origin === "hf-cache"
        ? {}
        : readRepoMetaFor(m.path, roots.get(m.origin) ?? getModelsBaseDir(), m.isDir);
    return {
      repo: m.repo,
      fileName: m.fileName,
      path: m.path,
      size: m.size,
      isActive,
      isChatModel: isActive && chatModel === slugModelFileName(m.fileName),
      category:
        meta.category && VALID_CATEGORIES.includes(meta.category)
          ? meta.category
          : classifyInstalledFilename(m.fileName),
      favorite: favorites.has(m.path),
      source: meta.source && VALID_SOURCES.includes(meta.source) ? meta.source : m.source,
      origin: m.origin,
      isDir: m.isDir,
      kind: m.kind,
      runtimeTarget: m.runtimeTarget,
      files: m.files,
    };
  });
}

/**
 * Canonical served model name for a model file: a lowercase slug that is used
 * both as the server-side model id (--alias / --served-model-name) and what
 * the UI shows in the model picker.
 */
export function slugModelFileName(fileName: string): string {
  return fileName
    .replace(/\.(gguf|safetensors|bin|pt|pth|ckpt|onnx|ggml)$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "-");
}

/** Switch the inference engine when the current one cannot load this format. */
function ensureEngineForKind(kind: ModelFileKind): void {
  const current = (getSetting("INFERENCE_ENGINE") as InferenceEngine) || "llama.cpp";
  if (engineSupports(current, kind)) return;
  const suggested = engineForModelKind(kind);
  if (suggested) updateSettings({ INFERENCE_ENGINE: suggested });
}

/** 服务端模型名：目录条目取仓库名（HF 缓存路径的 sha 目录不能当名字用）。 */
function servedNameForTarget(target: string, isDir: boolean): string {
  // 分批 GGUF 指向第一个分片，服务名不带 `-00001-of-00009`（见 modelNameForPath）
  if (!isDir) return slugModelFileName(modelNameForPath(target));
  let name = path.basename(target);
  if (/^[0-9a-f]{7,64}$/i.test(name)) {
    const snapshots = path.dirname(target);
    if (path.basename(snapshots) === "snapshots") {
      const entry = path.basename(path.dirname(snapshots));
      name = entry.replace(/^models--/, "").split("--").pop() || entry;
    }
  } else {
    // 应用下载目录的目录名是 safeRepoId 编码过的（`Qwen__Qwen3.5-4B`），
    // 服务名取仓库名那一段，别把编码后的 `__` 带进模型 ID。
    name = modelDisplayName(name);
  }
  return slugModelFileName(name);
}

/**
 * 本地模型路径 → 服务名（slug）。
 *
 * 与 `setActiveModel` 写入 `LOCAL_MODEL_NAME` 用的是同一套解析：分批 GGUF 落到第一个
 * 分片、仓库目录落到目录，所以 CLI / 预览命令算出来的名字和服务器实际提供的一致。
 */
export function servedNameForModelPath(modelPath: string): string {
  const target = resolveRuntimeTarget(modelPath);
  let isDir = false;
  try {
    isDir = statSync(target).isDirectory();
  } catch {
    // 不可读时按文件处理，交给调用方报错
  }
  return servedNameForTarget(target, isDir);
}

/**
 * 设为当前模型。
 *
 * 存放的是**运行时加载目标**而不是列表里那个文件：仓库目录（含 config.json）交给
 * vLLM / SGLang / MLX 整目录加载，GGUF 这类单文件模型仍然指向文件本身。
 * 这也是"非标准目录结构也能启动"的关键 —— 分片 safetensors 单拿一个文件是加载不了的。
 */
export function setActiveModel(pathToModel: string): { ok: boolean; error?: string } {
  if (!existsSync(pathToModel)) return { ok: false, error: "模型路径不存在" };
  const target = resolveRuntimeTarget(pathToModel);
  let isDir = false;
  try {
    isDir = statSync(target).isDirectory();
  } catch {
    return { ok: false, error: "模型路径不可读" };
  }
  // 目录条目按目录内容判定格式（HF 缓存里的模型目录），单文件按扩展名。
  const kind: ModelFileKind = isDir ? dirModelKind(target) : fileKind(path.basename(pathToModel));
  ensureEngineForKind(kind);
  const name = servedNameForTarget(target, isDir);
  updateSettings({
    LOCAL_MODEL_PATH: target,
    LOCAL_MODEL_NAME: name,
    CHAT_MODEL: name,
    // 用户刚在模型库里挑了一个具体的 MLX 目录模型：它才是要加载的那个。
    // MLX 引擎面板「部署」写的 MLX_MODEL 优先级更高，不清掉就会继续加载预设。
    ...(isDir && kind === "safetensors" && getSetting("INFERENCE_ENGINE") === "mlx"
      ? { MLX_MODEL: "" }
      : {}),
  });
  return { ok: true };
}

/** 目录占用（删除 HF 缓存条目时用来告诉用户释放了多少空间）。 */
function dirSize(dir: string, depth = 0): number {
  if (depth > 12) return 0;
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      const st = statSync(full);
      if (st.isDirectory()) total += dirSize(full, depth + 1);
      else total += st.size;
    } catch {
      // ignore
    }
  }
  return total;
}

/**
 * 删除本地模型。
 *
 * 路径来自 webview / 控制通道，不可信，所以只允许删除这三类位置：
 *   1. 应用下载目录内的文件（我们自己下下来的）；
 *   2. 用户显式添加过的本地目录（MODEL_DIRS）内的文件；
 *   3. Hugging Face 缓存：删除的是整个 `models--org--repo` 条目（blobs + snapshots），
 *      因为 snapshot 里全是软链，只删软链一个字节都释放不出来。
 * 其他任何路径一律拒绝 —— 否则一个 `path: "/etc/..."` 就能变成任意文件删除。
 */
export function deleteLocalModel(pathToModel: string): { ok: boolean; error?: string; freed?: number } {
  const abs = path.resolve(pathToModel);
  if (!existsSync(abs)) return { ok: false, error: "文件不存在" };

  const hub = getHfHubCacheDir();
  const cacheEntry = isInsideDir(hub, abs) ? findHfCacheEntry(abs, hub) : null;

  let freed = 0;
  try {
    if (cacheEntry) {
      freed = dirSize(cacheEntry);
      rmSync(cacheEntry, { recursive: true, force: true });
    } else {
      const allowed = [getModelsBaseDir(), ...getExtraModelDirs()];
      if (!allowed.some((root) => isInsideDir(root, abs))) {
        return {
          ok: false,
          error: "只允许删除应用下载目录、已添加的本地目录或 Hugging Face 缓存里的模型",
        };
      }
      const st = statSync(abs);
      freed = st.isDirectory() ? dirSize(abs) : st.size;
      rmSync(abs, { recursive: true, force: true });
      // 单文件删完后仓库目录里没有权重文件了，顺手把元数据一起清掉。
      // （目录条目本身就是仓库目录，元数据在它里面，已经跟着删掉了。）
      if (!st.isDirectory()) {
        const dir = path.dirname(abs);
        if (existsSync(dir) && readdirSync(dir).filter((n) => isModelWeightExt(n)).length === 0) {
          rmSync(path.join(dir, META_FILE), { force: true });
        }
      }
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  // 删掉的正是当前模型（或当前模型所在目录）时清空调用配置。
  const activePath = getSetting("LOCAL_MODEL_PATH");
  if (activePath && (activePath === abs || isInsideDir(abs, activePath) || !existsSync(activePath))) {
    updateSettings({ LOCAL_MODEL_PATH: "", LOCAL_MODEL_NAME: "", CHAT_MODEL: "" });
  }
  return { ok: true, freed };
}

/** 从缓存内的任意路径定位它所属的 `models--org--repo` 条目目录。 */
function findHfCacheEntry(target: string, hub: string): string | null {
  const rel = path.relative(path.resolve(hub), path.resolve(target));
  const first = rel.split(path.sep)[0];
  if (!first || !first.startsWith("models--")) return null;
  return path.join(path.resolve(hub), first);
}

export function getActiveModelPath(): string {
  return getSetting("LOCAL_MODEL_PATH");
}

/**
 * Import a local model file by copying it into the primary models dir
 * (`<base>/imported/`) so it appears in the installed-models list. Uses an
 * external `cp` process so multi-GB copies don't block the event loop.
 */
export async function importModelFile(sourcePath: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  if (!existsSync(sourcePath)) return { ok: false, error: "File does not exist" };
  const fileName = path.basename(sourcePath);
  if (!isModelWeightExt(fileName)) return { ok: false, error: "Not a supported model file" };
  try {
    const destDir = path.join(getModelsBaseDir(), "imported");
    mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, fileName);
    const proc = Bun.spawn(["cp", "-f", sourcePath, dest], { stdout: "ignore", stderr: "ignore" });
    const code = await proc.exited;
    if (code !== 0) return { ok: false, error: `Copy failed (exit ${code})` };
    return { ok: true, path: dest };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}