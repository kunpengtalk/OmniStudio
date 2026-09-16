import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { desc, eq, inArray } from "drizzle-orm";

import { db } from "./db";
import { videoRecords, type MediaSource } from "./db/schema";
import { getSetting, updateSettings } from "./db/settings";
import { getImagesBaseDir } from "./image-server";
import { chatImageUrl } from "../shared/server-info";
import * as CloudProviders from "./cloud-providers";
import {
  MINIMAX_VIDEO_MODELS,
  SEEDANCE_VIDEO_MODELS,
} from "../shared/cloud-providers";
import { logEvent } from "./app-log";
import { providerLabelFor, recordUsageEvent } from "./usage";

// 模型清单的唯一真源在 shared/cloud-providers（预设与服务商用同一份），
// 这里继续对外导出，保持既有导入方（rpc / 脚本）不变。
export { MINIMAX_VIDEO_MODELS, SEEDANCE_VIDEO_MODELS };

/**
 * AI 视频生成模块（参照 ./image-gen.ts 与 OmniLabs 的视频服务实现）。
 *
 * 三种后端，全部是「提交任务 + 轮询」的异步模式：
 *
 * 1. **MiniMax（云端，Hailuo / T2V 系）**：POST /v1/video_generation 提交，
 *    GET /v1/query/video_generation?task_id=… 轮询，成片用 file_id 走
 *    GET /v1/files/retrieve 取下载地址。支持首帧图（图生视频）。
 *    自部署的 MiniMax 兼容服务改 Base URL 即可（只实现了旧版 v2 私约的也能兜底）。
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

/** 生视频后端：本地 ComfyUI 或云端（云端厂商在设置里配置，见 cloud_providers 表）。 */
export type VideoGenBackend = "comfyui" | "cloud";

export type VideoRecordRow = {
  id: number;
  status: "processing" | "done" | "failed";
  source: MediaSource;
  /** 旧记录可能是 minimax / seedance（当时的后端名即协议名）。 */
  backend: VideoGenBackend | "minimax" | "seedance" | null;
  /** 云端提交用的服务商 id（轮询按它查上游）。 */
  providerId: string | null;
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
  /** 成片在 images 根目录下的相对路径（如 videos/xxx.mp4），供复用与读取。 */
  videoPath: string | null;
  error: string | null;
  createdAt: number;
  /** 上游报告的进度（0~1），仅轮询时返回，不落库。 */
  progress: number | null;
  /** 本轮轮询的瞬时错误（如成片下载失败，下一轮重试），不落库。 */
  pollError?: string | null;
};

export type VideoGenConfig = {
  backend: VideoGenBackend;
  /**
   * 云端生视频选中的服务商（地址 / 密钥 / 接口协议都来自这一行）。
   * 视频页只挑厂商 + 模型，不再单独保存地址与密钥。
   */
  providerId: string;
  model: string;
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
  /** 调用方来源：界面手工生成（manual，默认）还是 agent（内置 Pi Agent）。 */
  source?: MediaSource;
};

type RecordRow = typeof videoRecords.$inferSelect;

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** MiniMax 生视频的时长档位（Hailuo 系只认 6 / 10 秒，别的秒数会被上游拒或静默改）。 */
export const MINIMAX_DURATIONS = [6, 10];

/** MiniMax 生视频的分辨率档位。 */
export const MINIMAX_RESOLUTIONS = ["720P", "768P", "1080P"];

