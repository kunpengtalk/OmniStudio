/**
 * 迁移时间戳自愈回归测试（真测试体，由 db-migrate-timestamps.test.ts 子进程隔离跑）。
 *
 * 线上故障复现：多模态六列迁移（现编号 0037_tired_vanisher，合并 main 前是 0029）
 * 之前的 journal `when` 全是伪造的**未来**时间戳（递增整数序列，最大 ≈2026-09-22），
 * 而 drizzle 迁移器判断「是否需要应用」只比较 `已应用行的最大 created_at < 待应用迁移
 * 的 when`，从不校验 hash —— 真实时间戳的新迁移小于库里的伪造值，每次启动都被判定
 * 「已应用过」而静默跳过，embed_image 等六列永远建不出，新建知识库 INSERT 报
 * no such column、界面点击无响应。
 *
 * 本轮合并（v0.1.0）：main 侧又带来五条伪造时间戳的 0032-0036，与我们的 0032 撞号。
 * 收敛方式与上轮同构：main 的五条保留编号、when 归真为各自引入提交的毫秒时间；
 * 我们的迁移重编号 0037、SQL 字节不动（hash 稳定，自愈按 hash 对得上）、when 取
 * 0036+1 —— 仍是全序列最大值。
 *
 * 测试动线：全新库应用全部迁移 → 人工把库摆回「中毒」状态（六列撤掉 + 0037 记录删除
 * + 已应用行时间戳改回伪造值）→ 再起一个子进程加载 ./db（= 应用重启：自愈 + 迁移）
 * → 断言六列建回、0037 已记录、已应用行时间戳归真。
 *
 * 第三条用例走的是另一批真实库：main 的 0.1.0（0029-0036 用伪造未来时间戳应用）升到
 * 合并版 —— 这批库的六列同样缺失，且 0029-0036 已经应用过。自愈把它们的 created_at
 * 拉回真实值后，末位的 0037 才会被应用，同时 0029-0036 绝不能被重复执行
 * （重复 ADD COLUMN / CREATE TABLE 会抛错，子进程退出码非 0 即红）。
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const reimport = join(import.meta.dir, "db-reimport.ts");
const journalPath = join(import.meta.dir, "migrations", "meta", "_journal.json");
/** 0028 归真后的 when（git 提交毫秒 + 1，见 _journal.json 修订说明）。 */
const CORRECTED_0028_WHEN = 1789285860001;
/**
 * 末条（0037_tired_vanisher，多模态六列）的 when：本轮合并后 = 归真后 0036 的 when + 1，
 * 仍是全序列最大值（原始生成时间 1789399122175 夹在 0031 与 0032 之间，重编号到末位
 * 后必须抬到 0036 之上，journal 才能严格递增）。
 */
const CORRECTED_TIRED_WHEN = 1789471307003;
/** main 侧 0029-0036 归真后的 when（0029/0030 同提交 +0/+1；32/33 各自提交；34-36 同提交 +0/+1/+2）。 */
const CORRECTED_0029_WHEN = 1789366986000;
const CORRECTED_0030_WHEN = 1789366986001;
const CORRECTED_0031_WHEN = 1789387663000;
const CORRECTED_0032_WHEN = 1789433336000;
const CORRECTED_0033_WHEN = 1789436647000;
const CORRECTED_0034_WHEN = 1789471307000;
const CORRECTED_0035_WHEN = 1789471307001;
const CORRECTED_0036_WHEN = 1789471307002;
/** 伪造时代的 0028 when（未来时间戳，正是它把新迁移挡在门外）。 */
const OLD_FAKE_0028_WHEN = 1790095000002;
/** 伪造时代 main 的 0029-0036（0.0.9-canary.0 / 0.1.0 用户库里的样子）。 */
const OLD_FAKE_0029_WHEN = 1790095000003;
const OLD_FAKE_0031_WHEN = 1790095000005;
const OLD_FAKE_0036_WHEN = 1790095000010;

/** 子进程加载 ./db（模拟应用重启），失败时把输出带进断言信息便于诊断。 */
function relaunchApp(dbPath: string, dataDir: string): { exitCode: number; output: string } {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, "run", reimport, dbPath],
    env: { ...process.env, OMNI_DB_PATH: dbPath, OMNI_DATA_DIR: dataDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, output: `${proc.stdout}${proc.stderr}` };
}

