import { useState } from "react";
import { CheckCircle2Icon, ChevronDownIcon, CircleIcon, CircleDotIcon, ListTodoIcon, XCircleIcon } from "lucide-react";

import { useAgentStore } from "@stores/agent";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import type { TodoItem } from "../../../bun/agent-todos";

function TodoRow({ todo }: { todo: TodoItem }) {
  const t = useT();
  const icon =
    todo.status === "completed" ? (
      <CheckCircle2Icon className="size-3.5 text-emerald-600" />
    ) : todo.status === "in_progress" ? (
      <CircleDotIcon className="size-3.5 text-primary" />
    ) : todo.status === "cancelled" ? (
      <XCircleIcon className="size-3.5 text-muted-foreground/50" />
    ) : (
      <CircleIcon className="size-3.5 text-muted-foreground/50" />
    );
  return (
    <div className="flex items-start gap-1.5">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span
        className={cn(
          "min-w-0 flex-1 text-[11px] leading-4",
          todo.status === "completed" && "text-muted-foreground line-through",
          todo.status === "cancelled" && "text-muted-foreground/60 line-through",
        )}
      >
        {todo.content}
      </span>
      {todo.priority === "high" && todo.status !== "completed" && (
        <span className="shrink-0 rounded bg-destructive/10 px-1 text-[9px] text-destructive">
          {t("agent.todo.high")}
        </span>
      )}
    </div>
  );
}

/**
 * 待办进度面板（对齐 OpenWork 的 TodoPanel）：
 * 贴在输入框上方，默认展开；agent 每更新一次清单就实时反映进度。
 */
export function AgentTodoPanel() {
  const t = useT();
  const todos = useAgentStore((s) => s.todos);
  const [open, setOpen] = useState(true);

  const active = todos.filter((todo) => todo.status !== "cancelled");
  if (active.length === 0) return null;
  const completed = active.filter((todo) => todo.status === "completed").length;

  return (
    <div className="overflow-hidden rounded-xl border bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ListTodoIcon className="size-3.5" />
        <span className="font-medium">{t("agent.todo.title")}</span>
        <span className="tabular-nums">
          {completed}/{active.length}
        </span>
        <div className="ml-1 h-1 w-16 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${active.length ? (completed / active.length) * 100 : 0}%` }}
          />
        </div>
        <ChevronDownIcon className={cn("ml-auto size-3 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="space-y-1 border-t px-3 py-2">
          {todos.map((todo) => (
            <TodoRow key={todo.id} todo={todo} />
          ))}
        </div>
      )}
    </div>
  );
}
