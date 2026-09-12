import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { desc, eq, inArray } from "drizzle-orm";

import { db } from "./db";
import { videoRecords } from "./db/schema";
import { getSetting, updateSettings } from "./db/settings";
import { getImagesBaseDir } from "./image-server";
import { chatImageUrl } from "../shared/server-info";

/**
 * AI 视频生成模块（参照 ./image-gen.ts 与 OmniLabs 的视频服务实现）。
 *
 * 三种后端，全部是「提交任务 + 轮询」的异步模式：
 *
 * 1. **MiniMax（云端，H3）**：POST /v2/video_generation 提交，
 *    GET /v2/query/video_generation/{task_id} 轮询，成片从 content.url /
 *    /v2/files/{file_id} 下载。支持首帧图（图生视频）。自部署的 MiniMax
 *    兼容服务改 Base URL 即可。
 *
 * 2. **Seedance（云端，火山方舟）**：POST /api/v3/contents/generations/tasks
 *    提交（分辨率/比例/时长等以 `--flag` 尾缀写在提示词里），
 *    GET /tasks/{id} 轮询，成片取 content.video_url。
 *
 * 3. **ComfyUI（本地）**：提交 Wan 系文生视频工作流
 *    （CheckpointLoaderSimple + CLIPLoader(wan) + VAELoader + KSampler +
 *    SaveAnimatedWEBM），轮询 /history/{prompt_id}，从 /view 下载成片。
 *
 * submit 时先落一条 processing 记录并立即返回，前端每 5s 调
 * pollVideoRecords 查上游并回填结果（应用重启后继续轮询，任务不丢）。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type VideoGenBackend = "comfyui" | "minimax" | "seedance";

export type VideoRecordRow = {
  id: number;
  status: "processing" | "done" | "failed";
  backend: VideoGenBackend | null;
  model: string | null;
  prompt: string | null;
  negativePrompt: string | null;
  taskId: string | null;
  ratio: string | null;
  resolution: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  seed: number | null;
  steps: number | null;
  firstFrameUrl: string | null;
  videoUrl: string | null;
  error: string | null;
  createdAt: number;
  /** 上游报告的进度（0~1），仅轮询时返回，不落库。 */
  progress: number | null;
  /** 本轮轮询的瞬时错误（如成片下载失败，下一轮重试），不落库。 */
  pollError?: string | null;
};

export type VideoGenConfig = {
  backend: VideoGenBackend;
  minimaxBase: string;
  minimaxKey: string;
  minimaxModel: string;
  seedanceBase: string;
  seedanceKey: string;
  seedanceModel: string;
  comfyBase: string;
  comfyCkpt: string;
  comfyClip: string;
  comfyVae: string;
};

export type SubmitVideoParams = {
  prompt: string;
  negativePrompt?: string;
  /** 时长（秒）。minimax 4~15、seedance 3~12、comfyui 3~15（换算成 16fps 帧数）。 */
  duration?: number;
  ratio?: string;
  /** minimax: 480P/768P/2K；seedance: 480p/720p/1080p。comfyui 由比例换算像素。 */
  resolution?: string;
  seed?: number;
  steps?: number;
  /** KSampler cfg（仅 comfyui）。 */
  cfg?: number;
  model?: string;
  /** 图生视频首帧（images 目录内 ref，仅云端后端支持）。 */
  firstFrameRef?: string;
  /** 水印开关（minimax aigc_watermark / seedance --watermark）。 */
  watermark?: boolean;
  /** 前端当前页面的实时配置。若提供则优先使用（避免读到未保存的旧配置），并顺带落盘。 */
  config?: Partial<VideoGenConfig>;
};

type RecordRow = typeof videoRecords.$inferSelect;

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 各后端时长范围（秒）。 */
export const VIDEO_DURATION_RANGE: Record<VideoGenBackend, { min: number; max: number }> = {
  minimax: { min: 4, max: 15 },
  seedance: { min: 3, max: 12 },
  comfyui: { min: 3, max: 15 },
};

/** 比例 → ComfyUI（Wan）像素尺寸（均为 16 的倍数）。 */
export const VIDEO_COMFY_SIZES: Record<string, { width: number; height: number }> = {
  "16:9": { width: 832, height: 480 },
  "9:16": { width: 480, height: 832 },
  "1:1": { width: 640, height: 640 },
  "4:3": { width: 704, height: 528 },
  "3:4": { width: 528, height: 704 },
};

