import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { desc, eq, inArray } from "drizzle-orm";

import { db } from "./db";
import { musicRecords, type MediaSource } from "./db/schema";
import { getSetting, updateSettings } from "./db/settings";
import { getImagesBaseDir } from "./image-server";
import { chatImageUrl } from "../shared/server-info";
import * as CloudProviders from "./cloud-providers";
import {
  MINIMAX_MUSIC_MODELS,
  STEPFUN_MUSIC_MODELS,
  type CloudMusicApi,
} from "../shared/cloud-providers";
import { logEvent } from "./app-log";
import { providerLabelFor, recordUsageEvent } from "./usage";

// 模型清单的唯一真源在 shared/cloud-providers（预设与服务商用同一份），
// 这里继续对外导出，保持既有导入方（rpc / 脚本）不变。
export { MINIMAX_MUSIC_MODELS, STEPFUN_MUSIC_MODELS };

/**
 * AI 音乐生成模块（结构与 ./video-gen.ts 对齐）。
 *
 * ## 为什么按「协议」而不是按「厂商」分派
 *
 * 生音乐和生视频一样没有统一标准，而且这次连**执行模型**都不一样：
 *
 * | 协议      | 提交                                   | 结果                              | 形态     |
 * | --------- | -------------------------------------- | --------------------------------- | -------- |
 * | `stepfun` | `POST /v1/audio/music/submit` → task_id | 轮询 `/query`，音频以 **Base64** 回 | 异步     |
 * | `minimax` | `POST /v1/music_generation`             | 一次阻塞请求直接出音频（hex/url）  | **同步** |
 *
 * 所以 `submitMusicGeneration` 对两者都先落一条 `processing` 记录，区别在后面：
 * 异步的等前端轮询，同步的由**后台任务**（`runSynchronousJob`）在请求返回后回填。
 * 把厂商名硬编码进调用处的话，加一家就得改一遍分派 —— 协议字段（`musicApi`，
 * 存在厂商行上）是唯一的开关，加厂商 = 加一个取值 + 一对 submit/poll 实现。
 *
 * ## 本地后端
 *
 * `backend: "local"` 是**预留位**，尚未接入任何本地引擎。设置面（`MUSIC_LOCAL_*`）、
 * 记录字段（`localBase`）与界面开关都已就位，`localUnavailable` 会给出明确的可读错误而
 * 不是假装成功 —— 见那里的注释，接一个引擎只需要补齐那个函数 + 一个轮询分支。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 生音乐后端：云端（厂商行决定协议）或本地引擎（预留）。 */
export type MusicGenBackend = "cloud" | "local";

/** 生成任务类型。StepFun 直接吃这个值；MiniMax 没有该字段，由输入反推。 */
export type MusicTask = "text_to_music" | "music_cover" | "vocal_to_music";

export type MusicRecordRow = {
  id: number;
  status: "processing" | "done" | "failed";
  source: MediaSource;
  backend: MusicGenBackend | null;
  providerId: string | null;
  musicApi: CloudMusicApi | null;
  model: string | null;
  task: MusicTask | null;
  title: string | null;
  caption: string | null;
  lyrics: string | null;
  instrumental: boolean;
  refAudioUrl: string | null;
  responseFormat: string | null;
  sampleRate: number | null;
  bitRate: number | null;
  durationMs: number | null;
  taskId: string | null;
  audioUrl: string | null;
  /** 音频在 images 根目录下的相对路径（如 music/xxx.mp3），供复用与读取。 */
  audioPath: string | null;
  rewrittenCaption: string | null;
  rewrittenLyrics: string | null;
  error: string | null;
  createdAt: number;
  /** 本轮轮询的瞬时错误（如音频下载失败，下一轮重试），不落库。 */
  pollError?: string | null;
};

export type MusicGenConfig = {
  backend: MusicGenBackend;
  /** 云端选中的服务商（地址 / 密钥 / 接口协议都来自这一行）。 */
  providerId: string;
  model: string;
  /** 本地引擎（预留）：协议 / 地址 / 模型名。 */
  localApi: string;
  localBase: string;
  localModel: string;
};

export type SubmitMusicParams = {
  /** 风格描述（曲风 / 人声 / 情绪 / 调式…）。两家都必填。 */
  caption: string;
  lyrics?: string;
  /** 歌名：本地标签，不会发给上游（接口没有这个参数）。 */
  title?: string;
  /** 纯器乐：与 lyrics 互斥（StepFun 明确禁止同时传）。 */
  instrumental?: boolean;
  /** 任务类型；省略时按"有无参考音频 + 是否器乐"推断。 */
  task?: MusicTask;
  /** 参考歌曲 / 干声的 ref（images 目录内，stageAudio 暂存）。 */
  refAudioRef?: string;
  responseFormat?: MusicOutputFormat;
  sampleRate?: number;
  /** 前端当前页面的实时配置：优先使用（避免读到未保存的旧配置），并顺带落盘。 */
  config?: Partial<MusicGenConfig>;
  /** 调用方来源：界面手工生成（manual，默认）还是 agent。 */
  source?: MediaSource;
};

/** 输出格式：StepFun 五种，MiniMax 三种；取交集之外也各自校验。 */
export type MusicOutputFormat = "mp3" | "wav" | "flac" | "opus" | "pcm";

/** StepFun 支持的输出格式（文档「音频与输出约束」）。 */
export const STEPFUN_FORMATS: readonly MusicOutputFormat[] = ["wav", "flac", "opus", "mp3", "pcm"];
/** MiniMax `audio_setting.format` 的枚举。 */
export const MINIMAX_FORMATS: readonly MusicOutputFormat[] = ["mp3", "wav", "pcm"];

/** 各协议的输出格式档位：换厂商等于换协议，档位要跟着收敛。 */
export const MUSIC_FORMATS: Record<CloudMusicApi & ("stepfun" | "minimax"), readonly MusicOutputFormat[]> = {
  stepfun: STEPFUN_FORMATS,
  minimax: MINIMAX_FORMATS,
};

type RecordRow = typeof musicRecords.$inferSelect;

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 轮询兜底：超过 30 分钟仍未完成的任务标记为超时失败（生成通常 1~3 分钟）。 */
const STALE_MS = 30 * 60_000;

/**
 * 同步协议（minimax）的任务在**本进程**有活干，异步协议（stepfun）的没有。
 *
 * 它只用来判断"这条 processing 记录还有没有人管"：应用重启后集合是空的，
 * 而库里那条记录还写着 processing —— 那就是丢了，得如实标失败，
 * 不能让它挂到 30 分钟超时（更不能重发，那是二次计费）。
 */
const syncJobsInFlight = new Set<number>();

/** 同步任务给多久算"还在跑"：MiniMax 官方口径 30~120 秒，留足余量。 */
const SYNC_JOB_GRACE_MS = 10 * 60_000;

/**
 * 落盘时的扩展名 = 输出格式本身。
 *
 * 与生视频那边不同：视频的成片名是上游给的（要先按白名单验扩展名），而音乐的
 * 输出格式是我们自己收敛过的枚举值（`MUSIC_FORMATS`），直接用它更准 ——
 * 上游给的 Content-Type 常常是 `application/octet-stream`。
 */
