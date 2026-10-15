/**
 * 无限画布的文档持久化（`canvas_docs` 表）。
 *
 * 职责刻意地薄：节点 / 连线 / 视口的**唯一作者是 webview**，这里只做
 * 形状校验（shared/canvas.ts 的上限与 ref 规则）后整份存 JSON。校验放在
 * 主进程而不是只靠前端，是因为数据还会走控制 socket / 备份恢复等入口，
 * 坏载荷进来一次，画布页就再也打不开了。
 */
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { desc, eq } from "drizzle-orm";

import { db } from "./db";
import { canvasDocs } from "./db/schema";
import { logEvent } from "./app-log";
import { getImagesBaseDir } from "./image-server";
import {
  CANVAS_DEFAULT_VIEWPORT,
  CANVAS_LIMITS,
  isCanvasMediaRef,
  type CanvasConnectionData,
  type CanvasDocPayload,
  type CanvasDocSummary,
  type CanvasModelChoice,
  type CanvasNodeData,
  type CanvasViewport,
} from "../shared/canvas";

// RPC 契约直接引用这里的类型（`Canvas.CanvasDocSummary` 等），统一从 shared 取。
export * from "../shared/canvas";

type SavePatch = {
  title?: unknown;
  nodes?: unknown;
  connections?: unknown;
  viewport?: unknown;
};

