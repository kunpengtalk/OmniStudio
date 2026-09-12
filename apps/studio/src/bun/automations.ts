/**
 * 自动化任务（对齐 OpenWork Automations）：
 * 按 once / daily / weekly 计划在指定工作区自动跑一次 Agent，结果落成一条会话，
 * 用户事后能点开看完整轨迹（谁在什么时候跑了什么、产出了什么）。
 *
 * 计划计算是纯函数（支持 IANA 时区，含 DST 处理），调度靠一个 30 秒的巡检查询，
 * 不引入 job 队列：单机桌面应用同时到点的任务只有几个。
 */
import { and, asc, desc, eq, lte } from "drizzle-orm";

import { db } from "./db";
import { automationRuns, automations, conversations, messages } from "./db/schema";
import { getChatBaseUrl } from "./chat";
import { getChatModelLabel } from "./chat-model";
import { createConversation, getHistory } from "./chat";
import { runAgentTurn } from "./agent";
import { notify } from "./notifications";
import type { AgentMode } from "./agent";

export type ScheduleKind = "once" | "daily" | "weekly";

export type AutomationSchedule =
  | { at: string }
  | { hour: number; minute: number }
  | { hour: number; minute: number; daysOfWeek: number[] };

export type AutomationItem = {
  id: number;
  name: string;
  instructions: string;
  workspace: string;
  enabled: boolean;
  scheduleKind: ScheduleKind;
  schedule: AutomationSchedule;
  timezone: string;
  mode: AgentMode;
  lastRunAt: number | null;
  nextRunAt: number | null;
  createdAt: number;
  /** 最近一次运行的状态（列表里直接展示）。 */
  lastStatus: "running" | "succeeded" | "failed" | "cancelled" | null;
};

export type AutomationRunItem = {
  id: number;
  automationId: number;
  trigger: "scheduled" | "manual";
  status: "running" | "succeeded" | "failed" | "cancelled";
  conversationId: number | null;
  summary: string | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
};

// ---------------------------------------------------------------------------
// 时区与计划计算（纯函数，可单测）
// ---------------------------------------------------------------------------

/** 某时刻在指定时区的 UTC 偏移（毫秒）。 */
export function timezoneOffsetMs(ts: number, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = formatter.formatToParts(new Date(ts));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const hour = get("hour") % 24; // Intl 在午夜可能给 24
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return asUtc - (ts - (ts % 1000));
}

/** 把「某时区的墙上时间」换算成 UTC 时间戳（两轮逼近，足以处理 DST）。 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - timezoneOffsetMs(guess, timezone);
  const second = guess - timezoneOffsetMs(first, timezone);
  return second;
}

/** 某时区里该时间戳的「年月日 + 星期」。 */
export function zonedParts(
  ts: number,
  timezone: string,
): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const parts = formatter.formatToParts(new Date(ts));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    weekday: Math.max(0, weekdays.indexOf(get("weekday"))),
  };
}

/**
 * 下一次触发时间（毫秒）。
 * - once：`at`（ISO 字符串）本身；已过去则返回 null（跑过一次就结束）。
 * - daily：今天该时区的 hour:minute，已过则推到明天。
 * - weekly：最近一个命中 daysOfWeek 的那天。
 */
export function computeNextRun(
  kind: ScheduleKind,
  schedule: AutomationSchedule,
  timezone: string,
  from = Date.now(),
): number | null {
  if (kind === "once") {
    const at = "at" in schedule ? Date.parse(schedule.at) : Number.NaN;
    if (!Number.isFinite(at)) return null;
    return at > from ? at : null;
  }
  const hour = "hour" in schedule ? schedule.hour : 0;
  const minute = "minute" in schedule ? schedule.minute : 0;
  const days = kind === "weekly" && "daysOfWeek" in schedule ? schedule.daysOfWeek : [];
  // 从「当前时刻在该时区的墙上日期」出发，逐日试探（最多 8 天覆盖整周）。
  const start = zonedParts(from, timezone);
  for (let offset = 0; offset <= 8; offset += 1) {
    const probe = zonedTimeToUtc(start.year, start.month, start.day, 12, 0, timezone) + offset * 86_400_000;
    const parts = zonedParts(probe, timezone);
    if (kind === "weekly" && days.length > 0 && !days.includes(parts.weekday)) continue;
    const candidate = zonedTimeToUtc(parts.year, parts.month, parts.day, hour, minute, timezone);
    if (candidate > from) return candidate;
  }
  return null;
}

