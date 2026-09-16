import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { containsLikePattern, escapeLikePattern } from "./sql-like";

describe("LIKE 模式转义", () => {
  test("通配符被转义成字面量", () => {
    expect(escapeLikePattern("100%")).toBe("100\\%");
    expect(escapeLikePattern("a_b")).toBe("a\\_b");
    expect(escapeLikePattern("C:\\path")).toBe("C:\\\\path");
    expect(containsLikePattern("100%")).toBe("%100\\%%");
  });

  test("普通文本原样（不留多余转义）", () => {
    expect(escapeLikePattern("赛博朋克 猫")).toBe("赛博朋克 猫");
    expect(containsLikePattern("cat")).toBe("%cat%");
  });
});

describe("在真实 SQLite 上验证（转义只有配上 ESCAPE 才生效）", () => {
  const db = new Database(":memory:");
  db.run("create table t (name text)");
  db.run("insert into t (name) values ('100%'), ('1000'), ('a_b'), ('axb'), ('plain')");

  const search = (raw: string) =>
    (
      db
        .query("select name from t where name like ? escape '\\' order by name")
        .all(containsLikePattern(raw)) as { name: string }[]
    ).map((r) => r.name);

  test("搜 % 只命中真的带百分号的那条", () => {
    expect(search("100%")).toEqual(["100%"]);
  });

  test("搜 _ 只命中真的带下划线的那条", () => {
    expect(search("a_b")).toEqual(["a_b"]);
  });

  test("普通关键词照常模糊匹配", () => {
    expect(search("100")).toEqual(["100%", "1000"]);
    expect(search("ai")).toEqual(["plain"]);
    expect(search("zzz")).toEqual([]);
  });

  test("不转义时会命中全库 —— 这就是要防的那件事", () => {
    const naive = (
      db.query("select name from t where name like ? order by name").all("%100%%") as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(naive).toEqual(["100%", "1000"]);
    // 而 `%` 单独作为关键词时，naive 版本会命中所有行
    const naiveAll = db.query("select count(*) as n from t where name like ?").get("%%%") as {
      n: number;
    };
    expect(naiveAll.n).toBe(5);
  });
});
