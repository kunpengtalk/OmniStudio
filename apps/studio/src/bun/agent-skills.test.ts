/**
 * Skills 接入 Agent 的单测：只钉住"不能越界"的那几条 ——
 * 读技能文件这条路径通向文件系统，`../..` 与不存在的技能都必须被挡住，
 * 而不是抛异常或者读到技能目录之外的东西。
 */
import { describe, expect, test } from "bun:test";

import { readSkillFile } from "./agent-skills";

describe("readSkillFile", () => {
  test("非法技能名（试图越界）被拒绝", () => {
    for (const name of ["../../etc", "..", "/etc/passwd", "a/b", ""]) {
      const result = readSkillFile(name);
      expect(result.ok).toBe(false);
    }
  });

  test("没装过的技能给出可读原因，而不是抛错", () => {
    const result = readSkillFile("definitely-not-installed-skill-xyz");
    expect(result.ok).toBe(false);
    // 设置层没起来时也会走到这里：无论哪种情况都要给一句能读懂的原因，且不能抛异常
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
  });

  test("技能内的路径试图越界时被拒绝（哪怕技能本身不存在也不能放行）", () => {
    const result = readSkillFile("definitely-not-installed-skill-xyz", "../../../etc/passwd");
    expect(result.ok).toBe(false);
  });
});
