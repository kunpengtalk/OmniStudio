// Skills 页共享组件：工具徽章、技能卡、SKILL.md 查看器、工具选择弹层、安装进度。
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  LinkIcon,
  Loader2Icon,
  BlocksIcon,
  RefreshCwIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Badge } from "@ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ui/dialog";
import { Markdown } from "@components/markdown";
import { useSkillsStore } from "@stores/skills";
import { useT } from "@stores/ui-lang";
import {
  toolDisplayName,
  type ManagedSkill,
  type SyncStatus,
  type ToolInfo,
} from "@/shared/skills";
import { cn } from "@/mainview/lib/utils";

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

/** 与提示词页 PlazaView 相同的筛选 chip 样式。 */
export function chipClass(active: boolean): string {
  return cn(
    "shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
    active
      ? "bg-primary text-primary-foreground"
      : "border text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground",
  );
}

/** 各区顶部固定工具栏：左侧图标 + 标题 + 统计，右侧操作区。 */
export function Toolbar({
  icon,
  title,
  stats,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  stats?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-1.5">
        {icon}
        <span className="truncate text-sm font-semibold">{title}</span>
        {stats && <span className="truncate text-xs text-muted-foreground">{stats}</span>}
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

/** 与 OCR 页 parts 相同样式的分段切换。 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly { value: T; label: string; icon?: React.ReactNode }[];
}) {
  return (
    <div className="flex gap-0.5 rounded-lg border bg-background p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors",
            value === o.value
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {o.icon}
          <span className="truncate">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

const SYNC_BADGE: Record<SyncStatus, { key: string; cls: string }> = {
  synced: { key: "skills.sync.synced", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400" },
  copied: { key: "skills.sync.copied", cls: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400" },
  outdated: { key: "skills.sync.outdated", cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400" },
  missing: { key: "skills.sync.missing", cls: "bg-muted text-muted-foreground line-through" },
  conflict: { key: "skills.sync.conflict", cls: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400" },
  central: { key: "skills.sync.central", cls: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400" },
};

/** 工具 × 同步状态徽章；onClick 提供时整枚可点（切换同步）。 */
export function ToolBadge({
  tool,
  status,
  onClick,
}: {
  tool: string;
  status: SyncStatus;
  onClick?: () => void;
}) {
  const t = useT();
  const badge = SYNC_BADGE[status];
  const content = (
    <>
      <span className="max-w-28 truncate">{toolDisplayName(tool)}</span>
      {status === "synced" && <CheckIcon className="size-3" />}
      {status === "copied" && <CopyIcon className="size-3" />}
      {status === "outdated" && <RefreshCwIcon className="size-3" />}
      {status === "central" && <LinkIcon className="size-3" />}
    </>
  );
  const cls = cn(
    "inline-flex h-5 items-center gap-1 rounded-full px-1.5 text-[10px] font-medium",
    badge.cls,
    onClick && "cursor-pointer hover:opacity-80",
  );
  return onClick ? (
    <button type="button" className={cls} onClick={onClick} title={t(badge.key)}>
      {content}
    </button>
  ) : (
    <span className={cls} title={t(badge.key)}>
      {content}
    </span>
  );
}

/** 工具选择弹层（同步到… / 批量同步）。 */
export function ToolPickerDialog({
  open,
  onOpenChange,
  title,
  tools,
  onSelect,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  tools: ToolInfo[];
  onSelect: (tool: string) => void;
  busy?: boolean;
}) {
  const t = useT();
  const [filter, setFilter] = useState("");
  const filtered = tools.filter(
    (x) => x.enabled && !x.isCentral && x.name.toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t("skills.tools.pickerHint")}</DialogDescription>
        </DialogHeader>
        <input
          className="w-full rounded-md border bg-transparent px-3 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
          placeholder={t("common.search")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="grid max-h-72 grid-cols-2 gap-1 overflow-y-auto">
          {filtered.map((tool) => (
            <button
              key={tool.key}
              type="button"
              disabled={busy || !tool.installed}
              onClick={() => onSelect(tool.key)}
              className={cn(
                "flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors",
                tool.installed
                  ? "hover:border-muted-foreground/40"
                  : "cursor-not-allowed opacity-40",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{tool.name}</span>
              {tool.installed && <CheckIcon className="size-3 text-muted-foreground/50" />}
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="col-span-2 py-4 text-center text-xs text-muted-foreground">
              {t("common.noResults")}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 安装进度行（市场卡 / 更新按钮共用）。 */
export function InstallState({ ref: installRef }: { ref: string }) {
  const t = useT();
  const progress = useSkillsStore((s) => s.progress[installRef]);
  const cancel = useMutation({
    mutationFn: () => rpcClient.skillsCancelInstall({ ref: installRef }),
  });
  if (!progress) return null;
  if (progress.phase === "done") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600">
        <CheckIcon className="size-3" />
        {t("skills.install.done")}
      </span>
    );
  }
  if (progress.phase === "error") {
    return (
      <span className="inline-flex max-w-56 items-center gap-1 truncate text-[11px] text-destructive" title={progress.message}>
        <XIcon className="size-3 shrink-0" />
        {progress.message || t("skills.install.failed")}
      </span>
    );
  }
  if (progress.phase === "canceled") {
    return <span className="text-[11px] text-muted-foreground">{t("skills.install.canceled")}</span>;
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <Loader2Icon className="size-3 animate-spin" />
      {t(progress.phase === "cloning" ? "skills.install.cloning" : "skills.install.installing")}
      <button
        type="button"
        className="ml-1 inline-flex items-center gap-0.5 text-destructive hover:underline"
        onClick={() => cancel.mutate()}
      >
        <XIcon className="size-3" />
        {t("common.cancel")}
      </button>
    </span>
  );
}

/** SKILL.md 查看器弹窗（我的技能 / 项目技能共用）。 */
export function SkillDocDialog({
  open,
  onOpenChange,
  fetchDoc,
  title,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fetchDoc: () => Promise<{ markdown: string | null }>;
  title: string;
  footer?: React.ReactNode;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["skill-doc", title, open],
    queryFn: fetchDoc,
    enabled: open,
    staleTime: 5_000,
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-hidden">
        <DialogHeader>
          <DialogTitle className="truncate pr-6">{title}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto pr-1">
          {isLoading ? (
            <div className="flex justify-center py-10">
              <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : data?.markdown ? (
            <Markdown content={data.markdown} />
          ) : (
            <p className="py-8 text-center text-xs text-muted-foreground">SKILL.md not found</p>
          )}
        </div>
        {footer && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}

/** 我的技能卡片。 */
export function SkillCard({
  skill,
  installedToolKeys,
  onOpenDoc,
  onRemoveTool,
  onAddTool,
  onDelete,
  selected,
  onToggleSelect,
  onUpdate,
}: {
  skill: ManagedSkill;
  installedToolKeys: Set<string>;
  onOpenDoc: () => void;
  onRemoveTool: (tool: string) => void;
  onAddTool: () => void;
  onDelete: () => void;
  selected?: boolean;
  onToggleSelect?: () => void;
  onUpdate?: () => void;
}) {
  const t = useT();
  const hasUpdate = (skill as ManagedSkill & { availableUpdate?: boolean }).availableUpdate === true;
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border px-4 py-3 transition-colors",
        selected ? "border-primary/60 bg-primary/5" : "hover:border-muted-foreground/30",
      )}
    >
      <div className="flex items-start gap-2.5">
        {onToggleSelect && (
          <input
            type="checkbox"
            className="mt-1 size-3.5 shrink-0 accent-primary"
            checked={!!selected}
            onChange={onToggleSelect}
          />
        )}
        <button type="button" className="min-w-0 flex-1 text-left" onClick={onOpenDoc}>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium">{skill.name}</span>
            {skill.sourceType === "skillssh" && (
              <Badge variant="secondary" className="h-4 px-1 text-[9px]">skills.sh</Badge>
            )}
            {skill.sourceType === "git" && (
              <Badge variant="secondary" className="h-4 px-1 text-[9px]">git</Badge>
            )}
            {skill.sourceType === "local" && (
              <Badge variant="secondary" className="h-4 px-1 text-[9px]">{t("skills.source.local")}</Badge>
            )}
            {hasUpdate && (
              <Badge className="h-4 bg-amber-100 px-1 text-[9px] text-amber-700 hover:bg-amber-100 dark:bg-amber-900/40 dark:text-amber-400">
                {t("skills.hasUpdate")}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
            {skill.description || skill.id}
          </p>
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          {skill.sourceRef && onUpdate && (
            <button
              type="button"
              title={t("skills.update")}
              onClick={onUpdate}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <RefreshCwIcon className="size-3.5" />
            </button>
          )}
          <button
            type="button"
            title={t("skills.openFolder")}
            onClick={() => rpcClient.skillsOpenFolder({ path: "central", skillId: skill.id })}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <FolderOpenIcon className="size-3.5" />
          </button>
          <button
            type="button"
            title={t("skills.delete")}
            onClick={onDelete}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2Icon className="size-3.5" />
          </button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {skill.targets
          .filter((x) => installedToolKeys.has(x.tool))
          .map((x) => (
            <ToolBadge
              key={x.tool}
              tool={x.tool}
              status={x.status}
              onClick={x.status === "central" ? undefined : () => onRemoveTool(x.tool)}
            />
          ))}
        <button
          type="button"
          onClick={onAddTool}
          className="inline-flex h-5 items-center gap-0.5 rounded-full border border-dashed px-1.5 text-[10px] text-muted-foreground transition-colors hover:border-muted-foreground/50 hover:text-foreground"
        >
          <BlocksIcon className="size-2.5" />
          {t("skills.syncToMore")}
        </button>
        {skill.tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex h-5 items-center rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground"
          >
            #{tag}
          </span>
        ))}
      </div>
      <InstallState ref={`update:${skill.id}`} />
    </div>
  );
}

export { ExternalLinkIcon };
