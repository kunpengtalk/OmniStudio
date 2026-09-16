import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "fs";
import sharp from "sharp";

import { classifyBackupPath } from "../shared/backup";
import { db } from "./db";
import { memories } from "./db/schema";
import { updateSettings } from "./db/settings";
import { noteMemoryRef } from "./memory";
import { MEMORY_LIMITS } from "../shared/memory";
import {
  NOTE_LIMITS,
  attachNoteImage,
  attachmentsDir,
  isNoteImageRef,
  listNotes,
  localDay,
  normalizeDay,
  normalizeTags,
  removeNote,
  saveNote,
} from "./notes";

async function pngDataUrl(width = 40, height = 30): Promise<string> {
  const png = await sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 120, b: 60 } },
  })
    .png()
    .toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

/** 附件目录里是否有内容（删干净了应该是空的 / 不存在）。 */
function attachmentFiles(): string[] {
  const dir = attachmentsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
}

test("日期归一化：形状不对或不是真日期都退回今天", () => {
  expect(normalizeDay("2026-03-09")).toBe("2026-03-09");
  expect(normalizeDay("2026-2-9")).toBe(localDay());
  expect(normalizeDay("2026-02-30")).toBe(localDay());
  expect(normalizeDay("")).toBe(localDay());
  expect(normalizeDay(20260309)).toBe(localDay());
});

test("标签：去重、去空白、限个数与长度", () => {
  expect(normalizeTags([" 工作 ", "工作", "生活"])).toEqual(["工作", "生活"]);
  expect(normalizeTags("工作")).toEqual([]);
  expect(normalizeTags(Array.from({ length: 40 }, (_, i) => `t${i}`)).length).toBe(NOTE_LIMITS.tags);
  expect(normalizeTags(["x".repeat(80)])[0]!.length).toBe(NOTE_LIMITS.tagLength);
});

test("附件 ref 只认自己生成的形状（路径穿越一律不认）", () => {
  expect(isNoteImageRef("notes/abc123/a.webp")).toBe(true);
  expect(isNoteImageRef("notes/abc123/../../omni-studio.db")).toBe(false);
  expect(isNoteImageRef("notes/abc123/a.sh")).toBe(false);
  expect(isNoteImageRef("notes/abc123")).toBe(false);
  expect(isNoteImageRef("/etc/passwd")).toBe(false);
  expect(isNoteImageRef(null)).toBe(false);
});

test("新建笔记：标题正文都空则拒，写入后能整条读回来", async () => {
  const empty = saveNote({ title: "  ", body: "\n" });
  expect(empty.ok).toBe(false);
  expect(empty.error).toContain("不能都为空");

  const saved = saveNote({
    title: "第一天的记录",
    body: "今天把笔记小应用接通了。",
    tags: ["开发", "开发", "笔记"],
    day: "2026-01-02",
    pinned: true,
  });
  expect(saved.ok).toBe(true);
  const note = saved.note!;
  expect(note.id).toBeGreaterThan(0);
  expect(note.tags).toEqual(["开发", "笔记"]);
  expect(note.day).toBe("2026-01-02");
  expect(note.pinned).toBe(true);

  const all = await listNotes();
  const found = all.find((item) => item.id === note.id);
  expect(found?.title).toBe("第一天的记录");
  expect(found?.createdAt).toBe(note.createdAt);
});

test("更新笔记：改内容同时去掉的附件会被顺手删掉", async () => {
  const attached = await attachNoteImage({ dataUrl: await pngDataUrl(), name: "a.png" });
  expect(attached.ok).toBe(true);
  const ref = attached.image!.ref;
  const file = `${attachmentsDir()}/${ref.slice("notes/".length)}`;
  expect(existsSync(file)).toBe(true);

  const created = saveNote({ title: "带图", body: "图在下面", images: [ref] });
  expect(created.note!.images.length).toBe(1);
  expect(created.note!.images[0]!.width).toBe(40);

  const updated = saveNote({
    id: created.note!.id,
    title: "带图",
    body: "图删掉了",
    images: [],
  });
  expect(updated.ok).toBe(true);
  expect(updated.note!.images).toEqual([]);
  // 文件已经不在磁盘上了：留着就是永不回收的孤儿
  expect(existsSync(file)).toBe(false);
});

