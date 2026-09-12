// Skills 域聚合入口：启动初始化、列表组装、技能文档、删除清理、RPC 辅助。
import { join } from "path";
import { existsSync, readFileSync, rmSync } from "fs";
import type { ManagedSkill, ProjectSkillView } from "../../shared/skills";
import {
  ensureCentralRepo,
  reindexCentralRepo,
  cleanupTmp,
  startCentralWatch,
  stopCentralWatch,
  getCentralRepoDir,
  getCentralInfo,
  onCentralChanged,
  muteSelfWrites,
  setCentralRepoPath,
} from "./central-repo";
import {
  assembleManagedSkills,
  deleteSkillRows,
  listToolInfos,
  setToolEnabled,
  setAllToolsEnabled,
  setCustomToolPath,
  addCustomTool,
  removeCustomTool,
  setSkillTags,
  getAllTags,
  renameTagEverywhere,
  deleteTagEverywhere,
  getSyncMode,
  setSyncMode,
  getPresetRowsWithCounts,
  createPreset,
  updatePresetRow,
  deletePresetRow,
  addSkillToPreset,
  removeSkillFromPreset,
  setActivePreset,
} from "./store";
import { assembleTargetViews, centralToolViews, unsyncSkillFromTool, syncSkillToTool } from "./sync-engine";
import { listTargetRows } from "./store";
import { writeSkillMeta, writeAllMetadata } from "./meta-sync";
import { startAutoBackup, backupStatus, backupInit, setBackupRemote, backupCommit, backupPush, backupPull, setAutoBackup, listSnapshots, createSnapshot, restoreSnapshot, resolveConflict, sizeReport } from "./git-backup";
import { audit } from "./audit";
import { applyPresetToDefault, applyPresetToCodingAgents, togglePresetSkillTool, ensurePresetReady } from "./presets";
import { fetchLeaderboard, searchSkillssh } from "./skillssh";
import {
  installFromSkillssh,
  cancelInstall,
  gitPreview,
  gitConfirm,
  gitCancelPreview,
  installLocal,
  batchImportFolder,
  checkSkillUpdate,
  checkAllSkillUpdates,
  updateSkill,
  onInstallProgress,
} from "./installer";
import { scanDiscoveredSkills, importDiscoveredGroup, importAllDiscovered, scanProjectWorkspaces, discoverProjectAgentDirs } from "./scanner";
import {
  getProjectSkills,
  addProject,
  removeProject,
  importProjectSkill,
  exportSkillToProject,
  updateProjectSkillToCenter,
  toggleProjectSkill,
  deleteProjectSkill,
  getProjectSkillDoc,
  listProjectViews,
} from "./projects";
import { dirSizeBytes } from "./metadata";
import { listSkillRows } from "./store";

export { listSkillRows };

/** 安装进度订阅（rpc 的 initSkillsBroadcast 用）。 */
export function onInstallProgressForRpc(fn: (p: import("../../shared/skills").SkillsInstallProgress) => void) {
  return onInstallProgress(fn);
}

/** 应用启动时初始化（bun/index.ts 调用）。 */
export function initSkills() {
  ensureCentralRepo();
  cleanupTmp();
  // 首次：目录里有技能但 DB 空（比如接管已有 ~/.agents/skills）→ 收编。
  reindexCentralRepo();
  ensurePresetReady();
  startCentralWatch();
  startAutoBackup();
}

export function shutdownSkills() {
  stopCentralWatch();
}

/** 组装「我的技能」列表：DB + target 实时状态 + 中央库同根工具。 */
export function listSkills(): ManagedSkill[] {
  const views = assembleTargetViews();
  const managed = assembleManagedSkills(views);
  for (const skill of managed) {
    const centrals = centralToolViews(skill.id);
    if (centrals.length > 0) {
      skill.targets = [...skill.targets.filter((t) => t.status !== "central"), ...centrals];
    }
  }
  return managed;
}

