import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileTextIcon, HistoryIcon, ImageIcon, Loader2Icon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { Switch } from "@ui/switch";
import { formatSize } from "@/mainview/lib/format";
import { Textarea } from "@ui/textarea";
import { useT } from "@stores/ui-lang";
import { PageHeader, SettingsSection, SettingRow } from "@components/setting-ui";

/**
 * 设置 → Agent 能力：对齐 Codex 的那批开关。
 *
 * 现在有两组：
 * - 项目指令（AGENTS.md）：从工作区向上找到仓库根逐级装载，注入系统提示；
 * - 看图工具（view_image）：只有视觉模型收得下图片内容块，默认按模型名自动判断。
 *
 * 这里同时把「实际读到了哪几个文件」「当前模型能不能收图」显示出来 ——
 * 开关是抽象的，"装载了什么"才是用户能核对的事实。
 */
export function AgentCapsTab() {
  const t = useT();
  const queryClient = useQueryClient();

  const instructionsQuery = useQuery({
    queryKey: ["agent-instructions"],
    queryFn: () => rpcClient.getAgentInstructions(undefined),
  });
  const capsQuery = useQuery({
    queryKey: ["agent-capabilities"],
    queryFn: () => rpcClient.getAgentCapabilities(undefined),
  });
  const snapshotsQuery = useQuery({
    queryKey: ["agent-snapshots", "settings"],
    queryFn: () => rpcClient.listAgentSnapshots(undefined),
  });
  const sandboxQuery = useQuery({
    queryKey: ["agent-sandbox"],
    queryFn: () => rpcClient.getAgentSandbox(undefined),
  });
  const notifyQuery = useQuery({
    queryKey: ["agent-notify"],
    queryFn: () => rpcClient.getAgentNotify(undefined),
  });
  const hooksQuery = useQuery({
    queryKey: ["agent-hooks"],
    queryFn: () => rpcClient.getAgentHooks(undefined),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["agent-instructions"] });
    queryClient.invalidateQueries({ queryKey: ["agent-capabilities"] });
    queryClient.invalidateQueries({ queryKey: ["agent-snapshots"] });
    queryClient.invalidateQueries({ queryKey: ["agent-sandbox"] });
    queryClient.invalidateQueries({ queryKey: ["agent-notify"] });
    queryClient.invalidateQueries({ queryKey: ["agent-hooks"] });
  };

  const setInstructions = useMutation({
    mutationFn: (params: { enabled?: boolean; maxBytes?: number }) =>
      rpcClient.setAgentInstructions(params),
    onSuccess: invalidate,
  });
  const setVision = useMutation({
    mutationFn: (mode: "auto" | "on" | "off") => rpcClient.setAgentCapabilities({ visionTool: mode }),
    onSuccess: invalidate,
  });
  const setSnapshots = useMutation({
    mutationFn: (enabled: boolean) => rpcClient.setAgentSnapshots({ enabled }),
    onSuccess: invalidate,
  });
  /** 手动整理影子仓库：设置页显示占用，顺手给一个"立即清理"的入口。 */
  const gcSnapshots = useMutation({
    mutationFn: () => rpcClient.gcAgentSnapshots(undefined),
    onSuccess: invalidate,
  });
  const setHooks = useMutation({
    mutationFn: (raw: string) => rpcClient.setAgentHooks({ raw }),
    onSuccess: invalidate,
  });
  const setNotify = useMutation({
    mutationFn: (command: string) => rpcClient.setAgentNotify({ command }),
    onSuccess: invalidate,
  });
  const setSandbox = useMutation({
    mutationFn: (params: { mode?: "off" | "workspace-write" | "read-only"; allowNetwork?: boolean }) =>
      rpcClient.setAgentSandbox(params),
    onSuccess: invalidate,
  });

  const instructions = instructionsQuery.data;
  const caps = capsQuery.data;
  const limitKb = instructions ? Math.round(instructions.maxBytes / 1024) : 8;

  // 上限输入框用本地态：每次按键都提交会把输入框和查询结果来回顶，
  // 也让服务端收到一串没意义的中间值（1 -> 12 -> 128）。
  const [limitDraft, setLimitDraft] = useState(String(limitKb));
  const [notifyDraft, setNotifyDraft] = useState("");
  const [hooksDraft, setHooksDraft] = useState("[]");
  useEffect(() => {
    setLimitDraft(String(limitKb));
  }, [limitKb]);

  // 外部通知命令同样用本地态 + 失焦提交：跑一次命令不该在每次按键时发生。
  useEffect(() => {
    setNotifyDraft(notifyQuery.data?.command ?? "");
  }, [notifyQuery.data?.command]);

  useEffect(() => {
    setHooksDraft(hooksQuery.data?.raw ?? "[]");
  }, [hooksQuery.data?.raw]);

  const commitLimit = () => {
    const kb = Number(limitDraft);
    if (!Number.isFinite(kb) || kb < 1 || Math.round(kb) === limitKb) {
      setLimitDraft(String(limitKb));
      return;
    }
    setInstructions.mutate({ maxBytes: Math.floor(kb * 1024) });
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t("settings.agentCaps.title")} description={t("settings.agentCaps.desc")} />

      <SettingsSection
        title={t("settings.agentCaps.instructions.title")}
        description={t("settings.agentCaps.instructions.desc")}
        actions={
          instructionsQuery.isLoading ? (
            <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
          ) : (
            <Switch
              checked={instructions?.enabled ?? true}
              onCheckedChange={(checked) => setInstructions.mutate({ enabled: checked })}
            />
          )
        }
      >
        <SettingRow
          title={t("settings.agentCaps.instructions.limit")}
          description={instructions?.userPath ? t("settings.agentCaps.instructions.userFile") + `: ${instructions.userPath}` : undefined}
        >
          <Input
            className="h-8 w-24 text-xs"
            type="number"
            min={1}
            max={256}
            value={limitDraft}
            onChange={(event) => setLimitDraft(event.target.value)}
            onBlur={commitLimit}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitLimit();
            }}
          />
          <span className="text-xs text-muted-foreground">KB</span>
        </SettingRow>

        <SettingRow title={t("settings.agentCaps.instructions.files")} stacked>
          {instructionsQuery.isLoading ? (
            <div className="h-8 animate-pulse rounded bg-muted" />
          ) : instructions && instructions.files.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {instructions.files.map((file) => (
                <li key={file.path} className="flex items-center gap-2 text-xs">
                  <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span
                    className={
                      file.source === "user"
                        ? "rounded bg-sky-500/10 px-1 text-[10px] text-sky-600 dark:text-sky-400"
                        : "rounded bg-muted px-1 text-[10px] text-muted-foreground"
                    }
                  >
                    {t(
                      file.source === "user"
                        ? "settings.agentCaps.instructions.source.user"
                        : "settings.agentCaps.instructions.source.project",
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>
                    {file.path}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {(file.bytes / 1024).toFixed(1)} KB
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              {instructions?.workspace
                ? t("settings.agentCaps.instructions.noFiles")
                : t("settings.agentCaps.instructions.noWorkspace")}
            </p>
          )}
          {instructions?.truncated && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {t("settings.agentCaps.instructions.truncated")}
            </p>
          )}
        </SettingRow>
      </SettingsSection>

      <SettingsSection
        title={t("settings.agentCaps.vision.title")}
        description={t("settings.agentCaps.vision.desc")}
      >
        <SettingRow title={t("settings.agentCaps.vision.mode")}>
          <Select
            value={caps?.visionTool ?? "auto"}
            onValueChange={(value) => setVision.mutate(value as "auto" | "on" | "off")}
          >
            <SelectTrigger className="h-8 w-44 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{t("settings.agentCaps.vision.mode.auto")}</SelectItem>
              <SelectItem value="on">{t("settings.agentCaps.vision.mode.on")}</SelectItem>
              <SelectItem value="off">{t("settings.agentCaps.vision.mode.off")}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow title={t("settings.agentCaps.vision.current")} description={caps?.modelName || "—"}>
          <span
            className={
              caps?.visionAvailable
                ? "flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400"
                : "flex items-center gap-1 text-xs text-muted-foreground"
            }
          >
            <ImageIcon className="size-3.5" />
            {t(
              caps?.visionAvailable
                ? "settings.agentCaps.vision.available"
                : "settings.agentCaps.vision.unavailable",
            )}
          </span>
        </SettingRow>
      </SettingsSection>

      <SettingsSection
        title={t("settings.agentCaps.sandbox.title")}
        description={t("settings.agentCaps.sandbox.desc")}
      >
        <SettingRow
          title={t("settings.agentCaps.sandbox.mode")}
          description={
            sandboxQuery.data?.supported === false
              ? sandboxQuery.data.backend === "bwrap"
                ? t("settings.agentCaps.sandbox.noBwrap")
                : t("settings.agentCaps.sandbox.unsupported", { platform: sandboxQuery.data.platform })
              : t("settings.agentCaps.sandbox.backend", {
                  backend: sandboxQuery.data?.backend ?? "none",
                })
          }
        >
          <Select
            value={sandboxQuery.data?.mode ?? "off"}
            onValueChange={(value) =>
              setSandbox.mutate({ mode: value as "off" | "workspace-write" | "read-only" })
            }
            disabled={sandboxQuery.data?.supported === false}
          >
            <SelectTrigger className="h-8 w-44 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">{t("settings.agentCaps.sandbox.mode.off")}</SelectItem>
              <SelectItem value="workspace-write">
                {t("settings.agentCaps.sandbox.mode.workspaceWrite")}
              </SelectItem>
              <SelectItem value="read-only">
                {t("settings.agentCaps.sandbox.mode.readOnly")}
              </SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        {/* 升级流程是"被拦之后发生什么"的说明，没有开关可点，用一段说明占一行。 */}
        <p className="border-b px-4 py-3 text-xs text-muted-foreground last:border-b-0">
          {t("settings.agentCaps.sandbox.escalation")}
        </p>
        {/* Landlock：把"本机到底能不能用"照实写出来（真探测结果，不是理论上可以）。 */}
        <p className="border-b px-4 py-3 text-xs text-muted-foreground last:border-b-0">
          {t("settings.agentCaps.sandbox.landlock", {
            note: sandboxQuery.data?.landlock.note ?? "—",
          })}
        </p>
        <SettingRow
          title={t("settings.agentCaps.sandbox.network")}
          description={t("settings.agentCaps.sandbox.networkHint")}
        >
          <Switch
            checked={sandboxQuery.data?.allowNetwork ?? true}
            disabled={sandboxQuery.data?.mode !== "workspace-write"}
            onCheckedChange={(checked) => setSandbox.mutate({ allowNetwork: checked })}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection
        title={t("settings.agentCaps.hooks.title")}
        description={t("settings.agentCaps.hooks.desc")}
      >
        <SettingRow title={t("settings.agentCaps.hooks.config")} stacked>
          <Textarea
            className="min-h-24 font-mono text-xs"
            spellCheck={false}
            placeholder={t("settings.agentCaps.hooks.placeholder")}
            value={hooksDraft}
            onChange={(event) => setHooksDraft(event.target.value)}
            onBlur={() => {
              if (hooksDraft !== (hooksQuery.data?.raw ?? "[]")) setHooks.mutate(hooksDraft);
            }}
          />
          <p className="text-[11px] text-muted-foreground">
            {t("settings.agentCaps.hooks.hint", {
              events: (hooksQuery.data?.events ?? []).join(" / "),
            })}
          </p>
          {(hooksQuery.data?.hooks.length ?? 0) > 0 && (
            <ul className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
              {(hooksQuery.data?.hooks ?? []).map((hook, index) => (
                <li key={`${hook.event}-${index}`} className="truncate font-mono">
                  {hook.event} · {hook.command}
                </li>
              ))}
            </ul>
          )}
          {(hooksQuery.data?.errors.length ?? 0) > 0 && (
            <ul className="flex flex-col gap-0.5 text-[11px] text-destructive">
              {(hooksQuery.data?.errors ?? []).map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          )}
        </SettingRow>
      </SettingsSection>

      <SettingsSection
        title={t("settings.agentCaps.notify.title")}
        description={t("settings.agentCaps.notify.desc")}
      >
        <SettingRow title={t("settings.agentCaps.notify.command")} stacked>
          <Input
            className="h-8 font-mono text-xs"
            placeholder={t("settings.agentCaps.notify.placeholder")}
            value={notifyDraft}
            onChange={(event) => setNotifyDraft(event.target.value)}
            onBlur={() => {
              if (notifyDraft.trim() !== (notifyQuery.data?.command ?? "")) setNotify.mutate(notifyDraft);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") setNotify.mutate(notifyDraft);
            }}
          />
          <p className="text-[11px] text-muted-foreground">
            {t("settings.agentCaps.notify.hint")}
            {notifyQuery.data?.configured ? ` · ${t("settings.agentCaps.notify.on")}` : ""}
          </p>
        </SettingRow>
      </SettingsSection>

      <SettingsSection
        title={t("settings.agentCaps.snapshots.title")}
        description={t("settings.agentCaps.snapshots.desc")}
        actions={
          snapshotsQuery.isLoading ? (
            <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
          ) : (
            <Switch
              checked={snapshotsQuery.data?.enabled ?? true}
              disabled={snapshotsQuery.data?.gitAvailable === false}
              onCheckedChange={(checked) => setSnapshots.mutate(checked)}
            />
          )
        }
      >
        <SettingRow
          title={t("settings.agentCaps.snapshots.status")}
          description={snapshotsQuery.data?.workspace || t("settings.agentCaps.instructions.noWorkspace")}
        >
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <HistoryIcon className="size-3.5" />
            {snapshotsQuery.data?.gitAvailable === false
              ? t("settings.agentCaps.snapshots.noGit")
              : t("settings.agentCaps.snapshots.turns", {
                  count: String(snapshotsQuery.data?.turns ?? 0),
                })}
          </span>
        </SettingRow>

        {/* 占用与维护：影子仓库会跟着回合数长，用户要能看见它吃了多少、随时能清理。 */}
        <SettingRow
          title={t("settings.agentCaps.snapshots.disk")}
          description={t("settings.agentCaps.snapshots.diskHint", {
            threshold: String(Math.round((snapshotsQuery.data?.gcThresholds.bytes ?? 0) / 1024 / 1024)),
          })}
        >
          <span className="text-xs tabular-nums text-muted-foreground">
            {snapshotsQuery.data?.usage
              ? formatSize(snapshotsQuery.data.usage.bytes)
              : "—"}
          </span>
          <Button
            variant="outline"
            size="xs"
            className="h-7 text-[11px]"
            disabled={gcSnapshots.isPending || !snapshotsQuery.data?.usage}
            onClick={() => gcSnapshots.mutate()}
          >
            {gcSnapshots.isPending ? <Loader2Icon className="size-3 animate-spin" /> : null}
            {t("settings.agentCaps.snapshots.gc")}
          </Button>
        </SettingRow>
        {gcSnapshots.data && (
          <p className="border-b px-4 py-2 text-[11px] text-muted-foreground last:border-b-0">
            {gcSnapshots.data.ran
              ? t("settings.agentCaps.snapshots.gcDone", {
                  before: formatSize(gcSnapshots.data.bytesBefore),
                  after: formatSize(gcSnapshots.data.bytesAfter),
                })
              : (gcSnapshots.data.reason ?? t("settings.agentCaps.snapshots.gcSkipped"))}
          </p>
        )}
      </SettingsSection>
    </div>
  );
}
