import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "fs";
import path from "path";
import { Utils } from "electrobun/bun";
import { isModelWeightExt, safeRepoId } from "../shared/modelscope";

export { isModelWeightExt, safeRepoId };

const MODELSCOPE_BASE = "https://modelscope.cn";
const OPENAPI_BASE = `${MODELSCOPE_BASE}/openapi/v1`;

export type ModelScopeModel = {
  id: string;
  name: string;
  description: string;
  downloads: number;
  likes: number;
  license: string;
  tasks: string[];
  tags: string[];
  fileSize: number;
  params: number;
  createdAt: string;
  lastModified: string;
};

export type ModelScopeFile = {
  name: string;
  path: string;
  size: number;
  isLfs: boolean;
  /** gguf → llama.cpp；safetensors → vLLM / SGLang；other → 其它文件（bin/pt/config 等） */
  kind: "gguf" | "safetensors" | "other";
  /** 是否为模型权重文件（可用于任一推理引擎加载） */
  isWeight: boolean;
};

function fileKind(name: string): ModelScopeFile["kind"] {
  const n = name.toLowerCase();
  if (n.endsWith(".gguf")) return "gguf";
  if (n.endsWith(".safetensors")) return "safetensors";
  return "other";
}

/**
 * Dev builds run with the process CWD inside the app bundle, which electrobun
 * regenerates on every rebuild — a CWD-relative data dir would be wiped
 * together with the downloaded models. Always use userData so data survives.
 */
export function getModelsBaseDir(): string {
  const base = path.join(Utils.paths.userData, "models");
  migrateLegacyCwdDir("vllm-studio-models", base);
  migrateLegacyCwdDir("kunpengtalk-studio-models", base);
  migrateLegacyCwdDir("omni-studio-models", base);
  return base;
}

/**
 * One-time move of dev data that used to live next to the process CWD (the app
 * bundle in dev) into userData. No-op once the legacy dir is gone.
 */
function migrateLegacyCwdDir(legacyName: string, dest: string): void {
  try {
    const legacy = path.resolve(legacyName);
    if (legacy === dest || !existsSync(legacy) || existsSync(dest)) return;
    mkdirSync(path.dirname(dest), { recursive: true });
    renameSync(legacy, dest);
  } catch {
    // ignore — data inside a wiped bundle dir is already unrecoverable
  }
}

export function splitRepo(repo: string): { owner: string; name: string } {
  const idx = repo.indexOf("/");
  if (idx < 0) return { owner: repo, name: repo };
  return { owner: repo.slice(0, idx), name: repo.slice(idx + 1) };
}

export async function searchModels(
  query: string,
  page = 1,
  pageSize = 20,
): Promise<{ models: ModelScopeModel[]; total: number }> {
  const url = new URL(`${OPENAPI_BASE}/models`);
  url.searchParams.set("search", query);
  url.searchParams.set("page", String(page));
  url.searchParams.set("page_size", String(pageSize));

  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`ModelScope search failed: ${res.status}`);

  const body = (await res.json()) as {
    data?: {
      models?: Array<{
        id: string;
        display_name?: string;
        description?: string;
        downloads?: number;
        likes?: number;
        license?: string;
        tasks?: string[];
        tags?: string[];
        file_size?: number;
        params?: number;
        created_at?: string;
        last_modified?: string;
      }>;
      total?: number;
    };
  };

  const list = body.data?.models ?? [];
  return {
    models: list.map((m) => ({
      id: m.id ?? "",
      name: m.display_name ?? m.id ?? "",
      description: m.description ?? "",
      downloads: m.downloads ?? 0,
      likes: m.likes ?? 0,
      license: m.license ?? "",
      tasks: m.tasks ?? [],
      tags: m.tags ?? [],
      fileSize: m.file_size ?? 0,
      params: m.params ?? 0,
      createdAt: m.created_at ?? "",
      lastModified: m.last_modified ?? "",
    })),
    total: body.data?.total ?? list.length,
  };
}