function extForFormat(format: string): string {
  return `.${format.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// 配置（存 settings 表）
// ---------------------------------------------------------------------------

export function getMusicGenConfig(): MusicGenConfig {
  const backend = getSetting("MUSIC_BACKEND");
  return {
    backend: backend === "local" ? "local" : "cloud",
    providerId: (getSetting("MUSIC_PROVIDER_ID") || "").trim(),
    model: (getSetting("MUSIC_MODEL") || "").trim(),
    localApi: (getSetting("MUSIC_LOCAL_API") || "").trim(),
    localBase: (getSetting("MUSIC_LOCAL_BASE") || "").trim(),
    localModel: (getSetting("MUSIC_LOCAL_MODEL") || "").trim(),
  };
}

export function saveMusicGenConfig(cfg: Partial<MusicGenConfig>): void {
  const settings: Record<string, string> = {};
  if (cfg.backend !== undefined) settings.MUSIC_BACKEND = cfg.backend;
  if (cfg.providerId !== undefined) settings.MUSIC_PROVIDER_ID = cfg.providerId.trim();
  if (cfg.model !== undefined) settings.MUSIC_MODEL = cfg.model.trim();
  if (cfg.localApi !== undefined) settings.MUSIC_LOCAL_API = cfg.localApi.trim();
  if (cfg.localBase !== undefined) settings.MUSIC_LOCAL_BASE = cfg.localBase.trim();
  if (cfg.localModel !== undefined) settings.MUSIC_LOCAL_MODEL = cfg.localModel.trim();
  updateSettings(settings);
  if (cfg.providerId && cfg.model) {
    CloudProviders.saveAppModelChoice({
      settingKey: "MUSIC_PROVIDER_ID",
      providerId: cfg.providerId.trim(),
      model: cfg.model,
      type: "music",
    });
  }
}

/** 云端生音乐的一次调用目标：厂商地址 / 密钥 + 接口协议。 */
type CloudMusicTarget = {
  providerId: string;
  providerName: string;
  base: string;
  key: string;
  musicApi: "stepfun" | "minimax";
};

/**
 * 按服务商解析生音乐调用目标。音乐 API 没有统一标准，协议记在服务商行上
 * （`musicApi`），没配协议的厂商不能用来生音乐 —— 这里直接给出可读的原因。
 */
function resolveCloudTarget(providerId: string): CloudMusicTarget {
  const provider = CloudProviders.resolveCloudProvider(providerId);
  if (!provider) {
    throw new Error("还没选择云厂商。请到「设置 → 模型云服务」启用一个支持生音乐的厂商");
  }
  if (!provider.baseUrl.trim()) throw new Error(`云厂商「${provider.name}」还没有填 API 地址`);
  const musicApi = provider.musicApi;
  if (musicApi !== "stepfun" && musicApi !== "minimax") {
    throw new Error(
      `云厂商「${provider.name}」没有配置生音乐接口（在「设置 → 模型云服务」里把它设为 StepFun 或 MiniMax）`,
    );
  }
  return {
    providerId: provider.id,
    providerName: provider.name,
    base: provider.baseUrl.trim(),
    key: provider.apiKey.trim(),
    musicApi,
  };
}

/**
 * 记一次生音乐提交。与生图 / 生视频同一种情况：没有 token 口径（云端按次计费），
 * 但每次提交都是用户眼里的一次"调用"，统计页里得看得见。没有 token 就记
 * `requests: 1`，token 留 0。
 */
function recordMusicUsage(
  upstream: "local" | "cloud",
  provider: string,
  model: string | null | undefined,
): void {
  recordUsageEvent({
    channel: "music",
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

// ---------------------------------------------------------------------------
// 上游响应解析的公共部分
// ---------------------------------------------------------------------------

/** 读一次响应正文（Response 只能读一次），同时给出原始文本与其中可读的报错信息。 */
async function readErrorBody(res: Response): Promise<{ raw: string; message: string }> {
  const raw = (await res.text().catch(() => "")).trim();
  if (!raw) return { raw: "", message: "" };
  try {
    const json = JSON.parse(raw) as
      | { error?: { message?: string }; message?: string }
      | null;
    const message = json?.error?.message ?? json?.message;
    if (typeof message === "string" && message.trim()) return { raw, message };
    return { raw, message: raw.slice(0, 300) };
  } catch {
    return { raw, message: raw.slice(0, 300) };
  }
}

/**
 * 正文像不像 JSON：不像 JSON 的 404 是网关 / 路由回的（`404 page not found`），
 * 跟上游业务层的"任务不存在"是两回事 —— 前者要改地址，后者才是任务过期。
 */
function looksLikeJson(raw: string): boolean {
  const t = raw.trim();
  return t.startsWith("{") || t.startsWith("[");
}

/**
 * 路由级 404（正文不是 JSON）补一句「地址可能填错」——光回一句 `404 page not found`
 * 用户没法知道问题出在地址上。
 *
 * 注意这里与视频那边的一处差别：厂商的 baseUrl 预设**自带 `/v1`**
 * （`https://api.stepfun.com/v1`），而本模块要拼的是 `/v1/audio/music/submit`。
 * 直接拼会得到 `/v1/v1/audio/...`，所以提交前先剥掉已有的版本段（见 `apiRoot`）。
 */
function withRouteHint(base: string, status: number, raw: string, message: string): string {
  if (status !== 404 || looksLikeJson(raw)) return message;
  const text = message || "404 page not found";
  return `${text}：上游没有这个接口路径（当前 API 地址 ${base}），请到「设置 → 模型云服务」检查该厂商的地址 —— 填根地址或带 /v1 的地址都可以，两种都会被自动规整`;
}

/**
 * 厂商地址 → 可以安全拼接接口路径的根地址。
 *
 * 预设的 baseUrl 自带版本段（`https://api.stepfun.com/v1`、
 * `https://api.minimax.chat/v1`），而文档里的路径本身也带 `/v1`：直接拼就是
 * `/v1/v1/audio/music/submit`。**两种都接受**——写成根地址的人不该被惩罚，
 * 写成带版本段的人也不该——所以统一剥掉末尾的版本段再拼。
 */
export function apiRoot(base: string): string {
  let b = base.trim().replace(/\/+$/, "");
  while (/\/v\d+$/i.test(b)) b = b.replace(/\/v\d+$/i, "").replace(/\/+$/, "");
  return b;
}

/** 把接口路径拼到规整后的根地址上。 */
function endpoint(base: string, apiPath: string): string {
  const root = apiRoot(base);
  if (!root) throw new Error("该厂商还没填 API 地址，请到「设置 → 模型云服务」补上");
  return `${root}${apiPath}`;
}

// ---------------------------------------------------------------------------
// 记录
// ---------------------------------------------------------------------------

function toRow(r: RecordRow, pollError: string | null = null): MusicRecordRow {
  return {
    id: r.id,
    status: r.status,
    source: r.source,
    backend: r.backend ?? null,
    providerId: r.providerId ?? null,
    musicApi: (r.musicApi ?? "") as CloudMusicApi | null,
    model: r.model,
    task: r.task ?? null,
    title: r.title,
    caption: r.caption,
    lyrics: r.lyrics,
    instrumental: r.instrumental === 1,
    refAudioUrl: r.refAudioPath ? chatImageUrl(r.refAudioPath) : null,
    responseFormat: r.responseFormat,
    sampleRate: r.sampleRate,
    bitRate: r.bitRate,
    durationMs: r.durationMs,
    taskId: r.taskId,
    audioUrl: r.audioPath ? chatImageUrl(r.audioPath) : null,
    audioPath: r.audioPath,
    rewrittenCaption: r.rewrittenCaption,
    rewrittenLyrics: r.rewrittenLyrics,
    error: r.error,
    createdAt: r.createdAt ?? 0,
    pollError,
  };
}

export function listMusicRecords(limit = 100): MusicRecordRow[] {
  const rows = db
    .select()
    .from(musicRecords)
    .orderBy(desc(musicRecords.id))
    .limit(Math.min(limit, 500))
    .all();
  return rows.map((r) => toRow(r));
}

export function deleteMusicRecord(id: number): { ok: boolean } {
  const [row] = db.select().from(musicRecords).where(eq(musicRecords.id, id)).limit(1).all();
  if (!row) return { ok: false };
  db.delete(musicRecords).where(eq(musicRecords.id, id)).run();
  // 顺带清理磁盘上的音频（ref 是相对 images 根目录的路径）。
  if (row.audioPath) {
    const base = getImagesBaseDir();
    const resolved = path.resolve(base, row.audioPath);
    if (resolved.startsWith(base + path.sep) && existsSync(resolved)) {
      try {
        unlinkSync(resolved);
      } catch {}
    }
  }
  return { ok: true };
}

function insertMusicRecord(data: Partial<typeof musicRecords.$inferInsert>): RecordRow {
  return db.insert(musicRecords).values(data).returning().get();
}

function updateMusicRecord(
  id: number,
  values: Partial<typeof musicRecords.$inferInsert>,
): RecordRow {
  return db.update(musicRecords).set(values).where(eq(musicRecords.id, id)).returning().get();
}

// ---------------------------------------------------------------------------
// 音频落盘（写入 images 根目录下的 music/ 子目录，由本地媒体服务对外提供）
// ---------------------------------------------------------------------------

function saveGeneratedAudio(data: Uint8Array, format: string): string {
  const dir = path.join(getImagesBaseDir(), "music");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const name = `${randomUUID()}${extForFormat(format)}`;
  writeFileSync(path.join(dir, name), data);
  return `music/${name}`;
}

/** 把 ref 解析为 images 目录下的绝对路径（防目录穿越），不存在时返回 null。 */
function resolveRef(ref: string): string | null {
  const base = getImagesBaseDir();
  const resolved = path.resolve(base, ref);
  if (!resolved.startsWith(base + path.sep)) return null;
  return existsSync(resolved) ? resolved : null;
}

/**
 * 读参考音频并转成裸 Base64（**不带** `data:` 前缀）。
 *
 * 两家文档都明确写了"音频输入字段使用原始文件字节的 Base64 字符串，不包含
 * data: 前缀"——带上前缀是稳定 400（StepFun）或被当成损坏音频（MiniMax）。
 */
async function refAudioBase64(ref: string): Promise<string> {
  const abs = resolveRef(ref);
  if (!abs) throw new Error("参考音频文件不存在，请重新选择");
  return Buffer.from(await Bun.file(abs).arrayBuffer()).toString("base64");
}

/**
 * 音频时长的粗略估算：按已知采样率 / 位深算字节数。
 *
 * 只用于列表上显示"大概多长"，所以不做解码 —— 真正的时长要解析容器头
 * （mp3 没有固定头长，得跳帧），那是另一个量级的工作。mp3 按 128kbps 估，
 * 其余按 16bit 立体声 PCM 估。
 */
function estimateDurationMs(bytes: number, format: string, sampleRate: number | null): number | null {
  if (bytes <= 0) return null;
  if (format === "mp3") return Math.round((bytes * 8) / 128_000 * 1000);
  const rate = sampleRate && sampleRate > 0 ? sampleRate : 48_000;
  return Math.round((bytes / (rate * 2 * 2)) * 1000);
}

// ---------------------------------------------------------------------------
// 提交：StepFun 阶跃星辰（异步：submit + 轮询）
// ---------------------------------------------------------------------------

/**
 * StepFun 生音乐走官方的两段式接口：
 *
 *   POST {root}/v1/audio/music/submit   提交（task + model_id + caption + 可选 lyrics）
 *   POST {root}/v1/audio/music/query    轮询（{"task_id": …} → PENDING/RUNNING/SUCCESS/FAILED）
 *
 * 三个必须守住的点（文档里都写明了，漏掉就是到线上才发现的错）：
 *
 * 1. **`instrumental=true` 与 `lyrics` 互斥**。文档原话：「instrumental=true 时不得
 *    同时传入 lyrics」。歌词里的 `[Instrumental]` 只是局部器乐段，不能代替它。
 * 2. **`music_cover` / `vocal_to_music` 的 lyrics 必填**，而 `text_to_music` 不传
 *    歌词时由服务端自动写词 —— 所以歌词为空只在歌曲生成时才是合法的。
 * 3. **FAILED 是业务终态但 HTTP 仍是 200**，失败原因在 `error.stage` / `error.message`
 *    里；只看 `res.ok` 会把失败读成成功。
 *
 * `model_id` 文档写明是固定值（`stepaudio-3-music-preview`），但仍接受厂商行上
 * 用户填的模型名 —— 否则上游换了模型 id 就得改代码。
 */
async function submitStepfun(
  target: CloudMusicTarget,
  params: SubmitMusicParams,
  task: MusicTask,
  format: MusicOutputFormat,
): Promise<string> {
  const model = params.config?.model?.trim() || getSetting("MUSIC_MODEL") || STEPFUN_MUSIC_MODELS[0]!;
  const url = endpoint(target.base, "/v1/audio/music/submit");

  const body: Record<string, unknown> = {
    task,
    model_id: model,
    caption: params.caption.trim(),
    response_format: format,
  };
  // 歌词：器乐场景禁止传；其余场景传了才有值（空串等于没传，交给服务端自动写词）。
  const lyrics = (params.lyrics ?? "").trim();
  if (!params.instrumental && lyrics) body.lyrics = lyrics;
  if (task === "text_to_music") body.instrumental = params.instrumental === true;
  if (params.sampleRate && params.sampleRate > 0) body.sample_rate = params.sampleRate;
  if (task === "music_cover" && params.refAudioRef) {
    body.song_audio = await refAudioBase64(params.refAudioRef);
  }
  if (task === "vocal_to_music" && params.refAudioRef) {
    body.vocal_audio = await refAudioBase64(params.refAudioRef);
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(target.key ? { Authorization: `Bearer ${target.key}` } : {}),
    },
    body: JSON.stringify(body),
    // 提交要带上 Base64 的参考音频，大文件上传慢；生成本身在后台，这里只等入队。
    signal: AbortSignal.timeout(180_000),
  });
  const { raw, message } = await readErrorBody(res);
  if (!res.ok) {
    throw new Error(withRouteHint(target.base, res.status, raw, message) || `提交音乐生成任务失败（${res.status}）`);
  }
  let json: { task_id?: unknown } | null = null;
  try {
    json = JSON.parse(raw) as { task_id?: unknown };
  } catch {
    throw new Error(`上游响应不是合法 JSON：${raw.slice(0, 200) || "（空响应）"}`);
  }
  const taskId = json?.task_id;
  if (typeof taskId !== "string" || !taskId) {
    throw new Error(`StepFun 未返回 task_id：${raw.slice(0, 200) || "（空响应）"}`);
  }
  return taskId;
}

