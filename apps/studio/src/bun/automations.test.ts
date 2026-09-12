/**
 * 自动化计划计算单测：纯函数部分（时区换算 / 下次触发 / 描述文案）。
 * 不依赖数据库与调度器。
 */
import { describe, expect, test } from "bun:test";

import { computeNextRun, describeSchedule, zonedParts, zonedTimeToUtc } from "./automations";

const SHANGHAI = "Asia/Shanghai";
const NEW_YORK = "America/New_York";

describe("zonedTimeToUtc / zonedParts", () => {
  test("上海（UTC+8）墙上时间换算正确", () => {
    const ts = zonedTimeToUtc(2026, 3, 10, 9, 30, SHANGHAI);
    expect(new Date(ts).toISOString()).toBe("2026-03-10T01:30:00.000Z");
    const parts = zonedParts(ts, SHANGHAI);
    expect([parts.year, parts.month, parts.day, parts.hour, parts.minute]).toEqual([2026, 3, 10, 9, 30]);
  });

  test("纽约夏令时切换前后换算各自正确（EDT/EST）", () => {
    // 2026-03-08 是美东夏令时开始日：02:00 之后是 EDT（UTC-4）
    const before = zonedTimeToUtc(2026, 3, 8, 1, 0, NEW_YORK);
    expect(new Date(before).toISOString()).toBe("2026-03-08T06:00:00.000Z");
    const after = zonedTimeToUtc(2026, 3, 8, 12, 0, NEW_YORK);
    expect(new Date(after).toISOString()).toBe("2026-03-08T16:00:00.000Z");
  });
});

describe("computeNextRun", () => {
  test("daily：还没到点就是今天，过了就推到明天", () => {
    const from = zonedTimeToUtc(2026, 5, 1, 8, 0, SHANGHAI);
    const next = computeNextRun("daily", { hour: 9, minute: 30 }, SHANGHAI, from);
    expect(next).not.toBeNull();
    const parts = zonedParts(next!, SHANGHAI);
    expect([parts.day, parts.hour, parts.minute]).toEqual([1, 9, 30]);

    const later = zonedTimeToUtc(2026, 5, 1, 10, 0, SHANGHAI);
    const tomorrow = computeNextRun("daily", { hour: 9, minute: 30 }, SHANGHAI, later);
    expect(zonedParts(tomorrow!, SHANGHAI).day).toBe(2);
  });

  test("weekly：只在选中的星期触发（2026-05-01 是周五）", () => {
    const from = zonedTimeToUtc(2026, 5, 1, 10, 0, SHANGHAI); // 周五
    // 选周一(1) / 周三(3)：下一次应是 5-04（周一）
    const next = computeNextRun("weekly", { hour: 8, minute: 0, daysOfWeek: [1, 3] }, SHANGHAI, from);
    const parts = zonedParts(next!, SHANGHAI);
    expect([parts.month, parts.day, parts.weekday, parts.hour]).toEqual([5, 4, 1, 8]);
  });

  test("weekly：同一天但时间还没到，就是当天", () => {
    const from = zonedTimeToUtc(2026, 5, 4, 7, 0, SHANGHAI); // 周一 07:00
    const next = computeNextRun("weekly", { hour: 8, minute: 0, daysOfWeek: [1] }, SHANGHAI, from);
    expect(zonedParts(next!, SHANGHAI).day).toBe(4);
  });

  test("once：未来时间返回该时刻，过去时间返回 null", () => {
    const at = new Date(Date.now() + 3600_000).toISOString();
    expect(computeNextRun("once", { at }, SHANGHAI)).toBe(Date.parse(at));
    const past = new Date(Date.now() - 3600_000).toISOString();
    expect(computeNextRun("once", { at: past }, SHANGHAI)).toBeNull();
  });

  test("非法 once 时间返回 null，不抛异常", () => {
    expect(computeNextRun("once", { at: "not-a-date" }, SHANGHAI)).toBeNull();
  });
});

describe("describeSchedule", () => {
  test("三种计划都能给出可读文案", () => {
    expect(describeSchedule("daily", { hour: 9, minute: 5 })).toBe("每天 09:05");
    expect(describeSchedule("weekly", { hour: 18, minute: 0, daysOfWeek: [1, 3] })).toContain("周一");
    expect(describeSchedule("weekly", { hour: 18, minute: 0, daysOfWeek: [1, 3] })).toContain("18:00");
    expect(describeSchedule("once", { at: new Date(2026, 0, 1, 9, 0).toISOString() })).toContain("仅一次");
  });
});