export async function listRepoFiles(repo: string): Promise<ModelScopeFile[]> {
  const { owner, name } = splitRepo(repo);
  const url = `${MODELSCOPE_BASE}/api/v1/models/${owner}/${name}/repo/files?Revision=master&Recursive=true`;

  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`ModelScope files failed: ${res.status}`);

  const body = (await res.json()) as {
    Data?: { Files?: Array<{ Name: string; Path: string; Size: number; IsLFS: boolean }> };
  };

  // Return every file in the repo (not just GGUF): vLLM / SGLang models are
  // shipped as safetensors + config, TTS/ASR models as bin/pt/onnx, etc.
  // Model weights are sorted first so llama.cpp / vLLM / SGLang users can
  // pick the right file quickly; README/config/tokenizer stay downloadable.
  return (body.Data?.Files ?? [])
    .map((f) => ({
      name: f.Name,
      path: f.Path,
      size: f.Size,
      isLfs: f.IsLFS,
      kind: fileKind(f.Name),
      isWeight: isModelWeightExt(f.Name),
    }))
    .sort((a, b) => {
      const ra = a.isWeight ? 0 : 1;
      const rb = b.isWeight ? 0 : 1;
      return ra - rb || b.size - a.size;
    });
}

export function resolveFileUrl(repo: string, filePath: string): string {
  const { owner, name } = splitRepo(repo);
  return `${MODELSCOPE_BASE}/models/${owner}/${name}/resolve/master/${filePath}`;
}

export function localModelPath(repo: string, fileName: string): string {
  return path.join(getModelsBaseDir(), safeRepoId(repo), fileName);
}

export function isModelInstalled(repo: string, fileName: string): boolean {
  return existsSync(localModelPath(repo, fileName));
}

export function installedModelSize(repo: string, fileName: string): number | null {
  const p = localModelPath(repo, fileName);
  if (!existsSync(p)) return null;
  try {
    const stats = statSync(p);
    return stats.size;
  } catch {
    return null;
  }
}

export type DownloadProgress = {
  received: number;
  total: number | null;
  percent: number | null;
};

/**
 * Download a raw file from a HuggingFace repo (audio.cpp GGUF 等不在 ModelScope 上的资源)。
 * 优先走国内镜像 hf-mirror.com，失败后回退官方 huggingface.co。
 * 与 downloadFile 相同：带 Range 断点续传，进度通过 onProgress 回调。
 */
export async function downloadHuggingFaceFile(
  repo: string,
  filePath: string,
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<{ path: string; size: number }> {
  const dir = path.join(getModelsBaseDir(), safeRepoId(repo));
  const destPath = path.join(dir, filePath);
  mkdirSync(path.dirname(destPath), { recursive: true });

  const mirrors = [
    `https://hf-mirror.com/${repo}/resolve/main/${filePath}`,
    `https://huggingface.co/${repo}/resolve/main/${filePath}`,
  ];

  let lastError: Error | null = null;
  for (const url of mirrors) {
    try {
      return await downloadHttpFile(url, destPath, onProgress, signal);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      // 域名不可达时换下一个镜像；被用户取消则直接抛出。
      if (signal?.aborted) throw e;
    }
  }
  throw lastError ?? new Error("HF download failed");
}

/** 每个文件的并行分片数(多线程下载的线程数)。 */
const PARALLEL_PARTS = 8;
/** 文件小于该大小不分片,直接单流下载。 */
const PARALLEL_MIN_TOTAL = 8 * 1024 * 1024;
/** 每个分片至少包含的字节数(文件越大分片越多,但不超过 PARALLEL_PARTS)。 */
const PART_MIN_BYTES = 2 * 1024 * 1024;

function throttleReport(
  fn: (p: DownloadProgress) => void,
): (received: number, total: number) => void {
  let lastTime = 0;
  let lastBytes = -1;
  return (received, total) => {
    const now = Date.now();
    // 进度回调很频繁(8 路并流),只在变化足够大或间隔足够长时才上报。
    if (now - lastTime < 150 && received - lastBytes < 256 * 1024) return;
    lastTime = now;
    lastBytes = received;
    fn({ received, total, percent: total > 0 ? (received / total) * 100 : null });
  };
}

/** 探测文件总大小(Range: bytes=0-0 → Content-Range)。失败返回 null。 */
async function probeTotalSize(url: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const res = await fetch(url, {
      headers: { Range: "bytes=0-0" },
      redirect: "follow",
      signal,
    });
    const cr = res.headers.get("content-range");
    await res.body?.cancel();
    if (cr) {
      const m = /\/\s*(\d+)\s*$/.exec(cr);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n)) return n;
      }
    }
    return parseContentLength(res);
  } catch {
    return null;
  }
}

