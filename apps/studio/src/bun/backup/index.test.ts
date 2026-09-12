import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import {
  BACKUP_DB_ENTRY,
  BACKUP_FILES_PREFIX,
  DEFAULT_REMOTE_CONFIG,
  backupFileName,
  classifyArchiveEntry,
  classifyBackupPath,
  isSecretSettingKey,
  sanitizeScopes,
} from "../../shared/backup";
import {
  createBackup,
  deleteBackup,
  downloadRemoteBackup,
  estimateBackup,
  inspectBackup,
  listBackups,
  listRemoteBackups,
  readRemoteConfig,
  restoreBackup,
  testRemote,
  writeRemoteConfig,
} from "./index";
import { openArchive, listArchive } from "./archive";

let root: string;
let dataDir: string;
let dbPath: string;
let skillsRepo: string;

/** 用真实迁移 SQL 建库：表结构与线上一致，恢复路径才有意义。 */
function createSchema(path: string): Database {
  const db = new Database(path, { create: true });
  const dir = join(import.meta.dir, "..", "db", "migrations");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const text = readFileSync(join(dir, file), "utf8");
    for (const stmt of text.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (!trimmed || /__drizzle_migrations/i.test(trimmed)) continue;
      try {
        db.exec(trimmed);
      } catch {
        // 迁移里的索引 / 触发器可能已存在：建库只需要表结构
      }
    }
  }
  return db;
}

function seed(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`insert into settings (key, value) values ('VLLM_API_KEY', 'sk-secret-value'), ('SERVER_PORT', '8080'), ('SKILLS_CENTRAL_PATH', '${skillsRepo}')`);
  db.exec(
    "insert into cloud_providers (id, name, vendor, base_url, api_key, models) values ('openai', 'OpenAI', '', 'https://api.openai.com/v1', 'sk-cloud-secret', '[]')",
  );
  db.exec("insert into conversations (id, title, app) values (1, '会话一', 'chat'), (2, '会话二', 'agent')");
  db.exec("insert into messages (conversation_id, role, content) values (1, 'user', '你好'), (1, 'assistant', '你好，有什么可以帮你')");
  db.exec("insert into memories (content, category, status) values ('用户偏好中文', 'preference', 'active')");
  db.exec("insert into user_prompts (kind, category, name, prompt) values ('llm', '', '翻译助手', '把下面的内容翻译成中文')");
  db.exec("insert into documents (id, path, type, size, status, images_dir) values (1, '/tmp/doc.pdf', 'pdf', 10, 'completed', ?)", [
    join(dataDir, "images", "1"),
  ]);
  db.exec("insert into image_records (status, backend, prompt, image_path) values ('done', 'mlx', 'a cat', 'gen/cat.png')");
  db.close();
}

async function writeFileAt(rel: string, content: string | Buffer): Promise<void> {
  const full = join(dataDir, rel);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content);
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "omni-backup-"));
  dataDir = join(root, "data");
  dbPath = join(dataDir, "omni-studio.db");
  skillsRepo = join(root, "skills-repo");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(skillsRepo, ".git"), { recursive: true });
  createSchema(dbPath).close();
  seed(dbPath);
  await writeFile(join(skillsRepo, ".git", "HEAD"), "ref: refs/heads/main\n");
  await mkdir(join(skillsRepo, "my-skill"), { recursive: true });
  await writeFile(join(skillsRepo, "my-skill", "SKILL.md"), "# 技能\n");
  await writeFileAt("images/chat/1/attachment.png", Buffer.alloc(2048, 7));
  await writeFileAt("images/audio/tts-1.mp3", Buffer.alloc(4096, 9));
  await writeFileAt("images/gen/cat.png", Buffer.alloc(1024, 3));
  await writeFileAt("images/1/page-1.webp", Buffer.alloc(512, 4));
  await writeFileAt("uploads/doc.pdf", Buffer.alloc(256, 5));
  await writeFileAt("prompt-media/cached.png", Buffer.alloc(128, 6));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctx() {
  return { dataDir, dbPath, appVersion: "0.0.0-test" };
}

async function readArchivedDb(archivePath: string): Promise<string> {
  // 归档里只有 data/omni-studio.db 一个数据库条目，解到临时文件后只读打开
  const dest = join(root, `extracted-${Math.random().toString(36).slice(2)}.db`);
  for await (const entry of openArchive(archivePath)) {
    if (entry.name === BACKUP_DB_ENTRY) await entry.saveTo(dest);
    else await entry.discard();
  }
  return dest;
}

