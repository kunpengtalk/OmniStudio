// Git 备份 Tab：状态卡 / 远端连接（URL+PAT） / commit-push-pull / 快照与恢复 / 冲突解决 / 体积报告。
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangleIcon,
  CloudUploadIcon,
  GitBranchIcon,
  HardDriveDownloadIcon,
  Loader2Icon,
  RotateCcwIcon,
  TagIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { ScrollArea } from "@ui/scroll-area";
import { Spinner } from "@ui/spinner";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import { formatBytes, Toolbar } from "./parts";

export function BackupTab() {
  const t = useT();
  const queryClient = useQueryClient();
  const [remoteUrl, setRemoteUrl] = useState("");
  const [pat, setPat] = useState("");
  const [snapshotName, setSnapshotName] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: ["skills-backup"],
    queryFn: () => rpcClient.skillsBackupStatus(undefined),
  });
  const snapshotsQuery = useQuery({
    queryKey: ["skills-snapshots"],
    queryFn: () => rpcClient.skillsSnapshots(undefined),
  });
  const sizeQuery = useQuery({
    queryKey: ["skills-backup-size"],
    queryFn: () => rpcClient.skillsSizeReport(undefined),
  });

  const status = statusQuery.data?.status;
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["skills-backup"] });
    queryClient.invalidateQueries({ queryKey: ["skills-snapshots"] });
  };

  const init = useMutation({
    mutationFn: () => rpcClient.skillsBackupInit(undefined),
    onSuccess: invalidate,
  });
  const saveRemote = useMutation({
    mutationFn: () => rpcClient.skillsBackupSetRemote({ url: remoteUrl, pat: pat || undefined }),
    onSuccess: (data) => {
      setMessage(data.ok ? t("skills.backup.remoteSaved") : (data.error ?? "failed"));
      invalidate();
    },
  });
  const commit = useMutation({
    mutationFn: () => rpcClient.skillsBackupCommit({}),
    onSuccess: (data) => {
      setMessage(data.ok ? t("skills.backup.committed") : (data.error ?? "commit failed"));
      invalidate();
    },
  });
  const push = useMutation({
    mutationFn: () => rpcClient.skillsBackupPush(undefined),
    onSuccess: (data) => {
      setMessage(data.ok ? t("skills.backup.pushed") : (data.error ?? "push failed"));
      invalidate();
    },
  });
  const pull = useMutation({
    mutationFn: () => rpcClient.skillsBackupPull(undefined),
    onSuccess: (data) => {
      setMessage(data.ok ? t("skills.backup.pulled") : (data.error ?? "pull failed"));
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      queryClient.invalidateQueries({ queryKey: ["skills-presets"] });
    },
  });
  const createSnapshot = useMutation({
    mutationFn: () => rpcClient.skillsCreateSnapshot({ name: snapshotName || undefined }),
    onSuccess: (data) => {
      setMessage(data.ok ? `${t("skills.backup.snapshotCreated")}: ${data.tag}` : (data.error ?? "failed"));
      setSnapshotName("");
      invalidate();
    },
  });
  const restore = useMutation({
    mutationFn: (tag: string) => rpcClient.skillsRestoreSnapshot({ tag }),
    onSuccess: (data) => {
      setMessage(data.ok ? t("skills.backup.restored") : (data.error ?? "failed"));
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  });
  const resolve = useMutation({
    mutationFn: (keep: "local" | "remote") => rpcClient.skillsResolveConflict({ keep }),
    onSuccess: (data) => {
      setMessage(data.ok ? t("skills.backup.resolved") : (data.error ?? "failed"));
      invalidate();
    },
  });
  const setAuto = useMutation({
    mutationFn: (enabled: boolean) => rpcClient.skillsBackupSetAuto({ enabled }),
    onSuccess: invalidate,
  });

  const hasConflict = push.data && !push.data.ok && push.data.error === "SYNC_CONFLICT";
  const oversized = sizeQuery.data?.oversized ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar
        icon={<GitBranchIcon className="size-4 text-muted-foreground" />}
        title={t("skills.nav.backup")}
        stats={status ? (status.initialized ? status.branch : undefined) : undefined}
      />

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex w-full flex-col gap-4 p-4">
        {/* 状态卡 */}
        {statusQuery.isLoading ? (
          <div className="flex justify-center py-6"><Spinner className="size-5" /></div>
        ) : status ? (
          <div className="grid grid-cols-2 gap-2 rounded-lg border p-4 sm:grid-cols-4">
            <div>
              <p className="text-[10px] text-muted-foreground">{t("skills.backup.repoState")}</p>
              <p className="text-sm font-medium">
                {status.initialized ? (
                  <span className="text-emerald-600">{t("skills.backup.initialized")}</span>
                ) : (
                  <span className="text-muted-foreground">{t("skills.backup.notInitialized")}</span>
                )}
              </p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">{t("skills.backup.remote")}</p>
              <p className="truncate text-sm font-medium" title={status.remote}>
                {status.remote ? (
                  <span className="font-mono text-xs">{status.remote.replace(/\/\/[^@]+@/, "//***@")}</span>
                ) : (
                  <span className="text-muted-foreground">{t("skills.backup.noRemote")}</span>
                )}
              </p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">{t("skills.backup.aheadBehind")}</p>
              <p className="text-sm font-medium">
                ↑{status.ahead} ↓{status.behind} {status.dirty && `· ${t("skills.backup.dirty")}`}
              </p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">{t("skills.backup.lastCommit")}</p>
              <p className="truncate text-xs" title={status.lastCommit ?? ""}>
                {status.lastCommit ?? "—"}
              </p>
            </div>
          </div>
        ) : null}

        {/* 初始化 */}
        {!status?.initialized && (
          <Button size="sm" className="self-start" disabled={init.isPending} onClick={() => init.mutate()}>
            {init.isPending ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <GitBranchIcon data-icon="inline-start" />}
            {t("skills.backup.init")}
          </Button>
        )}

        {/* 远端连接 */}
        <div className="flex flex-col gap-2 rounded-lg border p-4">
          <p className="text-xs font-medium">{t("skills.backup.connect")}</p>
          <div className="flex gap-2">
            <Input
              className="h-9 flex-1 font-mono text-xs"
              placeholder="https://github.com/user/skills-backup.git"
              defaultValue={status?.remote ?? ""}
              onChange={(e) => setRemoteUrl(e.target.value)}
            />
            <Input
              className="h-9 w-40 font-mono text-xs"
              placeholder={t("skills.backup.patPlaceholder")}
              type="password"
              value={pat}
              onChange={(e) => setPat(e.target.value)}
            />
            <Button size="sm" className="h-9" disabled={saveRemote.isPending} onClick={() => saveRemote.mutate()}>
              {saveRemote.isPending ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : null}
              {t("common.save")}
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground">{t("skills.backup.patHint")}</p>
        </div>

        {/* 手动操作 */}
        <div className="flex flex-wrap items-center gap-2 rounded-lg border p-4">
          <Button size="sm" variant="outline" disabled={!status?.initialized || commit.isPending} onClick={() => commit.mutate()}>
            {commit.isPending ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <HardDriveDownloadIcon data-icon="inline-start" />}
            {t("skills.backup.commit")}
          </Button>
          <Button size="sm" variant="outline" disabled={!status?.initialized || push.isPending} onClick={() => push.mutate()}>
            {push.isPending ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <CloudUploadIcon data-icon="inline-start" />}
            {t("skills.backup.push")}
          </Button>
          <Button size="sm" variant="outline" disabled={!status?.initialized || pull.isPending} onClick={() => pull.mutate()}>
            {pull.isPending ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <HardDriveDownloadIcon data-icon="inline-start" />}
            {t("skills.backup.pull")}
          </Button>
          <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="size-3.5 accent-primary"
              checked={status?.autoBackup ?? true}
              disabled={setAuto.isPending}
              onChange={(e) => setAuto.mutate(e.target.checked)}
            />
            {t("skills.backup.auto")}
          </label>
        </div>

        {/* 冲突 */}
        {hasConflict && (
          <div className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
            <p className="flex items-center gap-1.5 text-xs font-medium text-destructive">
              <AlertTriangleIcon className="size-3.5" />
              {t("skills.backup.conflict")}
            </p>
            <p className="text-[11px] text-muted-foreground">{t("skills.backup.conflictHint")}</p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={resolve.isPending} onClick={() => resolve.mutate("local")}>
                {t("skills.backup.keepLocal")}
              </Button>
              <Button size="sm" variant="outline" disabled={resolve.isPending} onClick={() => resolve.mutate("remote")}>
                {t("skills.backup.keepRemote")}
              </Button>
            </div>
          </div>
        )}

        {message && (
          <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs">{message}</div>
        )}

        {/* 快照 */}
        <div className="flex flex-col gap-2 rounded-lg border p-4">
          <p className="flex items-center gap-1.5 text-xs font-medium">
            <TagIcon className="size-3.5" />
            {t("skills.backup.snapshots")}
          </p>
          <div className="flex gap-2">
            <Input
              className="h-8 text-xs"
              placeholder={t("skills.backup.snapshotNamePlaceholder")}
              value={snapshotName}
              onChange={(e) => setSnapshotName(e.target.value)}
            />
            <Button size="sm" variant="outline" className="h-8" disabled={!status?.initialized || createSnapshot.isPending} onClick={() => createSnapshot.mutate()}>
              {createSnapshot.isPending ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <TagIcon data-icon="inline-start" />}
              {t("skills.backup.createSnapshot")}
            </Button>
          </div>
          <div className="flex flex-col">
            {(snapshotsQuery.data?.snapshots ?? []).map((s) => (
              <div key={s.tag} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50">
                <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{s.tag}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {s.date} {s.subject}
                </span>
                <button
                  type="button"
                  title={t("skills.backup.restore")}
                  disabled={restore.isPending}
                  onClick={() => restore.mutate(s.tag)}
                  className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <RotateCcwIcon className="size-3.5" />
                </button>
              </div>
            ))}
            {(snapshotsQuery.data?.snapshots ?? []).length === 0 && (
              <p className="px-2 py-2 text-[11px] text-muted-foreground">{t("skills.backup.noSnapshots")}</p>
            )}
          </div>
        </div>

        {/* 体积报告 */}
        {sizeQuery.data && (
          <div className={cn("flex flex-col gap-1 rounded-lg border p-4", oversized.length > 0 && "border-amber-500/40")}>
            <p className="text-xs font-medium">
              {t("skills.backup.size")}: {formatBytes(sizeQuery.data.totalBytes)}
            </p>
            {oversized.map((o) => (
              <p key={o.id} className="text-[11px] text-amber-600">
                ⚠ {o.id}: {formatBytes(o.bytes)} &gt; 100MB
              </p>
            ))}
          </div>
        )}
      </div>
      </ScrollArea>
    </div>
  );
}
