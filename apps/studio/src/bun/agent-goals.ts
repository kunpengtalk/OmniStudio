/**
 * Agent 目标（Goal 模式）。
 *
 * Goal 模式与 Agent 模式的差别不在工具集，而在**谁来推进**：
 * Agent 模式跑完这一轮就停下等用户；Goal 模式在回合结束后自己接着跑，直到
 * 验收标准满足、撞上预算、或者被用户按了停止。
 *
 * 所以这个模块负责三件事（缺了任何一件，Goal 模式就只剩一段提示词）：
 * 1. **目标状态**：要达成什么、怎么算达成 —— 落库，跨回合 / 跨重启都还在；
 * 2. **账本**：已经花了多少 token / 多久、自动续跑了几轮 —— 这是"自主跑下去"的刹车；
 * 3. **注入**：把目标与完成标准写进系统提示，每轮都在，模型不会跑着跑着忘了要干什么。
 *
 * 记账口径：**刻意不把 cacheRead 算进 token 用量**（对齐 OMP）。前缀缓存命中的部分
 * 并没有真的重新送一遍上下文，把它算成"烧掉的预算"会让开了缓存之后预算瞬间爆掉 ——
 * 那是记账口径错，不是目标跑太多。
 */
import { eq } from "drizzle-orm";

import { db } from "./db";
import { agentGoals } from "./db/schema";
import { getSetting } from "./db/settings";

export type GoalStatus = "active" | "paused" | "budget-limited" | "complete" | "dropped";

export type AgentGoal = {
  conversationId: number;
  objective: string;
  acceptance: string | null;
  status: GoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  secondsUsed: number;
  continuations: number;
  outcome: string | null;
  createdAt: number | null;
  updatedAt: number | null;
};

const STATUSES: GoalStatus[] = ["active", "paused", "budget-limited", "complete", "dropped"];

/** 终态：不会再自动续跑。 */
export function isTerminal(status: GoalStatus): boolean {
  return status === "complete" || status === "dropped";
}

type Listener = (payload: { conversationId: number; goal: AgentGoal | null }) => void;
const listeners = new Set<Listener>();

