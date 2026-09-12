import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeftIcon,
  FileDiffIcon,
  Loader2Icon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { useAgentStore } from "@stores/agent";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import { summarizeEdit } from "./timeline";
import { parseUnifiedDiff } from "../../../shared/diff";

/** git porcelain 的状态码 → 一个字母 + 配色。 */
const STATUS_STYLE: Record<string, { label: string; className: string }> = {
  M: { label: "M", className: "text-amber-600" },
  A: { label: "A", className: "text-emerald-600" },
  D: { label: "D", className: "text-destructive" },
  "??": { label: "U", className: "text-sky-600" },
  R: { label: "R", className: "text-violet-600" },
  C: { label: "C", className: "text-violet-600" },
  U: { label: "!", className: "text-destructive" },
};

function statusStyle(status: string) {
  const first = status[0] ?? "M";
  return STATUS_STYLE[status] ?? STATUS_STYLE[first] ?? STATUS_STYLE.M!;
}

/** 本会话改动（工作区不是 git 仓库时的回落）：从 agent 的写文件事件里取。 */
function useSessionChanges() {
  const events = useAgentStore((s) => s.events);
  return useMemo(() => {
    const files = new Map<string, { path: string; added: number; removed: number; tool: string }>();
    for (const event of events) {
      if (event.kind !== "tool_start") continue;
      if (event.toolName !== "write_file" && event.toolName !== "edit_file") continue;
      const summary = summarizeEdit(event.args);
      if (!summary) continue;
      let filePath = "";
      try {
        filePath = String((JSON.parse(event.args ?? "{}") as { path?: string }).path ?? "");
      } catch {
        filePath = "";
      }
      if (!filePath) continue;
      const existing = files.get(filePath);
      files.set(filePath, {
        path: filePath,
        added: (existing?.added ?? 0) + summary.added,
        removed: (existing?.removed ?? 0) + summary.removed,
        tool: event.toolName,
      });
    }
    return [...files.values()].reverse();
  }, [events]);
}

/**
 * 「审查」页签：工作区是 git 仓库时列 `git status` 的改动（增删行数来自 numstat），
 * 点开看 unified diff；不是仓库时回落到「本会话 agent 改了哪些文件」。
 */
export function ReviewTab() {
  const t = useT();
  const workspace = useAgentStore((s) => s.workspace);
  const sessionFiles = useSessionChanges();
  const [selected, setSelected] = useState<string | null>(null);

  const changesQuery = useQuery({
    queryKey: ["agent-workspace-changes", workspace],
    queryFn: () => rpcClient.getWorkspaceChanges({ workspace: workspace || undefined }),
  });

  const diffQuery = useQuery({
    queryKey: ["agent-workspace-diff", workspace, selected],
    queryFn: () =>
      rpcClient.getWorkspaceDiff({ path: selected ?? "", workspace: workspace || undefined }),
    enabled: Boolean(selected),
  });

  const changes = changesQuery.data;
  const files = changes?.isRepo ? changes.files : sessionFiles.map((file) => ({ ...file, status: "M" }));
  const totals = files.reduce(
    (acc, file) => ({
      added: acc.added + (file.added ?? 0),
      removed: acc.removed + (file.removed ?? 0),
    }),
    { added: 0, removed: 0 },
  );

  if (selected) {
    return <DiffView path={selected} onBack={() => setSelected(null)} loading={diffQuery.isLoading} diff={diffQuery.data?.diff ?? ""} binary={diffQuery.data?.binary ?? false} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 border-b px-2 py-1.5 text-[11px]">
        <FileDiffIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">
          {changes?.isRepo
            ? t("agent.review.repoChanges", { count: String(files.length) })
            : t("agent.review.sessionChanges", { count: String(files.length) })}
        </span>
        {totals.added > 0 && <span className="shrink-0 font-mono text-[10px] text-emerald-600">+{totals.added}</span>}
        {totals.removed > 0 && (
          <span className="shrink-0 font-mono text-[10px] text-destructive">-{totals.removed}</span>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6 shrink-0 text-muted-foreground"
          tooltip={t("agent.review.refresh")}
          onClick={() => changesQuery.refetch()}
        >
          <RefreshCwIcon className={cn("size-3.5", changesQuery.isFetching && "animate-spin")} />
        </Button>
      </div>

      {changesQuery.isLoading ? (
        <div className="flex flex-1 justify-center py-6">
          <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : files.length === 0 ? (
        <p className="py-8 text-center text-[11px] text-muted-foreground">{t("agent.review.empty")}</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          <div className="flex flex-col gap-0.5">
            {files.map((file) => {
              const style = statusStyle(file.status);
              return (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => setSelected(file.path)}
                  className="group flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted/60"
                  title={file.path}
                >
                  <span className={cn("w-3 shrink-0 font-mono text-[11px] font-semibold", style.className)}>
                    {style.label}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px]">
                    {file.path.split("/").pop()}
                    <span className="ml-1.5 text-[10px] text-muted-foreground/60">
                      {file.path.split("/").slice(0, -1).join("/")}
                    </span>
                  </span>
                  {file.added ? (
                    <span className="shrink-0 font-mono text-[10px] text-emerald-600">+{file.added}</span>
                  ) : null}
                  {file.removed ? (
                    <span className="shrink-0 font-mono text-[10px] text-destructive">-{file.removed}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {!changes?.isRepo && !changesQuery.isLoading && (
        <p className="border-t px-2 py-1.5 text-[10px] leading-4 text-muted-foreground">
          {t("agent.review.notRepo")}
        </p>
      )}
    </div>
  );
}

/** unified diff 视图：+ 绿 / - 红 / @@ 灰。 */
function DiffView({
  path: filePath,
  diff,
  loading,
  binary,
  onBack,
}: {
  path: string;
  diff: string;
  loading: boolean;
  binary: boolean;
  onBack: () => void;
}) {
  const t = useT();
  const lines = useMemo(() => parseUnifiedDiff(diff), [diff]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 border-b px-2 py-1.5">
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6 shrink-0 text-muted-foreground"
          tooltip={t("agent.panel.back")}
          onClick={onBack}
        >
          <ArrowLeftIcon className="size-3.5" />
        </Button>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={filePath}>
          {filePath}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="flex justify-center py-6">
            <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : binary ? (
          <p className="flex items-center justify-center gap-1.5 py-8 text-[11px] text-muted-foreground">
            <TriangleAlertIcon className="size-3.5" />
            {t("agent.review.binary")}
          </p>
        ) : lines.length === 0 || (lines.length === 1 && lines[0]!.text === "") ? (
          <p className="py-8 text-center text-[11px] text-muted-foreground">{t("agent.review.noDiff")}</p>
        ) : (
          <pre className="min-w-full text-[10.5px] leading-4">
            {lines.map((line, index) => (
              <div
                key={index}
                className={cn(
                  "px-2 whitespace-pre-wrap",
                  line.type === "add" && "bg-emerald-500/10",
                  line.type === "del" && "bg-destructive/10",
                  line.type === "meta" && "bg-muted/40 text-muted-foreground",
                )}
              >
                {line.text || " "}
              </div>
            ))}
          </pre>
        )}
      </div>
    </div>
  );
}
