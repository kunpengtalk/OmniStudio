import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { desc, eq } from "drizzle-orm";

import { db } from "./db";
import { imageRecords, type MediaSource } from "./db/schema";
import { getSetting, updateSettings } from "./db/settings";
import { getImagesBaseDir } from "./image-server";
import { chatImageUrl } from "../shared/server-info";
import * as MlxGen from "./mlx-gen";
import { findMlxModel } from "./mlx-gen";
import * as CloudProviders from "./cloud-providers";
import { logEvent } from "./app-log";
import { providerLabelFor, recordUsageEvent } from "./usage";

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
  source: MediaSource;
  backend: ImageGenBackend | null;
  model: string | null;
  prompt: string | null;
  negativePrompt: string | null;
  width: number | null;
  height: number | null;
  seed: number | null;
  steps: number | null;
  imageUrl: string | null;
  /** 生成图片在 images 根目录下的相对路径（如 gen/xxx.png），供网关 b64_json 直读。 */
  imagePath: string | null;
  error: string | null;
  createdAt: number;
};

export type ImageGenConfig = {
  backend: ImageGenBackend;
  /**
   * 云端后端选中的服务商 id（「设置 → 模型云服务」里配置的厂商）。
   * 地址与密钥由服务商行提供 —— 图像页只挑厂商 + 模型，不再单独保存连接信息。
   */
  providerId: string;
  /** 服务商地址 / 密钥（只读派生：从 providerId 解析，见 `getImageGenConfig`）。 */
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
  /** AI 修图：参考图在 images 目录下的 ref（如 edit/in/xxx.png）。仅 OpenAI 兼容云端后端支持。
   *  提供时走 /v1/images/edits 以图改图；否则走 /v1/images/generations 纯文生图。 */
  referenceImageRef?: string;
  /** 前端当前页面的实时配置。若提供则优先使用（避免读取到未保存的旧配置），并顺带落盘。 */
  config?: Partial<ImageGenConfig>;
  /** 是否把本次生效配置落盘到 settings（默认 true；网关等只读调用传 false 避免改写用户配置）。 */
  persistConfig?: boolean;
  /** 调用方来源：界面手工生成（manual，默认）还是 agent（内置 Pi Agent / 网关）。 */
  source?: MediaSource;
};

type RecordRow = typeof imageRecords.$inferSelect;

// ---------------------------------------------------------------------------
// 配置（存 settings 表）
// ---------------------------------------------------------------------------

export function getImageGenConfig(): ImageGenConfig {
  const backend = getSetting("IMG_BACKEND");
  const providerId = (getSetting("IMG_PROVIDER_ID") || "").trim();
  const provider = CloudProviders.resolveCloudProvider(providerId);
  return {
    backend: backend === "comfyui" || backend === "mlx" ? backend : "api",
    providerId,
    // 地址与密钥只有一个来源：选中的云厂商。
    apiBase: provider?.baseUrl.trim() ?? "",
    apiKey: provider?.apiKey.trim() ?? "",
    model: (getSetting("IMG_MODEL") || "").trim(),
    comfyBase: (getSetting("IMG_COMFY_BASE") || "").trim(),
  };
}

/**
 * 保存生图配置。后端页面只写 backend / providerId / model —— 地址与密钥属于
 * 服务商（设置页维护），旧调用方传 apiBase/apiKey 时忽略，避免又出现第二份连接信息。
 */
export function saveImageGenConfig(cfg: Partial<ImageGenConfig>): void {
  const settings: Record<string, string> = {};
  if (cfg.backend !== undefined) settings.IMG_BACKEND = cfg.backend;
  if (cfg.providerId !== undefined) settings.IMG_PROVIDER_ID = cfg.providerId.trim();
  if (cfg.model !== undefined) settings.IMG_MODEL = cfg.model.trim();
  if (cfg.comfyBase !== undefined) settings.IMG_COMFY_BASE = cfg.comfyBase.trim();
  updateSettings(settings);
  // 选中的模型并进厂商清单（带"生图"分类），下次打开选择器就能看到它。
  if (cfg.providerId && cfg.model) {
    CloudProviders.saveAppModelChoice({
      settingKey: "IMG_PROVIDER_ID",
      providerId: cfg.providerId.trim(),
      model: cfg.model,
      type: "image",
    });
  }
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

/**
 * 上游报错取一句人话。
 *
 * 报错信封不止 OpenAI 那一种：除了 `{ error: { message } }`，国内不少聚合网关用的是
 * `{ code, message }`（硅基流动 20012 那种）。只认第一种的后果是把整段 JSON 原样丢给
 * 用户 —— 小应用里显示的就是 `{"code":20012,"message":"Model does not exist…"}`，
 * 既不好看也没告诉人去哪儿改。
 */
export function upstreamErrorText(body: string): string {
  const raw = (body ?? "").trim();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    const nested = parsed?.error;
    if (nested && typeof nested === "object" && typeof nested.message === "string") {
      return nested.message;
    }
    if (typeof nested === "string" && nested) return nested;
    if (typeof parsed?.message === "string" && parsed.message) return parsed.message;
  } catch {
    // 不是 JSON 就当纯文本
  }
  return raw.slice(0, 300);
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = await res.text().catch(() => "");
  const text = upstreamErrorText(body);
  return text || `${fallback} (${res.status})`;
}

