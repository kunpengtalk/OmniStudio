import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  BrainIcon,
  CheckIcon,
  DownloadIcon,
  HistoryIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  RefreshCwIcon,
  EraserIcon,
  SparklesIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import { Spinner } from "@ui/spinner";
import { Switch } from "@ui/switch";
import { Badge } from "@ui/badge";
import { Textarea } from "@ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { useT } from "@stores/ui-lang";
import { useMemoryUi } from "@stores/memory-ui";
import {
  MEMORY_CATEGORIES,
  type MemoryCategory,
  type MemoryEntry,
  type MemoryEventEntry,
  type MemoryStatus,
} from "@/shared/memory";
import { PageHeader, SettingsSection, SettingRow } from "./setting-ui";

const CATEGORY_KEY = (c: MemoryCategory) => `settings.memory.category.${c}`;
const STATUS_KEY = (s: MemoryStatus) => `settings.memory.status.${s}`;

/** 新建 / 编辑记忆对话框。 */
function MemoryDialog({
  open,
  initial,
  onClose,
}: {
  open: boolean;
  initial: MemoryEntry | null;
  onClose: () => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [content, setContent] = useState("");
  const [category, setCategory] = useState<MemoryCategory>("fact");
  const [tagsText, setTagsText] = useState("");
  const [pinned, setPinned] = useState(false);
  const [importance, setImportance] = useState(0.6);
  const [error, setError] = useState("");

  // 对话框每次打开用初始值重置本地状态
  const [openedFor, setOpenedFor] = useState<MemoryEntry | null | undefined>(undefined);
  if (open && openedFor !== initial) {
    setOpenedFor(initial);
    setContent(initial?.content ?? "");
    setCategory(initial?.category ?? "fact");
    setTagsText(initial?.tags.join(", ") ?? "");
    setPinned(initial?.pinned ?? false);
    setImportance(initial?.importance ?? 0.6);
    setError("");
  }
  if (!open && openedFor !== undefined) setOpenedFor(undefined);

  const saveMutation = useMutation({
    mutationFn: () => {
      if (!content.trim()) throw new Error(t("settings.memory.contentRequired"));
      return rpcClient.memorySave({
        memory: {
          id: initial?.id,
          content: content.trim(),
          category,
          tags: tagsText.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
          pinned,
          importance,
        },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["memories"] });
      onClose();
    },
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {initial ? t("settings.memory.editTitle") : t("settings.memory.addTitle")}
          </DialogTitle>
          <DialogDescription>{t("settings.memory.dialogDesc")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div>
            <Label className="mb-1 text-xs">{t("settings.memory.content")}</Label>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={t("settings.memory.contentPh")}
              className="min-h-20 text-xs"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="mb-1 text-xs">{t("settings.memory.category")}</Label>
              <Select value={category} onValueChange={(v) => setCategory(v as MemoryCategory)}>
                <SelectTrigger className="h-8 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MEMORY_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {t(CATEGORY_KEY(c))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="mb-1 text-xs">{t("settings.memory.tags")}</Label>
              <Input
                value={tagsText}
                onChange={(e) => setTagsText(e.target.value)}
                placeholder={t("settings.memory.tagsHint")}
                className="h-8 text-xs"
              />
            </div>
          </div>
          <label className="flex cursor-pointer items-center justify-between rounded-md border px-3 py-2">
            <span className="text-xs">{t("settings.memory.pinned")}</span>
            <Switch checked={pinned} onCheckedChange={setPinned} />
          </label>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <Label className="text-xs">{t("settings.memory.importance")}</Label>
              <span className="text-[11px] tabular-nums text-muted-foreground">{importance.toFixed(2)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={importance}
              onChange={(e) => setImportance(Number(e.target.value))}
              className="w-full accent-primary"
            />
            <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
              {t("settings.memory.importanceHint")}
            </p>
          </div>

          {(saveMutation.isError || error) && (
            <p className="text-xs text-destructive">
              {saveMutation.error instanceof Error
                ? saveMutation.error.message
                : error || String(saveMutation.error ?? "")}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? <Spinner data-icon="inline-start" /> : <CheckIcon data-icon="inline-start" />}
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 记忆来源 + 状态 + 热度的一行小字（详情行）。 */
function memoryMetaLine(memory: MemoryEntry, t: (k: string) => string): string {
  const parts = [
    memory.source === "agent" ? t("settings.memory.source.agent") : t("settings.memory.source.manual"),
    `${t("settings.memory.importance")} ${memory.importance.toFixed(2)}`,
  ];
  if (memory.usageCount > 0) parts.push(`${memory.usageCount}×`);
  if (memory.sourceRef) parts.push(memory.sourceRef);
  return parts.join(" · ");
}

function MemoryRow({ memory, onEdit }: { memory: MemoryEntry; onEdit: (m: MemoryEntry) => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["memories"] });

  const deleteMutation = useMutation({
    mutationFn: () => rpcClient.memoryDelete({ id: memory.id }),
    onSuccess: invalidate,
  });
  const pinMutation = useMutation({
    mutationFn: () => rpcClient.memorySetPinned({ id: memory.id, pinned: !memory.pinned }),
    onSuccess: invalidate,
  });
  const statusMutation = useMutation({
    mutationFn: (status: MemoryStatus) => rpcClient.memorySetStatus({ id: memory.id, status }),
    onSuccess: invalidate,
  });

  return (
    <div className="flex items-start justify-between gap-3 border-b px-4 py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-xs leading-relaxed">{memory.content}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="text-[10px]">
            {t(CATEGORY_KEY(memory.category))}
          </Badge>
          {memory.status !== "active" && (
            <Badge variant="destructive" className="text-[10px]">
              {t(STATUS_KEY(memory.status))}
            </Badge>
          )}
          {memory.pinned && (
            <Badge variant="secondary" className="text-[10px]">
              {t("settings.memory.pinned")}
            </Badge>
          )}
          {memory.scope && (
            <Badge variant="secondary" className="max-w-40 truncate text-[10px]" title={memory.scope}>
              {t("settings.memory.scope.project")}
            </Badge>
          )}
          <Badge variant="ghost" className="text-[10px] text-muted-foreground">
            {memoryMetaLine(memory, t)}
          </Badge>
          {memory.supersededBy != null && (
            <Badge variant="ghost" className="text-[10px] text-muted-foreground">
              → #{memory.supersededBy}
            </Badge>
          )}
          {memory.tags.map((tag) => (
            <span key={tag} className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              #{tag}
            </span>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 pt-0.5">
        <Button
          variant="ghost"
          size="icon-sm"
          className={memory.pinned ? "h-7 w-7 text-primary" : "h-7 w-7"}
          onClick={() => pinMutation.mutate()}
          title={memory.pinned ? t("settings.memory.unpin") : t("settings.memory.pin")}
        >
          {memory.pinned ? <PinIcon className="size-3.5" /> : <PinOffIcon className="size-3.5" />}
        </Button>
        {memory.status === "archived" ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="h-7 w-7"
            onClick={() => statusMutation.mutate("active")}
            title={t("settings.memory.restore")}
          >
            <ArchiveRestoreIcon className="size-3.5" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon-sm"
            className="h-7 w-7"
            onClick={() => statusMutation.mutate("archived")}
            title={t("settings.memory.archive")}
          >
            <ArchiveIcon className="size-3.5" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="h-7 w-7"
          onClick={() => onEdit(memory)}
          title={t("settings.memory.edit")}
        >
          <PencilIcon className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="h-7 w-7 text-destructive hover:text-destructive"
          onClick={() => deleteMutation.mutate()}
          title={t("settings.memory.delete")}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

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
export function MemoryListCard() {
  const t = useT();
  const query = useMemoryUi((s) => s.query);
  const setQuery = useMemoryUi((s) => s.setQuery);
  const category = useMemoryUi((s) => s.category);
  const setCategory = useMemoryUi((s) => s.setCategory);
  const status = useMemoryUi((s) => s.status);
  const setStatus = useMemoryUi((s) => s.setStatus);
  const [editing, setEditing] = useState<MemoryEntry | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const { data } = useQuery({
    queryKey: ["memories", query, category, status],
    queryFn: () =>
      rpcClient.memoryList({
        query: query.trim() || undefined,
        category: category === "all" || category === "pinned" ? undefined : (category as MemoryCategory),
        status: status as MemoryStatus | "open" | "all",
      }),
  });
  let memories = data?.memories ?? [];
  if (category === "pinned") memories = memories.filter((m) => m.pinned);

  return (
    <>
      <SettingsSection
        title={t("settings.memory.listTitle")}
        description={t("settings.memory.listDesc")}
        actions={
          <div className="flex items-center gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("settings.memory.searchPh")}
              className="h-7 w-40 text-xs"
            />
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="h-7 w-24 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("settings.memory.all")}</SelectItem>
                <SelectItem value="pinned">{t("settings.memory.pinned")}</SelectItem>
                {MEMORY_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {t(CATEGORY_KEY(c))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="h-7 w-24 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">{t("settings.memory.statusFilter.open")}</SelectItem>
                <SelectItem value="active">{t(STATUS_KEY("active"))}</SelectItem>
                <SelectItem value="pending">{t(STATUS_KEY("pending"))}</SelectItem>
                <SelectItem value="archived">{t(STATUS_KEY("archived"))}</SelectItem>
                <SelectItem value="all">{t("settings.memory.statusFilter.all")}</SelectItem>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <PlusIcon data-icon="inline-start" />
              {t("settings.memory.add")}
            </Button>
          </div>
        }
      >
        {memories.length === 0 ? (
          <SettingRow title={t("settings.memory.empty")} description={t("settings.memory.emptyHint")}>
            <BrainIcon className="size-4 text-muted-foreground" />
          </SettingRow>
        ) : (
          memories.map((m) => (
            <MemoryRow
              key={m.id}
              memory={m}
              onEdit={(mem) => {
                setEditing(mem);
                setDialogOpen(true);
              }}
            />
          ))
        )}
      </SettingsSection>

      <MemoryDialog open={dialogOpen} initial={editing} onClose={() => setDialogOpen(false)} />
    </>
  );
}

/** 设置 → 工具 → 记忆：开关 + 待确认队列 + 记忆库 + 维护 + 外部 Agent 同步。 */
export function MemoryTab() {
  const t = useT();
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t("settings.memory.title")} description={t("settings.memory.desc")} />
      <MemoryEnableCard />
      <MemoryPendingCard />
      <MemoryListCard />
      <MemoryMaintenanceCard />
      <MemorySyncCard />
    </div>
  );
}
