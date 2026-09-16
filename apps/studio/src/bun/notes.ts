/**
 * 小应用「笔记」的数据层：正文进主库（`miniapp_notes`），附件进数据目录
 * （`images/notes/<附件 id>/`），两者都跟着 `omi backup` 一起走。
 *
 * 为什么不是"小应用自己存"：小应用跑在不透明源的 sandbox iframe 里，那里连
 * `localStorage` 都没有；而笔记是用户唯一会认真检查"重装后还在不在"的数据，
 * 只能落在主进程能保证的位置。这也是这个小应用需要新动作（`notes.*`）的原因 ——
 * 它不再是"算完就丢"的一次性工具。
 *
 * 另一条主线：**每条笔记会沉淀成一条记忆**（`memory.ts` 的 syncNoteMemory）—— 记忆是
 * 单行、≤500 字、会被注入所有 Agent 上下文的条目，所以那里存的是"索引级"摘要而不是正文；
 * 开关在笔记小应用的设置里（`NOTES_AGENT_ACCESS`，同时也是 `note_*` 读取工具的开关），
 * 删笔记时对应的记忆一起清掉。
 * 记忆同步失败**不让笔记保存失败**：正文已经落库，那才是用户真正在乎的东西。
 *
 * 两条贯穿全文件的约定：
 *   1. **输入全部不可信**：调用方有小应用（iframe）与 RPC，长度、标签数、附件数、
 *      ref 形状都在这里再夹一遍 —— 桥接层夹过不代表这里可以不夹（CLI / 未来入口会绕开它）。
 *   2. **附件 ref 必须能安全反推目录**：删除一条笔记要连带删掉它的附件目录，
 *      所以 ref 只接受本模块自己生成的形状 `notes/<id>/<文件名>`（见 `isNoteImageRef`），
 *      别的一律丢掉 —— 否则一个 `../..` 就能让"删附件"删到数据目录里的别处去。
 *
 * 这里刻意不 import electrobun：本模块要能在 `bun test` 里单独加载。
 */
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import path from "path";
import { desc, eq } from "drizzle-orm";
import sharp from "sharp";

import { db } from "./db";
import { miniappNotes } from "./db/schema";
import { getDataDir } from "./paths";
import { chatImageUrl } from "../shared/server-info";
import { isInsideDir, safeBaseName, safeJoin } from "./path-safety";
import { logEvent } from "./app-log";
import { forgetNoteMemory, syncNoteMemory } from "./memory";

// ---------------------------------------------------------------------------
// 限额与形状
// ---------------------------------------------------------------------------

/** 一条笔记的边界。与小应用侧（`lib/miniapp-bridge.ts`）的夹取保持一致，改一处要改两处。 */
export const NOTE_LIMITS = {
  title: 200,
  body: 20_000,
  tags: 12,
  tagLength: 24,
  images: 9,
  /** 单张附件的解码后字节上限。 */
  imageBytes: 12 * 1024 * 1024,
  /** 长边超过它就压到 2048（网格里全是 12MP 原图会让列表滚动一顿一顿的）。 */
  imageEdge: 2048,
} as const;

/** 附件落盘允许的图片类型（也决定扩展名：不听小应用给的文件名）。 */
const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const IMAGE_EXTS = Object.values(IMAGE_EXT);

export type NoteImage = {
  /** `images/` 下的相对 ref（`notes/<附件 id>/<文件名>`）。 */
  ref: string;
  /** 可直接加载的媒体地址（图片服务提供，桌面端是回环地址）。 */
  url: string;
  /** 磁盘绝对路径（导出 Markdown 时写成可点开的路径，ref 出了媒体服务就没人认得）。 */
  path: string;
  width: number;
  height: number;
  bytes: number;
};

export type Note = {
  id: number;
  title: string;
  body: string;
  tags: string[];
  /** 归属日期 `YYYY-MM-DD`。 */
  day: string;
  images: NoteImage[];
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
};

export type NoteInput = {
  id?: number;
  title?: unknown;
  body?: unknown;
  tags?: unknown;
  day?: unknown;
  /** 附件 ref 数组（先经 `attachNoteImage` 落盘再挂上来）。 */
  images?: unknown;
  pinned?: unknown;
};

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

