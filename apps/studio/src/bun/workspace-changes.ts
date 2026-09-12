/**
 * 工作区改动（侧边面板的「审查」页签）：
 * 工作区是 git 仓库时用 `git status` + `git diff --numstat` 给出「哪些文件动了、增删多少行」，
 * 点开某个文件再看它的 unified diff —— 与 ZCode 审查面板的信息结构一致。
 *
 * 只用 argv 数组调 git（不经过 shell），路径全部落在工作区内（safeJoin），
 * 因此面板里点不到工作区之外的东西。
 */
import { existsSync, readFileSync, statSync } from "fs";
import path from "path";

import { safeJoin } from "./path-safety";

// diff 行分类与界面共用（见 shared/diff.ts）
export { parseUnifiedDiff, type DiffLine } from "../shared/diff";

export type WorkspaceChangeFile = {
  /** 相对工作区的路径（git 输出的就是相对路径）。 */
  path: string;
  /** M 修改 / A 新增 / D 删除 / R 重命名 / ?? 未跟踪 / U 冲突。 */
  status: string;
  added: number | null;
  removed: number | null;
};

export type WorkspaceChanges = {
  root: string;
  /** 工作区是不是 git 仓库；否时界面回落到「本会话改动」。 */
  isRepo: boolean;
  files: WorkspaceChangeFile[];
  error?: string;
};

/** 最多列这么多文件 / diff 字符，避免大仓库一次把界面撑爆。 */
const MAX_FILES = 400;
const MAX_DIFF_CHARS = 400_000;
const GIT_TIMEOUT_MS = 10_000;

async function runGit(
  root: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: ["git", "-C", root, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", LC_ALL: "C" },
  });
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // 已经退出
    }
  }, GIT_TIMEOUT_MS);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { ok: code === 0, stdout, stderr };
  } catch {
    return { ok: false, stdout: "", stderr: "git failed" };
  } finally {
    clearTimeout(timer);
  }
}

export async function isGitRepo(root: string): Promise<boolean> {
  if (!root || !existsSync(root)) return false;
  const result = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  return result.ok && result.stdout.trim() === "true";
}

/** `git status --porcelain -z` 的条目解析（-z 下重命名会多带一个原路径）。 */
function parseStatus(stdout: string): { path: string; status: string }[] {
  const entries = stdout.split("\0").filter(Boolean);
  const files: { path: string; status: string }[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2).trim() || "?";
    const filePath = entry.slice(3);
    files.push({ path: filePath, status: status === "??" ? "??" : status });
    // 重命名 / 复制：紧跟的下一段是原路径，跳过它。
    if (status.startsWith("R") || status.startsWith("C")) i += 1;
  }
  return files;
}

/** 未跟踪文件没有 numstat，直接数行得到「+N」。 */
function countLines(absPath: string): number | null {
  try {
    const stat = statSync(absPath);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return null;
    const text = readFileSync(absPath, "utf8");
    if (!text) return 0;
    const lines = text.split("\n");
    return text.endsWith("\n") ? lines.length - 1 : lines.length;
  } catch {
    return null;
  }
}

export async function getWorkspaceChanges(root: string): Promise<WorkspaceChanges> {
  if (!root || !existsSync(root)) {
    return { root, isRepo: false, files: [], error: "Workspace not found" };
  }
  if (!(await isGitRepo(root))) {
    return { root, isRepo: false, files: [] };
  }

  const status = await runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!status.ok) {
    return { root, isRepo: true, files: [], error: status.stderr.trim() || "git status failed" };
  }
  const entries = parseStatus(status.stdout).slice(0, MAX_FILES);

  // 增删行数：相对 HEAD 的累计改动（暂存 + 未暂存都算），一次拿全表。
  const numstat = await runGit(root, ["diff", "--numstat", "HEAD", "--"]);
  const stats = new Map<string, { added: number | null; removed: number | null }>();
  for (const line of numstat.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [added, removed, ...rest] = line.split("\t");
    const filePath = rest.join("\t");
    if (!filePath) continue;
    stats.set(filePath, {
      added: added === "-" ? null : Number(added),
      removed: removed === "-" ? null : Number(removed),
    });
  }

  const files = entries.map((entry) => {
    const stat = stats.get(entry.path);
    if (stat) return { path: entry.path, status: entry.status, ...stat };
    if (entry.status === "??") {
      const abs = safeJoin(root, entry.path);
      return { path: entry.path, status: entry.status, added: abs ? countLines(abs) : null, removed: 0 };
    }
    return { path: entry.path, status: entry.status, added: 0, removed: 0 };
  });

  return { root, isRepo: true, files };
}

export type WorkspaceDiff = {
  path: string;
  diff: string;
  truncated: boolean;
  /** 二进制 / 超大文件：没有可展示的文本 diff。 */
  binary: boolean;
};

export async function getWorkspaceDiff(root: string, relativePath: string): Promise<WorkspaceDiff> {
  const abs = safeJoin(root, relativePath);
  if (!abs) throw new Error("Path outside workspace");
  if (!existsSync(abs)) {
    // 已删除的文件：git 里还有 diff，照样能看。
  }

  let diff = (await runGit(root, ["diff", "HEAD", "--", relativePath])).stdout;
  if (!diff.trim()) {
    // 未跟踪文件（git diff 看不到）：用 --no-index 跟 /dev/null 比，得到标准 unified diff。
    const untracked = await runGit(root, ["diff", "--no-index", "--no-color", "--", "/dev/null", relativePath]);
    diff = untracked.stdout;
  }

  const binary = /Binary files .* differ/.test(diff) || diff.includes("GIT binary patch");
  const truncated = diff.length > MAX_DIFF_CHARS;
  return {
    path: relativePath,
    diff: truncated ? `${diff.slice(0, MAX_DIFF_CHARS)}\n…(truncated)` : diff,
    truncated,
    binary,
  };
}

/** 工作区里有没有 .git 目录（面板显示「审查」页签的前置条件，纯同步判断，便宜）。 */
export function hasGitDir(root: string): boolean {
  try {
    return existsSync(path.join(root, ".git"));
  } catch {
    return false;
  }
}
