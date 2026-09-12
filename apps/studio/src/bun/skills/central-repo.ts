// 中央技能库：路径解析（默认 ~/.agents/skills）、目录结构、索引重建、变更监听。
import { homedir } from "os";
import { join, resolve } from "path";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  watch,
  type FSWatcher,
} from "fs";
import { getSetting, updateSettings } from "../db/settings";
import { db } from "../db";
import { skills as skillsTable } from "../db/schema";
import { eq } from "drizzle-orm";
import {
  DEFAULT_CENTRAL_SKILLS_DIR,
  SKILLS_META_DIR,
} from "../../shared/skills";
import { isSkillDir, parseSkillMd } from "./metadata";

/** 中央库根目录（git 备份仓库根）。 */
export function getCentralRepoDir(): string {
  const override = getSetting("SKILLS_CENTRAL_PATH").trim();
  if (override) return resolve(expandHome(override));
  return join(homedir(), DEFAULT_CENTRAL_SKILLS_DIR);
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** 中央库存放技能的目录。 */
export function getSkillsDir(): string {
  return getCentralRepoDir();
}

/** 跨设备元数据目录（随 git 提交）。 */
export function getMetaDir(): string {
  return join(getCentralRepoDir(), SKILLS_META_DIR);
}

/** 项目覆盖前自动备份目录。 */
export function getProjectBackupDir(): string {
  return join(getMetaDir(), "project-backups");
}

/** 克隆/导入临时目录（启动时清理孤儿，中断恢复）。 */
export function getTmpDir(): string {
  return join(getCentralRepoDir(), SKILLS_META_DIR, "tmp");
}

export function setCentralRepoPath(p: string) {
  updateSettings({ SKILLS_CENTRAL_PATH: p.trim() });
}

/** 确保中央库结构存在；返回创建信息。 */
export function ensureCentralRepo(): { ok: boolean; dir: string; created: boolean } {
  const dir = getCentralRepoDir();
  const existed = existsSync(dir);
  try {
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, SKILLS_META_DIR, "skills"), { recursive: true });
    mkdirSync(join(dir, SKILLS_META_DIR, "tmp"), { recursive: true });
    return { ok: true, dir, created: !existed };
  } catch {
    return { ok: false, dir, created: false };
  }
}

export interface CentralInfo {
  dir: string;
  /** 是否使用默认路径（~/.agents/skills）。 */
  isDefault: boolean;
  skillCount: number;
  sizeBytes: number;
  dbCount: number;
  warnings: string[];
}

export function getCentralInfo(sizeBytes: number, dbCount: number): CentralInfo {
  const dir = getCentralRepoDir();
  const defaultDir = join(homedir(), DEFAULT_CENTRAL_SKILLS_DIR);
  const warnings: string[] = [];
  if (!existsSync(dir)) warnings.push("repo_path_invalid");
  let skillCount = 0;
  if (existsSync(dir)) {
    try {
      skillCount = readdirSync(dir, { withFileTypes: true }).filter(
        (e) => e.isDirectory() && !e.name.startsWith(".") && isSkillDir(join(dir, e.name)),
      ).length;
    } catch {}
  }
  return {
    dir,
    isDefault: dir === resolve(defaultDir),
    skillCount,
    sizeBytes,
    dbCount,
    warnings,
  };
}

/**
 * 重建索引：扫描中央库目录，把磁盘上有 SKILL.md 但 DB 没有的技能收编进 DB；
 * DB 里有但磁盘没有的技能删除（目录被外部删除后的自愈）。
 * 用于首次启动、git 备份 pull 之后、以及手动触发。
 */
export function reindexCentralRepo(): { added: string[]; removed: string[] } {
  ensureCentralRepo();
  const dir = getCentralRepoDir();
  const added: string[] = [];
  const removed: string[] = [];

  const diskIds = new Set<string>();
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (!isSkillDir(full)) continue;
      diskIds.add(e.name);
      const existing = db.select().from(skillsTable).where(eq(skillsTable.id, e.name)).get();
      if (existing) {
        // 元数据仍以 DB 为准，但名称/描述跟随磁盘刷新。
        const meta = parseSkillMd(full);
        if (meta.name && meta.name !== existing.name) {
          db.update(skillsTable).set({ name: meta.name }).where(eq(skillsTable.id, e.name)).run();
        }
      } else {
        const meta = parseSkillMd(full);
        db.insert(skillsTable)
          .values({
            id: e.name,
            name: meta.name || e.name,
            description: meta.description,
            sourceType: "scan",
          })
          .onConflictDoNothing()
          .run();
        added.push(e.name);
      }
    }
  } catch {}

  for (const row of db.select().from(skillsTable).all()) {
    if (!diskIds.has(row.id)) {
      db.delete(skillsTable).where(eq(skillsTable.id, row.id)).run();
      removed.push(row.id);
    }
  }
  return { added, removed };
}

/** 启动清理：临时目录里的克隆残留（安装中断恢复）。 */
export function cleanupTmp() {
  const tmp = getTmpDir();
  if (!existsSync(tmp)) return;
  try {
    for (const e of readdirSync(tmp, { withFileTypes: true })) {
      try {
        rmSync(join(tmp, e.name), { recursive: true, force: true });
      } catch {}
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// 中央库文件监听：外部编辑（或 git pull）后通知前端刷新。
// ---------------------------------------------------------------------------

type ChangedListener = () => void;
const changedListeners = new Set<ChangedListener>();

export function onCentralChanged(fn: ChangedListener) {
  changedListeners.add(fn);
  return () => changedListeners.delete(fn);
}

let watcher: FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
/** 自身写入的静默窗口（避免安装/同步自身触发刷新风暴）。 */
let muteUntil = 0;

export function muteSelfWrites(ms = 1500) {
  muteUntil = Date.now() + ms;
}

/** 监听中央库目录（递归）。重复调用先关闭旧 watcher。 */
export function startCentralWatch() {
  stopCentralWatch();
  ensureCentralRepo();
  try {
    watcher = watch(getCentralRepoDir(), { recursive: true }, () => {
      if (Date.now() < muteUntil) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        for (const fn of changedListeners) {
          try {
            fn();
          } catch {}
        }
      }, 1000);
    });
  } catch {
    watcher = null;
  }
}

export function stopCentralWatch() {
  try {
    watcher?.close();
  } catch {}
  watcher = null;
}
