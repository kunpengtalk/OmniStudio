/**
 * 回合快照与回退（对齐 Codex 的回合安全网）。
 *
 * 为什么需要：Agent 改完一堆文件之后，用户最想要的按钮是「把它刚才那些改动撤掉」。
 * 靠工具事件里的 diff 回放在真实场景里不可靠（bash 改的文件、生成的新文件都不在
 * 工具 diff 里），所以参照 Codex 的做法给工作区建一个**影子 git 仓库**：
 *
 * - 仓库在数据目录（`<数据目录>/agent-snapshots/<工作区键>/`），
 *   **不碰用户自己的 `.git`**（我们用 `--git-dir` 指到影子仓库、`--work-tree` 指到工作区）；
 * - 每轮 Agent 开跑前提交一次（`add -A` + `commit --allow-empty`），
 *   因此快照记录的是「这一轮开始前」的状态；
 * - 回退就是 `reset --hard <该轮快照>`：这一轮新增的文件被删掉、改过的文件还原，
 *   而 `.gitignore` / 排除表里的东西（node_modules 等）**不受影响**（它们从未入库）。
 *
 * 依赖 git 可执行文件；没有 git 时整个功能静默降级（快照返回 null，界面不出现按钮）。
 * 每次快照的实际耗时与文件数都落统一日志，慢的时候能看出来是工作区太大。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "fs";
import path from "path";
import { createHash } from "crypto";

import { getSetting } from "./db/settings";
import { getDataDir } from "./paths";
import { logEvent } from "./app-log";

/** 一次回合快照。 */
export type TurnSnapshot = {
  /** git commit sha。 */
  id: string;
  conversationId: number;
  messageId: number | null;
  /** 展示用标签（例如「第 3 轮」）。 */
  label: string;
  createdAt: number;
  /** 快照时工作区里的文件数（排除 node_modules 等之后的量）。 */
  files: number;
};

/** 影子仓库里保存的索引：sha → 元数据（也是回退时的白名单）。 */
type SnapshotIndex = {
  workspace: string;
  records: TurnSnapshot[];
  /** 上次 `git gc` 的时间（毫秒）：维护是"顺手做"的，不做节流会在每轮都触发一次。 */
  lastGcAt?: number;
};

const GIT_TIMEOUT_MS = 20_000;
/** 索引最多保留这么多条（更老的快照仍在 git 历史里，只是不再提供回退入口）。 */
const MAX_RECORDS = 200;
/** 自动维护的节流窗口：再脏也 10 分钟才收拾一次。 */
const GC_MIN_INTERVAL_MS = 10 * 60 * 1000;
/** 每次维护最多扫这么多文件来算占用，避免超大工作区把设置页拖住。 */
const USAGE_SCAN_LIMIT = 20_000;

/**
 * 不进快照的目录 / 文件：与工具层的 IGNORED_DIRS 一致，外加构建产物与日志。
 * 写进影子仓库的 `.git/info/exclude`，因此不影响用户仓库的 .gitignore。
 */
const EXCLUDE_PATTERNS = [
  "node_modules/",
  "dist/",
  "build/",
  "out/",
  "coverage/",
  ".next/",
  ".nuxt/",
  ".turbo/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".cache/",
  ".gradle/",
  "target/",
  "Pods/",
  "DerivedData/",
  ".DS_Store",
  "*.log",
  // 应用自己的数据目录绝不该进快照（里面有 API Key）。
  ".omni-studio/",
];

/** 快照开关：默认开；`AGENT_SNAPSHOTS=0` 关掉（工作区特别大 / 不需要回退时）。 */
export function snapshotsEnabled(): boolean {
  return getSetting("AGENT_SNAPSHOTS") !== "0";
}

/** 影子仓库位置：按工作区绝对路径取稳定键，同一个工作区永远映射到同一个仓库。 */
export function snapshotRepoDir(workspace: string): string {
  const resolved = path.resolve(workspace);
  const hash = createHash("sha1").update(resolved).digest("hex").slice(0, 12);
  const name = path.basename(resolved).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40) || "workspace";
  return getDataDir("agent-snapshots", `${name}-${hash}`);
}

