import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Database } from "bun:sqlite";
import { join } from "path";
import { appendFileSync, copyFileSync, mkdirSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "fs";
import * as schema from "./schema";
import { getDataDir } from "../paths";
import { logEvent } from "../app-log";

const isDev = import.meta.env.NODE_ENV === "development";

// `omni` CLI（独立进程）通过 OMNI_DB_PATH / OMNI_DATA_DIR 指向打包应用的
// userData 数据库；未设置时行为与以前完全一致。路径解析见 `paths.getUserDataDir`，
// 这里不再 import electrobun，避免独立进程触发其模块级副作用。
let dbPath: string;
if (isDev && !process.env.OMNI_DB_PATH && !process.env.OMNI_DATA_DIR) {
  dbPath = "sqlite.db";
} else {
  // Ensure data directory exists
  const dataDir = getDataDir();
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  dbPath = process.env.OMNI_DB_PATH ?? join(dataDir, "omni-studio.db");
  for (const legacyName of ["vllm-studio.db", "kunpengtalk-studio.db"]) {
    if (!existsSync(dbPath)) {
      const legacyPath = join(dataDir, legacyName);
      if (existsSync(legacyPath)) {
        try {
          renameSync(legacyPath, dbPath);
        } catch {
          // ignore — fall back to a fresh database
        }
      }
    }
  }
}

const sqlite = new Database(dbPath, { create: true });
// WAL + busy timeout：记忆桥接（omi memory mcp / omi memory add）会在应用之外
// 直连这份库写回数据，WAL 允许多进程并发读写，busy timeout 吸收偶发锁竞争。
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA busy_timeout = 5000;");
sqlite.exec("PRAGMA synchronous = NORMAL;");
export const db = drizzle({ client: sqlite, schema: schema });

/**
 * 原始 bun:sqlite 连接。
 *
 * 备份恢复需要"应用这一条"写连接：另开一条连接会变成两个写者，
 * 与运行中的应用抢锁，恢复这种批量写入尤其容易撞 SQLITE_BUSY。
 */
export const sqliteClient = sqlite;

// 连接建立即迁移：gateway/rpc 等模块在 import 阶段就会读表，
// 若等 bun/index.ts 的顶层代码再 migrate，空库首次启动会先崩在 settings 表缺失上。
// 打包后所有模块合并进 app/bun/index.js，import.meta.dir 即 app/bun，路径带 db/ 前缀；
// 从源码直接运行（bun src/bun/xxx.ts）时 import.meta.dir 是 src/bun/db，前缀去掉。
const migrationsFolder = existsSync(join(import.meta.dir, "db", "migrations"))
  ? join(import.meta.dir, "db", "migrations")
  : join(import.meta.dir, "migrations");

/**
 * 迁移前备份数据库文件。
 *
 * 迁移失败时应用会起不来，而用户此时的唯一"修复手段"往往是删库（等于丢掉全部
 * 设置 / API Key / 会话）。这里保证任何一次迁移前都有一份可回滚的副本，
 * 并只保留最近 3 份，避免无限占盘。
 */
function backupBeforeMigrate(): void {
  try {
    if (!existsSync(dbPath) || statSync(dbPath).size === 0) return;
    // 全新库（还没有任何表）没有可回滚的数据，不必产生备份噪音。
    const tables = sqlite
      .query("select count(*) as c from sqlite_master where type='table'")
      .get() as { c: number } | null;
    if (!tables || tables.c === 0) return;
    const dir = join(dbPath, "..", "db-backups");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = join(dir, `${stamp}.db`);
    copyFileSync(dbPath, dest);
    // 只保留最近 3 份
    const keep = 3;
    const files = readdirSync(dir)
      .filter((n) => n.endsWith(".db"))
      .sort();
    for (const stale of files.slice(0, Math.max(0, files.length - keep))) {
      rmSync(join(dir, stale), { force: true });
    }
  } catch {
    // 备份失败不阻断启动（只读盘 / 空间不足等）；迁移失败时会另外记录日志。
  }
}

/** 迁移失败日志：应用可能因此起不来，留下可诊断的现场。 */
function logMigrateFailure(error: unknown): void {
  // 双写：统一日志（`omi logs` 应用没运行时直接读文件，照样能看到）+
  // 这份专用纯文本 —— 迁移失败时应用可能整个起不来，错误信息里指的就是它。
  logEvent({
    level: "error",
    source: "app",
    event: "db.migrate.failed",
    message: error instanceof Error ? error.message : String(error),
    detail: { dbPath, error },
  });
  try {
    const dir = join(getDataDir(), "logs");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, "db-migrate-error.log"),
      `[${new Date().toISOString()}] 迁移失败（数据库：${dbPath}）\n${String(error)}\n\n`,
    );
  } catch {
    // ignore
  }
}