/** 各接口协议的时长范围（秒）：云端按厂商协议分（MiniMax / Seedance），本地是 ComfyUI。 */
export const VIDEO_DURATION_RANGE: Record<"minimax" | "seedance" | "comfyui", {
  min: number;
  max: number;
}> = {
  minimax: { min: 6, max: 10 },
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

/** 轮询兜底：超过 30 分钟仍未完成的任务标记为超时失败。 */
const STALE_MS = 30 * 60_000;

const VIDEO_EXT_RE = /\.(mp4|webm|mov|mkv|gif)$/i;

// ---------------------------------------------------------------------------
// 配置（存 settings 表）
// ---------------------------------------------------------------------------

export function getVideoGenConfig(): VideoGenConfig {
  const backend = getSetting("VIDEO_BACKEND");
  return {
    // 旧值（minimax / seedance）归一成 cloud：那一套配置在启动时已迁成服务商行。
    backend: backend === "comfyui" ? "comfyui" : "cloud",
    providerId: (getSetting("VIDEO_PROVIDER_ID") || "").trim(),
    model: (getSetting("VIDEO_MODEL") || "").trim(),
    comfyBase: (getSetting("VIDEO_COMFY_BASE") || "").trim(),
    comfyCkpt: (getSetting("VIDEO_COMFY_CKPT") || "").trim(),
    comfyClip: (getSetting("VIDEO_COMFY_CLIP") || "").trim(),
    comfyVae: (getSetting("VIDEO_COMFY_VAE") || "").trim(),
  };
}

/** 保存生视频配置：视频页只写 backend / providerId / model。 */
export function saveVideoGenConfig(cfg: Partial<VideoGenConfig>): void {
  const settings: Record<string, string> = {};
  if (cfg.backend !== undefined) settings.VIDEO_BACKEND = cfg.backend;
  if (cfg.providerId !== undefined) settings.VIDEO_PROVIDER_ID = cfg.providerId.trim();
  if (cfg.model !== undefined) settings.VIDEO_MODEL = cfg.model.trim();
  if (cfg.comfyBase !== undefined) settings.VIDEO_COMFY_BASE = cfg.comfyBase.trim();
  if (cfg.comfyCkpt !== undefined) settings.VIDEO_COMFY_CKPT = cfg.comfyCkpt.trim();
  if (cfg.comfyClip !== undefined) settings.VIDEO_COMFY_CLIP = cfg.comfyClip.trim();
  if (cfg.comfyVae !== undefined) settings.VIDEO_COMFY_VAE = cfg.comfyVae.trim();
  updateSettings(settings);
  if (cfg.providerId && cfg.model) {
    CloudProviders.saveAppModelChoice({
      settingKey: "VIDEO_PROVIDER_ID",
      providerId: cfg.providerId.trim(),
      model: cfg.model,
      type: "video",
    });
  }
}

/** 云端生视频的一次调用目标：厂商地址 / 密钥 + 接口协议。 */
type CloudVideoTarget = {
  providerId: string;
  providerName: string;
  base: string;
  key: string;
  videoApi: "minimax" | "seedance";
};

/**
 * 按服务商解析生视频调用目标。视频 API 没有统一标准，协议记在服务商行上
 * （`videoApi`），没配协议的厂商不能用来生视频 —— 这里直接给出可读的原因。
 */
function resolveCloudTarget(providerId: string): CloudVideoTarget {
  const provider = CloudProviders.resolveCloudProvider(providerId);
  if (!provider) {
    throw new Error("还没选择云厂商。请到「设置 → 模型云服务」启用一个支持生视频的厂商");
  }
  if (!provider.baseUrl.trim()) throw new Error(`云厂商「${provider.name}」还没有填 API 地址`);
  const videoApi = provider.videoApi;
  if (videoApi !== "minimax" && videoApi !== "seedance") {
    throw new Error(`云厂商「${provider.name}」没有配置生视频接口（在设置里选 MiniMax / Seedance）`);
  }
  return {
    providerId: provider.id,
    providerName: provider.name,
    base: provider.baseUrl.trim(),
    key: provider.apiKey.trim(),
    videoApi,
  };
}

/**
 * 记一次生视频提交。
 *
 * 跟生图同一种情况：没有 token 口径（云端按秒 / 次计费，本地 ComfyUI 免费），
 * 但每次提交都是用户眼里的一次"调用"，统计页里得看得见。没有 token 就记
 * `requests: 1`，token 留 0。
 */
function recordVideoUsage(
  upstream: "local" | "cloud",
  provider: string,
  model: string | null | undefined,
): void {
  recordUsageEvent({
    channel: "video",
    upstream,
    provider: provider || providerLabelFor(upstream),
    model: model ?? "",
  });
}

/** 失败日志用：解析不到也只能记个空，别让日志本身抛错。 */
function providerTargetForLog(providerId: string): { base: string; hasApiKey: boolean } | null {
  const provider = CloudProviders.resolveCloudProvider(providerId);
  if (!provider) return null;
  return { base: provider.baseUrl.trim(), hasApiKey: Boolean(provider.apiKey.trim()) };
}

/**
 * 归一化厂商根地址：剥掉用户误填的版本后缀，再拼本协议要求的前缀。
 *
 * 用户常把接口文档里带版本的整段路径直接填进「API 地址」（`…/v1`、`…/v2`、
 * `…/api/v3`），而调用处还会再拼一次自己的路径 —— 请求就落成
 * `…/v1/v2/video_generation`，上游只回一句 404 page not found（真踩过）。
 * 所以先把末尾的版本段（`/v1`、`/v2` …，可连写多个）剥掉，再补协议前缀。
 */
export function normalizeApiBase(base: string, prefix: "" | "/api/v3"): string {
  let b = base.trim().replace(/\/+$/, "");
  if (prefix && b.endsWith(prefix)) b = b.slice(0, -prefix.length);
  while (/\/v\d+$/i.test(b)) b = b.replace(/\/v\d+$/i, "").replace(/\/+$/, "");
  return b ? `${b}${prefix}` : "";
}

/** 读一次响应正文（Response 只能读一次），同时给出原始文本与其中可读的报错信息。 */
async function readErrorBody(res: Response): Promise<{ raw: string; message: string }> {
  const raw = (await res.text().catch(() => "")).trim();
  if (!raw) return { raw: "", message: "" };
  try {
    const json = JSON.parse(raw) as
      | {
          error?: { message?: string };
          base_resp?: { status_code?: unknown; status_msg?: string };
          message?: string;
        }
      | null;
    const message = json?.error?.message ?? json?.base_resp?.status_msg ?? json?.message;
    if (typeof message === "string" && message.trim()) {
      // MiniMax 把业务码放在 base_resp.status_code，正文里不带它 —— 而排查时大家搜的
      // 恰恰是这个码（1004 login fail）。丢掉就白记了，所以有码就并进消息里。
      const code = json?.base_resp?.status_code;
      const withCode =
        code === undefined || code === null || message.includes(String(code))
          ? message
          : `${String(code)} ${message}`;
      return { raw, message: withCode };
    }
    return { raw, message: raw.slice(0, 300) };
  } catch {
    return { raw, message: raw.slice(0, 300) };
  }
}

/**
 * 正文像不像 JSON：不像 JSON 的 404 是网关 / 路由回的（`404 page not found`），
 * 跟上游业务层的「任务不存在」是两回事 —— 前者要改地址，后者才是任务过期。
 */
function looksLikeJson(raw: string): boolean {
  const t = raw.trim();
  return t.startsWith("{") || t.startsWith("[");
}

/**
 * 路由级 404（正文不是 JSON）补一句「地址可能填错」——光回一句 `404 page not found`
 * 用户没法知道问题出在地址上（这正是首次提交失败的现场）。
 */
function withRouteHint(base: string, status: number, raw: string, message: string): string {
  if (status !== 404 || looksLikeJson(raw)) return message;
  const text = message || "404 page not found";
  return `${text}：上游没有这个接口路径（当前 API 地址 ${base}），请到「设置 → 模型云服务」检查该厂商的地址 —— 填根地址即可，不要带 /v1、/v2`;
}

/** 上游报错文案。`hintBase` 给定时，路由级 404 会补上「地址可能填错」的提示。 */
async function errorMessage(res: Response, fallback: string, hintBase?: string): Promise<string> {
  const { raw, message } = await readErrorBody(res);
  const text = message || `${fallback}（${res.status}）`;
  return hintBase ? withRouteHint(hintBase, res.status, raw, text) : text;
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
    source: r.source,
    backend: r.backend ?? null,
    providerId: r.providerId ?? null,
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
    videoPath: r.videoPath,
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
  source?: MediaSource;
  backend?: VideoGenBackend | null;
  providerId?: string | null;
  comfyBase?: string | null;
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
      source: data.source ?? "manual",
      backend: data.backend ?? null,
      providerId: data.providerId ?? null,
      comfyBase: data.comfyBase ?? null,
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
// 提交：MiniMax（官方 v1 接口）
// ---------------------------------------------------------------------------

/**
 * MiniMax 生视频走官方公开接口（v1）：
 *
 *   POST {root}/v1/video_generation                  提交（model + prompt + 可选首帧图）
 *   GET  {root}/v1/query/video_generation?task_id=…  查状态（Queueing/Preparing/Processing/Success/Fail）
 *   GET  {root}/v1/files/retrieve?file_id=…          取成片下载地址（file.download_url）
 *
 * 两个真踩过的坑，都写在这里，别再退回去：
 *
 * 1. **业务错误走 HTTP 200 + base_resp.status_code**（1004 鉴权 / 1002 限流 / 2013 参数）。
 *    只看 `res.ok` 会把失败当成功；反过来，网关与中转站可能把任意路径兜底成
 *    **200 + HTML 首页**，那时连 JSON 都不是。
 * 2. 老实现用的是 `/v2/video_generation` + `content[]` 请求体（那是 OmniLabs 的私有约定，
 *    抄的 Seedance 形状），MiniMax 官方要的是 `prompt` 字符串 —— 路径与请求体都不对，
 *    所以"提交成功过"也只可能是撞上了某台兼容服务。v2 形状这里保留成兜底，
 *    但**默认走官方 v1**。
 */

/** 请求形状：官方 v1（prompt）与 OmniLabs 那套 v2 私约（content 数组）。 */
type MinimaxFlavor = "v1" | "v2";

/** 提交时用了哪套形状（按 task_id 记）：两套的查询路径不同，轮询跟着用同一套。 */
const minimaxFlavors = new Map<string, MinimaxFlavor>();

/** Hailuo 系模型只认 6 / 10 秒：取最接近的合法档位（等距时取长的那档）。 */
export function nearestMinimaxDuration(seconds: number | undefined): number {
  const want = Math.round(seconds ?? MINIMAX_DURATIONS[0]!);
  return MINIMAX_DURATIONS.reduce(
    (best, cur) => (Math.abs(cur - want) <= Math.abs(best - want) ? cur : best),
    MINIMAX_DURATIONS[0]!,
  );
}

/** 只有 Hailuo 系模型吃 duration / resolution；T2V-01 / I2V-01 那代没有这两个参数。 */
function minimaxTakesQualityParams(model: string): boolean {
  return /hailuo/i.test(model);
}

/** 提交用的请求头（v1 / v2 一样）。 */
function minimaxHeaders(key: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
  };
}

/**
 * 解析 MiniMax 的响应体：把「HTTP 200 但 base_resp.status_code ≠ 0」这种业务错误
 * 提出来，也拦下"返回的是网页"这种连 JSON 都不是的情况。
 */
function parseMinimaxJson(raw: string): {
  json: Record<string, unknown> | null;
  error: string | null;
  /** base_resp.status_code（业务码）；没有就是 null。 */
  code: number | null;
} {
  const text = raw.trim();
  if (!text) return { json: null, error: "上游返回了空响应", code: null };
  if (!looksLikeJson(text)) {
    return {
      json: null,
      code: null,
      error:
        "上游返回的是网页（HTML）而不是接口响应 —— 这个地址多半是网站首页或中转站，" +
        "不支持 MiniMax 视频接口，请到「设置 → 模型云服务」换一个厂商",
    };
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { json: null, code: null, error: `上游响应不是合法 JSON：${text.slice(0, 120)}` };
  }
  const baseResp = json.base_resp as { status_code?: unknown; status_msg?: unknown } | undefined;
  const code = baseResp?.status_code;
  if (typeof code === "number" && code !== 0) {
    const message = String(baseResp?.status_msg ?? "").trim() || "上游返回错误";
    const hint =
      code === 1004
        ? "（API Key 被上游拒绝，去「设置 → 模型云服务」检查）"
        : code === 1002
          ? "（上游限流，稍后重试）"
          : code === 2013
            ? "（参数或模型名不对：MiniMax 只认 MiniMax-Hailuo-2.3 / MiniMax-Hailuo-02 / T2V-01 这类模型 id）"
            : "";
    return { json, code, error: `${code} ${message}${hint}` };
  }
  return { json, error: null, code: null };
}

/** 从响应里取 task_id（v1 顶层 / v2 可能在 data 里）。 */
function minimaxTaskId(json: Record<string, unknown> | null): string {
  const direct = json?.task_id;
  if (typeof direct === "string" && direct) return direct;
  const nested = (json?.data as { task_id?: unknown } | undefined)?.task_id;
  return typeof nested === "string" ? nested : "";
}

/** 官方 v1 提交。返回 task_id；路由不存在时返回 null（交给 v2 兜底）。 */
async function submitMinimaxV1(
  target: CloudVideoTarget,
  params: SubmitVideoParams,
  model: string,
  root: string,
): Promise<string | null> {
  const firstFrame = params.firstFrameRef ? await firstFrameDataUrl(params.firstFrameRef) : null;
  const body: Record<string, unknown> = { model, prompt: params.prompt };
  if (firstFrame) body.first_frame_image = firstFrame;
  if (minimaxTakesQualityParams(model)) {
    body.duration = nearestMinimaxDuration(params.duration);
    if (params.resolution) body.resolution = params.resolution;
  }

  const res = await fetch(`${root}/v1/video_generation`, {
    method: "POST",
    headers: minimaxHeaders(target.key),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const { raw, message } = await readErrorBody(res);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(withRouteHint(root, res.status, raw, message) || `提交 MiniMax 生成任务失败（${res.status}）`);

  const parsed = parseMinimaxJson(raw);
  if (parsed.error) throw new Error(parsed.error);
  const taskId = minimaxTaskId(parsed.json);
  if (!taskId) throw new Error(`MiniMax 未返回 task_id：${raw.slice(0, 200) || "（空响应）"}`);
  minimaxFlavors.set(taskId, "v1");
  return taskId;
}

/**
 * OmniLabs 那套 v2 私约的兜底提交（`/v2/video_generation` + `content` 数组）。
 * 只在官方 v1 路由不存在时用：自部署 / 兼容服务可能只实现了这一套。
 */
async function submitMinimaxV2Compat(
  target: CloudVideoTarget,
  params: SubmitVideoParams,
  model: string,
  root: string,
): Promise<string | null> {
  const content: Record<string, unknown>[] = [{ type: "text", text: params.prompt }];
  if (params.firstFrameRef) {
    const dataUrl = await firstFrameDataUrl(params.firstFrameRef);
    if (dataUrl) content.push({ type: "image_url", image_url: dataUrl });
  }
  const body: Record<string, unknown> = {
    model,
    content,
    duration: nearestMinimaxDuration(params.duration),
    aigc_watermark: params.watermark ?? false,
  };
  if (params.ratio) body.ratio = params.ratio;
  if (params.resolution) body.resolution = params.resolution;

  const res = await fetch(`${root}/v2/video_generation`, {
    method: "POST",
    headers: minimaxHeaders(target.key),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const { raw, message } = await readErrorBody(res);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(withRouteHint(root, res.status, raw, message) || `提交 MiniMax 生成任务失败（${res.status}）`);

  const parsed = parseMinimaxJson(raw);
  if (parsed.error) throw new Error(parsed.error);
  const taskId = minimaxTaskId(parsed.json);
  if (!taskId) throw new Error(`MiniMax 未返回 task_id：${raw.slice(0, 200) || "（空响应）"}`);
  minimaxFlavors.set(taskId, "v2");
  return taskId;
}

async function submitMinimax(
  target: CloudVideoTarget,
  params: SubmitVideoParams,
  fallbackModel: string,
): Promise<string> {
  const root = normalizeApiBase(target.base, "");
  if (!root) throw new Error("请先配置 MiniMax 服务地址");
  const model = params.model?.trim() || fallbackModel || MINIMAX_VIDEO_MODELS[0]!;

  const taskId = await submitMinimaxV1(target, params, model, root);
  if (taskId) return taskId;
  const legacy = await submitMinimaxV2Compat(target, params, model, root);
  if (legacy) return legacy;
  // 两套路径都不存在：这地址不是 MiniMax 视频服务（中转站/首页都会这样）
  throw new Error(
    `上游没有 MiniMax 视频接口：/v1/video_generation 与 /v2/video_generation 都不存在（当前 API 地址 ${root}）。` +
      `请到「设置 → 模型云服务」确认该厂商的地址是 MiniMax 官方（https://api.minimaxi.com 或 https://api.minimax.chat，不带 /v1）`,
  );
}

// ---------------------------------------------------------------------------
// 提交：Seedance（火山方舟）
// ---------------------------------------------------------------------------

async function submitSeedance(
  target: CloudVideoTarget,
  params: SubmitVideoParams,
  fallbackModel: string,
): Promise<string> {
  const base = normalizeApiBase(target.base, "/api/v3");
  if (!base) throw new Error("请先配置 Seedance（火山方舟）服务地址");
  const model = params.model?.trim() || fallbackModel || SEEDANCE_VIDEO_MODELS[0]!;

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
      ...(target.key ? { Authorization: `Bearer ${target.key}` } : {}),
    },
    body: JSON.stringify({ model, content }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(await errorMessage(res, "提交 Seedance 生成任务失败", base));
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
): Promise<{
  promptId: string;
  width: number;
  height: number;
  frames: number;
  seed: number;
  /** 实际用的 checkpoint（没填时会自动探一个），用量记录要的是它。 */
  checkpoint: string;
  /** 实际提交到的地址（去掉尾部斜杠）：轮询必须问同一台服务器。 */
  base: string;
}> {
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
  return {
    promptId: json.prompt_id,
    width: size.width,
    height: size.height,
    frames,
    seed,
    checkpoint,
    base,
  };
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
    backend: params.config?.backend ?? dbCfg.backend,
    providerId:
      params.config?.providerId !== undefined
        ? params.config.providerId.trim()
        : dbCfg.providerId,
    model: params.config?.model !== undefined ? params.config.model.trim() : dbCfg.model,
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
    source: params.source ?? "manual",
    backend: cfg.backend,
    providerId: cfg.backend === "cloud" ? cfg.providerId || null : null,
    model: params.model?.trim() || cfg.model || null,
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
        // 记下"提交到哪台 ComfyUI"：轮询按它查，用户中途改地址不会让在途任务查错服务器
        // （改地址后 404 会被当成"还在队列"，一路空转到 30 分钟超时）。
        comfyBase: submitted.base,
        taskId: submitted.promptId,
        width: submitted.width,
        height: submitted.height,
        duration: Math.round((submitted.frames - 1) / 16),
        seed: submitted.seed,
        steps: params.steps ?? 20,
      });
      // 生视频按秒 / 次计费，没有 token 口径，记一行只为了让统计页看得到
      // "用了几次"，模型名是 ComfyUI 的 checkpoint（用户认的就是它）。
      recordVideoUsage("local", "ComfyUI", submitted.checkpoint);
      return { record: toRow(record) };
    }

    // 云端：厂商决定接口协议（MiniMax / Seedance），地址与密钥同样来自厂商行。
    const target = resolveCloudTarget(cfg.providerId);
    // MiniMax 只认 6 / 10 秒：库里记的时长要与真正发出去的一致，
    // 否则卡片上写着 5s、上游生成的是 6s。
    if (target.videoApi === "minimax") common.duration = nearestMinimaxDuration(params.duration);
    const taskId =
      target.videoApi === "seedance"
        ? await submitSeedance(target, params, cfg.model)
        : await submitMinimax(target, params, cfg.model);
    recordVideoUsage(
      "cloud",
      target.providerName,
      common.model ?? (target.videoApi === "seedance" ? SEEDANCE_VIDEO_MODELS[0]! : MINIMAX_VIDEO_MODELS[0]!),
    );
    const record = insertVideoRecord({ ...common, taskId });
    return { record: toRow(record) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const target = cfg.backend === "cloud" ? providerTargetForLog(cfg.providerId) : null;
    logEvent({
      level: "error",
      source: "video",
      event: "video.submit.failed",
      message,
      detail: {
        backend: cfg.backend,
        providerId: cfg.providerId || null,
        model: (cfg.backend === "comfyui" ? cfg.comfyCkpt : cfg.model) || null,
        base: cfg.comfyBase || target?.base || null,
        hasApiKey: target?.hasApiKey ?? false,
        prompt: (params.prompt ?? "").slice(0, 300),
        firstFrame: params.firstFrameRef ?? null,
        error: e,
      },
    });
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

/**
 * 一轮轮询撞上的上游失败。`fatal` 表示重试也不会好（鉴权被拒 / 接口地址不对），
 * 调用方应当立刻把记录标失败，而不是 5 秒一次地白问到超时。
 */
type PollFailure = {
  fatal: boolean;
  message: string;
  status?: number;
};

type PollResult = {
  done: boolean;
  failed?: string;
  videoUrl?: string;
  progress?: number | null;
  /** 本轮查询失败但任务可能还在跑：保留 processing，下轮再查（同时让界面与日志看得见）。 */
  pollFailure?: PollFailure;
};

/**
 * 上游 HTTP 错误 → 能不能靠重试解决。
 *
 * 401/403 是鉴权被上游拒绝：每 5 秒重试一次不会变好，只会把真实原因埋掉 ——
 * 真踩过：MiniMax 返回 `1004 login fail`，应用一路当成"还在生成"，任务挂到
 * 30 分钟超时才被标记失败，日志里一个字都没有，排查只能靠猜。
 */
function classifyPollStatus(status: number, message: string): PollFailure {
  if (status === 401 || status === 403) {
    return {
      fatal: true,
      status,
      message: `上游鉴权失败（${status}）：${message || "API Key 被拒绝"} —— 请到「设置 → 模型云服务」检查该厂商的 API Key`,
    };
  }
  if (status >= 500) {
    return {
      fatal: false,
      status,
      message: `上游服务异常（${status}），正在自动重试${message ? `：${message}` : ""}`,
    };
  }
  return {
    fatal: false,
    status,
    message: `上游返回 ${status}${message ? `：${message}` : ""}`,
  };
}

/**
 * 轮询撞上 404 的两种面貌，处理方式相反：正文是 JSON 的，是上游在说「任务没了」——
 * 终态；正文是纯文本的（`404 page not found`），是网关 / 路由没这个路径，地址填错了 ——
 * 那是配置问题，用户改好地址还能接着把任务查回来，所以走致命失败那条路（宽限后判死）。
 */
function classifyPoll404(base: string, raw: string, message: string): PollResult {
  if (looksLikeJson(raw)) return { done: true, failed: "上游任务不存在或已过期" };
  return {
    done: false,
    pollFailure: {
      fatal: true,
      status: 404,
      message: `${message || "404 page not found"}：上游没有这个接口路径（当前 API 地址 ${base}），请到「设置 → 模型云服务」检查该厂商的地址`,
    },
  };
}

/** Success 后取成片地址：MiniMax 的查询只给 file_id，要再查一次 /files/retrieve 拿 download_url。 */
async function minimaxFileUrl(root: string, key: string, fileId: string): Promise<string> {
  const res = await fetch(`${root}/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(30_000),
  });
  const { raw, message } = await readErrorBody(res);
  if (!res.ok) {
    throw new Error(withRouteHint(root, res.status, raw, message) || `取成片地址失败（${res.status}）`);
  }
  const parsed = parseMinimaxJson(raw);
  if (parsed.error) throw new Error(parsed.error);
  const file = parsed.json?.file as { download_url?: unknown } | undefined;
  const url = file?.download_url;
  if (typeof url !== "string" || !url) throw new Error(`上游未返回成片下载地址（file_id=${fileId}）`);
  return url;
}

/** 成片地址在各家响应里的位置不一，按可能性逐个试。 */
function minimaxVideoUrl(json: Record<string, unknown> | null): string {
  if (!json) return "";
  const content = json.content as { url?: unknown; video_url?: unknown } | undefined;
  const candidates = [
    content?.url,
    content?.video_url,
    json.video_url,
    json.video,
    json.output,
    json.file_url,
    json.url,
  ];
  for (const c of candidates) if (typeof c === "string" && c) return c;
  return "";
}

/** 成片 file_id 的位置同样各家不一。 */
function minimaxFileId(json: Record<string, unknown> | null): string {
  if (!json) return "";
  const file = json.file as { name?: unknown; file_id?: unknown } | undefined;
  for (const c of [json.file_id, file?.file_id, file?.name]) {
    if (typeof c === "string" && c) return c;
  }
  return "";
}

/** 按指定形状查一次任务；`routeMissing` 表示这个地址根本没有那套查询路径。 */
async function pollMinimaxFlavor(
  target: CloudVideoTarget,
  taskId: string,
  flavor: MinimaxFlavor,
  root: string,
): Promise<{ routeMissing: boolean; result: PollResult }> {
  const endpoint =
    flavor === "v2"
      ? `${root}/v2/query/video_generation/${encodeURIComponent(taskId)}`
      : `${root}/v1/query/video_generation?task_id=${encodeURIComponent(taskId)}`;
  const res = await fetch(endpoint, {
    headers: target.key ? { Authorization: `Bearer ${target.key}` } : {},
    signal: AbortSignal.timeout(30_000),
  });
  const { raw, message } = await readErrorBody(res);
  if (res.status === 404) {
    // 纯文本 404 = 路由不存在（换另一套形状还有救）；JSON 404 = 上游说任务没了（终态）
    if (!looksLikeJson(raw)) return { routeMissing: true, result: { done: false } };
    return { routeMissing: false, result: { done: true, failed: "上游任务不存在或已过期" } };
  }
  if (!res.ok) {
    // 网络抖动 / 5xx 下轮再查；鉴权被拒交给上层判死（不再静默 done:false）
    return {
      routeMissing: false,
      result: { done: false, pollFailure: classifyPollStatus(res.status, message) },
    };
  }

  const parsed = parseMinimaxJson(raw);
  if (parsed.error) {
    // 业务码走 HTTP 200：1004 这类鉴权失败跟 HTTP 401 同等对待，其余按可重试处理
    const fatal = parsed.code === 1004 || parsed.code === 1005 || parsed.code === 1006;
    return { routeMissing: false, result: { done: false, pollFailure: { fatal, message: parsed.error } } };
  }

  const json = parsed.json;
  const status = typeof json?.status === "string" ? json.status : "";
  if (MINIMAX_FAILED.has(status)) {
    const reason = [json?.fail_reason, json?.error, json?.message].find(
      (v): v is string => typeof v === "string" && v.trim() !== "",
    );
    return { routeMissing: false, result: { done: true, failed: reason ?? "生成失败" } };
  }
  if (!MINIMAX_DONE.has(status)) {
    const progress = normalizeProgress((json as { progress?: unknown } | null)?.progress);
    return { routeMissing: false, result: { done: false, progress } };
  }

  // Success：先看响应里有没有直接给地址；MiniMax 官方只给 file_id，再查一次取下载地址
  let url = minimaxVideoUrl(json);
  if (!url) {
    const fileId = minimaxFileId(json);
    if (fileId) url = await minimaxFileUrl(root, target.key, fileId);
  }
  if (!url) {
    return {
      routeMissing: false,
      result: { done: true, failed: "上游未返回成片地址（既没有下载地址也没有 file_id）" },
    };
  }
  const absolute = /^https?:\/\//i.test(url) ? url : new URL(url, `${root}/`).toString();
  return { routeMissing: false, result: { done: true, videoUrl: absolute } };
}

async function pollMinimax(target: CloudVideoTarget, taskId: string): Promise<PollResult> {
  const root = normalizeApiBase(target.base, "");
  if (!root) return { done: true, failed: "该厂商还没填 API 地址，请到「设置 → 模型云服务」补上" };

  const remembered = minimaxFlavors.get(taskId) ?? "v1";
  const first = await pollMinimaxFlavor(target, taskId, remembered, root);
  if (!first.routeMissing) return first.result;

  // 这个地址没有那套查询路径：换另一套形状再试一次（自部署 / 兼容服务常只实现一套）
  const other: MinimaxFlavor = remembered === "v1" ? "v2" : "v1";
  const second = await pollMinimaxFlavor(target, taskId, other, root);
  if (!second.routeMissing) {
    minimaxFlavors.set(taskId, other);
    return second.result;
  }
  // 两套都不存在：地址不对（配置问题，宽限期内改好还能接着查）
  return {
    done: false,
    pollFailure: {
      fatal: true,
      status: 404,
      message: `上游没有 MiniMax 的任务查询接口（当前 API 地址 ${root}）：/v1/query/video_generation 与 /v2/query/video_generation 都不存在，请到「设置 → 模型云服务」检查该厂商的地址`,
    },
  };
}

async function pollSeedance(target: CloudVideoTarget, taskId: string): Promise<PollResult> {
  const base = normalizeApiBase(target.base, "/api/v3");
  if (!base) return { done: true, failed: "该厂商还没填 API 地址，请到「设置 → 模型云服务」补上" };
  const res = await fetch(`${base}/contents/generations/tasks/${taskId}`, {
    headers: target.key ? { Authorization: `Bearer ${target.key}` } : {},
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404) {
    const { raw, message } = await readErrorBody(res);
    return classifyPoll404(base, raw, message);
  }
  if (!res.ok) {
    const { message } = await readErrorBody(res);
    return { done: false, pollFailure: classifyPollStatus(res.status, message) };
  }
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

/**
 * 在途 ComfyUI 任务该问哪台服务器。
 *
 * 记在记录上的地址优先（提交时那台）；只有旧记录（这列还没有值）才回落到当前配置，
 * 并留一条 warn —— 回落是"可能问错服务器"的状态，日志里要看得见。
 */
function comfyBaseForRow(row: RecordRow, cfg: VideoGenConfig): string {
  const recorded = (row.comfyBase ?? "").trim();
  if (recorded) return recorded;
  logEvent({
    level: "warn",
    source: "video",
    event: "video.poll.comfy_base_missing",
    message: "这条 ComfyUI 任务没有记录提交地址，按当前配置查询",
    detail: { id: row.id, taskId: row.taskId, currentBase: cfg.comfyBase || null },
  });
  return cfg.comfyBase;
}

async function pollComfy(base: string, promptId: string): Promise<PollResult> {  const cleanBase = base.trim().replace(/\/+$/, "");
  if (!cleanBase) return { done: true, failed: "这条任务没有记录 ComfyUI 地址，无法继续查询" };
  const res = await fetch(`${cleanBase}/history/${promptId}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return { done: false }; // 还在队列里
  if (!res.ok) {
    const { message } = await readErrorBody(res);
    return {
      done: false,
      pollFailure: {
        fatal: false,
        status: res.status,
        message: `ComfyUI 返回 ${res.status}${message ? `：${message}` : ""}`,
      },
    };
  }
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

/**
 * 连续轮询失败的状态（按记录 id）：日志节流 + 致命失败的宽限计时 + 超时文案里带上最后原因。
 *
 * 内存态足够：它只影响"多快把问题摆到眼前"，不影响任务本身（任务在 DB 里）。
 */
const pollFailures = new Map<
  number,
  { fails: number; lastMessage: string; lastLogAt: number; fatalSince: number | null }
>();

/** 连续失败到这个次数（前端 5s 一轮，约 2 分钟）把日志升到 error —— 一直 warn 会被当噪声忽略。 */
const POLL_FAIL_ESCALATE = 24;

/** 同一条记录的轮询失败日志最多每分钟一条：不节流会被每 5 秒一次的轮询刷满。 */
const POLL_FAIL_LOG_INTERVAL_MS = 60_000;

/**
 * 致命失败（鉴权被拒 / 地址填错）的宽限期：重试确实不会好，但也不宜第一枪就判死 ——
 * 云端任务已经提交并计费，用户趁这会儿去设置里把 Key / 地址改对，还能接着把成片取回来。
 * 期间记录保持 processing、原因透在界面上；超过宽限期仍失败才标失败。
 */
const FATAL_POLL_GRACE_MS = 3 * 60_000;

/**
 * 记一次轮询失败：计数 + 节流日志（首次必然记，之后每分钟一条），并维护致命失败的计时。
 * 返回更新后的状态，调用方据此决定"还等不等"。
 */
function notePollFailure(
  row: { id: number; backend: string | null; taskId: string | null },
  providerId: string,
  fail: PollFailure,
): { fails: number; fatalSince: number | null } {
  const now = Date.now();
  const prev = pollFailures.get(row.id);
  const fails = (prev?.fails ?? 0) + 1;
  const lastLogAt = prev?.lastLogAt ?? 0;
  // 非致命失败清掉致命计时：401 中间夹了一次 5xx，不该把宽限期接着算下去。
  const fatalSince = fail.fatal ? (prev?.fatalSince ?? now) : null;
  const shouldLog = fails === 1 || now - lastLogAt >= POLL_FAIL_LOG_INTERVAL_MS;
  pollFailures.set(row.id, {
    fails,
    lastMessage: fail.message,
    lastLogAt: shouldLog ? now : lastLogAt,
    fatalSince,
  });
  if (!shouldLog) return { fails, fatalSince };
  logEvent({
    // 致命失败第一枪就记 error：它要用户去改设置，混在 warn 里会被忽略
    level: fail.fatal || fails >= POLL_FAIL_ESCALATE ? "error" : "warn",
    source: "video",
    event: "video.poll.http",
    message: fail.message,
    detail: {
      id: row.id,
      backend: row.backend,
      providerId: providerId || null,
      taskId: row.taskId,
      status: fail.status ?? null,
      fails,
      fatal: fail.fatal,
    },
  });
  return { fails, fatalSince };
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
      pollFailures.delete(row.id);
      out.push(toRow(row));
      continue;
    }

    // 轮询按**记录里的厂商**去查：用户中途换了厂商也要把之前提交的任务查完。
    // 升级前提交的记录没有 providerId（那一列是新加的），它的 backend 就是当时的
    // 协议名；迁移把同一套地址 + 密钥搬成了当前选中的厂商行，所以这些在途任务
    // 还能查回上游 —— 不兜底就会被误判成「厂商已删除」。
    const legacyCloud = row.backend === "minimax" || row.backend === "seedance";
    const providerId = row.providerId ?? (legacyCloud ? cfg.providerId : "");

    // 兜底超时：上游一直不回来就标记失败，避免永远「生成中」。
    // 带上最后一次查询失败的原因 —— 否则用户只看到"超时"，排查还得自己翻日志。
    if (Date.now() - (row.createdAt ?? 0) > STALE_MS) {
      const last = pollFailures.get(row.id)?.lastMessage;
      pollFailures.delete(row.id);
      const updated = updateVideoRecord(row.id, {
        status: "failed",
        error: last
          ? `生成超时（超过 30 分钟）；最后一次查询失败：${last}`
          : "生成超时（超过 30 分钟），可重试或检查服务状态",
      });
      logEvent({
        level: "error",
        source: "video",
        event: "video.poll.timeout",
        message: "视频生成超时（超过 30 分钟）",
        detail: {
          id: row.id,
          backend: row.backend,
          providerId: providerId || null,
          taskId: row.taskId,
          lastPollError: last ?? null,
          prompt: row.prompt?.slice(0, 200),
        },
      });
      out.push(toRow(updated));
      continue;
    }

    try {
      // 厂商行被删 / 没配协议这类配置问题：resolveCloudTarget 会抛，抛出去会被当成
      // "瞬时错误"每 5 秒重试到超时 —— 它是配置问题，重试不会有结果，直接失败。
      let cloudTarget: CloudVideoTarget | null = null;
      let setupError: string | null = null;
      if (row.backend !== "comfyui" && providerId) {
        try {
          cloudTarget = resolveCloudTarget(providerId);
        } catch (e) {
          setupError = e instanceof Error ? e.message : String(e);
        }
      }
      const result: PollResult = setupError
        ? { done: true, failed: `无法继续查询上游状态：${setupError}` }
        : !row.taskId
          ? { done: true, failed: "缺少上游任务 id" }
          : cloudTarget?.videoApi === "seedance"
            ? await pollSeedance(cloudTarget, row.taskId)
            : cloudTarget?.videoApi === "minimax"
              ? await pollMinimax(cloudTarget, row.taskId)
              : row.backend === "comfyui"
                ? await pollComfy(comfyBaseForRow(row, cfg), row.taskId)
                : { done: true, failed: "这条任务的厂商已删除，无法继续查询上游状态" };

      if (!result.done) {
        const fail = result.pollFailure;
        const state = fail ? notePollFailure(row, providerId, fail) : null;
        // 致命失败（鉴权被拒 / 地址填错）留一段宽限期：期间保留 processing、原因透在
        // 界面上，让人有机会改好设置再把成片取回来；过了宽限期才判死。
        if (
          fail?.fatal &&
          state?.fatalSince &&
          Date.now() - state.fatalSince >= FATAL_POLL_GRACE_MS
        ) {
          pollFailures.delete(row.id);
          const updated = updateVideoRecord(row.id, { status: "failed", error: fail.message });
          logEvent({
            level: "error",
            source: "video",
            event: "video.poll.failed",
            message: fail.message,
            detail: {
              id: row.id,
              backend: row.backend,
              providerId: providerId || null,
              taskId: row.taskId,
              status: fail.status ?? null,
            },
          });
          out.push(toRow(updated));
          continue;
        }
        out.push(toRow(row, result.progress ?? null, fail?.message ?? null));
        continue;
      }
      if (result.failed) {
        pollFailures.delete(row.id);
        const updated = updateVideoRecord(row.id, { status: "failed", error: result.failed });
        logEvent({
          level: "error",
          source: "video",
          event: "video.poll.failed",
          message: result.failed,
          detail: { id: row.id, backend: row.backend, taskId: row.taskId },
        });
        out.push(toRow(updated));
        continue;
      }
      // 下载成片并落盘（文件名沿用上游，扩展名白名单校验）。
      const name = result.videoUrl!.split("?")[0]!.split("/").pop() ?? "video.mp4";
      const ref = await downloadToRef(result.videoUrl!, name);
      pollFailures.delete(row.id);
      const updated = updateVideoRecord(row.id, { status: "done", videoPath: ref });
      out.push(toRow(updated));
    } catch (e) {
      // 下载失败 / 网络异常这类瞬时错误：保留 processing，下一轮重试（超时兜底在上面）。
      // 走 notePollFailure 而不是直接落 debug：首次失败要看得见，重复失败按分钟节流
      // （前端每 5 秒轮询一次，不节流会把日志刷满）。
      const message = e instanceof Error ? e.message : String(e);
      notePollFailure(row, providerId, { fatal: false, message });
      out.push(toRow(row, null, message));
    }
  }
  return out;
}
