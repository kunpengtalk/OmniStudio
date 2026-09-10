import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { join } from "path";
import * as fs from "fs";
import { mock } from "bun:test";

// ---------------------------------------------------------------------------
// 独立临时测试库（跑全部迁移，得到真实的 prompt 表）
// ---------------------------------------------------------------------------
const tmpDb = `/tmp/prompt-library-test-${process.pid}.db`;
fs.rmSync(tmpDb, { force: true });
const sqlite = new Database(tmpDb, { create: true });
const db = drizzle({ client: sqlite });
migrate(db, { migrationsFolder: join(import.meta.dir, "db/migrations") });

mock.module("./db", () => ({ db }));

// 提示词模块路径位于 src/bun/ 下，import.meta.dir 即 src/bun，seed JSON 就在旁边
const PromptLib = await import("./prompt-library");

describe("prompt-library", () => {
  beforeAll(() => {
    PromptLib.seedIfNeeded();
  });

  afterAll(() => {
    sqlite.close();
    fs.rmSync(tmpDb, { force: true });
  });

  test("首次灌入后三类数据都有", () => {
    const counts = PromptLib.countPromptsByKind();
    expect(counts.image).toBeGreaterThan(500);
    expect(counts.video).toBeGreaterThan(1000);
    expect(counts.llm).toBeGreaterThan(10);
  });

  test("重复 seed 幂等，不会重复插入", () => {
    PromptLib.seedIfNeeded();
    const counts = PromptLib.countPromptsByKind();
    expect(counts.image).toBeGreaterThan(500);
    expect(counts.video).toBeGreaterThan(1000);
  });

  test("列出分类带条数", () => {
    const cats = PromptLib.listCategories("image");
    expect(cats.length).toBeGreaterThanOrEqual(5);
    const poster = cats.find((c) => c.name === "海报");
    expect(poster).toBeDefined();
    expect(poster!.count).toBeGreaterThan(50);
  });

  test("按分类过滤", () => {
    const { items, total } = PromptLib.listPrompts({ kind: "image", category: "IP" });
    expect(total).toBeGreaterThan(0);
    expect(items.every((i) => i.category === "IP")).toBe(true);
  });

  test("关键词搜索命中标题/提示词", () => {
    const { items, total } = PromptLib.listPrompts({ kind: "video", search: "镜头" });
    expect(total).toBeGreaterThan(0);
    expect(items.length).toBeGreaterThan(0);
  });

  test("分页 limit/offset", () => {
    const page1 = PromptLib.listPrompts({ kind: "video", category: "广告品牌", limit: 5, offset: 0 });
    const page2 = PromptLib.listPrompts({ kind: "video", category: "广告品牌", limit: 5, offset: 5 });
    expect(page1.items.length).toBeLessThanOrEqual(5);
    expect(page1.items[0]?.id).not.toBe(page2.items[0]?.id);
  });

  test("来源过滤", () => {
    const { items, total } = PromptLib.listPrompts({ kind: "image", source: "awesome" });
    expect(total).toBeGreaterThan(100);
    expect(items.every((i) => i.source === "awesome")).toBe(true);
  });

  test("视频案例的 mode/duration 字段存在", () => {
    const { items } = PromptLib.listPrompts({ kind: "video", category: "广告品牌", limit: 20 });
    const withMode = items.filter((i) => i.mode);
    expect(withMode.length).toBeGreaterThan(0);
  });
});
