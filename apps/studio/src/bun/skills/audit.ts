// Skills 操作审计日志（入库，最近 500 条）。
import { desc, lt } from "drizzle-orm";
import { db } from "../db";
import { skillAuditLog } from "../db/schema";

export function audit(action: string, detail?: string) {
  try {
    db.insert(skillAuditLog).values({ action, detail: detail ?? null }).run();
    // 只保留最近 500 条
    const rows = db.select().from(skillAuditLog).orderBy(desc(skillAuditLog.id)).all();
    if (rows.length > 500) {
      const cutoff = rows[499]!.id;
      db.delete(skillAuditLog).where(lt(skillAuditLog.id, cutoff)).run();
    }
  } catch {}
}

export function listAudit(limit = 20) {
  return db.select().from(skillAuditLog).orderBy(desc(skillAuditLog.id)).limit(limit).all();
}