function clampText(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/** 节点校验：未知 kind / 坏坐标 / 超限文本一律修到合法值，不抛错（保存不能整单失败）。 */
function sanitizeNode(raw: unknown): CanvasNodeData | null {
  if (typeof raw !== "object" || raw === null) return null;
  const n = raw as Record<string, unknown>;
  const kind = n.kind;
  if (kind !== "text" && kind !== "image" && kind !== "video" && kind !== "music" && kind !== "audio") return null;
  const num = (v: unknown, fallback: number, lo: number, hi: number) => {
    const x = typeof v === "number" && Number.isFinite(v) ? v : fallback;
    return Math.min(Math.max(x, lo), hi);
  };
  const modelRaw = n.model;
  const model = (() => {
    if (typeof modelRaw !== "object" || modelRaw === null) return undefined;
    const m = modelRaw as { source?: unknown; model?: unknown; providerId?: unknown };
    if (m.source !== "local" && m.source !== "cloud") return undefined;
    const modelId = typeof m.model === "string" ? m.model.trim().slice(0, 400) : "";
    if (!modelId) return undefined;
    const choice: CanvasModelChoice = { source: m.source, model: modelId };
    if (typeof m.providerId === "string" && m.providerId) choice.providerId = m.providerId.slice(0, 120);
    return choice;
  })();
  const refKeys = ["resultRef"] as const;
  /** 可选数值：非法就当作"没设"。 */
  const optNum = (v: unknown, lo: number, hi: number): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : undefined;
  const optText = (v: unknown, max: number): string | undefined => {
    if (typeof v !== "string") return undefined;
    const text = v.slice(0, max);
    return text.length > 0 ? text : undefined;
  };
  const optRef = (v: unknown): string | undefined => (isCanvasMediaRef(v) ? v : undefined);

  const node: CanvasNodeData = {
    id: clampText(n.id, 64).replace(/[^A-Za-z0-9_-]/g, "") || `n${Math.random().toString(36).slice(2, 10)}`,
    kind,
    title: clampText(n.title, CANVAS_LIMITS.titleChars) || "未命名",
    x: num(n.x, 0, -1_000_000, 1_000_000),
    y: num(n.y, 0, -1_000_000, 1_000_000),
    width: num(n.width, 320, 80, 8000),
    height: num(n.height, 240, 80, 8000),
    prompt: clampText(n.prompt, CANVAS_LIMITS.promptChars),
    ...(model ? { model } : {}),
    ...(typeof n.voice === "string" && n.voice ? { voice: clampText(n.voice, 200) } : {}),
    ...(n.instrumental === true ? { instrumental: true } : {}),
    status: n.status === "loading" || n.status === "success" || n.status === "error" ? n.status : "idle",
    ...(typeof n.error === "string" && n.error ? { error: clampText(n.error, 2000) } : {}),
    resultText: clampText(n.resultText, CANVAS_LIMITS.resultTextChars),
    // 生图 / 视频 / 音乐 / 语音的参数：逐项夹到合法区间，坏的当作未设置。
    ...(optNum(n.imgWidth, 64, 4096) !== undefined ? { imgWidth: optNum(n.imgWidth, 64, 4096) } : {}),
    ...(optNum(n.imgHeight, 64, 4096) !== undefined ? { imgHeight: optNum(n.imgHeight, 64, 4096) } : {}),
    ...(optNum(n.count, 1, 8) !== undefined ? { count: optNum(n.count, 1, 8) } : {}),
    ...(optNum(n.steps, 1, 100) !== undefined ? { steps: optNum(n.steps, 1, 100) } : {}),
    ...(optNum(n.seed, 0, 2 ** 31 - 1) !== undefined ? { seed: optNum(n.seed, 0, 2 ** 31 - 1) } : {}),
    ...(optText(n.negativePrompt, CANVAS_LIMITS.textChars) ? { negativePrompt: optText(n.negativePrompt, CANVAS_LIMITS.textChars) } : {}),
    ...(optNum(n.quantize, 0, 8) !== undefined ? { quantize: optNum(n.quantize, 0, 8) } : {}),
    ...(optRef(n.refImageRef) ? { refImageRef: optRef(n.refImageRef) } : {}),
    ...(optNum(n.duration, 1, 60) !== undefined ? { duration: optNum(n.duration, 1, 60) } : {}),
    ...(optText(n.ratio, 20) ? { ratio: optText(n.ratio, 20) } : {}),
    ...(optText(n.resolution, 20) ? { resolution: optText(n.resolution, 20) } : {}),
    ...(n.watermark === true ? { watermark: true } : {}),
    ...(optNum(n.cfg, 1, 20) !== undefined ? { cfg: optNum(n.cfg, 1, 20) } : {}),
    ...(optRef(n.firstFrameRef) ? { firstFrameRef: optRef(n.firstFrameRef) } : {}),
    ...(n.musicTask === "text_to_music" || n.musicTask === "music_cover" || n.musicTask === "vocal_to_music"
      ? { musicTask: n.musicTask }
      : {}),
    ...(optText(n.lyrics, CANVAS_LIMITS.textChars) ? { lyrics: optText(n.lyrics, CANVAS_LIMITS.textChars) } : {}),
    ...(optRef(n.refAudioRef) ? { refAudioRef: optRef(n.refAudioRef) } : {}),
    ...(optText(n.responseFormat, 20) ? { responseFormat: optText(n.responseFormat, 20) } : {}),
    ...(optNum(n.sampleRate, 0, 192_000) !== undefined ? { sampleRate: optNum(n.sampleRate, 0, 192_000) } : {}),
    ...(n.ttsSource === "edge" || n.ttsSource === "compat" || n.ttsSource === "local" ? { ttsSource: n.ttsSource } : {}),
    ...(optRef(n.referenceAudioRef) ? { referenceAudioRef: optRef(n.referenceAudioRef) } : {}),
    ...(optText(n.emotion, CANVAS_LIMITS.tagChars) ? { emotion: optText(n.emotion, CANVAS_LIMITS.tagChars) } : {}),
    ...(optText(n.instruct, CANVAS_LIMITS.textChars) ? { instruct: optText(n.instruct, CANVAS_LIMITS.textChars) } : {}),
    ...(optText(n.language, CANVAS_LIMITS.tagChars) ? { language: optText(n.language, CANVAS_LIMITS.tagChars) } : {}),
    ...(optText(n.localModelId, CANVAS_LIMITS.tagChars) ? { localModelId: optText(n.localModelId, CANVAS_LIMITS.tagChars) } : {}),
  };
  for (const key of refKeys) {
    const ref = n[key];
    if (isCanvasMediaRef(ref)) node[key] = ref;
  }
  if (typeof n.recordId === "number" && Number.isInteger(n.recordId) && n.recordId > 0) {
    node.recordId = n.recordId;
  }
  if (typeof n.updatedAt === "number" && Number.isFinite(n.updatedAt)) node.updatedAt = n.updatedAt;
  return node;
}

function sanitizeNodes(raw: unknown): CanvasNodeData[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: CanvasNodeData[] = [];
  for (const item of raw.slice(0, CANVAS_LIMITS.nodes)) {
    const node = sanitizeNode(item);
    if (!node || seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
  }
  return out;
}

function sanitizeConnections(raw: unknown, nodeIds: Set<string>): CanvasConnectionData[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: CanvasConnectionData[] = [];
  for (const item of raw.slice(0, CANVAS_LIMITS.connections)) {
    if (typeof item !== "object" || item === null) continue;
    const c = item as Record<string, unknown>;
    const fromId = typeof c.fromId === "string" ? c.fromId : "";
    const toId = typeof c.toId === "string" ? c.toId : "";
    // 端点必须是画布里真实存在的节点：悬空连线在渲染层永远画不出来，只会占库。
    if (!nodeIds.has(fromId) || !nodeIds.has(toId) || fromId === toId) continue;
    const id = (typeof c.id === "string" ? c.id : "").replace(/[^A-Za-z0-9_-]/g, "");
    const key = `${fromId}->${toId}`;
    if (!id || seen.has(key)) continue;
    seen.add(key);
    out.push({ id, fromId, toId });
  }
  return out;
}

function sanitizeViewport(raw: unknown): CanvasViewport {
  if (typeof raw !== "object" || raw === null) return CANVAS_DEFAULT_VIEWPORT;
  const v = raw as Record<string, unknown>;
  const num = (x: unknown, fallback: number) => (typeof x === "number" && Number.isFinite(x) ? x : fallback);
  return {
    x: num(v.x, 0),
    y: num(v.y, 0),
    k: Math.min(Math.max(num(v.k, 1), 0.05), 4),
  };
}

function sanitizePayload(patch: SavePatch): Partial<CanvasDocPayload & { title: string }> {
  const out: Partial<CanvasDocPayload & { title: string }> = {};
  if (patch.title !== undefined) out.title = clampText(patch.title, CANVAS_LIMITS.titleChars);
  if (patch.nodes !== undefined) out.nodes = sanitizeNodes(patch.nodes);
  if (patch.connections !== undefined) {
    // 连线的端点校验依赖节点集合：只传连线不传节点时读不到原集合，这种调用
    // 由前端保证不会发生（保存永远是整份载荷）；这里仍兜底按空集合过滤。
    const nodes = (out.nodes ?? []) as CanvasNodeData[];
    const ids = new Set(nodes.map((n) => n.id));
    out.connections = sanitizeConnections(patch.connections, ids);
  }
  if (patch.viewport !== undefined) out.viewport = sanitizeViewport(patch.viewport);
  return out;
}

export function listCanvasDocs(): CanvasDocSummary[] {
  return db
    .select({
      id: canvasDocs.id,
      title: canvasDocs.title,
      nodes: canvasDocs.nodes,
      updatedAt: canvasDocs.updatedAt,
    })
    .from(canvasDocs)
    .orderBy(desc(canvasDocs.updatedAt))
    .all()
    .map((row) => ({
      id: row.id,
      title: row.title || "未命名画布",
      nodeCount: (() => {
        try {
          return JSON.parse(row.nodes).length ?? 0;
        } catch {
          return 0;
        }
      })(),
      updatedAt: row.updatedAt,
    }));
}

export function getCanvasDoc(id: number): { id: number; title: string; payload: CanvasDocPayload; updatedAt: number } | null {
  const row = db.select().from(canvasDocs).where(eq(canvasDocs.id, id)).limit(1).all()[0];
  if (!row) return null;
  let payload: CanvasDocPayload;
  try {
    const ids = new Set(sanitizeNodes(JSON.parse(row.nodes)).map((n) => n.id));
    payload = {
      nodes: sanitizeNodes(JSON.parse(row.nodes)),
      connections: sanitizeConnections(JSON.parse(row.connections), ids),
      viewport: sanitizeViewport(JSON.parse(row.viewport)),
    };
  } catch (e) {
    // 坏 JSON 的文档以空画布打开（可被用户重写覆盖），而不是让整页崩掉。
    logEvent({
      level: "warn",
      source: "canvas",
      event: "canvas.doc.corrupt",
      message: `画布文档 JSON 解析失败，以空画布打开：id ${id}`,
      detail: { id, error: e },
    });
    payload = { nodes: [], connections: [], viewport: CANVAS_DEFAULT_VIEWPORT };
  }
  return { id: row.id, title: row.title || "未命名画布", payload, updatedAt: row.updatedAt };
}

export function createCanvasDoc(title?: unknown): CanvasDocSummary {
  const now = Date.now();
  const cleanTitle = clampText(title, CANVAS_LIMITS.titleChars) || "未命名画布";
  const rows = db
    .insert(canvasDocs)
    .values({
      title: cleanTitle,
      nodes: "[]",
      connections: "[]",
      viewport: JSON.stringify(CANVAS_DEFAULT_VIEWPORT),
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: canvasDocs.id, updatedAt: canvasDocs.updatedAt })
    .all();
  const row = rows[0];
  return { id: row?.id ?? 0, title: cleanTitle, nodeCount: 0, updatedAt: row?.updatedAt ?? now };
}

export function saveCanvasDoc(id: number, patch: SavePatch): { ok: boolean; error?: string } {
  const clean = sanitizePayload(patch);
  const exists = db.select({ id: canvasDocs.id }).from(canvasDocs).where(eq(canvasDocs.id, id)).limit(1).all()[0];
  if (!exists) return { ok: false, error: `画布不存在（id ${id}）` };
  const values: Record<string, unknown> = { updatedAt: Date.now() };
  if (clean.title !== undefined) values.title = clean.title;
  if (clean.nodes !== undefined) values.nodes = JSON.stringify(clean.nodes);
  if (clean.connections !== undefined) values.connections = JSON.stringify(clean.connections);
  if (clean.viewport !== undefined) values.viewport = JSON.stringify(clean.viewport);
  db.update(canvasDocs)
    .set(values as Partial<typeof canvasDocs.$inferInsert>)
    .where(eq(canvasDocs.id, id))
    .run();
  return { ok: true };
}

export function deleteCanvasDoc(id: number): { ok: boolean; error?: string } {
  const removed = db
    .delete(canvasDocs)
    .where(eq(canvasDocs.id, id))
    .returning({ id: canvasDocs.id })
    .all();
  if (removed.length === 0) return { ok: false, error: `画布不存在（id ${id}）` };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 上传导入：画布「导入资源 → 上传」把本地图片落成 images/ 内的 ref，
// 之后与生成产物同一条路（chatImageUrl 预览 / referenceImageRef 转交生成器）。
// ---------------------------------------------------------------------------

const IMPORT_MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const IMPORT_MAX_BYTES = 20 * 1024 * 1024;

export function importCanvasImage(input: { dataUrl: string; name?: string }): { ref?: string; error?: string } {
  const match = /^data:([a-z/+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(input.dataUrl ?? "");
  if (!match) return { error: "只支持图片的 dataURL（png / jpg / webp / gif）" };
  const ext = IMPORT_MIME_EXT[match[1]!];
  if (!ext) return { error: `不支持的图片格式：${match[1]}` };
  let buffer: Buffer;
  try {
    buffer = Buffer.from(match[2]!, "base64");
  } catch {
    return { error: "图片数据解码失败" };
  }
  if (buffer.length === 0) return { error: "图片内容为空" };
  if (buffer.length > IMPORT_MAX_BYTES) return { error: "图片超过 20MB，先压缩再上传" };

  // 文件名只用来保留可读性，实际落盘名是时间戳 + 随机段（防碰撞防穿越）。
  void input.name;
  const dir = path.join(getImagesBaseDir(), "canvas");
  mkdirSync(dir, { recursive: true });
  const file = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  writeFileSync(path.join(dir, file), buffer);
  const ref = `canvas/${file}`;
  logEvent({
    level: "info",
    source: "canvas",
    event: "canvas.image.imported",
    message: `画布导入图片：${ref}`,
    detail: { bytes: buffer.length, mime: match[1] },
  });
  return { ref };
}