function clampText(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/** 本地时区的 `YYYY-MM-DD`（`toISOString` 是 UTC，跨时区会让"今天"差一天）。 */
export function localDay(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 日期归一化：形状对且是真日期才收，否则退回今天（日历里放一个不存在的日子没法看）。 */
export function normalizeDay(value: unknown): string {
  const raw = clampText(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return localDay();
  const [y, m, d] = raw.split("-").map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);
  const valid = date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
  return valid ? raw : localDay();
}

/** 标签：去空白、去重（大小写不敏感）、限个数与长度，顺序保持用户输入。 */
export function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value.slice(0, NOTE_LIMITS.tags * 2)) {
    const tag = clampText(item, NOTE_LIMITS.tagLength).trim().replace(/\s+/g, " ");
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= NOTE_LIMITS.tags) break;
  }
  return out;
}

/**
 * 附件 ref 的形状校验：**只认本模块生成的** `notes/<id>/<文件名>.<图片后缀>`。
 *
 * 删除笔记时会按 ref 反推目录，所以这里的严格程度直接等于"能不能被诱导删掉别的目录"：
 * 段数、id 字符集、扩展名白名单三者一起卡，`..` 与绝对路径自然都过不了。
 */
export function isNoteImageRef(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 300) return false;
  const match = /^notes\/([a-z0-9]{6,32})\/([A-Za-z0-9._-]{1,120})$/.exec(value);
  if (!match) return false;
  const ext = path.extname(match[2]!).slice(1).toLowerCase();
  return IMAGE_EXTS.includes(ext);
}

function normalizeImageRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isNoteImageRef).slice(0, NOTE_LIMITS.images);
}

