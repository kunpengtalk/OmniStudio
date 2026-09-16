import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArchiveIcon, ArchiveRestoreIcon, CheckIcon, PencilIcon, PinIcon, PinOffIcon, Trash2Icon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import { Spinner } from "@ui/spinner";
import { Switch } from "@ui/switch";
import { Badge } from "@ui/badge";
import { Textarea } from "@ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { useT } from "@stores/ui-lang";
import { CATEGORY_KEY, STATUS_KEY } from "./constants";
import { MEMORY_CATEGORIES, type MemoryCategory, type MemoryEntry, type MemoryStatus } from "@/shared/memory";

/** 新建 / 编辑记忆对话框。 */
export function MemoryDialog({
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

export function MemoryRow({ memory, onEdit }: { memory: MemoryEntry; onEdit: (m: MemoryEntry) => void }) {
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
