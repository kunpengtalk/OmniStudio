import { copyFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import path from "path";
import { Type } from "typebox";
import { and, count, desc, eq, gte, like, or, type SQL } from "drizzle-orm";

import { db } from "./db";
import { imageRecords, videoRecords, voiceRecords, type MediaSource } from "./db/schema";
import { getImagesBaseDir } from "./image-server";
import * as ImageGen from "./image-gen";
import * as VideoGen from "./video-gen";
import * as Voice from "./voice";
import * as TtsLocal from "./tts-local";
import { prepareImageGeneration } from "./media-setup";
import {
  assertInsideWorkspace,
  errorResult,
  resolvePath,
  textResult,
  type BuiltTool,
  type ToolContext,
} from "./agent-tools";

/**
 * Agent 的素材工具：把应用里产生的媒体资产暴露给 Agent，并支持复用。
 *
 * 用户在界面上手工生成的、以及 Agent 自己生成的图片 / 语音 / 视频，都记在同一批
 * 表里（image_records / video_records / voice_records），`source` 字段区分来源
 * （manual = 用户手工生成，agent = Agent 或外部 agent 经网关生成）。
 *
 * - `media_search`：按时间 / 关键词 / 类型 / 来源检索素材，结果带 ref 与日期；
 * - `media_export`：把库里的素材复制进工作区，写文档时用相对路径引用；
 * - `generate_image` / `generate_speech` / `generate_video`：用应用里已配置好的
 *   生图 / TTS / 视频后端生成新素材（产物照常入库，之后能被 media_search 检索到）。
 *
 * ref 是素材在 images 根目录下的相对路径（如 gen/xxx.png、videos/xxx.mp4、
 * audio/tts-xxx.mp3），是本模块统一的复用凭据。
 */

type MediaKind = "image" | "video" | "audio";

const KIND_LABEL: Record<MediaKind, string> = { image: "图片", video: "视频", audio: "语音" };
const SOURCE_LABEL: Record<MediaSource, string> = { manual: "用户手工生成", agent: "Agent 生成" };
/** 复制进工作区时的文件名前缀。 */
const KIND_PREFIX: Record<MediaKind, string> = { image: "image", video: "video", audio: "speech" };

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 50;
const DEFAULT_VIDEO_TIMEOUT_MS = 10 * 60_000;
const MAX_VIDEO_TIMEOUT_MS = 30 * 60_000;
const MAX_SPEECH_CHARS = 5_000;

/** 常用比例 → 像素尺寸（都是 16 的倍数，兼容各家本地引擎）。 */
const ASPECT_SIZES: Record<string, { width: number; height: number }> = {
  "1:1": { width: 1024, height: 1024 },
  "16:9": { width: 1344, height: 768 },
  "9:16": { width: 768, height: 1344 },
  "4:3": { width: 1152, height: 864 },
  "3:4": { width: 864, height: 1152 },
};

const DEFAULT_SIZE = { width: 1024, height: 1024 };

// ---------------------------------------------------------------------------
// 通用
// ---------------------------------------------------------------------------

function formatTime(ts: number | null): string {
  const d = new Date(ts ?? 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function clip(text: string | null | undefined, max = 200): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** images 根目录下的 ref → 绝对路径（防目录穿越），不存在时返回 null。 */
export function libraryAbsPath(ref: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const base = getImagesBaseDir();
  const abs = path.resolve(base, trimmed);
  if (!abs.startsWith(base + path.sep)) return null;
  return existsSync(abs) ? abs : null;
}

function libraryRefOf(abs: string): string {
  return toPosix(path.relative(getImagesBaseDir(), abs));
}

type Asset = { kind: MediaKind; ref: string; absPath: string };

function imageRefById(id: number): string | null {
  const row = db.select().from(imageRecords).where(eq(imageRecords.id, id)).get();
  return row?.imagePath ?? null;
}

function videoRefById(id: number): string | null {
  const row = db.select().from(videoRecords).where(eq(videoRecords.id, id)).get();
  return row?.videoPath ?? null;
}

function audioRefById(id: number): string | null {
  const row = db.select().from(voiceRecords).where(eq(voiceRecords.id, id)).get();
  return row?.audioPath ?? null;
}

/**
 * 解析一个素材引用：支持 media_search 给出的 ref、`image#12` / `video#3` /
 * `audio#7` 句柄，以及 images 目录内的绝对路径。解析不到返回 null。
 */
function resolveAssetRef(input: string): Asset | null {
  const trimmed = input?.trim();
  if (!trimmed) return null;

  const direct = libraryAbsPath(trimmed);
  if (direct) {
    const kind = kindOfRef(libraryRefOf(direct));
    return kind ? { kind, ref: libraryRefOf(direct), absPath: direct } : null;
  }

  const byId = /^(?:(image|video|audio)\s*)?#?\s*(\d+)$/.exec(trimmed);
  if (byId) {
    const kind = (byId[1] ?? "image") as MediaKind;
    const ref =
      kind === "image"
        ? imageRefById(Number(byId[2]))
        : kind === "video"
          ? videoRefById(Number(byId[2]))
          : audioRefById(Number(byId[2]));
    const abs = ref ? libraryAbsPath(ref) : null;
    if (abs && ref) return { kind, ref, absPath: abs };
  }
  return null;
}

/** 按子目录判断素材类型（gen/edit/chat = 图片，videos = 视频，audio = 语音）。 */
function kindOfRef(ref: string): MediaKind | null {
  if (ref.startsWith("videos/")) return "video";
  if (ref.startsWith("audio/")) return "audio";
  if (ref.startsWith("gen/") || ref.startsWith("edit/") || ref.startsWith("chat/")) return "image";
  return null;
}

/**
 * 取生成时的参考图 ref。除了库里的素材，还接受工作区内的图片文件
 * （自动暂存进 images/edit/in/）——用户自己放进工作区的图也能被复用。
 */
async function resolveReferenceRef(
  ctx: ToolContext,
  input: string,
): Promise<string | null> {
  const asset = resolveAssetRef(input);
  if (asset) {
    if (asset.kind !== "image") return null;
    return asset.ref;
  }
  try {
    const abs = resolvePath(ctx.workspace, input);
    if (!existsSync(abs)) return null;
    const [staged] = await ImageGen.stageEditImage([abs]);
    return staged?.ref ?? null;
  } catch {
    return null;
  }
}

/** ref → 工作区内的相对路径（不存在自动创建目录）；失败返回 null。 */
function copyIntoWorkspace(opts: {
  workspace: string;
  saveTo: string;
  srcAbs: string;
  kind: MediaKind;
  name?: string;
  used: Set<string>;
}): string | null {
  const dir = resolvePath(opts.workspace, opts.saveTo);
  assertInsideWorkspace(opts.workspace, dir);
  mkdirSync(dir, { recursive: true });

  const ext = path.extname(opts.srcAbs) || (opts.kind === "image" ? ".png" : ".mp4");
  const requested = opts.name?.trim() ? path.basename(opts.name.trim()) : "";
  const fileName = requested
    ? requested
    : nextFreeName(dir, KIND_PREFIX[opts.kind], ext, opts.used);

  const dest = path.join(dir, fileName);
  assertInsideWorkspace(opts.workspace, dest);
  copyFileSync(opts.srcAbs, dest);
  opts.used.add(fileName);
  return toPosix(path.relative(path.resolve(opts.workspace), dest));
}

/** 生成不与现有文件重名的 `前缀-N.扩展名`。 */
function nextFreeName(dir: string, prefix: string, ext: string, used: Set<string>): string {
  const pattern = new RegExp(`^${prefix}-(\\d+)${ext.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  let next = 1;
  for (const entry of readdirSync(dir)) {
    const m = pattern.exec(entry);
    if (m) next = Math.max(next, Number(m[1]) + 1);
  }
  while (used.has(`${prefix}-${next}${ext}`)) next += 1;
  return `${prefix}-${next}${ext}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

// ---------------------------------------------------------------------------
// media_search
// ---------------------------------------------------------------------------

export type MediaItem = {
  kind: MediaKind;
  id: number;
  ref: string;
  createdAt: number | null;
  source: MediaSource;
  /** 尺寸 / 时长 / 模型等一行摘要。 */
  meta: string;
  /** 图片与视频的提示词，或语音所读的文本。 */
  caption: string | null;
  /** 状态（非 done 时才展示）。 */
  statusNote?: string | null;
};

function searchImages(
  keyword: string | null,
  source: MediaSource | "all",
  since: number | null,
  limit: number,
): MediaItem[] {
  const conds = [eq(imageRecords.status, "done")];
  if (source !== "all") conds.push(eq(imageRecords.source, source));
  if (since) conds.push(gte(imageRecords.createdAt, since));
  if (keyword) {
    const match = or(
      like(imageRecords.prompt, `%${keyword}%`),
      like(imageRecords.model, `%${keyword}%`),
    );
    if (match) conds.push(match);
  }
  return db
    .select()
    .from(imageRecords)
    .where(and(...conds))
    .orderBy(desc(imageRecords.id))
    .limit(limit)
    .all()
    .flatMap((r) => {
      if (!r.imagePath) return [];
      const dims = r.width && r.height ? `${r.width}x${r.height}` : null;
      const meta = [dims, r.model, r.backend].filter(Boolean).join(" · ");
      return [
        {
          kind: "image" as const,
          id: r.id,
          ref: r.imagePath,
          createdAt: r.createdAt,
          source: r.source,
          meta,
          caption: clip(r.prompt),
        },
      ];
    });
}

function searchVideos(
  keyword: string | null,
  source: MediaSource | "all",
  since: number | null,
  limit: number,
): MediaItem[] {
  const conds: SQL[] = [];
  if (source !== "all") conds.push(eq(videoRecords.source, source));
  if (since) conds.push(gte(videoRecords.createdAt, since));
  if (keyword) {
    const match = or(
      like(videoRecords.prompt, `%${keyword}%`),
      like(videoRecords.model, `%${keyword}%`),
    );
    if (match) conds.push(match);
  }
  const where = conds.length > 0 ? and(...conds) : undefined;
  return db
    .select()
    .from(videoRecords)
    .where(where)
    .orderBy(desc(videoRecords.id))
    .limit(limit)
    .all()
    .flatMap((r) => {
      if (!r.videoPath) return [];
      const meta = [
        r.duration ? `${r.duration}s` : null,
        r.ratio,
        r.resolution,
        r.model,
      ]
        .filter(Boolean)
        .join(" · ");
      return [
        {
          kind: "video" as const,
          id: r.id,
          ref: r.videoPath,
          createdAt: r.createdAt,
          source: r.source,
          meta,
          caption: clip(r.prompt),
          statusNote: r.status === "done" ? null : r.status === "processing" ? "生成中" : "生成失败",
        },
      ];
    });
}

function searchAudio(
  keyword: string | null,
  source: MediaSource | "all",
  since: number | null,
  limit: number,
): MediaItem[] {
  const conds = [eq(voiceRecords.kind, "tts")];
  if (source !== "all") conds.push(eq(voiceRecords.source, source));
  if (since) conds.push(gte(voiceRecords.createdAt, since));
  if (keyword) {
    const match = or(
      like(voiceRecords.text, `%${keyword}%`),
      like(voiceRecords.model, `%${keyword}%`),
      like(voiceRecords.voice, `%${keyword}%`),
    );
    if (match) conds.push(match);
  }
  return db
    .select()
    .from(voiceRecords)
    .where(and(...conds))
    .orderBy(desc(voiceRecords.id))
    .limit(limit)
    .all()
    .flatMap((r) => {
      if (!r.audioPath) return [];
      const meta = [r.model, r.voice, r.durationMs ? `${Math.round(r.durationMs / 1000)}s` : null]
        .filter(Boolean)
        .join(" · ");
      return [
        {
          kind: "audio" as const,
          id: r.id,
          ref: r.audioPath,
          createdAt: r.createdAt,
          source: r.source,
          meta,
          caption: clip(r.text),
        },
      ];
    });
}

function formatItems(items: MediaItem[]): string {
  return items
    .map((item, i) => {
      const head = [
        `[${i + 1}] ${KIND_LABEL[item.kind]} #${item.id}`,
        formatTime(item.createdAt),
        SOURCE_LABEL[item.source],
        item.meta,
        item.statusNote,
      ]
        .filter(Boolean)
        .join(" · ");
      const lines = [head];
      if (item.caption) {
        lines.push(`  ${item.kind === "audio" ? "文本" : "提示词"}：${item.caption}`);
      }
      lines.push(`  ref: ${item.ref}`);
      const abs = libraryAbsPath(item.ref);
      if (abs) lines.push(`  文件: ${abs}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

const REUSE_HINT =
  "复用方式：把 ref 传给 generate_image 的 reference（以图改图）、generate_video 的 first_frame（图生视频），" +
  "或用 media_export 复制到工作区后用相对路径引用。这些都是二进制文件，不要用 read_file 打开。";

/** 素材库总量概览：先让 Agent 知道"积累了多少东西"，而不是只看当前这一页。 */
function libraryOverviewText(): string | null {
  const images = db
    .select({ n: count() })
    .from(imageRecords)
    .where(eq(imageRecords.status, "done"))
    .get()?.n ?? 0;
  const videos = db
    .select({ n: count() })
    .from(videoRecords)
    .where(eq(videoRecords.status, "done"))
    .get()?.n ?? 0;
  const audio = db
    .select({ n: count() })
    .from(voiceRecords)
    .where(eq(voiceRecords.kind, "tts"))
    .get()?.n ?? 0;
  const total = images + videos + audio;
  if (total === 0) return null;
  const agentMade =
    (db
      .select({ n: count() })
      .from(imageRecords)
      .where(and(eq(imageRecords.status, "done"), eq(imageRecords.source, "agent")))
      .get()?.n ?? 0) +
    (db
      .select({ n: count() })
      .from(videoRecords)
      .where(and(eq(videoRecords.status, "done"), eq(videoRecords.source, "agent")))
      .get()?.n ?? 0) +
    (db
      .select({ n: count() })
      .from(voiceRecords)
      .where(and(eq(voiceRecords.kind, "tts"), eq(voiceRecords.source, "agent")))
      .get()?.n ?? 0);
  return `素材库一共 ${total} 项（图片 ${images} / 语音 ${audio} / 视频 ${videos}），其中 Agent 生成 ${agentMade} 项。`;
}

export type MediaSearchParams = {
  query?: string;
  kind?: string;
  source?: string;
  days?: number;
  limit?: number;
};

export type MediaSearchOutcome = {
  /** 本次返回的素材（已按时间倒序、已截断到 limit）。 */
  items: MediaItem[];
  /** 直接可读的文本结果（内置工具与 MCP / REST 共用同一份排版）。 */
  text: string;
};

/**
 * 检索素材库：内置 Agent 工具、网关 MCP 与 REST 共用这一份实现，
 * 保证三处口径一致（同样的过滤、同样的日期与 ref 排版）。
 */
export function searchMediaLibrary(params: MediaSearchParams = {}): MediaSearchOutcome {
  const keyword = params.query?.trim() ? params.query.trim() : null;
  const limit = Math.max(1, Math.min(Math.floor(params.limit ?? DEFAULT_LIMIT), MAX_LIMIT));
  const source: MediaSource | "all" =
    params.source === "manual" || params.source === "agent" ? params.source : "all";
  const days = Number(params.days);
  const since = Number.isFinite(days) && days > 0 ? Date.now() - days * 86_400_000 : null;
  const kind = params.kind?.trim().toLowerCase();

  const items: MediaItem[] = [];
  if (!kind || kind === "all" || kind === "image") {
    items.push(...searchImages(keyword, source, since, limit));
  }
  if (!kind || kind === "all" || kind === "video") {
    items.push(...searchVideos(keyword, source, since, limit));
  }
  if (!kind || kind === "all" || kind === "audio") {
    items.push(...searchAudio(keyword, source, since, limit));
  }

  items.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  const top = items.slice(0, limit);
  const overview = libraryOverviewText();

  if (top.length === 0) {
    const head = keyword
      ? `没有匹配「${keyword}」的素材。可以去掉 query 看看最近的素材，或用 generate_image / generate_speech / generate_video 现做。`
      : "素材库还是空的：用户还没有生成过图片 / 语音 / 视频。";
    return { items: top, text: overview ? `${head}\n${overview}` : head };
  }

  const counts = top.reduce<Record<string, number>>((acc, item) => {
    acc[KIND_LABEL[item.kind]] = (acc[KIND_LABEL[item.kind]] ?? 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(counts)
    .map(([label, n]) => `${label} ${n}`)
    .join(" / ");
  const header = [`最近素材 ${top.length} 条（${summary}）：`];
  if (overview) header.push(overview);
  return {
    items: top,
    text: [...header, "", formatItems(top), "", REUSE_HINT].join("\n"),
  };
}

function createMediaSearch(): BuiltTool {
  return {
    name: "media_search",
    label: "Search media library",
    description:
      "Look up the media assets that already exist in OmniStudio: images, speech (TTS) and videos — " +
      "both the ones the user generated by hand in the app and the ones generated by agents. " +
      "Use it before generating anything new (to reuse existing material), and when the user refers to " +
      "something they made earlier (\"我上次生成的那张图\"). Results are newest-first with dates, prompts, refs and file paths.",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({ description: "Keywords matched against prompts / spoken text / model names. Omit to list what was made recently." }),
      ),
      kind: Type.Optional(
        Type.String({ description: 'Restrict to one kind: "image" | "video" | "audio". Default: all.' }),
      ),
      source: Type.Optional(
        Type.String({ description: 'Restrict by origin: "manual" (the user made it in the UI) | "agent". Default: all.' }),
      ),
      days: Type.Optional(Type.Number({ description: "Only assets created within the last N days." })),
      limit: Type.Optional(Type.Number({ description: `Max items (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` })),
    }),
    execute: async (
      _toolCallId,
      params: { query?: string; kind?: string; source?: string; days?: number; limit?: number },
    ) => {
      try {
        return textResult(searchMediaLibrary(params).text);
      } catch (e) {
        return errorResult(`media_search failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// media_export
// ---------------------------------------------------------------------------

function createMediaExport(ctx: ToolContext): BuiltTool {
  return {
    name: "media_export",
    label: "Export media into workspace",
    description:
      "Copy existing media assets (from media_search) into the workspace so they can be referenced by relative " +
      "path from the document / page you are writing. Use this to reuse images, audio or video the user already has " +
      "instead of generating them again.",
    parameters: Type.Object({
      refs: Type.Array(Type.String(), {
        description: "Asset handles from media_search: refs like `gen/xxx.png`, or `image#12` / `video#3` / `audio#7`.",
      }),
      save_to: Type.String({ description: 'Workspace-relative target directory, e.g. "assets".' }),
      name: Type.Optional(
        Type.String({
          description:
            "Optional file name when exporting exactly one asset, e.g. `cover.png`. An existing file with the same name is overwritten.",
        }),
      ),
    }),
    executionMode: "sequential",
    execute: async (
      _toolCallId,
      params: { refs: string[]; save_to: string; name?: string },
    ) => {
      try {
        const refs = (params.refs ?? []).filter((r) => typeof r === "string" && r.trim());
        if (refs.length === 0) return errorResult("refs 不能为空：先用 media_search 拿到素材的 ref。");
        if (!params.save_to?.trim()) return errorResult("save_to 不能为空（工作区内的目标目录）。");

        const used = new Set<string>();
        const copied: string[] = [];
        const missing: string[] = [];
        for (const input of refs) {
          const asset = resolveAssetRef(input);
          if (!asset) {
            missing.push(input);
            continue;
          }
          const rel = copyIntoWorkspace({
            workspace: ctx.workspace,
            saveTo: params.save_to.trim(),
            srcAbs: asset.absPath,
            kind: asset.kind,
            name: refs.length === 1 ? params.name : undefined,
            used,
          });
          if (rel) {
            copied.push(`${KIND_LABEL[asset.kind]} ${asset.ref} → ${rel}`);
            // 复制进工作区也算一次「产出」：产出物面板里能看到它。
            ctx.recordArtifact?.(rel, "media_export");
          }
        }

        const lines: string[] = [];
        if (copied.length > 0) {
          lines.push(`已复制 ${copied.length} 个素材到工作区：`, ...copied.map((c) => `- ${c}`));
          lines.push(
            "",
            "在 Markdown 里直接引用这些相对路径即可：" +
              copied
                .map((c) => c.split("→ ")[1])
                .filter(Boolean)
                .join("、"),
          );
        }
        if (missing.length > 0) {
          lines.push("", `找不到这些素材：${missing.join("、")}（用 media_search 重新确认 ref）。`);
        }
        return copied.length > 0 ? textResult(lines.join("\n")) : errorResult(lines.join("\n"));
      } catch (e) {
        return errorResult(`media_export failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// generate_image
// ---------------------------------------------------------------------------

function resolveImageSize(
  aspect?: string,
  width?: number,
  height?: number,
): { width: number; height: number } {
  const w = Number(width);
  const h = Number(height);
  // 只给了一边时，另一边沿用默认边长，而不是把这一边也丢掉。
  if (w > 0 || h > 0) {
    return {
      width: w > 0 ? Math.floor(w) : DEFAULT_SIZE.width,
      height: h > 0 ? Math.floor(h) : DEFAULT_SIZE.height,
    };
  }
  const ratio = aspect?.trim();
  if (ratio) {
    const size = ASPECT_SIZES[ratio];
    if (size) return size;
  }
  return DEFAULT_SIZE;
}

function createGenerateImage(ctx: ToolContext): BuiltTool {
  return {
    name: "generate_image",
    label: "Generate image",
    description:
      "Generate image(s) with the image backend already configured in OmniStudio (local MLX / OpenAI-compatible API / ComfyUI). " +
      "If the backend or model is not set up yet, a dialog pops up asking the user to configure it and to pick a model — " +
      "wait for their confirmation instead of guessing, and never retry by yourself when the user cancels. " +
      "Results are stored in the media library (findable later via media_search). " +
      "When illustrating a document, pass `save_to` so the files are copied next to your text and can be referenced by relative path. " +
      "Note: cloud backends may cost money and take a while; prefer reusing an existing asset via media_search when possible.",
    parameters: Type.Object({
      prompt: Type.String({
        description: "What to draw — subject, style, lighting, composition. Be specific and visual.",
      }),
      negative_prompt: Type.Optional(Type.String({ description: "What to avoid in the image." })),
      count: Type.Optional(Type.Number({ description: "How many images to generate (1-8, default 1)." })),
      aspect_ratio: Type.Optional(
        Type.String({ description: `Aspect ratio: ${Object.keys(ASPECT_SIZES).join(" | ")}. Default 1:1.` }),
      ),
      width: Type.Optional(Type.Number({ description: "Explicit width in pixels (with height, overrides aspect_ratio)." })),
      height: Type.Optional(Type.Number({ description: "Explicit height in pixels." })),
      model: Type.Optional(Type.String({ description: "Model / checkpoint id override. Usually omit to use the configured default." })),
      reference: Type.Optional(
        Type.String({
          description:
            "Existing image to edit or restyle: a media_search ref, `image#12`, or a workspace file path. " +
            "Only supported by the OpenAI-compatible backend.",
        }),
      ),
      seed: Type.Optional(Type.Number({ description: "Seed for reproducible results." })),
      save_to: Type.Optional(
        Type.String({ description: 'Workspace-relative directory to copy the results into, e.g. "assets". Omit to keep them in the media library only.' }),
      ),
    }),
    executionMode: "sequential",
    execute: async (
      _toolCallId,
      params: {
        prompt: string;
        negative_prompt?: string;
        count?: number;
        aspect_ratio?: string;
        width?: number;
        height?: number;
        model?: string;
        reference?: string;
        seed?: number;
        save_to?: string;
      },
      signal?: AbortSignal,
    ) => {
      try {
        const size = resolveImageSize(params.aspect_ratio, params.width, params.height);
        const count = Math.max(1, Math.min(Math.floor(params.count ?? 1), 8));
        let referenceImageRef: string | undefined;
        if (params.reference?.trim()) {
          const ref = await resolveReferenceRef(ctx, params.reference.trim());
          if (!ref) {
            return errorResult(
              `找不到参考图：${params.reference}。用 media_search 拿 ref，或给工作区内图片的相对路径。`,
            );
          }
          referenceImageRef = ref;
        }

        // 后端没配好 / 没选模型 / 本地模型没下载时，先弹窗让用户配好并确认；
        // 用户没指定模型时，扫到的候选超过一个会再弹一次确认用哪个生图。
        const prep = await prepareImageGeneration({ signal, explicitModel: params.model });
        if (!prep.ok) return errorResult(prep.message);

        const { records, error } = await ImageGen.generateImage({
          prompt: params.prompt,
          negativePrompt: params.negative_prompt,
          width: size.width,
          height: size.height,
          count,
          model: params.model ?? prep.model,
          seed: params.seed,
          referenceImageRef,
          // 不改写用户在「图像」页保存的配置。
          persistConfig: false,
          source: "agent",
        });
        if (signal?.aborted) return errorResult("已中断。");
        if (error || records.length === 0) {
          return errorResult(
            `生图失败：${error ?? "未返回图片"}\n` +
              "提示：生图后端与模型在应用「图像」页配置；本地 MLX 需要先下载引擎和模型。",
          );
        }

        const done = records.filter((r) => r.imagePath);
        const lines = [
          `已生成 ${done.length} 张图片（${size.width}x${size.height}，后端 ${done[0]?.backend ?? "-"}，模型 ${done[0]?.model ?? "-"}）：`,
        ];
        for (const [i, record] of done.entries()) {
          lines.push(`- [${i + 1}] #${record.id} ref: ${record.imagePath}`);
        }
        if (params.save_to?.trim() && done.length > 0) {
          const used = new Set<string>();
          const copied: string[] = [];
          for (const record of done) {
            const abs = record.imagePath ? libraryAbsPath(record.imagePath) : null;
            if (!abs) continue;
            const rel = copyIntoWorkspace({
              workspace: ctx.workspace,
              saveTo: params.save_to.trim(),
              srcAbs: abs,
              kind: "image",
              used,
            });
            if (rel) {
              copied.push(rel);
              ctx.recordArtifact?.(rel, "generate_image");
            }
          }
          if (copied.length > 0) {
            lines.push("", `已复制到工作区：${copied.join("、")}`);
            lines.push(`Markdown 引用示例：![插图](${copied[0]})`);
          }
        }
        return textResult(lines.join("\n"));
      } catch (e) {
        return errorResult(`generate_image failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// generate_speech
// ---------------------------------------------------------------------------

/** 按引擎链合成语音：auto = 本地 audio.cpp → 三方 Provider → Edge 在线。 */
async function synthesizeSpeech(input: {
  text: string;
  voice?: string;
  model?: string;
  engine: "auto" | "local" | "provider" | "edge";
}): Promise<{ record?: Voice.VoiceRecordRow; error?: string }> {
  const attempts: string[] = [];
  const order: ("local" | "provider" | "edge")[] =
    input.engine === "auto" ? ["local", "provider", "edge"] : [input.engine];

  for (const engine of order) {
    try {
      if (engine === "local") {
        if (!TtsLocal.isTtsLocalActive()) {
          attempts.push("本地引擎未启动");
          continue;
        }
        return {
          record: await TtsLocal.runTTSLocal({
            text: input.text,
            voice: input.voice,
            model: input.model,
            source: "agent",
          }),
        };
      }
      if (engine === "provider") {
        if (!Voice.getTTSProviderConfig().base) {
          attempts.push("未配置三方 TTS Provider");
          continue;
        }
        return {
          record: await Voice.runTTS({
            text: input.text,
            voice: input.voice,
            model: input.model,
            source: "agent",
          }),
        };
      }
      return {
        record: await Voice.runTTSEdge({ text: input.text, voice: input.voice ?? "", source: "agent" }),
      };
    } catch (e) {
      attempts.push(`${engine}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { error: attempts.join("；") || "没有可用的 TTS 引擎" };
}

function createGenerateSpeech(ctx: ToolContext): BuiltTool {
  return {
    name: "generate_speech",
    label: "Generate speech",
    description:
      "Turn text into a speech audio file using the TTS engines configured in OmniStudio: the local audio.cpp engine, " +
      "a third-party OpenAI-compatible provider, or the free online Edge TTS (tried in that order). " +
      "The audio is stored in the media library (findable via media_search). Long scripts should be split into a few calls.",
    parameters: Type.Object({
      text: Type.String({ description: "Text to speak. Keep each call under ~2000 characters for best results." }),
      voice: Type.Optional(
        Type.String({
          description: 'Voice id or clone name, e.g. "zh-CN-XiaoxiaoNeural" for Edge TTS. Omit to use the configured default voice.',
        }),
      ),
      model: Type.Optional(Type.String({ description: "TTS model id override (local catalog id or provider model)." })),
      engine: Type.Optional(
        Type.String({ description: 'Which engine to use: "auto" (default) | "local" | "provider" | "edge".' }),
      ),
      save_to: Type.Optional(
        Type.String({ description: 'Workspace-relative directory to copy the audio into, e.g. "assets".' }),
      ),
    }),
    executionMode: "sequential",
    execute: async (
      _toolCallId,
      params: { text: string; voice?: string; model?: string; engine?: string; save_to?: string },
      signal?: AbortSignal,
    ) => {
      try {
        const text = params.text?.trim() ?? "";
        if (!text) return errorResult("text 不能为空。");
        if (text.length > MAX_SPEECH_CHARS) {
          return errorResult(
            `文本太长（${text.length} 字，上限 ${MAX_SPEECH_CHARS}）。请分段多次调用 generate_speech。`,
          );
        }
        const engine =
          params.engine === "local" || params.engine === "provider" || params.engine === "edge"
            ? params.engine
            : "auto";
        const { record, error } = await synthesizeSpeech({
          text,
          voice: params.voice,
          model: params.model,
          engine,
        });
        if (signal?.aborted) return errorResult("已中断。");
        if (error || !record) {
          return errorResult(
            `语音合成失败：${error ?? "未知错误"}\n` +
              "提示：本地引擎需在「本地引擎 → TTS」启动并下载模型；三方 Provider 在「语音」页配置。",
          );
        }
        const lines = [
          `已合成语音（引擎 ${record.model ?? "-"}，音色 ${record.voice || "默认"}）：`,
          `- #${record.id} ref: ${record.audioPath ?? "-"}`,
        ];
        if (params.save_to?.trim() && record.audioPath) {
          const abs = libraryAbsPath(record.audioPath);
          if (abs) {
            const rel = copyIntoWorkspace({
              workspace: ctx.workspace,
              saveTo: params.save_to.trim(),
              srcAbs: abs,
              kind: "audio",
              used: new Set<string>(),
            });
            if (rel) {
              lines.push("", `已复制到工作区：${rel}`);
              ctx.recordArtifact?.(rel, "generate_speech");
            }
          }
        }
        return textResult(lines.join("\n"));
      } catch (e) {
        return errorResult(`generate_speech failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// generate_video
// ---------------------------------------------------------------------------

function createGenerateVideo(ctx: ToolContext): BuiltTool {
  return {
    name: "generate_video",
    label: "Generate video",
    description:
      "Generate a video with the backend configured in OmniStudio (MiniMax / Seedance cloud, or a local ComfyUI Wan workflow). " +
      "Video generation is asynchronous and usually takes 1-5 minutes, so this tool submits the job and waits for it. " +
      "Cloud backends cost money — only use it when the user actually asked for a video.",
    parameters: Type.Object({
      prompt: Type.String({ description: "What the video should show, including camera and motion." }),
      aspect_ratio: Type.Optional(Type.String({ description: 'Aspect ratio, e.g. "16:9" | "9:16" | "1:1". Default 16:9.' })),
      duration: Type.Optional(Type.Number({ description: "Duration in seconds (cloud backends: 4-15)." })),
      resolution: Type.Optional(Type.String({ description: 'Resolution, e.g. "768P" | "1080p".' })),
      model: Type.Optional(Type.String({ description: "Model id override. Usually omit." })),
      first_frame: Type.Optional(
        Type.String({
          description:
            "Image used as the first frame (image-to-video): a media_search ref, `image#12`, or a workspace image path.",
        }),
      ),
      seed: Type.Optional(Type.Number({ description: "Seed for reproducible results." })),
      save_to: Type.Optional(
        Type.String({ description: 'Workspace-relative directory to copy the finished video into, e.g. "assets".' }),
      ),
      timeout_seconds: Type.Optional(
        Type.Number({ description: `How long to wait for the result (default 600, max ${MAX_VIDEO_TIMEOUT_MS / 1000}).` }),
      ),
    }),
    executionMode: "sequential",
    execute: async (
      _toolCallId,
      params: {
        prompt: string;
        aspect_ratio?: string;
        duration?: number;
        resolution?: string;
        model?: string;
        first_frame?: string;
        seed?: number;
        save_to?: string;
        timeout_seconds?: number;
      },
      signal?: AbortSignal,
    ) => {
      try {
        let firstFrameRef: string | undefined;
        if (params.first_frame?.trim()) {
          const ref = await resolveReferenceRef(ctx, params.first_frame.trim());
          if (!ref) {
            return errorResult(
              `找不到首帧图：${params.first_frame}。"用 media_search 拿 ref，或给工作区内图片的相对路径。`,
            );
          }
          firstFrameRef = ref;
        }

        const submitted = await VideoGen.submitVideoGeneration({
          prompt: params.prompt,
          ratio: params.aspect_ratio,
          duration: params.duration,
          resolution: params.resolution,
          model: params.model,
          firstFrameRef,
          seed: params.seed,
          source: "agent",
        });
        if (submitted.error || !submitted.record) {
          return errorResult(
            `视频提交失败：${submitted.error ?? "未知错误"}\n` +
              "提示：视频后端与密钥在应用「视频」页配置。",
          );
        }

        const timeoutMs = Math.min(
          Math.max(Math.floor((params.timeout_seconds ?? DEFAULT_VIDEO_TIMEOUT_MS / 1000) * 1000), 30_000),
          MAX_VIDEO_TIMEOUT_MS,
        );
        const deadline = Date.now() + timeoutMs;
        let record = submitted.record;
        while (record.status === "processing" && Date.now() < deadline) {
          await sleep(5_000, signal);
          if (signal?.aborted) break;
          const [next] = await VideoGen.pollVideoRecords([record.id]);
          if (!next || next.status !== "processing") {
            record = next ?? record;
            break;
          }
          record = next;
        }

        if (record.status === "processing") {
          return textResult(
            signal?.aborted
              ? `已中断等待。视频 #${record.id} 仍在上游生成，产物会自动入库，之后可以用 media_search 找到。`
              : `等待超时（${Math.round(timeoutMs / 1000)}s）。视频 #${record.id} 仍在上游生成，` +
                "产物会自动入库；可以稍后用 media_search 检索，不要在本次回答里假定它已经完成。",
          );
        }
        if (record.status === "failed") {
          return errorResult(`视频生成失败：${record.error ?? "上游返回失败"}`);
        }

        const lines = [
          `视频已生成（${record.duration ?? "-"}s，${record.ratio ?? "-"}，模型 ${record.model ?? "-"}）：`,
          `- #${record.id} ref: ${record.videoPath ?? "-"}`,
        ];
        if (params.save_to?.trim() && record.videoPath) {
          const abs = libraryAbsPath(record.videoPath);
          if (abs) {
            const rel = copyIntoWorkspace({
              workspace: ctx.workspace,
              saveTo: params.save_to.trim(),
              srcAbs: abs,
              kind: "video",
              used: new Set<string>(),
            });
            if (rel) {
              lines.push("", `已复制到工作区：${rel}`);
              ctx.recordArtifact?.(rel, "generate_video");
            }
          }
        }
        return textResult(lines.join("\n"));
      } catch (e) {
        return errorResult(`generate_video failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 工具集
// ---------------------------------------------------------------------------

/** 只读的素材检索：Plan / Agent / Goal 三模式都可用。 */
export function buildMediaReadTools(): BuiltTool[] {
  return [createMediaSearch()];
}

/**
 * 会写文件、且可能调用付费云端的工具：只在 Agent / Goal 模式下提供，
 * 不给"只出方案不动手"的 Plan 模式。
 */
export function buildMediaGenTools(ctx: ToolContext): BuiltTool[] {
  return [
    createGenerateImage(ctx),
    createGenerateSpeech(ctx),
    createGenerateVideo(ctx),
    createMediaExport(ctx),
  ];
}
