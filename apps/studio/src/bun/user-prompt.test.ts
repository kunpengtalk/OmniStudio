import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { join } from "path";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// 独立临时测试库（跑全部迁移，得到真实的 user_prompts / prompts 表）
// ---------------------------------------------------------------------------
const tmpDb = `/tmp/user-prompt-test-${process.pid}.db`;
fs.rmSync(tmpDb, { force: true });
const sqlite = new Database(tmpDb, { create: true });
const db = drizzle({ client: sqlite });
migrate(db, { migrationsFolder: join(import.meta.dir, "db/migrations") });

mock.module("./db", () => ({ db }));

const PromptLib = await import("./prompt-library");
const Up = await import("./user-prompt");

describe("user-prompt", () => {
  beforeAll(() => {
    PromptLib.seedIfNeeded(); // 灌入广场数据，供导入测试
  });

  afterAll(() => {
    sqlite.close();
    fs.rmSync(tmpDb, { force: true });
  });

  test("新建并列出（默认按更新时间倒序）", () => {
    const a = Up.createMyPrompt({
      kind: "image",
      category: "我的插画",
      name: "A 插画",
      prompt: "一只猫",
      summary: "测试",
    });
    const b = Up.createMyPrompt({
      kind: "image",
      name: "B 无分类",
      prompt: "一只狗",
    });
    expect(a.id).toBeGreaterThan(0);
    expect(a.key).toBe(`user-${a.id}`);
    expect(a.category).toBe("我的插画");
    expect(b.category).toBe("未分类");

    const { items, total } = Up.listMyPrompts({ kind: "image" });
    expect(total).toBe(2);
    expect(items[0]!.id).toBe(b.id); // 后新建的排前面
  });

  test("分类与搜索过滤", () => {
    const cats = Up.listMyPromptCategories();
    expect(cats.some((c) => c.name === "我的插画" && c.count >= 1)).toBe(true);
    expect(cats.some((c) => c.name === "未分类" && c.count >= 1)).toBe(true);

    const hit = Up.listMyPrompts({ kind: "image", search: "插画" });
    expect(hit.total).toBeGreaterThan(0);
    // 搜索命中「未分类」分组的项
    const uncat = Up.listMyPrompts({ kind: "image", category: "未分类" });
    expect(uncat.total).toBeGreaterThan(0);
  });

  test("更新会触发 updatedAt 并写回字段", () => {
    const a = Up.createMyPrompt({ kind: "llm", name: "旧名", prompt: "旧提示词" });
    const updated = Up.updateMyPrompt(a.id, {
      name: "新名",
      category: "办公",
      summary: "更新后的简介",
    });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("新名");
    expect(updated!.category).toBe("办公");
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(a.createdAt);
  });

  test("删除", () => {
    const a = Up.createMyPrompt({ kind: "video", name: "待删", prompt: "x" });
    expect(Up.deleteMyPrompt(a.id).ok).toBe(true);
    expect(Up.listMyPrompts({ kind: "video" }).items.some((i) => i.id === a.id)).toBe(false);
  });

  test("从广场导入：字段拷贝 + 幂等（重复导入返回 already）", () => {
    const plaza = PromptLib.listPrompts({ kind: "image", limit: 1 });
    const src = plaza.items[0]!;
    const first = Up.importMyPromptFromPlaza(src.id);
    expect(first.item).toBeDefined();
    expect(first.already).toBeUndefined();
    expect(first.item!.name).toBe(src.name);
    expect(first.item!.prompt).toBe(src.prompt);
    expect(first.item!.sourceKey).toBe(src.key);
    // image 与广场一致（同一 mediaKey；库里存原始路径）
    expect(first.item!.mediaKey).toBe(src.mediaKey);

    const keys = Up.listMyPromptSourceKeys();
    expect(keys).toContain(src.key);

    const again = Up.importMyPromptFromPlaza(src.id);
    expect(again.already).toBe(true);
    expect(again.item!.id).toBe(first.item!.id);
    // 不会重复插入
    const all = Up.listMyPrompts({ kind: "image" });
    const dup = all.items.filter((i) => i.sourceKey === src.key);
    expect(dup.length).toBe(1);
  });

  test("从广场导入不存在的 id 返回空", () => {
    expect(Up.importMyPromptFromPlaza(999999)).toEqual({});
  });
});
