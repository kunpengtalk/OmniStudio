/**
 * Goal 模式的单测。
 *
 * 重点不是"能不能存下来"，而是**刹车灵不灵**：
 * Goal 模式会自动续跑（不需要用户发话），所以"什么时候必须停"是这里最该钉住的东西 ——
 * 撞 token 预算要停、续跑次数到上限要停、被用户按了停止之后不许自己再跑起来。
 */
import { beforeEach, describe, expect, test } from "bun:test";

import {
  addGoalUsage,
  clearGoal,
  createGoal,
  defaultGoalTokenBudget,
  describeGoal,
  getGoal,
  goalContinuationText,
  goalPromptSection,
  isTerminal,
  maxGoalContinuations,
  setGoalStatus,
} from "./agent-goals";
import { updateSettings } from "./db/settings";

const CONVERSATION = 990_001;

beforeEach(() => {
  clearGoal(CONVERSATION);
  updateSettings({ AGENT_GOAL_MAX_CONTINUATIONS: "6", AGENT_GOAL_TOKEN_BUDGET: "0" });
});

describe("目标状态", () => {
  test("立项后可读回，初始为 active 且计数归零", () => {
    const goal = createGoal(CONVERSATION, { objective: "把导出功能做完", acceptance: "导出 csv 且能打开" });
    expect(goal.status).toBe("active");
    expect(goal.acceptance).toBe("导出 csv 且能打开");
    expect(goal.tokensUsed).toBe(0);
    expect(goal.continuations).toBe(0);
    expect(getGoal(CONVERSATION)?.objective).toBe("把导出功能做完");
  });

  test("重新立项会重置计数（旧目标的消耗不该算到新目标头上）", () => {
    createGoal(CONVERSATION, { objective: "第一版" });
    addGoalUsage(CONVERSATION, { tokens: 5_000, seconds: 60, continuation: true });
    const next = createGoal(CONVERSATION, { objective: "第二版" });
    expect(next.tokensUsed).toBe(0);
    expect(next.continuations).toBe(0);
    expect(next.secondsUsed).toBe(0);
  });

  test("终态判定：complete / dropped 不再续跑", () => {
    expect(isTerminal("complete")).toBe(true);
    expect(isTerminal("dropped")).toBe(true);
    expect(isTerminal("active")).toBe(false);
    expect(isTerminal("paused")).toBe(false);
    expect(isTerminal("budget-limited")).toBe(false);
  });

  test("状态可以人工改（暂停 / 恢复 / 放弃），不存在的目标返回 null", () => {
    createGoal(CONVERSATION, { objective: "x" });
    expect(setGoalStatus(CONVERSATION, "paused")?.status).toBe("paused");
    expect(setGoalStatus(CONVERSATION, "active")?.status).toBe("active");
    expect(setGoalStatus(CONVERSATION, "dropped", "缺权限")?.outcome).toBe("缺权限");
    expect(setGoalStatus(123_456_789, "active")).toBeNull();
  });
});

