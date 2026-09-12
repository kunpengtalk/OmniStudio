import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BrainIcon,
  CheckIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  RefreshCwIcon,
  EraserIcon,
  Trash2Icon,
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
import { MEMORY_CATEGORIES, type MemoryCategory, type MemoryEntry } from "@/shared/memory";
import { PageHeader, SettingsSection, SettingRow } from "./setting-ui";

const CATEGORY_KEY = (c: MemoryCategory) => `settings.memory.category.${c}`;

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
  const [error, setError] = useState("");

  // 对话框每次打开用初始值重置本地状态
  const [openedFor, setOpenedFor] = useState<MemoryEntry | null | undefined>(undefined);
  if (open && openedFor !== initial) {
    setOpenedFor(initial);
    setContent(initial?.content ?? "");
    setCategory(initial?.category ?? "fact");
    setTagsText(initial?.tags.join(", ") ?? "");
    setPinned(initial?.pinned ?? false);
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

  return (
    <div className="flex items-start justify-between gap-3 border-b px-4 py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-xs leading-relaxed">{memory.content}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="text-[10px]">
            {t(CATEGORY_KEY(memory.category))}
          </Badge>
          {memory.pinned && (
            <Badge variant="secondary" className="text-[10px]">
              {t("settings.memory.pinned")}
            </Badge>
          )}
          <Badge variant="ghost" className="text-[10px] text-muted-foreground">
            {memory.source === "agent" ? t("settings.memory.source.agent") : t("settings.memory.source.manual")}
            {memory.usageCount > 0 ? ` · ${memory.usageCount}×` : ""}
          </Badge>
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
  const enabled = settingsQuery.data?.settings?.MEMORY_ENABLED !== "0";
  const toggleMutation = useMutation({
    mutationFn: (v: boolean) =>
      rpcClient.updateSettings({ settings: { MEMORY_ENABLED: v ? "1" : "0" } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });
  return (
    <SettingsSection>
      <SettingRow title={t("settings.memory.enable")} description={t("settings.memory.enableDesc")}>
        <Switch
          checked={enabled}
          onCheckedChange={(v) => toggleMutation.mutate(v)}
          disabled={toggleMutation.isPending}
        />
      </SettingRow>
    </SettingsSection>
  );
}

/** 记忆库列表卡片：过滤条件在 memory-ui store 里（与记忆应用页侧栏联动）。 */
export function MemoryListCard() {
  const t = useT();
  const query = useMemoryUi((s) => s.query);
  const setQuery = useMemoryUi((s) => s.setQuery);
  const category = useMemoryUi((s) => s.category);
  const setCategory = useMemoryUi((s) => s.setCategory);
  const [editing, setEditing] = useState<MemoryEntry | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const { data } = useQuery({
    queryKey: ["memories", query, category],
    queryFn: () =>
      rpcClient.memoryList({
        query: query.trim() || undefined,
        category: category === "all" || category === "pinned" ? undefined : (category as MemoryCategory),
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

/** 设置 → 工具 → 记忆：一键启用 + 记忆库管理 + 外部 Agent 同步。 */
export function MemoryTab() {
  const t = useT();
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t("settings.memory.title")} description={t("settings.memory.desc")} />
      <MemoryEnableCard />
      <MemoryListCard />
      <MemorySyncCard />
    </div>
  );
}
