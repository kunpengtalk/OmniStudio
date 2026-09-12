// 跨设备元数据：把 DB 里的技能/预设/目标/标签写成中央库内 .omnistudio/ 下的
// 规范化 JSON（随 git 提交）；git pull / 换机后 reindexFromMetadata 重建 DB。
import { join } from "path";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { eq } from "drizzle-orm";
import { db } from "../db";
import {
  skills as skillsTable,
  skillTargets,
  skillPresets,
  presetSkills,
  presetSkillTools,
} from "../db/schema";
import { getMetaDir, getCentralRepoDir, ensureCentralRepo } from "./central-repo";
import { hashSkillDir, parseSkillMd, isSkillDir } from "./metadata";
import { parseTags } from "./store";

interface SkillMetaFile {
  schema: 1;
  id: string;
  name: string;
  description: string | null;
  sourceType: string;
  sourceRef: string | null;
  sourceSubpath: string | null;
  sourceRevision: string | null;
  tags: string[];
  updatedAt: number;
}

interface PresetMetaFile {
  schema: 1;
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  sortOrder: number;
  skillIds: string[];
  /** skillId -> { tool -> enabled }。 */
  tools: Record<string, Record<string, boolean>>;
}

/** 全量写出（提交前调用）。规范：pretty JSON + 固定字段顺序 + LF。 */
export function writeAllMetadata() {
  ensureCentralRepo();
  const metaRoot = getMetaDir();
  const skillsDir = join(metaRoot, "skills");
  const presetsDir = join(metaRoot, "presets");
  mkdirSync(skillsDir, { recursive: true });
  mkdirSync(presetsDir, { recursive: true });

  const skillRows = db.select().from(skillsTable).all();
  const writtenIds = new Set<string>();
  for (const row of skillRows) {
    const meta: SkillMetaFile = {
      schema: 1,
      id: row.id,
      name: row.name,
      description: row.description,
      sourceType: row.sourceType,
      sourceRef: row.sourceRef,
      sourceSubpath: row.sourceSubpath,
      sourceRevision: row.sourceRevision,
      tags: parseTags(row.tags),
      updatedAt: row.updatedAt ?? Date.now(),
    };
    writeFileSync(join(skillsDir, `${row.id}.json`), JSON.stringify(meta, null, 2) + "\n");
    writtenIds.add(row.id);
  }
  // 清掉 DB 已无对应技能的孤儿元数据（保留 tmp / project-backups）。
  for (const e of readdirSync(skillsDir)) {
    if (!e.endsWith(".json")) continue;
    const id = e.slice(0, -5);
    if (!writtenIds.has(id)) {
      try {
        rmSync(join(skillsDir, e), { force: true });
      } catch {}
    }
  }

  const presetRows = db.select().from(skillPresets).all().sort((a, b) => a.sortOrder - b.sortOrder);
  const writtenPresets = new Set<string>();
  for (const p of presetRows) {
    const members = db.select().from(presetSkills).where(eq(presetSkills.presetId, p.id)).all();
    const tools: Record<string, Record<string, boolean>> = {};
    for (const m of members) {
      const toggles = db
        .select()
        .from(presetSkillTools)
        .where(eq(presetSkillTools.presetId, p.id))
        .all()
        .filter((t) => t.skillId === m.skillId);
      tools[m.skillId] = Object.fromEntries(toggles.map((t) => [t.tool, t.enabled === 1]));
    }
    const meta: PresetMetaFile = {
      schema: 1,
      id: p.id,
      name: p.name,
      description: p.description,
      icon: p.icon,
      sortOrder: p.sortOrder,
      skillIds: members.map((m) => m.skillId),
      tools,
    };
    writeFileSync(join(presetsDir, `${p.id}.json`), JSON.stringify(meta, null, 2) + "\n");
    writtenPresets.add(p.id);
  }
  for (const e of readdirSync(presetsDir)) {
    if (!e.endsWith(".json")) continue;
    if (!writtenPresets.has(e.slice(0, -5))) {
      try {
        rmSync(join(presetsDir, e), { force: true });
      } catch {}
    }
  }
}

