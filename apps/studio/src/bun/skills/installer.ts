// 安装器：skills.sh 市场安装 / Git URL 导入（预览+确认） / 本地导入（目录/zip/.skill）
// / 批量导入 / 更新检查与更新 / 取消。进度经 listener 推送。
import { join, basename, resolve, dirname } from "path";
import {
  existsSync,
  mkdirSync,
  rmSync,
  readdirSync,
  renameSync,
  copyFileSync,
  statSync,
} from "fs";
import { randomUUID } from "crypto";
import type { SkillSource, SkillsInstallProgress } from "../../shared/skills";
import { getCentralRepoDir, getTmpDir, ensureCentralRepo, muteSelfWrites } from "./central-repo";
import { isInsideDir, safeJoin, safeName } from "../path-safety";
import {
  upsertSkill,
  getSkillRow,
  listSkillRows,
  parseTags,
} from "./store";
import { parseSkillMd, sanitizeSkillName, isSkillDir, hashSkillDir } from "./metadata";
import { resyncCopyTargets } from "./sync-engine";
import { audit } from "./audit";
import { writeSkillMeta } from "./meta-sync";

// ---------------------------------------------------------------------------
// 进度推送
// ---------------------------------------------------------------------------

type ProgressListener = (p: SkillsInstallProgress) => void;
const progressListeners = new Set<ProgressListener>();

export function onInstallProgress(fn: ProgressListener) {
  progressListeners.add(fn);
  return () => progressListeners.delete(fn);
}