/** 分片边界(字节区间 [start, end) )。 */
function partRanges(total: number, count: number): { start: number; end: number }[] {
  return Array.from({ length: count }, (_, i) => ({
    start: Math.floor((total * i) / count),
    end: i === count - 1 ? total : Math.floor((total * (i + 1)) / count),
  }));
}

/** 把已完成的分片按顺序合并为最终文件,完成后删除分片。 */
async function mergeParts(destPath: string, partPaths: string[]): Promise<void> {
  const tmp = `${destPath}.merge`;
  await new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(tmp);
    ws.on("error", reject);
    ws.on("finish", () => resolve());

    void (async () => {
      try {
        for (const p of partPaths) {
          await new Promise<void>((done, fail) => {
            const rs = createReadStream(p);
            rs.on("error", fail);
            rs.on("end", done);
            rs.pipe(ws, { end: false });
          });
        }
        ws.end();
      } catch (e) {
        try {
          ws.destroy();
        } catch {
          // ignore
        }
        reject(e);
      }
    })();
  });

  try {
    rmSync(destPath, { force: true });
    renameSync(tmp, destPath);
    for (const p of partPaths) rmSync(p, { force: true });
  } catch (e) {
    throw e;
  }
}

/**
 * 多线程(并行分片)下载,每个分片独立 Range 请求,可逐片断点续传。
 * 服务器不支持 Range / 请求被取消时返回 false,由调用方回退单流或抛出。
 */
async function downloadParallel(
  url: string,
  destPath: string,
  total: number,
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  const count = Math.min(PARALLEL_PARTS, Math.max(1, Math.ceil(total / PART_MIN_BYTES)));
  const partPaths = Array.from({ length: count }, (_, i) => `${destPath}.part${i}`);
  const ranges = partRanges(total, count);

  // 已有分片的大小(已下载的字节数,用于断点续传)。
  const existing = partPaths.map((p) => (existsSync(p) ? statSync(p).size : 0));

  // 分片全部就绪(比如上次下载到合并前中断)→ 直接合并。
  if (ranges.every((r, i) => existing[i]! >= r.end - r.start)) {
    await mergeParts(destPath, partPaths);
    onProgress?.({ received: total, total, percent: 100 });
    return true;
  }

  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) return false;
    signal.addEventListener("abort", onAbort, { once: true });
  }

  let received = existing.reduce((a, b) => a + b, 0);
  let serverIgnoredRange = false;
  const report = throttleReport((p) => onProgress?.(p));

  try {
    await Promise.all(
      partPaths.map((p, i) =>
        (async () => {
          if (ac.signal.aborted) return;
          const { start, end } = ranges[i]!;
          const length = end - start;
          let got = existing[i]!;
          if (got >= length) return;

          const res = await fetch(url, {
            headers: { Range: `bytes=${start + got}-${end - 1}` },
            redirect: "follow",
            signal: ac.signal,
          });
          // 服务器忽略 Range 返回整个文件 → 无法并行,整体回退单流。
          if (res.status === 200) {
            serverIgnoredRange = true;
            ac.abort();
            await res.body?.cancel();
            return;
          }
          if (res.status !== 206) {
            throw new Error(`Range download failed: ${res.status}`);
          }
          const stream = res.body;
          if (!stream) throw new Error("No response body");

          const reader = stream.getReader();
          const ws = createWriteStream(p, { flags: "a" });
          await new Promise<void>((resolve, reject) => {
            ws.on("error", reject);
            ws.on("finish", () => resolve());
            void (async () => {
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  if (value) {
                    ws.write(value);
                    received += value.byteLength;
                    report(received, total);
                  }
                }
              } catch (e) {
                // 取消/IO 错误时保留已写分片,下次从分片大小继续。
                try {
                  ws.end();
                } catch {
                  // ignore
                }
                reject(e);
                return;
              }
              ws.end();
            })();
          });
        })(),
      ),
    );

    if (serverIgnoredRange) return false;
    if (signal?.aborted || ac.signal.aborted) return false;

    await mergeParts(destPath, partPaths);
    onProgress?.({ received: total, total, percent: 100 });
    return true;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/** 单流下载(带 Range 断点续传),用于不支持 Range 或文件较小的场景。 */