/**
 * 「模型不存在」这类报错补一句能照着做的提示。
 *
 * 实测最常见的成因不是上游坏了：`IMG_MODEL` 是三个后端共用的一个槽位，从本地 MLX
 * 切到云端时它不会被清掉，于是 `z-image-turbo`（MLX 的 preset id）被原样发给了
 * 硅基流动 —— 上游只回一句 "Model does not exist"，用户没法从这句话看出问题在
 * 自己的设置里，更看不出该改哪儿。
 */
export function modelNotFoundHint(
  message: string,
  model: string,
  providerName?: string,
): string {
  const hit =
    /model\s+(does not exist|not found|is not exist)|invalid\s+model|no such model|模型不存在|不存在的模型/i.test(
      message,
    );
  if (!hit) return message;
  const where = providerName?.trim() || "当前厂商";
  return (
    `${where} 没有这个模型：${model}。` +
    `到「图像生成 → 云端」的模型选择器里换一个该厂商提供的生图模型` +
    `（或把生图后端切回本地 MLX / ComfyUI）。上游原始报错：${message}`
  );
}

// ---------------------------------------------------------------------------
// 模型列表
// ---------------------------------------------------------------------------

/**
 * 从 OpenAI 兼容 /models 拉取可用模型列表。
 *
 * 地址候选与响应解析都交给 CloudProviders.fetchRemoteModels：与设置页「获取模型列表」
 * 用同一份实现 —— 两边各写一套时，同一个上游会一边列得出模型、一边报错。
 */
export async function listImageApiModels(
  base: string,
  apiKey: string,
): Promise<string[]> {
  if (!base.trim()) throw new Error("Missing API base URL");
  const r = await CloudProviders.fetchRemoteModels({ baseUrl: base, apiKey });
  if (!r.ok) throw new Error(r.error);
  return r.models;
}

/**
 * 列出某个后端可用的模型 id（RPC 与 Agent 弹窗共用的入口）。
 *
 * 凭据只有一个来源：`IMG_PROVIDER_ID` 指向的服务商行。调用方**不能**传地址或密钥 ——
 * 页面此前传的是 `apiKey: ""`，而空串不会被 `??` 拦下，需要鉴权的上游列模型必然 401。
 * 唯一例外是 `comfyBaseOverride`：ComfyUI 地址是用户自己的服务地址（不是凭据），
 * 且弹窗要用「还没落盘的表单值」探测。
 */
