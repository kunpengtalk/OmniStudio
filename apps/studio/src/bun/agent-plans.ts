/**
 * Plan 模式的方案（计划落盘 + 批准 + 交接）。
 *
 * 之前 Plan 模式是"只读 + 让模型把方案写在正文里"，问题是：
 * 1. 方案**不落盘**，切回 Agent 模式后模型手里没有那份方案 —— 只能去历史正文里捞；
 * 2. 没有**批准**这个动作，"看方案 → 同意 → 执行"这条链路是断的；
 * 3. 为了"绝不写文件"，它连计划都存不下来 —— 而写一份计划本身并不危险。
 *
 * 现在的形态（对齐 OMP 的 local:// 计划文件 + xd://propose 批准）：
 * - Plan 模式**只能写这一个东西**：`write_plan` 工具把方案写到数据目录下的
 *   `plans/<会话>.md`（工作区一行都不碰），并登记成产出物，右侧面板可直接预览；
 * - 用户在时间线里点「批准并执行」→ 切到 Agent 模式，把方案正文作为执行轮的任务描述；
 * - 批准过的方案还会进子智能体的开场上下文：派出去干活的那一片也知道整体计划长什么样，
 *   不必让主 Agent 再复述一遍（这正是 OMP 的 plan handoff 做的事）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";

import { db } from "./db";
import { agentPlans } from "./db/schema";
import { getDataDir } from "./paths";
import { recordArtifact } from "./agent-artifacts";
import { logEvent } from "./app-log";

export type AgentPlan = {
  conversationId: number;
  content: string;
  messageId: number | null;
  filePath: string | null;
  approvedAt: number | null;
  createdAt: number | null;
  updatedAt: number | null;
};

type Listener = (payload: { conversationId: number; plan: AgentPlan | null }) => void;
const listeners = new Set<Listener>();

export function onPlanChanged(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function notify(conversationId: number, plan: AgentPlan | null): void {
  for (const listener of listeners) listener({ conversationId, plan });
}

function toPlan(row: typeof agentPlans.$inferSelect): AgentPlan {
  return {
    conversationId: row.conversationId,
    content: row.content,
    messageId: row.messageId ?? null,
    filePath: row.filePath ?? null,
    approvedAt: row.approvedAt ?? null,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

/** 方案落盘目录：数据目录下的 plans/（**不在工作区里**，Plan 模式不该碰工作区）。 */
export function plansDir(): string {
  return getDataDir("plans");
}

export function planFilePath(conversationId: number): string {
  return path.join(plansDir(), `${conversationId}.md`);
}

export function getPlan(conversationId: number): AgentPlan | null {
  const row = db.select().from(agentPlans).where(eq(agentPlans.conversationId, conversationId)).get();
  return row ? toPlan(row) : null;
}

/**
 * 写入（或覆盖）方案。
 *
 * 同时做三件事：落盘 → 登记产出物（右侧面板可预览）→ 写库（供批准与交接）。
 * 产出物登记用的是**绝对路径**：它在数据目录里、不在工作区里，
 * 而产出物面板读的就是绝对路径（`/artifact/<id>` 走的是同一条读路径）。
 */
export function savePlan(
  conversationId: number,
  input: { content: string; messageId?: number | null; workspace?: string },
): AgentPlan {
  const content = input.content.trim();
  mkdirSync(plansDir(), { recursive: true });
  const filePath = planFilePath(conversationId);
  writeFileSync(filePath, content, "utf8");

  const existing = getPlan(conversationId);
  if (existing) {
    // 重新写方案 = 之前那次批准作废：内容变了，不能算"用户已经同意过"。
    db.update(agentPlans)
      .set({ content, messageId: input.messageId ?? null, filePath, approvedAt: null })
      .where(eq(agentPlans.conversationId, conversationId))
      .run();
  } else {
    db.insert(agentPlans).values({ conversationId, content, messageId: input.messageId ?? null, filePath }).run();
  }
  try {
    recordArtifact({
      conversationId,
      messageId: input.messageId ?? null,
      filePath,
      workspace: input.workspace ?? plansDir(),
      tool: "write_plan",
    });
  } catch (error) {
    // 产出物登记失败不该让"写方案"这一步失败：文件已经落盘了。但必须留痕 ——
    // 不留的话现象是"方案写出来了，右侧产出物面板里却没有"，事后没有任何线索可查。
    logEvent({
      level: "warn",
      source: "agent",
      event: "agent.plan.artifact_failed",
      message: `方案已落盘但登记产出物失败：${error instanceof Error ? error.message : String(error)}`,
      detail: { conversationId, filePath },
    });
  }
  const plan = getPlan(conversationId)!;
  notify(conversationId, plan);
  return plan;
}

/** 用户批准这份方案。没有方案 / 方案为空时返回原因，不抛错。 */
export function approvePlan(conversationId: number): { ok: boolean; plan?: AgentPlan; error?: string } {
  const plan = getPlan(conversationId);
  if (!plan) return { ok: false, error: "这个会话还没有方案（先在 Plan 模式里让它写一份）。" };
  if (!plan.content.trim()) return { ok: false, error: "方案是空的，没什么可执行的。" };
  db.update(agentPlans)
    .set({ approvedAt: Date.now() })
    .where(eq(agentPlans.conversationId, conversationId))
    .run();
  const approved = getPlan(conversationId)!;
  notify(conversationId, approved);
  return { ok: true, plan: approved };
}

export function clearPlan(conversationId: number): void {
  const filePath = planFilePath(conversationId);
  try {
    if (existsSync(filePath)) rmSync(filePath);
  } catch {
    // 文件删不掉不影响清库：宁可留一个孤儿文件，也不要让"清空会话"报错。
  }
  db.delete(agentPlans).where(eq(agentPlans.conversationId, conversationId)).run();
  notify(conversationId, null);
}

/** 批准过的方案正文（没批准过返回 null）—— 交给执行轮或子智能体。 */
export function approvedPlanContent(conversationId: number): string | null {
  const plan = getPlan(conversationId);
  if (!plan || !plan.approvedAt || !plan.content.trim()) return null;
  return plan.content;
}

/** 从磁盘把方案读回来（用户可能手工编辑过那个 md 文件）。 */
export function readPlanFile(conversationId: number): string | null {
  const filePath = planFilePath(conversationId);
  try {
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * 子智能体的计划上下文（对齐 OMP 的 plan handoff）。
 *
 * 派出去的那一片只知道自己的子任务，不知道整体计划；把批准过的计划带上，
 * 它才不会做出与整体方案冲突的局部决定（比如改了主计划里不打算动的文件）。
 */
export function planHandoffSection(conversationId: number): string | null {
  const plan = approvedPlanContent(conversationId);
  if (!plan) return null;
  return [
    "",
    "## 已批准的整体方案（供你对照，不要偏离）",
    "",
    "主 Agent 与用户已经就下面这份方案达成一致，你负责的是其中一片：",
    "",
    plan,
    "",
    "如果你的子任务与方案冲突，以你的任务说明为准，并在结论里说明冲突在哪。",
  ].join("\n");
}
