// 我的技能 Tab：中央库技能列表 + 工具同步徽章 + 详情 + 批量操作 + 更新。
// 布局与提示词页 PlazaView 同构：固定工具栏（标题+筛选+搜索+检查更新）→ 滚动内容区。
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Loader2Icon,
  PlusIcon,
  BlocksIcon,
  RefreshCwIcon,
  SearchIcon,
  TagIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { ScrollArea } from "@ui/scroll-area";
import { Spinner } from "@ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ui/dialog";
import { useT } from "@stores/ui-lang";
import { toolDisplayName } from "@/shared/skills";
import { SkillCard, SkillDocDialog, Toolbar, ToolPickerDialog, chipClass } from "./parts";

export function MySkillsTab() {
  const t = useT();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState<string>("all");
  const [toolFilter, setToolFilter] = useState<string>("all");
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [picker, setPicker] = useState<{ skillIds: string[] } | null>(null);
  const [docSkill, setDocSkill] = useState<string | null>(null);
  const [tagEditor, setTagEditor] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);

  const skillsQuery = useQuery({
    queryKey: ["skills"],
    queryFn: () => rpcClient.skillsList(undefined),
  });
  const toolsQuery = useQuery({
    queryKey: ["skills-tools"],
    queryFn: () => rpcClient.skillsGetTools(undefined),
  });
  const tagsQuery = useQuery({
    queryKey: ["skills-tags"],
    queryFn: () => rpcClient.skillsGetAllTags(undefined),
  });

  const skills = skillsQuery.data?.skills ?? [];
  const tools = toolsQuery.data?.tools ?? [];
  const installedToolKeys = useMemo(() => new Set(tools.map((x) => x.key)), [tools]);

  const checkUpdates = useMutation({
    mutationFn: () => rpcClient.skillsCheckUpdates({}),
    onSuccess: (data) => {
      // 把 availableUpdate 标记写进缓存（前端合并展示）。
      queryClient.setQueryData<{ skills: typeof skills }>(["skills"], (old) => {
        if (!old) return old;
        const map = new Map(data.statuses.map((s) => [s.id, s.status]));
        return {
          skills: old.skills.map((s) => ({
            ...s,
            availableUpdate: map.get(s.id) === "update_available",
          })),
        };
      });
    },
  });
  const updateOne = useMutation({
    mutationFn: (skillId: string) => rpcClient.skillsUpdateSkill({ skillId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["skills"] }),
  });
  const syncMutation = useMutation({
    mutationFn: ({ skillId, tool }: { skillId: string; tool: string }) =>
      rpcClient.skillsSyncToTool({ skillId, tool }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["skills"] }),
  });
  const unsyncMutation = useMutation({
    mutationFn: ({ skillId, tool }: { skillId: string; tool: string }) =>
      rpcClient.skillsUnsyncFromTool({ skillId, tool }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["skills"] }),
  });
  const deleteMutation = useMutation({
    mutationFn: (ids: string[]) => rpcClient.skillsDelete({ ids }),
    onSuccess: () => {
      setSelection(new Set());
      setConfirmDelete(null);
      queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  });
  const setTagsMutation = useMutation({
    mutationFn: ({ skillId, tags }: { skillId: string; tags: string[] }) =>
      rpcClient.skillsSetTags({ skillId, tags }),
    onSuccess: () => {
      setTagEditor(null);
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      queryClient.invalidateQueries({ queryKey: ["skills-tags"] });
    },
  });

  const q = search.trim().toLowerCase();
  const filtered = skills.filter((s) => {
    if (q && !`${s.name} ${s.id} ${s.description ?? ""}`.toLowerCase().includes(q)) return false;
    if (tagFilter === "none" && s.tags.length > 0) return false;
    if (tagFilter !== "all" && tagFilter !== "none" && !s.tags.includes(tagFilter)) return false;
    if (toolFilter !== "all" && !s.targets.some((x) => x.tool === toolFilter)) return false;
    return true;
  });

  const docSkillObj = skills.find((s) => s.id === docSkill);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar
        icon={<BlocksIcon className="size-4 text-muted-foreground" />}
        title={t("skills.nav.my")}
        stats={skills.length > 0 ? `${filtered.length} / ${skills.length}` : undefined}
      >
        {[
          { key: "all", label: t("common.all") },
          { key: "none", label: t("skills.my.untagged") },
          ...(tagsQuery.data?.tags ?? []).map((tag) => ({ key: `tag:${tag}`, label: `#${tag}` })),
        ].map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTagFilter(item.key === tagFilter ? "all" : item.key)}
            className={chipClass(tagFilter === item.key)}
          >
            {item.label}
          </button>
        ))}
        {tools.filter((x) => x.enabled && x.installed).length > 0 && (
          <select
            className="h-8 rounded-lg border bg-transparent px-2 text-xs text-muted-foreground outline-none"
            value={toolFilter}
            onChange={(e) => setToolFilter(e.target.value)}
          >
            <option value="all">{t("skills.my.allTools")}</option>
            {tools
              .filter((x) => x.enabled && x.installed)
              .map((x) => (
                <option key={x.key} value={x.key}>
                  {x.name}
                </option>
              ))}
          </select>
        )}
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          disabled={checkUpdates.isPending || skills.length === 0}
          onClick={() => checkUpdates.mutate()}
        >
          {checkUpdates.isPending ? (
            <Loader2Icon data-icon="inline-start" className="animate-spin" />
          ) : (
            <RefreshCwIcon data-icon="inline-start" />
          )}
          {t("skills.checkUpdates")}
        </Button>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("skills.my.searchPlaceholder")}
            className="h-8 w-52 pl-8 text-xs"
          />
          {search && (
            <button
              type="button"
              aria-label={t("common.cancel")}
              onClick={() => setSearch("")}
              className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <XIcon className="size-3.5" />
            </button>
          )}
        </div>
      </Toolbar>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 p-4">
          {/* 批量栏 */}
          {selection.size > 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 text-xs">
              <span className="font-medium">{t("skills.my.selected", { n: String(selection.size) })}</span>
              <Button size="sm" variant="outline" className="ml-auto h-7" onClick={() => setPicker({ skillIds: [...selection] })}>
                <PlusIcon data-icon="inline-start" />
                {t("skills.my.batchSync")}
              </Button>
              <Button size="sm" variant="outline" className="h-7" disabled={selection.size !== 1} onClick={() => {
                const id = [...selection][0]!;
                setTagInput((skills.find((s) => s.id === id)?.tags ?? []).join(", "));
                setTagEditor(id);
              }}>
                <TagIcon data-icon="inline-start" />
                {t("skills.my.tag")}
              </Button>
              <Button size="sm" variant="destructive" className="h-7" onClick={() => setConfirmDelete([...selection])}>
                <Trash2Icon data-icon="inline-start" />
                {t("common.delete")}
              </Button>
            </div>
          )}

          {skillsQuery.isLoading ? (
            <div className="flex justify-center py-16">
              <Spinner className="size-5" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
              <div className="flex size-16 items-center justify-center rounded-2xl bg-primary/10">
                <BlocksIcon className="size-7 text-muted-foreground" />
              </div>
              <p className="max-w-sm text-xs leading-5 text-muted-foreground">
                {skills.length === 0 ? t("skills.my.empty") : t("common.noResults")}
              </p>
            </div>
          ) : (
            filtered.map((skill) => (
              <SkillCard
                key={skill.id}
                skill={skill}
                installedToolKeys={installedToolKeys}
                onOpenDoc={() => setDocSkill(skill.id)}
                onRemoveTool={(tool) => unsyncMutation.mutate({ skillId: skill.id, tool })}
                onAddTool={() => setPicker({ skillIds: [skill.id] })}
                onDelete={() => setConfirmDelete([skill.id])}
                selected={selection.has(skill.id)}
                onToggleSelect={() =>
                  setSelection((s) => {
                    const next = new Set(s);
                    if (next.has(skill.id)) next.delete(skill.id);
                    else next.add(skill.id);
                    return next;
                  })
                }
                onUpdate={() => updateOne.mutate(skill.id)}
              />
            ))
          )}
        </div>
      </ScrollArea>

      {/* 同步到… */}
      <ToolPickerDialog
        open={!!picker}
        onOpenChange={(open) => !open && setPicker(null)}
        title={t("skills.my.syncTo")}
        tools={tools}
        busy={syncMutation.isPending}
        onSelect={(tool) => {
          for (const skillId of picker?.skillIds ?? []) {
            syncMutation.mutate({ skillId, tool });
          }
          setPicker(null);
        }}
      />

      {/* SKILL.md 详情 */}
      <SkillDocDialog
        open={!!docSkill}
        onOpenChange={(open) => !open && setDocSkill(null)}
        title={docSkillObj?.name ?? docSkill ?? ""}
        fetchDoc={() => rpcClient.skillsGetDoc({ skillId: docSkill! })}
        footer={
          docSkillObj && (
            <div className="flex flex-wrap items-center gap-1.5">
              {docSkillObj.targets.map((x) => (
                <span key={x.tool} className="text-[11px] text-muted-foreground">
                  {toolDisplayName(x.tool)}
                </span>
              ))}
            </div>
          )
        }
      />

      {/* 标签编辑 */}
      <Dialog open={!!tagEditor} onOpenChange={(open) => !open && setTagEditor(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("skills.my.editTags")}</DialogTitle>
            <DialogDescription>{t("skills.my.editTagsHint")}</DialogDescription>
          </DialogHeader>
          <Input
            className="h-9 text-xs"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            placeholder="tag1, tag2"
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setTagEditor(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              disabled={setTagsMutation.isPending}
              onClick={() =>
                tagEditor &&
                setTagsMutation.mutate({
                  skillId: tagEditor,
                  tags: tagInput.split(/[,，]/).map((x) => x.trim()).filter(Boolean),
                })
              }
            >
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <Dialog open={!!confirmDelete} onOpenChange={(open) => !open && setConfirmDelete(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("skills.my.deleteTitle")}</DialogTitle>
            <DialogDescription>
              {t("skills.my.deleteDesc", { n: String(confirmDelete?.length ?? 0) })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmDelete(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="destructive" size="sm" disabled={deleteMutation.isPending} onClick={() => confirmDelete && deleteMutation.mutate(confirmDelete)}>
              {deleteMutation.isPending ? <Loader2Icon className="size-3.5 animate-spin" /> : <Trash2Icon className="size-3.5" />}
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