/** StepFun `/v1/audio/music/query` 的响应（只声明我们真正读的字段）。 */
type StepfunQueryResponse = {
  status?: unknown;
  audio?: unknown;
  sample_rate?: unknown;
  rewritten_caption?: unknown;
  rewritten_lyrics?: unknown;
  error?: { stage?: unknown; message?: unknown } | null;
};

/** StepFun 任务状态 → 终态判定。 */
const STEPFUN_DONE = new Set(["SUCCESS", "success"]);
const STEPFUN_FAILED = new Set(["FAILED", "failed"]);

/**
 * 失败阶段的可读解释。文档给了四个 stage，各有对应的处理建议 ——
 * 原样回给用户一句 `audio_transcode` 是没法指导下一步的。
 */
const STEPFUN_STAGE_HINT: Record<string, string> = {
  audio_transcode: "音频无法解码或采样率非法，请换一个参考音频 / 输出格式",
  no_speech_detected: "干声里没检测到有效人声，请换一段清晰、空白较少的干声",
  censor: "内容被安全审核拦截，请调整风格描述或歌词后重试",
  internal: "服务端内部错误，稍后重试即可（task_id 已在记录里，便于排查）",
};

type PollOutcome = {
  done: boolean;
  failed?: string;
  /** 音频字节（或可直接下载的地址）。 */
  audio?: { bytes: Uint8Array } | { url: string };
  progress?: number | null;
  /**
   * 上游回报的采样率（StepFun 的 SUCCESS 响应里有 `sample_rate`）。
   * 它比"请求里写的那个"可靠：省略或传 0 时上游会用模型原生采样率，
   * 只有响应才知道最后是哪个。
   */
  sampleRate?: number | null;
  /** 本轮查询失败但任务可能还在跑：保留 processing，下轮再查。 */
  pollFailure?: { fatal: boolean; message: string; status?: number };
};

