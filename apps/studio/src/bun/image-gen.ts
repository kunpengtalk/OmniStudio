import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { desc, eq } from "drizzle-orm";

import { db } from "./db";
import { imageRecords } from "./db/schema";
import { getSetting, updateSettings } from "./db/settings";
import { getImagesBaseDir } from "./image-server";
import { chatImageUrl } from "../shared/server-info";
import * as MlxGen from "./mlx-gen";
import { findMlxModel } from "./mlx-gen";

/**
 * AI 生图模块。
 *
 * 支持三种推理后端（与语音页一样在页面顶部切换）：
 *
 * 1. **MLX（本地，Apple Silicon）**：基于 mflux 引擎（FLUX.1 / FLUX.2 /
 *    Z-Image 等模型的 MLX 原生实现），完全离线生成，见 ./mlx-gen.ts。
 *
 * 2. **OpenAI 兼容 API**（Diffusers）：直连任意的 OpenAI 兼容
 *    `/v1/images/generations` 服务（本地 diffusers / sd-webui wrapper /
 *    云端 API 等），返回 b64_json 或 url。
 *
 * 3. **ComfyUI**：直接对接 ComfyUI HTTP API —— 提交标准文生图工作流
 *    （CheckpointLoaderSimple → KSampler → VAEDecode → SaveImage），
 *    轮询 /history 直到出图，再从 /view 下载图片。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type ImageGenBackend = "mlx" | "api" | "comfyui";

export type ImageRecordRow = {
  id: number;
  status: "done" | "failed";
  backend: ImageGenBackend | null;
  model: string | null;
  prompt: string | null;
  negativePrompt: string | null;
  width: number | null;
  height: number | null;
  seed: number | null;
  steps: number | null;
  imageUrl: string | null;
  error: string | null;
  createdAt: number;
};

export type ImageGenConfig = {
  backend: ImageGenBackend;
  apiBase: string;
  apiKey: string;
  model: string;
  comfyBase: string;
};

export type GenerateImageParams = {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  count?: number;
  seed?: number;
  steps?: number;
  model?: string;
  /** MLX 后端：加载时量化位数（3/4/5/6/8），0 表示不量化。 */
  quantize?: number;
  /** 前端当前页面的实时配置。若提供则优先使用（避免读取到未保存的旧配置），并顺带落盘。 */
  config?: Partial<ImageGenConfig>;
};

type RecordRow = typeof imageRecords.$inferSelect;

// ---------------------------------------------------------------------------
// 配置（存 settings 表）
// ---------------------------------------------------------------------------

export function getImageGenConfig(): ImageGenConfig {
  const backend = getSetting("IMG_BACKEND");
  return {
    backend: backend === "comfyui" || backend === "mlx" ? backend : "api",
    apiBase: (getSetting("IMG_API_BASE") || "").trim(),
    apiKey: (getSetting("IMG_API_KEY") || "").trim(),
    model: (getSetting("IMG_MODEL") || "").trim(),
    comfyBase: (getSetting("IMG_COMFY_BASE") || "").trim(),
  };
}

export function saveImageGenConfig(cfg: Partial<ImageGenConfig>): void {
  const settings: Record<string, string> = {};
  if (cfg.backend !== undefined) settings.IMG_BACKEND = cfg.backend;
  if (cfg.apiBase !== undefined) settings.IMG_API_BASE = cfg.apiBase.trim();
  if (cfg.apiKey !== undefined) settings.IMG_API_KEY = cfg.apiKey.trim();
  if (cfg.model !== undefined) settings.IMG_MODEL = cfg.model.trim();
  if (cfg.comfyBase !== undefined) settings.IMG_COMFY_BASE = cfg.comfyBase.trim();
  updateSettings(settings);
}

/** 把用户填的地址规整成带 /v1 后缀的形式（兼容填不填 /v1 两种写法）。 */
function normalizeApiBase(base: string): string {
  let b = base.trim().replace(/\/+$/, "");
  if (b && !/\/v1$/i.test(b)) b = `${b}/v1`;
  return b;
}

function normalizeComfyBase(base: string): string {
  return base.trim().replace(/\/+$/, "");
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = await res.text().catch(() => "");
  if (body) {
    try {
      return JSON.parse(body)?.error?.message ?? body.slice(0, 300);
    } catch {
      return body.slice(0, 300);
    }
  }
  return `${fallback} (${res.status})`;
}

// ---------------------------------------------------------------------------
// 模型列表
// ---------------------------------------------------------------------------

