import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangleIcon, Loader2Icon, Undo2Icon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ui/dialog";
import { useT } from "@stores/ui-lang";

/**
 * 「撤销本轮」弹窗（对齐 Codex 的回合安全网）。
 *
 * 回退是破坏性动作（新文件会被删掉），所以**先给预览再执行**：列出这一轮改过 /
 * 新建的文件，用户看清楚才点确认。执行完把结果（还原了几个、删了几个）原样留在
 * 弹窗里，不是一闪而过的 toast —— 用户需要核对"到底动了什么"。
 */
export function RevertTurnDialog({
  open,
  onOpenChange,
  snapshotId,
  label,
  onReverted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snapshotId: string;
  label: string;
  onReverted?: () => void;
}) {
  const t = useT();
  const [result, setResult] = useState<{ restored: string[]; removed: string[] } | null>(null);

  const previewQuery = useMutation({
    mutationFn: () => rpcClient.previewAgentSnapshot({ id: snapshotId }),
  });
  const revertMutation = useMutation({
    mutationFn: () => rpcClient.revertAgentSnapshot({ id: snapshotId }),
    onSuccess: (data) => {
      if (!data.ok) return;
      setResult({ restored: data.restored ?? [], removed: data.removed ?? [] });
      onReverted?.();
    },
  });

  const preview = previewQuery.data;
  const files = preview?.files ?? [];
  const deleted = files.filter((file) => file.status === "A" || file.status === "?");
  const restored = files.filter((file) => file.status !== "A" && file.status !== "?");

  // 打开时拉一次预览：要改哪些文件是用户点确认前必须知道的事。
  const previewMutate = previewQuery.mutate;
  useEffect(() => {
    if (open) previewMutate();
  }, [open, previewMutate]);

  const close = (next: boolean) => {
    if (!next) {
      setResult(null);
      revertMutation.reset();
      previewQuery.reset();
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Undo2Icon className="size-4" />
            {t("agent.revert.title")} · {label}
          </DialogTitle>
          <DialogDescription>{t("agent.revert.desc")}</DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="flex flex-col gap-2 text-xs">
            <p className="text-emerald-600 dark:text-emerald-400">
              {t("agent.revert.done", {
                restored: String(result.restored.length),
                removed: String(result.removed.length),
              })}
            </p>
            {result.restored.length > 0 && (
              <FileList title={t("agent.revert.restored")} files={result.restored} tone="restore" />
            )}
            {result.removed.length > 0 && (
              <FileList title={t("agent.revert.removed")} files={result.removed} tone="delete" />
            )}
          </div>
        ) : previewQuery.isPending ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" />
            {t("agent.revert.previewing")}
          </div>
        ) : previewQuery.isError || (preview && !preview.ok) ? (
          <p className="text-xs text-destructive">
            {preview?.error ?? t("agent.revert.previewFailed")}
          </p>
        ) : files.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("agent.revert.noChanges")}</p>
        ) : (
          <div className="flex flex-col gap-2 text-xs">
            {restored.length > 0 && (
              <FileList
                title={t("agent.revert.willRestore", { count: String(restored.length) })}
                files={restored.map((file) => file.path)}
                tone="restore"
              />
            )}
            {deleted.length > 0 && (
              <FileList
                title={t("agent.revert.willDelete", { count: String(deleted.length) })}
                files={deleted.map((file) => file.path)}
                tone="delete"
              />
            )}
            <p className="flex items-start gap-1.5 text-muted-foreground">
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
              {t("agent.revert.hint")}
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => close(false)}>
            {result ? t("common.close") : t("common.cancel")}
          </Button>
          {!result && (
            <Button
              variant="destructive"
              size="sm"
              disabled={revertMutation.isPending || !preview?.ok || files.length === 0}
              onClick={() => revertMutation.mutate()}
            >
              {revertMutation.isPending ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              {t("agent.revert.confirm")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 文件清单：还原（M/D）与删除（A/?）用不同颜色，扫一眼就知道会不会丢东西。 */
function FileList({
  title,
  files,
  tone,
}: {
  title: string;
  files: string[];
  tone: "restore" | "delete";
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-muted-foreground">{title}</span>
      <ul className="max-h-40 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-[11px]">
        {files.slice(0, 100).map((file) => (
          <li
            key={file}
            className={tone === "delete" ? "text-destructive/90" : "text-foreground/80"}
          >
            {file}
          </li>
        ))}
        {files.length > 100 && <li className="text-muted-foreground">…</li>}
      </ul>
    </div>
  );
}
