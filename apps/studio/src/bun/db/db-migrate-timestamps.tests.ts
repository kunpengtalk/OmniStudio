/**
 * 迁移时间戳自愈回归测试（真测试体，由 db-migrate-timestamps.test.ts 子进程隔离跑）。
 *
 * 线上故障复现：0029 之前的 journal `when` 全是伪造的**未来**时间戳（递增整数序列，
 * 最大 ≈2026-09-22），而 drizzle 迁移器判断「是否需要应用」只比较 `已应用行的最大
 * created_at < 待应用迁移的 when`，从不校验 hash —— 0029 用真实时间戳（≈2026-09-14）
 * 生成后小于库里的伪造值，每次启动都被判定「已应用过」而静默跳过，embed_image 等六列
 * 永远建不出，新建知识库 INSERT 报 no such column、界面点击无响应。
 *
 * 测试动线：全新库应用全部迁移 → 人工把库摆回「中毒」状态（六列撤掉 + 0029 记录删除
 * + 已应用行时间戳改回伪造值）→ 再起一个子进程加载 ./db（= 应用重启：自愈 + 迁移）
 * → 断言六列建回、0029 已记录、已应用行时间戳归真。
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
/** 0029 的真实生成时间戳（journal 保留未动，也是全序列最大值）。 */
const CORRECTED_0029_WHEN = 1789399122175;
/** 伪造时代的 0028 when（未来时间戳，正是它把 0029 挡在门外）。 */
const OLD_FAKE_0028_WHEN = 1790095000002;

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

describe("迁移时间戳自愈", () => {
  test("journal 时间戳严格递增，且全序列最大值就是 0029 的真实时间戳（伪造未来值已清零）", () => {
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: { when: number }[];
    };
    const whens = journal.entries.map((e) => e.when);
    expect(whens.length).toBe(30);
    for (let i = 1; i < whens.length; i++) {
      expect(whens[i]!).toBeGreaterThan(whens[i - 1]!);
    }
    // 任何 when 都不得超过 0029 的真实生成时间 —— 否则下一条真实时间戳的新迁移又会
    // 被静默跳过（这正是本次故障的成因）。
    expect(Math.max(...whens)).toBe(CORRECTED_0029_WHEN);
  });

  test("中毒库重启后自愈：六列建回、0029 已应用、已应用行时间戳归真", () => {
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
    // ① 0029 的六列不存在；② 0029 无应用记录；③ 已应用行 created_at 是伪造未来值。
    const poison = new Database(dbPath);
    poison.exec("ALTER TABLE knowledge_bases DROP COLUMN embed_image");
    poison.exec("ALTER TABLE knowledge_bases DROP COLUMN embed_audio");
    poison.exec("ALTER TABLE knowledge_bases DROP COLUMN embed_video");
    poison.exec("ALTER TABLE knowledge_chunks DROP COLUMN modality");
    poison.exec("ALTER TABLE knowledge_chunks DROP COLUMN media_path");
    poison.exec("ALTER TABLE knowledge_chunks DROP COLUMN media_index");
    poison.run("DELETE FROM __drizzle_migrations WHERE created_at = ?", [CORRECTED_0029_WHEN]);
    poison.run("UPDATE __drizzle_migrations SET created_at = ? WHERE created_at = ?", [
      OLD_FAKE_0028_WHEN,
      CORRECTED_0028_WHEN,
    ]);
    poison.close();

    // 第二次「启动」：自愈必须先把 0028 行时间戳归真，迁移器才会应用 0029
    const second = relaunchApp(dbPath, dataDir);
    if (second.exitCode !== 0) console.error(second.output);
    expect(second.exitCode).toBe(0);

    const healed = new Database(dbPath);
    expect(columnsOf(healed, "knowledge_bases")).toContain("embed_image");
    expect(columnsOf(healed, "knowledge_chunks")).toContain("modality");
    const rows = healed
      .query("SELECT created_at FROM __drizzle_migrations ORDER BY created_at")
      .all() as { created_at: number }[];
    expect(rows.length).toBe(30);
    // 0029 已应用，且成为全序列最大 created_at（后续真实时间戳的新迁移不会再被挡）
    expect(rows[rows.length - 1]!.created_at).toBe(CORRECTED_0029_WHEN);
    // 伪造未来值已清除
    expect(rows.every((r) => Number(r.created_at) <= CORRECTED_0029_WHEN)).toBe(true);
    healed.close();
  });
});