function gitDirOf(repoDir: string): string {
  return path.join(repoDir, ".git");
}

type GitResult = { ok: boolean; stdout: string; stderr: string };

/**
 * 跑一条 git 命令：argv 数组（不经过 shell），显式指定影子 git 目录与工作区，
 * 因此永远不会动到用户自己的仓库。所有写的操作都带超时。
 */
function runShadowGit(
  repoDir: string,
  workspace: string,
  args: string[],
  opts: { allowFailure?: boolean; env?: Record<string, string> } = {},
): GitResult {
  const proc = Bun.spawnSync({
    cmd: [
      "git",
      "--git-dir",
      gitDirOf(repoDir),
      "--work-tree",
      workspace,
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "gc.auto=0",
      ...args,
    ],
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
      LC_ALL: "C",
      // 影子仓库不需要任何身份配置：提交者固定成本地 Agent。
      GIT_AUTHOR_NAME: "OmniStudio Agent",
      GIT_AUTHOR_EMAIL: "agent@omnistudio.local",
      GIT_COMMITTER_NAME: "OmniStudio Agent",
      GIT_COMMITTER_EMAIL: "agent@omnistudio.local",
      ...(opts.env ?? {}),
    },
    timeout: GIT_TIMEOUT_MS,
  });
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  const ok = proc.exitCode === 0;
  if (!ok && !opts.allowFailure) {
    logEvent({
      level: "warn",
      source: "agent",
      event: "agent.snapshot.git",
      message: `git ${args[0] ?? ""} 失败：${stderr.trim().slice(0, 300)}`,
      detail: { workspace, args },
    });
  }
  return { ok, stdout, stderr };
}

