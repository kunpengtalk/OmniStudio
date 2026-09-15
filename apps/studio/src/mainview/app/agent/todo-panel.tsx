import { useState } from "react";
import { CheckCircle2Icon, ChevronDownIcon, CircleIcon, CircleDotIcon, ListTodoIcon, XCircleIcon } from "lucide-react";

import { useAgentStore } from "@stores/agent";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import type { TodoItem, TodoStatus } from "../../../bun/agent-todos";

/** 状态色只能取 --ds-*：卡片是浮层，跟消息流共用一套灰阶才不打架。 */
const STATUS_TONE: Record<TodoStatus, string> = {
  completed: "var(--ds-success)",
  in_progress: "var(--ds-text-primary)",
  cancelled: "var(--ds-text-faint)",
  pending: "var(--ds-text-faint)",
};

function TodoRow({ todo }: { todo: TodoItem }) {
  const t = useT();
  const icon =
    todo.status === "completed" ? (
      <CheckCircle2Icon className="size-3.5" />
    ) : todo.status === "in_progress" ? (
      <CircleDotIcon className="size-3.5" />
    ) : todo.status === "cancelled" ? (
      <XCircleIcon className="size-3.5" />
    ) : (
      <CircleIcon className="size-3.5" />
    );
  return (
    <div className="flex items-start gap-1.5">
      <span className="mt-0.5 shrink-0" style={{ color: STATUS_TONE[todo.status] }} aria-hidden>
        {icon}
      </span>
      <span
        className={cn(
          "composer-panel-text",
          todo.status === "completed" && "done",
          todo.status === "cancelled" && "cancelled",
        )}
      >
        {todo.content}
      </span>
      {todo.priority === "high" && todo.status !== "completed" && (
        <span className="composer-panel-pill error">{t("agent.todo.high")}</span>
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
    <div className="composer-panel collapsible">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="composer-panel-head"
      >
        <ListTodoIcon className="size-3.5" aria-hidden />
        <span className="font-medium">{t("agent.todo.title")}</span>
        <span className="tabular-nums">
          {completed}/{active.length}
        </span>
        <span className="composer-panel-bar">
          <i style={{ width: `${active.length ? (completed / active.length) * 100 : 0}%` }} />
        </span>
        <ChevronDownIcon className={cn("ml-auto size-3 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="composer-panel-body">
          <div className="composer-panel-scroll space-y-1">
            {todos.map((todo) => (
              <TodoRow key={todo.id} todo={todo} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