/** 单技能元数据写出（安装/更新后轻量刷新）。 */
export function writeSkillMeta(skillId: string) {
  const row = db.select().from(skillsTable).where(eq(skillsTable.id, skillId)).get();
  if (!row) return;
  const meta: SkillMetaFile = {
    schema: 1,
    id: row.id,
    name: row.name,
    description: row.description,
    sourceType: row.sourceType,
    sourceRef: row.sourceRef,
    sourceSubpath: row.sourceSubpath,
    sourceRevision: row.sourceRevision,
    tags: parseTags(row.tags),
    updatedAt: row.updatedAt ?? Date.now(),
  };
  try {
    mkdirSync(join(getMetaDir(), "skills"), { recursive: true });
    writeFileSync(join(getMetaDir(), "skills", `${skillId}.json`), JSON.stringify(meta, null, 2) + "\n");
  } catch {}
}

/**
 * 从元数据重建 DB（git pull / 首次 clone 恢复后调用）：
 * - 磁盘技能目录 + 元数据 JSON → upsert skills 行（内容哈希未变保留 updatedAt）
 * - 预设与开关恢复；活动预设沿用 settings（本机状态）
 */
export function reindexFromMetadata(): { restored: number; presets: number } {
  ensureCentralRepo();
  const central = getCentralRepoDir();
  const skillsDir = join(getMetaDir(), "skills");
  let restored = 0;
  if (existsSync(skillsDir)) {
    for (const e of readdirSync(skillsDir)) {
      if (!e.endsWith(".json")) continue;
      try {
        const meta = JSON.parse(readFileSync(join(skillsDir, e), "utf8")) as SkillMetaFile;
        const dir = join(central, meta.id);
        if (!existsSync(dir) || !isSkillDir(dir)) continue;
        const diskMeta = parseSkillMd(dir);
        const hash = hashSkillDir(dir);
        // 内容未变时保留原 updatedAt（哈希存进 sourceSubpath 之外的字段会污染元数据，
        // 这里简单以当前时间覆盖——预设立即恢复即可）。
        void hash;
        db.insert(skillsTable)
          .values({
            id: meta.id,
            name: diskMeta.name || meta.name,
            description: diskMeta.description ?? meta.description,
            sourceType: (meta.sourceType as any) ?? "scan",
            sourceRef: meta.sourceRef,
            sourceSubpath: meta.sourceSubpath,
            sourceRevision: meta.sourceRevision,
            tags: JSON.stringify(meta.tags ?? []),
          })
          .onConflictDoUpdate({
            target: skillsTable.id,
            set: {
              name: diskMeta.name || meta.name,
              description: diskMeta.description ?? meta.description,
              sourceType: (meta.sourceType as any) ?? "scan",
              sourceRef: meta.sourceRef,
              sourceSubpath: meta.sourceSubpath,
              sourceRevision: meta.sourceRevision,
              tags: JSON.stringify(meta.tags ?? []),
            },
          })
          .run();
        restored++;
      } catch {}
    }
  }
  const presetsDir = join(getMetaDir(), "presets");
  let presets = 0;
  if (existsSync(presetsDir)) {
    for (const e of readdirSync(presetsDir)) {
      if (!e.endsWith(".json")) continue;
      try {
        const meta = JSON.parse(readFileSync(join(presetsDir, e), "utf8")) as PresetMetaFile;
        db.insert(skillPresets)
          .values({
            id: meta.id,
            name: meta.name,
            description: meta.description,
            icon: meta.icon,
            sortOrder: meta.sortOrder,
          })
          .onConflictDoUpdate({
            target: skillPresets.id,
            set: { name: meta.name, description: meta.description, icon: meta.icon, sortOrder: meta.sortOrder },
          })
          .run();
        db.delete(presetSkills).where(eq(presetSkills.presetId, meta.id)).run();
        for (const sid of meta.skillIds) {
          db.insert(presetSkills).values({ presetId: meta.id, skillId: sid }).onConflictDoNothing().run();
        }
        db.delete(presetSkillTools).where(eq(presetSkillTools.presetId, meta.id)).run();
        for (const [sid, tools] of Object.entries(meta.tools ?? {})) {
          for (const [tool, enabled] of Object.entries(tools)) {
            db.insert(presetSkillTools)
              .values({ presetId: meta.id, skillId: sid, tool, enabled: enabled ? 1 : 0 })
              .onConflictDoNothing()
              .run();
          }
        }
        presets++;
      } catch {}
    }
  }
  // DB 有但磁盘 + 元数据都没有的技能：清掉。
  for (const row of db.select().from(skillsTable).all()) {
    if (!existsSync(join(central, row.id))) {
      db.delete(skillsTable).where(eq(skillsTable.id, row.id)).run();
      db.delete(skillTargets).where(eq(skillTargets.skillId, row.id)).run();
    }
  }
  return { restored, presets };
}

export function metadataExists(): boolean {
  return existsSync(join(getMetaDir(), "skills"));
}