test("删除笔记：行没了，附件目录也清掉", async () => {
  const attached = await attachNoteImage({ dataUrl: await pngDataUrl(), name: "b.png" });
  const ref = attached.image!.ref;
  const dir = `${attachmentsDir()}/${ref.slice("notes/".length).split("/")[0]}`;
  const created = saveNote({ title: "待删除", body: "x", images: [ref] });
  expect(existsSync(dir)).toBe(true);

  const removed = removeNote(created.note!.id);
  expect(removed.ok).toBe(true);
  expect(existsSync(dir)).toBe(false);
  expect((await listNotes()).some((item) => item.id === created.note!.id)).toBe(false);
  expect(removeNote(created.note!.id).ok).toBe(false);
  expect(removeNote(-1).ok).toBe(false);
});

test("挂附件：只收 base64 图片，类型听 mime、不听文件名", async () => {
  const bad = await attachNoteImage({ dataUrl: "https://example.com/a.png", name: "a.png" });
  expect(bad.ok).toBe(false);

  const svg = await attachNoteImage({
    dataUrl: `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`,
    name: "evil.sh",
  });
  expect(svg.ok).toBe(false);
  expect(svg.error).toContain("不支持");

  const weirdName = await attachNoteImage({ dataUrl: await pngDataUrl(), name: "../../a b?.png" });
  expect(weirdName.ok).toBe(true);
  expect(weirdName.image!.ref).toMatch(/^notes\/[a-z0-9]+\/[A-Za-z0-9._-]+\.png$/);
});

test("挂附件：超大尺寸压到长边 2048 并转 webp", async () => {
  const attached = await attachNoteImage({
    dataUrl: await pngDataUrl(3000, 600),
    name: "panorama.png",
  });
  expect(attached.ok).toBe(true);
  expect(attached.image!.ref.endsWith(".webp")).toBe(true);
  expect(attached.image!.width).toBe(NOTE_LIMITS.imageEdge);
  expect(attached.image!.bytes).toBeLessThan(3000 * 600);
});

test("挂附件：超过体积上限直接拒，不落盘", async () => {
  const before = attachmentFiles().length;
  const huge = `data:image/png;base64,${Buffer.alloc(NOTE_LIMITS.imageBytes + 1024).toString("base64")}`;
  const result = await attachNoteImage({ dataUrl: huge, name: "big.png" });
  expect(result.ok).toBe(false);
  expect(result.error).toContain("过大");
  expect(attachmentFiles().length).toBe(before);
});

test("挂附件：伪造的 ref 不会被写进笔记（删除时就不会误删别处）", () => {
  const saved = saveNote({
    title: "伪造附件",
    body: "x",
    images: ["notes/xxxxxx/../../omni-studio.db", "/etc/passwd", "notes/xxxxxx/a.png"],
  });
  expect(saved.ok).toBe(true);
  // 只有形状合法的那一条留下来（哪怕磁盘上其实没有这个文件）
  expect(saved.note!.images.map((image) => image.ref)).toEqual(["notes/xxxxxx/a.png"]);
});

test("附件跟着「笔记」作用域一起备份（换个存放位置就会静默丢图）", async () => {
  const attached = await attachNoteImage({ dataUrl: await pngDataUrl(), name: "backup.png" });
  expect(attached.ok).toBe(true);
  // 备份按"相对数据目录"的路径归类，未命中任何文件根的文件**不参与备份**，
  // 而落进 media 作用域则默认不勾 —— 两条都会让"恢复之后图没了"。
  expect(classifyBackupPath(`images/${attached.image!.ref}`)).toMatchObject({
    rootId: "note-images",
    scope: "notes",
  });
});