export const MINIMAX_VIDEO_MODELS = ["MiniMax-H3", "MiniMax-H3-Max"];

export const SEEDANCE_VIDEO_MODELS = [
  "doubao-seedance-1-0-lite-t2v-250428",
  "doubao-seedance-1-0-lite-i2v-250428",
  "doubao-seedance-1-0-pro-t2v-250528",
  "doubao-seedance-1-0-pro-i2v-250528",
];

/** 轮询兜底：超过 30 分钟仍未完成的任务标记为超时失败。 */
const STALE_MS = 30 * 60_000;

const VIDEO_EXT_RE = /\.(mp4|webm|mov|mkv|gif)$/i;

// ---------------------------------------------------------------------------
// 配置（存 settings 表）
// ---------------------------------------------------------------------------

export function getVideoGenConfig(): VideoGenConfig {
  const backend = getSetting("VIDEO_BACKEND");
  return {
    backend: backend === "comfyui" || backend === "seedance" ? backend : "minimax",
    minimaxBase: (getSetting("VIDEO_MINIMAX_BASE") || "").trim(),
    minimaxKey: (getSetting("VIDEO_MINIMAX_API_KEY") || "").trim(),
    minimaxModel: (getSetting("VIDEO_MINIMAX_MODEL") || "").trim(),
    seedanceBase: (getSetting("VIDEO_SEEDANCE_BASE") || "").trim(),
    seedanceKey: (getSetting("VIDEO_SEEDANCE_API_KEY") || "").trim(),
    seedanceModel: (getSetting("VIDEO_SEEDANCE_MODEL") || "").trim(),
    comfyBase: (getSetting("VIDEO_COMFY_BASE") || "").trim(),
    comfyCkpt: (getSetting("VIDEO_COMFY_CKPT") || "").trim(),
    comfyClip: (getSetting("VIDEO_COMFY_CLIP") || "").trim(),
    comfyVae: (getSetting("VIDEO_COMFY_VAE") || "").trim(),
  };
}

export function saveVideoGenConfig(cfg: Partial<VideoGenConfig>): void {
  const settings: Record<string, string> = {};
  if (cfg.backend !== undefined) settings.VIDEO_BACKEND = cfg.backend;
  if (cfg.minimaxBase !== undefined) settings.VIDEO_MINIMAX_BASE = cfg.minimaxBase.trim();
  if (cfg.minimaxKey !== undefined) settings.VIDEO_MINIMAX_API_KEY = cfg.minimaxKey.trim();
  if (cfg.minimaxModel !== undefined) settings.VIDEO_MINIMAX_MODEL = cfg.minimaxModel.trim();
  if (cfg.seedanceBase !== undefined) settings.VIDEO_SEEDANCE_BASE = cfg.seedanceBase.trim();
  if (cfg.seedanceKey !== undefined) settings.VIDEO_SEEDANCE_API_KEY = cfg.seedanceKey.trim();
  if (cfg.seedanceModel !== undefined) settings.VIDEO_SEEDANCE_MODEL = cfg.seedanceModel.trim();
  if (cfg.comfyBase !== undefined) settings.VIDEO_COMFY_BASE = cfg.comfyBase.trim();
  if (cfg.comfyCkpt !== undefined) settings.VIDEO_COMFY_CKPT = cfg.comfyCkpt.trim();
  if (cfg.comfyClip !== undefined) settings.VIDEO_COMFY_CLIP = cfg.comfyClip.trim();
  if (cfg.comfyVae !== undefined) settings.VIDEO_COMFY_VAE = cfg.comfyVae.trim();
  updateSettings(settings);
}

function normalizeBase(base: string, suffix: string): string {
  let b = base.trim().replace(/\/+$/, "");
  if (b && !b.endsWith(suffix)) b = `${b}${suffix}`;
  return b;
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = await res.text().catch(() => "");
  if (body) {
    try {
      const json = JSON.parse(body);
      return (
        json?.error?.message ??
        json?.base_resp?.status_msg ??
        json?.message ??
        body.slice(0, 300)
      );
    } catch {
      return body.slice(0, 300);
    }
  }
  return `${fallback}（${res.status}）`;
}

// ---------------------------------------------------------------------------
// 模型列表
// ---------------------------------------------------------------------------

export type VideoGenModels = {
  models: string[];
  checkpoints: string[];
  clips: string[];
  vaes: string[];
};

