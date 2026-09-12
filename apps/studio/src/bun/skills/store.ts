// Skills 存储：Drizzle CRUD + 工具适配器解析（启停/覆盖/自定义）。
import { homedir } from "os";
import { join, resolve } from "path";
import { existsSync } from "fs";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  skills as skillsTable,
  skillTargets,
  skillPresets,
  presetSkills,
  presetSkillTools,
  skillProjects,
  skillsshCache,
} from "../db/schema";
import { getSetting, updateSettings } from "../db/settings";
import {
  TOOL_ADAPTERS,
  type CustomToolDef,
  type ToolAdapterDef,
  type ToolInfo,
  type ManagedSkill,
  type SkillTargetView,
  type SyncMode,
  type SyncStatus,
  type PresetView,
} from "../../shared/skills";
import { getCentralRepoDir } from "./central-repo";
import { audit } from "./audit";

// ---------------------------------------------------------------------------
// 工具适配器解析
// ---------------------------------------------------------------------------

export function getDisabledTools(): Set<string> {
  try {
    return new Set(JSON.parse(getSetting("SKILLS_TOOLS_DISABLED")) as string[]);
  } catch {
    return new Set();
  }
}

export function setToolEnabled(tool: string, enabled: boolean) {
  const set = getDisabledTools();
  if (enabled) set.delete(tool);
  else set.add(tool);
  updateSettings({ SKILLS_TOOLS_DISABLED: JSON.stringify([...set]) });
}

export function setAllToolsEnabled(enabled: boolean) {
  updateSettings({ SKILLS_TOOLS_DISABLED: enabled ? "[]" : JSON.stringify(TOOL_ADAPTERS.map((t) => t.key)) });
}

export function getCustomTools(): CustomToolDef[] {
  try {
    return JSON.parse(getSetting("SKILLS_CUSTOM_TOOLS")) as CustomToolDef[];
  } catch {
    return [];
  }
}

export function getPathOverrides(): Record<string, string> {
  try {
    return JSON.parse(getSetting("SKILLS_TOOL_PATH_OVERRIDES")) as Record<string, string>;
  } catch {
    return {};
  }
}

export function setCustomToolPath(tool: string, path: string | null) {
  const overrides = getPathOverrides();
  if (path) overrides[tool] = path;
  else delete overrides[tool];
  updateSettings({ SKILLS_TOOL_PATH_OVERRIDES: JSON.stringify(overrides) });
}

export function addCustomTool(def: CustomToolDef): { ok: boolean; error?: string } {
  const key = def.key.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  if (!key) return { ok: false, error: "invalid key" };
  if (TOOL_ADAPTERS.some((t) => t.key === key)) return { ok: false, error: "key exists" };
  const custom = getCustomTools();
  if (custom.some((t) => t.key === key)) return { ok: false, error: "key exists" };
  custom.push({ ...def, key });
  updateSettings({ SKILLS_CUSTOM_TOOLS: JSON.stringify(custom) });
  return { ok: true };
}

export function removeCustomTool(key: string) {
  const custom = getCustomTools().filter((t) => t.key !== key);
  updateSettings({ SKILLS_CUSTOM_TOOLS: JSON.stringify(custom) });
}

/** 合并内置 + 自定义工具为适配器列表（含路径覆盖）。 */
export function resolveAdapters(): ToolAdapterDef[] {
  const home = homedir();
  // 自定义工具 skillsDir 允许绝对路径或 ~/ 开头；统一成「home 相对」便于检测。
  const custom = getCustomTools().map<ToolAdapterDef>((c) => {
    const abs = c.skillsDir.startsWith("~")
      ? join(home, c.skillsDir.slice(2))
      : resolve(c.skillsDir);
    const relFromHome = abs.startsWith(home + "/") ? abs.slice(home.length + 1) : abs;
    return {
      key: c.key,
      name: c.name,
      skillsDir: relFromHome,
      detectDir: relFromHome.includes("/") ? relFromHome.split("/").slice(0, -1).join("/") : relFromHome,
      projectSkillsDir: c.projectSkillsDir?.startsWith("~") ? c.projectSkillsDir.slice(2) : c.projectSkillsDir,
      category: c.category,
    };
  });
  const merged = [...TOOL_ADAPTERS, ...custom];
  const overrides = getPathOverrides();
  if (Object.keys(overrides).length === 0) return merged;
  return merged.map((t) => {
    const o = overrides[t.key];
    if (!o) return t;
    const abs = o.startsWith("~") ? join(home, o.slice(2)) : resolve(o);
    return { ...t, skillsDir: abs.startsWith(home + "/") ? abs.slice(home.length + 1) : abs };
  });
}