export async function listImageGenModelIds(
  backend?: ImageGenBackend,
  comfyBaseOverride?: string,
): Promise<string[]> {
  const cfg = getImageGenConfig();
  const picked = backend ?? cfg.backend;
  if (picked === "comfyui") return listComfyCheckpoints(comfyBaseOverride ?? cfg.comfyBase);
  if (picked === "mlx") return MlxGen.MLX_MODELS.map((m) => m.id);
  return listImageApiModels(cfg.apiBase, cfg.apiKey);
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
    source: r.source,
    backend: r.backend ?? null,
    model: r.model,
    prompt: r.prompt,
    negativePrompt: r.negativePrompt,
    width: r.width,
    height: r.height,
    seed: r.seed,
    steps: r.steps,
    imageUrl: r.imagePath ? chatImageUrl(r.imagePath) : null,
    imagePath: r.imagePath,
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
  source?: MediaSource;
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
      source: data.source ?? "manual",
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
// AI 修图：参考图暂存与解析
// ---------------------------------------------------------------------------

const EDIT_IMAGE_EXT_RE = /^\.(png|jpe?g|webp|bmp|tiff?|heic|heif)$/;

/** 把用户选中的参考图拷入 images/edit/in/，返回 {ref, url}（供修图页展示与生成时引用）。 */
export async function stageEditImage(
  paths: string[],
): Promise<{ ref: string; url: string }[]> {
  const dir = path.join(getImagesBaseDir(), "edit", "in");
  mkdirSync(dir, { recursive: true });
  const out: { ref: string; url: string }[] = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const ext = path.extname(p).toLowerCase();
    if (!EDIT_IMAGE_EXT_RE.test(ext)) continue;
    const name = `${randomUUID()}${ext}`;
    const dest = path.join(dir, name);
    await Bun.write(dest, Bun.file(p));
    const ref = `edit/in/${name}`;
    out.push({ ref, url: chatImageUrl(ref) });
  }
  return out;
}

