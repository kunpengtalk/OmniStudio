import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import {
  createTurnSnapshot,
  findSnapshot,
  maybeGcSnapshotRepo,
  snapshotGcThresholds,
  snapshotRepoUsage,
  gitAvailable,
  listTurnSnapshots,
  previewSnapshotChanges,
  revertToSnapshot,
  snapshotRepoDir,
  snapshotStatus,
  snapshotsEnabled,
} from "./agent-snapshots";
import { updateSettings } from "./db/settings";

/**
 * 回合快照与回退（对齐 Codex 的回合安全网）。
 *
 * 这里跑的是**真实 git**：快照链、read-tree 的还原语义、排除表，都只有在真
 * 仓库上才验得出来。没有 git 的环境整体跳过（功能本身也会静默降级）。
 */
const hasGit = gitAvailable();

let workspace: string;

beforeAll(() => {
  if (!hasGit) console.warn("跳过回合快照测试：环境里没有 git");
});

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "omni-snapshot-ws-"));
});

afterEach(() => {
  updateSettings({ AGENT_SNAPSHOTS: "1" });
  rmSync(workspace, { recursive: true, force: true });
});

afterAll(() => {
  // 影子仓库留在隔离的测试数据目录里，不影响真实用户数据。
});

const write = (relative: string, contents: string) => {
  const target = path.join(workspace, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
};

const read = (relative: string) => readFileSync(path.join(workspace, relative), "utf8");
const exists = (relative: string) => existsSync(path.join(workspace, relative));

describe("影子仓库", () => {
  test("仓库建在数据目录里，不碰工作区", () => {
    if (!hasGit) return;
    const repoDir = snapshotRepoDir(workspace);
    write("a.txt", "v1\n");
    const snapshot = createTurnSnapshot({ conversationId: 1, messageId: 10, workspace });
    expect(snapshot).not.toBeNull();
    expect(existsSync(repoDir)).toBe(true);
    // 工作区里不该多出 .git 或任何我们的文件。
    expect(existsSync(path.join(workspace, ".git"))).toBe(false);
    expect(snapshot!.files).toBe(1);
  });

  test("node_modules / 构建产物不进快照（排除表生效）", () => {
    if (!hasGit) return;
    write("src/app.ts", "export const a = 1;\n");
    write("node_modules/dep/index.js", "module.exports = {};\n");
    write("dist/bundle.js", "// built\n");
    const snapshot = createTurnSnapshot({ conversationId: 1, messageId: 11, workspace });
    expect(snapshot!.files).toBe(1); // 只有 src/app.ts
  });

  test("工作区里已有的 git 仓库不受影响", () => {
    if (!hasGit) return;
    // 用户自己的工作区就是一个 git 仓库：影子仓库必须完全绕开它。
    const userRepo = Bun.spawnSync({ cmd: ["git", "init", "--quiet", workspace], stdout: "pipe", stderr: "pipe" });
    expect(userRepo.exitCode).toBe(0);
    write("a.txt", "v1\n");
    const snapshot = createTurnSnapshot({ conversationId: 1, messageId: 12, workspace });
    write("a.txt", "v2\n");
    revertToSnapshot(snapshot!.id);
    expect(read("a.txt")).toBe("v1\n");
    // 用户仓库里依旧是「未跟踪」状态，没有被我们提交过。
    const status = Bun.spawnSync({
      cmd: ["git", "-C", workspace, "status", "--porcelain"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(status.stdout.toString()).toContain("?? a.txt");
  });

  test("关掉开关后不再创建快照", () => {
    if (!hasGit) return;
    updateSettings({ AGENT_SNAPSHOTS: "0" });
    expect(snapshotsEnabled()).toBe(false);
    write("a.txt", "v1\n");
    expect(createTurnSnapshot({ conversationId: 1, messageId: 13, workspace })).toBeNull();
    updateSettings({ AGENT_SNAPSHOTS: "1", AGENT_SNAPSHOT_GC_MB: "", AGENT_SNAPSHOT_GC_TURNS: "" });
  });
});

describe("回退", () => {
  test("还原改过的文件、删掉这一轮新建的文件，排除目录不受影响", () => {
    if (!hasGit) return;
    write("a.txt", "v1\n");
    write("keep/b.txt", "keep\n");
    write("node_modules/dep.js", "dep\n");
    const snapshot = createTurnSnapshot({ conversationId: 2, messageId: 20, workspace })!;

    write("a.txt", "v2\n");
    write("created.txt", "new\n");
    write("dir/nested.txt", "nested\n");
    write("node_modules/dep.js", "changed\n");

    const preview = previewSnapshotChanges(snapshot.id);
    expect(preview.ok).toBe(true);
    expect(preview.files?.map((file) => file.path).sort()).toEqual(["a.txt", "created.txt", "dir/nested.txt"]);

    const result = revertToSnapshot(snapshot.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.restored).toEqual(["a.txt"]);
    expect(result.removed.sort()).toEqual(["created.txt", "dir/nested.txt"]);

    expect(read("a.txt")).toBe("v1\n");
    expect(read("keep/b.txt")).toBe("keep\n");
    expect(exists("created.txt")).toBe(false);
    expect(exists("dir/nested.txt")).toBe(false);
    // 排除表里的东西从未入库，回退也不该动它。
    expect(read("node_modules/dep.js")).toBe("changed\n");
  });

  test("回退到较早的一轮之后，还能回退到更近的那一轮（快照链不被 reset 打断）", () => {
    if (!hasGit) return;
    write("a.txt", "v1\n");
    const first = createTurnSnapshot({ conversationId: 3, messageId: 30, workspace })!;
    write("a.txt", "v2\n");
    const second = createTurnSnapshot({ conversationId: 3, messageId: 31, workspace })!;
    write("a.txt", "v3\n");

    expect(revertToSnapshot(first.id).ok).toBe(true);
    expect(read("a.txt")).toBe("v1\n");
    expect(revertToSnapshot(second.id).ok).toBe(true);
    expect(read("a.txt")).toBe("v2\n");
  });

  test("预览列出的就是回退会做的（含未跟踪文件）", () => {
    if (!hasGit) return;
    write("a.txt", "v1\n");
    const snapshot = createTurnSnapshot({ conversationId: 4, messageId: 40, workspace })!;
    write("a.txt", "v2\n");
    write("untracked.txt", "x\n"); // 快照之后新增、且从未进过索引
    const preview = previewSnapshotChanges(snapshot.id);
    const result = revertToSnapshot(snapshot.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const touched = [...result.restored, ...result.removed].sort();
    expect(touched).toEqual((preview.files ?? []).map((file) => file.path).sort());
    expect(touched).toEqual(["a.txt", "untracked.txt"]);
  });

  test("未知快照 / 已消失的工作区都给出明确错误（不静默成功）", () => {
    if (!hasGit) return;
    const missing = revertToSnapshot("0".repeat(40));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("快照不存在");
    expect(findSnapshot("0".repeat(40))).toBeNull();
  });

  test("索引里的工作区被改过：拒绝回退，绝不拿它去改文件系统", () => {
    if (!hasGit) return;
    write("a.txt", "v1\n");
    // 会话 id 用一个别的用例都不占的值：影子仓库按工作区隔离，但 listTurnSnapshots()
    // 是全局扫描后按会话过滤的，复用 id 会污染后面「按会话过滤」的计数。
    const snapshot = createTurnSnapshot({ conversationId: 4242, messageId: 424200, workspace })!;

    // 模拟 Agent 自己改写索引：bash 工具的沙箱默认是关的，它能改到应用数据目录里的
    // 这份 JSON。改掉 workspace 之后如果照单全收，用户一点「撤销本轮」，
    // `git add -A` + `read-tree --reset -u` 就会清掉这个"新工作区"里快照没有的所有文件。
    const victim = mkdtempSync(path.join(tmpdir(), "omni-snapshot-victim-"));
    try {
      writeFileSync(path.join(victim, "重要文件.txt"), "不能被删\n", "utf8");
      const repoDir = snapshotRepoDir(workspace);
      const indexFile = path.join(repoDir, "index.json");
      const index = JSON.parse(readFileSync(indexFile, "utf8")) as { workspace: string };
      index.workspace = victim;
      writeFileSync(indexFile, JSON.stringify(index), "utf8");

      const preview = previewSnapshotChanges(snapshot.id);
      expect(preview.ok).toBe(false);
      if (!preview.ok) expect(preview.error).toContain("不可信");

      const result = revertToSnapshot(snapshot.id);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("不可信");

      // 关键：受害目录一个字节都没被动过，原工作区也还留着。
      expect(readFileSync(path.join(victim, "重要文件.txt"), "utf8")).toBe("不能被删\n");
      expect(read("a.txt")).toBe("v1\n");
      // 指针不认这条记录：findSnapshot 只返回可信的。
      expect(findSnapshot(snapshot.id)).toBeNull();
    } finally {
      rmSync(victim, { recursive: true, force: true });
      // 把索引改回去，免得污染后面的用例（影子仓库按工作区路径复用）。
      const repoDir = snapshotRepoDir(workspace);
      const indexFile = path.join(repoDir, "index.json");
      if (existsSync(indexFile)) {
        const index = JSON.parse(readFileSync(indexFile, "utf8")) as { workspace: string };
        index.workspace = workspace;
        writeFileSync(indexFile, JSON.stringify(index), "utf8");
      }
    }
  });
});

/**
 * 仓库维护：影子仓库跟着每轮提交长，相邻两轮的文件绝大多数是同一份 ——
 * 打包（git gc）之后这些重复内容只存一次。策略是"占用超阈值或轮数到顶"时顺手整理，
 * 并且 10 分钟内不重复整理；设置页也能看到占用并手动清一次。
 */
describe("仓库维护", () => {
  test("默认阈值 256MB / 200 轮，设置项可调", () => {
    updateSettings({ AGENT_SNAPSHOT_GC_MB: "", AGENT_SNAPSHOT_GC_TURNS: "" });
    expect(snapshotGcThresholds()).toEqual({ bytes: 256 * 1024 * 1024, turns: 200 });
    updateSettings({ AGENT_SNAPSHOT_GC_MB: "8", AGENT_SNAPSHOT_GC_TURNS: "30" });
    expect(snapshotGcThresholds()).toEqual({ bytes: 8 * 1024 * 1024, turns: 30 });
    // 轮数下限 10：再小就成了每轮都打包，反而更慢。
    updateSettings({ AGENT_SNAPSHOT_GC_TURNS: "1" });
    expect(snapshotGcThresholds().turns).toBe(10);
  });

  test("没到阈值就不整理，并说明原因", () => {
    if (!hasGit) return;
    write("a.txt", "1\n");
    createTurnSnapshot({ conversationId: 11, messageId: 110, workspace });
    const result = maybeGcSnapshotRepo(workspace);
    expect(result.ran).toBe(false);
    expect(result.reason).toContain("占用");
    expect(result.freedBytes).toBe(0);
  });

  test("超过体积阈值会自动整理；整理后快照依然可以回退", () => {
    if (!hasGit) return;
    write("src/app.ts", "export const v = 1;\n");
    const first = createTurnSnapshot({ conversationId: 12, messageId: 120, workspace })!;
    for (let index = 2; index <= 6; index += 1) {
      write("src/app.ts", `export const v = ${index};\n`);
      write(`src/extra-${index}.ts`, `export const extra${index} = ${index};\n`);
      createTurnSnapshot({ conversationId: 12, messageId: 120 + index, workspace });
    }
    // 把阈值调到 0MB 触发自动整理（真实场景是 256MB）。
    updateSettings({ AGENT_SNAPSHOT_GC_MB: "0.0001" });
    const result = maybeGcSnapshotRepo(workspace);
    expect(result.ran).toBe(true);
    // 注意：**不能断言"整理后一定更小"**。仓库很小时 pack 的索引（.idx）与头部开销
    // 可能比松散对象还大，总量反而略增；gc 的收益要仓库长到一定规模才体现。
    // 这里只钉住"确实整理过"：pack 目录出现、计数是真实测量值。
    expect(existsSync(path.join(snapshotRepoDir(workspace), ".git", "objects", "pack"))).toBe(true);
    expect(result.bytesAfter).toBeGreaterThan(0);
    expect(result.freedBytes).toBe(Math.max(0, result.bytesBefore - result.bytesAfter));

    // 历史没被丢掉 —— 这是维护最要紧的性质。
    const revert = revertToSnapshot(first.id);
    expect(revert.ok).toBe(true);
    expect(read("src/app.ts")).toBe("export const v = 1;\n");
    expect(exists("src/extra-6.ts")).toBe(false);
  });

  test("整理有节流：刚整理过就不再整理（force 可跳过）", () => {
    if (!hasGit) return;
    write("a.txt", "1\n");
    createTurnSnapshot({ conversationId: 13, messageId: 130, workspace });
    const forced = maybeGcSnapshotRepo(workspace, { force: true });
    expect(forced.ran).toBe(true);
    const again = maybeGcSnapshotRepo(workspace, { force: true });
    expect(again.ran).toBe(true); // force 无视节流与阈值
    const throttled = maybeGcSnapshotRepo(workspace);
    expect(throttled.ran).toBe(false);
    expect(throttled.reason).toContain("10 分钟");
  });

  test("没有影子仓库时给出可读原因（而不是报错）", () => {
    if (!hasGit) return;
    const result = maybeGcSnapshotRepo(path.join(workspace, "never-used"));
    expect(result.ran).toBe(false);
    expect(result.reason).toContain("还没有影子仓库");
  });
});

describe("索引", () => {
  test("按会话过滤，标签按会话内的轮次递增", () => {
    if (!hasGit) return;
    write("a.txt", "1\n");
    createTurnSnapshot({ conversationId: 5, messageId: 50, workspace });
    write("a.txt", "2\n");
    createTurnSnapshot({ conversationId: 5, messageId: 51, workspace });
    createTurnSnapshot({ conversationId: 6, messageId: 60, workspace });

    const mine = listTurnSnapshots(5);
    expect(mine).toHaveLength(2);
    expect(mine.map((snapshot) => snapshot.label)).toEqual(["第 2 轮", "第 1 轮"]);
    expect(mine.every((snapshot) => snapshot.conversationId === 5)).toBe(true);
    expect(listTurnSnapshots(6)).toHaveLength(1);
    expect(listTurnSnapshots(6)[0]!.label).toBe("第 1 轮");
  });

  test("快照记录了消息 id（界面据此把「撤销本轮」挂在对应消息上）", () => {
    if (!hasGit) return;
    write("a.txt", "1\n");
    const snapshot = createTurnSnapshot({ conversationId: 7, messageId: 71, workspace });
    expect(snapshot!.messageId).toBe(71);
    expect(findSnapshot(snapshot!.id)?.snapshot.conversationId).toBe(7);
  });

  test("状态摘要给出开关、git 可用性与轮数", () => {
    if (!hasGit) return;
    write("a.txt", "1\n");
    createTurnSnapshot({ conversationId: 8, messageId: 80, workspace });
    const status = snapshotStatus(workspace);
    expect(status.enabled).toBe(true);
    expect(status.gitAvailable).toBe(true);
    expect(status.turns).toBe(1);
  });

  test("占用统计：给出影子仓库字节数、轮数与上次维护时间", () => {
    if (!hasGit) return;
    write("a.txt", "1\n");
    write("b.txt", "2\n");
    createTurnSnapshot({ conversationId: 10, messageId: 100, workspace });
    const usage = snapshotRepoUsage(workspace);
    expect(usage).not.toBeNull();
    expect(usage!.turns).toBe(1);
    expect(usage!.bytes).toBeGreaterThan(0);
    expect(usage!.repoDir).toContain("agent-snapshots");
    expect(usage!.lastSnapshotAt).toBeGreaterThan(0);
    expect(usage!.truncated).toBe(false);
    // 没建过仓库的工作区：明确返回 null，而不是编一个 0 出来。
    expect(snapshotRepoUsage(path.join(workspace, "nope"))).toBeNull();
  });

  test("内容相同、同一秒创建的快照也不会撞 id（撞了就会回退到别人的工作区）", () => {
    if (!hasGit) return;
    // 两个工作区、同一份内容、同一个会话/消息号：git 默认会算出同一个 commit sha，
    // 而 sha 是回退时的定位键 —— 提交信息里必须带上足够的唯一信息。
    const other = mkdtempSync(path.join(tmpdir(), "omni-snapshot-ws-"));
    try {
      write("a.txt", "same\n");
      writeFileSync(path.join(other, "a.txt"), "same\n");
      const mine = createTurnSnapshot({ conversationId: 9, messageId: 90, workspace })!;
      const theirs = createTurnSnapshot({ conversationId: 9, messageId: 90, workspace: other })!;
      expect(mine.id).not.toBe(theirs.id);
      expect(findSnapshot(mine.id)?.snapshot.messageId).toBe(90);
      expect(previewSnapshotChanges(mine.id).workspace).toBe(path.resolve(workspace));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
