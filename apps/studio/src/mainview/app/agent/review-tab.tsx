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
import { useAgentStore } from "@stores/agent";
import { useT } from "@stores/ui-lang";
import { PiTip } from "./pi-tip";
import { summarizeEdit } from "./timeline";
import { parseUnifiedDiff } from "../../../shared/diff";

/** git porcelain 的状态码 → 一个字母 + 语义色（新增绿 / 删除红 / 冲突红 / 其余中性）。 */
const STATUS_STYLE: Record<string, { label: string; tone: "success" | "error" | "muted" }> = {
  M: { label: "M", tone: "muted" },
  A: { label: "A", tone: "success" },
  D: { label: "D", tone: "error" },
  "??": { label: "U", tone: "muted" },
  R: { label: "R", tone: "muted" },
  C: { label: "C", tone: "muted" },
  U: { label: "!", tone: "error" },
};

function statusStyle(status: string) {
  const first = status[0] ?? "M";
  return STATUS_STYLE[status] ?? STATUS_STYLE[first] ?? STATUS_STYLE.M!;
}

function statusColor(tone: "success" | "error" | "muted"): string {
  if (tone === "success") return "var(--ds-success)";
  if (tone === "error") return "var(--ds-error)";
  return "var(--ds-text-muted)";
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
    <div className="wp-body">
      <div className="wp-toolbar">
        <FileDiffIcon size={13} aria-hidden style={{ flex: "none", color: "var(--ds-text-muted)" }} />
        <span className="wp-toolbar-text">
          {changes?.isRepo
            ? t("agent.review.repoChanges", { count: String(files.length) })
            : t("agent.review.sessionChanges", { count: String(files.length) })}
        </span>
        {totals.added > 0 ? <span className="review-counters review-add">+{totals.added}</span> : null}
        {totals.removed > 0 ? <span className="review-counters review-del">-{totals.removed}</span> : null}
        <PiTip label={t("agent.review.refresh")}>
          <button
            type="button"
            className="wp-action-btn"
            aria-label={t("agent.review.refresh")}
            onClick={() => changesQuery.refetch()}
          >
            <RefreshCwIcon size={13} className={changesQuery.isFetching ? "animate-spin" : undefined} aria-hidden />
          </button>
        </PiTip>
      </div>

      {changesQuery.isLoading ? (
        <div className="wp-empty">
          <Loader2Icon size={16} className="animate-spin" aria-hidden />
        </div>
      ) : files.length === 0 ? (
        <div className="wp-empty">
          <span className="wp-empty-mark">
            <FileDiffIcon size={18} aria-hidden />
          </span>
          <p className="wp-empty-title">{t("agent.review.empty")}</p>
        </div>
      ) : (
        <div className="wp-scroll" style={{ padding: "4px 8px 12px" }}>
          {files.map((file) => {
            const style = statusStyle(file.status);
            const dir = file.path.split("/").slice(0, -1).join("/");
            return (
              <button
                key={file.path}
                type="button"
                className="review-row"
                title={file.path}
                onClick={() => setSelected(file.path)}
              >
                <span className="review-status" style={{ color: statusColor(style.tone) }}>
                  {style.label}
                </span>
                <span className="file-row-name">
                  {file.path.split("/").pop()}
                  {dir ? (
                    <span style={{ marginLeft: 6, color: "var(--ds-text-faint)", fontSize: 10.5 }}>{dir}</span>
                  ) : null}
                </span>
                {file.added ? <span className="review-counters review-add">+{file.added}</span> : null}
                {file.removed ? <span className="review-counters review-del">-{file.removed}</span> : null}
              </button>
            );
          })}
        </div>
      )}

      {!changes?.isRepo && !changesQuery.isLoading ? (
        <p
          style={{
            flex: "none",
            padding: "6px 10px",
            borderTop: "1px solid var(--ds-border-subtle)",
            color: "var(--ds-text-muted)",
            fontSize: 10.5,
            lineHeight: 1.4,
          }}
        >
          {t("agent.review.notRepo")}
        </p>
      ) : null}
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
    <div className="wp-body">
      <div className="file-viewer-head">
        <PiTip label={t("agent.panel.back")}>
          <button type="button" className="wp-action-btn" aria-label={t("agent.panel.back")} onClick={onBack}>
            <ArrowLeftIcon size={13} aria-hidden />
          </button>
        </PiTip>
        <span className="file-viewer-path" title={filePath}>
          {filePath}
        </span>
      </div>
      <div className="wp-scroll" style={{ padding: "0 8px 12px" }}>
        {loading ? (
          <div className="wp-empty">
            <Loader2Icon size={16} className="animate-spin" aria-hidden />
          </div>
        ) : binary ? (
          <div className="wp-empty">
            <span className="wp-empty-mark">
              <TriangleAlertIcon size={18} aria-hidden />
            </span>
            <p className="wp-empty-title">{t("agent.review.binary")}</p>
          </div>
        ) : lines.length === 0 || (lines.length === 1 && lines[0]!.text === "") ? (
          <div className="wp-empty">
            <span className="wp-empty-mark">
              <FileDiffIcon size={18} aria-hidden />
            </span>
            <p className="wp-empty-title">{t("agent.review.noDiff")}</p>
          </div>
        ) : (
          <div className="diff-view" style={{ maxHeight: "none" }}>
            {lines.map((line, index) => (
              <div
                key={index}
                className={`diff-line${line.type === "add" ? " add" : line.type === "del" ? " del" : ""}${
                  line.type === "meta" ? " hunk" : ""
                }`}
              >
                {line.type === "meta" ? null : (
                  <span className="diff-line-sign">
                    {line.type === "add" ? "+" : line.type === "del" ? "-" : ""}
                  </span>
                )}
                <span style={{ minWidth: 0 }}>{line.text || " "}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
