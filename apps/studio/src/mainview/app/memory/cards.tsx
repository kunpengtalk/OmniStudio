import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BrainIcon, CheckIcon, DownloadIcon, HistoryIcon, RefreshCwIcon, EraserIcon, SparklesIcon, UploadIcon, XIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Spinner } from "@ui/spinner";
import { Switch } from "@ui/switch";
import { Badge } from "@ui/badge";
import { useT } from "@stores/ui-lang";
import { SettingsSection, SettingRow } from "@components/setting-ui";
import type { MemoryEventEntry } from "@/shared/memory";
import { CATEGORY_KEY } from "./constants";

/** 同步到外部 Agent 卡片：目标工具勾选 + 一键同步 / 移除区块。 */
export function MemorySyncCard() {
  const t = useT();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ["memory-sync-status"],
    queryFn: () => rpcClient.memorySyncStatus(undefined),
  });
  const targets = data?.targets ?? [];

  // 已同步的默认勾选；未同步但已安装的工具也预勾选（一次点击即接入）。
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const effectiveSelected = useMemo(() => {
    if (selected) return selected;
    const preset = new Set<string>();
    for (const target of targets) {
      if (target.hasBlock || target.installed) preset.add(target.tool);
    }
    return preset;
  }, [selected, targets]);
  const toggle = (tool: string) => {
    const next = new Set(effectiveSelected);
    if (next.has(tool)) next.delete(tool);
    else next.add(tool);
    setSelected(next);
  };

  const applyMutation = useMutation({
    mutationFn: (remove: boolean) =>
      rpcClient.memorySyncApply({ tools: [...effectiveSelected], remove }),
    onSuccess: () => {
      setSelected(null);
      queryClient.invalidateQueries({ queryKey: ["memory-sync-status"] });
    },
  });

  return (
    <SettingsSection
      title={t("settings.memory.sync.title")}
      description={t("settings.memory.sync.desc")}
      actions={
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => applyMutation.mutate(true)}
            disabled={applyMutation.isPending || effectiveSelected.size === 0}
          >
            <EraserIcon data-icon="inline-start" />
            {t("settings.memory.sync.remove")}
          </Button>
          <Button
            size="sm"
            className="h-7 text-xs"
            onClick={() => applyMutation.mutate(false)}
            disabled={applyMutation.isPending || effectiveSelected.size === 0}
          >
            {applyMutation.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <RefreshCwIcon data-icon="inline-start" />
            )}
            {t("settings.memory.sync.apply")}
          </Button>
        </div>
      }
    >
      {targets.map((target) => (
        <SettingRow
          key={target.tool}
          title={
            <span className="flex items-center gap-2">
              {target.name}
              {target.hasBlock ? (
                <Badge variant="secondary" className="text-[10px]">
                  {t("settings.memory.sync.synced")}
                </Badge>
              ) : null}
              {!target.installed && (
                <Badge variant="outline" className="text-[10px] text-muted-foreground">
                  {t("settings.memory.sync.notInstalled")}
                </Badge>
              )}
            </span>
          }
          description={target.path.replace(/^\/Users\/[^/]+/, "~")}
        >
          <Switch checked={effectiveSelected.has(target.tool)} onCheckedChange={() => toggle(target.tool)} />
        </SettingRow>
      ))}
      {targets.length === 0 && (
        <SettingRow title={t("settings.memory.sync.noTargets")} description={t("settings.memory.sync.noTargetsHint")}>
          <BrainIcon className="size-4 text-muted-foreground" />
        </SettingRow>
      )}
      <p className="px-4 py-2 text-[11px] leading-relaxed text-muted-foreground">
        {t("settings.memory.sync.writebackHint")}
      </p>
    </SettingsSection>
  );
}

/** 总开关卡片（设置页与记忆应用页共用）。 */
export function MemoryEnableCard() {
  const t = useT();
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  const settings = settingsQuery.data?.settings;
  const enabled = settings?.MEMORY_ENABLED !== "0";
  const reviewMode = settings?.MEMORY_REVIEW_MODE === "1";
  const toggleMutation = useMutation({
    mutationFn: (patch: Record<string, string>) => rpcClient.updateSettings({ settings: patch }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });
  return (
    <SettingsSection>
      <SettingRow title={t("settings.memory.enable")} description={t("settings.memory.enableDesc")}>
        <Switch
          checked={enabled}
          onCheckedChange={(v) => toggleMutation.mutate({ MEMORY_ENABLED: v ? "1" : "0" })}
          disabled={toggleMutation.isPending}
        />
      </SettingRow>
      <SettingRow title={t("settings.memory.reviewMode")} description={t("settings.memory.reviewModeDesc")}>
        <Switch
          checked={reviewMode}
          onCheckedChange={(v) => toggleMutation.mutate({ MEMORY_REVIEW_MODE: v ? "1" : "0" })}
          disabled={toggleMutation.isPending || !enabled}
        />
      </SettingRow>
    </SettingsSection>
  );
}

/** 待确认队列：Agent / CLI / MCP 写入的记忆，用户批准后才进检索与注入。 */
export function MemoryPendingCard() {
  const t = useT();
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["memories", "pending"],
    queryFn: () => rpcClient.memoryPending(undefined),
  });
  const pending = data?.memories ?? [];

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["memories"] });
    queryClient.invalidateQueries({ queryKey: ["memory-stats"] });
  };
  const approveMutation = useMutation({
    mutationFn: (id: number) => rpcClient.memorySetStatus({ id, status: "active" }),
    onSuccess: invalidate,
  });
  const rejectMutation = useMutation({
    mutationFn: (id: number) => rpcClient.memoryDelete({ id }),
    onSuccess: invalidate,
  });

  if (pending.length === 0) return null;

  return (
    <SettingsSection
      title={t("settings.memory.pending.title")}
      description={t("settings.memory.pending.desc")}
      actions={
        <Button
          size="sm"
          className="h-7 text-xs"
          onClick={() => pending.forEach((m) => approveMutation.mutate(m.id))}
          disabled={approveMutation.isPending}
        >
          <CheckIcon data-icon="inline-start" />
          {t("settings.memory.pending.approveAll")}
        </Button>
      }
    >
      {pending.map((memory) => (
        <div key={memory.id} className="flex items-start justify-between gap-3 border-b px-4 py-3 last:border-b-0">
          <div className="min-w-0 flex-1">
            <p className="text-xs leading-relaxed">{memory.content}</p>
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
              <Badge variant="outline" className="text-[10px]">
                {t(CATEGORY_KEY(memory.category))}
              </Badge>
              {memory.scope ? <span>{t("settings.memory.scope.project")}</span> : null}
              <span>{memory.sourceRef ?? "agent"}</span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => approveMutation.mutate(memory.id)}
            >
              <CheckIcon data-icon="inline-start" />
              {t("settings.memory.pending.approve")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-destructive hover:text-destructive"
              onClick={() => rejectMutation.mutate(memory.id)}
            >
              <XIcon data-icon="inline-start" />
              {t("settings.memory.pending.reject")}
            </Button>
          </div>
        </div>
      ))}
    </SettingsSection>
  );
}


