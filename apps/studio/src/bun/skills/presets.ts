// 场景（预设）服务：应用预设 = 一次性把「预设技能 × 启用工具」部署/卸载到磁盘。
import { getCentralRepoDir, muteSelfWrites } from "./central-repo";
import {
  getActivePresetId,
  setActivePreset,
  listPresetSkillIds,
  getPresetSkillToggles,
  setPresetSkillToggle,
  listTargetRows,
  listPresetRows,
  resolveAdapters,
  getDisabledTools,
  adapterSkillsPath,
} from "./store";
import { syncSkillToTool, unsyncSkillFromTool } from "./sync-engine";
import { audit } from "./audit";

/**
 * 应用预设为默认状态：收集期望 targets（该预设所有技能 × 其启用工具）→
 * 卸载不再想要的部署 → 设置活动预设 → 部署期望。一次性动作，非持续同步。
 */
export function applyPresetToDefault(presetId: string): { ok: boolean; deployed: number; undeployed: number; errors: string[] } {
  const central = getCentralRepoDir();
  const disabled = getDisabledTools();
  const skillIds = listPresetSkillIds(presetId);

  // 期望集合：presetSkillTools 里 enabled 的（没记录的默认视为启用——成员即启用）。
  const desired = new Set<string>(); // `${skillId}::${tool}`
  for (const sid of skillIds) {
    const toggles = getPresetSkillToggles(presetId, sid);
    for (const a of resolveAdapters()) {
      if (disabled.has(a.key)) continue;
      if (adapterSkillsPath(a) === central) continue; // 同根工具无需部署
      if (toggles[a.key] === false) continue;
      desired.add(`${sid}::${a.key}`);
    }
  }

  // 卸载：skill_targets 里有、但不在期望集合（且技能仍是预设成员或已移除）。
  const errors: string[] = [];
  let deployed = 0;
  let undeployed = 0;
  muteSelfWrites(3000);
  const current = listTargetRows();
  const members = new Set(skillIds);
  for (const t of current) {
    const key = `${t.skillId}::${t.tool}`;
    if (desired.has(key)) continue;
    // 只动「属于该预设管理范围」的部署：技能在预设里但开关关了，或技能不在预设里。
    if (!members.has(t.skillId)) {
      // 技能不在预设内：它是用户手动部署的，保守保留。
      continue;
    }
    const r = unsyncSkillFromTool(t.skillId, t.tool);
    if (r.ok) undeployed++;
    else errors.push(`unsync ${t.skillId}/${t.tool}: ${r.error}`);
  }

  setActivePreset(presetId);

  for (const key of desired) {
    const [sid, tool] = key.split("::") as [string, string];
    const r = syncSkillToTool(sid, tool);
    if (r.ok) deployed++;
    else if (!r.needConfirm) errors.push(`sync ${sid}/${tool}: ${r.error}`);
  }
  audit("preset_apply", `${presetId} (+${deployed}/-${undeployed})`);
  return { ok: errors.length === 0, deployed, undeployed, errors };
}

/** 预设全技能 × 全部启用 coding agents 的批量加/卸。 */
export function applyPresetToCodingAgents(presetId: string, mode: "add" | "remove"): { ok: boolean; count: number; errors: string[] } {
  const central = getCentralRepoDir();
  const disabled = getDisabledTools();
  const skillIds = listPresetSkillIds(presetId);
  const tools = resolveAdapters().filter(
    (a) => a.category === "coding" && !disabled.has(a.key) && adapterSkillsPath(a) !== central,
  );
  const errors: string[] = [];
  let count = 0;
  muteSelfWrites(3000);
  for (const sid of skillIds) {
    for (const tool of tools) {
      if (mode === "add") {
        const r = syncSkillToTool(sid, tool.key);
        if (r.ok) count++;
        else if (!r.needConfirm) errors.push(`${sid}/${tool.key}: ${r.error}`);
      } else {
        const r = unsyncSkillFromTool(sid, tool.key);
        if (r.ok) count++;
        else errors.push(`${sid}/${tool.key}: ${r.error}`);
      }
    }
  }
  audit("preset_apply_agents", `${presetId} ${mode} ${count}`);
  return { ok: errors.length === 0, count, errors };
}

/** 预设内技能 × 工具开关：活动预设时立即落盘部署/卸载。 */
export function togglePresetSkillTool(presetId: string, skillId: string, tool: string, enabled: boolean): { ok: boolean; error?: string } {
  setPresetSkillToggle(presetId, skillId, tool, enabled);
  if (getActivePresetId() === presetId) {
    const central = getCentralRepoDir();
    if (adapterSkillsPath(resolveAdapters().find((a) => a.key === tool)!) === central) {
      return { ok: true }; // 同根工具无需落盘
    }
    if (enabled) {
      const r = syncSkillToTool(skillId, tool);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    }
    const r = unsyncSkillFromTool(skillId, tool);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }
  return { ok: true };
}

/** 预设成员的当前落盘状态（n/m 部分安装徽标用）。 */
export function presetDeployStats(presetId: string): { total: number; deployed: number } {
  const skillIds = listPresetSkillIds(presetId);
  const rows = listTargetRows();
  let deployed = 0;
  for (const sid of skillIds) {
    if (rows.some((t) => t.skillId === sid)) deployed++;
  }
  return { total: skillIds.length, deployed };
}

/** 确保至少有一个预设；返回活动预设。 */
export function ensurePresetReady(): string {
  const rows = listPresetRows();
  if (rows.length === 0) {
    // ensureDefaultPreset 在 store 里懒创建
    return getActivePresetId();
  }
  return getActivePresetId();
}
