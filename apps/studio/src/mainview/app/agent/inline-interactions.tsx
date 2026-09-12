import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronDownIcon,
  Loader2Icon,
  MessageCircleQuestionIcon,
  ShieldCheckIcon,
  XIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { useAgentStore, type PermissionReply } from "@stores/agent";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import type { PendingPermission, QuestionPrompt } from "../../../bun/agent-interactions";
import type { PermissionRequest } from "../../../bun/permissions";
import type { AgentEventRow } from "../../../bun/agent";

const PERMISSION_LABEL: Record<string, string> = {
  bash: "执行命令",
  edit: "修改文件",
  read: "读取文件",
  external_directory: "访问工作区之外",
  webfetch: "抓取网页",
  websearch: "联网搜索",
  mcp: "调用外部工具",
  media: "生成媒体",
  task: "派发子任务",
  doom_loop: "重复调用保护",
};

/** 从事件里解出授权请求（请求事件与结果事件都带 id）。 */
type PermissionAsk = PermissionRequest & { id: string; tool?: string };

function parseAsk(event: AgentEventRow): PermissionAsk | null {
  if (!event.args) return null;
  try {
    const parsed = JSON.parse(event.args) as PermissionAsk;
    return parsed?.id ? parsed : null;
  } catch {
    return null;
  }
}

function parseMeta(event: AgentEventRow): { id?: string; reply?: PermissionReply; answers?: string[][] } {
  if (!event.args) return {};
  try {
    return JSON.parse(event.args) as { id?: string; reply?: PermissionReply; answers?: string[][] };
  } catch {
    return {};
  }
}

/**
 * 授权确认卡片（消息流内）：
 * 未应答时是带按钮的卡片，悬在该条消息下方；应答后收成一行记录留在流里，
 * 回看历史还能看到「当时问了什么、怎么答的」。
 */