function parseJsonArray(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 附件目录：`<dataDir>/images/notes/`。 */
export function attachmentsDir(): string {
  return path.join(getDataDir("images"), "notes");
}

/**
 * ref → 磁盘路径。走 `safeJoin` 再判一次目录归属：ref 是拼出来的字符串，
 * 任何一环放松都会变成"读 / 删数据目录里的任意文件"。
 */
export function resolveNoteImage(ref: unknown): string | null {
  if (!isNoteImageRef(ref)) return null;
  return safeJoin(attachmentsDir(), ref.slice("notes/".length));
}

/** 附件尺寸缓存：列表与编辑器都按它占位，缺了就现场量一次（异步，见 `measureImages`）。 */
const dimCache = new Map<string, { width: number; height: number }>();

async function measureImages(refs: string[]): Promise<void> {
  const missing = [...new Set(refs)].filter((ref) => !dimCache.has(ref));
  await Promise.all(
    missing.map(async (ref) => {
      const file = resolveNoteImage(ref);
      if (!file) {
        dimCache.set(ref, { width: 0, height: 0 });
        return;
      }
      try {
        const meta = await sharp(file).metadata();
        dimCache.set(ref, { width: meta.width ?? 0, height: meta.height ?? 0 });
      } catch {
        dimCache.set(ref, { width: 0, height: 0 });
      }
    }),
  );
}

function imageBytes(ref: string): number {
  const file = resolveNoteImage(ref);
  if (!file) return 0;
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function toNote(row: typeof miniappNotes.$inferSelect): Note {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    tags: normalizeTags(parseJsonArray(row.tags)),
    day: normalizeDay(row.day),
    images: normalizeImageRefs(parseJsonArray(row.images)).map((ref) => ({
      ref,
      url: chatImageUrl(ref),
      path: resolveNoteImage(ref) ?? "",
      ...(dimCache.get(ref) ?? { width: 0, height: 0 }),
      bytes: imageBytes(ref),
    })),
    pinned: row.pinned === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

/**
 * 全部笔记，置顶在前、其余按最近更新。
 *
 * 一次拉完而不是分页：本地笔记是"回头翻一翻"的量级（几百条），而日历视图本来就需要
 * 整月的数据；分页反而会让小应用里多出一堆"加载更多"的状态。
 */
export async function listNotes(): Promise<Note[]> {
  pruneOrphanImages();
  const rows = db
    .select()
    .from(miniappNotes)
    .orderBy(desc(miniappNotes.pinned), desc(miniappNotes.updatedAt))
    .all();
  await measureImages(rows.flatMap((row) => normalizeImageRefs(parseJsonArray(row.images))));
  return rows.map(toNote);
}

/**
 * 清掉没有任何笔记引用的附件目录（进程内只跑一次，尽力而为）。
 *
 * 会留下孤儿的是"新建笔记时挂了几张图、最后没保存就关掉"这条路径 —— 文件已经落盘，
 * 但没有任何一行笔记记得它。只删**一天以前**的：正在编辑、还没保存的那几张图的目录
 * 也是"当前无引用"的状态，按时间把它们排除在外，才不会删到用户手边的东西。
 */
let prunedOrphans = false;

function pruneOrphanImages(): void {
  if (prunedOrphans) return;
  prunedOrphans = true;
  const dir = attachmentsDir();
  let entries: string[];
  try {
    if (!existsSyncDir(dir)) return;
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const referenced = new Set<string>();
  for (const row of db.select().from(miniappNotes).all()) {
    for (const ref of normalizeImageRefs(parseJsonArray(row.images))) {
      referenced.add(ref.split("/")[1]!);
    }
  }
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const name of entries) {
    if (referenced.has(name)) continue;
    const target = safeJoin(dir, name);
    if (!target) continue;
    try {
      if (statSync(target).mtimeMs > cutoff) continue;
      rmSync(target, { recursive: true, force: true });
    } catch {
      // 单个目录删不掉不影响其它：孤儿回收本来就是尽力而为。
    }
  }
}

function existsSyncDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 按关键词找笔记（供 Agent 的 `note_search` 工具用）。
 *
 * 不走 SQL LIKE 而在内存里过滤：笔记是"几百条"的量级，而 SQL 侧要处理
 * `%` / `_` 转义与大小写折叠（记忆模块为此专门有个 `containsLikePattern`）——
 * 在 JS 里 `includes` 一次，行为最直白也最难出错。命中按最近更新排序。
 */
export function searchNotes(query: string, limit = 8): Note[] {
  const needle = String(query ?? "").trim().toLowerCase();
  const rows = db.select().from(miniappNotes).orderBy(desc(miniappNotes.updatedAt)).all();
  const matched = needle
    ? rows.filter((row) => {
        const hay = `${row.title}\n${row.body}\n${parseJsonArray(row.tags).join(" ")}`.toLowerCase();
        return hay.includes(needle);
      })
    : rows;
  return matched.slice(0, Math.max(1, Math.min(limit, 50))).map(toNote);
}

/** 读一条笔记（`note_read` 工具用）；不存在返回 null。 */
export function getNote(id: number): Note | null {
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = db.select().from(miniappNotes).where(eq(miniappNotes.id, id)).get();
  return row ? toNote(row) : null;
}

/** 统计（设置页显示"共 N 篇 / N 张附件 / 占多少"）。 */
export function noteStats(notes: Note[]): { notes: number; images: number; bytes: number } {
  let images = 0;
  let bytes = 0;
  for (const note of notes) {
    images += note.images.length;
    for (const image of note.images) bytes += image.bytes;
  }
  return { notes: notes.length, images, bytes };
}

// ---------------------------------------------------------------------------
// 写
// ---------------------------------------------------------------------------

export type SaveNoteResult = { ok: boolean; note?: Note; error?: string };

/**
 * 新建或更新一条笔记。
 *
 * 空标题 + 空正文直接拒（否则列表里会多出一张点不出内容的空卡片）；更新时间戳由这里写，
 * 不交给小应用 —— 不然"最近更新"排序可以被它随手改。
 */
export function saveNote(input: NoteInput): SaveNoteResult {
  const title = clampText(input.title, NOTE_LIMITS.title).trim();
  const body = clampText(input.body, NOTE_LIMITS.body).trim();
  if (!title && !body) return { ok: false, error: "标题和正文不能都为空" };

  const tags = normalizeTags(input.tags);
  const images = normalizeImageRefs(input.images);
  const day = normalizeDay(input.day);
  const now = Date.now();
  const pinned = input.pinned === true ? 1 : 0;
  const id =
    typeof input.id === "number" && Number.isInteger(input.id) && input.id > 0 ? input.id : null;

  try {
    if (id) {
      const existing = db.select().from(miniappNotes).where(eq(miniappNotes.id, id)).get();
      if (!existing) return { ok: false, error: "这条笔记已经不存在了" };
      // 被移除的附件顺手删文件：留着就是数据目录里永不回收的孤儿。
      for (const ref of normalizeImageRefs(parseJsonArray(existing.images))) {
        if (!images.includes(ref)) removeImageFile(ref);
      }
      const updated = db
        .update(miniappNotes)
        .set({
          title,
          body,
          tags: JSON.stringify(tags),
          day,
          images: JSON.stringify(images),
          pinned,
          updatedAt: now,
        })
        .where(eq(miniappNotes.id, id))
        .returning()
        .get();
      if (!updated) return { ok: false, error: "保存后读不回这条笔记" };
      syncMemoryFor(updated);
      return { ok: true, note: toNote(updated) };
    }

    const inserted = db
      .insert(miniappNotes)
      .values({
        title,
        body,
        tags: JSON.stringify(tags),
        day,
        images: JSON.stringify(images),
        pinned,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    if (!inserted) return { ok: false, error: "写入失败" };
    syncMemoryFor(inserted);
    return { ok: true, note: toNote(inserted) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logEvent({
      level: "error",
      source: "miniapp",
      event: "miniapp.notes.save.failed",
      message,
      detail: { id, chars: title.length + body.length, images: images.length, error: e },
    });
    return { ok: false, error: message };
  }
}

/**
 * 把一条笔记沉淀成记忆（幂等、尽力而为）。
 *
 * 放在保存路径里而不是 RPC 层：凡是"笔记写成功"的入口都该同步 —— 对话 / Agent 的一键
 * 存笔记走的是同一个 RPC，将来多一个入口也不必再记得补这一步。
 */
function syncMemoryFor(row: typeof miniappNotes.$inferSelect): void {
  try {
    const outcome = syncNoteMemory({
      noteId: row.id,
      title: row.title,
      body: row.body,
      day: normalizeDay(row.day),
      tags: normalizeTags(parseJsonArray(row.tags)),
      pinned: row.pinned === 1,
    });
    if (!outcome.ok || outcome.action === "skipped") {
      logEvent({
        level: "info",
        source: "miniapp",
        event: "miniapp.notes.memory.skipped",
        message: outcome.reason ?? "",
        detail: { noteId: row.id, action: outcome.action },
      });
    }
  } catch (e) {
    logEvent({
      level: "warn",
      source: "miniapp",
      event: "miniapp.notes.memory.sync_failed",
      message: e instanceof Error ? e.message : String(e),
      detail: { noteId: row.id, error: e },
    });
  }
}

/** 删除一条笔记：先删附件，再删行（行没了才发现附件删不动，就再也找不回来了）。 */
export function removeNote(id: number): { ok: boolean; error?: string } {
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "笔记 id 不合法" };
  const row = db.select().from(miniappNotes).where(eq(miniappNotes.id, id)).get();
  if (!row) return { ok: false, error: "这条笔记已经不存在了" };
  for (const ref of normalizeImageRefs(parseJsonArray(row.images))) removeImageFile(ref);
  db.delete(miniappNotes).where(eq(miniappNotes.id, id)).run();
  // 记忆跟着走：留着就是"Agent 记得一条打开就报 404 的笔记"。
  try {
    forgetNoteMemory(id);
  } catch (e) {
    logEvent({
      level: "warn",
      source: "miniapp",
      event: "miniapp.notes.memory.forget_failed",
      message: e instanceof Error ? e.message : String(e),
      detail: { noteId: id, error: e },
    });
  }
  return { ok: true };
}

/**
 * 删掉一个附件（连同它那个只属于它自己的目录）。删不动只记日志，不打断删除流程 ——
 * 用户点了删除，笔记必须消失，残留文件是次要问题。
 */
function removeImageFile(ref: string): void {
  const file = resolveNoteImage(ref);
  if (!file) return;
  try {
    const dir = path.dirname(file);
    if (!isInsideDir(attachmentsDir(), dir)) return;
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    logEvent({
      level: "warn",
      source: "miniapp",
      event: "miniapp.notes.image.remove_failed",
      message: e instanceof Error ? e.message : String(e),
      detail: { ref, error: e },
    });
  }
}

// ---------------------------------------------------------------------------
// 附件落盘
// ---------------------------------------------------------------------------

export type AttachImageResult = { ok: boolean; image?: NoteImage; error?: string };

/**
 * 把一张图片存进数据目录，返回可预览的 ref + url。
 *
 * 三个必须在这里做的判断（输入来自 iframe）：
 *   - **只收 base64 的 data: 地址**：远程 URL 与明文段要么会去下载别人的内容，
 *     要么让后续解析多一条分支；
 *   - **类型听 mime、不听文件名**：否则一个叫 `x.sh` 的东西会带着图片后缀落盘；
 *   - **长边超限就压到 2048**：日记里的手机原图动辄 4-8MB，列表网格一次加载九张会卡。
 */
export async function attachNoteImage(params: {
  dataUrl: unknown;
  name?: unknown;
}): Promise<AttachImageResult> {
  const raw = typeof params.dataUrl === "string" ? params.dataUrl.trim() : "";
  const match = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(raw);
  if (!match) return { ok: false, error: "只接受 base64 的图片数据" };
  const mime = match[1]!.toLowerCase();
  const ext = IMAGE_EXT[mime];
  if (!ext) return { ok: false, error: `不支持的图片类型：${mime}` };

  const bytes = Buffer.from(match[2]!, "base64");
  if (bytes.byteLength === 0) return { ok: false, error: "图片内容为空" };
  if (bytes.byteLength > NOTE_LIMITS.imageBytes) {
    return {
      ok: false,
      error: `图片过大（${Math.round(bytes.byteLength / 1024 / 1024)}MB，上限 ${NOTE_LIMITS.imageBytes / 1024 / 1024}MB）`,
    };
  }

  let outBytes = bytes;
  let outExt = ext;
  let width = 0;
  let height = 0;
  try {
    const meta = await sharp(bytes).metadata();
    width = meta.width ?? 0;
    height = meta.height ?? 0;
    const largest = Math.max(width, height);
    // 动图转静帧会丢信息，所以压缩只对静态图做。
    if (largest > NOTE_LIMITS.imageEdge && (meta.pages ?? 1) === 1) {
      outBytes = Buffer.from(
        await sharp(bytes)
          .rotate() // 按 EXIF 摆正：手机竖拍的照片缺这一步会躺着
          .resize({ width: NOTE_LIMITS.imageEdge, height: NOTE_LIMITS.imageEdge, fit: "inside", withoutEnlargement: true })
          .webp({ quality: 82 })
          .toBuffer(),
      );
      outExt = "webp";
      const scaled = await sharp(outBytes).metadata();
      width = scaled.width ?? width;
      height = scaled.height ?? height;
    }
  } catch (e) {
    // sharp 认不出的图（罕见的 PNG 变体等）：原样存，让"能不能显示"由浏览器决定，
    // 总比整张图被拒好。
    logEvent({
      level: "warn",
      source: "miniapp",
      event: "miniapp.notes.image.decode_failed",
      message: e instanceof Error ? e.message : String(e),
      detail: { mime, bytes: bytes.byteLength, error: e },
    });
  }

  // 附件 id：目录名同时也是 ref 的第二段，字符集被 isNoteImageRef 限制成小写字母数字。
  const attachmentId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.toLowerCase();
  const picked = safeBaseName(typeof params.name === "string" ? params.name : "") ?? "";
  const stem = (path.basename(picked, path.extname(picked)).slice(0, 60) || "image")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^[._]+/, "");
  const fileName = `${stem || "image"}.${outExt}`;
  const dir = path.join(attachmentsDir(), attachmentId);
  const target = safeJoin(dir, fileName);
  if (!target) return { ok: false, error: "附件文件名不合法" };

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(target, outBytes);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logEvent({
      level: "error",
      source: "miniapp",
      event: "miniapp.notes.image.save_failed",
      message,
      detail: { dir, bytes: outBytes.byteLength, error: e },
    });
    return { ok: false, error: message };
  }

  const ref = `notes/${attachmentId}/${fileName}`;
  dimCache.set(ref, { width, height });
  return {
    ok: true,
    image: {
      ref,
      url: chatImageUrl(ref),
      path: target,
      width,
      height,
      bytes: outBytes.byteLength,
    },
  };
}
