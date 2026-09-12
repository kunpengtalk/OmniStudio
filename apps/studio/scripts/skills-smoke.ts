// Skills 域冒烟测试：隔离环境（临时 DB）跑核心链路。
// 用法：OMNI_DATA_DIR=/tmp/omni-skills-test bun run scripts/skills-smoke.ts
import {
  initSkills,
  listSkills,
  shutdownSkills,
  getCentralRepoDir,
  getCentralInfoForRpc,
  syncSkillToTool,
  unsyncSkillFromTool,
  listToolInfos,
  backupInit,
  backupCommit,
  backupStatus,
  createSnapshot,
  listSnapshots,
  fetchLeaderboard,
  checkSkillUpdate,
} from "../src/bun/skills";
import { parseSkillMd, hashSkillDir, isSkillDir } from "../src/bun/skills/metadata";
import { readdirSync, existsSync, readlinkSync, lstatSync, rmSync } from "fs";
import { join } from "path";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}
let step = 0;
const ok = (msg: string) => console.log(`[${++step}] OK ${msg}`);

// 1. 初始化（建目录 + 收编 ~/.agents/skills 已有技能）
initSkills();
ok(`initSkills, central=${getCentralRepoDir()}`);

// 2. 解析真实 SKILL.md
const central = getCentralRepoDir();
const first = readdirSync(central, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith("."))
  .map((e) => join(central, e.name))
  .find((d) => isSkillDir(d))!;
const meta = parseSkillMd(first);
assert(meta.name || meta.description !== undefined, `parseSkillMd on ${first}`);
ok(`parseSkillMd ${first.split("/").pop()} -> name=${meta.name?.slice(0, 40)}`);

// 3. 哈希稳定
const h1 = hashSkillDir(first);
const h2 = hashSkillDir(first);
assert(h1 === h2 && h1.length === 64, "hashSkillDir stable");
ok("hashSkillDir stable");

// 4. 收编：listSkills 应包含大量磁盘技能
const skills = listSkills();
assert(skills.length > 50, `listSkills got ${skills.length}`);
const sample = skills[0]!;
console.log(`    e.g. ${sample.id} / ${sample.name} / targets=${sample.targets.length}`);
ok(`listSkills ${skills.length} skills`);

// 5. 工具检测
const tools = listToolInfos();
const centralTools = tools.filter((t) => t.isCentral);
const installed = tools.filter((t) => t.installed);
assert(tools.length >= 50, `tools ${tools.length}`);
assert(centralTools.some((t) => t.key === "cline"), "cline is central-rooted");
console.log(`    installed=${installed.length} central-rooted=${centralTools.map((t) => t.key).join(",")}`);
ok(`listToolInfos ${tools.length} tools`);

// 6. symlink 同步 → cursor（真实目录）
const testSkill = skills.find((s) => !s.sourceRef)?.id ?? sample.id;
const cursorDir = join(process.env.HOME!, ".cursor/skills", testSkill);
// 清掉可能的残留
if (existsSync(cursorDir) && lstatSync(cursorDir).isSymbolicLink()) rmSync(cursorDir);
const syncRes = syncSkillToTool(testSkill, "cursor");
assert(syncRes.ok, `syncSkillToTool: ${JSON.stringify(syncRes)}`);
assert(existsSync(cursorDir), "cursor target exists");
const link = readlinkSync(cursorDir);
assert(link === join(central, testSkill), `link -> ${link}`);
ok(`symlink ${testSkill} -> ~/.cursor/skills/${testSkill}`);
// 同步后 listSkills 应显示 synced
const after = listSkills().find((s) => s.id === testSkill);
assert(after?.targets.some((t) => t.tool === "cursor" && t.status === "synced"), "status synced");
ok("sync status = synced");
// 卸载
const unsyncRes = unsyncSkillFromTool(testSkill, "cursor");
assert(unsyncRes.ok, `unsync: ${JSON.stringify(unsyncRes)}`);
assert(!existsSync(cursorDir), "cursor target removed");
ok("unsync removes target");

// 7. git 备份：init + commit + snapshot
const initRes = backupInit();
assert(initRes.ok, `backupInit: ${initRes.error}`);
const commitRes = backupCommit("smoke test");
assert(commitRes.ok, `backupCommit: ${commitRes.error}`);
const st = backupStatus();
assert(st.initialized && !st.dirty, `status ${JSON.stringify(st)}`);
const snap = createSnapshot("smoke");
assert(snap.ok && snap.tag, `snapshot: ${JSON.stringify(snap)}`);
const snaps = listSnapshots();
assert(snaps.some((s) => s.tag === snap.tag), "snapshot listed");
ok(`git backup init/commit/snapshot ${snap.tag}`);

// 8. 市场 API（网络）
try {
  const board = await fetchLeaderboard("alltime");
  assert(board.length > 0, "leaderboard empty");
  console.log(`    top: ${board.slice(0, 3).map((s) => `${s.source}/${s.skillId}`).join(" | ")}`);
  ok(`skills.sh leaderboard ${board.length} items`);
  // 更新检查（拿第一项当样例，ls-remote）
  const upd = await checkSkillUpdate(skills.find((s) => s.sourceType === "scan")!.id);
  console.log(`    update check (scan source): ${upd.status}`);
} catch (e) {
  console.log(`[!] 网络/skills.sh 不可达（跳过）: ${String(e).slice(0, 120)}`);
}

// 9. 中央库信息
const info = getCentralInfoForRpc();
assert(info.skillCount > 50, `central info ${info.skillCount}`);
console.log(`    dir=${info.dir} size=${(info.sizeBytes / 1e6).toFixed(1)}MB warnings=${info.warnings.join(",") || "-"}`);
ok(`central info ${info.skillCount} skills`);

shutdownSkills();
console.log("\nALL SMOKE TESTS PASSED");
process.exit(0);