/** 人类可读的计划描述（UI 列表用）。 */
export function describeSchedule(kind: ScheduleKind, schedule: AutomationSchedule): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  if (kind === "once") {
    const at = "at" in schedule ? Date.parse(schedule.at) : Number.NaN;
    return Number.isFinite(at) ? `仅一次 · ${new Date(at).toLocaleString("zh-CN")}` : "仅一次";
  }
  const time = `${pad("hour" in schedule ? schedule.hour : 0)}:${pad("minute" in schedule ? schedule.minute : 0)}`;
  if (kind === "daily") return `每天 ${time}`;
  const names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const days = "daysOfWeek" in schedule ? [...schedule.daysOfWeek].sort() : [];
  return `每周 ${days.map((day) => names[day] ?? "").filter(Boolean).join("、")} ${time}`;
}

// ---------------------------------------------------------------------------
// 存取
// ---------------------------------------------------------------------------

type Listener = () => void;
const listeners = new Set<Listener>();

export function onAutomationsChanged(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function emitChanged() {
  for (const cb of listeners) cb();
}

function parseSchedule(raw: string): AutomationSchedule {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as AutomationSchedule) : { hour: 9, minute: 0 };
  } catch {
    return { hour: 9, minute: 0 };
  }
}

function toItem(row: typeof automations.$inferSelect, lastStatus: AutomationItem["lastStatus"] = null): AutomationItem {
  return {
    id: row.id,
    name: row.name,
    instructions: row.instructions,
    workspace: row.workspace,
    enabled: row.enabled === 1,
    scheduleKind: row.scheduleKind,
    schedule: parseSchedule(row.schedule),
    timezone: row.timezone,
    mode: row.mode,
    lastRunAt: row.lastRunAt,
    nextRunAt: row.nextRunAt,
    createdAt: row.createdAt ?? Date.now(),
    lastStatus,
  };
}

export function listAutomations(): AutomationItem[] {
  const rows = db.select().from(automations).orderBy(desc(automations.id)).all();
  return rows.map((row) => {
    const lastRun = db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.automationId, row.id))
      .orderBy(desc(automationRuns.id))
      .limit(1)
      .all()[0];
    return toItem(row, lastRun?.status ?? null);
  });
}

export function getAutomation(id: number): AutomationItem | null {
  const row = db.select().from(automations).where(eq(automations.id, id)).get();
  return row ? toItem(row) : null;
}

export function createAutomation(input: {
  name: string;
  instructions: string;
  workspace: string;
  scheduleKind: ScheduleKind;
  schedule: AutomationSchedule;
  timezone: string;
  mode?: AgentMode;
  enabled?: boolean;
}): AutomationItem {
  const nextRunAt = computeNextRun(input.scheduleKind, input.schedule, input.timezone);
  const inserted = db
    .insert(automations)
    .values({
      name: input.name.trim() || "未命名自动化",
      instructions: input.instructions.trim(),
      workspace: input.workspace,
      enabled: input.enabled === false ? 0 : 1,
      scheduleKind: input.scheduleKind,
      schedule: JSON.stringify(input.schedule),
      timezone: input.timezone || "UTC",
      mode: input.mode ?? "agent",
      nextRunAt,
    })
    .returning()
    .get();
  emitChanged();
  return toItem(inserted);
}

