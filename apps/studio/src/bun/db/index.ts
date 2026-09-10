import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdirSync, existsSync, renameSync } from "fs";
import * as schema from "./schema";
import { getDataDir } from "../paths";

const isDev = import.meta.env.NODE_ENV === "development";

// `omni` CLI（独立进程）通过 OMNI_DB_PATH / OMNI_DATA_DIR 指向打包应用的
// userData 数据库；未设置时行为与以前完全一致。
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
export const db = drizzle({ client: sqlite, schema: schema });