describe("作用域归置", () => {
  test("images/chat 归聊天、images/gen 归媒体，未列入的目录不参与", () => {
    expect(classifyBackupPath("images/chat/1/a.png")).toMatchObject({ rootId: "chat-images", scope: "chats" });
    expect(classifyBackupPath("images/gen/cat.png")).toMatchObject({ rootId: "images", scope: "media" });
    expect(classifyBackupPath("images/1/page.webp")).toMatchObject({ rootId: "images", scope: "media" });
    expect(classifyBackupPath("uploads/doc.pdf")).toMatchObject({ rootId: "uploads", scope: "media" });
    expect(classifyBackupPath("models/x.gguf")).toBeNull();
    expect(classifyBackupPath("engines/paddleocr/bin")).toBeNull();
    expect(classifyBackupPath("logs/app.log")).toBeNull();
  });

  test("归档条目反推归属，技能仓库的 .git 被排除", () => {
    expect(classifyArchiveEntry(`${BACKUP_FILES_PREFIX}chat-images/1/a.png`)).toMatchObject({ scope: "chats" });
    expect(classifyArchiveEntry(`${BACKUP_FILES_PREFIX}skills-repo/my-skill/SKILL.md`)).toMatchObject({ scope: "skills" });
    expect(classifyArchiveEntry(`${BACKUP_FILES_PREFIX}skills-repo/.git/HEAD`)).toBeNull();
    expect(classifyArchiveEntry("manifest.json")).toBeNull();
  });

  test("密钥键判定不误伤普通配置", () => {
    expect(isSecretSettingKey("VLLM_API_KEY")).toBe(true);
    expect(isSecretSettingKey("SKILLS_GIT_PAT")).toBe(true);
    expect(isSecretSettingKey("SERVER_IMAGE_MAX_TOKENS")).toBe(false);
    expect(isSecretSettingKey("SKILLS_CENTRAL_PATH")).toBe(false);
    expect(isSecretSettingKey("LOCAL_MODEL_PATH")).toBe(false);
  });

  test("非法作用域被丢弃", () => {
    expect(sanitizeScopes(["chats", "bogus", 3, "chats"])).toEqual(["chats"]);
    expect(sanitizeScopes("chats")).toEqual([]);
  });
});

