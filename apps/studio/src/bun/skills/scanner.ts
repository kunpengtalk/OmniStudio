// 扫描：发现已启用工具目录里已有的技能（分组收编进中央库）+ 项目目录扫描。
import { join, basename } from "path";
import { existsSync, readdirSync, statSync, rmSync } from "fs";
import type { DiscoveredSkillGroup } from "../../shared/skills";
import { getCentralRepoDir } from "./central-repo";
import { adapterSkillsPath, resolveAdapters, getDisabledTools } from "./store";
import { isSkillDir, parseSkillMd, hashSkillDir } from "./metadata";
import { importSkillDir } from "./installer";
import { audit } from "./audit";

const IGNORED_DIRS = new Set(["node_modules", "target", "__pycache__", ".git", "dist", "build", ".venv"]);

/** 扫描已启用工具的全局 skills 目录：发现「本应用未管理」的技能，按内容哈希分组。 */
export function scanDiscoveredSkills(): DiscoveredSkillGroup[] {
  const central = getCentralRepoDir();
  const disabled = getDisabledTools();
  const adapters = resolveAdapters().filter((a) => !disabled.has(a.key));
  const groups = new Map<string, DiscoveredSkillGroup>();

  for (const adapter of adapters) {
    for (const dirRel of [adapter.skillsDir, ...(adapter.extraScanDirs ?? [])]) {
      const dir = adapterSkillsPath({ ...adapter, skillsDir: dirRel });
      if (!existsSync(dir)) continue;
      // 中央库本身跳过（那不是「外部」技能）。
      if (dir === central) continue;
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
        // symlink 指向中央库的（本应用部署）不算发现。
        try {
          if (statSync(full).isSymbolicLink()) continue;
        } catch {}
        const meta = parseSkillMd(full);
        const name = meta.name || e.name;
        const fingerprint = hashSkillDir(full);
        const key = `${name}::${fingerprint}`;
        const existing = groups.get(key);
        if (existing) {
          if (!existing.locations.some((l) => l.path === full)) {
            existing.locations.push({ tool: adapter.key, path: full });
          }
        } else {
          groups.set(key, { name, locations: [{ tool: adapter.key, path: full }], imported: false });
        }
      }
    }
  }

  const out = [...groups.values()];
  // 已收编标记：中央库里有同名技能且内容哈希一致。
  for (const g of out) {
    g.imported = isImported(g);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function isImported(group: DiscoveredSkillGroup): boolean {
  const central = getCentralRepoDir();
  try {
    const entries = readdirSync(central, { withFileTypes: true }).filter(
      (e) => e.isDirectory() && !e.name.startsWith("."),
    );
    const fp = hashSkillDir(group.locations[0]!.path);
    for (const e of entries) {
      const dir = join(central, e.name);
      if (!isSkillDir(dir)) continue;
      if (hashSkillDir(dir) === fp) return true;
    }
  } catch {}
  return false;
}

/** 收编单个发现组（复制进中央库 + 清理工具目录里的原目录）。 */
export function importDiscoveredGroup(name: string, paths: string[], removeOriginal: boolean): { ok: boolean; id?: string; error?: string } {
  const src = paths[0];
  if (!src || !existsSync(src)) return { ok: false, error: "source missing" };
  const result = importSkillDir(src, { sourceType: "scan" });
  if (!result.ok) return result;
  if (removeOriginal) {
    for (const p of paths) {
      try {
        if (statSync(p).isDirectory()) {
          rmSync(p, { recursive: true, force: true });
        }
      } catch {}
    }
  }
  audit("scan_import", `${name} -> ${result.id}`);
  return result;
}

/** 一键收编全部发现组。 */
export function importAllDiscovered(groups: DiscoveredSkillGroup[], removeOriginal: boolean): { installed: string[]; errors: string[] } {
  const installed: string[] = [];
  const errors: string[] = [];
  for (const g of groups) {
    if (g.imported) continue;
    const result = importDiscoveredGroup(g.name, g.locations.map((l) => l.path), removeOriginal);
    if (result.ok) installed.push(result.id!);
    else errors.push(`${g.name}: ${result.error}`);
  }
  return { installed, errors };
}

// ---------------------------------------------------------------------------
// 项目扫描：找一个目录（及有限子目录）里的「项目工作区」
// （内部存在任一 agent 的项目 skills 目录）。
// ---------------------------------------------------------------------------

export interface DiscoveredProject {
  path: string;
  /** 命中的项目 skills 相对目录（去重）。 */
  agentDirs: string[];
}

export function isProjectWorkspace(dir: string): boolean {
  return discoverProjectAgentDirs(dir).length > 0;
}

/** 项目内命中的 agent skills 相对目录（共享目录去重合并显示）。 */
export function discoverProjectAgentDirs(projectRoot: string): string[] {
  const adapters = resolveAdapters();
  const found = new Set<string>();
  for (const a of adapters) {
    const rel = a.projectSkillsDir ?? a.skillsDir;
    if (existsSync(join(projectRoot, rel))) found.add(rel);
  }
  return [...found];
}

/** 扫描父目录下的候选项目（深度 2，忽略常见构建目录）。 */
export function scanProjectWorkspaces(root: string): DiscoveredProject[] {
  const out: DiscoveredProject[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 2) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || IGNORED_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      const agentDirs = discoverProjectAgentDirs(full);
      if (agentDirs.length > 0) {
        out.push({ path: full, agentDirs });
      } else {
        walk(full, depth + 1);
      }
    }
  };
  // 根目录本身也可以是项目。
  if (isProjectWorkspace(root)) out.push({ path: root, agentDirs: discoverProjectAgentDirs(root) });
  walk(root, 0);
  return out;
}

export function projectNameOf(path: string): string {
  return basename(path) || path;
}
