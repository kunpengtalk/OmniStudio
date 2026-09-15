/**
 * 用量账本的聚合口径。
 *
 * 这里钉的是**读出来对不对**，而不是"能不能写进去"：统计页上的每个数字都由
 * `getUsageStats` 决定，口径错了（连击多算一天、占比拿请求数当分母、区间外的
 * 历史混进趋势）界面上看不出错，只会让人以为自己用少了。
 *
 * 自建临时库 + mock `./db`（与 chat.test.ts / image-gen.test.ts 同一套路）：
 * 测试跑在 `--parallel` 下，每个文件一个进程，库里只有本文件写的数据，
 * 不会串到别人的临时库上。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import * as schema from "./db/schema";
import { mockModulePartial } from "./test-mocks";

const dir = mkdtempSync(join(tmpdir(), "omni-usage-"));
const sqlite = new Database(join(dir, "usage.db"), { create: true });
const db = drizzle({ client: sqlite, schema });
migrate(db, { migrationsFolder: join(import.meta.dir, "db/migrations") });

await mockModulePartial<typeof import("./db")>("./db", { db, sqliteClient: sqlite });

const { getUsageStats, localDay, recordUsageEvent, shiftDay } = await import("./usage");
const { usageRecords } = await import("./db/schema");

const TODAY = localDay();

function seed(rows: {
  day: string;
  channel?: schema.UsageRecordRow["channel"];
  upstream?: schema.UsageRecordRow["upstream"];
  provider?: string;
  model?: string;
  input?: number;
  output?: number;
  cached?: number;
  reasoning?: number;
  requests?: number;
  estimated?: boolean;
}[]) {
  for (const r of rows) {
    db.insert(usageRecords)
      .values({
        createdAt: new Date(`${r.day}T12:00:00`).getTime(),
        day: r.day,
        channel: r.channel ?? "chat",
        upstream: r.upstream ?? "local",
        provider: r.provider ?? "llama.cpp",
        model: r.model ?? "qwen3",
        inputTokens: r.input ?? 0,
        outputTokens: r.output ?? 0,
        cachedTokens: r.cached ?? 0,
        reasoningTokens: r.reasoning ?? 0,
        requests: r.requests ?? 1,
        estimated: r.estimated ? 1 : 0,
      })
      .run();
  }
}

beforeEach(() => {
  db.delete(usageRecords).run();
});

describe("日期工具", () => {
  test("localDay 用本地时区，不是 UTC", () => {
    // 本地时间当天的 00:30：东八区下 toISOString() 会落到前一天，这里不该。
    const local = new Date(2026, 8, 14, 0, 30);
    expect(localDay(local.getTime())).toBe("2026-09-14");
  });

  test("shiftDay 跨月、跨年都稳", () => {
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDay("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDay("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDay("2024-03-01", -1)).toBe("2024-02-29"); // 闰年
  });
});

describe("落库", () => {
  test("记一行并补上本地日期", () => {
    recordUsageEvent({
      channel: "gateway",
      upstream: "cloud",
      provider: "DeepSeek",
      model: "deepseek-v4",
      inputTokens: 1200,
      outputTokens: 300,
      cachedTokens: 800,
      reasoningTokens: 50,
    });
    const row = db.select().from(usageRecords).all()[0]!;
    expect(row.day).toBe(TODAY);
    expect(row.channel).toBe("gateway");
    expect(row.inputTokens).toBe(1200);
    expect(row.cachedTokens).toBe(800);
    expect(row.requests).toBe(1);
    expect(row.estimated).toBe(0);
  });

  test("requests 为 0 时不落行（调用方用它表示这次不算）", () => {
    recordUsageEvent({
      channel: "chat",
      upstream: "local",
      provider: "llama.cpp",
      model: "qwen3",
      requests: 0,
    });
    expect(db.select().from(usageRecords).all().length).toBe(0);
  });

  test("负数字段被夹到 0，脏数据不会让统计变成负数", () => {
    recordUsageEvent({
      channel: "chat",
      upstream: "local",
      provider: "llama.cpp",
      model: "qwen3",
      inputTokens: -5,
      outputTokens: Number.NaN,
    });
    const row = db.select().from(usageRecords).all()[0]!;
    expect(row.inputTokens).toBe(0);
    expect(row.outputTokens).toBe(0);
  });

  test("没有模型名 / 厂商名时写成占位符，不会留空单元格", () => {
    recordUsageEvent({ channel: "image", upstream: "local", provider: "", model: "" });
    const row = db.select().from(usageRecords).all()[0]!;
    expect(row.provider).not.toBe("");
    expect(row.model).not.toBe("");
  });
});

describe("概要口径", () => {
  test("累计按 input + output，缓存与思考是子集不重复加", () => {
    seed([
      { day: TODAY, input: 1000, output: 200, cached: 900, reasoning: 150 },
      { day: TODAY, input: 500, output: 100 },
    ]);
    const s = getUsageStats(30).summary;
    expect(s.tokens).toBe(1800);
    expect(s.inputTokens).toBe(1500);
    expect(s.outputTokens).toBe(300);
  });

  test("峰值取单日最高的那天，今日单独算", () => {
    seed([
      { day: shiftDay(TODAY, -3), input: 5000, output: 0 },
      { day: TODAY, input: 100, output: 0 },
    ]);
    const { summary } = getUsageStats(30);
    expect(summary.peakDay?.day).toBe(shiftDay(TODAY, -3));
    expect(summary.peakDay?.tokens).toBe(5000);
    expect(summary.todayTokens).toBe(100);
    expect(summary.activeDays).toBe(2);
  });

  test("连击：今天没有记录就从昨天数（今天还没过完）", () => {
    seed([
      { day: shiftDay(TODAY, -1), input: 10 },
      { day: shiftDay(TODAY, -2), input: 10 },
      { day: shiftDay(TODAY, -3), input: 10 },
      // 断档两天后再往前的两天连击
      { day: shiftDay(TODAY, -6), input: 10 },
      { day: shiftDay(TODAY, -7), input: 10 },
    ]);
    const { summary } = getUsageStats(30);
    expect(summary.currentStreak).toBe(3);
    expect(summary.longestStreak).toBe(3);
  });

  test("今天有记录时连击把今天算进去", () => {
    seed([
      { day: TODAY, input: 1 },
      { day: shiftDay(TODAY, -1), input: 1 },
      { day: shiftDay(TODAY, -2), input: 1 },
    ]);
    expect(getUsageStats(30).summary.currentStreak).toBe(3);
  });

  test("断了两天，当前连击归零", () => {
    seed([
      { day: shiftDay(TODAY, -2), input: 1 },
      { day: shiftDay(TODAY, -3), input: 1 },
    ]);
    expect(getUsageStats(30).summary.currentStreak).toBe(0);
  });

  test("累计口径不随区间变化，区间只影响分组表", () => {
    seed([
      { day: shiftDay(TODAY, -100), input: 9999 },
      { day: TODAY, input: 1 },
    ]);
    const week = getUsageStats(7);
    const month = getUsageStats(30);
    expect(week.summary.tokens).toBe(10_000);
    expect(month.summary.tokens).toBe(10_000);
    expect(week.range.tokens).toBe(1);
    expect(month.range.tokens).toBe(1);
  });

  test("估算占比：有估算记录时才算得出来", () => {
    seed([
      { day: TODAY, input: 10, estimated: true },
      { day: TODAY, input: 10 },
      { day: TODAY, input: 10 },
      { day: TODAY, input: 10 },
    ]);
    expect(getUsageStats(30).summary.estimatedShare).toBeCloseTo(0.25, 5);
  });

  test("空库不炸：返回 0 而不是 null/NaN", () => {
    const stats = getUsageStats(30);
    expect(stats.summary.tokens).toBe(0);
    expect(stats.summary.peakDay).toBeNull();
    expect(stats.summary.firstDay).toBeNull();
    expect(stats.summary.estimatedShare).toBe(0);
    expect(stats.range.days.length).toBe(30);
    expect(stats.models).toEqual([]);
  });

  test("区间天数被夹到合理范围（前端传 0 / 超大值时不会算崩）", () => {
    expect(getUsageStats(0).rangeDays).toBe(1);
    expect(getUsageStats(99_999).rangeDays).toBe(400);
  });
});

describe("分组", () => {
  test("模型按 token 降序，占比以区间内总 token 为分母", () => {
    seed([
      { day: TODAY, model: "a", input: 750, output: 0 },
      { day: TODAY, model: "b", input: 250, output: 0 },
    ]);
    const { models } = getUsageStats(30);
    expect(models.map((m) => m.label)).toEqual(["a", "b"]);
    expect(models[0]!.share).toBeCloseTo(0.75, 5);
    expect(models[1]!.share).toBeCloseTo(0.25, 5);
  });

  test("同一个模型来自多个厂商时列出厂商明细", () => {
    seed([
      { day: TODAY, model: "gpt-4o", provider: "OpenAI", input: 500 },
      { day: TODAY, model: "gpt-4o", provider: "聚合站", input: 100 },
    ]);
    const { models } = getUsageStats(30);
    expect(models.length).toBe(1);
    expect(models[0]!.detail).toContain("OpenAI");
    expect(models[0]!.detail).toContain("聚合站");
  });

  test("单一来源的模型不写明细（纯噪音）", () => {
    seed([{ day: TODAY, model: "qwen3", provider: "llama.cpp", input: 10 }]);
    expect(getUsageStats(30).models[0]!.detail).toBeUndefined();
  });

  test("厂商分栏列出它家用了几个模型", () => {
    seed([
      { day: TODAY, model: "a", provider: "DeepSeek", input: 100 },
      { day: TODAY, model: "b", provider: "DeepSeek", input: 100 },
      { day: TODAY, model: "c", provider: "本地引擎", input: 100 },
    ]);
    const { providers } = getUsageStats(30);
    const deepseek = providers.find((p) => p.label === "DeepSeek")!;
    expect(deepseek.detail).toBe("2");
    expect(providers.find((p) => p.label === "本地引擎")!.detail).toBe("1");
  });

  test("没记录过的渠道也在列表里（显示 0），否则会以为这个入口没统计", () => {
    seed([{ day: TODAY, channel: "gateway", input: 10 }]);
    const { channels } = getUsageStats(30);
    const chat = channels.find((c) => c.key === "chat")!;
    expect(chat.tokens).toBe(0);
    expect(chat.requests).toBe(0);
    expect(channels.length).toBeGreaterThan(1);
  });

  test("只有生图 / 生视频（token 全 0）时按调用次数算占比", () => {
    seed([
      { day: TODAY, channel: "image", upstream: "cloud", provider: "云厂商", model: "gpt-image-1", requests: 3 },
      { day: TODAY, channel: "video", upstream: "cloud", provider: "云厂商", model: "MiniMax", requests: 1 },
    ]);
    const { channels, summary } = getUsageStats(30);
    expect(summary.tokens).toBe(0);
    expect(summary.requests).toBe(4);
    const image = channels.find((c) => c.key === "image")!;
    expect(image.share).toBeCloseTo(0.75, 5);
    // 按次数排序时生图排在生视频前面
    expect(channels[0]!.key).toBe("image");
  });

  test("渠道占比的分母是调用次数：混着有 token 与没 token 的渠道时也一样", () => {
    seed([
      { day: TODAY, channel: "chat", input: 100_000, requests: 3 },
      { day: TODAY, channel: "image", requests: 1 },
    ]);
    const { channels } = getUsageStats(30);
    const image = channels.find((c) => c.key === "image")!;
    // 按 token 算的话生图是 0%，用户就看不出"这个入口被用过"
    expect(image.share).toBeCloseTo(0.25, 5);
    expect(channels.find((c) => c.key === "chat")!.share).toBeCloseTo(0.75, 5);
  });

  test("厂商栏仍按 token 算占比，不被渠道口径带跑", () => {
    seed([
      { day: TODAY, provider: "DeepSeek", model: "a", input: 900, requests: 1 },
      { day: TODAY, provider: "ComfyUI", channel: "image", model: "flux", requests: 9 },
    ]);
    const { providers } = getUsageStats(30);
    expect(providers.find((p) => p.label === "DeepSeek")!.share).toBeCloseTo(1, 5);
    expect(providers.find((p) => p.label === "ComfyUI")!.share).toBe(0);
  });

  test("区间外的大额记录不进分组表", () => {
    seed([
      { day: shiftDay(TODAY, -60), model: "old", input: 999_999 },
      { day: TODAY, model: "new", input: 10 },
    ]);
    const { models } = getUsageStats(30);
    expect(models.map((m) => m.label)).toEqual(["new"]);
  });
});

describe("趋势", () => {
  test("按天补齐：没有记录的那天是 0，长度与区间一致", () => {
    seed([{ day: TODAY, model: "a", input: 100 }]);
    const { trend } = getUsageStats(7);
    expect(trend.days.length).toBe(7);
    expect(trend.days[6]).toBe(TODAY);
    expect(trend.series[0]!.values.length).toBe(7);
    expect(trend.series[0]!.values[0]).toBe(0);
    expect(trend.series[0]!.values[6]).toBe(100);
  });

  test("超过 6 个模型时其余并成「其他」，总量不漏", () => {
    const rows = Array.from({ length: 8 }).map((_, i) => ({
      day: TODAY,
      model: `m${i}`,
      input: (i + 1) * 100,
    }));
    seed(rows);
    const { trend } = getUsageStats(30);
    expect(trend.series.length).toBe(6);
    expect(trend.series[0]!.label).toBe("m7"); // 用量最大的排最前
    const total = trend.series.reduce((sum, s) => sum + s.tokens, 0) + (trend.other?.tokens ?? 0);
    expect(total).toBe(rows.reduce((sum, r) => sum + r.input, 0));
    expect(trend.other!.tokens).toBe(100 + 200); // 最小的两个
  });

  test("六个模型以内不出现「其他」", () => {
    seed([{ day: TODAY, model: "a", input: 1 }]);
    expect(getUsageStats(30).trend.other).toBeNull();
  });

  test("热力图数据覆盖到区间之外的历史（它是近一年口径）", () => {
    seed([{ day: shiftDay(TODAY, -200), model: "old", input: 42 }]);
    const { activity, trend } = getUsageStats(7);
    expect(activity.some((b) => b.tokens === 42)).toBe(true);
    expect(trend.series.every((s) => s.tokens === 0)).toBe(true);
  });
});