/** 技能 SKILL.md 文档。 */
export function getSkillDoc(skillId: string): { markdown: string } | null {
  const dir = join(getCentralRepoDir(), skillId);
  for (const marker of ["SKILL.md", "skill.md"]) {
    const p = join(dir, marker);
    if (existsSync(p)) {
      try {
        return { markdown: readFileSync(p, "utf8") };
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** 删除技能：卸载全部部署 + 删中央库目录 + 删 DB 行 + 刷元数据。 */
export function deleteSkills(ids: string[]): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const id of ids) {
    for (const t of listTargetRows().filter((t) => t.skillId === id)) {
      const r = unsyncSkillFromTool(id, t.tool);
      if (!r.ok) errors.push(`${id}/${t.tool}: ${r.error}`);
    }
    const dir = join(getCentralRepoDir(), id);
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      errors.push(`${id}: ${String(e)}`);
    }
  }
  deleteSkillRows(ids);
  writeAllMetadata();
  audit("delete", ids.join(","));
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// RPC 辅助（需要按 id 查项目路径的封装）
// ---------------------------------------------------------------------------

function projectPathOf(projectId: string): string | null {
  const row = listProjectViews().find((p) => p.id === projectId);
  return row?.path ?? null;
}

export function getCentralInfoForRpc() {
  const central = getCentralRepoDir();
  return getCentralInfo(dirSizeBytes(central), listSkillRows().length);
}

export function getProjectSkillsForRpc(projectId: string): { skills: ProjectSkillView[]; agentDirs: string[] } {
  const path = projectPathOf(projectId);
  if (!path) return { skills: [], agentDirs: [] };
  return { skills: getProjectSkills(path), agentDirs: discoverProjectAgentDirs(path) };
}

export function projectImportToCenterForRpc(projectId: string, relDir: string) {
  const path = projectPathOf(projectId);
  if (!path) return { ok: false, error: "project not found" };
  return importProjectSkill(path, relDir);
}

export function projectExportForRpc(projectId: string, skillId: string, agentRel?: string) {
  const path = projectPathOf(projectId);
  if (!path) return { ok: false, error: "project not found" };
  return exportSkillToProject(path, skillId, agentRel);
}

export function projectUpdateToCenterForRpc(projectId: string, relDir: string) {
  const path = projectPathOf(projectId);
  if (!path) return { ok: false, error: "project not found" };
  return updateProjectSkillToCenter(path, relDir);
}

export function projectToggleForRpc(projectId: string, relDir: string, enabled: boolean) {
  const path = projectPathOf(projectId);
  if (!path) return { ok: false, error: "project not found" };
  return toggleProjectSkill(path, relDir, enabled);
}

export function projectDeleteForRpc(projectId: string, relDir: string) {
  const path = projectPathOf(projectId);
  if (!path) return { ok: false, error: "project not found" };
  return deleteProjectSkill(path, relDir);
}

export function projectSkillDocForRpc(projectId: string, relDir: string): { markdown: string | null } {
  const path = projectPathOf(projectId);
  if (!path) return { markdown: null };
  return { markdown: getProjectSkillDoc(path, relDir) };
}

export {
  ensureCentralRepo,
  reindexCentralRepo,
  getCentralRepoDir,
  onCentralChanged,
  muteSelfWrites,
  setCentralRepoPath,
  listProjectViews,
  listToolInfos,
  setToolEnabled,
  setAllToolsEnabled,
  setCustomToolPath,
  addCustomTool,
  removeCustomTool,
  setSkillTags,
  writeSkillMeta,
  getAllTags,
  renameTagEverywhere,
  deleteTagEverywhere,
  getSyncMode,
  setSyncMode,
  getPresetRowsWithCounts,
  createPreset,
  updatePresetRow,
  deletePresetRow,
  addSkillToPreset,
  removeSkillFromPreset,
  setActivePreset,
  applyPresetToDefault,
  applyPresetToCodingAgents,
  togglePresetSkillTool,
  syncSkillToTool,
  unsyncSkillFromTool,
  fetchLeaderboard,
  searchSkillssh,
  installFromSkillssh,
  cancelInstall,
  gitPreview,
  gitConfirm,
  gitCancelPreview,
  installLocal,
  batchImportFolder,
  checkSkillUpdate,
  checkAllSkillUpdates,
  updateSkill,
  scanDiscoveredSkills,
  importDiscoveredGroup,
  importAllDiscovered,
  scanProjectWorkspaces,
  addProject,
  removeProject,
  backupStatus,
  backupInit,
  setBackupRemote,
  backupCommit,
  backupPush,
  backupPull,
  setAutoBackup,
  listSnapshots,
  createSnapshot,
  restoreSnapshot,
  resolveConflict,
  sizeReport,
};
