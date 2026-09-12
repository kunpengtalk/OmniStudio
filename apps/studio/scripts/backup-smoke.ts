/**
 * 备份 / 恢复冒烟：临时数据目录 → 造数据（DB + 媒体 + 技能仓库）→ 命令行创建备份
 * → 列表 / 预览 → 破坏现场 → 命令行恢复 → 校验选中的作用域回来、未选的没被动。
 *
 * 跑法：bun run scripts/backup-smoke.ts（或 OMNI_DATA_DIR=… 指定目录保留现场）
 *
 * 这里刻意走 `bin/omi.ts` 子进程而不是直接调函数：验证 CLI 在独立进程、
 * 应用没运行、且**不加载应用数据层**的条件下确实能备份与恢复
 * （最后一个检查点专门把数据库弄坏来证明这一点）。
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "os";
import path from "path";

const providedDataDir = process.env.OMNI_DATA_DIR;
const dataDir = providedDataDir ?? mkdtempSync(path.join(tmpdir(), "omni-backup-smoke-"));
mkdirSync(dataDir, { recursive: true });

let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — ${detail ?? ""}`}`);
  if (!ok) failed++;
};

const skillsRepo = path.join(dataDir, "skills-repo");
const dbPath = path.join(dataDir, "omni-studio.db");

// 1. 造数据：设置（含密钥）、云服务商、会话与消息、记忆、技能仓库文件、媒体文件
// 表结构按迁移文件建（含后续 ALTER TABLE 补的列），与真实数据目录一致；
// drizzle 自己的迁移记录表不建 —— 那是应用/数据层的事，备份命令不碰它。
{
  const sqlite = new Database(dbPath, { create: true });
  const migrations = path.join(import.meta.dir, "..", "src", "bun", "db", "migrations");
  const files = (await Array.fromAsync(new Bun.Glob("*.sql").scan({ cwd: migrations }))).sort();
  for (const file of files) {
    const text = await Bun.file(path.join(migrations, file)).text();
    for (const stmt of text.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (!trimmed || /__drizzle_migrations/i.test(trimmed)) continue;
      try {
        sqlite.exec(trimmed);
      } catch {
        // 迁移里可能含已存在对象的语句（索引 / 触发器）：建库阶段忽略
      }
    }
  }
  sqlite.exec(
    `insert into settings (key, value) values
      ('VLLM_API_KEY', 'sk-smoke-secret'), ('SERVER_PORT', '8080'), ('SKILLS_CENTRAL_PATH', '${skillsRepo}')`,
  );
  sqlite.exec(
    "insert into cloud_providers (id, name, vendor, base_url, api_key, models) values ('deepseek','DeepSeek','','https://api.deepseek.com','sk-cloud','[]')",
  );
  sqlite.exec("insert into conversations (id, title, app) values (1, '冒烟会话', 'chat')");
  sqlite.exec("insert into messages (conversation_id, role, content) values (1, 'user', '你好'), (1, 'assistant', '你好！')");
  sqlite.exec("insert into memories (content, category, status) values ('冒烟记忆', 'fact', 'active')");
  sqlite.exec("insert into image_records (status, backend, prompt, image_path) values ('done','mlx','a cat','gen/cat.png')");
  sqlite.close();
}
await mkdir(path.join(skillsRepo, "my-skill"), { recursive: true });
await writeFile(path.join(skillsRepo, "my-skill", "SKILL.md"), "# 冒烟技能\n");
await mkdir(path.join(skillsRepo, ".git"), { recursive: true });
await writeFile(path.join(skillsRepo, ".git", "HEAD"), "ref: refs/heads/main\n");
await mkdir(path.join(dataDir, "images", "audio"), { recursive: true });
await writeFile(path.join(dataDir, "images", "audio", "tts-1.mp3"), Buffer.alloc(4096, 3));
await mkdir(path.join(dataDir, "images", "chat", "1"), { recursive: true });
await writeFile(path.join(dataDir, "images", "chat", "1", "a.png"), Buffer.alloc(1024, 4));

// 2. 命令行运行（应用没在运行 —— 这正是要验证的场景）
const omi = path.join(import.meta.dir, "..", "bin", "omi.ts");
function runOmi(args: string[]): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync(["bun", omi, ...args], {
    env: { ...process.env, OMNI_DATA_DIR: dataDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode ?? 0,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

/** 异步跑 CLI：假 S3 服务端跑在本进程里，spawnSync 会把事件循环卡死。 */
async function runOmiAsync(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", omi, ...args], {
    env: { ...process.env, OMNI_DATA_DIR: dataDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  return {
    code,
    out: await new Response(proc.stdout).text(),
    err: await new Response(proc.stderr).text(),
  };
}

const outDir = path.join(dataDir, "out");
const created = runOmi([
  "backup",
  "create",
  "--scopes",
  "settings,chats,skills,memory",
  "--out",
  outDir,
  "--note",
  "冒烟",
  "--json",
]);
check("omi backup create 成功", created.code === 0, created.err.trim());
let backupPath = "";
if (created.code === 0) {
  const payload = JSON.parse(created.out) as { path: string; manifest: { scopes: string[] } };
  backupPath = payload.path;
  check("创建结果里带上所选作用域", payload.manifest.scopes.join(",") === "settings,chats,skills,memory");
  check("归档文件已生成", existsSync(backupPath), backupPath);
}

const listed = runOmi(["backup", "list", "--dir", outDir]);
check("omi backup list 列出该备份", listed.code === 0 && listed.out.includes(path.basename(backupPath)), listed.err.trim());

const inspected = runOmi(["backup", "inspect", backupPath, "--json"]);
if (inspected.code === 0) {
  const info = JSON.parse(inspected.out) as { scopes: string[]; manifest: { db: { tables: Record<string, number> } } };
  check("预览含会话数据", (info.manifest.db.tables.messages ?? 0) === 2);
  check("预览不包含未选作用域（media 表为空）", (info.manifest.db.tables.image_records ?? 0) === 0);
} else {
  check("omi backup inspect 成功", false, inspected.err.trim());
}

// 3. 破坏现场：删消息、改设置、删技能文件 / 聊天附件 / 媒体文件，并加一条"恢复不该留"的记忆
{
  const db = new Database(dbPath);
  db.exec("delete from messages");
  db.exec("update settings set value = '9999' where key = 'SERVER_PORT'");
  db.exec("insert into memories (content, category, status) values ('恢复后新增', 'fact', 'active')");
  db.close();
}
rmSync(path.join(skillsRepo, "my-skill"), { recursive: true, force: true });
rmSync(path.join(dataDir, "images", "chat", "1", "a.png"), { force: true });
rmSync(path.join(dataDir, "images", "gen", "cat.png"), { force: true });

// 4. 恢复（--yes 跳过确认；媒体没进备份，其文件应保持"已删除"状态）
const restored = runOmi(["backup", "restore", backupPath, "--yes", "--json"]);
check("omi backup restore 成功", restored.code === 0, restored.err.trim());
if (restored.code === 0) {
  const result = JSON.parse(restored.out) as { files: number; tables: { table: string; rows: number }[]; safetyPath?: string };
  check("恢复写回了消息", result.tables.find((t) => t.table === "messages")?.rows === 2);
  check("恢复了技能仓库文件", result.files >= 1, JSON.stringify(result.files));
  check("恢复前生成了安全备份", !!result.safetyPath && existsSync(result.safetyPath), result.safetyPath ?? "无");
}

{
  const db = new Database(dbPath, { readonly: true });
  const messages = db.query("select count(*) c from messages").get() as { c: number };
  const port = db.query("select value v from settings where key = 'SERVER_PORT'").get() as { v: string };
  const memories = db.query("select count(*) c from memories").get() as { c: number };
  const media = db.query("select count(*) c from image_records").get() as { c: number };
  check("消息回来了", messages.c === 2, String(messages.c));
  check("设置回到备份时的值", port.v === "8080", port.v);
  check("记忆被备份里的内容整体替换（现场新增的消失）", memories.c === 1, `memories=${memories.c}`);
  check("未参与备份的作用域保持现状（media 记录没动）", media.c === 1, `image_records=${media.c}`);
  db.close();
}
check("技能文件回来了", existsSync(path.join(skillsRepo, "my-skill", "SKILL.md")));
check("聊天附件随 chats 一起恢复", existsSync(path.join(dataDir, "images", "chat", "1", "a.png")));
check("备份外的媒体文件没有被凭空创建", !existsSync(path.join(dataDir, "images", "gen", "cat.png")));

// 5. 恢复期间应用在运行必须被拒绝（用假的控制 socket 让 isAppRunning 认为应用在线）
//    注意用异步 spawn：spawnSync 会阻塞本进程事件循环，假 socket 就没人应答了。
const fakeSocket = path.join(dataDir, "omni-control.sock");
const fakeApp = Bun.serve({
  unix: fakeSocket,
  fetch() {
    return new Response(JSON.stringify({ ok: true, data: { version: "smoke" } }));
  },
});
const blockedProc = Bun.spawn(["bun", omi, "backup", "restore", backupPath, "--yes"], {
  env: { ...process.env, OMNI_DATA_DIR: dataDir, OMNI_CONTROL_SOCKET: fakeSocket },
  stdout: "pipe",
  stderr: "pipe",
});
const blockedCode = await blockedProc.exited;
const blockedErr = await new Response(blockedProc.stderr).text();
await fakeApp.stop(true);
check(
  "应用在运行时拒绝离线恢复",
  blockedCode !== 0 && blockedErr.includes("正在运行"),
  blockedErr.trim(),
);
// 非备份文件被拒绝
const junk = path.join(dataDir, "junk.omnibackup");
await writeFile(junk, "not a tar");
const badInspect = runOmi(["backup", "inspect", junk]);
check("非备份文件被拒绝", badInspect.code !== 0, badInspect.out.trim());

// 6. 加密 + 远端上传：起一个假 S3，配好远端，再走完整命令行流程
{
  const store = new Map<string, Buffer>();
  const fakeS3 = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const key = decodeURIComponent(url.pathname.replace("/bucket/", ""));
      if (req.method === "PUT") {
        store.set(key, Buffer.from(await req.arrayBuffer()));
        return new Response("", { status: 200 });
      }
      if (req.method === "DELETE") {
        store.delete(key);
        return new Response("", { status: 204 });
      }
      if (url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const contents = [...store.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([k, v]) => `<Contents><Key>${k}</Key><Size>${v.length}</Size><LastModified>2026-09-12T10:15:00.000Z</LastModified></Contents>`)
          .join("");
        return new Response(`<?xml version="1.0"?><ListBucketResult>${contents}</ListBucketResult>`);
      }
      const item = store.get(key);
      if (!item) return new Response("missing", { status: 404 });
      return new Response(new Uint8Array(item), { headers: { "content-length": String(item.length) } });
    },
  });

  // 远端配置直接写进 settings 表（应用内界面写的是同一批键）
  const cfg = new Database(dbPath);
  const put = cfg.prepare("insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value");
  put.run("BACKUP_REMOTE_KIND", "s3");
  put.run("BACKUP_REMOTE_ENABLED", "1");
  put.run("BACKUP_REMOTE_ENDPOINT", `http://127.0.0.1:${fakeS3.port}`);
  put.run("BACKUP_REMOTE_BUCKET", "bucket");
  put.run("BACKUP_REMOTE_REGION", "us-east-1");
  put.run("BACKUP_REMOTE_ACCESS_KEY", "AKIAIOSFODNN7EXAMPLE");
  put.run("BACKUP_REMOTE_SECRET_KEY", "smoke-secret");
  put.run("BACKUP_REMOTE_PREFIX", "omni");
  cfg.close();

  const remoteTest = await runOmiAsync(["backup", "remote", "test"]);
  check("omi backup remote test 通过", remoteTest.code === 0 && remoteTest.out.includes("✓"), remoteTest.err.trim());

  const encrypted = await runOmiAsync([
    "backup",
    "create",
    "--scopes",
    "settings,skills",
    "--password",
    "smoke-pass",
    "--upload",
    "--note",
    "加密上传",
    "--json",
  ]);
  check("加密 + 上传成功", encrypted.code === 0, encrypted.err.trim());
  let encPath = "";
  if (encrypted.code === 0) {
    const payload = JSON.parse(encrypted.out) as { path: string; manifest: { encrypted?: boolean }; uploaded?: { location: string } };
    encPath = payload.path;
    check("清单标记已加密", payload.manifest.encrypted === true);
    check("已上传到远端", !!payload.uploaded?.location && store.size === 1, JSON.stringify(payload.uploaded));
    const raw = await Bun.file(encPath).arrayBuffer();
    const bytes = Buffer.from(raw);
    check("归档里搜不到明文", !bytes.includes(Buffer.from("sk-smoke-secret")) && !bytes.includes(Buffer.from("my-skill")));
    check("归档带加密魔数", bytes.subarray(0, 8).toString("ascii") === "OMNBKP01");
  }

  const wrongPassword = await runOmiAsync(["backup", "inspect", encPath, "--password", "nope"]);
  check("密码错误被拒绝", wrongPassword.code !== 0 && wrongPassword.err.includes("密码错误"), wrongPassword.err.trim());
  const encInspect = await runOmiAsync(["backup", "inspect", encPath, "--password", "smoke-pass", "--json"]);
  check("正确密码可预览", encInspect.code === 0 && JSON.parse(encInspect.out).scopes.join(",") === "settings,skills");

  const remoteList = await runOmiAsync(["backup", "remote", "list", "--json"]);
  check("omi backup remote list 看得到上传的备份", remoteList.code === 0 && remoteList.out.includes("OmniStudio-"), remoteList.err.trim());
  const remoteDownload = await runOmiAsync(["backup", "remote", "download", path.basename(encPath)]);
  check("omi backup remote download 拉回本地", remoteDownload.code === 0 && remoteDownload.out.includes("已下载到"), remoteDownload.err.trim());

  await fakeS3.stop(true);
}

