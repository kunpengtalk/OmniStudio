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
 * 本轮合并（模型下载批次）：main 侧带来 0037_tired_vanisher（多模态六列），我们的三条
 * 音乐迁移撞号 0037 —— 同构收敛：main 的六列保留 0037，音乐三条顺延 0038/0039/0040、
 * SQL 字节不动（hash 稳定）、when 取引入提交毫秒。由此多出一条真实故障路径：音乐迁移
 * 按伪造时间戳应用过的库（本机 canary）归真后，库内最大值高于六列迁移的 when，drizzle
 * 读一次最大值就再也够不着它 —— 第四条用例钉住 `repairUnreachableMigrations()`。
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
 * 0037_tired_vanisher（多模态六列）的 when：上一轮合并时 = 归真后 0036 的 when + 1，
 * 当时是全序列最大值（原始生成时间 1789399122175 夹在 0031 与 0032 之间，重编号到末位
 * 后必须抬到 0036 之上，journal 才能严格递增）。
 */
const CORRECTED_TIRED_WHEN = 1789471307003;
/**
 * 本次合并的三条音乐迁移（音乐歌单 → 歌词 LRC → 封面路径）顺延到 main 的 0037 之后，
 * when 取引入提交的毫秒时间 +0/+1/+2，其中末条 0040 是新的全序列最大值。
 * 三条都排在多模态六列迁移之后，于是本机 canary 库（音乐迁移按伪造时间戳应用过）
 * 的库内最大值高于六列迁移的 when —— 正是 `repairUnreachableMigrations()` 要补的那类。
 */
const CORRECTED_MUSIC_0038_WHEN = 1789530817000;
const CORRECTED_MUSIC_0039_WHEN = 1789530817001;
const CORRECTED_MUSIC_0040_WHEN = 1789530817002;
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
/** 伪造时代的三条音乐迁移（本机 canary 库里的样子）。 */
const OLD_FAKE_MUSIC_0038_WHEN = 1790095000011;
const OLD_FAKE_MUSIC_0039_WHEN = 1790095000012;
const OLD_FAKE_MUSIC_0040_WHEN = 1790095000013;

/** 子进程加载 ./db（模拟应用重启），失败时把输出带进断言信息便于诊断。 */
function relaunchApp(
  dbPath: string,
  dataDir: string,
  extraEnv: Record<string, string> = {},
): { exitCode: number; output: string } {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, "run", reimport, dbPath],
    env: { ...process.env, OMNI_DB_PATH: dbPath, OMNI_DATA_DIR: dataDir, ...extraEnv },
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

