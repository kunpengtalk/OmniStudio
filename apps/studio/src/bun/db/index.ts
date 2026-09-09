import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { Utils } from "electrobun/bun";
import { join } from "path";
import { mkdirSync, existsSync, renameSync } from "fs";
import * as schema from "./schema";

const isDev = import.meta.env.NODE_ENV === "development";

let dbPath: string;
if (isDev) {
  dbPath = "sqlite.db";
} else {
  // Ensure data directory exists
  const dataDir = Utils.paths.userData;
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  dbPath = join(dataDir, "omni-studio.db");
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