/**
 * 上游 HTTP 错误 → 能不能靠重试解决。
 *
 * 401/403 是鉴权被上游拒绝：每 5 秒重试一次不会变好，只会把真实原因埋掉
 * （视频那边真踩过：MiniMax 返回 `1004 login fail`，被当成"还在生成"挂到超时）。
 */
function classifyPollStatus(status: number, message: string): { fatal: boolean; message: string; status?: number } {
  if (status === 401 || status === 403) {
    return {
      fatal: true,
      status,
      message: `上游鉴权失败（${status}）：${message || "API Key 被拒绝"} —— 请到「设置 → 模型云服务」检查该厂商的 API Key`,
    };
  }
  if (status >= 500) {
    return { fatal: false, status, message: `上游服务异常（${status}），正在自动重试${message ? `：${message}` : ""}` };
  }
  return { fatal: false, status, message: `上游返回 ${status}${message ? `：${message}` : ""}` };
}

/**
 * StepFun 的错误码 → 能不能重试。文档明确给了 `x-should-retry` 的语义：
 * 参数 / 鉴权 / 资源类（400 / 401 / 404）重试无效，限流与临时故障（429 / 500 / 503）
 * 才重试；额度类 429 重试也无效，要按 error.type 单独处理。
 */
function classifyStepfunErrorType(
  errorType: string,
  status: number,
): { fatal: boolean; message: string } {
  const hint =
    errorType === "insufficient_credit"
      ? "（Credit 余额不足，请到阶跃平台充值）"
      : errorType === "model_invalid"
        ? "（模型 ID 错误，或该账号没有这个模型的权限）"
        : errorType === "request_params_invalid"
          ? "（参数或参数组合不合法，检查风格描述与歌词）"
          : errorType === "project_credit_limit_exceeded" || errorType === "member_project_credit_limit_exceeded"
            ? "（项目或成员达到 Credit 上限）"
            : "";
  // 参数 / 鉴权 / 额度类都属于"改了才有救"，重试只是把原因埋掉。
  const fatal =
    status === 400 ||
    status === 401 ||
    status === 404 ||
    status === 402 ||
    errorType === "insufficient_credit" ||
    errorType === "model_invalid" ||
    errorType === "request_params_invalid" ||
    errorType.startsWith("project_credit_limit") ||
    errorType.startsWith("member_project_credit_limit");
  return { fatal, message: `${errorType || status}${hint}` };
}

async function pollStepfun(target: CloudMusicTarget, taskId: string): Promise<PollOutcome> {
  const url = endpoint(target.base, "/v1/audio/music/query");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(target.key ? { Authorization: `Bearer ${target.key}` } : {}),
    },
    body: JSON.stringify({ task_id: taskId }),
    signal: AbortSignal.timeout(60_000),
  });
  const { raw, message } = await readErrorBody(res);

  if (!res.ok) {
    // 纯文本 404 = 路由不存在（地址填错，改好还能接着查）；JSON 404 = 上游说任务没了。
    if (res.status === 404) {
      if (!looksLikeJson(raw)) {
        return {
          done: false,
          pollFailure: {
            fatal: true,
            status: 404,
            message: withRouteHint(target.base, res.status, raw, message),
          },
        };
      }
      return { done: true, failed: "上游任务不存在或已超过保留期" };
    }
    // error.type 决定重试是否有意义（见 classifyStepfunErrorType）。
    const errorType = ((): string => {
      try {
        return String(
          (JSON.parse(raw) as { error?: { type?: unknown } })?.error?.type ?? "",
        );
      } catch {
        return "";
      }
    })();
    if (errorType) {
      const classified = classifyStepfunErrorType(errorType, res.status);
      if (classified.fatal) {
        return { done: false, pollFailure: { fatal: true, status: res.status, message: classified.message } };
      }
    }
    return { done: false, pollFailure: classifyPollStatus(res.status, message) };
  }

  let json: StepfunQueryResponse | null = null;
  try {
    json = JSON.parse(raw) as StepfunQueryResponse;
  } catch {
    return { done: false, pollFailure: { fatal: false, message: `上游响应不是合法 JSON：${raw.slice(0, 120)}` } };
  }

  const status = typeof json?.status === "string" ? json.status : "";
  if (STEPFUN_FAILED.has(status)) {
    const stage = typeof json?.error?.stage === "string" ? json.error.stage : "";
    const detail = typeof json?.error?.message === "string" ? json.error.message : "";
    const hint = STEPFUN_STAGE_HINT[stage] ?? "";
    return {
      done: true,
      failed: [stage, detail].filter(Boolean).join("：") + (hint ? `（${hint}）` : "") || "生成失败",
    };
  }
  if (!STEPFUN_DONE.has(status)) {
    // PENDING / RUNNING：文档没有进度字段，如实返回 null（界面显示流逝时间而不是假进度）。
    return { done: false, progress: null };
  }

  const b64 = typeof json?.audio === "string" ? json.audio : "";
  if (!b64) return { done: true, failed: "上游返回 SUCCESS 但没有音频数据" };
  const bytes = Uint8Array.from(Buffer.from(b64, "base64"));
  if (bytes.length === 0) return { done: true, failed: "上游返回的音频是空的" };
  const reported = Number(json?.sample_rate);
  return {
    done: true,
    audio: { bytes },
    sampleRate: Number.isFinite(reported) && reported > 0 ? reported : null,
  };
}