/** 解析适配器全局 skills 目录为绝对路径。 */
export function adapterSkillsPath(a: ToolAdapterDef): string {
  const p = a.skillsDir;
  if (p.startsWith("~")) return join(homedir(), p.slice(2));
  if (p.startsWith("/")) return p;
  return join(homedir(), p);
}

function adapterDetectPath(a: ToolAdapterDef): string {
  const p = a.detectDir;
  if (p.startsWith("~")) return join(homedir(), p.slice(2));
  if (p.startsWith("/")) return p;
  return join(homedir(), p);
}

/** 全部工具的 UI 信息（installed/enabled/isCentral）。 */
export function listToolInfos(): ToolInfo[] {
  const central = resolve(getCentralRepoDir());
  const disabled = getDisabledTools();
  return resolveAdapters().map((a) => {
    const skillsPath = resolve(adapterSkillsPath(a));
    return {
      key: a.key,
      name: a.name,
      category: a.category,
      skillsDir: skillsPath,
      projectSkillsDir: a.projectSkillsDir ?? a.skillsDir,
      installed: existsSync(adapterDetectPath(a)) || existsSync(skillsPath),
      enabled: !disabled.has(a.key),
      isCustom: getCustomTools().some((c) => c.key === a.key),
      isCentral: skillsPath === central,
    };
  });
}

export function getAdapter(key: string): ToolAdapterDef | undefined {
  return resolveAdapters().find((a) => a.key === key);
}

export function getSyncMode(): SyncMode {
  return getSetting("SKILLS_SYNC_MODE") === "copy" ? "copy" : "symlink";
}

export function setSyncMode(mode: SyncMode) {
  updateSettings({ SKILLS_SYNC_MODE: mode });
}

// ---------------------------------------------------------------------------
// skills CRUD
// ---------------------------------------------------------------------------

export type NewSkill = {
  id: string;
  name: string;
  description?: string | null;
  sourceType?: ManagedSkill["sourceType"];
  sourceRef?: string | null;
  sourceSubpath?: string | null;
  sourceRevision?: string | null;
  tags?: string[];
};

export function upsertSkill(row: NewSkill) {
  db.insert(skillsTable)
    .values({
      id: row.id,
      name: row.name,
      description: row.description ?? null,
      sourceType: row.sourceType ?? "manual",
      sourceRef: row.sourceRef ?? null,
      sourceSubpath: row.sourceSubpath ?? null,
      sourceRevision: row.sourceRevision ?? null,
      tags: JSON.stringify(row.tags ?? []),
    })
    .onConflictDoUpdate({
      target: skillsTable.id,
      set: {
        name: row.name,
        description: row.description ?? null,
        sourceType: row.sourceType ?? "manual",
        sourceRef: row.sourceRef ?? null,
        sourceSubpath: row.sourceSubpath ?? null,
        sourceRevision: row.sourceRevision ?? null,
        updatedAt: Date.now(),
      },
    })
    .run();
}

export function getSkillRow(id: string) {
  return db.select().from(skillsTable).where(eq(skillsTable.id, id)).get();
}

export function listSkillRows() {
  return db.select().from(skillsTable).all().sort((a, b) => a.name.localeCompare(b.name));
}

export function deleteSkillRows(ids: string[]) {
  if (ids.length === 0) return;
  db.delete(skillsTable).where(inArray(skillsTable.id, ids)).run();
  db.delete(skillTargets).where(inArray(skillTargets.skillId, ids)).run();
  db.delete(presetSkills).where(inArray(presetSkills.skillId, ids)).run();
  db.delete(presetSkillTools).where(inArray(presetSkillTools.skillId, ids)).run();
}

export function setSkillTags(id: string, tags: string[]) {
  db.update(skillsTable).set({ tags: JSON.stringify(tags) }).where(eq(skillsTable.id, id)).run();
}

