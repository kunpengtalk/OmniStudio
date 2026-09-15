/**
 * Plan 模式的单测：方案落盘、批准语义、以及"批准过的方案怎么交给执行者"。
 *
 * 最该钉住的是**批准失效**：方案改过之后，上一次的批准必须作废 ——
 * 否则用户"批准的是 A、执行的是 B"，这是最危险的一种不一致。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import {
  approvePlan,
  approvedPlanContent,
  clearPlan,
  getPlan,
  planFilePath,
  planHandoffSection,
  savePlan,
} from "./agent-plans";

const CONVERSATION = 990_002;

beforeEach(() => {
  clearPlan(CONVERSATION);
});

describe("方案落盘", () => {
  test("写入后文件与库都在，且带上落盘路径", () => {
    const plan = savePlan(CONVERSATION, { content: "## 目标\n把导出做完", messageId: 7 });
    expect(plan.content).toContain("把导出做完");
    expect(plan.messageId).toBe(7);
    expect(plan.filePath).toBe(planFilePath(CONVERSATION));
    expect(existsSync(planFilePath(CONVERSATION))).toBe(true);
    expect(readFileSync(planFilePath(CONVERSATION), "utf8")).toContain("把导出做完");
  });

  test("重复写入是覆盖而不是追加（方案只有一份）", () => {
    savePlan(CONVERSATION, { content: "第一版" });
    savePlan(CONVERSATION, { content: "第二版" });
    expect(getPlan(CONVERSATION)!.content).toBe("第二版");
    expect(readFileSync(planFilePath(CONVERSATION), "utf8")).toBe("第二版");
  });

  test("首尾空白被去掉（模型常常多写几个换行）", () => {
    expect(savePlan(CONVERSATION, { content: "\n\n  方案正文  \n\n" }).content).toBe("方案正文");
  });
});

describe("批准语义", () => {
  test("没方案时批准给出可读原因，不抛错", () => {
    const result = approvePlan(CONVERSATION);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("还没有方案");
  });

  test("批准后 approvedPlanContent 才拿得到正文", () => {
    savePlan(CONVERSATION, { content: "方案 A" });
    expect(approvedPlanContent(CONVERSATION)).toBeNull();
    expect(approvePlan(CONVERSATION).ok).toBe(true);
    expect(approvedPlanContent(CONVERSATION)).toBe("方案 A");
  });

  test("改过方案之后，上一次的批准作废（不能批准 A 却执行 B）", () => {
    savePlan(CONVERSATION, { content: "方案 A" });
    approvePlan(CONVERSATION);
    expect(approvedPlanContent(CONVERSATION)).toBe("方案 A");

    savePlan(CONVERSATION, { content: "方案 B" });
    expect(getPlan(CONVERSATION)!.approvedAt).toBeNull();
    expect(approvedPlanContent(CONVERSATION)).toBeNull();
  });

  test("空方案不能被批准", () => {
    savePlan(CONVERSATION, { content: "占位" });
    // 直接改库模拟"方案被清空"的场景
    savePlan(CONVERSATION, { content: "" });
    expect(approvePlan(CONVERSATION).ok).toBe(false);
  });
});

describe("交给执行者", () => {
  test("批准过的方案进子智能体的上下文，并说明冲突时以任务说明为准", () => {
    savePlan(CONVERSATION, { content: "## 方案\n1. 改 a.ts" });
    expect(planHandoffSection(CONVERSATION)).toBeNull();
    approvePlan(CONVERSATION);
    const section = planHandoffSection(CONVERSATION)!;
    expect(section).toContain("改 a.ts");
    expect(section).toContain("以你的任务说明为准");
  });
});

describe("清理", () => {
  test("清空会话时方案与文件一起清掉", () => {
    savePlan(CONVERSATION, { content: "方案" });
    approvePlan(CONVERSATION);
    clearPlan(CONVERSATION);
    expect(getPlan(CONVERSATION)).toBeNull();
    expect(existsSync(planFilePath(CONVERSATION))).toBe(false);
  });
});