export function updateAutomation(
  id: number,
  patch: {
    name?: string;
    instructions?: string;
    workspace?: string;
    scheduleKind?: ScheduleKind;
    schedule?: AutomationSchedule;
    timezone?: string;
    mode?: AgentMode;
    enabled?: boolean;
  },
): AutomationItem | null {
  const existing = db.select().from(automations).where(eq(automations.id, id)).get();
  if (!existing) return null;
  const scheduleKind = patch.scheduleKind ?? existing.scheduleKind;
  const schedule = patch.schedule ?? parseSchedule(existing.schedule);
  const timezone = patch.timezone ?? existing.timezone;
  db.update(automations)
    .set({
      ...(patch.name !== undefined ? { name: patch.name.trim() || existing.name } : {}),
      ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
      ...(patch.workspace !== undefined ? { workspace: patch.workspace } : {}),
      ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled ? 1 : 0 } : {}),
      scheduleKind,
      schedule: JSON.stringify(schedule),
      timezone,
      // 改了计划就重算下次触发；重新启用时也重算（可能已经过期很久）。
      nextRunAt:
        patch.enabled === false ? null : computeNextRun(scheduleKind, schedule, timezone) ?? null,
    })
    .where(eq(automations.id, id))
    .run();
  emitChanged();
  return getAutomation(id);
}

export function deleteAutomation(id: number): void {
  db.delete(automationRuns).where(eq(automationRuns.automationId, id)).run();
  db.delete(automations).where(eq(automations.id, id)).run();
  emitChanged();
}