const EVENT_KEY = (action: string) => `settings.memory.event.${action}`;

/** 维护卡片：手动整理（归档 / 补向量）、导出导入、最近审计流水。 */
export function MemoryMaintenanceCard() {
  const t = useT();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");

  const eventsQuery = useQuery({
    queryKey: ["memory-events"],
    queryFn: () => rpcClient.memoryEvents({ limit: 8 }),
  });
  const maintainMutation = useMutation({
    mutationFn: () => rpcClient.memoryMaintain(undefined),
    onSuccess: (r) => {
      setMessage(
        t("settings.memory.maintain.done")
          .replace("{archived}", String(r.archived + r.expired))
          .replace("{merged}", String(r.consolidated))
          .replace("{embedded}", String(r.embedded)),
      );
      queryClient.invalidateQueries({ queryKey: ["memories"] });
      queryClient.invalidateQueries({ queryKey: ["memory-stats"] });
    },
  });
  const importMutation = useMutation({
    mutationFn: async (file: File) => {
      const payload = JSON.parse(await file.text());
      return rpcClient.memoryImport({ payload });
    },
    onSuccess: (r) => {
      setMessage(t("settings.memory.import.done").replace("{n}", String(r.imported)).replace("{m}", String(r.merged)));
      queryClient.invalidateQueries({ queryKey: ["memories"] });
      queryClient.invalidateQueries({ queryKey: ["memory-stats"] });
    },
    onError: (e) => setMessage(e instanceof Error ? e.message : String(e)),
  });

  const exportAll = async () => {
    const data = await rpcClient.memoryExport(undefined);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `omni-memories-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const events: MemoryEventEntry[] = eventsQuery.data?.events ?? [];

  return (
    <SettingsSection
      title={t("settings.memory.maintain.title")}
      description={t("settings.memory.maintain.desc")}
      actions={
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={exportAll}>
            <DownloadIcon data-icon="inline-start" />
            {t("settings.memory.export")}
          </Button>
          <label className="inline-flex">
            <input
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) importMutation.mutate(file);
                e.target.value = "";
              }}
            />
            <Button variant="outline" size="sm" className="h-7 text-xs" asChild>
              <span className="cursor-pointer">
                <UploadIcon data-icon="inline-start" />
                {t("settings.memory.import")}
              </span>
            </Button>
          </label>
          <Button
            size="sm"
            className="h-7 text-xs"
            onClick={() => maintainMutation.mutate()}
            disabled={maintainMutation.isPending}
          >
            {maintainMutation.isPending ? <Spinner data-icon="inline-start" /> : <SparklesIcon data-icon="inline-start" />}
            {t("settings.memory.maintain.run")}
          </Button>
        </div>
      }
    >
      <div className="px-4 py-3">
        {message ? <p className="mb-2 text-[11px] text-muted-foreground">{message}</p> : null}
        <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <HistoryIcon className="size-3.5" />
          {t("settings.memory.events.title")}
        </p>
        {events.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">{t("settings.memory.events.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {events.map((ev) => (
              <li key={ev.id} className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <Badge variant="outline" className="text-[10px]">
                  {t(EVENT_KEY(ev.action))}
                </Badge>
                <span className="truncate">
                  {ev.memoryId ? `#${ev.memoryId} ` : ""}
                  {eventDetail(ev)}
                </span>
                <span className="ml-auto shrink-0 tabular-nums">
                  {ev.createdAt ? new Date(ev.createdAt).toLocaleString() : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingsSection>
  );
}

/** 审计详情里最有用的一句：旧文本 / 原因 / 相似度。 */

function eventDetail(ev: MemoryEventEntry): string {
  const detail = ev.detail as Record<string, unknown> | null;
  if (!detail) return "";
  const text =
    (typeof detail.previousContent === "string" && detail.previousContent) ||
    (typeof detail.preview === "string" && detail.preview) ||
    (typeof detail.reason === "string" && detail.reason) ||
    "";
  const extra = typeof detail.similarity === "number" ? `（相似度 ${detail.similarity}）` : "";
  return `${text}${extra}`;
}

/** 记忆库列表卡片：过滤条件在 memory-ui store 里（与记忆应用页侧栏联动）。 */