export function InlinePermissionCard({
  askEvent,
  settleEvent,
}: {
  askEvent: AgentEventRow;
  /** 同 id 的结果事件；为空表示还没应答。 */
  settleEvent?: AgentEventRow;
}) {
  const t = useT();
  const asks = useMemo(() => parseAsk(askEvent), [askEvent]);
  const settled = settleEvent ? parseMeta(settleEvent) : null;
  const [open, setOpen] = useState(false);

  // 还挂在主进程里等应答的请求（切会话 / 重连后依然能恢复）。
  const pending: PendingPermission | undefined = useAgentStore((s) =>
    asks ? s.permissions.find((item) => item.id === asks.id) : undefined,
  );
  const isPending = Boolean(pending) && !settled;

  const respond = useMutation({
    mutationFn: ({ id, reply }: { id: string; reply: PermissionReply }) =>
      rpcClient.respondAgentPermission({ id, reply }),
    onSuccess: (_data, variables) => {
      useAgentStore.getState().settlePermission(variables.id);
    },
  });

  if (!asks) return null;

  const label = PERMISSION_LABEL[asks.permission] ?? asks.permission;
  const isDoomLoop = asks.permission === "doom_loop";

  // 已应答：收成一行，点开看详情。
  if (!isPending) {
    const reply = settled?.reply ?? "deny";
    const denied = reply === "deny";
    const text = settleEvent?.output ?? `${denied ? "已拒绝" : "已允许"}：${asks.permission} · ${asks.pattern}`;
    return (
      <div
        className={cn(
          "overflow-hidden rounded-xl border text-xs",
          denied ? "border-amber-500/30 bg-amber-500/5" : "border-emerald-500/25 bg-emerald-500/5",
        )}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px]"
        >
          <ShieldCheckIcon
            className={cn("size-3 shrink-0", denied ? "text-amber-600" : "text-emerald-600")}
          />
          <span className="min-w-0 flex-1 truncate">{text}</span>
          <ChevronDownIcon className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")} />
        </button>
        {open && (
          <div className="space-y-1 border-t bg-background/40 px-3 py-2 text-[11px]">
            <p className="text-muted-foreground">{asks.title}</p>
            {Object.entries(asks.detail ?? {}).map(([key, value]) => (
              <div key={key} className="flex gap-2">
                <span className="w-16 shrink-0 text-muted-foreground">{key}</span>
                <span className="min-w-0 flex-1 font-mono text-[11px] break-all">{String(value)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // 待应答：直接画在消息流里（不浮层遮挡输入框），用户就地确认。
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border bg-popover text-xs shadow-sm",
        isDoomLoop ? "border-amber-500/40" : "border-primary/30",
      )}
      data-permission-request={asks.permission}
    >
      <div className="flex items-start gap-2 border-b px-3 py-2">
        <div
          className={cn(
            "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md",
            isDoomLoop ? "bg-amber-500/15 text-amber-600" : "bg-primary/10 text-primary",
          )}
        >
          {isDoomLoop ? <AlertTriangleIcon className="size-3.5" /> : <ShieldCheckIcon className="size-3.5" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium">{asks.title}</p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {t("agent.permission.subtitle")} · {label}
            <span className="ml-1.5 rounded bg-muted px-1 font-mono">{asks.tool ?? asks.permission}</span>
          </p>
        </div>
      </div>

      <div className="space-y-1 px-3 py-2">
        {isDoomLoop && (
          <p className="rounded-md bg-amber-500/10 px-2 py-1.5 text-[10px] text-amber-700 dark:text-amber-400">
            {t("agent.permission.doomLoop")}
          </p>
        )}
        {Object.entries(asks.detail ?? {}).map(([key, value]) => (
          <div key={key} className="flex gap-2 text-[11px]">
            <span className="w-14 shrink-0 text-muted-foreground">{key}</span>
            <span className="min-w-0 flex-1 font-mono text-[10px] break-all">{String(value)}</span>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-t bg-muted/30 px-3 py-2">
        <Button
          variant="outline"
          size="sm"
          className="h-6 text-[11px]"
          disabled={respond.isPending}
          onClick={() => respond.mutate({ id: asks.id, reply: "deny" })}
        >
          <XIcon data-icon="inline-start" />
          {t("agent.permission.deny")}
        </Button>
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-[11px]"
            tooltip={t("agent.permission.workspaceHint")}
            disabled={respond.isPending}
            onClick={() => respond.mutate({ id: asks.id, reply: "workspace" })}
          >
            {t("agent.permission.workspace")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="h-6 text-[11px]"
            disabled={respond.isPending}
            onClick={() => respond.mutate({ id: asks.id, reply: "session" })}
          >
            {t("agent.permission.session")}
          </Button>
          <Button
            size="sm"
            className="h-6 text-[11px]"
            disabled={respond.isPending}
            onClick={() => respond.mutate({ id: asks.id, reply: "once" })}
          >
            {respond.isPending ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <CheckIcon data-icon="inline-start" />}
            {t("agent.permission.once")}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** 提问卡片（消息流内）：未答时就地选择 / 填写，答完收成一行记录。 */
export function InlineQuestionCard({
  askEvent,
  settleEvent,
}: {
  askEvent: AgentEventRow;
  settleEvent?: AgentEventRow;
}) {
  const t = useT();
  const parsed = useMemo(() => {
    if (!askEvent.args) return null;
    try {
      const value = JSON.parse(askEvent.args) as { id?: string; questions?: QuestionPrompt[] };
      return value.id && value.questions?.length ? { id: value.id, questions: value.questions } : null;
    } catch {
      return null;
    }
  }, [askEvent]);
  const settled = settleEvent ? parseMeta(settleEvent) : null;
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [custom, setCustom] = useState("");
  const [answers, setAnswers] = useState<string[][]>([]);
  const [open, setOpen] = useState(false);

  const pending = useAgentStore((s) =>
    parsed ? s.questions.find((item) => item.id === parsed.id) : undefined,
  );
  const isPending = Boolean(pending) && !settled;

  const respond = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: string[][] }) =>
      rpcClient.respondAgentQuestion({ id, answers: payload }),
    onSuccess: (_data, variables) => {
      useAgentStore.getState().settleQuestion(variables.id);
    },
  });

  if (!parsed) return null;
  const total = parsed.questions.length;
  const current = parsed.questions[Math.min(index, total - 1)]!;

  if (!isPending) {
    const answered = (settled?.answers ?? []).map((answer) => answer.join("、")).filter(Boolean);
    return (
      <div className="overflow-hidden rounded-xl border border-primary/20 bg-primary/5 text-xs">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px]"
        >
          <MessageCircleQuestionIcon className="size-3 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate">
            {settleEvent?.output ?? (answered.length > 0 ? `已回答：${answered.join(" / ")}` : "未作答")}
          </span>
          <ChevronDownIcon className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")} />
        </button>
        {open && (
          <div className="space-y-1 border-t bg-background/40 px-3 py-2 text-[11px]">
            {parsed.questions.map((question, questionIndex) => (
              <p key={questionIndex} className="text-muted-foreground">
                Q：{question.question}
                <span className="ml-1 text-foreground">
                  A：{(settled?.answers?.[questionIndex] ?? []).join("、") || "（未作答）"}
                </span>
              </p>
            ))}
          </div>
        )}
      </div>
    );
  }

  const commit = (answer: string[]) => {
    const next = [...answers];
    next[index] = answer.length > 0 ? answer : [t("agent.question.skipped")];
    if (index < total - 1) {
      setAnswers(next);
      setIndex(index + 1);
      setSelected([]);
      setCustom("");
      return;
    }
    respond.mutate({ id: parsed.id, payload: next });
  };

  const toggle = (label: string) => {
    if (current.multiple) {
      setSelected((prev) =>
        prev.includes(label) ? prev.filter((item) => item !== label) : [...prev, label],
      );
      return;
    }
    setSelected([label]);
    if (index < total - 1) setTimeout(() => commit([label]), 150);
  };

  return (
    <div className="overflow-hidden rounded-xl border border-primary/30 bg-popover text-xs shadow-sm">
      <div className="flex items-start gap-2 border-b px-3 py-2">
        <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <MessageCircleQuestionIcon className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium">{current.header || t("agent.question.title")}</p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {t("agent.question.progress", { current: String(index + 1), total: String(total) })}
          </p>
        </div>
      </div>
      <div className="space-y-2 px-3 py-2">
        <p className="text-[11px]">{current.question}</p>
        {current.options.length > 0 && (
          <div className="flex flex-col gap-1">
            {current.options.map((option) => {
              const active = selected.includes(option.label);
              return (
                <button
                  key={option.label}
                  type="button"
                  onClick={() => toggle(option.label)}
                  className={cn(
                    "rounded-lg border px-2 py-1.5 text-left transition-colors",
                    active ? "border-primary bg-primary/5" : "hover:bg-muted/60",
                  )}
                >
                  <span className="block text-[11px] font-medium">{option.label}</span>
                  {option.description && (
                    <span className="mt-0.5 block text-[10px] text-muted-foreground">
                      {option.description}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
        <Input
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              const answer = [...selected];
              if (custom.trim()) answer.push(custom.trim());
              commit(answer);
            }
          }}
          placeholder={t("agent.question.custom")}
          className="h-7 text-[11px]"
        />
      </div>
      <div className="flex items-center justify-end gap-1.5 border-t bg-muted/30 px-3 py-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-[11px]"
          disabled={respond.isPending}
          onClick={() => respond.mutate({ id: parsed.id, payload: [] })}
        >
          {t("agent.question.skip")}
        </Button>
        <Button
          size="sm"
          className="h-6 text-[11px]"
          disabled={respond.isPending}
          onClick={() => {
            const answer = [...selected];
            if (custom.trim()) answer.push(custom.trim());
            commit(answer);
          }}
        >
          {index < total - 1 ? t("agent.question.next") : t("agent.question.submit")}
        </Button>
      </div>
    </div>
  );
}
