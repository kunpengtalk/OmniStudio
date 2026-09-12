// 同步引擎：中央库技能 → 各工具 skills 目录的部署（symlink / copy）、
// 实时状态检测与安全卸载。参照 skills-manager 的 sync_engine 移植。
import { join, resolve, dirname } from "path";
import {
  existsSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
  mkdirSync,
  rmSync,
  readdirSync,
  copyFileSync,
} from "fs";
import type { SyncMode, SkillTargetView } from "../../shared/skills";
import { getCentralRepoDir, muteSelfWrites } from "./central-repo";
import {
  adapterSkillsPath,
  getAdapter,
  getSyncMode,
  listTargetRows,
  upsertTarget,
  deleteTarget,
  listToolInfos,
  getDisabledTools,
  resolveAdapters,
  toSyncStatus,
} from "./store";
import { hashSkillDir } from "./metadata";
import { audit } from "./audit";

const isWindows = process.platform === "win32";

/** 目标路径的磁盘实时分类。 */
export type LiveState =
  | "absent"
  | "link-to-source"
  | "foreign-link"
  | "real-dir"
  | "real-file"
  | "central-root";

export function classifyTarget(targetDir: string, sourceDir: string): LiveState {
  if (resolve(targetDir) === resolve(getCentralRepoDir())) return "central-root";
  let st;
  try {
    st = lstatSync(targetDir);
  } catch {
    return "absent";
  }
  if (st.isSymbolicLink()) {
    let link: string;
    try {
      link = readlinkSync(targetDir);
    } catch {
      return "foreign-link";
    }
    const resolved = link.startsWith("/") ? link : resolve(dirname(targetDir), link);
    return resolved === resolve(sourceDir) ? "link-to-source" : "foreign-link";
  }
  if (st.isDirectory()) return "real-dir";
  return "real-file";
}

/** 递归复制目录（跳过 .git / .DS_Store）。 */
export function copyDirRecursive(src: string, dest: string) {
  mkdirSync(dest, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === ".DS_Store") continue;
    const s = join(src, e.name);
    const d = join(dest, e.name);
    if (e.isDirectory()) copyDirRecursive(s, d);
    else if (e.isFile()) copyFileSync(s, d);
  }
}

/**
 * 部署一个技能目录到目标：
 * - symlink 模式：Unix 直接符号链接；Windows 依次尝试 symlink → junction → 降级 copy（如实返回实际模式）。
 * - copy 模式：递归复制。
 * 目标已被真实目录/文件占用时返回 needConfirm（由 UI 确认后带 overwrite 再来）。
 */