// ---------------------------------------------------------------------------
// 笔记 → 记忆：保存、更新、删除都要跟着走（Agent 靠记忆才能"想起"笔记）
// ---------------------------------------------------------------------------

function memoryOf(noteId: number) {
  return db.select().from(memories).all().find((row) => row.sourceRef === noteMemoryRef(noteId));
}

test("保存笔记会沉淀一条记忆（含标题 / 日期 / 正文摘要）", () => {
  updateSettings({ NOTES_AGENT_ACCESS: "1", MEMORY_ENABLED: "1" });
  const saved = saveNote({
    title: "周末爬山",
    body: "早上六点出门，山顶的云正好散开。\n下次带上长焦。",
    tags: ["生活"],
    day: "2026-09-13",
  });
  const row = memoryOf(saved.note!.id);
  expect(row).toBeTruthy();
  expect(row!.content).toContain("周末爬山");
  expect(row!.content).toContain("2026-09-13");
  expect(row!.content).toContain("山顶的云");
  // 记忆是单行的（会被注入所有 Agent 的上下文），换行必须被压平
  expect(row!.content.includes("\n")).toBe(false);
  expect(row!.content.length).toBeLessThanOrEqual(MEMORY_LIMITS.maxContentChars);
  expect(JSON.parse(row!.tags)).toContain("生活");
  // 用户在笔记里亲手写的东西，不该排队等确认
  expect(row!.status).toBe("active");
  expect(row!.source).toBe("manual");
});

test("改笔记更新同一条记忆，不堆积；删笔记连记忆一起清掉", () => {
  updateSettings({ NOTES_AGENT_ACCESS: "1", MEMORY_ENABLED: "1" });
  const created = saveNote({ title: "会议要点", body: "范围收敛到两个功能", day: "2026-09-10" });
  const id = created.note!.id;
  const firstMemoryId = memoryOf(id)!.id;

  saveNote({ id, title: "会议要点", body: "范围收敛到两个功能；另外周三给接口", day: "2026-09-10" });
  expect(memoryOf(id)!.id).toBe(firstMemoryId);
  expect(memoryOf(id)!.content).toContain("周三给接口");
  expect(db.select().from(memories).all().filter((r) => r.sourceRef === noteMemoryRef(id)).length).toBe(1);

  expect(removeNote(id).ok).toBe(true);
  expect(memoryOf(id)).toBeUndefined();
});

test("关掉同步开关就不再写记忆，但笔记照常保存", () => {
  updateSettings({ NOTES_AGENT_ACCESS: "0" });
  const saved = saveNote({ title: "只是随手记", body: "买牛奶", day: "2026-09-11" });
  expect(saved.ok).toBe(true);
  expect(memoryOf(saved.note!.id)).toBeUndefined();
  updateSettings({ NOTES_AGENT_ACCESS: "1" });
});

test("疑似凭据的笔记不进记忆库（记忆会被注入所有 Agent，正文照常落库）", async () => {
  updateSettings({ NOTES_AGENT_ACCESS: "1", MEMORY_ENABLED: "1" });
  const saved = saveNote({
    title: "部署备忘",
    body: "api_key: sk-abcdefghijklmnop",
    day: "2026-09-12",
  });
  expect(saved.ok).toBe(true);
  expect(memoryOf(saved.note!.id)).toBeUndefined();
  expect((await listNotes()).some((note) => note.id === saved.note!.id)).toBe(true);
});

test("超长正文的记忆被压到上限以内，并带上「怎么读全文」的钩子", () => {
  updateSettings({ NOTES_AGENT_ACCESS: "1", MEMORY_ENABLED: "1" });
  const saved = saveNote({ title: "长文", body: "背景".repeat(600), day: "2026-09-12" });
  const content = memoryOf(saved.note!.id)!.content;
  expect(content.length).toBeLessThanOrEqual(MEMORY_LIMITS.maxContentChars);
  expect(content).toContain("…");
  // 摘要末尾必须留 `note_read #<id>`：模型靠这句话从"想得起"走到"读得到"
  expect(content).toContain(`note_read #${saved.note!.id}`);
});