describe("备份 / 恢复", () => {
  test("估算能区分作用域体积", async () => {
    const est = await estimateBackup({ ctx: ctx() });
    const media = est.scopes.find((s) => s.scope === "media")!;
    const chats = est.scopes.find((s) => s.scope === "chats")!;
    // media: images/gen + images/1 + images/audio + uploads = 1024 + 512 + 4096 + 256
    expect(media.bytes).toBe(1024 + 512 + 4096 + 256);
    expect(media.rows).toBe(2); // documents + image_records
    expect(chats.bytes).toBe(2048);
    expect(chats.rows).toBe(4); // 2 会话 + 2 消息
    expect(est.dataDirBytes).toBeGreaterThan(media.bytes + chats.bytes);
  });

  test("创建 → 预览 → 恢复：选中的作用域回来，没选的保持原样", async () => {
    const created = await createBackup({
      ctx: ctx(),
      scopes: ["settings", "chats", "media"],
      destinationDir: join(root, "out"),
      fileName: "my-backup",
    });
    expect(existsSync(created.path)).toBe(true);
    expect(created.manifest.scopes).toEqual(["settings", "chats", "media"]);

    const info = await inspectBackup({ path: created.path });
    expect(info.scopes).toEqual(["settings", "chats", "media"]);
    expect(info.manifest.db.tables.messages).toBe(2);

    // 未勾选的作用域不在归档里：被裁掉的表行数为 0 且不含 skills 文件
    const extracted = await readArchivedDb(created.path);
    const snap = new Database(extracted, { readonly: true });
    expect(snap.query("select count(*) c from messages").get()).toEqual({ c: 2 });
    expect(snap.query("select count(*) c from memories").get()).toEqual({ c: 0 });
    expect(snap.query("select count(*) c from user_prompts").get()).toEqual({ c: 0 });
    snap.close();
    const entries = (await listArchive(created.path)).map((e) => e.name);
    expect(entries).toContain(`${BACKUP_FILES_PREFIX}chat-images/1/attachment.png`);
    expect(entries).toContain(`${BACKUP_FILES_PREFIX}images/audio/tts-1.mp3`);
    expect(entries.some((n) => n.startsWith(`${BACKUP_FILES_PREFIX}prompt-media/`))).toBe(false);
    expect(entries.some((n) => n.startsWith(`${BACKUP_FILES_PREFIX}skills-repo/`))).toBe(false);

    // 破坏现场：删会话、改设置、删文件、加一条记忆（恢复不该动它）
    const live = new Database(dbPath);
    live.exec("delete from messages; delete from conversations");
    live.exec("update settings set value = '9999' where key = 'SERVER_PORT'");
    live.exec("insert into memories (content, category, status) values ('恢复后新增', 'fact', 'active')");
    live.close();
    rmSync(join(dataDir, "images", "audio", "tts-1.mp3"));
    rmSync(join(dataDir, "images", "chat", "1", "attachment.png"));

    const restored = await restoreBackup({ ctx: ctx(), path: created.path });
    expect(restored.scopes).toEqual(["settings", "chats", "media"]);
    expect(restored.safetyPath && existsSync(restored.safetyPath)).toBe(true);
    expect(restored.warnings).toEqual([]);

    const after = new Database(dbPath, { readonly: true });
    expect(after.query("select count(*) c from conversations").get()).toEqual({ c: 2 });
    expect(after.query("select count(*) c from messages").get()).toEqual({ c: 2 });
    expect(after.query("select value v from settings where key = 'SERVER_PORT'").get()).toEqual({ v: "8080" });
    // 未参与恢复的作用域原封不动：备份里的 memories 是空的，但本机的两条都在
    expect(after.query("select count(*) c from memories").get()).toEqual({ c: 2 });
    expect(after.query("select count(*) c from user_prompts").get()).toEqual({ c: 1 });
    after.close();

    expect(existsSync(join(dataDir, "images", "audio", "tts-1.mp3"))).toBe(true);
    expect(existsSync(join(dataDir, "images", "chat", "1", "attachment.png"))).toBe(true);
    expect(restored.tables.find((t) => t.table === "messages")?.rows).toBe(2);
  });

  test("恢复技能作用域：中央库文件回到设置里指定的目录", async () => {
    const created = await createBackup({ ctx: ctx(), scopes: ["skills"] });
    rmSync(join(skillsRepo, "my-skill"), { recursive: true, force: true });
    await restoreBackup({ ctx: ctx(), path: created.path, safety: false });
    expect(await readFile(join(skillsRepo, "my-skill", "SKILL.md"), "utf8")).toBe("# 技能\n");
  });

  test("剔除密钥：清单标记 + 明文被清空，表结构仍在", async () => {
    const created = await createBackup({ ctx: ctx(), scopes: ["settings"], redactSecrets: true });
    expect(created.manifest.redacted).toBe(true);
    const extracted = await readArchivedDb(created.path);
    const snap = new Database(extracted, { readonly: true });
    expect(snap.query("select value v from settings where key = 'VLLM_API_KEY'").get()).toEqual({ v: "" });
    expect(snap.query("select value v from settings where key = 'SERVER_PORT'").get()).toEqual({ v: "8080" });
    expect(snap.query("select api_key k from cloud_providers where id = 'openai'").get()).toEqual({ k: "" });
    snap.close();

    // 不剔除时原样保留（用户自己的备份要能带密钥）
    const plain = await createBackup({ ctx: ctx(), scopes: ["settings"], fileName: "plain" });
    const plainDb = await readArchivedDb(plain.path);
    const plainSnap = new Database(plainDb, { readonly: true });
    expect(plainSnap.query("select value v from settings where key = 'VLLM_API_KEY'").get()).toEqual({ v: "sk-secret-value" });
    plainSnap.close();
  });

  test("列表 / 删除：只认备份目录内的文件", async () => {
    const { path } = await createBackup({ ctx: ctx(), scopes: ["settings"] });
    const listed = await listBackups({ dir: join(dataDir, "backups") });
    expect(listed.backups.length).toBe(1);
    expect(listed.backups[0]!.path).toBe(path);
    expect(listed.backups[0]!.scopes).toEqual(["settings"]);

    const backupDir = join(dataDir, "backups");
    const outside = await deleteBackup({ path: join(root, "evil.omnibackup"), dir: backupDir });
    expect(outside.ok).toBe(false);
    expect((await deleteBackup({ path, dir: backupDir })).ok).toBe(true);
    expect((await listBackups({ dir: join(dataDir, "backups") })).backups.length).toBe(0);
  });

  test("损坏 / 非备份文件被拒绝，且原文件保留", async () => {
    const fake = join(root, "not-a-backup.omnibackup");
    await writeFile(fake, "this is not a tar");
    await expect(inspectBackup({ path: fake })).rejects.toThrow();
    const listed = await listBackups({ dir: root });
    expect(listed.backups[0]!.error).toBeTruthy();
  });

  test("文件名带时间戳且扩展名固定", () => {
    expect(backupFileName(new Date(2026, 0, 2, 3, 4, 5))).toBe("OmniStudio-20260102-030405.omnibackup");
  });

  test("加密备份：清单要密码才读得到，恢复同样需要密码", async () => {
    const created = await createBackup({
      ctx: ctx(),
      scopes: ["settings", "chats"],
      password: "s3cret-pass",
    });
    expect(created.manifest.encrypted).toBe(true);
    expect(existsSync(created.path)).toBe(true);

    // 归档里搜不到明文（会话标题、设置值都不可见）
    const raw = await readFile(created.path);
    expect(raw.includes(Buffer.from("冒烟会话"))).toBe(false);
    expect(raw.includes(Buffer.from("sk-secret-value"))).toBe(false);

    await expect(inspectBackup({ path: created.path })).rejects.toThrow(/需要输入密码/);
    await expect(inspectBackup({ path: created.path, password: "wrong" })).rejects.toThrow(/密码错误/);
    const info = await inspectBackup({ path: created.path, password: "s3cret-pass" });
    expect(info.scopes).toEqual(["settings", "chats"]);
    expect(info.manifest.encrypted).toBe(true);

    // 列表不需要密码：标记"已加密"，不当成损坏文件
    const listed = await listBackups({ dir: join(dataDir, "backups") });
    expect(listed.backups[0]!.encrypted).toBe(true);
    expect(listed.backups[0]!.error).toBeUndefined();
    expect(listed.backups[0]!.scopes).toEqual([]);

    // 破坏现场后恢复
    const live = new Database(dbPath);
    live.exec("delete from messages; delete from conversations");
    live.close();
    await expect(restoreBackup({ ctx: ctx(), path: created.path, password: "wrong", safety: false })).rejects.toThrow(
      /密码错误/,
    );
    const restored = await restoreBackup({
      ctx: ctx(),
      path: created.path,
      password: "s3cret-pass",
      safety: false,
    });
    expect(restored.scopes).toEqual(["settings", "chats"]);
    const after = new Database(dbPath, { readonly: true });
    expect(after.query("select count(*) c from messages").get()).toEqual({ c: 2 });
    after.close();
  });

  test("远端：配置读写、创建时上传、列取与下载（假 S3 服务端）", async () => {
    const store = new Map<string, Buffer>();
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const key = decodeURIComponent(url.pathname.replace("/bucket/", ""));
        if (req.method === "PUT") {
          store.set(key, Buffer.from(await req.arrayBuffer()));
          return new Response("", { status: 200 });
        }
        if (url.searchParams.get("list-type") === "2") {
          const contents = [...store.entries()]
            .map(([k, v]) => `<Contents><Key>${k}</Key><Size>${v.length}</Size><LastModified>2026-09-12T10:15:00.000Z</LastModified></Contents>`)
            .join("");
          return new Response(`<?xml version="1.0"?><ListBucketResult>${contents}</ListBucketResult>`);
        }
        const item = store.get(key);
        if (!item) return new Response("missing", { status: 404 });
        return new Response(new Uint8Array(item), { headers: { "content-length": String(item.length) } });
      },
    });
    try {
      writeRemoteConfig(
        {
          ...DEFAULT_REMOTE_CONFIG,
          kind: "s3",
          enabled: true,
          endpoint: `http://127.0.0.1:${server.port}`,
          bucket: "bucket",
          region: "us-east-1",
          accessKey: "AKIAIOSFODNN7EXAMPLE",
          secretKey: "secret",
          prefix: "omni",
        },
        ctx(),
      );
      const config = readRemoteConfig(ctx());
      expect(config.enabled).toBe(true);
      expect(config.bucket).toBe("bucket");
      expect(await testRemote(ctx())).toMatchObject({ ok: true });

      const created = await createBackup({
        ctx: ctx(),
        scopes: ["settings"],
        password: "pw",
        upload: true,
        onProgress: () => {},
      });
      expect(created.uploaded?.key).toBe(`omni/${created.name}`);
      expect(store.size).toBe(1);

      const remote = await listRemoteBackups(ctx());
      expect(remote.map((e) => e.name)).toEqual([created.name]);
      expect(remote[0]!.bytes).toBe(created.bytes);

      const downloaded = await downloadRemoteBackup({ ctx: ctx(), fileName: created.name });
      expect(existsSync(downloaded.path)).toBe(true);
      const info = await inspectBackup({ path: downloaded.path, password: "pw" });
      expect(info.scopes).toEqual(["settings"]);

      // 未启用远端时勾选上传必须明确报错（而不是静默成功）
      writeRemoteConfig({ ...DEFAULT_REMOTE_CONFIG }, ctx());
      await expect(createBackup({ ctx: ctx(), scopes: ["settings"], upload: true })).rejects.toThrow(/未启用/);
    } finally {
      await server.stop(true);
    }
  });

  test("未选任何作用域时拒绝创建", async () => {
    await expect(createBackup({ ctx: ctx(), scopes: [] })).rejects.toThrow("请至少选择一个要备份的内容");
  });
});
