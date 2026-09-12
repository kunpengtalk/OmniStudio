import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdirSync, existsSync, renameSync } from "fs";
import * as schema from "./schema";
import { getDataDir } from "../paths";

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

// 连接建立即迁移：gateway/rpc 等模块在 import 阶段就会读表，
// 若等 bun/index.ts 的顶层代码再 migrate，空库首次启动会先崩在 settings 表缺失上。
// 打包后所有模块合并进 app/bun/index.js，import.meta.dir 即 app/bun，路径带 db/ 前缀；
// 从源码直接运行（bun src/bun/xxx.ts）时 import.meta.dir 是 src/bun/db，前缀去掉。
const migrationsFolder = existsSync(join(import.meta.dir, "db", "migrations"))
  ? join(import.meta.dir, "db", "migrations")
  : join(import.meta.dir, "migrations");
migrate(db, { migrationsFolder });