export function deploySkillDir(
  sourceDir: string,
  targetDir: string,
  mode: SyncMode,
  overwrite: boolean,
): { ok: boolean; mode?: SyncMode; needConfirm?: boolean; error?: string } {
  const live = classifyTarget(targetDir, sourceDir);
  if (live === "central-root") return { ok: false, error: "target is central repo" };
  if (live === "real-dir" || live === "real-file" || live === "foreign-link") {
    if (!overwrite) return { ok: false, needConfirm: true };
    try {
      rmSync(targetDir, { recursive: true, force: true });
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
  try {
    mkdirSync(dirname(targetDir), { recursive: true });
    if (mode === "symlink") {
      // 绝对链接，跨工具读取最稳。
      try {
        symlinkSync(resolve(sourceDir), targetDir, isWindows ? "junction" : "dir");
        return { ok: true, mode: "symlink" };
      } catch {
        if (isWindows) {
          // Windows 无特权时 junction 已在上面尝试；最终降级为复制。
          copyDirRecursive(sourceDir, targetDir);
          return { ok: true, mode: "copy" };
        }
        return { ok: false, error: "symlink failed" };
      }
    }
    copyDirRecursive(sourceDir, targetDir);
    return { ok: true, mode: "copy" };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * 卸载：只有磁盘状态与记录的模式吻合才删（防止误删用户自建目录）。
 * 共享目录（如 ~/.config/agents/skills 被 amp/replit 共享）在还有其他
 * target 引用时不删除父目录，只删技能子目录。
 */
export function removeRecordedTarget(skillId: string, sourceDir: string, toolKey: string): { ok: boolean; error?: string } {
  const targetDir = join(adapterSkillsPath(getAdapter(toolKey)!), skillId);
  const targetParent = dirname(targetDir);
  const central = resolve(getCentralRepoDir());
  if (resolve(targetParent) === central) return { ok: false, error: "central repo" };

  // 幸存者检查：还有别的 target 的 skills 目录与这里相同吗？
  const all = listTargetRows();
  const adapters = new Map(resolveAdapters().map((a) => [a.key, a] as const));
  const pathOwners = new Set<string>();
  for (const t of all) {
    if (t.skillId === skillId && t.tool === toolKey) continue;
    const a = adapters.get(t.tool);
    if (a) pathOwners.add(resolve(adapterSkillsPath(a)));
  }
  const live = classifyTarget(targetDir, sourceDir);
  if (live === "absent") {
    deleteTarget(skillId, toolKey);
    return { ok: true };
  }
  if (live === "link-to-source") {
    try {
      rmSync(targetDir, { recursive: true, force: true });
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  } else if (live === "real-dir") {
    // 记录是 copy 模式才允许删真实目录。
    const row = all.find((t) => t.skillId === skillId && t.tool === toolKey);
    if (!row || row.mode !== "copy") return { ok: false, error: "disk state mismatch" };
    try {
      rmSync(targetDir, { recursive: true, force: true });
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  } else {
    return { ok: false, error: "disk state mismatch" };
  }

  // 父目录若没有其他引用则清掉（共享目录保留）。
  if (!pathOwners.has(resolve(targetParent))) {
    try {
      const remaining = readdirSync(targetParent).filter((x) => !x.startsWith("."));
      if (remaining.length === 0) rmSync(targetParent, { recursive: true, force: true });
    } catch {}
  }
  deleteTarget(skillId, toolKey);
  return { ok: true };
}

/** 同步技能到工具（写 skill_targets 记录）。 */
export function syncSkillToTool(skillId: string, toolKey: string, opts?: { overwrite?: boolean }): { ok: boolean; error?: string; needConfirm?: boolean } {
  const adapter = getAdapter(toolKey);
  if (!adapter) return { ok: false, error: "unknown tool" };
  if (listToolInfos().find((t) => t.key === toolKey)?.isCentral) {
    return { ok: false, error: "central-root tool needs no sync" };
  }
  const sourceDir = join(getCentralRepoDir(), skillId);
  if (!existsSync(sourceDir)) return { ok: false, error: "skill dir missing" };
  const targetDir = join(adapterSkillsPath(adapter), skillId);
  muteSelfWrites();
  const result = deploySkillDir(sourceDir, targetDir, getSyncMode(), opts?.overwrite ?? false);
  if (!result.ok) return result;
  upsertTarget(skillId, toolKey, result.mode ?? getSyncMode(), hashSkillDir(sourceDir));
  audit("sync", `${skillId} -> ${toolKey} (${result.mode})`);
  return { ok: true };
}

/** 卸载技能的某个工具部署。 */
export function unsyncSkillFromTool(skillId: string, toolKey: string): { ok: boolean; error?: string } {
  const sourceDir = join(getCentralRepoDir(), skillId);
  muteSelfWrites();
  const result = removeRecordedTarget(skillId, sourceDir, toolKey);
  if (result.ok) audit("unsync", `${skillId} <- ${toolKey}`);
  return result;
}

/** copy 模式目标重推（源更新后）。 */
export function resyncCopyTargets(skillId: string) {
  const sourceDir = join(getCentralRepoDir(), skillId);
  if (!existsSync(sourceDir)) return;
  const hash = hashSkillDir(sourceDir);
  muteSelfWrites();
  for (const row of listTargetRows().filter((t) => t.skillId === skillId)) {
    if (row.mode !== "copy") continue;
    const adapter = getAdapter(row.tool);
    if (!adapter) continue;
    const targetDir = join(adapterSkillsPath(adapter), skillId);
    deploySkillDir(sourceDir, targetDir, "copy", true);
    upsertTarget(skillId, row.tool, "copy", hash);
  }
}

/**
 * 组装已部署技能的 target 视图（DB 记录 + 实时状态 + copy 过期判断）。
 * 与中央库同根的工具（cline/warp 等）由 centralToolViews 单独合成。
 */
export function assembleTargetViews(): Map<string, SkillTargetView[]> {
  const rows = listTargetRows();
  const adapters = resolveAdapters();
  const central = resolve(getCentralRepoDir());
  const bySkill = new Map<string, SkillTargetView[]>();
  for (const row of rows) {
    const adapter = adapters.find((a) => a.key === row.tool);
    if (!adapter) continue;
    const sourceDir = join(central, row.skillId);
    const targetDir = join(adapterSkillsPath(adapter), row.skillId);
    const live = classifyTarget(targetDir, sourceDir);
    let status = toSyncStatus(row.mode, live);
    if (status === "copied" && row.sourceHash && existsSync(sourceDir)) {
      if (row.sourceHash !== hashSkillDir(sourceDir)) status = "outdated";
    }
    if (status) {
      const list = bySkill.get(row.skillId) ?? [];
      list.push({ tool: row.tool, mode: row.mode, status });
      bySkill.set(row.skillId, list);
    }
  }
  return bySkill;
}

/** 中央库同根工具的状态视图（每个技能都直接可用）。 */
export function centralToolViews(_skillId: string): SkillTargetView[] {
  const disabled = getDisabledTools();
  return resolveAdapters()
    .filter((a) => resolve(adapterSkillsPath(a)) === centralRoot() && !disabled.has(a.key))
    .map((a) => ({ tool: a.key, mode: "symlink" as SyncMode, status: "central" as const }));
}

function centralRoot(): string {
  return resolve(getCentralRepoDir());
}

/** 目标目录存在且非本应用部署（外部真实目录），供 UI 冲突提示。 */
export function targetConflicts(skillId: string, toolKey: string): boolean {
  const adapter = getAdapter(toolKey);
  if (!adapter) return false;
  const sourceDir = join(getCentralRepoDir(), skillId);
  const targetDir = join(adapterSkillsPath(adapter), skillId);
  const live = classifyTarget(targetDir, sourceDir);
  return live === "real-dir" || live === "real-file" || live === "foreign-link";
}