/** 从 OpenAI 兼容 /v1/models 拉取可用模型列表。 */
export async function listImageApiModels(
  base: string,
  apiKey: string,
): Promise<string[]> {
  const cleanBase = normalizeApiBase(base);
  if (!cleanBase) throw new Error("Missing API base URL");
  const res = await fetch(`${cleanBase}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`请求失败（${res.status}）`);
  const json = (await res.json().catch(() => null)) as { data?: { id?: string }[] } | null;
  const data = json?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** 从 ComfyUI /object_info 拉取可用 checkpoint 列表。 */
export async function listComfyCheckpoints(base: string): Promise<string[]> {
  const cleanBase = normalizeComfyBase(base);
  if (!cleanBase) throw new Error("Missing ComfyUI base URL");
  const res = await fetch(`${cleanBase}/object_info/CheckpointLoaderSimple`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`请求失败（${res.status}）`);
  const json = (await res.json().catch(() => null)) as
    | { CheckpointLoaderSimple?: { input?: { required?: { ckpt_name?: [string[]] } } } }
    | null;
  const names = json?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
  return Array.isArray(names) ? names.filter((n): n is string => typeof n === "string") : [];
}

// ---------------------------------------------------------------------------
// 记录
// ---------------------------------------------------------------------------

function toRow(r: RecordRow): ImageRecordRow {
  return {
    id: r.id,
    status: r.status,
    backend: r.backend ?? null,
    model: r.model,
    prompt: r.prompt,
    negativePrompt: r.negativePrompt,
    width: r.width,
    height: r.height,
    seed: r.seed,
    steps: r.steps,
    imageUrl: r.imagePath ? chatImageUrl(r.imagePath) : null,
    error: r.error,
    createdAt: r.createdAt ?? 0,
  };
}

export function listImageRecords(limit = 100): ImageRecordRow[] {
  const rows = db
    .select()
    .from(imageRecords)
    .orderBy(desc(imageRecords.id))
    .limit(Math.min(limit, 500))
    .all();
  return rows.map(toRow);
}

export function deleteImageRecord(id: number): { ok: boolean } {
  const [row] = db.select().from(imageRecords).where(eq(imageRecords.id, id)).limit(1).all();
  if (!row) return { ok: false };
  db.delete(imageRecords).where(eq(imageRecords.id, id)).run();
  // 顺带清理磁盘上的图片文件（ref 是相对 images 根目录的路径）。
  if (row.imagePath) {
    const base = getImagesBaseDir();
    const resolved = path.resolve(base, row.imagePath);
    if (resolved.startsWith(base + path.sep) && existsSync(resolved)) {
      try {
        unlinkSync(resolved);
      } catch {}
    }
  }
  return { ok: true };
}

function insertImageRecord(data: {
  status?: "done" | "failed";
  backend?: ImageGenBackend | null;
  model?: string | null;
  prompt?: string | null;
  negativePrompt?: string | null;
  width?: number | null;
  height?: number | null;
  seed?: number | null;
  steps?: number | null;
  imagePath?: string | null;
  error?: string | null;
}): RecordRow {
  return db
    .insert(imageRecords)
    .values({
      status: data.status ?? "done",
      backend: data.backend ?? null,
      model: data.model ?? null,
      prompt: data.prompt ?? null,
      negativePrompt: data.negativePrompt ?? null,
      width: data.width ?? null,
      height: data.height ?? null,
      seed: data.seed ?? null,
      steps: data.steps ?? null,
      imagePath: data.imagePath ?? null,
      error: data.error ?? null,
    })
    .returning()
    .get();
}

// ---------------------------------------------------------------------------
// 图片落盘（写入 images 根目录下的 gen/ 子目录，由图片服务器对外提供）
// ---------------------------------------------------------------------------

function saveGeneratedImage(data: Uint8Array): string {
  const dir = path.join(getImagesBaseDir(), "gen");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const ref = `gen/${randomUUID()}.png`;
  writeFileSync(path.join(dir, `${path.basename(ref)}`), data);
  return ref;
}

// ---------------------------------------------------------------------------
// 生成：MLX 本地引擎（mflux，Apple Silicon）
// ---------------------------------------------------------------------------

async function generateViaMlx(
  cfg: ImageGenConfig,
  params: GenerateImageParams,
): Promise<string[]> {
  const modelId = params.model?.trim() || cfg.model || MlxGen.MLX_MODELS[0]!.id;
  const model = findMlxModel(modelId);
  if (!model) {
    throw new Error(`未知的 MLX 模型：${modelId}`);
  }

  const dir = path.join(getImagesBaseDir(), "gen");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // mflux 一次生成一张；数量 > 1 时循环多次（不同 seed）。
  const count = Math.max(1, Math.min(params.count ?? 1, 8));
  const refs: string[] = [];
  for (let i = 0; i < count; i++) {
    const ref = `gen/${randomUUID()}.png`;
    const seed = (params.seed ?? 0) > 0 ? params.seed! + i : undefined;
    const result = await MlxGen.generateWithMlx({
      modelId: model.id,
      prompt: params.prompt,
      width: params.width ?? 1024,
      height: params.height ?? 1024,
      steps: params.steps ?? model.defaultSteps,
      seed,
      quantize: params.quantize,
      outputPath: path.join(dir, path.basename(ref)),
    });
    if (!result.ok) throw new Error(result.error ?? "MLX 生成失败");
    refs.push(ref);
  }
  return refs;
}

// ---------------------------------------------------------------------------
// 生成：OpenAI 兼容 API（Diffusers 服务）
// ---------------------------------------------------------------------------

type ApiImageItem = { b64_json?: string; url?: string };

async function generateViaApi(
  cfg: ImageGenConfig,
  params: GenerateImageParams,
): Promise<string[]> {
  const base = normalizeApiBase(cfg.apiBase);
  if (!base) throw new Error("请先在左侧配置 OpenAI 兼容服务的 Base URL");
  const model = params.model?.trim() || cfg.model;
  if (!model) throw new Error("请先填写生图模型 ID");

  const body: Record<string, unknown> = {
    model,
    prompt: params.prompt,
    n: Math.max(1, Math.min(params.count ?? 1, 8)),
    size: `${params.width ?? 1024}x${params.height ?? 1024}`,
    response_format: "b64_json",
  };
  if (params.negativePrompt?.trim()) body.negative_prompt = params.negativePrompt.trim();

  const res = await fetch(`${base}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600_000),
  });
  if (!res.ok) throw new Error(await errorMessage(res, "生图请求失败"));

  const json = (await res.json().catch(() => null)) as { data?: ApiImageItem[] } | null;
  const items = json?.data ?? [];
  if (items.length === 0) throw new Error("服务未返回任何图片");

  const refs: string[] = [];
  for (const item of items) {
    if (item.b64_json) {
      refs.push(saveGeneratedImage(Uint8Array.from(Buffer.from(item.b64_json, "base64"))));
    } else if (item.url) {
      const imgRes = await fetch(item.url, { signal: AbortSignal.timeout(120_000) });
      if (!imgRes.ok) throw new Error(`下载生成图片失败（${imgRes.status}）`);
      refs.push(saveGeneratedImage(new Uint8Array(await imgRes.arrayBuffer())));
    }
  }
  if (refs.length === 0) throw new Error("服务返回的数据无法解析为图片");
  return refs;
}