export function parseTags(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function renameTagEverywhere(from: string, to: string) {
  for (const row of db.select().from(skillsTable).all()) {
    const tags = parseTags(row.tags);
    if (tags.includes(from)) {
      setSkillTags(row.id, [...new Set(tags.map((t) => (t === from ? to : t)))]);
    }
  }
}

export function deleteTagEverywhere(tag: string) {
  for (const row of db.select().from(skillsTable).all()) {
    const tags = parseTags(row.tags);
    if (tags.includes(tag)) {
      setSkillTags(row.id, tags.filter((t) => t !== tag));
    }
  }
}

export function getAllTags(): string[] {
  const set = new Set<string>();
  for (const row of db.select().from(skillsTable).all()) {
    for (const t of parseTags(row.tags)) set.add(t);
  }
  return [...set].sort();
}

// ---------------------------------------------------------------------------
// skill_targets CRUD
// ---------------------------------------------------------------------------

export function listTargetRows() {
  return db.select().from(skillTargets).all();
}

export function getTargetRowsFor(skillId: string) {
  return db.select().from(skillTargets).where(eq(skillTargets.skillId, skillId)).all();
}

export function upsertTarget(skillId: string, tool: string, mode: SyncMode, sourceHash: string | null) {
  db.insert(skillTargets)
    .values({ skillId, tool, mode, sourceHash })
    .onConflictDoUpdate({
      target: [skillTargets.skillId, skillTargets.tool],
      set: { mode, sourceHash, updatedAt: Date.now() },
    })
    .run();
}

export function deleteTarget(skillId: string, tool: string) {
  db.delete(skillTargets).where(and(eq(skillTargets.skillId, skillId), eq(skillTargets.tool, tool))).run();
}

/** 还有哪些 target 指向同一路径（共享目录删除前的幸存者检查）。 */
export function countTargetsOnPath(skillId: string, tool: string, path: string, all: { skillId: string; tool: string }[], skillsPathOf: (tool: string) => string): number {
  let n = 0;
  for (const t of all) {
    if (t.skillId === skillId && t.tool === tool) continue;
    if (skillsPathOf(t.tool) === path) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// presets CRUD
// ---------------------------------------------------------------------------

export function ensureDefaultPreset(): string {
  const rows = db.select().from(skillPresets).all().sort((a, b) => a.sortOrder - b.sortOrder);
  if (rows.length > 0) {
    if (!getSetting("SKILLS_ACTIVE_PRESET")) {
      updateSettings({ SKILLS_ACTIVE_PRESET: rows[0]!.id });
    }
    return getSetting("SKILLS_ACTIVE_PRESET");
  }
  const id = "default";
  db.insert(skillPresets)
    .values({ id, name: "Default", sortOrder: 0 })
    .onConflictDoNothing()
    .run();
  updateSettings({ SKILLS_ACTIVE_PRESET: id });
  return id;
}

export function getActivePresetId(): string {
  return ensureDefaultPreset();
}

export function setActivePreset(id: string) {
  updateSettings({ SKILLS_ACTIVE_PRESET: id });
}

export function listPresetRows() {
  ensureDefaultPreset();
  return db.select().from(skillPresets).all().sort((a, b) => a.sortOrder - b.sortOrder);
}

export function getPresetRowsWithCounts(): PresetView[] {
  const active = getActivePresetId();
  const rows = listPresetRows();
  return rows.map((r) => {
    const members = db
      .select()
      .from(presetSkills)
      .where(eq(presetSkills.presetId, r.id))
      .all();
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      icon: r.icon,
      sortOrder: r.sortOrder,
      skillCount: members.length,
      skillIds: members.map((m) => m.skillId),
      isActive: r.id === active,
    };
  });
}

export function createPreset(name: string, description?: string | null, icon?: string | null): string {
  const id = `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const maxOrder = Math.max(0, ...listPresetRows().map((r) => r.sortOrder));
  db.insert(skillPresets).values({ id, name, description: description ?? null, icon: icon ?? null, sortOrder: maxOrder + 1 }).run();
  audit("preset_create", `${id}:${name}`);
  return id;
}

export function updatePresetRow(id: string, name: string, description?: string | null, icon?: string | null) {
  db.update(skillPresets)
    .set({ name, description: description ?? null, icon: icon ?? null, updatedAt: Date.now() })
    .where(eq(skillPresets.id, id))
    .run();
}

export function deletePresetRow(id: string): { ok: boolean; error?: string } {
  const rows = listPresetRows();
  if (rows.length <= 1) return { ok: false, error: "last preset" };
  db.delete(skillPresets).where(eq(skillPresets.id, id)).run();
  db.delete(presetSkills).where(eq(presetSkills.presetId, id)).run();
  db.delete(presetSkillTools).where(eq(presetSkillTools.presetId, id)).run();
  if (getActivePresetId() === id) {
    const first = listPresetRows()[0];
    if (first) setActivePreset(first.id);
  }
  return { ok: true };
}

export function addSkillToPreset(presetId: string, skillId: string) {
  const maxOrder = Math.max(0, ...db.select().from(presetSkills).where(eq(presetSkills.presetId, presetId)).all().map((r) => r.sortOrder));
  db.insert(presetSkills).values({ presetId, skillId, sortOrder: maxOrder + 1 }).onConflictDoNothing().run();
}

export function removeSkillFromPreset(presetId: string, skillId: string) {
  db.delete(presetSkills).where(and(eq(presetSkills.presetId, presetId), eq(presetSkills.skillId, skillId))).run();
  db.delete(presetSkillTools).where(and(eq(presetSkillTools.presetId, presetId), eq(presetSkillTools.skillId, skillId))).run();
}

export function listPresetSkillIds(presetId: string): string[] {
  return db.select().from(presetSkills).where(eq(presetSkills.presetId, presetId)).all().map((r) => r.skillId);
}

export function getPresetSkillToggles(presetId: string, skillId: string): Record<string, boolean> {
  const rows = db
    .select()
    .from(presetSkillTools)
    .where(and(eq(presetSkillTools.presetId, presetId), eq(presetSkillTools.skillId, skillId)))
    .all();
  const out: Record<string, boolean> = {};
  for (const r of rows) out[r.tool] = r.enabled === 1;
  return out;
}

export function setPresetSkillToggle(presetId: string, skillId: string, tool: string, enabled: boolean) {
  db.insert(presetSkillTools)
    .values({ presetId, skillId, tool, enabled: enabled ? 1 : 0 })
    .onConflictDoUpdate({
      target: [presetSkillTools.presetId, presetSkillTools.skillId, presetSkillTools.tool],
      set: { enabled: enabled ? 1 : 0, updatedAt: Date.now() },
    })
    .run();
}

// ---------------------------------------------------------------------------
// projects CRUD
// ---------------------------------------------------------------------------

export function listProjectRows() {
  return db.select().from(skillProjects).all().sort((a, b) => a.name.localeCompare(b.name));
}

export function addProjectRow(path: string, name: string): { ok: boolean; id?: string; error?: string } {
  const existing = db.select().from(skillProjects).where(eq(skillProjects.path, path)).get();
  if (existing) return { ok: false, error: "duplicate" };
  const id = `proj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  db.insert(skillProjects).values({ id, name, path }).run();
  audit("project_add", `${id}:${path}`);
  return { ok: true, id };
}

export function removeProjectRow(id: string) {
  db.delete(skillProjects).where(eq(skillProjects.id, id)).run();
}

// ---------------------------------------------------------------------------
// 市场缓存
// ---------------------------------------------------------------------------

export function getCache<T>(key: string, ttlMs: number): T | null {
  const row = db.select().from(skillsshCache).where(eq(skillsshCache.key, key)).get();
  if (!row) return null;
  if (Date.now() - (row.fetchedAt ?? 0) > ttlMs) return null;
  try {
    return JSON.parse(row.payload) as T;
  } catch {
    return null;
  }
}

export function setCache(key: string, value: unknown) {
  db.insert(skillsshCache)
    .values({ key, payload: JSON.stringify(value), fetchedAt: Date.now() })
    .onConflictDoUpdate({ target: skillsshCache.key, set: { payload: JSON.stringify(value), fetchedAt: Date.now() } })
    .run();
}

// ---------------------------------------------------------------------------
// 组装 ManagedSkill（DB 行 + target 实时状态由 sync-engine 计算）
// ---------------------------------------------------------------------------

export function assembleManagedSkills(targetViews: Map<string, SkillTargetView[]>): ManagedSkill[] {
  return listSkillRows().map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    sourceType: row.sourceType,
    sourceRef: row.sourceRef,
    sourceRevision: row.sourceRevision,
    tags: parseTags(row.tags),
    updatedAt: row.updatedAt ?? 0,
    targets: targetViews.get(row.id) ?? [],
  }));
}

/** 同步状态计算（statusOf 由 sync-engine 提供的实时探测结果）。 */
export function toSyncStatus(mode: SyncMode, live: string): SyncStatus | null {
  switch (live) {
    case "central-root":
      return "central";
    case "link-to-source":
      return "synced";
    case "real-dir":
      return mode === "copy" ? "copied" : "conflict";
    case "foreign-link":
    case "real-file":
      return "conflict";
    case "absent":
      return "missing";
    default:
      return null;
  }
}
