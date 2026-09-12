// 项目级管理：项目内 .agents/skills 等目录的技能列表 / 启停（-disabled 改名）/
// 与中央库双向同步（五态：内容哈希 + mtime 1s 容差）/ 覆盖前自动备份。
import { join, resolve } from "path";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, cpSync, statSync, readFileSync } from "fs";
import type { ProjectSkillView, ProjectSyncState } from "../../shared/skills";
import { getCentralRepoDir, getProjectBackupDir } from "./central-repo";
import { safeJoin, safeName } from "../path-safety";
import {
  listProjectRows,
  addProjectRow,
  removeProjectRow,
  listSkillRows,
  upsertSkill,
} from "./store";
import { isSkillDir, parseSkillMd, hashSkillDir, dirMtimeMs } from "./metadata";
import { copyDirSkipVcs, importSkillDir } from "./installer";
import { writeSkillMeta } from "./meta-sync";
import { audit } from "./audit";
import { discoverProjectAgentDirs } from "./scanner";

/** 项目内 agent skills 相对目录分组（共享目录合并，按 first-seen 归组）。 */
export function projectAgentGroups(projectPath: string): string[] {
  return discoverProjectAgentDirs(projectPath);
}

/** 项目内技能视图（全部 agent 目录合并 + enabled + 五态 + 中央库匹配）。 */
export function getProjectSkills(projectPath: string): ProjectSkillView[] {
  const groups = projectAgentGroups(projectPath);
  const out = new Map<string, ProjectSkillView>();
  const central = getCentralRepoDir();

  for (const rel of groups) {
    for (const enabled of [true, false]) {
      const dir = enabled ? join(projectPath, rel) : join(projectPath, `${rel}-disabled`);
      if (!existsSync(dir)) continue;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith(".")) continue;
        const full = join(dir, e.name);
        if (!isSkillDir(full)) continue;
        const meta = parseSkillMd(full);
        const key = `${rel}/${enabled ? "" : "disabled:"}${e.name}`;
        const match = matchCentralSkill(e.name, meta.name, hashSkillDir(full));
        out.set(key, {
          relDir: `${rel}/${e.name}`,
          name: meta.name || e.name,
          description: meta.description,
          enabled,
          centralId: match?.id ?? null,
          centralName: match?.name ?? null,
          syncState: match ? computeSyncState(join(central, match.id), full) : "project_only",
        });
      }
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 中央库匹配打分：sourceRef 路径命中(3) > 内容哈希(2) > slug 名字(1)。 */
function matchCentralSkill(
  dirName: string,
  skillName: string | null,
  hash: string,
): { id: string; name: string; score: number } | null {
  let best: { id: string; name: string; score: number } | null = null;
  for (const row of listSkillRows()) {
    let score = 0;
    if (row.id === dirName || row.name === skillName) score = 1;
    const centralDir = join(getCentralRepoDir(), row.id);
    if (existsSync(centralDir) && isSkillDir(centralDir) && hashSkillDir(centralDir) === hash) score = Math.max(score, 2);
    if (score > 0 && (!best || score > best.score)) best = { id: row.id, name: row.name, score };
  }
  return best;
}

function computeSyncState(centralDir: string, projectDir: string): ProjectSyncState {
  if (!existsSync(centralDir)) return "project_only";
  const sameHash = hashSkillDir(centralDir) === hashSkillDir(projectDir);
  if (sameHash) return "in_sync";
  const cm = dirMtimeMs(centralDir);
  const pm = dirMtimeMs(projectDir);
  const tolerance = 1000;
  const centerNewer = cm > pm + tolerance;
  const projectNewer = pm > cm + tolerance;
  if (centerNewer && !projectNewer) return "center_newer";
  if (projectNewer && !centerNewer) return "project_newer";
  return "diverged";
}

/** 添加项目：确保项目内默认 agent 目录存在（.agents/skills + disabled 兄弟）。 */
export function addProject(path: string): { ok: boolean; id?: string; error?: string; created?: string[] } {
  const abs = resolve(path);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return { ok: false, error: "dir not found" };
  const created: string[] = [];
  const existing = projectAgentGroups(abs);
  if (existing.length === 0) {
    // 默认创建通用标准目录（不覆盖用户已有结构）。
    const skillsDir = join(abs, ".agents/skills");
    const disabledDir = join(abs, ".agents/skills-disabled");
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(disabledDir, { recursive: true });
    created.push(".agents/skills");
  }
  const name = abs.split("/").pop() || abs;
  const result = addProjectRow(abs, name);
  if (!result.ok) return { ok: false, error: result.error };
  audit("project_add", abs);
  return { ok: true, id: result.id, created };
}

export function removeProject(id: string) {
  removeProjectRow(id);
}

/** 启停：skills 与 skills-disabled 兄弟目录间改名。 */
export function toggleProjectSkill(projectPath: string, relDir: string, enabled: boolean): { ok: boolean; error?: string } {
  // relDir 来自 webview：必须解析后仍在项目目录内，否则改名/删除会跑到项目外。
  const full = safeJoin(projectPath, relDir);
  const name = safeName(relDir.split("/").pop() ?? "");
  if (!full || !name) return { ok: false, error: "非法的技能路径" };
  const parent = relDir.split("/").slice(0, -1).join("/");
  const base = parent.replace(/-disabled$/, "");
  const targetRel = enabled ? join(base, name) : join(`${base}-disabled`, name);
  const target = safeJoin(projectPath, targetRel);
  if (!target) return { ok: false, error: "非法的技能路径" };
  try {
    if (enabled) mkdirSync(join(projectPath, base), { recursive: true });
    else mkdirSync(join(projectPath, `${base}-disabled`), { recursive: true });
    renameSync(full, target);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export function deleteProjectSkill(projectPath: string, relDir: string): { ok: boolean; error?: string } {
  const full = safeJoin(projectPath, relDir);
  if (!full) return { ok: false, error: "非法的技能路径" };
  try {
    rmSync(full, { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** 项目技能收编进中央库（不动项目目录）。 */
export function importProjectSkill(projectPath: string, relDir: string): { ok: boolean; id?: string; error?: string } {
  const full = safeJoin(projectPath, relDir);
  if (!full || !existsSync(full) || !isSkillDir(full)) return { ok: false, error: "skill not found" };
  return importSkillDir(full, { sourceType: "project", sourceRef: projectPath });
}

/** 覆盖前自动备份到 <central>/.omnistudio/project-backups/<ts>/<name>。 */
function backupBeforeOverwrite(label: string, dir: string) {
  try {
    const dest = join(getProjectBackupDir(), `${Date.now().toString(36)}-${label}`);
    mkdirSync(dest, { recursive: true });
    cpSync(dir, join(dest, "old"), { recursive: true });
  } catch {}
}

/** 中央库 → 项目（覆盖项目侧）。 */
export function exportSkillToProject(projectPath: string, skillId: string, agentRel?: string): { ok: boolean; error?: string } {
  const id = safeName(skillId);
  const centralDir = id ? safeJoin(getCentralRepoDir(), id) : null;
  if (!id || !centralDir || !existsSync(centralDir)) return { ok: false, error: "skill missing in central" };
  const rel = agentRel ?? defaultProjectRel(projectPath);
  const target = safeJoin(projectPath, join(rel, id));
  if (!target) return { ok: false, error: "非法的目标路径" };
  backupBeforeOverwrite(`proj-${id}`, target);
  try {
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    mkdirSync(join(projectPath, rel), { recursive: true });
    copyDirSkipVcs(centralDir, target);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function defaultProjectRel(projectPath: string): string {
  const groups = projectAgentGroups(projectPath);
  if (groups.length > 0) return groups[0]!;
  return ".agents/skills";
}

/** 项目 → 中央库（覆盖中央库侧，重推 copy 目标）。 */
export function updateProjectSkillToCenter(projectPath: string, relDir: string): { ok: boolean; id?: string; error?: string } {
  const full = safeJoin(projectPath, relDir);
  if (!full || !existsSync(full) || !isSkillDir(full)) return { ok: false, error: "skill not found" };
  const name = relDir.split("/").pop()!;
  const meta = parseSkillMd(full);
  const match = matchCentralSkill(name, meta.name, hashSkillDir(full));
  const centralDir = match ? join(getCentralRepoDir(), match.id) : null;
  if (centralDir && existsSync(centralDir)) {
    backupBeforeOverwrite(`center-${match!.id}`, centralDir);
    try {
      const staging = join(getCentralRepoDir(), ".omnistudio", "tmp", `stage-${Date.now().toString(36)}`);
      copyDirSkipVcs(full, staging);
      rmSync(centralDir, { recursive: true, force: true });
      renameSync(staging, centralDir);
      const skillName = meta.name || match!.name;
      upsertSkill({
        id: match!.id,
        name: skillName,
        description: meta.description,
        sourceType: "project",
        sourceRef: projectPath,
      });
      writeSkillMeta(match!.id);
      return { ok: true, id: match!.id };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
  return importSkillDir(full, { sourceType: "project", sourceRef: projectPath });
}

/** 项目技能文档。 */
export function getProjectSkillDoc(projectPath: string, relDir: string): string | null {
  const full = safeJoin(projectPath, relDir);
  if (!full || !existsSync(full) || !isSkillDir(full)) return null;
  const marker = ["SKILL.md", "skill.md"].find((m) => existsSync(join(full, m)));
  if (!marker) return null;
  try {
    return readFileSync(join(full, marker), "utf8");
  } catch {
    return null;
  }
}

/** 列出项目（含技能数）。 */
export function listProjectViews() {
  return listProjectRows().map((r) => ({
    id: r.id,
    name: r.name,
    path: r.path,
    skillCount: getProjectSkills(r.path).length,
  }));
}