/**
 * StepFun 的 `rewritten_caption` / `rewritten_lyrics` 只在 SUCCESS 时返回，
 * 与音频在同一次响应里 —— 单独取一次（轮询函数的返回值只带音频，避免为一个
 * 展示字段把整个响应结构透到上层）。
 */
async function fetchStepfunRewrites(
  target: CloudMusicTarget,
  taskId: string,
): Promise<{ caption: string | null; lyrics: string | null }> {
  try {
    const res = await fetch(endpoint(target.base, "/v1/audio/music/query"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(target.key ? { Authorization: `Bearer ${target.key}` } : {}),
      },
      body: JSON.stringify({ task_id: taskId }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { caption: null, lyrics: null };
    const json = (await res.json().catch(() => null)) as
      | { rewritten_caption?: unknown; rewritten_lyrics?: unknown }
      | null;
    return {
      caption: typeof json?.rewritten_caption === "string" ? json.rewritten_caption : null,
      lyrics: typeof json?.rewritten_lyrics === "string" ? json.rewritten_lyrics : null,
    };
  } catch {
    return { caption: null, lyrics: null };
  }
}

// ---------------------------------------------------------------------------
// 提交：MiniMax（同步：一次阻塞请求直接出音频）
// ---------------------------------------------------------------------------

/** MiniMax `/v1/music_generation` 的响应：业务码在 base_resp，音频在 data.audio。 */
type MinimaxMusicResponse = {
  data?: { audio?: unknown; status?: unknown };
  base_resp?: { status_code?: unknown; status_msg?: unknown };
};

/**
 * MiniMax 生音乐走 `POST /v1/music_generation`，**没有 task_id、没有查询接口**
 * （`/v1/query/music_generation` 是 404），一次请求阻塞 30~120 秒直接返回音频。
 *
 * 三个与 StepFun 不同、必须单独处理的地方：
 *
 * 1. **业务错误走 HTTP 200 + `base_resp.status_code`**（1004 鉴权 / 1002 限流 /
 *    1008 余额 / 2013 参数）。只看 `res.ok` 会把鉴权失败当成功。
 * 2. **音频默认是 hex 字符串**，不是 base64 —— `bytes.fromhex()` 才对。用
 *    `output_format: "url"` 可以换成下载地址（24 小时有效），但那样多一跳下载，
 *    而这里的记录本来就要落盘，所以固定用 hex。
 * 3. **模型是 `music-cover` 时才需要参考音频**，字段是 `audio_base64`（请求字段名，
 *    与响应的 `data.audio` 同名不同义，别抄错）。
 *
 * 它同时是"同步协议"的代表：调用方必须把它放到后台任务里跑（见 `runSynchronousJob`），
 * 否则会把 RPC 挂住两分钟。
 */
async function runMinimaxSync(
  target: CloudMusicTarget,
  params: SubmitMusicParams,
  task: MusicTask,
  format: MusicOutputFormat,
): Promise<{ bytes: Uint8Array; format: string; sampleRate: number | null }> {
  const model = params.config?.model?.trim() || getSetting("MUSIC_MODEL") || MINIMAX_MUSIC_MODELS[0]!;
  const url = endpoint(target.base, "/v1/music_generation");
  const sampleRate = params.sampleRate && params.sampleRate > 0 ? params.sampleRate : 44_100;

  const body: Record<string, unknown> = {
    model,
    // MiniMax 把风格描述叫 prompt（StepFun 叫 caption），歌词字段同名。
    prompt: params.caption.trim(),
    output_format: "hex",
    audio_setting: { sample_rate: sampleRate, format },
  };
  const lyrics = (params.lyrics ?? "").trim();
  if (lyrics) body.lyrics = lyrics;
  // `is_instrumental` 才是官方字段名（社区代码里常见写成 `instrumental`，会被静默忽略）。
  if (task === "text_to_music") body.is_instrumental = params.instrumental === true;
  if (task === "music_cover" && params.refAudioRef) {
    body.audio_base64 = await refAudioBase64(params.refAudioRef);
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(target.key ? { Authorization: `Bearer ${target.key}` } : {}),
    },
    body: JSON.stringify(body),
    // 文档口径 30~120 秒；留足余量，超时后由后台任务标失败（不会重发，避免二次计费）。
    signal: AbortSignal.timeout(600_000),
  });
  const { raw, message } = await readErrorBody(res);
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        withRouteHint(target.base, res.status, raw, message) ||
          "上游没有 /v1/music_generation 接口，请检查该厂商的 API 地址",
      );
    }
    throw new Error(message || `音乐生成失败（${res.status}）`);
  }

  let json: MinimaxMusicResponse | null = null;
  try {
    json = JSON.parse(raw) as MinimaxMusicResponse;
  } catch {
    throw new Error(`上游响应不是合法 JSON：${raw.slice(0, 200) || "（空响应）"}`);
  }

  // HTTP 200 也可能是业务错误：先看 base_resp.status_code。
  const code = json?.base_resp?.status_code;
  if (typeof code === "number" && code !== 0) {
    const msg = String(json?.base_resp?.status_msg ?? "").trim() || "上游返回错误";
    const hint =
      code === 1004 || code === 2049
        ? "（API Key 被上游拒绝，去「设置 → 模型云服务」检查）"
        : code === 1002
          ? "（上游限流，稍后重试）"
          : code === 1008
            ? "（账户余额不足）"
            : code === 2013
              ? "（参数或模型名不对）"
              : code === 1026
                ? "（内容被安全审核拦截）"
                : "";
    throw new Error(`${code} ${msg}${hint}`);
  }
  if (json?.data?.status === 1) {
    // 文档只把 status:1 记作"进行中"，没说非流式请求会不会返回它。真遇到了不能
    // 当成功（data.audio 还是空的）—— 如实报错，让用户重试。
    throw new Error("上游返回「进行中」但没有音频（MiniMax status=1），请重试一次");
  }

  const hex = typeof json?.data?.audio === "string" ? json.data.audio : "";
  if (!hex) throw new Error("上游没有返回音频数据（data.audio 为空）");
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(Buffer.from(hex, "hex"));
  } catch {
    throw new Error("上游返回的音频不是合法的 hex 编码");
  }
  if (bytes.length === 0) throw new Error("上游返回的音频是空的");
  return { bytes, format, sampleRate };
}