function columnsOf(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

function createdAts(db: Database): number[] {
  return (
    db.query("SELECT created_at FROM __drizzle_migrations ORDER BY created_at").all() as {
      created_at: number;
    }[]
  ).map((r) => Number(r.created_at));
}

/** 撤掉多模态六列 + 删除 0037 的应用记录（两批库共同的中毒面）。 */
function stripMultimodal(db: Database): void {
  for (const col of ["embed_image", "embed_audio", "embed_video"]) {
    db.exec(`ALTER TABLE knowledge_bases DROP COLUMN ${col}`);
  }
  for (const col of ["modality", "media_path", "media_index"]) {
    db.exec(`ALTER TABLE knowledge_chunks DROP COLUMN ${col}`);
  }
  db.run("DELETE FROM __drizzle_migrations WHERE created_at = ?", [CORRECTED_TIRED_WHEN]);
}

describe("迁移时间戳自愈", () => {
  test("journal 时间戳严格递增，且全序列最大值就是末条 0037 的归真时间戳（伪造未来值已清零）", () => {
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: { when: number }[];
    };
    const whens = journal.entries.map((e) => e.when);
    expect(whens.length).toBe(38);
    for (let i = 1; i < whens.length; i++) {
      expect(whens[i]!).toBeGreaterThan(whens[i - 1]!);
    }
    // 任何 when 都不得超过末条的归真值 —— 否则下一条真实时间戳的新迁移又会
    // 被静默跳过（这正是本次故障的成因）。
    expect(Math.max(...whens)).toBe(CORRECTED_TIRED_WHEN);
  });

  test("中毒库重启后自愈：六列建回、0037 已应用、已应用行时间戳归真", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "db-ts-heal-"));
    const dbPath = join(dataDir, "heal.db");

    // 第一次「启动」：全新库顺序应用全部迁移
    const first = relaunchApp(dbPath, dataDir);
    if (first.exitCode !== 0) console.error(first.output);
    expect(first.exitCode).toBe(0);

    const baseline = new Database(dbPath);
    expect(columnsOf(baseline, "knowledge_bases")).toContain("embed_image");
    baseline.close();

    // 摆回中毒状态（对齐真实用户库当时的样子）：
    // ① 六列不存在；② 0037 无应用记录；③ 已应用行 created_at 是伪造未来值。
    const poison = new Database(dbPath);
    stripMultimodal(poison);
    poison.run("UPDATE __drizzle_migrations SET created_at = ? WHERE created_at = ?", [
      OLD_FAKE_0028_WHEN,
      CORRECTED_0028_WHEN,
    ]);
    poison.close();

    // 第二次「启动」：自愈必须先把 0028 行时间戳归真，迁移器才会应用 0037
    const second = relaunchApp(dbPath, dataDir);
    if (second.exitCode !== 0) console.error(second.output);
    expect(second.exitCode).toBe(0);

    const healed = new Database(dbPath);
    expect(columnsOf(healed, "knowledge_bases")).toContain("embed_image");
    expect(columnsOf(healed, "knowledge_chunks")).toContain("modality");
    const rows = createdAts(healed);
    expect(rows.length).toBe(38);
    // 0037 已应用，且成为全序列最大 created_at（后续真实时间戳的新迁移不会再被挡）
    expect(rows[rows.length - 1]!).toBe(CORRECTED_TIRED_WHEN);
    // 伪造未来值已清除
    expect(rows.every((v) => v <= CORRECTED_TIRED_WHEN)).toBe(true);
    healed.close();
  });

  test("发布库（main 的 0.1.0，0029-0036 按伪造时间戳应用过）升级：先归真再补 0037，且不重复执行 0029-0036", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "db-ts-released-"));
    const dbPath = join(dataDir, "released.db");

    const first = relaunchApp(dbPath, dataDir);
    if (first.exitCode !== 0) console.error(first.output);
    expect(first.exitCode).toBe(0);

    // 摆回 0.1.0 的真实形态：六列缺失、0029-0036 已应用（伪造未来时间戳）、
    // 库里最大 created_at 就是伪造值 —— 合并版末位的 0037 归真 when 比它小，
    // 不做自愈就会被判定「已应用过」而永远跳过。
    const released = new Database(dbPath);
    stripMultimodal(released);
    const fakeRows: [number, number][] = [
      // [伪造 when, 归真 when]：0028 起逐条摆回 main 侧发布库里的样子
      [OLD_FAKE_0028_WHEN, CORRECTED_0028_WHEN],
      [OLD_FAKE_0029_WHEN, CORRECTED_0029_WHEN],
      [OLD_FAKE_0029_WHEN + 1, CORRECTED_0030_WHEN],
      [OLD_FAKE_0031_WHEN, CORRECTED_0031_WHEN],
      [OLD_FAKE_0031_WHEN + 1, CORRECTED_0032_WHEN],
      [OLD_FAKE_0031_WHEN + 2, CORRECTED_0033_WHEN],
      [OLD_FAKE_0031_WHEN + 3, CORRECTED_0034_WHEN],
      [OLD_FAKE_0031_WHEN + 4, CORRECTED_0035_WHEN],
      [OLD_FAKE_0036_WHEN, CORRECTED_0036_WHEN],
    ];
    for (const [fake, corrected] of fakeRows) {
      released.run("UPDATE __drizzle_migrations SET created_at = ? WHERE created_at = ?", [
        fake,
        corrected,
      ]);
    }
    released.close();

    const upgraded = relaunchApp(dbPath, dataDir);
    // 退出码 0 同时证明两件事：0037 被应用（六列建回），且 0029-0036 没有被重复执行
    // （重复 ADD COLUMN / CREATE TABLE 会让迁移抛错、进程非 0 退出）。
    if (upgraded.exitCode !== 0) console.error(upgraded.output);
    expect(upgraded.exitCode).toBe(0);

    const healed = new Database(dbPath);
    expect(columnsOf(healed, "knowledge_bases")).toContain("embed_image");
    expect(columnsOf(healed, "knowledge_chunks")).toContain("media_index");
    // main 侧 v0.1.0 的新表在升级库里原样保留（0034-0036 已按伪造时间戳应用过）
    expect(
      healed.query("SELECT name FROM sqlite_master WHERE type='table' AND name='music_records'").get(),
    ).not.toBeNull();
    expect(
      healed.query("SELECT name FROM sqlite_master WHERE type='table' AND name='miniapp_notes'").get(),
    ).not.toBeNull();
    expect(
      healed.query("SELECT name FROM sqlite_master WHERE type='table' AND name='usage_records'").get(),
    ).not.toBeNull();
    const rows = createdAts(healed);
    expect(rows.length).toBe(38);
    expect(rows[rows.length - 1]!).toBe(CORRECTED_TIRED_WHEN);
    expect(rows.every((v) => v <= CORRECTED_TIRED_WHEN)).toBe(true);
    healed.close();
  });
});