describe("账本与刹车", () => {
  test("累加 token / 秒数，只有续跑轮才计入续跑次数", () => {
    createGoal(CONVERSATION, { objective: "x" });
    addGoalUsage(CONVERSATION, { tokens: 1_000, seconds: 30 });
    const afterUserTurn = getGoal(CONVERSATION)!;
    expect(afterUserTurn.tokensUsed).toBe(1_000);
    // 用户自己发话开启的第一轮不算"自动续跑"
    expect(afterUserTurn.continuations).toBe(0);

    addGoalUsage(CONVERSATION, { tokens: 500, seconds: 10, continuation: true });
    expect(getGoal(CONVERSATION)!.continuations).toBe(1);
    expect(getGoal(CONVERSATION)!.tokensUsed).toBe(1_500);
    expect(getGoal(CONVERSATION)!.secondsUsed).toBe(40);
  });

  test("默认不设 token 预算（本地消耗量级差太大，拍一个数反而误导）", () => {
    expect(defaultGoalTokenBudget()).toBeNull();
    updateSettings({ AGENT_GOAL_TOKEN_BUDGET: "50000" });
    expect(defaultGoalTokenBudget()).toBe(50_000);
    updateSettings({ AGENT_GOAL_TOKEN_BUDGET: "0" });
    expect(defaultGoalTokenBudget()).toBeNull();
  });

  test("撞上 token 预算时明确报告（调用方据此停止推进）", () => {
    updateSettings({ AGENT_GOAL_TOKEN_BUDGET: "1" });
    createGoal(CONVERSATION, { objective: "x" });
    expect(getGoal(CONVERSATION)!.tokenBudget).toBe(1);
    const hit = addGoalUsage(CONVERSATION, { tokens: 1_000, seconds: 1 });
    expect(hit.exceededBudget).toBe(true);

    // 没设预算就不该报超
    updateSettings({ AGENT_GOAL_TOKEN_BUDGET: "0" });
    createGoal(CONVERSATION, { objective: "y" });
    expect(addGoalUsage(CONVERSATION, { tokens: 999_999, seconds: 1 }).exceededBudget).toBe(false);
  });

  test("已终结的目标不再记账（完成之后跑的那轮不算目标消耗）", () => {
    createGoal(CONVERSATION, { objective: "x" });
    setGoalStatus(CONVERSATION, "complete", "做完了");
    addGoalUsage(CONVERSATION, { tokens: 9_999, seconds: 99, continuation: true });
    expect(getGoal(CONVERSATION)!.tokensUsed).toBe(0);
  });

  test("续跑上限可配，默认 6；设 0 = 关掉自动续跑（空值不该被当成 0）", () => {
    expect(maxGoalContinuations()).toBe(6);
    updateSettings({ AGENT_GOAL_MAX_CONTINUATIONS: "2" });
    expect(maxGoalContinuations()).toBe(2);
    // 空串走默认 —— `Number("") === 0` 会让"没配过"变成"一次都不许续跑"
    updateSettings({ AGENT_GOAL_MAX_CONTINUATIONS: "" });
    expect(maxGoalContinuations()).toBe(6);
    updateSettings({ AGENT_GOAL_MAX_CONTINUATIONS: "abc" });
    expect(maxGoalContinuations()).toBe(6);
    // 显式设 0 才是"关掉"
    updateSettings({ AGENT_GOAL_MAX_CONTINUATIONS: "0" });
    expect(maxGoalContinuations()).toBe(0);
  });
});

describe("注入与文案", () => {
  test("目标段落带上目标、验收标准与完成标准（终结后不再注入）", () => {
    createGoal(CONVERSATION, { objective: "把导出功能做完", acceptance: "能导出 csv" });
    const section = goalPromptSection(CONVERSATION)!;
    expect(section).toContain("把导出功能做完");
    expect(section).toContain("能导出 csv");
    // 完成标准的四句是防"自我感觉良好"的关键，缺一句都该当回归
    expect(section).toContain("验证范围必须等于声明范围");
    expect(section).toContain("不确定");
    expect(section).toContain("预算快用完了不等于任务完成了");

    setGoalStatus(CONVERSATION, "complete", "做完了");
    expect(goalPromptSection(CONVERSATION)).toBeNull();
  });

  test("没设验收标准时提示先去对齐，而不是默默跳过", () => {
    createGoal(CONVERSATION, { objective: "把导出功能做完" });
    expect(goalPromptSection(CONVERSATION)).toContain("ask_user");
  });

  test("续跑消息要求「接着推进」而不是复述，并要求给出证据或说明卡点", () => {
    const goal = createGoal(CONVERSATION, { objective: "把导出做完", acceptance: "能导出 csv" });
    const text = goalContinuationText(goal);
    expect(text).toContain("把导出做完");
    expect(text).toContain("不要复述");
    expect(text).toContain("complete");
    expect(text).toContain("abandon");
  });

  test("进度描述同时给出用量与续跑次数", () => {
    createGoal(CONVERSATION, { objective: "x" });
    addGoalUsage(CONVERSATION, { tokens: 1_234, seconds: 120, continuation: true });
    const described = describeGoal(getGoal(CONVERSATION)!);
    expect(described).toContain("1234 tokens");
    expect(described).toContain("2 分钟");
    expect(described).toContain("1 / 6");
  });
});