// ---------------------------------------------------------------------------
// 提交：本地引擎（预留位）
// ---------------------------------------------------------------------------

/**
 * 本地生音乐 —— **尚未接入任何引擎**。
 *
 * 返回的是"为什么不能用的可读原因"，由调用方在落库前提前返回（不产生失败记录）。
 *
 * 这里刻意不做"假装成功"的兜底（返回一段静音、或回落到云端）：那会让用户以为
 * 本地后端可用了，然后在质量 / 计费上被坑。设置面（`MUSIC_LOCAL_API` /
 * `MUSIC_LOCAL_BASE` / `MUSIC_LOCAL_MODEL`）、记录字段（`localBase`）与界面上的
 * 后端开关都已就位，接入时只需要：
 *
 *   1. 给 `MUSIC_LOCAL_API` 定一个取值（如 `"comfyui-ace-step"` / `"diffrhythm"`）；
 *   2. 在这个函数里实现提交（本地服务通常是"提交工作流 → 拿 prompt_id"，与
 *      video-gen 的 ComfyUI 分支同形）；
 *   3. 在 `pollMusicRecords` 里加一个对应的分支（或像同步协议那样走后台任务）。
 *
 * 在那之前，错误信息就是这里唯一诚实的答案。
 */
async function localUnavailable(cfg: MusicGenConfig): Promise<string> {
  const base = cfg.localBase.trim();
  const api = cfg.localApi.trim();
  logEvent({
    level: "warn",
    source: "music",
    event: "music.local.not_implemented",
    message: "本地生音乐后端尚未接入（预留位）",
    detail: { localApi: api || null, localBase: base || null, localModel: cfg.localModel || null },
  });
  return (
    "本地音乐生成还没接入引擎（当前是预留位）。" +
    (api ? `已配置的本地协议「${api}」还没有对应实现，` : "本地协议还没选，") +
    "可先用云端厂商：到「设置 → 模型云服务」启用一个支持生音乐的厂商（StepFun / MiniMax）"
  );
}

// ---------------------------------------------------------------------------
// 对外入口：提交生成
// ---------------------------------------------------------------------------

/** 按输入推断任务类型：有参考音频看它是什么（翻唱走整曲、配乐走干声），否则文生音乐。 */
function inferTask(params: SubmitMusicParams): MusicTask {
  if (params.task) return params.task;
  return params.refAudioRef ? "music_cover" : "text_to_music";
}

/** 输出格式收敛到该协议支持的档位（换厂商等于换协议，档位互不认）。 */
function snapFormat(api: "stepfun" | "minimax", format: MusicOutputFormat | undefined): MusicOutputFormat {
  const allowed = MUSIC_FORMATS[api];
  const want = format ?? "mp3";
  return allowed.includes(want) ? want : "mp3";
}

function validateParams(params: SubmitMusicParams, task: MusicTask): string | null {
  if (!params.caption.trim()) return "请先填写音乐描述（曲风 / 人声 / 情绪）";
  // StepFun 文档：instrumental=true 时不得同时传入 lyrics。
  if (params.instrumental && (params.lyrics ?? "").trim()) {
    return "纯器乐与歌词不能同时填写：选了纯器乐就清空歌词（歌词里的 [Instrumental] 不能代替它）";
  }
  if (task !== "text_to_music" && !params.refAudioRef) {
    return task === "music_cover" ? "翻唱需要先上传参考歌曲" : "干声配乐需要先上传无伴奏干声";
  }
  // 翻唱 / 配乐的歌词两家的文档都写成必填。
  if (task !== "text_to_music" && !(params.lyrics ?? "").trim()) {
    return "翻唱与干声配乐都必须提供歌词";
  }
  return null;
}