// 7. 数据库坏掉（迁移失败 / 文件损坏）时，备份能力必须还在：
//    先留一份库文件副本用于随后重建，再把库写成垃圾字节。
const dbCopy = path.join(dataDir, "omni-studio.db.keep");
await Bun.write(dbCopy, Bun.file(dbPath));
await writeFile(dbPath, "this is definitely not a sqlite database");
const listedBroken = runOmi(["backup", "list", "--dir", outDir]);
check(
  "数据库不可用时仍能列出备份（不加载数据层）",
  listedBroken.code === 0 && listedBroken.out.includes(path.basename(backupPath)),
  listedBroken.err.trim() || listedBroken.out.trim(),
);
const memoryBroken = runOmi(["memory", "list"]);
check(
  "同一个坏库下，需要数据层的命令确实会失败（对照）",
  memoryBroken.code !== 0,
  "memory list 竟然成功了，说明隔离检查没有意义",
);
rmSync(dbPath, { force: true });
await Bun.write(dbPath, Bun.file(dbCopy));
rmSync(dbCopy, { force: true });

// 只清理自己建的临时目录；调用方显式指定 OMNI_DATA_DIR 时保留现场。
if (!providedDataDir) {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {}
}

console.log(failed === 0 ? "\nBackup smoke 全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