function emitProgress(p: SkillsInstallProgress) {
  for (const fn of progressListeners) {
    try {
      fn(p);
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// git 封装（系统 git，照搬 tts-models.ts 的模式）
// ---------------------------------------------------------------------------

const activeInstalls = new Map<string, () => void>();

/** 是否有安装任务在进行。 */
export function installActive(ref: string): boolean {
  return activeInstalls.has(ref);
}

export function cancelInstall(ref: string): boolean {
  const kill = activeInstalls.get(ref);
  if (!kill) return false;
  kill();
  return true;
}

async function git(
  args: string[],
  opts?: { cwd?: string; onSpawn?: (kill: () => void) => void },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: opts?.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  opts?.onSpawn?.(() => {
    try {
      proc.kill();
    } catch {}
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** 校验 git URL：允许 https/http/ssh/git@ 与 "owner/repo" 简写；拒绝 file:// 与本地路径。 */
export function normalizeGitUrl(raw: string): { ok: boolean; url?: string; subpath?: string; error?: string } {
  let url = raw.trim();
  if (!url) return { ok: false, error: "empty url" };
  if (/^[\w.-]+\/[\w.-]+$/.test(url) && !url.includes("://") && !url.includes("@")) {
    url = `https://github.com/${url}.git`;
  }
  if (url.startsWith("file://") || url.includes("::") || url.startsWith("/")) {
    return { ok: false, error: "local path not allowed" };
  }
  if (!/^https?:\/\/|^git@|^ssh:\/\//.test(url)) return { ok: false, error: "invalid url" };
  // GitHub /tree/branch/subpath 拆解
  let subpath: string | undefined;
  const treeMatch = url.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/tree\/([^/]+)\/(.+)$/);
  if (treeMatch) {
    url = `${treeMatch[1]}.git`;
    subpath = (treeMatch[3] ?? "").replace(/\/$/, "");
  }
  return { ok: true, url, subpath };
}

// ---------------------------------------------------------------------------
// skill 目录解析（克隆后）
// ---------------------------------------------------------------------------

/** 在克隆目录中解析 skill 目录：优先已知路径约定，再深度受限 walk。 */
export function resolveSkillDir(repoDir: string, skillId: string | null): string | null {
  const candidates: string[] = [];
  if (skillId) {
    candidates.push(
      join(repoDir, skillId),
      join(repoDir, "skills", skillId),
      join(repoDir, ".agents", "skills", skillId),
      join(repoDir, ".claude", "skills", skillId),
    );
  }
  for (const c of candidates) {
    if (existsSync(c) && isSkillDir(c)) return c;
  }
  // walk：按目录名或 SKILL.md frontmatter name 匹配。
  let found: string | null = null;
  const walk = (cur: string, depth: number) => {
    if (found || depth > 6) return;
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found) return;
      if (e.name === ".git" || e.name.startsWith(".")) continue;
      if (!e.isDirectory()) continue;
      const full = join(cur, e.name);
      if (isSkillDir(full)) {
        if (!skillId || e.name === skillId || parseSkillMd(full).name === skillId) {
          found = full;
          return;
        }
      }
      walk(full, depth + 1);
    }
  };
  walk(repoDir, 0);
  return found;
}

/** 收集仓库内全部 skill 目录（Git 导入预览用）。 */
export function collectGitSkillDirs(repoDir: string): { relPath: string; name: string; description: string | null }[] {
  const out: { relPath: string; name: string; description: string | null }[] = [];
  const walk = (cur: string, rel: string, depth: number) => {
    if (depth > 6 || out.length > 200) return;
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".git" || e.name === "node_modules" || e.name.startsWith(".DS")) continue;
      if (!e.isDirectory()) continue;
      const full = join(cur, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (isSkillDir(full)) {
        const meta = parseSkillMd(full);
        out.push({ relPath: childRel, name: meta.name || e.name, description: meta.description });
      } else {
        walk(full, childRel, depth + 1);
      }
    }
  };
  walk(repoDir, "", 0);
  return out;
}

// ---------------------------------------------------------------------------
// 中央库写入
// ---------------------------------------------------------------------------

/** 目标目录名：内容哈希与既有技能相同则复用，否则 -2/-3 去重。 */
function uniqueDest(base: string, sourceDir: string): string {
  const central = getCentralRepoDir();
  const sourceHash = hashSkillDir(sourceDir);
  const direct = join(central, base);
  if (!existsSync(direct)) return direct;
  // 同名但内容相同：直接复用（更新走 updateSkill）。
  if (isSkillDir(direct) && hashSkillDir(direct) === sourceHash) return direct;
  for (let i = 2; i < 50; i++) {
    const candidate = join(central, `${base}-${i}`);
    if (!existsSync(candidate)) return candidate;
    if (isSkillDir(candidate) && hashSkillDir(candidate) === sourceHash) return candidate;
  }
  return join(central, `${base}-${Date.now().toString(36)}`);
}

/** 把一个 skill 目录复制进中央库并入库。返回技能 id。 */
export function importSkillDir(
  sourceDir: string,
  opts: {
    name?: string;
    sourceType: SkillSource;
    sourceRef?: string | null;
    sourceSubpath?: string | null;
    sourceRevision?: string | null;
  },
): { ok: boolean; id?: string; reused?: boolean; error?: string } {
  ensureCentralRepo();
  const meta = parseSkillMd(sourceDir);
  const rawName = opts.name || meta.name || basename(sourceDir);
  const base = sanitizeSkillName(rawName);
  const dest = uniqueDest(base, sourceDir);
  const reused = hashSkillDir(dest) === hashSkillDir(sourceDir) && isSkillDir(dest);
  if (!reused) {
    muteSelfWrites();
    try {
      // 临时复制再原子 rename，中断不留半成品。
      const staging = join(getTmpDir(), `stage-${randomUUID().slice(0, 8)}`);
      copyDirSkipVcs(sourceDir, staging);
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(staging, dest);
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
  upsertSkill({
    id: basename(dest),
    name: rawName,
    description: meta.description,
    sourceType: opts.sourceType,
    sourceRef: opts.sourceRef ?? null,
    sourceSubpath: opts.sourceSubpath ?? null,
    sourceRevision: opts.sourceRevision ?? null,
  });
  writeSkillMeta(basename(dest));
  audit("install", `${basename(dest)} (${opts.sourceType}${opts.sourceRef ? ` ${opts.sourceRef}` : ""})`);
  return { ok: true, id: basename(dest), reused };
}

/** 递归复制（跳过 .git / .DS_Store）。 */
export function copyDirSkipVcs(src: string, dest: string) {
  mkdirSync(dest, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === ".DS_Store" || e.name === "Thumbs.db") continue;
    const s = join(src, e.name);
    const d = join(dest, e.name);
    if (e.isDirectory()) copyDirSkipVcs(s, d);
    else if (e.isFile()) copyFileSync(s, d);
  }
}

// ---------------------------------------------------------------------------
// skills.sh 市场安装
// ---------------------------------------------------------------------------

export async function installFromSkillssh(
  source: string,
  skillId: string,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const ref = `${source}/${skillId}`;
  if (activeInstalls.has(ref)) return { ok: false, error: "install in progress" };
  const repoUrl = `https://github.com/${source}.git`;
  const tmp = join(getTmpDir(), `clone-${randomUUID().slice(0, 8)}`);
  let killed = false;
  activeInstalls.set(ref, () => {
    killed = true;
  });
  emitProgress({ ref, phase: "cloning" });
  try {
    ensureCentralRepo();
    const clone = await git(["clone", "--depth", "1", repoUrl, tmp], {
      onSpawn: (kill) => activeInstalls.set(ref, kill),
    });
    if (killed) {
      emitProgress({ ref, phase: "canceled" });
      return { ok: false, error: "canceled" };
    }
    if (clone.code !== 0) {
      emitProgress({ ref, phase: "error", message: clone.stderr.slice(0, 300) });
      return { ok: false, error: `git clone failed: ${clone.stderr.slice(0, 200)}` };
    }
    emitProgress({ ref, phase: "installing" });
    const skillDir = resolveSkillDir(tmp, skillId);
    if (!skillDir) {
      emitProgress({ ref, phase: "error", message: "skill dir not found" });
      return { ok: false, error: `skill "${skillId}" not found in ${source}` };
    }
    const rev = await git(["-C", tmp, "rev-parse", "HEAD"]);
    const subpath = skillDir === tmp ? null : skillDir.slice(tmp.length + 1);
    const result = importSkillDir(skillDir, {
      sourceType: "skillssh",
      sourceRef: ref,
      sourceSubpath: subpath,
      sourceRevision: rev.code === 0 ? rev.stdout.trim() : null,
    });
    if (result.ok) emitProgress({ ref, phase: "done", message: result.id });
    else emitProgress({ ref, phase: "error", message: result.error });
    return result;
  } finally {
    activeInstalls.delete(ref);
    try {
      if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Git URL 导入（预览 → 勾选 → 确认）
// ---------------------------------------------------------------------------

export async function gitPreview(
  rawUrl: string,
): Promise<{ ok: boolean; tempDir?: string; skills?: { relPath: string; name: string; description: string | null }[]; error?: string }> {
  const norm = normalizeGitUrl(rawUrl);
  if (!norm.ok) return { ok: false, error: norm.error };
  const tmp = join(getTmpDir(), `preview-${randomUUID().slice(0, 8)}`);
  const ref = `preview:${tmp}`;
  emitProgress({ ref, phase: "cloning" });
  const args = norm.subpath
    ? ["clone", "--depth", "1", "--filter", "blob:none", "--no-checkout", norm.url!, tmp]
    : ["clone", "--depth", "1", norm.url!, tmp];
  const clone = await git(args);
  if (clone.code !== 0) {
    try {
      if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    } catch {}
    return { ok: false, error: `git clone failed: ${clone.stderr.slice(0, 200)}` };
  }
  if (norm.subpath) {
    await git(["-C", tmp, "sparse-checkout", "set", "--cone", norm.subpath]);
    await git(["-C", tmp, "checkout"]);
  }
  const skills = collectGitSkillDirs(norm.subpath ? join(tmp, norm.subpath) : tmp);
  if (skills.length === 0) {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
    return { ok: false, error: "no skills found in repository" };
  }
  return { ok: true, tempDir: tmp, skills };
}

export function gitConfirm(
  rawUrl: string,
  tempDir: string,
  items: { relPath: string; name: string }[],
): { ok: boolean; installed: string[]; errors: string[] } {
  const norm = normalizeGitUrl(rawUrl);
  const installed: string[] = [];
  const errors: string[] = [];
  // tempDir 会走到函数结尾的递归删除，必须限定为我们自己的预览临时目录；
  // 否则 skillsGitConfirm({tempDir:"/Users/x/Pictures", items:[]}) 会删掉任意目录。
  if (!isInsideDir(getTmpDir(), tempDir)) {
    return { ok: false, installed, errors: ["非法的临时目录：必须来自技能仓库预览"] };
  }
  for (const item of items) {
    const dir = safeJoin(tempDir, item.relPath);
    if (!dir || !existsSync(dir) || !isSkillDir(dir)) {
      errors.push(item.relPath);
      continue;
    }
    const revSync = Bun.spawnSync(["git", "-C", tempDir, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
    const revision = revSync.exitCode === 0 ? new TextDecoder().decode(revSync.stdout).trim() : null;
    const result = importSkillDir(dir, {
      name: item.name,
      sourceType: "git",
      sourceRef: norm.url ?? rawUrl,
      sourceSubpath: item.relPath,
      sourceRevision: revision,
    });
    if (result.ok) installed.push(result.id!);
    else errors.push(`${item.relPath}: ${result.error}`);
  }
  try {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  } catch {}
  return { ok: errors.length === 0, installed, errors };
}

export function gitCancelPreview(tempDir: string) {
  try {
    // 与 gitConfirm 同样的约束：只清理自己的预览目录。
    if (existsSync(tempDir) && isInsideDir(getTmpDir(), tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// 本地导入（目录 / .zip / .skill）
// ---------------------------------------------------------------------------

export function installLocal(
  path: string,
  name?: string,
): { ok: boolean; id?: string; error?: string } {
  const abs = resolve(path);
  if (!existsSync(abs)) return { ok: false, error: "path not found" };
  const st = statSync(abs);
  if (st.isDirectory()) {
    if (!isSkillDir(abs)) {
      // 目录本身不是 skill：如果只包含一个 skill 目录则收编它。
      const subs = readdirSync(abs, { withFileTypes: true }).filter(
        (e) => e.isDirectory() && isSkillDir(join(abs, e.name)),
      );
      if (subs.length === 1) return importSkillDir(join(abs, subs[0]!.name), { name, sourceType: "local" });
      return { ok: false, error: "no SKILL.md found" };
    }
    return importSkillDir(abs, { name, sourceType: "local" });
  }
  if (/\.(zip|skill)$/i.test(abs)) {
    // zip / .skill（zip 变体）：系统 unzip 解包（防 Zip-Slip：解到临时目录后再校验路径）。
    const tmp = join(getTmpDir(), `zip-${randomUUID().slice(0, 8)}`);
    mkdirSync(tmp, { recursive: true });
    const unzip = Bun.spawnSync(["unzip", "-q", "-o", abs, "-d", tmp], { stdout: "pipe", stderr: "pipe" });
    if (unzip.exitCode !== 0) {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {}
      return { ok: false, error: `unzip failed: ${new TextDecoder().decode(unzip.stderr).slice(0, 200)}` };
    }
    // 找 SKILL.md（最多 4 层）。
    const found = findSkillRoot(tmp, 0);
    if (!found) {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {}
      return { ok: false, error: "no SKILL.md in archive" };
    }
    const result = importSkillDir(found, { name, sourceType: "local" });
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
    return result;
  }
  return { ok: false, error: "unsupported file type" };
}

function findSkillRoot(dir: string, depth: number): string | null {
  if (depth > 4) return null;
  if (isSkillDir(dir)) return dir;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const found = findSkillRoot(join(dir, e.name), depth + 1);
      if (found) return found;
    }
  } catch {}
  return null;
}

/** 批量导入文件夹：每个子目录（含 SKILL.md）都收编。 */
export function batchImportFolder(
  path: string,
): { installed: string[]; errors: string[] } {
  const abs = resolve(path);
  const installed: string[] = [];
  const errors: string[] = [];
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    return { installed, errors: ["folder not found"] };
  }
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const full = join(abs, e.name);
    if (!isSkillDir(full)) continue;
    const result = importSkillDir(full, { sourceType: "local" });
    if (result.ok) installed.push(result.id!);
    else errors.push(`${e.name}: ${result.error}`);
  }
  return { installed, errors };
}

// ---------------------------------------------------------------------------
// 更新检查与更新
// ---------------------------------------------------------------------------

export interface SkillUpdateStatus {
  id: string;
  status: "up_to_date" | "update_available" | "unknown";
  remoteRevision: string | null;
}

/** git 类来源（git/skillssh）：ls-remote 解析远端 revision 与本地比较。 */
export async function checkSkillUpdate(skillId: string): Promise<SkillUpdateStatus> {
  const row = getSkillRow(skillId);
  if (!row || !row.sourceRef) return { id: skillId, status: "unknown", remoteRevision: null };
  const url = row.sourceType === "skillssh" ? `https://github.com/${row.sourceRef.split("/").slice(0, 2).join("/")}.git` : row.sourceRef;
  const norm = normalizeGitUrl(url);
  if (!norm.ok) return { id: skillId, status: "unknown", remoteRevision: null };
  const remote = await git(["ls-remote", norm.url!]);
  if (remote.code !== 0) return { id: skillId, status: "unknown", remoteRevision: null };
  const lines = remote.stdout.split("\n").filter(Boolean);
  if (lines.length === 0) return { id: skillId, status: "unknown", remoteRevision: null };
  // refs/heads 优先，其次 peeled tag、tag、HEAD。
  const pick =
    lines.find((l) => l.includes("refs/heads/")) ??
    lines.find((l) => l.includes("^{}")) ??
    lines.find((l) => l.includes("refs/tags/")) ??
    lines.find((l) => l.includes("HEAD"));
  const remoteRevision = pick?.split("\t")[0] ?? null;
  if (!remoteRevision) return { id: skillId, status: "unknown", remoteRevision: null };
  return {
    id: skillId,
    status: row.sourceRevision && row.sourceRevision !== remoteRevision ? "update_available" : "up_to_date",
    remoteRevision,
  };
}

export async function checkAllSkillUpdates(): Promise<SkillUpdateStatus[]> {
  const rows = listSkillRows().filter((r) => r.sourceRef);
  const out: SkillUpdateStatus[] = [];
  // 逐个 ls-remote，限并发 4。
  const queue = [...rows];
  const worker = async () => {
    while (queue.length > 0) {
      const row = queue.shift()!;
      out.push(await checkSkillUpdate(row.id));
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out;
}

/** 更新：浅克隆到 staged → 目录哈希比较 → 原子换目录 → copy 目标重推。 */
export async function updateSkill(skillId: string): Promise<{ ok: boolean; error?: string; unchanged?: boolean }> {
  const row = getSkillRow(skillId);
  if (!row || !row.sourceRef) return { ok: false, error: "no source" };
  const url = row.sourceType === "skillssh" ? `https://github.com/${row.sourceRef.split("/").slice(0, 2).join("/")}.git` : row.sourceRef;
  const norm = normalizeGitUrl(url);
  if (!norm.ok) return { ok: false, error: norm.error };
  const ref = `update:${skillId}`;
  emitProgress({ ref, phase: "cloning" });
  const tmp = join(getTmpDir(), `update-${randomUUID().slice(0, 8)}`);
  const args = row.sourceSubpath
    ? ["clone", "--depth", "1", "--filter", "blob:none", "--no-checkout", norm.url!, tmp]
    : ["clone", "--depth", "1", norm.url!, tmp];
  const clone = await git(args);
  if (clone.code !== 0) {
    emitProgress({ ref, phase: "error", message: clone.stderr.slice(0, 300) });
    try {
      if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    } catch {}
    return { ok: false, error: `git clone failed: ${clone.stderr.slice(0, 200)}` };
  }
  if (row.sourceSubpath) {
    await git(["-C", tmp, "sparse-checkout", "set", "--cone", row.sourceSubpath]);
    await git(["-C", tmp, "checkout"]);
  }
  const skillDir = resolveSkillDir(row.sourceSubpath ? join(tmp, row.sourceSubpath) : tmp, row.sourceType === "skillssh" ? (row.sourceRef ?? "").split("/").pop() ?? null : null);
  if (!skillDir) {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
    emitProgress({ ref, phase: "error", message: "skill dir not found" });
    return { ok: false, error: "skill dir not found in remote" };
  }
  const centralDir = join(getCentralRepoDir(), skillId);
  const oldHash = existsSync(centralDir) ? hashSkillDir(centralDir) : null;
  const newHash = hashSkillDir(skillDir);
  const revSync = Bun.spawnSync(["git", "-C", tmp, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
  const revision = revSync.exitCode === 0 ? new TextDecoder().decode(revSync.stdout).trim() : null;
  if (oldHash === newHash) {
    // 内容无变化：只刷新 revision 元数据。
    upsertSkill({ id: skillId, name: row.name, sourceType: row.sourceType, sourceRef: row.sourceRef, sourceSubpath: row.sourceSubpath, sourceRevision: revision, tags: parseTags(row.tags) });
    writeSkillMeta(skillId);
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
    emitProgress({ ref, phase: "done", message: skillId });
    return { ok: true, unchanged: true };
  }
  emitProgress({ ref, phase: "installing" });
  muteSelfWrites();
  try {
    const staging = join(getTmpDir(), `stage-${randomUUID().slice(0, 8)}`);
    copyDirSkipVcs(skillDir, staging);
    if (existsSync(centralDir)) {
      const backup = join(getTmpDir(), `old-${randomUUID().slice(0, 8)}`);
      renameSync(centralDir, backup);
      try {
        renameSync(staging, centralDir);
        try {
          rmSync(backup, { recursive: true, force: true });
        } catch {}
      } catch (e) {
        // 换目录失败：回滚旧目录。
        renameSync(backup, centralDir);
        return { ok: false, error: String(e) };
      }
    } else {
      renameSync(staging, centralDir);
    }
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    try {
      if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }
  const meta = parseSkillMd(centralDir);
  upsertSkill({
    id: skillId,
    name: meta.name || row.name,
    description: meta.description ?? row.description,
    sourceType: row.sourceType,
    sourceRef: row.sourceRef,
    sourceSubpath: row.sourceSubpath,
    sourceRevision: revision,
    tags: parseTags(row.tags),
  });
  writeSkillMeta(skillId);
  resyncCopyTargets(skillId);
  audit("update", `${skillId} -> ${revision?.slice(0, 8) ?? "?"}`);
  emitProgress({ ref, phase: "done", message: skillId });
  return { ok: true };
}