export function listAutomationRuns(automationId?: number, limit = 50): AutomationRunItem[] {
  const query = db.select().from(automationRuns);
  const rows = (automationId === undefined
    ? query.orderBy(desc(automationRuns.id)).limit(limit).all()
    : query
        .where(eq(automationRuns.automationId, automationId))
        .orderBy(desc(automationRuns.id))
        .limit(limit)
        .all()) as (typeof automationRuns.$inferSelect)[];
  return rows.map((row) => ({
    id: row.id,
    automationId: row.automationId,
    trigger: row.trigger,
    status: row.status,
    conversationId: row.conversationId,
    summary: row.summary,
    error: row.error,
    startedAt: row.startedAt ?? Date.now(),
    finishedAt: row.finishedAt,
  }));
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

/** 正在跑的自动化（避免同一任务并发执行 / 重复触发）。 */
const runningAutomations = new Set<number>();

export function isAutomationRunning(id: number): boolean {
  return runningAutomations.has(id);
}

export type AutomationRunResult = { ok: boolean; runId: number; conversationId: number | null; error?: string };

/**
 * 跑一次自动化：开一条会话 → 执行 Agent 回合 → 写运行记录。
 * 会话是真实会话，所以用户能在侧栏点开、继续追问、看到产出物。
 */
export async function runAutomation(id: number, trigger: "scheduled" | "manual" = "manual"): Promise<AutomationRunResult> {
  const automation = getAutomation(id);
  if (!automation) return { ok: false, runId: -1, conversationId: null, error: "Automation not found" };
  if (runningAutomations.has(id)) {
    return { ok: false, runId: -1, conversationId: null, error: "该自动化正在运行中" };
  }
  // 用统一的模型解析：本地模式下"已启动实例"也算有模型，
  // 只看 CHAT_MODEL 设置会把"本地起好了但没设默认模型"误判成不可用。
  if (!getChatBaseUrl() || !getChatModelLabel()) {
    const failure = "没有可用的模型或推理服务";
    const run = db
      .insert(automationRuns)
      .values({ automationId: id, trigger, status: "failed", error: failure })
      .returning()
      .get();
    db.update(automations)
      .set({ lastRunAt: Date.now(), nextRunAt: computeNextRun(automation.scheduleKind, automation.schedule, automation.timezone) })
      .where(eq(automations.id, id))
      .run();
    // 没跑起来也要通知：否则用户完全不知道计划任务一直在失败。
    notify({
      kind: "error",
      title: `自动化失败：${automation.name}`,
      body: failure,
      conversationId: null,
    });
    emitChanged();
    return { ok: false, runId: run.id, conversationId: null, error: failure };
  }

  runningAutomations.add(id);
  const startedAt = Date.now();
  const run = db
    .insert(automationRuns)
    .values({ automationId: id, trigger, status: "running", startedAt })
    .returning()
    .get();

  // 会话落在自动化自己的工作区上，标题带任务名，便于在侧栏辨认。
  const conversation = createConversation(`自动化：${automation.name}`, "agent");
  db.update(conversations)
    .set({ workspace: automation.workspace })
    .where(eq(conversations.id, conversation.id))
    .run();

  let error: string | undefined;
  try {
    const result = await runAgentTurn({
      conversationId: conversation.id,
      content: automation.instructions,
      mode: automation.mode,
      workspace: automation.workspace,
      // 无人值守：需要澄清时不会干等 10 分钟，而是让模型自己选合理默认继续。
      headless: true,
    });
    if (!result.ok) error = result.error ?? "运行失败";
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    runningAutomations.delete(id);
  }

  // 摘要取本次会话最后一条助手消息（跑完就能在列表里看到结论）。
  const history = getHistory(conversation.id);
  const lastAssistant = [...history].reverse().find((message) => message.role === "assistant");
  const summary = lastAssistant?.content?.slice(0, 4000) ?? null;

  db.update(automationRuns)
    .set({
      status: error ? "failed" : "succeeded",
      conversationId: conversation.id,
      summary,
      error: error ?? null,
      finishedAt: Date.now(),
    })
    .where(eq(automationRuns.id, run.id))
    .run();

  db.update(automations)
    .set({
      lastRunAt: Date.now(),
      nextRunAt: computeNextRun(automation.scheduleKind, automation.schedule, automation.timezone),
      // 一次性任务跑完就自动关闭，避免下次启动又触发。
      ...(automation.scheduleKind === "once" ? { enabled: 0 } : {}),
    })
    .where(eq(automations.id, id))
    .run();

  if (trigger === "scheduled") {
    notify({
      kind: error ? "error" : "automation",
      title: error ? `自动化失败：${automation.name}` : `自动化完成：${automation.name}`,
      body: (error ?? summary ?? "").replace(/\s+/g, " ").slice(0, 200),
      conversationId: conversation.id,
    });
  }

  emitChanged();
  return { ok: !error, runId: run.id, conversationId: conversation.id, error };
}

/** 巡检是否正在跑：一次巡检可能持续几分钟（任务本身在跑），不允许重入。 */
let ticking = false;

/** 巡检：找出到点的任务并逐个执行（串行，避免同时压垮本地推理服务）。 */
export async function tickAutomations(now = Date.now()): Promise<number> {
  // 30 秒一跳，但一个任务可能要跑几分钟：上一跳没结束时直接跳过这一跳，
  // 否则会同时在跑的巡检查到同一个到点任务（虽然 runningAutomations 会兜住，但日志会很乱）。
  if (ticking) return 0;
  ticking = true;
  try {
    return await tickAutomationsInner(now);
  } finally {
    ticking = false;
  }
}

async function tickAutomationsInner(now: number): Promise<number> {
  const due = db
    .select()
    .from(automations)
    .where(and(eq(automations.enabled, 1), lte(automations.nextRunAt, now)))
    .orderBy(asc(automations.nextRunAt))
    .all();
  let executed = 0;
  for (const row of due) {
    if (runningAutomations.has(row.id)) continue;
    if (!row.nextRunAt) continue;
    // 错过太久（应用没开）的任务不补跑历史，直接顺延到下一个点。
    const stale = now - row.nextRunAt > 6 * 60 * 60 * 1000;
    if (stale && row.scheduleKind !== "once") {
      const next = computeNextRun(row.scheduleKind, parseSchedule(row.schedule), row.timezone, now);
      db.update(automations)
        .set({ nextRunAt: next ?? null, lastRunAt: row.nextRunAt })
        .where(eq(automations.id, row.id))
        .run();
      continue;
    }
    await runAutomation(row.id, "scheduled");
    executed += 1;
  }
  return executed;
}

let ticker: ReturnType<typeof setInterval> | null = null;

/** 启动调度巡检（应用启动时调用一次；重复调用无副作用）。 */
export function startAutomationScheduler(intervalMs = 30_000): void {
  if (ticker) return;
  ticker = setInterval(() => {
    void tickAutomations().catch(() => {
      // 巡检失败不致命：下一轮会重试
    });
  }, intervalMs);
}

export function stopAutomationScheduler(): void {
  if (ticker) clearInterval(ticker);
  ticker = null;
}

/** 自动化会话里 agent 产出的最后一条消息（供 UI 直接展示结果）。 */
export function lastAssistantMessage(conversationId: number): string | null {
  const rows = db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.id))
    .limit(5)
    .all();
  return rows.find((row) => row.role === "assistant")?.content ?? null;
}