/** git 是否可用（没有 git 时整个快照功能降级，不影响回合本身）。 */
export function gitAvailable(): boolean {
  try {
    const proc = Bun.spawnSync({ cmd: ["git", "--version"], stdout: "pipe", stderr: "pipe", timeout: 5000 });
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

/** 初始化影子仓库（幂等）：建目录、写排除表、确认 core.worktree 指向工作区。 */
export function ensureSnapshotRepo(workspace: string): { ok: true; repoDir: string } | { ok: false; error: string } {
  const root = path.resolve(workspace);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return { ok: false, error: `工作区不存在：${root}` };
  }
  const repoDir = snapshotRepoDir(root);
  const gitDir = gitDirOf(repoDir);
  try {
    if (!existsSync(gitDir)) {
      mkdirSync(repoDir, { recursive: true });
      const init = runShadowGit(repoDir, root, ["init", "--quiet"]);
      if (!init.ok) return { ok: false, error: init.stderr.trim() || "git init 失败" };
      // core.worktree 落进影子仓库配置：之后即使不带 --work-tree 也不会跑偏。
      runShadowGit(repoDir, root, ["config", "core.worktree", root], { allowFailure: true });
      runShadowGit(repoDir, root, ["config", "core.bare", "false"], { allowFailure: true });
    }
    const excludePath = path.join(gitDir, "info", "exclude");
    const excludeBody = `${EXCLUDE_PATTERNS.join("\n")}\n`;
    const current = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
    if (!current.includes("node_modules/")) {
      mkdirSync(path.dirname(excludePath), { recursive: true });
      writeFileSync(excludePath, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${excludeBody}`, "utf8");
    }
    return { ok: true, repoDir };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logEvent({
      level: "warn",
      source: "agent",
      event: "agent.snapshot.init",
      message: `影子仓库初始化失败：${message}`,
      detail: { workspace: root },
    });
    return { ok: false, error: message };
  }
}

function indexPath(repoDir: string): string {
  return path.join(repoDir, "index.json");
}

export function readSnapshotIndex(repoDir: string): SnapshotIndex {
  try {
    const parsed = JSON.parse(readFileSync(indexPath(repoDir), "utf8")) as SnapshotIndex;
    if (!parsed || !Array.isArray(parsed.records)) return { workspace: "", records: [] };
    return parsed;
  } catch {
    return { workspace: "", records: [] };
  }
}

function writeSnapshotIndex(repoDir: string, index: SnapshotIndex): void {
  const target = indexPath(repoDir);
  const tmp = `${target}.tmp`;
  // 先写临时文件再改名：界面随时在读它，不能读到写了一半的 JSON。
  writeFileSync(tmp, JSON.stringify(index, null, 2), "utf8");
  renameSync(tmp, target);
}

/**
 * 回合开始前的快照：`add -A` + `commit --allow-empty`。
 * 返回 null 表示没做成（git 缺失 / 关了开关 / 出错）——**调用方不该因此中断回合**。
 */
export function createTurnSnapshot(input: {
  conversationId: number;
  messageId: number | null;
  workspace: string;
  label?: string;
}): TurnSnapshot | null {
  if (!snapshotsEnabled()) return null;
  const prepared = ensureSnapshotRepo(input.workspace);
  if (!prepared.ok) return null;
  const { repoDir } = prepared;
  const workspace = path.resolve(input.workspace);
  const startedAt = Date.now();

  const added = runShadowGit(repoDir, workspace, ["add", "-A"]);
  if (!added.ok) return null;
  const staged = runShadowGit(repoDir, workspace, ["diff", "--cached", "--name-only"]);
  const files = staged.ok ? staged.stdout.split("\n").filter(Boolean).length : 0;
  const countAll = runShadowGit(repoDir, workspace, ["ls-files"]);
  const totalFiles = countAll.ok ? countAll.stdout.split("\n").filter(Boolean).length : files;

  const index = readSnapshotIndex(repoDir);
  const turnNumber = index.records.filter((record) => record.conversationId === input.conversationId).length + 1;
  const label = input.label ?? `第 ${turnNumber} 轮`;
  /**
   * 提交信息里带上会话 / 消息 / 毫秒时间戳，**也是为了唯一性**：
   * 两个工作区在同一秒提交同样的内容时，git 会算出同一个 sha，
   * 而 sha 是我们回退时的定位键 —— 撞车就会回退到别人的工作区。
   */
  const stampedAt = Date.now();
  const commitArgs = [
    "commit",
    "--quiet",
    "--no-verify",
    "--allow-empty",
    "-m",
    `omni-snapshot ${label} conv=${input.conversationId} msg=${input.messageId ?? 0} at=${stampedAt}`,
  ];
  const dateEnv = {
    GIT_AUTHOR_DATE: `${Math.floor(stampedAt / 1000)} +0000`,
    GIT_COMMITTER_DATE: `${Math.floor(stampedAt / 1000)} +0000`,
  };
  const committed = runShadowGit(repoDir, workspace, commitArgs, { env: dateEnv });
  if (!committed.ok) return null;
  const rev = runShadowGit(repoDir, workspace, ["rev-parse", "HEAD"]);
  if (!rev.ok) return null;

  const snapshot: TurnSnapshot = {
    id: rev.stdout.trim(),
    conversationId: input.conversationId,
    messageId: input.messageId,
    label,
    createdAt: stampedAt,
    files: totalFiles,
  };
  const records = [...index.records, snapshot].slice(-MAX_RECORDS);
  writeSnapshotIndex(repoDir, { workspace, records });

  // 顺手维护：阈值与节流都在 maybeGcSnapshotRepo 里判，这里只管调用。
  try {
    maybeGcSnapshotRepo(workspace);
  } catch {
    // 维护失败不影响快照本身
  }

  logEvent({
    level: "info",
    source: "agent",
    event: "agent.snapshot.created",
    message: `回合快照已创建：${label}（${totalFiles} 个文件，${Date.now() - startedAt}ms）`,
    detail: { conversationId: input.conversationId, workspace, id: snapshot.id, files: totalFiles },
  });
  return snapshot;
}

/** 某个会话（或全部）的快照，新 → 旧。 */
export function listTurnSnapshots(conversationId?: number): TurnSnapshot[] {
  if (!snapshotsEnabled()) return [];
  const base = getDataDir("agent-snapshots");
  if (!existsSync(base)) return [];
  const out: TurnSnapshot[] = [];
  for (const entry of new Bun.Glob("*/index.json").scanSync({ cwd: base, absolute: true })) {
    const index = readSnapshotIndex(path.dirname(entry));
    for (const record of index.records) {
      if (conversationId === undefined || record.conversationId === conversationId) out.push(record);
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 索引里的工作区必须与它所在的仓库目录对得上。
 *
 * 仓库目录名就是 `snapshotRepoDir(workspace)`（工作区绝对路径的 hash + 目录名），两者是
 * 一体的；对不上说明 `index.json` 被改过。这个检查是必须的，因为**写这个文件的人和
 * 被限制的人是同一个**：Agent 的 bash 工具沙箱默认是关的，它能改到应用数据目录里的
 * 这份 JSON，把 `workspace` 换成任意目录 —— 之后用户一点「撤销本轮」，
 * `git add -A` + `read-tree --reset -u` 就会把那个目录清成快照时的树（快照里没有的
 * 文件全被删掉）。索引文件对不上时一律当"快照不可信"，不猜、不兜底。
 */
function workspaceMatchesRepo(repoDir: string, workspace: string): boolean {
  if (!workspace) return false;
  try {
    return path.resolve(snapshotRepoDir(workspace)) === path.resolve(repoDir);
  } catch {
    return false;
  }
}

type SnapshotLookup =
  | { ok: true; snapshot: TurnSnapshot; repoDir: string; workspace: string }
  | { ok: false; reason: "missing" | "untrusted" };

/**
 * 找一条快照（回退 / 预览都要先确认它确实存在）。
 *
 * 同一条 id 理论上只属于一个仓库（提交信息里带了会话 / 消息 / 毫秒时间戳），
 * 但万一撞车，优先返回**工作区还在**的那个；`workspace` 与仓库目录对不上的记录直接
 * 不参与（见 `workspaceMatchesRepo`），宁可报"不可信"也不拿它去改文件系统。
 */
function lookupSnapshot(id: string): SnapshotLookup {
  const base = getDataDir("agent-snapshots");
  if (!existsSync(base)) return { ok: false, reason: "missing" };
  const matches: {
    snapshot: TurnSnapshot;
    repoDir: string;
    workspace: string;
    workspaceExists: boolean;
  }[] = [];
  let sawUntrusted = false;
  for (const entry of new Bun.Glob("*/index.json").scanSync({ cwd: base, absolute: true })) {
    const repoDir = path.dirname(entry);
    const index = readSnapshotIndex(repoDir);
    const record = index.records.find((item) => item.id === id);
    if (!record) continue;
    if (!workspaceMatchesRepo(repoDir, index.workspace)) {
      sawUntrusted = true;
      logEvent({
        level: "warn",
        source: "agent",
        event: "agent.snapshot.untrusted",
        message: "快照索引里的工作区与快照仓库对不上，已忽略这条记录",
        detail: { id, repoDir, workspace: index.workspace },
      });
      continue;
    }
    matches.push({
      snapshot: record,
      repoDir,
      workspace: index.workspace,
      workspaceExists: existsSync(index.workspace),
    });
  }
  if (!matches.length) return { ok: false, reason: sawUntrusted ? "untrusted" : "missing" };
  const preferred = matches.find((match) => match.workspaceExists) ?? matches[0]!;
  return { ok: true, snapshot: preferred.snapshot, repoDir: preferred.repoDir, workspace: preferred.workspace };
}

export function findSnapshot(id: string): { snapshot: TurnSnapshot; repoDir: string } | null {
  const found = lookupSnapshot(id);
  return found.ok ? { snapshot: found.snapshot, repoDir: found.repoDir } : null;
}

/** 找不到 / 不可信时给用户看的话。 */
function lookupError(reason: "missing" | "untrusted"): string {
  return reason === "untrusted"
    ? "这条快照的记录已不可信（工作区与快照仓库对不上），已拒绝回退。请重新执行一轮以生成新快照。"
    : "快照不存在或已被清理";
}

/**
 * 回退会改哪些文件（拿给用户在点之前看一眼）。
 *
 * `git diff <sha>` 只看已跟踪的路径，所以额外补上未跟踪文件（状态 `?`）——
 * 它们一样会被回退删掉，不列出来就是"预览说一套、执行做一套"。
 */
export function previewSnapshotChanges(id: string): {
  ok: boolean;
  workspace?: string;
  files?: { status: string; path: string }[];
  error?: string;
} {
  const found = lookupSnapshot(id);
  if (!found.ok) return { ok: false, error: lookupError(found.reason) };
  const { repoDir, workspace } = found;
  if (!existsSync(workspace)) {
    return { ok: false, error: "快照对应的工作区已不存在" };
  }
  // 与当前工作区对比：`diff <sha>` 给的是「回退后会发生的改动」。
  const diff = runShadowGit(repoDir, workspace, ["diff", "--name-status", id], { allowFailure: true });
  if (!diff.ok) return { ok: false, error: diff.stderr.trim() || "无法计算差异" };
  const files = diff.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status = "", ...rest] = line.split("\t");
      return { status: status.charAt(0), path: rest.join("\t") };
    });
  const untracked = runShadowGit(repoDir, workspace, ["ls-files", "--others", "--exclude-standard"], {
    allowFailure: true,
  });
  if (untracked.ok) {
    for (const path of untracked.stdout.split("\n").filter(Boolean)) {
      files.push({ status: "?", path });
    }
  }
  return { ok: true, workspace, files };
}

export type RevertResult =
  | { ok: true; workspace: string; restored: string[]; removed: string[] }
  | { ok: false; error: string };

/**
 * 回退到某次回合快照。
 *
 * 两条命令的分工：
 * 1. `add -A` 先把当前状态（含这一轮新建的文件）登记进索引；
 * 2. `read-tree --reset -u <sha>` 把索引与工作区一起还原成快照时的树 ——
 *    用 `read-tree` 而不是 `reset --hard`，是因为后者会把 HEAD 一起挪回去，
 *    之后就没法再"回到更近的某一轮"了（快照链要一直保留）。
 *
 * 只影响工作区里**曾经被快照跟踪**的路径；排除表（node_modules / 构建产物）与
 * 用户自己 .gitignore 掉的东西原样保留。
 */
export function revertToSnapshot(id: string): RevertResult {
  const found = lookupSnapshot(id);
  if (!found.ok) return { ok: false, error: lookupError(found.reason) };
  const { repoDir, workspace } = found;
  if (!existsSync(workspace)) return { ok: false, error: "快照对应的工作区已不存在" };
  if (!existsSync(gitDirOf(repoDir))) return { ok: false, error: "快照仓库已被删除" };

  const before = previewSnapshotChanges(id);
  const staged = runShadowGit(repoDir, workspace, ["add", "-A"], { allowFailure: true });
  if (!staged.ok) return { ok: false, error: staged.stderr.trim() || "git add 失败" };
  const reset = runShadowGit(repoDir, workspace, ["read-tree", "--reset", "-u", id], { allowFailure: true });
  if (!reset.ok) {
    return { ok: false, error: reset.stderr.trim() || "git read-tree 失败" };
  }
  const files = before.ok ? (before.files ?? []) : [];
  // A = 快照之后新增的（回退时删掉），? = 未跟踪的新文件（同样删掉），
  // D / M / R = 快照里有的（回退时还原）。
  const removed = files.filter((file) => file.status === "A" || file.status === "?").map((file) => file.path);
  const restored = files.filter((file) => file.status !== "A" && file.status !== "?").map((file) => file.path);

  logEvent({
    level: "info",
    source: "agent",
    event: "agent.snapshot.reverted",
    message: `已回退到回合快照（还原 ${restored.length} 个、删除 ${removed.length} 个文件）`,
    detail: { workspace, id, restored: restored.slice(0, 50), removed: removed.slice(0, 50) },
  });
  return { ok: true, workspace, restored, removed };
}

/* -------------------------------------------------------------------------
 * 仓库维护：占用统计 + 自动 / 手动 gc
 *
 * 为什么需要：影子仓库跟着每一轮提交长（每轮一棵树 + 一个 commit），
 * 裸对象（loose objects）既占地方又不共享 —— 而相邻两轮的绝大多数文件是同一份，
 * 打包（pack）之后这些重复内容只会存一次。所以在"仓库明显变大 / 快照条数到顶"
 * 时顺手收拾一次，并把占用显示在设置页，用户能看见它到底吃了多少磁盘。
 * ---------------------------------------------------------------------- */

export type SnapshotRepoUsage = {
  repoDir: string;
  workspace: string;
  /** `.git` 目录占用的字节数。 */
  bytes: number;
  /** 索引里还留着多少轮快照。 */
  turns: number;
  lastSnapshotAt: number | null;
  lastGcAt: number | null;
  /** 达到上限（20k 文件）时说明这个数是下限。 */
  truncated: boolean;
};

/** 递归量一个目录的字节数（跟着符号链接会把整个磁盘卷进来，所以不跟随）。 */
function directoryBytes(root: string): { bytes: number; files: number; truncated: boolean } {
  let bytes = 0;
  let files = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files >= USAGE_SCAN_LIMIT) return { bytes, files, truncated: true };
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(target);
      } else if (entry.isFile()) {
        files += 1;
        try {
          bytes += statSync(target).size;
        } catch {
          // 读不到就跳过：占用统计不该因为一个文件失败而整个失败
        }
      }
    }
  }
  return { bytes, files, truncated: false };
}

/** 某个工作区的影子仓库占用（没有仓库时返回 null）。 */
export function snapshotRepoUsage(workspace: string): SnapshotRepoUsage | null {
  const root = path.resolve(workspace);
  const repoDir = snapshotRepoDir(root);
  if (!existsSync(path.join(repoDir, ".git"))) return null;
  const index = readSnapshotIndex(repoDir);
  const measured = directoryBytes(repoDir);
  const last = index.records[index.records.length - 1];
  return {
    repoDir,
    workspace: index.workspace || root,
    bytes: measured.bytes,
    turns: index.records.length,
    lastSnapshotAt: last?.createdAt ?? null,
    lastGcAt: index.lastGcAt ?? null,
    truncated: measured.truncated,
  };
}

/** 维护阈值：大于这么多字节、或快照条数到顶时收拾一次（设置项可调）。 */
export function snapshotGcThresholds(): { bytes: number; turns: number } {
  const rawBytes = Number(getSetting("AGENT_SNAPSHOT_GC_MB")) * 1024 * 1024;
  const bytes = Number.isFinite(rawBytes) && rawBytes > 0 ? rawBytes : 256 * 1024 * 1024;
  const rawTurns = Number(getSetting("AGENT_SNAPSHOT_GC_TURNS"));
  const turns = Number.isFinite(rawTurns) && rawTurns > 0 ? Math.max(10, Math.floor(rawTurns)) : MAX_RECORDS;
  return { bytes, turns };
}

export type SnapshotGcResult = {
  ran: boolean;
  /** 没跑的原因（界面与日志要能解释"为什么没收拾"）。 */
  reason?: string;
  bytesBefore: number;
  bytesAfter: number;
  freedBytes: number;
};

/**
 * 收拾影子仓库：`git gc --prune=now`。
 *
 * 触发条件（任一满足，且距上次维护超过 10 分钟）：
 * - `.git` 占用超过 `AGENT_SNAPSHOT_GC_MB`（默认 256MB）；
 * - 快照条数达到 `AGENT_SNAPSHOT_GC_TURNS`（默认 200，与索引上限一致 ——
 *   到顶意味着接下来要丢老记录，正是该打包的时候）。
 * `force: true` 跳过阈值与节流（设置页的「立即清理」用它）。
 *
 * 历史不会被丢掉：每轮快照都是 HEAD 的祖先，`gc` 只打包合并、不删可达对象；
 * 但索引里已经不再提供入口的老记录，其对象会在 prune 时被回收。
 */
export function maybeGcSnapshotRepo(workspace: string, opts: { force?: boolean } = {}): SnapshotGcResult {
  const before = snapshotRepoUsage(workspace);
  if (!before) {
    return { ran: false, reason: "还没有影子仓库（这个工作区没跑过 Agent 回合）", bytesBefore: 0, bytesAfter: 0, freedBytes: 0 };
  }
  const thresholds = snapshotGcThresholds();
  if (!opts.force) {
    const recently = before.lastGcAt !== null && Date.now() - before.lastGcAt < GC_MIN_INTERVAL_MS;
    if (recently) {
      return { ran: false, reason: "距上次维护不到 10 分钟", bytesBefore: before.bytes, bytesAfter: before.bytes, freedBytes: 0 };
    }
    const overBytes = before.bytes > thresholds.bytes;
    const full = before.turns >= thresholds.turns;
    if (!overBytes && !full) {
      return {
        ran: false,
        reason: `占用 ${Math.round(before.bytes / 1024 / 1024)}MB < ${Math.round(thresholds.bytes / 1024 / 1024)}MB，快照 ${before.turns} 轮 < ${thresholds.turns} 轮`,
        bytesBefore: before.bytes,
        bytesAfter: before.bytes,
        freedBytes: 0,
      };
    }
  }

  const startedAt = Date.now();
  const gc = runShadowGit(before.repoDir, before.workspace, ["gc", "--prune=now", "--quiet"], {
    allowFailure: true,
  });
  const after = snapshotRepoUsage(before.workspace) ?? before;
  const index = readSnapshotIndex(before.repoDir);
  writeSnapshotIndex(before.repoDir, { ...index, lastGcAt: Date.now() });

  const freedBytes = Math.max(0, before.bytes - after.bytes);
  logEvent({
    level: gc.ok ? "info" : "warn",
    source: "agent",
    event: "agent.snapshot.gc",
    message: gc.ok
      ? `影子仓库已整理：${Math.round(before.bytes / 1024 / 1024)}MB → ${Math.round(after.bytes / 1024 / 1024)}MB（释放 ${Math.round(freedBytes / 1024)}KB，${Date.now() - startedAt}ms）`
      : `影子仓库整理失败：${gc.stderr.trim().slice(0, 200)}`,
    detail: { workspace: before.workspace, repoDir: before.repoDir, turns: before.turns, force: opts.force === true },
  });
  return {
    ran: gc.ok,
    ...(gc.ok ? {} : { reason: gc.stderr.trim().slice(0, 200) || "git gc 失败" }),
    bytesBefore: before.bytes,
    bytesAfter: after.bytes,
    freedBytes,
  };
}

/** 设置页展示用：开关状态、git 可用性、某工作区的快照数量。 */
export function snapshotStatus(workspace?: string): {
  enabled: boolean;
  gitAvailable: boolean;
  repoDir: string | null;
  turns: number;
  /** 影子仓库占用（没建过仓库时 null）：设置页要显示它到底吃了多少磁盘。 */
  usage: SnapshotRepoUsage | null;
  gcThresholds: { bytes: number; turns: number };
} {
  const enabled = snapshotsEnabled();
  const available = gitAvailable();
  const gcThresholds = snapshotGcThresholds();
  if (!enabled || !workspace || !available) {
    return { enabled, gitAvailable: available, repoDir: null, turns: 0, usage: null, gcThresholds };
  }
  const usage = snapshotRepoUsage(workspace);
  return {
    enabled,
    gitAvailable: available,
    repoDir: usage?.repoDir ?? snapshotRepoDir(workspace),
    turns: usage?.turns ?? 0,
    usage,
    gcThresholds,
  };
}
