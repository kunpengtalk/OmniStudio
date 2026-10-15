import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { join } from "path";
import * as fs from "fs";

import * as schema from "./db/schema";
import { mockModulePartial } from "./test-mocks";

// ---------------------------------------------------------------------------
// 独立临时测试库（跑全部迁移，得到真实的 prompt 表）
// ---------------------------------------------------------------------------
const tmpDb = `/tmp/prompt-library-test-${process.pid}.db`;
fs.rmSync(tmpDb, { force: true });
const sqlite = new Database(tmpDb, { create: true });
const db = drizzle({ client: sqlite, schema });
migrate(db, { migrationsFolder: join(import.meta.dir, "db/migrations") });

await mockModulePartial<typeof import("./db")>("./db", { db });

// 内置题库（第三方聚合内容）已于 2026-10-03 法律风险排查中清空，随包种子只剩空壳。
// seedIfNeeded 改为可注入目录：这里喂一份小 fixture，验证灌库 / 幂等 / 查询全链路。
const tmpSeedDir = `/tmp/prompt-library-seed-${process.pid}`;
const writeSeed = (file: string, data: unknown) =>
  fs.writeFileSync(join(tmpSeedDir, file), JSON.stringify(data));

const PromptLib = await import("./prompt-library");

describe("prompt-library", () => {
  beforeAll(() => {
    fs.mkdirSync(tmpSeedDir, { recursive: true });
    writeSeed("image-prompts.json", {
      categories: [{ name: "海报", intro: "poster" }, { name: "IP" }],
      items: [
        {
          id: "t-img-1",
          name: "秋日海报",
          category: "海报",
          prompt: "A autumn poster prompt",
          image: "https://example.com/case544.jpg",
          source: "awesome",
          sourceLabel: "GPT-Image-2",
          featured: 3,
        },
        { id: "t-img-2", name: "IP 形象", category: "IP", prompt: "An IP mascot prompt", source: "img2hub" },
      ],
    });
    writeSeed("video-prompts.json", {
      categories: [{ name: "广告品牌" }],
      sources: ["h3cases"],
      items: [
        { id: "t-vid-1", name: "镜头一", category: "广告品牌", prompt: "Ten shots", mode: "文生视频", duration: 15, source: "h3cases", featured: 2 },
        { id: "t-vid-2", name: "镜头二", category: "广告品牌", prompt: "Rainy bar", source: "h3cases" },
        { id: "t-vid-3", name: "镜头三", category: "广告品牌", prompt: "Neon street", source: "h3cases" },
      ],
    });
    writeSeed("llm-prompts.json", {
      categories: [{ name: "办公" }],
      items: [{ id: "t-llm-1", name: "周报助手", category: "办公", prompt: "写一份周报" }],
    });
    PromptLib.seedIfNeeded(tmpSeedDir);
  });

  afterAll(() => {
    sqlite.close();
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(tmpSeedDir, { force: true, recursive: true });
  });

  test("首次灌入后三类数据都有", () => {
    const counts = PromptLib.countPromptsByKind();
    expect(counts.image).toBe(2);
    expect(counts.video).toBe(3);
    expect(counts.llm).toBe(1);
  });

  test("重复 seed 幂等，不会重复插入", () => {
    PromptLib.seedIfNeeded(tmpSeedDir);
    const counts = PromptLib.countPromptsByKind();
    expect(counts.image).toBe(2);
    expect(counts.video).toBe(3);
  });

  test("随包种子必须是空壳（法律合规：不得再内置第三方聚合内容）", () => {
    const seedDir = join(import.meta.dir, "prompt-library/seed");
    for (const f of ["image-prompts.json", "video-prompts.json", "llm-prompts.json"]) {
      const data = JSON.parse(fs.readFileSync(join(seedDir, f), "utf8"));
      expect(data.items ?? []).toEqual([]);
    }
  });

  test("列出分类带条数", () => {
    const cats = PromptLib.listCategories("image");
    expect(cats.length).toBe(2);
    const poster = cats.find((c) => c.name === "海报");
    expect(poster).toBeDefined();
    expect(poster!.count).toBe(1);
  });

  test("按分类过滤", () => {
    const { items, total } = PromptLib.listPrompts({ kind: "image", category: "IP" });
    expect(total).toBe(1);
    expect(items.every((i) => i.category === "IP")).toBe(true);
  });

  test("关键词搜索命中标题/提示词", () => {
    const { items, total } = PromptLib.listPrompts({ kind: "video", search: "镜头" });
    expect(total).toBe(3);
    expect(items.length).toBe(3);
  });

  test("分页 limit/offset", () => {
    const page1 = PromptLib.listPrompts({ kind: "video", category: "广告品牌", limit: 2, offset: 0 });
    const page2 = PromptLib.listPrompts({ kind: "video", category: "广告品牌", limit: 2, offset: 2 });
    expect(page1.items.length).toBe(2);
    expect(page1.items[0]?.id).not.toBe(page2.items[0]?.id);
  });

  test("来源过滤", () => {
    const { items, total } = PromptLib.listPrompts({ kind: "image", source: "awesome" });
    expect(total).toBe(1);
    expect(items.every((i) => i.source === "awesome")).toBe(true);
  });

  test("视频案例的 mode/duration 字段存在", () => {
    const { items } = PromptLib.listPrompts({ kind: "video", limit: 20 });
    const withMode = items.filter((i) => i.mode);
    expect(withMode.length).toBe(1);
    expect(withMode[0]!.duration).toBe(15);
  });

  test("mediaUrl 只透传绝对地址；旧题库相对路径不再解析", () => {
    expect(PromptLib.mediaUrl("https://example.com/case544.jpg")).toBe("https://example.com/case544.jpg");
    expect(PromptLib.mediaUrl("/prompt-library/awesome/case544.jpg")).toBeNull();
    const { items } = PromptLib.listPrompts({ kind: "image", limit: 30 });
    expect(items[0]!.image).toBe("https://example.com/case544.jpg");
  });
});

// ---------------------------------------------------------------------------
// （第三方云端 URL 解析器已随热链管线拆除，无独立测试面）
// ---------------------------------------------------------------------------