/** 把 ref 解析为 images 目录下的绝对路径（防目录穿越），不存在时返回 null。 */
function resolveImageRef(ref: string): string | null {
  const base = getImagesBaseDir();
  const resolved = path.resolve(base, ref);
  if (!resolved.startsWith(base + path.sep)) return null;
  return existsSync(resolved) ? resolved : null;
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

/**
 * 生图接口的 usage（gpt-image-1 这一类按 token 计费的服务才会回）。
 * 字段名沿用 OpenAI 的 `usage`：`input_tokens` / `output_tokens`。
 */
type ApiImageUsage = { input_tokens?: number; output_tokens?: number; total_tokens?: number };

/**
 * 记一次生图调用。
 *
 * 生图和对话不是一套口径：多数服务只回图片、不回 token，所以**照样记一行**
 * （token 为 0，只计次数）—— 用户眼里「我这个月生了几百张图」本身就是用量，
 * 统计页里看不到反而奇怪。接口给了 usage 就照实填（gpt-image-1 会回）。
 */
function recordImageUsage(
  backend: string,
  provider: string,
  model: string,
  usage?: ApiImageUsage | null,
): void {
  recordUsageEvent({
    channel: "image",
    upstream: backend === "api" ? "cloud" : "local",
    provider,
    model,
    inputTokens: usage?.input_tokens,
    outputTokens: usage?.output_tokens,
  });
}

/** 生图后端的厂商展示名：云端取服务商名，本地是引擎名。 */
function imageProviderLabel(backend: string, providerId: string): string {
  if (backend === "mlx") return "MLX";
  if (backend === "comfyui") return "ComfyUI";
  return CloudProviders.resolveCloudProvider(providerId)?.name ?? providerLabelFor("cloud");
}

/** 解析 OpenAI 兼容图片接口的返回，逐张落盘并返回 ref 列表。 */
async function saveApiItems(res: Response, ctx: { provider: string; model: string }): Promise<string[]> {
  const json = (await res.json().catch(() => null)) as
    | { data?: ApiImageItem[]; usage?: ApiImageUsage }
    | null;
  const items = json?.data ?? [];
  if (items.length === 0) throw new Error("服务未返回任何图片");
  recordImageUsage("api", ctx.provider, ctx.model, json?.usage);

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

async function generateViaApi(
  cfg: ImageGenConfig,
  params: GenerateImageParams,
): Promise<string[]> {
  const base = normalizeApiBase(cfg.apiBase);
  if (!base) throw new Error("请先在左侧配置 OpenAI 兼容服务的 Base URL");
  const model = params.model?.trim() || cfg.model;
  if (!model) throw new Error("请先填写生图模型 ID");

  const count = Math.max(1, Math.min(params.count ?? 1, 8));
  const size = `${params.width ?? 1024}x${params.height ?? 1024}`;
  const usageCtx = { provider: imageProviderLabel("api", cfg.providerId), model };
  // 「模型不存在」时把厂商名写进报错：用户要照着它去改设置。
  const hint = (message: string) =>
    modelNotFoundHint(message, model, CloudProviders.resolveCloudProvider(cfg.providerId)?.name);

  // AI 修图：带参考图时走 /v1/images/edits（multipart 以图改图）；否则走纯文生图。
  if (params.referenceImageRef) {
    const abs = resolveImageRef(params.referenceImageRef);
    if (!abs) throw new Error("参考图文件不存在");

    const form = new FormData();
    form.append("model", model);
    form.append("prompt", params.prompt);
    form.append("n", String(count));
    form.append("size", size);
    form.append("response_format", "b64_json");
    if (params.negativePrompt?.trim()) form.append("negative_prompt", params.negativePrompt.trim());
    form.append(
      "image",
      new File([await Bun.file(abs).arrayBuffer()], path.basename(abs), {
        type: "image/png",
      }),
    );

    const res = await fetch(`${base}/images/edits`, {
      method: "POST",
      headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
      body: form,
      signal: AbortSignal.timeout(600_000),
    });
    if (!res.ok) throw new Error(hint(await errorMessage(res, "修图请求失败")));
    return saveApiItems(res, usageCtx);
  }

  const body: Record<string, unknown> = {
    model,
    prompt: params.prompt,
    n: count,
    size,
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
  if (!res.ok) throw new Error(hint(await errorMessage(res, "生图请求失败")));
  return saveApiItems(res, usageCtx);
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
  // 优先使用前端实时配置（用户可能换了厂商 / 模型但还没点“保存”），缺失字段回退到
  // 数据库里已保存的配置；同时把实时配置落盘，避免下次读到旧值。
  // 地址与密钥不来自页面：一律按选中的服务商现取（页面只存 providerId）。
  const dbCfg = getImageGenConfig();
  const providerId =
    params.config?.providerId !== undefined ? params.config.providerId.trim() : dbCfg.providerId;
  const provider = CloudProviders.resolveCloudProvider(providerId);
  const cfg: ImageGenConfig = {
    backend: params.config?.backend ?? dbCfg.backend,
    providerId,
    apiBase: provider?.baseUrl.trim() ?? "",
    apiKey: provider?.apiKey.trim() ?? "",
    model:
      params.config?.model !== undefined ? params.config.model.trim() : dbCfg.model,
    comfyBase:
      params.config?.comfyBase !== undefined
        ? params.config.comfyBase.trim()
        : dbCfg.comfyBase,
  };
  // 把页面上的实时配置落盘（含 backend），确保下次打开仍是这次用的配置。
  // 网关调用时传 persistConfig: false，避免 API 请求改写用户保存的图像配置。
  if (params.persistConfig !== false) {
    try {
      saveImageGenConfig(cfg);
    } catch {}
  }

  const prompt = params.prompt?.trim() ?? "";
  if (!prompt) {
    return { records: [], error: "请先输入提示词" };
  }

  try {
    // 参考图以图改图目前只有 OpenAI 兼容云端后端具备。
    if (params.referenceImageRef && cfg.backend !== "api") {
      throw new Error("参考图修图仅支持 OpenAI 兼容的云端后端（api）");
    }
    const refs =
      cfg.backend === "mlx"
        ? await generateViaMlx(cfg, params)
        : cfg.backend === "comfyui"
          ? await generateViaComfy(cfg, params)
          : await generateViaApi(cfg, params);
    // 本地两个后端（MLX / ComfyUI）不走 HTTP 计费，也不回 usage —— 但一次生成
    // 就是一次调用，照样记一行；模型名分别是 MLX 模型 id 与 ComfyUI 的 checkpoint。
    if (cfg.backend !== "api") {
      recordImageUsage(cfg.backend, imageProviderLabel(cfg.backend, cfg.providerId), params.model?.trim() || cfg.model);
    }

    const records = refs.map((ref) =>
      toRow(
        insertImageRecord({
          status: "done",
          source: params.source ?? "manual",
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
    // 统一日志：失败记录入库之外也落一份现场（含后端与提示词，便于复盘）。
    // 「没配置后端 / 模型」这类问题看这条就能直接定位，不必重现。
    logEvent({
      level: "error",
      source: "image",
      event: "image.generate.failed",
      message,
      detail: {
        backend: cfg.backend,
        model: params.model?.trim() || cfg.model || null,
        apiBase: cfg.apiBase || null,
        comfyBase: cfg.comfyBase || null,
        hasApiKey: Boolean(cfg.apiKey),
        prompt: prompt.slice(0, 300),
        width: params.width ?? null,
        height: params.height ?? null,
        reference: params.referenceImageRef ?? null,
        source: params.source ?? "manual",
        error: e,
      },
    });
    insertImageRecord({
      status: "failed",
      source: params.source ?? "manual",
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