async function downloadSingle(
  url: string,
  destPath: string,
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<{ path: string; size: number }> {
  const existing = existsSync(destPath) ? statSync(destPath).size : 0;
  const headers: Record<string, string> = {};
  if (existing > 0) headers["Range"] = `bytes=${existing}-`;

  const res = await fetch(url, {
    headers,
    redirect: "follow",
    signal: signal ?? AbortSignal.timeout(60_000),
  });
  if (res.status === 416) return { path: destPath, size: existing };
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);

  // 若服务器忽略 Range 返回完整 200,则从头写(覆盖可能不完整的部分文件)。
  const isResume = res.status === 206 && existing > 0;
  const contentLength = parseContentLength(res);
  const total =
    contentLength != null ? (isResume ? existing + contentLength : contentLength) : null;

  const stream = res.body;
  if (!stream) throw new Error("No response body");

  const reader = stream.getReader();
  const ws = createWriteStream(destPath, { flags: isResume ? "a" : "w" });
  let received = isResume ? existing : 0;

  return new Promise<{ path: string; size: number }>((resolve, reject) => {
    ws.on("error", reject);
    ws.on("finish", () => resolve({ path: destPath, size: received }));

    void (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            ws.write(value);
            received += value.byteLength;
            if (total) {
              onProgress?.({ received, total, percent: (received / total) * 100 });
            } else {
              onProgress?.({ received, total, percent: null });
            }
          }
        }
      } catch (e) {
        // Abort (pause/cancel) or IO error — flush partial bytes so resume can
        // resume from the exact file size on disk.
        try {
          ws.end();
        } catch {
          // ignore
        }
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      ws.end();
    })();
  });
}

/** 删除某个文件遗留的 .part 分片(合并完成后或取消时清理)。 */
function cleanupParts(destPath: string): void {
  try {
    const dir = path.dirname(destPath);
    const base = path.basename(destPath);
    for (const n of readdirSync(dir)) {
      if (n.startsWith(`${base}.part`)) rmSync(path.join(dir, n), { force: true });
    }
  } catch {
    // ignore
  }
}

/**
 * 带并行分片 + 断点续传的文件下载。最终落盘文件与单流一致,分片文件
 * 下载过程中存在于 destPath.partN,完成后合并删除。
 */
async function downloadHttpFile(
  url: string,
  destPath: string,
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<{ path: string; size: number }> {
  const existingFinal = existsSync(destPath) ? statSync(destPath).size : 0;
  let hasParts = false;
  try {
    hasParts = readdirSync(path.dirname(destPath)).some((n) =>
      n.startsWith(`${path.basename(destPath)}.part`),
    );
  } catch {
    // ignore
  }

  // 尝试多线程:优先续传分片;无分片时若总大小已知且文件较大则全量分片。
  if (hasParts || existingFinal === 0) {
    const total = await probeTotalSize(url, signal);
    if (total != null && total > existingFinal && total >= PARALLEL_MIN_TOTAL) {
      const ok = await downloadParallel(url, destPath, total, onProgress, signal);
      if (ok) return { path: destPath, size: total };
      // 并行被取消/不支持 → 被取消时按取消处理,其余回退单流。
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    } else if (total != null && existingFinal >= total) {
      cleanupParts(destPath);
      return { path: destPath, size: existingFinal };
    }
  }

  const done = await downloadSingle(url, destPath, onProgress, signal);
  cleanupParts(destPath);
  return done;
}

export async function downloadFile(
  repo: string,
  fileName: string,
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<{ path: string; size: number }> {
  const dir = path.join(getModelsBaseDir(), safeRepoId(repo));
  mkdirSync(dir, { recursive: true });
  const destPath = path.join(dir, fileName);

  return downloadHttpFile(resolveFileUrl(repo, fileName), destPath, onProgress, signal);
}

function parseContentLength(res: Response): number | null {
  const v = res.headers.get("content-length");
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}