// ---------------------------------------------------------------------------
// 生成：ComfyUI（标准文生图工作流）
// ---------------------------------------------------------------------------

function buildComfyWorkflow(params: {
  checkpoint: string;
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  steps: number;
  seed: number;
}): Record<string, unknown> {
  return {
    "4": {
      class_type: "CheckpointLoaderSimple",
      _meta: { title: "Load Checkpoint" },
      inputs: { ckpt_name: params.checkpoint },
    },
    "5": {
      class_type: "EmptyLatentImage",
      _meta: { title: "Empty Latent Image" },
      inputs: { width: params.width, height: params.height, batch_size: 1 },
    },
    "6": {
      class_type: "CLIPTextEncode",
      _meta: { title: "Prompt" },
      inputs: { text: params.prompt, clip: ["4", 1] },
    },
    "7": {
      class_type: "CLIPTextEncode",
      _meta: { title: "Negative Prompt" },
      inputs: { text: params.negativePrompt, clip: ["4", 1] },
    },
    "3": {
      class_type: "KSampler",
      _meta: { title: "KSampler" },
      inputs: {
        seed: params.seed,
        steps: params.steps,
        cfg: 7,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
    },
    "8": {
      class_type: "VAEDecode",
      _meta: { title: "VAE Decode" },
      inputs: { samples: ["3", 0], vae: ["4", 2] },
    },
    "9": {
      class_type: "SaveImage",
      _meta: { title: "Save Image" },
      inputs: { filename_prefix: "omnistudio", images: ["8", 0] },
    },
  };
}

async function generateViaComfy(
  cfg: ImageGenConfig,
  params: GenerateImageParams,
): Promise<string[]> {
  const base = normalizeComfyBase(cfg.comfyBase);
  if (!base) throw new Error("请先在左侧配置 ComfyUI 服务地址（如 http://127.0.0.1:8188）");
  const checkpoint = params.model?.trim() || cfg.model;
  if (!checkpoint) throw new Error("请先填写 ComfyUI checkpoint 名称");

  const clientId = randomUUID();
  const seed = params.seed ?? Math.floor(Math.random() * 2 ** 31);
  const workflow = buildComfyWorkflow({
    checkpoint,
    prompt: params.prompt,
    negativePrompt: params.negativePrompt?.trim() || "",
    width: params.width ?? 1024,
    height: params.height ?? 1024,
    steps: params.steps ?? 25,
    seed,
  });

  const submitRes = await fetch(`${base}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!submitRes.ok) throw new Error(await errorMessage(submitRes, "提交 ComfyUI 工作流失败"));
  const submitJson = (await submitRes.json().catch(() => null)) as
    | { prompt_id?: string; error?: unknown }
    | null;
  const promptId = submitJson?.prompt_id;
  if (!promptId) throw new Error("ComfyUI 未返回 prompt_id，请检查服务日志");

  // 轮询 /history/{prompt_id} 直到出图（最多 15 分钟）。
  const deadline = Date.now() + 15 * 60_000;
  let outputs: Record<string, { images?: { filename: string; subfolder: string; type: string }[] }> = {};
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const histRes = await fetch(`${base}/history/${promptId}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!histRes.ok) continue;
    const histJson = (await histRes.json().catch(() => null)) as
      | Record<string, { outputs?: typeof outputs; status?: { completed?: boolean } }>
      | null;
    const entry = histJson?.[promptId];
    if (entry?.outputs && Object.keys(entry.outputs).length > 0) {
      outputs = entry.outputs;
      break;
    }
    if (entry?.status?.completed && entry.outputs) {
      outputs = entry.outputs;
      break;
    }
  }
  if (Object.keys(outputs).length === 0) throw new Error("等待 ComfyUI 出图超时");

  const refs: string[] = [];
  for (const nodeOutput of Object.values(outputs)) {
    for (const img of nodeOutput.images ?? []) {
      if (img.type && img.type !== "output") continue;
      const qs = new URLSearchParams({
        filename: img.filename,
        subfolder: img.subfolder ?? "",
        type: img.type || "output",
      });
      const viewRes = await fetch(`${base}/view?${qs}`, { signal: AbortSignal.timeout(120_000) });
      if (!viewRes.ok) throw new Error(`下载生成图片失败（${viewRes.status}）`);
      refs.push(saveGeneratedImage(new Uint8Array(await viewRes.arrayBuffer())));
    }
  }
  if (refs.length === 0) throw new Error("ComfyUI 输出中未找到图片");
  return refs;
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

export async function generateImage(
  params: GenerateImageParams,
): Promise<{ records: ImageRecordRow[]; error?: string }> {
  // 优先使用前端实时配置（用户可能改了地址/key 但还没点“保存”，生成时应直接用页面上的值），
  // 缺失字段回退到数据库里已保存的配置；同时把实时配置落盘，避免下次读到旧值。
  const dbCfg = getImageGenConfig();
  const cfg: ImageGenConfig = {
    backend: params.config?.backend ?? dbCfg.backend,
    apiBase:
      params.config?.apiBase !== undefined
        ? params.config.apiBase.trim()
        : dbCfg.apiBase,
    apiKey:
      params.config?.apiKey !== undefined ? params.config.apiKey.trim() : dbCfg.apiKey,
    model:
      params.config?.model !== undefined ? params.config.model.trim() : dbCfg.model,
    comfyBase:
      params.config?.comfyBase !== undefined
        ? params.config.comfyBase.trim()
        : dbCfg.comfyBase,
  };
  // 把页面上的实时配置落盘（含 backend），确保下次打开仍是这次用的配置。
  try {
    saveImageGenConfig(cfg);
  } catch {}

  const prompt = params.prompt?.trim() ?? "";
  if (!prompt) {
    return { records: [], error: "请先输入提示词" };
  }

  try {
    const refs =
      cfg.backend === "mlx"
        ? await generateViaMlx(cfg, params)
        : cfg.backend === "comfyui"
          ? await generateViaComfy(cfg, params)
          : await generateViaApi(cfg, params);

    const records = refs.map((ref) =>
      toRow(
        insertImageRecord({
          status: "done",
          backend: cfg.backend,
          model: params.model?.trim() || cfg.model || null,
          prompt,
          negativePrompt: params.negativePrompt?.trim() || null,
          width: params.width ?? null,
          height: params.height ?? null,
          seed: params.seed ?? null,
          steps: params.steps ?? null,
          imagePath: ref,
        }),
      ),
    );
    return { records };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    insertImageRecord({
      status: "failed",
      backend: cfg.backend,
      model: params.model?.trim() || cfg.model || null,
      prompt,
      negativePrompt: params.negativePrompt?.trim() || null,
      width: params.width ?? null,
      height: params.height ?? null,
      seed: params.seed ?? null,
      steps: params.steps ?? null,
      error: message,
    });
    return { records: [], error: message };
  }
}