export async function submitMusicGeneration(
  params: SubmitMusicParams,
): Promise<{ record?: MusicRecordRow; error?: string }> {
  // 优先使用前端实时配置（同生图 / 生视频：生成时直接用页面上的值并落盘）。
  const dbCfg = getMusicGenConfig();
  const cfg: MusicGenConfig = {
    backend: params.config?.backend ?? dbCfg.backend,
    providerId:
      params.config?.providerId !== undefined ? params.config.providerId.trim() : dbCfg.providerId,
    model: params.config?.model !== undefined ? params.config.model.trim() : dbCfg.model,
    localApi: params.config?.localApi !== undefined ? params.config.localApi.trim() : dbCfg.localApi,
    localBase:
      params.config?.localBase !== undefined ? params.config.localBase.trim() : dbCfg.localBase,
    localModel:
      params.config?.localModel !== undefined ? params.config.localModel.trim() : dbCfg.localModel,
  };
  try {
    saveMusicGenConfig(cfg);
  } catch {}

  const invalid = validateParams(params, inferTask(params));
  if (invalid) return { error: invalid };

  const task = inferTask(params);

  // 本地后端还是预留位：这是**配置问题**而不是一次生成尝试 —— 界面上也禁用了按钮，
  // 走到这里只可能是 RPC 直调或旧配置。和 validateParams 一样在落库前返回，
  // 免得"本地未接入"把创作记录刷满；原因仍然写进 app.log（见 localUnavailable）。
  if (cfg.backend === "local") {
    const reason = await localUnavailable(cfg);
    return { error: reason };
  }

  const common = {
    source: params.source ?? "manual",
    backend: cfg.backend,
    providerId: cfg.providerId || null,
    model: cfg.model || null,
    task,
    title: params.title?.trim() || null,
    caption: params.caption.trim(),
    // 器乐场景不落歌词：它本来就不该被发出去，留着只会让下一步的人以为发过了。
    lyrics: params.instrumental ? null : (params.lyrics ?? "").trim() || null,
    instrumental: params.instrumental ? 1 : 0,
    refAudioPath: params.refAudioRef ?? null,
  } satisfies Partial<typeof musicRecords.$inferInsert>;

  try {
    if (params.refAudioRef && !resolveRef(params.refAudioRef)) {
      throw new Error("参考音频文件不存在，请重新选择");
    }

    const target = resolveCloudTarget(cfg.providerId);
    const format = snapFormat(target.musicApi, params.responseFormat);

    // 两种协议都先落一条 processing 记录再干活：前端立刻能看见"生成中"，
    // 失败也会留下一条可读的痕迹（而不是只在弹窗里闪一下）。
    const record = insertMusicRecord({
      ...common,
      status: "processing",
      musicApi: target.musicApi,
      model: cfg.model || defaultModelFor(target.musicApi),
      responseFormat: format,
      sampleRate: params.sampleRate && params.sampleRate > 0 ? params.sampleRate : null,
    });

    recordMusicUsage(
      "cloud",
      target.providerName,
      record.model ?? defaultModelFor(target.musicApi),
    );

    if (target.musicApi === "stepfun") {
      // 异步协议：拿 task_id 存进记录，剩下的交给前端轮询。
      const taskId = await submitStepfun(target, params, task, format);
      return { record: toRow(updateMusicRecord(record.id, { taskId })) };
    }

    // 同步协议：MiniMax 一次请求要阻塞 30~120 秒，绝不能在这儿等 ——
    // 挂到后台任务里，请求返回后由它回填记录（前端照样靠轮询刷新）。
    runSynchronousJob(record.id, target, params, task, format);
    return { record: toRow(record) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // 走到这里 backend 一定是 cloud：本地后端在上面就提前返回了（配置问题不落记录）。
    const target = providerTargetForLog(cfg.providerId);
    logEvent({
      level: "error",
      source: "music",
      event: "music.submit.failed",
      message,
      detail: {
        backend: cfg.backend,
        providerId: cfg.providerId || null,
        model: cfg.model || null,
        base: target?.base ?? null,
        hasApiKey: target?.hasApiKey ?? false,
        task,
        caption: params.caption.slice(0, 300),
        refAudio: params.refAudioRef ?? null,
        error: e,
      },
    });
    insertMusicRecord({ ...common, status: "failed", error: message });
    return { error: message };
  }
}

/**
 * 跑一次同步协议（MiniMax）的生成并回填记录。
 *
 * 刻意**不 await**：调用方（RPC）要立刻返回那条 processing 记录。
 * 失败一律落进记录与 app.log —— 后台任务的异常没人接，静默吞掉就没法排查了。
 */
function runSynchronousJob(
  recordId: number,
  target: CloudMusicTarget,
  params: SubmitMusicParams,
  task: MusicTask,
  format: MusicOutputFormat,
): void {
  syncJobsInFlight.add(recordId);
  void (async () => {
    try {
      const result = await runMinimaxSync(target, params, task, format);
      const ref = saveGeneratedAudio(result.bytes, result.format);
      updateMusicRecord(recordId, {
        status: "done",
        audioPath: ref,
        sampleRate: result.sampleRate,
        durationMs: estimateDurationMs(result.bytes.length, result.format, result.sampleRate),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logEvent({
        level: "error",
        source: "music",
        event: "music.sync.failed",
        message,
        detail: {
          id: recordId,
          providerId: target.providerId,
          musicApi: target.musicApi,
          model: params.config?.model ?? null,
          error: e,
        },
      });
      try {
        updateMusicRecord(recordId, { status: "failed", error: message });
      } catch {}
    } finally {
      syncJobsInFlight.delete(recordId);
    }
  })();
}

function defaultModelFor(api: "stepfun" | "minimax"): string {
  // 歌曲生成用第一个（stepfun 只有一个；minimax 的 music-3.0 是最新档）。
  return api === "stepfun" ? STEPFUN_MUSIC_MODELS[0]! : MINIMAX_MUSIC_MODELS[0]!;
}

// ---------------------------------------------------------------------------
// 对外入口：轮询（前端每 5s 调一次；应用重启后继续，任务不丢）
// ---------------------------------------------------------------------------

/**
 * 连续轮询失败的状态（按记录 id）：日志节流 + 致命失败的宽限计时。
 * 内存态足够：它只影响"多快把问题摆到眼前"，不影响任务本身（任务在 DB 里）。
 */
const pollFailures = new Map<
  number,
  { fails: number; lastMessage: string; lastLogAt: number; fatalSince: number | null }
>();

/** 连续失败到这个次数（前端 5s 一轮，约 2 分钟）把日志升到 error。 */
const POLL_FAIL_ESCALATE = 24;
/** 同一条记录的轮询失败日志最多每分钟一条。 */
const POLL_FAIL_LOG_INTERVAL_MS = 60_000;
/**
 * 致命失败（鉴权被拒 / 地址填错）的宽限期：重试确实不会好，但也不宜第一枪就判死 ——
 * 云端任务已经提交并计费，用户趁这会儿去设置里把 Key / 地址改对，还能接着把音频取回来。
 */
const FATAL_POLL_GRACE_MS = 3 * 60_000;

function notePollFailure(
  row: { id: number; backend: string | null; taskId: string | null },
  providerId: string,
  fail: { fatal: boolean; message: string; status?: number },
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
    level: fail.fatal || fails >= POLL_FAIL_ESCALATE ? "error" : "warn",
    source: "music",
    event: "music.poll.http",
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

/** 把结果音频落盘并标完成（两种协议的共同收尾）。 */
async function finishWithAudio(
  row: RecordRow,
  audio: { bytes: Uint8Array } | { url: string },
  format: string,
  sampleRate: number | null,
  rewrites?: { caption: string | null; lyrics: string | null },
): Promise<RecordRow> {
  let bytes: Uint8Array;
  if ("bytes" in audio) {
    bytes = audio.bytes;
  } else {
    const res = await fetch(audio.url, { signal: AbortSignal.timeout(300_000) });
    if (!res.ok) throw new Error(`下载音频失败（${res.status}）`);
    bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0) throw new Error("下载到的音频内容为空");
  }
  const ref = saveGeneratedAudio(bytes, format);
  return updateMusicRecord(row.id, {
    status: "done",
    audioPath: ref,
    sampleRate: sampleRate ?? row.sampleRate ?? null,
    durationMs: estimateDurationMs(bytes.length, format, sampleRate ?? row.sampleRate ?? null),
    ...(rewrites
      ? { rewrittenCaption: rewrites.caption, rewrittenLyrics: rewrites.lyrics }
      : {}),
  });
}

/**
 * 轮询在途任务。
 *
 * 只处理**异步协议**（stepfun）：同步协议的任务由提交时的后台任务回填，这里只为
 * 它做"任务还在不在"的判定 —— 应用重启会丢掉后台任务，那条记录不能一直挂着生成中，
 * 更不能重发（那是二次计费），所以如实标失败。
 */
export async function pollMusicRecords(ids: number[]): Promise<MusicRecordRow[]> {
  if (ids.length === 0) return [];
  const rows = db.select().from(musicRecords).where(inArray(musicRecords.id, ids)).all();
  const out: MusicRecordRow[] = [];

  for (const row of rows) {
    if (row.status !== "processing") {
      pollFailures.delete(row.id);
      out.push(toRow(row));
      continue;
    }

    // 兜底超时：带上最后一次查询失败的原因 —— 否则用户只看到"超时"，排查还得自己翻日志。
    if (Date.now() - (row.createdAt ?? 0) > STALE_MS) {
      const last = pollFailures.get(row.id)?.lastMessage;
      pollFailures.delete(row.id);
      const updated = updateMusicRecord(row.id, {
        status: "failed",
        error: last
          ? `生成超时（超过 30 分钟）；最后一次查询失败：${last}`
          : "生成超时（超过 30 分钟），可重试或检查服务状态",
      });
      logEvent({
        level: "error",
        source: "music",
        event: "music.poll.timeout",
        message: "音乐生成超时（超过 30 分钟）",
        detail: {
          id: row.id,
          backend: row.backend,
          providerId: row.providerId,
          taskId: row.taskId,
          lastPollError: last ?? null,
          caption: row.caption?.slice(0, 200),
        },
      });
      out.push(toRow(updated));
      continue;
    }

    const musicApi = row.musicApi;
    if (musicApi !== "stepfun" && musicApi !== "minimax") {
      // 本地后端（预留）或旧记录：没有可查的上游，直接标失败并说明原因。
      pollFailures.delete(row.id);
      const updated = updateMusicRecord(row.id, {
        status: "failed",
        error:
          row.backend === "local"
            ? "本地音乐生成后端尚未接入（预留位）"
            : "这条记录没有可查询的上游协议（旧记录或厂商协议已清空），无法继续",
      });
      out.push(toRow(updated));
      continue;
    }

    // 同步协议（minimax）：本进程还有活干就继续等，没有就是重启丢的。
    if (musicApi === "minimax") {
      if (syncJobsInFlight.has(row.id)) {
        out.push(toRow(row));
        continue;
      }
      const age = Date.now() - (row.createdAt ?? 0);
      if (age < SYNC_JOB_GRACE_MS) {
        // 刚提交不久：后台任务可能正在路上（提交与轮询之间有竞态窗口），再等一轮。
        out.push(toRow(row));
        continue;
      }
      pollFailures.delete(row.id);
      const updated = updateMusicRecord(row.id, {
        status: "failed",
        // 不重发：同步协议重发就是重新计费一次。让用户自己决定要不要再来一次。
        error: "任务中断（同步协议的后台任务已不在，通常是应用重启导致）。为避免重复计费不会自动重发，请重新生成",
      });
      logEvent({
        level: "warn",
        source: "music",
        event: "music.poll.sync_orphaned",
        message: "同步音乐任务失去后台执行者（应用重启），已标记失败且未重发",
        detail: { id: row.id, providerId: row.providerId, musicApi, ageMs: age },
      });
      out.push(toRow(updated));
      continue;
    }

    // 异步协议（stepfun）：按记录里的厂商查上游。
    let target: CloudMusicTarget | null = null;
    let setupError: string | null = null;
    if (row.providerId) {
      try {
        target = resolveCloudTarget(row.providerId);
      } catch (e) {
        setupError = e instanceof Error ? e.message : String(e);
      }
    }
    if (!setupError && target && target.musicApi !== "stepfun") {
      // 厂商行上的协议被改过了：在途任务是按 stepfun 提交的，仍然按 stepfun 查
      // （记录里的 musicApi 才是提交时的真相），这里只把地址 / 密钥取过来。
      target = { ...target, musicApi: "stepfun" };
    }
    if (!setupError && row.taskId && target) {
      try {
        const outcome = await pollStepfun(target, row.taskId);
        if (!outcome.done) {
          const fail = outcome.pollFailure;
          const state = fail ? notePollFailure(row, row.providerId ?? "", fail) : null;
          if (fail?.fatal && state?.fatalSince && Date.now() - state.fatalSince >= FATAL_POLL_GRACE_MS) {
            pollFailures.delete(row.id);
            const updated = updateMusicRecord(row.id, { status: "failed", error: fail.message });
            logEvent({
              level: "error",
              source: "music",
              event: "music.poll.failed",
              message: fail.message,
              detail: { id: row.id, providerId: row.providerId, taskId: row.taskId, status: fail.status ?? null },
            });
            out.push(toRow(updated));
            continue;
          }
          out.push(toRow(row, fail?.message ?? null));
          continue;
        }
        if (outcome.failed) {
          pollFailures.delete(row.id);
          const updated = updateMusicRecord(row.id, { status: "failed", error: outcome.failed });
          logEvent({
            level: "error",
            source: "music",
            event: "music.poll.failed",
            message: outcome.failed,
            detail: { id: row.id, providerId: row.providerId, taskId: row.taskId },
          });
          out.push(toRow(updated));
          continue;
        }
        // `done` 且非 failed 时 pollStepfun 一定会给出音频；真没有就当失败处理，
        // 不要用非空断言让它变成下一轮里一句看不懂的 TypeError。
        if (!outcome.audio) {
          pollFailures.delete(row.id);
          const updated = updateMusicRecord(row.id, {
            status: "failed",
            error: "上游表示任务已完成，但没有返回音频数据",
          });
          logEvent({
            level: "error",
            source: "music",
            event: "music.poll.failed",
            message: "上游 done 但没有音频",
            detail: { id: row.id, providerId: row.providerId, taskId: row.taskId },
          });
          out.push(toRow(updated));
          continue;
        }
        const rewrites = await fetchStepfunRewrites(target, row.taskId);
        pollFailures.delete(row.id);
        const updated = await finishWithAudio(
          row,
          outcome.audio,
          row.responseFormat || "mp3",
          // 上游回报的采样率优先：省略 / 传 0 时实际用的是模型原生采样率。
          outcome.sampleRate ?? row.sampleRate,
          rewrites,
        );
        out.push(toRow(updated));
      } catch (e) {
        // 下载失败 / 网络异常这类瞬时错误：保留 processing，下一轮重试（超时兜底在上面）。
        const message = e instanceof Error ? e.message : String(e);
        notePollFailure(row, row.providerId ?? "", { fatal: false, message });
        out.push(toRow(row, message));
      }
      continue;
    }

    pollFailures.delete(row.id);
    const updated = updateMusicRecord(row.id, {
      status: "failed",
      error: setupError
        ? `无法继续查询上游状态：${setupError}`
        : "缺少上游任务 id，无法继续查询",
    });
    out.push(toRow(updated));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 模型清单
// ---------------------------------------------------------------------------

/**
 * 某个后端 / 厂商下可用的生音乐模型。
 *
 * 云端不请求上游的 `/v1/models`：生音乐模型往往不在 OpenAI 兼容的模型列表里
 * （StepFun 的 `stepaudio-3-music-preview` 就是），拉回来也是空的。预设清单
 * （`STEPFUN_MUSIC_MODELS` / `MINIMAX_MUSIC_MODELS`）才是可靠来源，用户也能手填。
 */
export function listMusicGenModels(input?: {
  backend?: MusicGenBackend;
  providerId?: string;
}): { models: string[]; error?: string } {
  const backend = input?.backend ?? getMusicGenConfig().backend;
  if (backend === "local") {
    // 本地引擎（预留）：没有可探测的清单，返回空表并说明原因 ——
    // 界面据此提示"接好引擎后再来"，而不是显示一个空下拉框让人以为坏了。
    return { models: [], error: "本地生音乐引擎尚未接入（预留位），暂无可选模型" };
  }
  if (input?.providerId) {
    const provider = CloudProviders.resolveCloudProvider(input.providerId);
    if (!provider) return { models: [], error: "服务商不存在" };
    if (provider.musicApi === "stepfun") return { models: [...STEPFUN_MUSIC_MODELS] };
    if (provider.musicApi === "minimax") return { models: [...MINIMAX_MUSIC_MODELS] };
    return { models: [], error: `云厂商「${provider.name}」没有配置生音乐接口` };
  }
  return { models: [...STEPFUN_MUSIC_MODELS, ...MINIMAX_MUSIC_MODELS] };
}
