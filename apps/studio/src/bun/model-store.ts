import { existsSync, rmSync, readdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { getModelsBaseDir, safeRepoId, splitRepo, installedModelSize, isModelWeightExt } from "./modelscope";
import { getSetting, updateSettings } from "./db/settings";
import type { ModelCategory } from "../shared/modelscope";

export type InstalledModel = {
  repo: string;
  fileName: string;
  path: string;
  size: number;
  isActive: boolean;
  isChatModel: boolean;
  category: ModelCategory;
  favorite: boolean;
};

const META_FILE = ".vllm-meta.json";

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

function listInstalledModelsRecursive(dir: string, repo: string, out: { repo: string; fileName: string; path: string; size: number }[]): void {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        listInstalledModelsRecursive(full, entry.name, out);
      } else if (isModelWeightExt(entry.name)) {
        const size = installedModelSize(repo, entry.name);
        out.push({
          repo,
          fileName: entry.name,
          path: full,
          size: size ?? 0,
        });
      }
    }
  } catch {
    // ignore
  }
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

function readCategory(repoDir: string, fileName: string): ModelCategory {
  try {
    const metaPath = path.join(repoDir, META_FILE);
    if (existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { category?: ModelCategory };
      if (meta.category && VALID_CATEGORIES.includes(meta.category)) return meta.category;
    }
  } catch {
    // fall through
  }
  return classifyInstalledFilename(fileName);
}

/** Persist the category of a downloaded model so the installed list can group by it. */
export function setModelCategory(repo: string, fileName: string, category: ModelCategory) {
  if (!VALID_CATEGORIES.includes(category)) return;
  const repoDir = path.join(getModelsBaseDir(), safeRepoId(repo));
  try {
    const metaPath = path.join(repoDir, META_FILE);
    let meta: { category?: ModelCategory } = {};
    if (existsSync(metaPath)) {
      try {
        meta = JSON.parse(readFileSync(metaPath, "utf8")) as { category?: ModelCategory };
      } catch {
        meta = {};
      }
    }
    meta.category = category;
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
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

export function listInstalledModels(): InstalledModel[] {
  const baseDirs = getModelsDirs();
  if (baseDirs.length === 0) return [];

  const activePath = getSetting("LOCAL_MODEL_PATH");
  const chatModel = getSetting("CHAT_MODEL");
  const favorites = getFavorites();

  const results: InstalledModel[] = [];

  for (const baseDir of baseDirs) {
    if (!existsSync(baseDir)) continue;
    for (const repoDirName of readdirSync(baseDir, { withFileTypes: true })) {
      if (!repoDirName.isDirectory()) continue;
      const repoDir = path.join(baseDir, repoDirName.name);
      const files: { repo: string; fileName: string; path: string; size: number }[] = [];
      listInstalledModelsRecursive(repoDir, repoDirName.name, files);
      for (const f of files) {
        const isActive = f.path === activePath;
        results.push({
          repo: f.repo,
          fileName: f.fileName,
          path: f.path,
          size: f.size,
          isActive,
          isChatModel: isActive && chatModel === f.fileName,
          category: readCategory(repoDir, f.fileName),
          favorite: favorites.has(f.path),
        });
      }
    }
  }

  return results;
}

export function setActiveModel(pathToModel: string): { ok: boolean; error?: string } {
  if (!existsSync(pathToModel)) return { ok: false, error: "Model file does not exist" };
  const fileName = path.basename(pathToModel);
  const name = fileName
    .replace(/\.(gguf|safetensors|bin|pt|pth|ckpt|onnx|ggml)$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "-");
  updateSettings({
    LOCAL_MODEL_PATH: pathToModel,
    LOCAL_MODEL_NAME: name,
    CHAT_MODEL: name,
  });
  return { ok: true };
}

export function deleteLocalModel(pathToModel: string): { ok: boolean } {
  try {
    rmSync(pathToModel, { force: true });
    const dir = path.dirname(pathToModel);
    const remaining = readdirSync(dir).filter((n) => isModelWeightExt(n));
    if (remaining.length === 0) rmSync(path.join(dir, META_FILE), { force: true });
  } catch {
    // ignore
  }
  if (getSetting("LOCAL_MODEL_PATH") === pathToModel) {
    updateSettings({ LOCAL_MODEL_PATH: "", LOCAL_MODEL_NAME: "", CHAT_MODEL: "" });
  }
  return { ok: true };
}

export function getActiveModelPath(): string {
  return getSetting("LOCAL_MODEL_PATH");
}