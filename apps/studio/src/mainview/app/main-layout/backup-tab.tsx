import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArchiveIcon,
  CheckIcon,
  CloudUploadIcon,
  DownloadIcon,
  EyeIcon,
  EyeOffIcon,
  FolderOpenIcon,
  HardDriveDownloadIcon,
  KeyRoundIcon,
  LockIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
  Trash2Icon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Switch } from "@ui/switch";
import { Spinner } from "@ui/spinner";
import { Badge } from "@ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ui/dialog";
import { useT } from "@stores/ui-lang";
import { isBackupRunning, useBackupStore } from "@stores/backup";
import {
  BACKUP_NEVER_INCLUDED,
  BACKUP_PASSWORD_REQUIRED_HINT,
  BACKUP_SCOPES,
  BACKUP_SCOPE_GROUPS,
  DEFAULT_REMOTE_CONFIG,
  type BackupFinishedEvent,
  type BackupInspectResult,
  type BackupProgress,
  type BackupRemoteConfig,
  type BackupRemoteEntry,
  type BackupScopeGroup,
  type BackupScopeId,
  type BackupSummary,
} from "@/shared/backup";
import { PageHeader, SettingsSection, SettingRow } from "./setting-ui";

/** 备份体积可能到 GB 级：format.ts 的 formatSize 只到 MB，这里单独补一层。 */
function formatBytes(bytes: number | undefined | null): string {
  if (!bytes || bytes <= 0) return "0 B";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function formatTime(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

/** 密码输入：带显示 / 隐藏切换，避免用户在看不到输入的情况下打错密码。 */
function PasswordInput({
  value,
  onChange,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 pr-8 text-xs"
        disabled={disabled}
        autoComplete="new-password"
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        tabIndex={-1}
      >
        {visible ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
      </button>
    </div>
  );
}

/** 进度条：仓库里没有 progress 组件，沿用下载面板那种细条实现。 */
function ProgressBar({ progress }: { progress: BackupProgress }) {
  const t = useT();
  const percent = progress.percent ?? 0;
  const indeterminate = progress.percent === null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span className="truncate">
          {t(`backup.phase.${progress.phase}`)}
          {progress.current ? ` · ${progress.current}` : ""}
        </span>
        <span className="shrink-0 tabular-nums">
          {indeterminate ? t("backup.progressWorking") : `${percent}%`}
          {progress.totalItems ? ` · ${progress.processedItems ?? 0}/${progress.totalItems}` : ""}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full bg-primary transition-[width] duration-200 ${indeterminate ? "animate-pulse" : ""}`}
          style={{ width: `${indeterminate ? 30 : Math.max(2, percent)}%` }}
        />
      </div>
      {progress.processedBytes != null && progress.totalBytes != null && (
        <p className="text-[11px] text-muted-foreground">
          {formatBytes(progress.processedBytes)} / {formatBytes(progress.totalBytes)}
        </p>
      )}
    </div>
  );
}

export function BackupTab() {
  const t = useT();
  const queryClient = useQueryClient();
  const { progress, last, notice, setNotice, clearFinished } = useBackupStore();
  const running = isBackupRunning(progress);

  const [scopes, setScopes] = useState<BackupScopeId[]>(
    BACKUP_SCOPES.filter((s) => s.defaultOn).map((s) => s.id),
  );
  const [destDir, setDestDir] = useState<string | null>(null);
  const [redact, setRedact] = useState(false);
  const [compress, setCompress] = useState(true);
  const [password, setPassword] = useState("");
  const [upload, setUpload] = useState(false);
  const [note, setNote] = useState("");

  const [restorePath, setRestorePath] = useState<string | null>(null);
  const [restorePassword, setRestorePassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [restoreInfo, setRestoreInfo] = useState<BackupInspectResult | null>(null);
  const [restoreScopes, setRestoreScopes] = useState<BackupScopeId[]>([]);
  const [safety, setSafety] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const overview = useQuery({ queryKey: ["backup-overview"], queryFn: () => rpcClient.backupOverview(undefined) });
  const backups = useQuery({ queryKey: ["backups"], queryFn: () => rpcClient.backupList(undefined) });
  const estimate = useQuery({ queryKey: ["backup-estimate"], queryFn: () => rpcClient.backupEstimate(undefined) });
  const remoteConfig = useQuery({ queryKey: ["backup-remote"], queryFn: () => rpcClient.backupRemoteGet(undefined) });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["backups"] });
    queryClient.invalidateQueries({ queryKey: ["backup-estimate"] });
  };

  // 远端下载完成后自动进入预览：省掉"下载完还得再点一次选文件"。
  const downloadedPath = last?.ok && last.kind === "download" && last.result && "path" in last.result ? last.result.path : null;
  useEffect(() => {
    if (!downloadedPath) return;
    setRestorePassword("");
    setNeedsPassword(false);
    setRestorePath(downloadedPath);
    inspectMutation.mutate({ path: downloadedPath });
    // inspectMutation 是稳定引用，这里只跟下载路径走
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloadedPath]);

  const createMutation = useMutation({
    mutationFn: () => {
      clearFinished();
      return rpcClient.backupCreate({
        scopes,
        destinationDir: destDir ?? undefined,
        note: note.trim() || undefined,
        redactSecrets: redact,
        compress,
        password: password || undefined,
        upload: upload || undefined,
      });
    },
    onError: (err) => setNotice(err instanceof Error ? err.message : String(err)),
  });

  const inspectMutation = useMutation({
    mutationFn: (params: { path: string; password?: string }) => rpcClient.backupInspect(params),
    onSuccess: (info) => {
      setRestoreInfo(info);
      setRestoreScopes(info.scopes);
      setNeedsPassword(false);
      clearFinished();
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      setRestoreInfo(null);
      // 加密备份没给密码时提示输入，而不是把"需要密码"当失败弹错误
      if (message.includes(BACKUP_PASSWORD_REQUIRED_HINT)) {
        setNeedsPassword(true);
        if (restorePassword) setNotice(t("backup.restore.passwordWrong"));
        return;
      }
      setNotice(message);
    },
  });

  const startInspect = (path: string, pwd?: string) => {
    setRestorePath(path);
    inspectMutation.mutate({ path, password: pwd || undefined });
  };

  const pickFile = async () => {
    const { path } = await rpcClient.backupChooseFile(undefined);
    if (!path) return;
    setRestorePassword("");
    setNeedsPassword(false);
    startInspect(path);
  };

  const restoreMutation = useMutation({
    mutationFn: () => {
      if (!restorePath) throw new Error(t("backup.restore.noFile"));
      clearFinished();
      return rpcClient.backupRestore({
        path: restorePath,
        scopes: restoreScopes,
        safety,
        password: restorePassword || undefined,
      });
    },
    onError: (err) => setNotice(err instanceof Error ? err.message : String(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: (path: string) => rpcClient.backupDelete({ path }),
    onSuccess: refresh,
  });

  const pickDir = async () => {
    const res = await rpcClient.backupChooseDir(undefined);
    if (!res.dir) return;
    if (res.error) {
      setNotice(t("backup.create.dirUnwritable", { error: res.error }));
      return;
    }
    setNotice(null);
    setDestDir(res.dir);
  };

  const estimateFor = (scope: BackupScopeId) => estimate.data?.scopes.find((s) => s.scope === scope);

  const toggle = (list: BackupScopeId[], id: BackupScopeId): BackupScopeId[] =>
    list.includes(id) ? list.filter((s) => s !== id) : [...list, id];

  const selectedBytes = scopes.reduce((sum, id) => sum + (estimateFor(id)?.bytes ?? 0), 0);
  const dbBytes = estimate.data?.dbBytes ?? 0;
  const freeBytes = estimate.data?.freeBytes ?? null;
  const tooBig = freeBytes != null && selectedBytes + dbBytes > freeBytes;
  const remoteReady = !!remoteConfig.data?.configured;

  return (
    <>
      <PageHeader title={t("settings.backup.title")} description={t("settings.backup.subtitle")} />

      {(notice || (last && !last.ok)) && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">
            {notice ?? (last?.canceled ? t("backup.canceled") : last?.error)}
          </span>
          <button type="button" onClick={() => setNotice(null)} className="shrink-0">
            <XIcon className="size-3.5" />
          </button>
        </div>
      )}

      {last?.ok && <ResultCard event={last} />}

      {/* 创建 */}
      <SettingsSection
        title={t("backup.create.title")}
        description={t("backup.create.description")}
        className="mb-4"
      >
        <SettingRow title={t("backup.create.scopes")} description={t("backup.create.scopesHint")} stacked>
          <div className="flex flex-col gap-3">
            {BACKUP_SCOPE_GROUPS.map((group) => {
              const groupScopes = BACKUP_SCOPES.filter((s) => s.group === group.id);
              if (!groupScopes.length) return null;
              return (
                <div key={group.id} className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-medium text-muted-foreground">
                    {t(`backup.scopeGroup.${group.id}`)}
                  </span>
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {groupScopes.map((def) => {
                      const stat = estimateFor(def.id);
                      return (
                        <label
                          key={def.id}
                          className="flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 transition-colors hover:bg-muted/40"
                        >
                          <input
                            type="checkbox"
                            className="mt-0.5 size-3.5 accent-primary"
                            checked={scopes.includes(def.id)}
                            onChange={() => setScopes((prev) => toggle(prev, def.id))}
                            disabled={running}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center justify-between gap-2">
                              <span className="text-xs font-medium">{t(`backup.scope.${def.id}.title`)}</span>
                              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                                {formatBytes(stat?.bytes ?? 0)}
                              </span>
                            </span>
                            <span className="mt-0.5 block text-[11px] text-muted-foreground">
                              {t(`backup.scope.${def.id}.desc`)}
                            </span>
                            <span className="mt-0.5 block text-[11px] text-muted-foreground/70">
                              {t("backup.scope.stat", {
                                rows: String(stat?.rows ?? 0),
                                files: String(stat?.files ?? 0),
                              })}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {t("backup.create.excludedHint", { dirs: BACKUP_NEVER_INCLUDED.join(" / ") })}
          </p>
        </SettingRow>

        <SettingRow title={t("backup.create.password")} description={t("backup.create.passwordHint")} stacked>
          <div className="flex flex-col gap-1.5">
            <PasswordInput
              value={password}
              onChange={setPassword}
              placeholder={t("backup.create.passwordPlaceholder")}
              disabled={running}
            />
            {password && (
              <p className="flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-500">
                <ShieldAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                {t("backup.create.passwordWarning")}
              </p>
            )}
          </div>
        </SettingRow>

        <SettingRow title={t("backup.create.destination")} description={destDir ?? overview.data?.dir ?? ""}>
          <Button size="sm" variant="outline" onClick={pickDir} disabled={running}>
            <FolderOpenIcon data-icon="inline-start" />
            {t("backup.create.chooseDir")}
          </Button>
          {destDir && (
            <Button size="sm" variant="ghost" onClick={() => setDestDir(null)} disabled={running}>
              {t("backup.create.resetDir")}
            </Button>
          )}
        </SettingRow>

        <SettingRow
          title={t("backup.create.upload")}
          description={remoteReady ? t("backup.create.uploadHint") : t("backup.remote.notConfigured")}
        >
          <Switch
            checked={upload}
            onCheckedChange={setUpload}
            disabled={running || !remoteReady}
          />
        </SettingRow>

        <SettingRow title={t("backup.create.redact")} description={t("backup.create.redactHint")}>
          <Switch checked={redact} onCheckedChange={setRedact} disabled={running} />
        </SettingRow>

        <SettingRow title={t("backup.create.compress")} description={t("backup.create.compressHint")}>
          <Switch checked={compress} onCheckedChange={setCompress} disabled={running} />
        </SettingRow>

        <SettingRow title={t("backup.create.note")} description={t("backup.create.noteHint")} stacked>
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("backup.create.notePlaceholder")}
            className="h-8 text-xs"
            disabled={running}
          />
        </SettingRow>

        <div className="flex flex-col gap-3 px-4 py-3">
          {progress && progress.kind === "create" && <ProgressBar progress={progress} />}
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              onClick={() => createMutation.mutate()}
              disabled={running || scopes.length === 0 || tooBig}
            >
              {running && progress?.kind === "create" ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <HardDriveDownloadIcon data-icon="inline-start" />
              )}
              {running && progress?.kind === "create"
                ? t("backup.create.running")
                : t("backup.create.start")}
            </Button>
            {running && progress?.kind === "create" && (
              <Button size="sm" variant="outline" onClick={() => rpcClient.backupCancel({ taskId: progress.taskId })}>
                {t("backup.cancel")}
              </Button>
            )}
            <p className="text-[11px] text-muted-foreground">
              {t("backup.create.sizeHint", {
                size: formatBytes(selectedBytes + dbBytes),
                free: freeBytes == null ? "—" : formatBytes(freeBytes),
              })}
            </p>
          </div>
          {tooBig && <p className="text-[11px] text-destructive">{t("backup.create.notEnoughSpace")}</p>}
        </div>
      </SettingsSection>

      {/* 恢复 */}
      <SettingsSection
        title={t("backup.restore.title")}
        description={t("backup.restore.description")}
        className="mb-4"
      >
        <SettingRow
          title={t("backup.restore.source")}
          description={restorePath ?? t("backup.restore.noFileHint")}
        >
          <Button size="sm" variant="outline" onClick={pickFile} disabled={running || inspectMutation.isPending}>
            {inspectMutation.isPending ? <Spinner data-icon="inline-start" /> : <ArchiveIcon data-icon="inline-start" />}
            {t("backup.restore.chooseFile")}
          </Button>
        </SettingRow>

        {needsPassword && (
          <SettingRow title={t("backup.restore.password")} description={t("backup.restore.passwordHint")} stacked>
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <PasswordInput
                  value={restorePassword}
                  onChange={setRestorePassword}
                  placeholder={t("backup.create.passwordPlaceholder")}
                  disabled={inspectMutation.isPending}
                />
              </div>
              <Button
                size="sm"
                onClick={() => restorePath && startInspect(restorePath, restorePassword)}
                disabled={!restorePassword || inspectMutation.isPending}
              >
                <KeyRoundIcon data-icon="inline-start" />
                {t("backup.restore.unlock")}
              </Button>
            </div>
          </SettingRow>
        )}

        {restoreInfo && (
          <>
            <SettingRow title={t("backup.restore.contents")} stacked>
              <div className="flex flex-col gap-1.5 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  {restoreInfo.manifest.encrypted && (
                    <Badge variant="secondary">
                      <LockIcon className="mr-1 size-3" />
                      {t("backup.history.encrypted")}
                    </Badge>
                  )}
                  {t("backup.restore.meta", {
                    time: formatTime(restoreInfo.manifest.createdAt),
                    version: restoreInfo.manifest.appVersion,
                    size: formatBytes(restoreInfo.bytes),
                  })}
                </span>
                <span>
                  {t("backup.restore.totals", {
                    tables: String(Object.values(restoreInfo.manifest.db.tables).reduce((a, b) => a + b, 0)),
                    files: String(restoreInfo.manifest.totals.files),
                  })}
                </span>
                {restoreInfo.manifest.note && (
                  <span>
                    {t("backup.restore.note")}
                    {restoreInfo.manifest.note}
                  </span>
                )}
              </div>
              {restoreInfo.warnings.map((w) => (
                <p key={w} className="flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-500">
                  <ShieldAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                  {w}
                </p>
              ))}
            </SettingRow>

            <SettingRow title={t("backup.restore.pickScopes")} description={t("backup.restore.pickScopesHint")} stacked>
              <div className="flex flex-wrap gap-1.5">
                {restoreInfo.scopes.map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setRestoreScopes((prev) => toggle(prev, id))}
                    disabled={running}
                    className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                      restoreScopes.includes(id)
                        ? "border-primary/40 bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    {restoreScopes.includes(id) && <CheckIcon className="mr-1 inline size-3" />}
                    {t(`backup.scope.${id}.title`)}
                  </button>
                ))}
              </div>
            </SettingRow>

            <SettingRow title={t("backup.restore.safety")} description={t("backup.restore.safetyHint")}>
              <Switch checked={safety} onCheckedChange={setSafety} disabled={running} />
            </SettingRow>

            <div className="flex flex-col gap-3 px-4 py-3">
              {progress && progress.kind === "restore" && <ProgressBar progress={progress} />}
              <div className="flex items-center gap-3">
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => setConfirmOpen(true)}
                  disabled={running || restoreScopes.length === 0}
                >
                  {running && progress?.kind === "restore" ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <RotateCcwIcon data-icon="inline-start" />
                  )}
                  {running && progress?.kind === "restore"
                    ? t("backup.restore.running")
                    : t("backup.restore.start")}
                </Button>
                {running && progress?.kind === "restore" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => rpcClient.backupCancel({ taskId: progress.taskId })}
                  >
                    {t("backup.cancel")}
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
      </SettingsSection>

      <RemoteSection
        config={remoteConfig.data?.config ?? DEFAULT_REMOTE_CONFIG}
        configured={remoteReady}
        running={running}
        progress={progress}
        onChanged={() => queryClient.invalidateQueries({ queryKey: ["backup-remote"] })}
        onNotice={setNotice}
      />

      {/* 备份记录 */}
      <SettingsSection title={t("backup.history.title")} description={t("backup.history.description")}>
        {backups.isLoading ? (
          <div className="flex items-center gap-2 px-4 py-4 text-xs text-muted-foreground">
            <Spinner /> {t("backup.history.loading")}
          </div>
        ) : (backups.data?.backups.length ?? 0) === 0 ? (
          <p className="px-4 py-4 text-xs text-muted-foreground">{t("backup.history.empty")}</p>
        ) : (
          backups.data!.backups.map((item) => (
            <HistoryRow
              key={item.path}
              item={item}
              disabled={running}
              onRestore={() => {
                setRestorePassword("");
                setNeedsPassword(false);
                startInspect(item.path);
              }}
              onReveal={() => rpcClient.backupReveal({ path: item.path })}
              onDelete={() => deleteMutation.mutate(item.path)}
            />
          ))
        )}
      </SettingsSection>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("backup.restore.confirmTitle")}</DialogTitle>
            <DialogDescription>{t("backup.restore.confirmBody")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 text-xs">
            <p className="text-muted-foreground">{t("backup.restore.confirmList")}</p>
            <ul className="list-inside list-disc text-muted-foreground">
              {restoreScopes.map((id) => (
                <li key={id}>{t(`backup.scope.${id}.title`)}</li>
              ))}
            </ul>
            <p className="text-muted-foreground">{t("backup.restore.confirmKeep")}</p>
          </div>
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={() => setConfirmOpen(false)}>
              {t("backup.restore.confirmCancel")}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => {
                setConfirmOpen(false);
                restoreMutation.mutate();
              }}
            >
              {t("backup.restore.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** 远端存储（S3 兼容 / WebDAV）配置 + 远端备份列表。 */
function RemoteSection({
  config,
  configured,
  running,
  progress,
  onChanged,
  onNotice,
}: {
  config: BackupRemoteConfig;
  configured: boolean;
  running: boolean;
  progress: BackupProgress | null;
  onChanged: () => void;
  onNotice: (message: string | null) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<BackupRemoteConfig>(config);
  const [dirty, setDirty] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  // 配置是异步查回来的：查询回来后回填表单（用户已经动过的字段不覆盖）。
  useEffect(() => {
    if (!dirty) setDraft(config);
  }, [config, dirty]);

  // 查询回来后同步一次草稿（用户没改过时才覆盖，避免打断输入）
  const patch = (next: Partial<BackupRemoteConfig>) => {
    setDraft((prev) => ({ ...prev, ...next }));
    setDirty(true);
  };

  const saveMutation = useMutation({
    mutationFn: () => rpcClient.backupRemoteSave({ config: draft }),
    onSuccess: (res) => {
      if (!res.ok) {
        onNotice(res.error ?? "保存失败");
        return;
      }
      setDirty(false);
      onNotice(null);
      onChanged();
      setTestResult(null);
    },
    onError: (err) => onNotice(err instanceof Error ? err.message : String(err)),
  });

  const testMutation = useMutation({
    mutationFn: async () => {
      // 测试前先落盘，否则测的是旧配置（用户会以为保存过了）
      const saved = await rpcClient.backupRemoteSave({ config: draft });
      if (!saved.ok) throw new Error(saved.error ?? "保存失败");
      setDirty(false);
      onChanged();
      return rpcClient.backupRemoteTest(undefined);
    },
    onSuccess: (res) => {
      setTestResult({
        ok: res.ok,
        text: res.ok ? (res.detail ?? t("backup.remote.testOk")) : (res.error ?? t("backup.remote.testFail")),
      });
    },
    onError: (err) => setTestResult({ ok: false, text: err instanceof Error ? err.message : String(err) }),
  });

  const remoteList = useQuery({
    queryKey: ["backup-remote-list", config.endpoint, config.bucket, config.prefix, config.enabled],
    queryFn: () => rpcClient.backupRemoteList(undefined),
    enabled: configured,
  });

  const downloadMutation = useMutation({
    mutationFn: (fileName: string) => rpcClient.backupRemoteDownload({ fileName }),
    onError: (err) => onNotice(err instanceof Error ? err.message : String(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: (fileName: string) => rpcClient.backupRemoteDelete({ fileName }),
    onSuccess: (res) => {
      if (!res.ok) {
        onNotice(res.error ?? "删除失败");
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["backup-remote-list"] });
    },
  });

  const isS3 = draft.kind === "s3";

  return (
    <SettingsSection
      title={t("backup.remote.title")}
      description={t("backup.remote.description")}
      className="mb-4"
    >
      <SettingRow title={t("backup.remote.enabled")} description={t("backup.remote.enabledHint")}>
        <Switch checked={draft.enabled} onCheckedChange={(v) => patch({ enabled: v })} disabled={running} />
      </SettingRow>

      <SettingRow title={t("backup.remote.kind")} description={t("backup.remote.kindHint")}>
        <Select value={draft.kind} onValueChange={(v) => patch({ kind: v as BackupRemoteConfig["kind"] })}>
          <SelectTrigger className="h-8 w-40 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="s3">{t("backup.remote.kindS3")}</SelectItem>
            <SelectItem value="webdav">{t("backup.remote.kindWebdav")}</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>

      <SettingRow title={isS3 ? t("backup.remote.endpoint") : t("backup.remote.webdavUrl")} description={isS3 ? t("backup.remote.endpointHint") : t("backup.remote.webdavUrlHint")} stacked>
        <Input
          value={draft.endpoint}
          onChange={(e) => patch({ endpoint: e.target.value })}
          placeholder={isS3 ? "https://s3.us-east-1.amazonaws.com" : "https://dav.jianguoyun.com/dav/备份"}
          className="h-8 text-xs"
        />
      </SettingRow>

      {isS3 ? (
        <div className="grid gap-3 px-4 py-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-[11px] text-muted-foreground">{t("backup.remote.bucket")}</label>
            <Input
              value={draft.bucket}
              onChange={(e) => patch({ bucket: e.target.value })}
              className="h-8 text-xs"
              placeholder="my-backups"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-muted-foreground">{t("backup.remote.region")}</label>
            <Input
              value={draft.region}
              onChange={(e) => patch({ region: e.target.value })}
              className="h-8 text-xs"
              placeholder="us-east-1"
            />
          </div>
        </div>
      ) : null}

      <div className="grid gap-3 px-4 py-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-[11px] text-muted-foreground">
            {isS3 ? t("backup.remote.accessKey") : t("backup.remote.username")}
          </label>
          <Input
            value={draft.accessKey}
            onChange={(e) => patch({ accessKey: e.target.value })}
            className="h-8 text-xs"
            autoComplete="off"
          />
        </div>
        <div>
          <label className="mb-1 block text-[11px] text-muted-foreground">
            {isS3 ? t("backup.remote.secretKey") : t("backup.remote.appPassword")}
          </label>
          <PasswordInput
            value={draft.secretKey}
            onChange={(v) => patch({ secretKey: v })}
            placeholder={isS3 ? "" : t("backup.remote.appPasswordHint")}
          />
        </div>
      </div>

      <SettingRow title={t("backup.remote.prefix")} description={t("backup.remote.prefixHint")} stacked>
        <Input
          value={draft.prefix}
          onChange={(e) => patch({ prefix: e.target.value })}
          className="h-8 text-xs"
          placeholder="OmniStudio"
        />
      </SettingRow>

      {isS3 && (
        <SettingRow title={t("backup.remote.pathStyle")} description={t("backup.remote.pathStyleHint")}>
          <Switch
            checked={draft.forcePathStyle}
            onCheckedChange={(v) => patch({ forcePathStyle: v })}
            disabled={running}
          />
        </SettingRow>
      )}

      <SettingRow title={t("backup.remote.autoUpload")} description={t("backup.remote.autoUploadHint")}>
        <Switch checked={draft.autoUpload} onCheckedChange={(v) => patch({ autoUpload: v })} disabled={running} />
      </SettingRow>

      <SettingRow title={t("backup.remote.deleteLocal")} description={t("backup.remote.deleteLocalHint")}>
        <Switch
          checked={draft.deleteLocalAfterUpload}
          onCheckedChange={(v) => patch({ deleteLocalAfterUpload: v })}
          disabled={running}
        />
      </SettingRow>

      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <Button size="sm" onClick={() => saveMutation.mutate()} disabled={!dirty || saveMutation.isPending}>
          {saveMutation.isPending ? <Spinner data-icon="inline-start" /> : <CheckIcon data-icon="inline-start" />}
          {dirty ? t("common.save") : t("backup.remote.saved")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => testMutation.mutate()} disabled={testMutation.isPending}>
          {testMutation.isPending ? <Spinner data-icon="inline-start" /> : <CloudUploadIcon data-icon="inline-start" />}
          {t("backup.remote.test")}
        </Button>
        {testResult && (
          <span className={`text-[11px] ${testResult.ok ? "text-emerald-600" : "text-destructive"}`}>
            {testResult.text}
          </span>
        )}
      </div>

      {configured && (
        <div className="border-t">
          <div className="flex items-center justify-between px-4 py-2">
            <span className="text-[11px] font-medium text-muted-foreground">{t("backup.remote.listTitle")}</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => queryClient.invalidateQueries({ queryKey: ["backup-remote-list"] })}
            >
              {t("backup.remote.refresh")}
            </Button>
          </div>
          {progress?.kind === "download" && (
            <div className="px-4 pb-3">
              <ProgressBar progress={progress} />
            </div>
          )}
          {remoteList.data?.error ? (
            <p className="px-4 pb-4 text-[11px] text-destructive">{remoteList.data.error}</p>
          ) : remoteList.isLoading ? (
            <p className="flex items-center gap-2 px-4 pb-4 text-[11px] text-muted-foreground">
              <Spinner /> {t("backup.remote.loading")}
            </p>
          ) : (remoteList.data?.entries.length ?? 0) === 0 ? (
            <p className="px-4 pb-4 text-[11px] text-muted-foreground">{t("backup.remote.empty")}</p>
          ) : (
            remoteList.data!.entries.map((entry: BackupRemoteEntry) => (
              <div key={entry.name} className="flex items-center gap-3 border-t px-4 py-2.5">
                <CloudUploadIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs">{entry.name}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {formatTime(entry.modifiedAt)} · {formatBytes(entry.bytes)}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={running}
                  onClick={() => downloadMutation.mutate(entry.name)}
                >
                  <DownloadIcon data-icon="inline-start" />
                  {t("backup.remote.download")}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={running}
                  title={t("backup.remote.delete")}
                  onClick={() => deleteMutation.mutate(entry.name)}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
            ))
          )}
        </div>
      )}
    </SettingsSection>
  );
}

/** 任务终态卡片：创建给路径（含远端位置），恢复给"写回了什么"与安全备份位置。 */
function ResultCard({ event }: { event: BackupFinishedEvent }) {
  const t = useT();
  if (event.kind === "create" && event.result && "manifest" in event.result) {
    const result = event.result;
    return (
      <div className="mb-4 flex items-start gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-xs">
        <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-emerald-700 dark:text-emerald-500">
            {t("backup.create.done", { size: formatBytes(result.bytes) })}
          </p>
          {result.uploaded ? (
            <p className="mt-0.5 break-all text-muted-foreground">
              {t("backup.result.uploadedTo")}
              {result.uploaded.location}
            </p>
          ) : null}
          {result.localDeleted ? (
            <p className="mt-0.5 text-muted-foreground">{t("backup.result.localDeleted")}</p>
          ) : (
            <p className="mt-0.5 break-all text-muted-foreground">{result.path}</p>
          )}
        </div>
        {!result.localDeleted && (
          <Button size="sm" variant="ghost" onClick={() => rpcClient.backupReveal({ path: result.path })}>
            <FolderOpenIcon data-icon="inline-start" />
            {t("backup.history.reveal")}
          </Button>
        )}
      </div>
    );
  }
  if (event.kind === "download" && event.result && "path" in event.result) {
    return (
      <div className="mb-4 flex items-start gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-xs">
        <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-emerald-700 dark:text-emerald-500">
            {t("backup.remote.downloaded", { size: formatBytes(event.result.bytes) })}
          </p>
          <p className="mt-0.5 break-all text-muted-foreground">{event.result.path}</p>
        </div>
      </div>
    );
  }
  if (event.kind === "restore" && event.result && "scopes" in event.result) {
    const result = event.result;
    const rows = result.tables.reduce((sum, x) => sum + x.rows, 0);
    return (
      <div className="mb-4 flex items-start gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-xs">
        <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-emerald-700 dark:text-emerald-500">
            {t("backup.restore.done", { rows: String(rows), files: String(result.files) })}
          </p>
          {result.safetyPath && (
            <p className="mt-0.5 break-all text-muted-foreground">
              {t("backup.restore.safetyAt")}
              {result.safetyPath}
            </p>
          )}
          {result.warnings.map((w) => (
            <p key={w} className="mt-0.5 break-words text-amber-600 dark:text-amber-500">
              {w}
            </p>
          ))}
        </div>
      </div>
    );
  }
  return null;
}

function HistoryRow({
  item,
  disabled,
  onRestore,
  onReveal,
  onDelete,
}: {
  item: BackupSummary;
  disabled: boolean;
  onRestore: () => void;
  onReveal: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <div className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0">
      <ArchiveIcon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">{item.name}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          <span>{formatTime(item.createdAt)}</span>
          <span>{formatBytes(item.bytes)}</span>
          {item.appVersion && <span>v{item.appVersion}</span>}
          {item.encrypted && (
            <Badge variant="secondary">
              <LockIcon className="mr-1 size-3" />
              {t("backup.history.encrypted")}
            </Badge>
          )}
          {item.redacted && <Badge variant="secondary">{t("backup.history.redacted")}</Badge>}
        </p>
        {item.error ? (
          <p className="mt-0.5 text-[11px] text-destructive">{t("backup.history.corrupted")}</p>
        ) : (
          <p className="mt-0.5 flex flex-wrap gap-1">
            {item.scopes.map((id) => (
              <span key={id} className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {t(`backup.scope.${id}.title`)}
              </span>
            ))}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="outline" onClick={onRestore} disabled={disabled || !!item.error}>
          <DownloadIcon data-icon="inline-start" />
          {t("backup.history.restore")}
        </Button>
        <Button size="icon" variant="ghost" onClick={onReveal} title={t("backup.history.reveal")}>
          <FolderOpenIcon className="size-3.5" />
        </Button>
        <Button size="icon" variant="ghost" onClick={() => setConfirmOpen(true)} title={t("backup.history.delete")}>
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("backup.history.deleteTitle")}</DialogTitle>
            <DialogDescription>{item.name}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={() => setConfirmOpen(false)}>
              {t("backup.restore.confirmCancel")}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => {
                setConfirmOpen(false);
                onDelete();
              }}
            >
              {t("backup.history.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