export function onGoalChanged(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function notify(conversationId: number, goal: AgentGoal | null): void {
  for (const listener of listeners) listener({ conversationId, goal });
}

function toGoal(row: typeof agentGoals.$inferSelect): AgentGoal {
  return {
    conversationId: row.conversationId,
    objective: row.objective,
    acceptance: row.acceptance ?? null,
    status: STATUSES.includes(row.status) ? row.status : "active",
    tokenBudget: row.tokenBudget ?? null,
    tokensUsed: row.tokensUsed ?? 0,
    secondsUsed: row.secondsUsed ?? 0,
    continuations: row.continuations ?? 0,
    outcome: row.outcome ?? null,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

export function getGoal(conversationId: number): AgentGoal | null {
  const row = db.select().from(agentGoals).where(eq(agentGoals.conversationId, conversationId)).get();
  return row ? toGoal(row) : null;
}

/** 续跑上限的默认值：本地一轮几十秒到几分钟，6 轮已经够跑完绝大多数任务。 */
export const DEFAULT_MAX_CONTINUATIONS = 6;

/**
 * 续跑轮数上限。设成 0 = **关掉自动续跑**（Goal 模式退化成"一轮内做完"，是合法选择）；
 * 空 / 非法值 = 用默认值 —— 不能把空串当成 0（`Number("") === 0`），
 * 那会让"没配过这个设置"变成"一次都不许续跑"。
 */
export function maxGoalContinuations(): number {
  const raw = getSetting("AGENT_GOAL_MAX_CONTINUATIONS").trim();
  if (!raw) return DEFAULT_MAX_CONTINUATIONS;
  const configured = Number(raw);
  return Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : DEFAULT_MAX_CONTINUATIONS;
}

/**
 * 默认 token 预算。
 *
 * 0 / 空 = 不限制。默认给 0 是有意的：本地模型的账最难估（同一个任务在 8k 和 32k
 * 窗口下的消耗差一个量级），给一个拍脑袋的数字反而会让用户以为"它算过"。
 * 真正的刹车是续跑轮数上限；预算留给"我想卡死一个数"的用户显式去设。
 */
export function defaultGoalTokenBudget(): number | null {
  const configured = Number(getSetting("AGENT_GOAL_TOKEN_BUDGET"));
  return Number.isFinite(configured) && configured > 0 ? configured : null;
}

export function createGoal(
  conversationId: number,
  input: { objective: string; acceptance?: string | null; tokenBudget?: number | null },
): AgentGoal {
  const objective = input.objective.trim();
  const acceptance = input.acceptance?.trim() || null;
  const tokenBudget = input.tokenBudget ?? defaultGoalTokenBudget();
  const existing = getGoal(conversationId);
  if (existing) {
    db.update(agentGoals)
      .set({
        objective,
        acceptance,
        status: "active",
        tokenBudget,
        // 换目标 = 重新开始计数：旧的消耗不该算在新目标头上。
        tokensUsed: 0,
        secondsUsed: 0,
        continuations: 0,
        outcome: null,
      })
      .where(eq(agentGoals.conversationId, conversationId))
      .run();
  } else {
    db.insert(agentGoals)
      .values({ conversationId, objective, acceptance, status: "active", tokenBudget })
      .run();
  }
  const goal = getGoal(conversationId)!;
  notify(conversationId, goal);
  return goal;
}

export function setGoalStatus(conversationId: number, status: GoalStatus, outcome?: string | null): AgentGoal | null {
  const existing = getGoal(conversationId);
  if (!existing) return null;
  db.update(agentGoals)
    .set({ status, outcome: outcome?.trim() || existing.outcome })
    .where(eq(agentGoals.conversationId, conversationId))
    .run();
  const goal = getGoal(conversationId);
  notify(conversationId, goal);
  return goal;
}

/**
 * 累加一轮的消耗，并判断是否撞上预算。
 *
 * `seconds` 只该包含**真正在跑**的时间（调用方按回合起止算），等待用户的时间不算进去 ——
 * 否则用户去泡杯咖啡，回来就看到目标"超时"了。
 */
export function addGoalUsage(
  conversationId: number,
  usage: { tokens: number; seconds: number; continuation?: boolean },
): { goal: AgentGoal | null; exceededBudget: boolean } {
  const goal = getGoal(conversationId);
  if (!goal) return { goal: null, exceededBudget: false };
  if (isTerminal(goal.status)) return { goal, exceededBudget: false };

  const tokensUsed = goal.tokensUsed + Math.max(0, Math.round(usage.tokens));
  const secondsUsed = goal.secondsUsed + Math.max(0, Math.round(usage.seconds));
  // 只有"自动续跑"的那几轮才计数：用户自己发话开启的第一轮不算续跑，
  // 否则界面上会写着"续跑 1 次"而用户根本没让它自己跑过。
  const continuations = goal.continuations + (usage.continuation ? 1 : 0);
  db.update(agentGoals)
    .set({ tokensUsed, secondsUsed, continuations })
    .where(eq(agentGoals.conversationId, conversationId))
    .run();

  const updated = getGoal(conversationId);
  const exceededBudget = Boolean(updated?.tokenBudget && tokensUsed >= updated.tokenBudget);
  notify(conversationId, updated);
  return { goal: updated, exceededBudget };
}

export function clearGoal(conversationId: number): void {
  db.delete(agentGoals).where(eq(agentGoals.conversationId, conversationId)).run();
  notify(conversationId, null);
}

/** 目标的一句话进度（界面与轨迹里都用它，别处不要再拼一遍）。 */
export function describeGoal(goal: AgentGoal): string {
  const parts = [`目标：${goal.objective}`, `状态：${goal.status}`];
  parts.push(goal.tokenBudget ? `已用 ${goal.tokensUsed} / ${goal.tokenBudget} tokens` : `已用 ${goal.tokensUsed} tokens`);
  if (goal.secondsUsed > 0) parts.push(`已运行 ${Math.round(goal.secondsUsed / 60)} 分钟`);
  parts.push(`自动续跑 ${goal.continuations} / ${maxGoalContinuations()} 次`);
  return parts.join("；");
}

/**
 * 目标段落：进系统提示。
 *
 * 完成标准那几句是**刻意写死的**，它们解决的是自主循环最典型的失败模式：
 * 模型跑到预算见底就把"我做了很多"当成"我做到了"。OMP 的写法值得逐条照抄。
 */
export function goalPromptSection(conversationId: number): string | null {
  const goal = getGoal(conversationId);
  if (!goal || isTerminal(goal.status)) return null;
  return [
    "## 当前目标（Goal 模式）",
    "",
    `**目标**：${goal.objective}`,
    goal.acceptance ? `**验收标准**：${goal.acceptance}` : "**验收标准**：（尚未明确 —— 先用 ask_user 与用户对齐，再写进 goal 工具）",
    `**进度**：${describeGoal(goal)}`,
    "",
    "这个目标由你自主推进，回合结束后会自动继续，直到达成或撞上预算。",
    "",
    "**什么算达成**（必须逐条核对，不要凭感觉）：",
    "- 逐项对照目标里说好的交付物，**对照当前真实状态**核验，不是对照你打算做什么；",
    "- 验证范围必须等于声明范围：只验证了一部分就不能说全部完成；",
    "- 任何一处不确定 = 还没达成 —— 不确定就继续查，不要写成「应该没问题」；",
    "- **预算快用完了不等于任务完成了**，那只是时间到了；",
    "- 确实达成时调用 `goal` 工具的 complete，并在 outcome 里列出证据（文件 / 命令 / 输出）；",
    "- 做不到就调用 abandon 说明卡在哪，不要为了收尾而谎报完成。",
  ].join("\n");
}

/** 自动续跑时作为"用户消息"推给模型的内容。 */
export function goalContinuationText(goal: AgentGoal): string {
  return [
    `（系统自动继续 —— 目标「${goal.objective}」尚未完成。）`,
    "",
    "接着推进：下一步做最该做的那件事，不要复述已经做过的部分。",
    goal.acceptance ? `验收标准：${goal.acceptance}` : "如果验收标准还不清楚，先用 ask_user 问清楚再继续。",
    "认为已经达成 → 调用 goal 工具 complete 并给出证据；做不到 → 调用 abandon 说明卡在哪。",
  ].join("\n");
}
