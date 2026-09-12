/**
 * 数据库迁移冒烟测试（独立进程跑，不依赖 electrobun / 窗口）：
 * 1. journal 完整性：条目按 idx 递增、`when` 严格递增（drizzle 用 DB 里最大的
 *    created_at 判断是否跳过迁移，`when` 倒挂会让老用户升级时漏建表）。
 * 2. 全新库：全部迁移按序应用，关键表齐全。
 * 3. 重复打开同一个库：迁移幂等，不报错、不重复应用。
 *
 * 跑法：bun scripts/migrations-smoke.ts（脚本自建临时库并回收）
 */
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const MIGRATIONS = `${import.meta.dir}/../src/bun/db/migrations`;

// 每个已发布功能都要在此登记一张代表表，迁移漏建会在这里暴露。
const EXPECTED_TABLES = [
  "settings",
  "conversations",
  "messages",
  "voice_records",
  "image_records",
  "translation_records",
  "agent_events",
  "prompts",
  "user_prompts",
  "skills",
  "preset_skills",
  "cloud_providers",
  "mcp_servers",
  "knowledge_bases",
  "knowledge_docs",
  "knowledge_chunks",
  "memories",
  "video_records",
  "benchmark_records",
  "agent_permissions",
  "agent_todos",
  "agent_artifacts",
  "automations",
  "automation_runs",
];

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}
let step = 0;
const ok = (msg: string) => console.log(`[${++step}] OK ${msg}`);

// 1. journal 完整性
// 历史遗留：idx <= 12 的早期条目（0006/0007）`when` 自 v0.0.3-canary.0 起就小于前一条，
// 但所有已发布版本都先于后续迁移按数组顺序应用过它们，对用户无害；且 0006 是
// ALTER TABLE ADD COLUMN，改 `when` 会让老库重复执行而报错，故原值保持不动。
// 真正致命的是「新迁移的 when 低于老库已记录的最大 when」——drizzle 会直接跳过它，
// 于是老用户升级后缺表，故 idx >= 13 起强制严格递增且高于全部历史值。
const LEGACY_MAX_IDX = 12;
const journal = JSON.parse(readFileSync(`${MIGRATIONS}/meta/_journal.json`, "utf8")) as {
  entries: { idx: number; when: number; tag: string }[];
};
journal.entries.forEach((e, i) => {
  assert(e.idx === i, `journal 条目 idx 错位：第 ${i} 项是 ${e.idx}（${e.tag}）`);
});
const legacyMaxWhen = Math.max(...journal.entries.filter((e) => e.idx <= LEGACY_MAX_IDX).map((e) => e.when));
for (const e of journal.entries.filter((e) => e.idx > LEGACY_MAX_IDX)) {
  assert(e.when > legacyMaxWhen, `迁移 ${e.tag} 的 when=${e.when} 未高于历史最大值 ${legacyMaxWhen}，老库升级会跳过它`);
  assert(e.when > journal.entries[e.idx - 1]!.when, `迁移 ${e.tag} 的 when 未高于前一条 ${journal.entries[e.idx - 1]!.tag}`);
}
ok(`journal 完整（${journal.entries.length} 个迁移，idx >= 13 的 when 均高于历史最大值）`);

const dir = mkdtempSync(path.join(tmpdir(), "omni-migrations-"));
const dbPath = path.join(dir, "omni-studio.db");

function apply(label: string): { tables: string[]; applied: number; maxWhen: number } {
  const sqlite = new Database(dbPath, { create: true });
  try {
    migrate(drizzle({ client: sqlite }), { migrationsFolder: MIGRATIONS });
  } catch (e) {
    throw new Error(`${label} 迁移失败：${(e as Error).message}`, { cause: e });
  }
  const tables = (
    sqlite.query("select name from sqlite_master where type='table'").all() as { name: string }[]
  ).map((r) => r.name);
  const stat = sqlite
    .query("select count(*) as applied, max(created_at) as maxWhen from __drizzle_migrations")
    .get() as { applied: number; maxWhen: number };
  sqlite.close();
  return { tables, ...stat };
}

// 2. 全新库
const fresh = apply("全新库");
const missing = EXPECTED_TABLES.filter((t) => !fresh.tables.includes(t));
assert(missing.length === 0, `全新库缺表：${missing.join(", ")}`);
assert(fresh.applied === journal.entries.length, `应应用 ${journal.entries.length} 个迁移，实际 ${fresh.applied}`);
ok(`全新库建表齐全（${fresh.tables.length} 张表，应用 ${fresh.applied} 个迁移）`);

// 3. 幂等重跑
const again = apply("重复打开");
assert(again.applied === fresh.applied, `重复打开后迁移数变化：${fresh.applied} → ${again.applied}`);
ok("重复打开同一库：迁移幂等");

rmSync(dir, { recursive: true, force: true });
console.log("\nmigrations smoke 全部通过");
