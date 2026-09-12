// Git 备份：中央库（~/.agents/skills）作为 git 仓库，init/commit/push/pull、
// 快照 tag 与恢复、自动备份（中央库变更尾去抖）、冲突整体二选一（操作前快照兜底）。
import { join } from "path";
import { existsSync, appendFileSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { getSetting, updateSettings } from "../db/settings";
import { SKILL_SIZE_LIMIT_BYTES } from "../../shared/skills";
import { getCentralRepoDir, ensureCentralRepo, onCentralChanged, muteSelfWrites } from "./central-repo";
import { writeAllMetadata, reindexFromMetadata } from "./meta-sync";
import { dirSizeBytes } from "./metadata";
import { audit } from "./audit";

const GITIGNORE_LINES = [".DS_Store", "Thumbs.db", "*.tmp", "__pycache__/", "*.pyc", ".omnistudio/tmp/", ".omnistudio/project-backups/"];

function git(args: string[]): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["git", "-C", getCentralRepoDir(), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return {
    code: proc.exitCode ?? -1,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

/** 远端 URL：设置里的 remote + 可选 PAT（https 时注入 userinfo）。 */
function remoteUrlWithCredential(): { url: string; hasPat: boolean } {
  const remote = getSetting("SKILLS_GIT_REMOTE").trim();
  const pat = getSetting("SKILLS_GIT_PAT").trim();
  if (!remote) return { url: "", hasPat: false };
  if (pat && /^https:\/\//.test(remote)) {
    return { url: remote.replace(/^https:\/\//, `https://x-access-token:${pat}@`), hasPat: true };
  }
  return { url: remote, hasPat: pat.length > 0 };
}

export interface BackupStatus {
  initialized: boolean;
  remote: string;
  branch: string;
  ahead: number;
  behind: number;
  lastCommit: string | null;
  autoBackup: boolean;
  dirty: boolean;
}

export function backupStatus(): BackupStatus {
  ensureCentralRepo();
  const initialized = existsSync(join(getCentralRepoDir(), ".git"));
  if (!initialized) {
    return {
      initialized: false,
      remote: getSetting("SKILLS_GIT_REMOTE"),
      branch: "main",
      ahead: 0,
      behind: 0,
      lastCommit: null,
      autoBackup: getSetting("SKILLS_AUTO_BACKUP") === "1",
      dirty: false,
    };
  }
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim() || "main";
  let ahead = 0;
  let behind = 0;
  const counts = git(["rev-list", "--left-right", "--count", `origin/${branch}...HEAD`]);
  if (counts.code === 0) {
    const parts = counts.stdout.trim().split(/\s+/);
    behind = Number(parts[0]) || 0;
    ahead = Number(parts[1]) || 0;
  }
  const last = git(["log", "-1", "--pretty=format:%h %ad %s", "--date=short"]);
  const status = git(["status", "--porcelain"]);
  return {
    initialized: true,
    remote: getSetting("SKILLS_GIT_REMOTE"),
    branch,
    ahead,
    behind,
    lastCommit: last.code === 0 ? last.stdout.trim() : null,
    autoBackup: getSetting("SKILLS_AUTO_BACKUP") === "1",
    dirty: status.stdout.trim().length > 0,
  };
}

/** 初始化（幂等）：git init main + .gitignore 追加。 */
export function backupInit(): { ok: boolean; error?: string } {
  const r = ensureCentralRepo();
  if (!r.ok) return { ok: false, error: "central repo unavailable" };
  if (!existsSync(join(getCentralRepoDir(), ".git"))) {
    const init = git(["init", "-b", "main"]);
    if (init.code !== 0) return { ok: false, error: init.stderr.slice(0, 200) };
  }
  // .gitignore 追加缺的行。
  const giPath = join(getCentralRepoDir(), ".gitignore");
  let gi = "";
  try {
    gi = readFileSync(giPath, "utf8");
  } catch {}
  const lines = new Set(gi.split(/\r?\n/));
  let changed = false;
  for (const line of GITIGNORE_LINES) {
    if (!lines.has(line)) {
      gi += (gi.endsWith("\n") || gi === "" ? "" : "\n") + line + "\n";
      lines.add(line);
      changed = true;
    }
  }
  if (changed) writeFileSync(giPath, gi);
  audit("backup_init", getCentralRepoDir());
  return { ok: true };
}

export function setBackupRemote(url: string, pat?: string): { ok: boolean; error?: string } {
  updateSettings({
    SKILLS_GIT_REMOTE: url.trim(),
    ...(pat !== undefined ? { SKILLS_GIT_PAT: pat.trim() } : {}),
  });
  if (!url.trim()) return { ok: true };
  backupInit();
  const r = git(["remote", "set-url", "origin", url.trim()]);
  if (r.code !== 0) {
    const add = git(["remote", "add", "origin", url.trim()]);
    if (add.code !== 0) return { ok: false, error: add.stderr.slice(0, 200) };
  }
  return { ok: true };
}

/** 写元数据 + 全量提交。 */
export function backupCommit(message = "backup"): { ok: boolean; error?: string } {
  if (!existsSync(join(getCentralRepoDir(), ".git"))) return { ok: false, error: "not initialized" };
  try {
    muteSelfWrites();
    writeAllMetadata();
  } catch (e) {
    return { ok: false, error: `metadata: ${e}` };
  }
  git(["add", "-A"]);
  const status = git(["status", "--porcelain"]);
  if (status.stdout.trim() === "") return { ok: true };
  const c = git(["commit", "-m", message]);
  if (c.code !== 0) return { ok: false, error: c.stderr.slice(0, 200) };
  audit("backup_commit", message);
  return { ok: true };
}

export function backupPush(): { ok: boolean; error?: string } {
  const { url } = remoteUrlWithCredential();
  if (!url) return { ok: false, error: "no remote" };
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim() || "main";
  // 首推：set upstream。
  const push = git(["push", "-u", url, `HEAD:${branch}`]);
  if (push.code !== 0) {
    return { ok: false, error: classifyPushError(push.stderr) };
  }
  // 指向真实 remote 名（供 ahead/behind 统计）。
  git(["remote", "set-url", "origin", getSetting("SKILLS_GIT_REMOTE")]);
  git(["branch", "--set-upstream-to=origin/" + branch, branch]);
  return { ok: true };
}

function classifyPushError(stderr: string): string {
  if (stderr.includes("non-fast-forward") || stderr.includes("fetch first") || stderr.includes("rejected")) {
    return "SYNC_CONFLICT";
  }
  if (stderr.includes("Authentication failed") || stderr.includes("403")) {
    return "AUTH_FAILED";
  }
  return stderr.slice(0, 200);
}

export function backupPull(): { ok: boolean; error?: string } {
  const { url } = remoteUrlWithCredential();
  if (!url) return { ok: false, error: "no remote" };
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim() || "main";
  const fetch = git(["fetch", url, branch]);
  if (fetch.code !== 0) return { ok: false, error: fetch.stderr.slice(0, 200) };
  const merge = git(["merge", "--no-edit", "FETCH_HEAD"]);
  if (merge.code !== 0) {
    git(["merge", "--abort"]);
    return { ok: false, error: "MERGE_CONFLICT" };
  }
  // pull 后从元数据重建 DB（跨设备恢复）。
  muteSelfWrites();
  const restored = reindexFromMetadata();
  audit("backup_pull", `restored ${restored.restored}`);
  return { ok: true };
}

/** 快照 tag：omni-v-{时间戳}-{shortsha}。 */
export function createSnapshot(name?: string): { ok: boolean; tag?: string; error?: string } {
  const commit = backupCommit(name ? `snapshot: ${name}` : "snapshot");
  if (!commit.ok) return { ok: false, error: commit.error };
  const sha = git(["rev-parse", "--short", "HEAD"]).stdout.trim() || "nosh";
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  let tag = `omni-v-${ts}-${sha}`;
  if (git(["tag", "-l", tag]).stdout.trim()) tag += `-${Date.now() % 1000}`;
  const t = git(["tag", tag]);
  if (t.code !== 0) return { ok: false, error: t.stderr.slice(0, 200) };
  audit("snapshot", tag);
  return { ok: true, tag };
}

export function listSnapshots(): { tag: string; date: string; subject: string }[] {
  const out: { tag: string; date: string; subject: string }[] = [];
  const tags = git(["tag", "-l", "omni-v-*"]).stdout.trim();
  if (!tags) return out;
  for (const tag of tags.split("\n").reverse()) {
    const info = git(["log", "-1", "--pretty=format:%ad %s", "--date=short", tag]);
    const [date, ...rest] = info.stdout.trim().split(" ");
    out.push({ tag, date: date ?? "", subject: rest.join(" ") });
  }
  return out;
}

/** 恢复到快照：当前状态先自动快照，再 checkout tag 内容。 */
export function restoreSnapshot(tag: string): { ok: boolean; error?: string } {
  if (!/^omni-v-[\w-]+$/.test(tag)) return { ok: false, error: "invalid tag" };
  createSnapshot("pre-restore");
  const c = git(["checkout", tag, "--", "."]);
  if (c.code !== 0) return { ok: false, error: c.stderr.slice(0, 200) };
  backupCommit(`restore: switch skills library to ${tag}`);
  muteSelfWrites();
  reindexFromMetadata();
  audit("restore", tag);
  return { ok: true };
}

/** 冲突二选一：保留本地（强推，先推快照 tag 保底）/ 使用远端（reset --hard）。 */
export function resolveConflict(keep: "local" | "remote"): { ok: boolean; error?: string } {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim() || "main";
  if (keep === "local") {
    createSnapshot("pre-force-push");
    const { url } = remoteUrlWithCredential();
    if (!url) return { ok: false, error: "no remote" };
    const push = git(["push", "-u", url, `+HEAD:${branch}`]);
    return push.code === 0 ? { ok: true } : { ok: false, error: push.stderr.slice(0, 200) };
  }
  createSnapshot("pre-reset-remote");
  const { url } = remoteUrlWithCredential();
  if (!url) return { ok: false, error: "no remote" };
  const fetch = git(["fetch", url, branch]);
  if (fetch.code !== 0) return { ok: false, error: fetch.stderr.slice(0, 200) };
  const reset = git(["reset", "--hard", "FETCH_HEAD"]);
  if (reset.code !== 0) return { ok: false, error: reset.stderr.slice(0, 200) };
  muteSelfWrites();
  reindexFromMetadata();
  return { ok: true };
}

export function setAutoBackup(enabled: boolean) {
  updateSettings({ SKILLS_AUTO_BACKUP: enabled ? "1" : "0" });
}

/** 体积报告：仓库总大小 + 超过 100MB 的技能列表。 */
export function sizeReport(): { totalBytes: number; oversized: { id: string; bytes: number }[] } {
  const central = getCentralRepoDir();
  const total = dirSizeBytes(central);
  const oversized: { id: string; bytes: number }[] = [];
  try {
    for (const e of readdirSync(central, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const bytes = dirSizeBytes(join(central, e.name));
      if (bytes > SKILL_SIZE_LIMIT_BYTES) oversized.push({ id: e.name, bytes });
    }
  } catch {}
  return { totalBytes: total, oversized };
}

// ---------------------------------------------------------------------------
// 自动备份：中央库外部变更 → 尾去抖 120s → commit + push（失败指数退避）。
// ---------------------------------------------------------------------------

let autoTimer: ReturnType<typeof setTimeout> | null = null;
let failures = 0;
let running = false;

function scheduleAutoBackup() {
  if (getSetting("SKILLS_AUTO_BACKUP") !== "1") return;
  if (autoTimer) clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    autoTimer = null;
    void runAutoBackup();
  }, 120_000);
}

async function runAutoBackup() {
  if (running) return;
  running = true;
  try {
    const commit = backupCommit("auto backup");
    if (!commit.ok) throw new Error(commit.error);
    if (getSetting("SKILLS_GIT_REMOTE")) {
      const push = backupPush();
      if (!push.ok && push.error === "SYNC_CONFLICT") {
        // 自动模式保守处理：拉取合并一次，再失败就留给用户手动处理。
        try {
          backupPull();
        } catch {}
      } else if (!push.ok) {
        throw new Error(push.error);
      }
    }
    failures = 0;
  } catch {
    failures++;
  } finally {
    running = false;
    if (failures > 0) {
      // 指数退避：2^failures 分钟后重试（上限 60 分钟）。
      const delay = Math.min(2 ** failures, 60) * 60_000;
      setTimeout(() => void runAutoBackup(), delay);
    }
  }
}

/** 启动自动备份监听（应用启动时调用一次）。 */
export function startAutoBackup() {
  onCentralChanged(() => scheduleAutoBackup());
}

export function appendBackupLog(line: string) {
  try {
    mkdirSync(join(getCentralRepoDir(), ".omnistudio"), { recursive: true });
    appendFileSync(join(getCentralRepoDir(), ".omnistudio", "backup.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {}
}