/** journal 的 when 全序列（供"最新应用行 = 最新迁移"这类断言取末条值）。 */
function journalWhens(): number[] {
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { when: number }[];
  };
  return journal.entries.map((e) => e.when);
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
  test("journal 时间戳严格递增，且全序列最大值就是末条 0040 的归真时间戳（伪造未来值已清零）", () => {
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: { when: number }[];
    };
    const whens = journal.entries.map((e) => e.when);
    expect(whens.length).toBe(42);
    for (let i = 1; i < whens.length; i++) {
      expect(whens[i]!).toBeGreaterThan(whens[i - 1]!);
    }
    // 任何 when 都不得超过末条的归真值 —— 否则下一条真实时间戳的新迁移又会
    // 被静默跳过（这正是本次故障的成因）。末条现在是画布的 0041，
    // drizzle-kit 生成时取当前时间，天然大于音乐 0040 的归真值。
    expect(Math.max(...whens)).toBe(whens[whens.length - 1]!);
    expect(whens[whens.length - 1]!).toBeGreaterThan(CORRECTED_MUSIC_0040_WHEN);
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
    expect(rows.length).toBe(42);
    // 0037 的记录被补了回来（它的 when 已不是全序列最大值，drizzle 自己够不着它，
    // 靠 repairUnreachableMigrations 补跑并记账）
    expect(rows).toContain(CORRECTED_TIRED_WHEN);
    // 最新应用行现在是画布 0041（journal 末条），音乐 0040 是倒数第二条。
    expect(rows[rows.length - 1]!).toBe(Math.max(...journalWhens()));
    expect(rows).toContain(CORRECTED_MUSIC_0040_WHEN);
    // 伪造未来值已清除（全部行不超过 journal 末条的 when）
    expect(rows.every((v) => v <= Math.max(...journalWhens()))).toBe(true);
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
    expect(rows.length).toBe(42);
    // 最新应用行是画布 0041（journal 末条）；全部行都 ≤ 它（伪造的未来时间戳已归真）。
    expect(rows[rows.length - 1]!).toBe(Math.max(...journalWhens()));
    expect(rows.every((v) => v <= Math.max(...journalWhens()))).toBe(true);
    healed.close();
  });

  test("本机 canary 库（音乐迁移按伪造时间戳应用过、多模态缺失）升级：六列迁移不再被静默跳过", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "db-ts-canary-"));
    const dbPath = join(dataDir, "canary.db");

    const first = relaunchApp(dbPath, dataDir);
    if (first.exitCode !== 0) console.error(first.output);
    expect(first.exitCode).toBe(0);

    // 摆回本机 canary 库的样子：六列缺失、0037 无记录、0028-0036 与三条音乐迁移
    // 都记着伪造的**未来**时间戳（音乐迁移的 SQL 字节没动过，归真后按 hash 落到
    // 0038/0039/0040 的 when 上）。归真到这里，库内最大值 = 1789530817002，而六列
    // 迁移的 when 是 1789471307003 —— drizzle 只读一次最大值，自己永远不会再应用它。
    const poison = new Database(dbPath);
    stripMultimodal(poison);
    const fakeRows: [number, number][] = [
      [OLD_FAKE_0028_WHEN, CORRECTED_0028_WHEN],
      [OLD_FAKE_0029_WHEN, CORRECTED_0029_WHEN],
      [OLD_FAKE_0029_WHEN + 1, CORRECTED_0030_WHEN],
      [OLD_FAKE_0031_WHEN, CORRECTED_0031_WHEN],
      [OLD_FAKE_0031_WHEN + 1, CORRECTED_0032_WHEN],
      [OLD_FAKE_0031_WHEN + 2, CORRECTED_0033_WHEN],
      [OLD_FAKE_0031_WHEN + 3, CORRECTED_0034_WHEN],
      [OLD_FAKE_0031_WHEN + 4, CORRECTED_0035_WHEN],
      [OLD_FAKE_0036_WHEN, CORRECTED_0036_WHEN],
      [OLD_FAKE_MUSIC_0038_WHEN, CORRECTED_MUSIC_0038_WHEN],
      [OLD_FAKE_MUSIC_0039_WHEN, CORRECTED_MUSIC_0039_WHEN],
      [OLD_FAKE_MUSIC_0040_WHEN, CORRECTED_MUSIC_0040_WHEN],
    ];
    for (const [fake, corrected] of fakeRows) {
      poison.run("UPDATE __drizzle_migrations SET created_at = ? WHERE created_at = ?", [
        fake,
        corrected,
      ]);
    }
    poison.close();

    const second = relaunchApp(dbPath, dataDir);
    if (second.exitCode !== 0) console.error(second.output);
    expect(second.exitCode).toBe(0);

    const healed = new Database(dbPath);
    // 六列回来了 —— 这是补跑的证据（bug 状态是它们永远建不出来）
    expect(columnsOf(healed, "knowledge_bases")).toContain("embed_image");
    expect(columnsOf(healed, "knowledge_chunks")).toContain("media_index");
    // 音乐迁移没有被重复执行（重复 CREATE TABLE 会让迁移抛错、进程非 0 退出）
    expect(
      healed.query("SELECT name FROM sqlite_master WHERE type='table' AND name='music_playlists'").get(),
    ).not.toBeNull();
    const rows = createdAts(healed);
    expect(rows.length).toBe(42);
    expect(rows).toContain(CORRECTED_TIRED_WHEN);
    // 画布 0041（journal 末条）之后没有更多应用行 —— 伪造的未来时间戳已归真。
    expect(rows.every((v) => v <= Math.max(...journalWhens()))).toBe(true);
    healed.close();
  });

  /**
   * 只读进程（`omi` 的本地兜底）必须**原样离开**这份库。
   *
   * 这一条钉的是线上事故的另一半：同一个库会被安装版和仓库里的源码分别打开，两份构建的
   * journal 时间戳不一致，于是"谁跑一次迁移，另一方下次启动就重跑建表并崩在 table
   * already exists"（用户看到的"更新完 / 跑过 omi 之后再也打不开"）。
   * `src/cli/db.ts` 现在用 OMNI_SKIP_MIGRATIONS=1 打开，这里就钉住它的语义：
   * 不补迁移、不改时间戳，也不因为"库是中毒状态"而报错退出。
   */
  test("只读进程（OMNI_SKIP_MIGRATIONS=1）不迁移、不自愈，也不因中毒库而失败", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "db-ts-readonly-"));
    const dbPath = join(dataDir, "readonly.db");

    const first = relaunchApp(dbPath, dataDir);
    if (first.exitCode !== 0) console.error(first.output);
    expect(first.exitCode).toBe(0);

    // 摆回中毒状态：六列撤掉、0028 换回伪造的未来时间戳
    const poison = new Database(dbPath);
    stripMultimodal(poison);
    poison.run("UPDATE __drizzle_migrations SET created_at = ? WHERE created_at = ?", [
      CORRECTED_0028_WHEN,
      OLD_FAKE_0028_WHEN,
    ]);
    const beforeRows = createdAts(poison);
    const beforeHasEmbed = columnsOf(poison, "knowledge_bases").includes("embed_image");
    poison.close();

    const readonly = relaunchApp(dbPath, dataDir, { OMNI_SKIP_MIGRATIONS: "1" });
    if (readonly.exitCode !== 0) console.error(readonly.output);
    expect(readonly.exitCode).toBe(0);

    const after = new Database(dbPath);
    // 时间戳一个都没动（自愈没跑）
    expect(createdAts(after)).toEqual(beforeRows);
    // 迁移也没跑：六列仍然是缺的
    expect(columnsOf(after, "knowledge_bases").includes("embed_image")).toBe(beforeHasEmbed);
    expect(columnsOf(after, "knowledge_bases")).not.toContain("embed_image");
    after.close();
  });
});