backupBeforeMigrate();

/**
 * 迁移前自愈：按 hash 把已应用迁移行的 created_at 对齐到归真后的 journal 时间戳。
 *
 * 历史问题：0029 之前的 journal `when` 是伪造的**未来**时间戳（递增整数序列，最大
 * ≈2026-09-22），而 drizzle 迁移器判断「是否需要应用」只比较 `已应用行的最大
 * created_at < 待应用迁移的 when`，从不校验 hash —— 0029 用真实时间戳（≈2026-09-14）
 * 生成后小于库里的伪造值，每次启动都被判定「已应用过」而静默跳过，新列永远建不出
 * （线上表现：新建知识库 INSERT 报 no such column，界面点击无响应）。
 *
 * journal 的 when 已随修复归真（见 _journal.json 与提交说明）；这里把既有库中已应用
 * 行的 created_at 同步成归真值，让比较基准恢复真实时序。幂等：值一致的行不动；全新
 * 库（表不存在）直接返回，交给 migrate 顺序应用。
 */
function normalizeMigrationTimestamps(): void {
  try {
    const hasTable = sqlite
      .query("select 1 from sqlite_master where type='table' and name='__drizzle_migrations'")
      .get();
    if (!hasTable) return;
    const journalPath = join(migrationsFolder, "meta", "_journal.json");
    if (!existsSync(journalPath)) return;
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: { tag: string; when: number }[];
    };
    const rows = sqlite
      .query("SELECT hash, created_at FROM __drizzle_migrations")
      .all() as { hash: string; created_at: number | string }[];
    let fixed = 0;
    for (const entry of journal.entries) {
      const sqlPath = join(migrationsFolder, `${entry.tag}.sql`);
      if (!existsSync(sqlPath)) continue;
      const hash = new Bun.CryptoHasher("sha256").update(readFileSync(sqlPath)).digest("hex");
      const row = rows.find((r) => r.hash === hash);
      if (row && Number(row.created_at) !== entry.when) {
        sqlite.run("UPDATE __drizzle_migrations SET created_at = ? WHERE hash = ?", [
          entry.when,
          hash,
        ]);
        fixed += 1;
      }
    }
    if (fixed > 0) {
      logEvent({
        level: "warn",
        source: "app",
        event: "db.migrate.timestamps_normalized",
        message: `已按归真后的 journal 修正 ${fixed} 条迁移记录时间戳（修复伪造时间戳导致新迁移被静默跳过的问题）`,
      });
    }
  } catch (e) {
    // 修正失败不阻断启动：迁移若真因时间戳错乱被跳过，后续功能报错会引导查日志。
    logEvent({
      level: "warn",
      source: "app",
      event: "db.migrate.normalize_failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

normalizeMigrationTimestamps();
try {
  migrate(db, { migrationsFolder });
} catch (e) {
  logMigrateFailure(e);
  throw new Error(
    `数据库迁移失败：${e instanceof Error ? e.message : String(e)}\n` +
      `数据库：${dbPath}\n` +
      `迁移前备份位于同目录的 db-backups/（可复制回 ${join(dbPath)} 后重试），` +
      `详细日志见数据目录 logs/db-migrate-error.log。`,
    { cause: e },
  );
}