/** ComfyUI：从 /object_info 拉取 checkpoint / clip / vae 名称列表。 */
export async function listComfyVideoModels(base: string): Promise<VideoGenModels> {
  const clean = base.trim().replace(/\/+$/, "");
  if (!clean) throw new Error("请先配置 ComfyUI 服务地址（如 http://127.0.0.1:8188）");

  async function names(node: string, field: string): Promise<string[]> {
    const res = await fetch(`${clean}/object_info/${node}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`请求 ${node} 失败（${res.status}）`);
    const json = (await res.json().catch(() => null)) as
      | Record<string, { input?: { required?: Record<string, [string[]]> } }>
      | null;
    const list = json?.[node]?.input?.required?.[field]?.[0];
    return Array.isArray(list) ? list.filter((n): n is string => typeof n === "string") : [];
  }

  const [checkpoints, clips, vaes] = await Promise.all([
    names("CheckpointLoaderSimple", "ckpt_name"),
    names("CLIPLoader", "clip_name"),
    names("VAELoader", "vae_name"),
  ]);
  return { models: checkpoints, checkpoints, clips, vaes };
}

// ---------------------------------------------------------------------------
// 记录
// ---------------------------------------------------------------------------

function toRow(
  r: RecordRow,
  progress: number | null = null,
  pollError: string | null = null,
): VideoRecordRow {
  return {
    id: r.id,
    status: r.status,
    backend: r.backend ?? null,
    model: r.model,
    prompt: r.prompt,
    negativePrompt: r.negativePrompt,
    taskId: r.taskId,
    ratio: r.ratio,
    resolution: r.resolution,
    duration: r.duration,
    width: r.width,
    height: r.height,
    seed: r.seed,
    steps: r.steps,
    firstFrameUrl: r.firstFramePath ? chatImageUrl(r.firstFramePath) : null,
    videoUrl: r.videoPath ? chatImageUrl(r.videoPath) : null,
    error: r.error,
    createdAt: r.createdAt ?? 0,
    progress,
    pollError,
  };
}

export function listVideoRecords(limit = 100): VideoRecordRow[] {
  const rows = db
    .select()
    .from(videoRecords)
    .orderBy(desc(videoRecords.id))
    .limit(Math.min(limit, 500))
    .all();
  return rows.map((r) => toRow(r));
}

export function deleteVideoRecord(id: number): { ok: boolean } {
  const [row] = db.select().from(videoRecords).where(eq(videoRecords.id, id)).limit(1).all();
  if (!row) return { ok: false };
  db.delete(videoRecords).where(eq(videoRecords.id, id)).run();
  // 顺带清理磁盘上的成片（ref 是相对 images 根目录的路径）。
  if (row.videoPath) {
    const base = getImagesBaseDir();
    const resolved = path.resolve(base, row.videoPath);
    if (resolved.startsWith(base + path.sep) && existsSync(resolved)) {
      try {
        unlinkSync(resolved);
      } catch {}
    }
  }
  return { ok: true };
}

function insertVideoRecord(data: {
  status?: "processing" | "done" | "failed";
  backend?: VideoGenBackend | null;
  model?: string | null;
  prompt?: string | null;
  negativePrompt?: string | null;
  taskId?: string | null;
  ratio?: string | null;
  resolution?: string | null;
  duration?: number | null;
  width?: number | null;
  height?: number | null;
  seed?: number | null;
  steps?: number | null;
  firstFramePath?: string | null;
  videoPath?: string | null;
  error?: string | null;
}): RecordRow {
  return db
    .insert(videoRecords)
    .values({
      status: data.status ?? "processing",
      backend: data.backend ?? null,
      model: data.model ?? null,
      prompt: data.prompt ?? null,
      negativePrompt: data.negativePrompt ?? null,
      taskId: data.taskId ?? null,
      ratio: data.ratio ?? null,
      resolution: data.resolution ?? null,
      duration: data.duration ?? null,
      width: data.width ?? null,
      height: data.height ?? null,
      seed: data.seed ?? null,
      steps: data.steps ?? null,
      firstFramePath: data.firstFramePath ?? null,
      videoPath: data.videoPath ?? null,
      error: data.error ?? null,
    })
    .returning()
    .get();
}

function updateVideoRecord(
  id: number,
  values: Partial<typeof videoRecords.$inferInsert>,
): RecordRow {
  return db.update(videoRecords).set(values).where(eq(videoRecords.id, id)).returning().get();
}

// ---------------------------------------------------------------------------
// 成片落盘（写入 images 根目录下的 videos/ 子目录，由本地媒体服务对外提供）
// ---------------------------------------------------------------------------

function saveGeneratedVideo(data: Uint8Array, filename: string): string {
  const dir = path.join(getImagesBaseDir(), "videos");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const ext = VIDEO_EXT_RE.test(filename) ? path.extname(filename).toLowerCase() : ".mp4";
  const name = `${randomUUID()}${ext}`;
  writeFileSync(path.join(dir, name), data);
  return `videos/${name}`;
}

/** 把 ref 解析为 images 目录下的绝对路径（防目录穿越），不存在时返回 null。 */
function resolveImageRef(ref: string): string | null {
  const base = getImagesBaseDir();
  const resolved = path.resolve(base, ref);
  if (!resolved.startsWith(base + path.sep)) return null;
  return existsSync(resolved) ? resolved : null;
}

/** 读取首帧图并转成 data URL（minimax 的 image_url 直接吃 data URL）。 */
async function firstFrameDataUrl(ref: string): Promise<string | null> {
  const abs = resolveImageRef(ref);
  if (!abs) return null;
  const ext = path.extname(abs).toLowerCase();
  const mime =
    ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  const b64 = Buffer.from(await Bun.file(abs).arrayBuffer()).toString("base64");
  return `data:${mime};base64,${b64}`;
}

async function downloadToRef(url: string, fallbackName: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`下载成片失败（${res.status}）`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error("成片内容为空");
  return saveGeneratedVideo(bytes, fallbackName);
}

// ---------------------------------------------------------------------------
// 提交：MiniMax（H3）
// ---------------------------------------------------------------------------

async function submitMinimax(
  cfg: VideoGenConfig,
  params: SubmitVideoParams,
): Promise<string> {
  const base = normalizeBase(cfg.minimaxBase, "/v2").replace(/\/v2$/, "");
  if (!base) throw new Error("请先配置 MiniMax 服务地址");
  const model = params.model?.trim() || cfg.minimaxModel || MINIMAX_VIDEO_MODELS[0]!;

  const content: Record<string, unknown>[] = [{ type: "text", text: params.prompt }];
  if (params.firstFrameRef) {
    const dataUrl = await firstFrameDataUrl(params.firstFrameRef);
    if (dataUrl) content.push({ type: "image_url", image_url: dataUrl });
  }

  const range = VIDEO_DURATION_RANGE.minimax;
  const duration = Math.max(range.min, Math.min(range.max, Math.round(params.duration ?? 5)));

  const body: Record<string, unknown> = {
    model,
    content,
    duration,
    aigc_watermark: params.watermark ?? false,
  };
  if (params.ratio) body.ratio = params.ratio;
  if (params.resolution) body.resolution = params.resolution;

  const res = await fetch(`${base}/v2/video_generation`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.minimaxKey ? { Authorization: `Bearer ${cfg.minimaxKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(await errorMessage(res, "提交 MiniMax 生成任务失败"));
  const json = (await res.json().catch(() => null)) as
    | { task_id?: string; data?: { task_id?: string } }
    | null;
  const taskId = json?.task_id ?? json?.data?.task_id;
  if (!taskId) throw new Error("MiniMax 未返回 task_id，请检查服务配置");
  return taskId;
}

// ---------------------------------------------------------------------------
// 提交：Seedance（火山方舟）
// ---------------------------------------------------------------------------

async function submitSeedance(
  cfg: VideoGenConfig,
  params: SubmitVideoParams,
): Promise<string> {
  const base = normalizeBase(cfg.seedanceBase, "/api/v3");
  if (!base) throw new Error("请先配置 Seedance（火山方舟）服务地址");
  const model =
    params.model?.trim() || cfg.seedanceModel || SEEDANCE_VIDEO_MODELS[0]!;

  const range = VIDEO_DURATION_RANGE.seedance;
  const duration = Math.max(range.min, Math.min(range.max, Math.round(params.duration ?? 5)));

  // Seedance 的生成参数以 `--flag` 尾缀写在提示词文本里。
  const flags = [
    params.resolution ? `--resolution ${params.resolution}` : "",
    params.ratio ? `--ratio ${params.ratio}` : "",
    `--duration ${duration}`,
    `--watermark ${params.watermark ? "true" : "false"}`,
    params.seed && params.seed > 0 ? `--seed ${params.seed}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const content: Record<string, unknown>[] = [
    { type: "text", text: `${params.prompt} ${flags}`.trim() },
  ];
  if (params.firstFrameRef) {
    const dataUrl = await firstFrameDataUrl(params.firstFrameRef);
    if (dataUrl) {
      content.push({ type: "image_url", image_url: { url: dataUrl }, role: "first_frame" });
    }
  }

  const res = await fetch(`${base}/contents/generations/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.seedanceKey ? { Authorization: `Bearer ${cfg.seedanceKey}` } : {}),
    },
    body: JSON.stringify({ model, content }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(await errorMessage(res, "提交 Seedance 生成任务失败"));
  const json = (await res.json().catch(() => null)) as { id?: string } | null;
  if (!json?.id) throw new Error("Seedance 未返回任务 id，请检查 API Key 与模型");
  return json.id;
}

// ---------------------------------------------------------------------------
// 提交：ComfyUI（本地，Wan 文生视频工作流）
// ---------------------------------------------------------------------------

function buildComfyVideoWorkflow(p: {
  checkpoint: string;
  clip: string;
  vae: string;
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  frames: number;
  steps: number;
  cfg: number;
  seed: number;
}): Record<string, unknown> {
  return {
    "1": {
      class_type: "CheckpointLoaderSimple",
      _meta: { title: "Load Checkpoint" },
      inputs: { ckpt_name: p.checkpoint },
    },
    "2": {
      class_type: "CLIPLoader",
      _meta: { title: "Load CLIP" },
      inputs: { clip_name: p.clip, type: "wan", device: "default" },
    },
    "3": {
      class_type: "VAELoader",
      _meta: { title: "Load VAE" },
      inputs: { vae_name: p.vae },
    },
    "4": {
      class_type: "CLIPTextEncode",
      _meta: { title: "Prompt" },
      inputs: { text: p.prompt, clip: ["2", 0] },
    },
    "5": {
      class_type: "CLIPTextEncode",
      _meta: { title: "Negative Prompt" },
      inputs: { text: p.negativePrompt, clip: ["2", 0] },
    },
    "6": {
      class_type: "EmptyLatentImage",
      _meta: { title: "Empty Latent" },
      inputs: { width: p.width, height: p.height, length: p.frames, batch_size: 1 },
    },
    "7": {
      class_type: "KSampler",
      _meta: { title: "KSampler" },
      inputs: {
        seed: p.seed,
        steps: p.steps,
        cfg: p.cfg,
        sampler_name: "euler",
        scheduler: "simple",
        denoise: 1,
        model: ["1", 0],
        positive: ["4", 0],
        negative: ["5", 0],
        latent_image: ["6", 0],
      },
    },
    "8": {
      class_type: "VAEDecode",
      _meta: { title: "VAE Decode" },
      inputs: { samples: ["7", 0], vae: ["3", 0] },
    },
    "9": {
      class_type: "SaveAnimatedWEBM",
      _meta: { title: "Save Video" },
      inputs: {
        images: ["8", 0],
        filename_prefix: "omnistudio",
        fps: 16,
        lossless: false,
        quality: 90,
        method: "default",
      },
    },
  };
}

async function submitComfy(
  cfg: VideoGenConfig,
  params: SubmitVideoParams,
): Promise<{ promptId: string; width: number; height: number; frames: number; seed: number }> {
  const base = cfg.comfyBase.trim().replace(/\/+$/, "");
  if (!base) throw new Error("请先配置 ComfyUI 服务地址（如 http://127.0.0.1:8188）");

  // checkpoint / clip / vae 未填时，自动从 /object_info 里挑最像 Wan 的那一个。
  let { comfyCkpt: checkpoint, comfyClip: clip, comfyVae: vae } = cfg;
  const needProbe = !checkpoint || !clip || !vae;
  if (needProbe) {
    const lists = await listComfyVideoModels(base);
    const pick = (list: string[], re: RegExp) =>
      list.find((n) => re.test(n)) ?? list[0] ?? "";
    if (!checkpoint) checkpoint = pick(lists.checkpoints, /wan/i);
    if (!clip) clip = pick(lists.clips, /umt5|wan/i);
    if (!vae) vae = pick(lists.vaes, /wan/i);
  }
  if (!checkpoint) throw new Error("未找到 ComfyUI checkpoint，请先在 ComfyUI 下载 Wan 模型");
  if (!clip) throw new Error("未找到 ComfyUI CLIP（umt5），请先配置 CLIPLoader 模型");
  if (!vae) throw new Error("未找到 ComfyUI VAE（wan vae），请先配置 VAELoader 模型");

  const ratio = params.ratio || "16:9";
  const size = VIDEO_COMFY_SIZES[ratio] ?? VIDEO_COMFY_SIZES["16:9"]!;
  const range = VIDEO_DURATION_RANGE.comfyui;
  const duration = Math.max(range.min, Math.min(range.max, Math.round(params.duration ?? 5)));
  // Wan 系列 16fps；帧数 = 秒 * 16 + 1（81 帧 ≈ 5 秒）。
  const frames = duration * 16 + 1;
  const seed = params.seed && params.seed > 0 ? params.seed : Math.floor(Math.random() * 2 ** 31);

  const workflow = buildComfyVideoWorkflow({
    checkpoint,
    clip,
    vae,
    prompt: params.prompt,
    negativePrompt: params.negativePrompt?.trim() || "",
    width: size.width,
    height: size.height,
    frames,
    steps: params.steps ?? 20,
    cfg: params.cfg ?? 5,
    seed,
  });

  const res = await fetch(`${base}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: randomUUID() }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(await errorMessage(res, "提交 ComfyUI 工作流失败"));
  const json = (await res.json().catch(() => null)) as { prompt_id?: string } | null;
  if (!json?.prompt_id) throw new Error("ComfyUI 未返回 prompt_id，请检查服务日志");
  return { promptId: json.prompt_id, width: size.width, height: size.height, frames, seed };
}

// ---------------------------------------------------------------------------
// 对外入口：提交生成
// ---------------------------------------------------------------------------

export async function submitVideoGeneration(
  params: SubmitVideoParams,
): Promise<{ record?: VideoRecordRow; error?: string }> {
  // 优先使用前端实时配置（同生图：生成时直接用页面上的值并落盘）。
  const dbCfg = getVideoGenConfig();
  const cfg: VideoGenConfig = {
    ...dbCfg,
    backend: params.config?.backend ?? dbCfg.backend,
    minimaxBase:
      params.config?.minimaxBase !== undefined
        ? params.config.minimaxBase.trim()
        : dbCfg.minimaxBase,
    minimaxKey:
      params.config?.minimaxKey !== undefined
        ? params.config.minimaxKey.trim()
        : dbCfg.minimaxKey,
    minimaxModel:
      params.config?.minimaxModel !== undefined
        ? params.config.minimaxModel.trim()
        : dbCfg.minimaxModel,
    seedanceBase:
      params.config?.seedanceBase !== undefined
        ? params.config.seedanceBase.trim()
        : dbCfg.seedanceBase,
    seedanceKey:
      params.config?.seedanceKey !== undefined
        ? params.config.seedanceKey.trim()
        : dbCfg.seedanceKey,
    seedanceModel:
      params.config?.seedanceModel !== undefined
        ? params.config.seedanceModel.trim()
        : dbCfg.seedanceModel,
    comfyBase:
      params.config?.comfyBase !== undefined
        ? params.config.comfyBase.trim()
        : dbCfg.comfyBase,
    comfyCkpt:
      params.config?.comfyCkpt !== undefined ? params.config.comfyCkpt.trim() : dbCfg.comfyCkpt,
    comfyClip:
      params.config?.comfyClip !== undefined ? params.config.comfyClip.trim() : dbCfg.comfyClip,
    comfyVae:
      params.config?.comfyVae !== undefined ? params.config.comfyVae.trim() : dbCfg.comfyVae,
  };
  try {
    saveVideoGenConfig(cfg);
  } catch {}

  const prompt = params.prompt?.trim() ?? "";
  if (!prompt) return { error: "请先输入提示词" };

  const common = {
    backend: cfg.backend,
    model:
      params.model?.trim() ||
      (cfg.backend === "seedance" ? cfg.seedanceModel : cfg.minimaxModel) ||
      null,
    prompt,
    negativePrompt: params.negativePrompt?.trim() || null,
    ratio: params.ratio ?? null,
    resolution: params.resolution ?? null,
    duration: params.duration ?? null,
    seed: params.seed ?? null,
    steps: params.steps ?? null,
    firstFramePath: params.firstFrameRef ?? null,
  };

  try {
    if (cfg.backend !== "comfyui" && params.firstFrameRef) {
      const abs = resolveImageRef(params.firstFrameRef);
      if (!abs) throw new Error("首帧图文件不存在，请重新选择");
    }

    if (cfg.backend === "comfyui") {
      const submitted = await submitComfy(cfg, params);
      const record = insertVideoRecord({
        ...common,
        taskId: submitted.promptId,
        width: submitted.width,
        height: submitted.height,
        duration: Math.round((submitted.frames - 1) / 16),
        seed: submitted.seed,
        steps: params.steps ?? 20,
      });
      return { record: toRow(record) };
    }

    const taskId =
      cfg.backend === "seedance"
        ? await submitSeedance(cfg, params)
        : await submitMinimax(cfg, params);
    const record = insertVideoRecord({ ...common, taskId });
    return { record: toRow(record) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    insertVideoRecord({ ...common, status: "failed", error: message });
    return { error: message };
  }
}

// ---------------------------------------------------------------------------
// 对外入口：轮询（前端每 5s 调一次；应用重启后继续，任务不丢）
// ---------------------------------------------------------------------------

const MINIMAX_DONE = new Set(["Success", "Succeeded", "success", "succeeded"]);
const MINIMAX_FAILED = new Set(["Fail", "Failed", "fail", "Error", "error", "failed"]);
const SEEDANCE_DONE = new Set(["succeeded"]);
const SEEDANCE_FAILED = new Set(["failed", "cancelled"]);

/** 解析上游进度（0~1；上游给 0~100 的百分数时归一化）。 */
function normalizeProgress(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n > 1 ? Math.min(1, n / 100) : n;
}

async function pollMinimax(cfg: VideoGenConfig, taskId: string): Promise<{
  done: boolean;
  failed?: string;
  videoUrl?: string;
  progress?: number | null;
}> {
  const base = normalizeBase(cfg.minimaxBase, "/v2").replace(/\/v2$/, "");
  const res = await fetch(`${base}/v2/query/video_generation/${taskId}`, {
    headers: cfg.minimaxKey ? { Authorization: `Bearer ${cfg.minimaxKey}` } : {},
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404) return { done: true, failed: "上游任务不存在或已过期" };
  if (!res.ok) return { done: false }; // 网络抖动等：下轮再查
  const json = (await res.json().catch(() => null)) as
    | {
        status?: string;
        progress?: unknown;
        content?: { url?: string };
        video_url?: string;
        video?: string;
        output?: string;
        file_url?: string;
        file_id?: string;
        file?: { name?: string; file_id?: string };
        fail_reason?: string;
        error?: string;
        message?: string;
        base_resp?: { status_msg?: string };
      }
    | null;
  if (!json) return { done: false };

  const status = json.status ?? "";
  if (MINIMAX_FAILED.has(status)) {
    return {
      done: true,
      failed:
        json.fail_reason ?? json.error ?? json.message ??
        json.base_resp?.status_msg ?? "生成失败",
    };
  }
  if (!MINIMAX_DONE.has(status)) {
    return { done: false, progress: normalizeProgress(json.progress) };
  }

  // 成片地址：content.url（可能是 /v2/files/xxx.mp4 相对路径）兜底其他字段；
  // 只有 file_id 时用 /v2/files/{file_id} 取片。
  let url = json.content?.url ?? json.video_url ?? json.video ?? json.output ?? json.file_url;
  const fileId = json.file_id ?? json.file?.name ?? json.file?.file_id;
  if (!url && fileId) url = `${base}/v2/files/${fileId}`;
  if (!url) return { done: true, failed: "上游未返回成片地址" };
  const absolute = /^https?:\/\//i.test(url) ? url : new URL(url, `${base}/`).toString();
  return { done: true, videoUrl: absolute };
}

async function pollSeedance(cfg: VideoGenConfig, taskId: string): Promise<{
  done: boolean;
  failed?: string;
  videoUrl?: string;
  progress?: number | null;
}> {
  const base = normalizeBase(cfg.seedanceBase, "/api/v3");
  const res = await fetch(`${base}/contents/generations/tasks/${taskId}`, {
    headers: cfg.seedanceKey ? { Authorization: `Bearer ${cfg.seedanceKey}` } : {},
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404) return { done: true, failed: "上游任务不存在或已过期" };
  if (!res.ok) return { done: false };
  const json = (await res.json().catch(() => null)) as
    | {
        status?: string;
        content?: { video_url?: string };
        error?: { message?: string };
      }
    | null;
  if (!json) return { done: false };

  const status = json.status ?? "";
  if (SEEDANCE_FAILED.has(status)) {
    return { done: true, failed: json.error?.message ?? `生成失败（${status}）` };
  }
  if (!SEEDANCE_DONE.has(status)) return { done: false };
  const url = json.content?.video_url;
  if (!url) return { done: true, failed: "上游未返回成片地址" };
  return { done: true, videoUrl: url };
}

async function pollComfy(cfg: VideoGenConfig, promptId: string): Promise<{
  done: boolean;
  failed?: string;
  videoUrl?: string;
  progress?: number | null;
}> {
  const base = cfg.comfyBase.trim().replace(/\/+$/, "");
  const res = await fetch(`${base}/history/${promptId}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return { done: false }; // 还在队列里
  if (!res.ok) return { done: false };
  const json = (await res.json().catch(() => null)) as
    | Record<
        string,
        {
          outputs?: Record<
            string,
            {
              images?: { filename: string; subfolder?: string; type?: string }[];
              gifs?: { filename: string; subfolder?: string; type?: string }[];
            }
          >;
          status?: { status_str?: string; completed?: boolean; messages?: unknown[] };
        }
      >
    | null;
  const entry = json?.[promptId];
  if (!entry) return { done: false };

  if (entry.status?.status_str === "error") {
    const detail = JSON.stringify(entry.status.messages ?? "").slice(0, 300);
    return { done: true, failed: `ComfyUI 执行出错：${detail}` };
  }

  // 视频输出节点（SaveAnimatedWEBM / SaveVideo）的结果在 gifs / images 里。
  const files: { filename: string; subfolder?: string; type?: string }[] = [];
  for (const nodeOutput of Object.values(entry.outputs ?? {})) {
    files.push(...(nodeOutput.gifs ?? []), ...(nodeOutput.images ?? []));
  }
  if (files.length === 0) return { done: false }; // 仍在执行

  // 优先取视频扩展名的文件（webm/mp4），否则第一个输出。
  const file =
    files.find((f) => VIDEO_EXT_RE.test(f.filename)) ?? files[0]!;
  const qs = new URLSearchParams({
    filename: file.filename,
    subfolder: file.subfolder ?? "",
    type: file.type || "output",
  });
  return { done: true, videoUrl: `${base}/view?${qs}` };
}

export async function pollVideoRecords(ids: number[]): Promise<VideoRecordRow[]> {
  if (ids.length === 0) return [];
  const rows = db
    .select()
    .from(videoRecords)
    .where(inArray(videoRecords.id, ids))
    .all();
  const cfg = getVideoGenConfig();
  const out: VideoRecordRow[] = [];

  for (const row of rows) {
    if (row.status !== "processing") {
      out.push(toRow(row));
      continue;
    }

    // 兜底超时：上游一直不回来就标记失败，避免永远「生成中」。
    if (Date.now() - (row.createdAt ?? 0) > STALE_MS) {
      const updated = updateVideoRecord(row.id, {
        status: "failed",
        error: "生成超时（超过 30 分钟），可重试或检查服务状态",
      });
      out.push(toRow(updated));
      continue;
    }

    try {
      const result = !row.taskId
        ? { done: true, failed: "缺少上游任务 id" }
        : row.backend === "seedance"
          ? await pollSeedance(cfg, row.taskId)
          : row.backend === "comfyui"
            ? await pollComfy(cfg, row.taskId)
            : await pollMinimax(cfg, row.taskId);

      if (!result.done) {
        out.push(toRow(row, result.progress ?? null));
        continue;
      }
      if (result.failed) {
        const updated = updateVideoRecord(row.id, { status: "failed", error: result.failed });
        out.push(toRow(updated));
        continue;
      }
      // 下载成片并落盘（文件名沿用上游，扩展名白名单校验）。
      const name = result.videoUrl!.split("?")[0]!.split("/").pop() ?? "video.mp4";
      const ref = await downloadToRef(result.videoUrl!, name);
      const updated = updateVideoRecord(row.id, { status: "done", videoPath: ref });
      out.push(toRow(updated));
    } catch (e) {
      // 下载失败等瞬时错误：保留 processing，下一轮重试（超时兜底在上面）。
      out.push(toRow(row, null, e instanceof Error ? e.message : String(e)));
    }
  }
  return out;
}
