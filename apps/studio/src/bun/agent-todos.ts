/**
 * Agent 待办清单（OpenWork TodoPanel 的落库版）：
 * 会话里 agent 用 todo_write 全量覆盖清单，UI 在输入框上方实时展示进度。
 */
import { asc, eq } from "drizzle-orm";

import { db } from "./db";
import { agentTodos } from "./db/schema";

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";
export type TodoPriority = "high" | "medium" | "low";

export type TodoItem = {
  id: number;
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
};

export type TodoInput = {
  content: string;
  status?: TodoStatus;
  priority?: TodoPriority;
};

export type TodoRow = typeof agentTodos.$inferSelect;

type Listener = (payload: { conversationId: number; todos: TodoItem[] }) => void;
const listeners = new Set<Listener>();

export function onTodosChanged(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function listTodos(conversationId: number): TodoItem[] {
  return db
    .select()
    .from(agentTodos)
    .where(eq(agentTodos.conversationId, conversationId))
    .orderBy(asc(agentTodos.seq), asc(agentTodos.id))
    .all()
    .map((row) => ({
      id: row.id,
      content: row.content,
      status: row.status,
      priority: row.priority,
    }));
}

const STATUSES: TodoStatus[] = ["pending", "in_progress", "completed", "cancelled"];
const PRIORITIES: TodoPriority[] = ["high", "medium", "low"];

function normalizeStatus(value: unknown): TodoStatus {
  return STATUSES.includes(value as TodoStatus) ? (value as TodoStatus) : "pending";
}
function normalizePriority(value: unknown): TodoPriority {
  return PRIORITIES.includes(value as TodoPriority) ? (value as TodoPriority) : "medium";
}

/** 全量覆盖写入：agent 每次 todo_write 都给出完整清单（与 OpenWork 一致）。 */
export function writeTodos(conversationId: number, todos: TodoInput[]): TodoItem[] {
  const cleaned = todos
    .map((todo) => ({
      content: typeof todo?.content === "string" ? todo.content.trim() : "",
      status: normalizeStatus(todo?.status),
      priority: normalizePriority(todo?.priority),
    }))
    .filter((todo) => todo.content.length > 0);

  db.delete(agentTodos).where(eq(agentTodos.conversationId, conversationId)).run();
  cleaned.forEach((todo, index) => {
    db.insert(agentTodos)
      .values({
        conversationId,
        seq: index,
        content: todo.content.slice(0, 500),
        status: todo.status,
        priority: todo.priority,
      })
      .run();
  });

  const items = listTodos(conversationId);
  for (const cb of listeners) cb({ conversationId, todos: items });
  return items;
}

export function clearTodos(conversationId: number): void {
  db.delete(agentTodos).where(eq(agentTodos.conversationId, conversationId)).run();
  for (const cb of listeners) cb({ conversationId, todos: [] });
}

/** 进度摘要（"3/7"），供 UI 与自动化结果摘要使用。 */
export function todoProgress(conversationId: number): { completed: number; total: number } {
  const todos = listTodos(conversationId);
  const active = todos.filter((todo) => todo.status !== "cancelled");
  return { completed: active.filter((todo) => todo.status === "completed").length, total: active.length };
}
