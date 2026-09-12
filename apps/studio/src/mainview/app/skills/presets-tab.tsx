// 场景（预设）Tab：预设列表 + 应用 + 成员编辑 + 技能×工具开关（活动预设立即落盘）。
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckIcon,
  LayersIcon,
  Loader2Icon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
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
import { Input } from "@ui/input";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import { Toolbar, ToolBadge, ToolPickerDialog } from "./parts";

/** 新建预设的内置模板（用户提到的前端开发 / 数据分析场景）。 */
const PRESET_TEMPLATES = [
  { key: "blank", nameKey: "skills.presets.templateBlank", descZh: "", descEn: "" },
  { key: "frontend", nameKey: "skills.presets.templateFrontend", descZh: "前端开发工作流：组件生成、样式还原、测试与构建类技能", descEn: "Frontend workflow: components, styling, tests and build skills" },
  { key: "data", nameKey: "skills.presets.templateData", descZh: "数据分析工作流：数据清洗、可视化、报表生成类技能", descEn: "Data analysis workflow: cleaning, visualization and reporting skills" },
] as const;

export function PresetsTab() {
  const t = useT();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", template: "blank" });
  const [addSkills, setAddSkills] = useState(false);
  const [toolPickerFor, setToolPickerFor] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const presetsQuery = useQuery({
    queryKey: ["skills-presets"],
    queryFn: () => rpcClient.skillsListPresets(undefined),
  });
  const skillsQuery = useQuery({
    queryKey: ["skills"],
    queryFn: () => rpcClient.skillsList(undefined),
  });
  const toolsQuery = useQuery({
    queryKey: ["skills-tools"],
    queryFn: () => rpcClient.skillsGetTools(undefined),
  });

  const presets = presetsQuery.data?.presets ?? [];
  const active = selected ?? presets.find((p) => p.isActive)?.id ?? null;
  const activePreset = presets.find((p) => p.id === active);

  const createMutation = useMutation({
    mutationFn: () =>
      rpcClient.skillsCreatePreset({
        name: form.name.trim(),
        description: form.description.trim() || null,
      }),
    onSuccess: () => {
      setCreating(false);
      queryClient.invalidateQueries({ queryKey: ["skills-presets"] });
    },
  });
  const applyMutation = useMutation({
    mutationFn: (presetId: string) => rpcClient.skillsApplyPreset({ presetId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["skills"] }),
  });
  const setActiveMutation = useMutation({
    mutationFn: (presetId: string) => rpcClient.skillsSetActivePreset({ presetId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["skills-presets"] }),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => rpcClient.skillsDeletePreset({ id }),
    onSuccess: () => {
      setSelected(null);
      queryClient.invalidateQueries({ queryKey: ["skills-presets"] });
    },
  });
  const addMembers = useMutation({
    mutationFn: (skillIds: string[]) => rpcClient.skillsAddSkillsToPreset({ presetId: active!, skillIds }),
    onSuccess: () => {
      setAddSkills(false);
      queryClient.invalidateQueries({ queryKey: ["skills-presets"] });
    },
  });
  const removeMember = useMutation({
    mutationFn: (skillId: string) => rpcClient.skillsRemoveSkillFromPreset({ presetId: active!, skillId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["skills-presets"] }),
  });
  const toggleTool = useMutation({
    mutationFn: ({ skillId, tool, enabled }: { skillId: string; tool: string; enabled: boolean }) =>
      rpcClient.skillsTogglePresetSkillTool({ presetId: active!, skillId, tool, enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["skills"] }),
  });
  const updatePreset = useMutation({
    mutationFn: () =>
      rpcClient.skillsUpdatePreset({ id: active!, name: form.name.trim(), description: form.description.trim() || null }),
    onSuccess: () => {
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: ["skills-presets"] });
    },
  });

  const memberIds = activePreset?.skillIds ?? [];
  const memberSkills = (skillsQuery.data?.skills ?? []).filter((s) => memberIds.includes(s.id));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar
        icon={<LayersIcon className="size-4 text-muted-foreground" />}
        title={t("skills.nav.presets")}
        stats={presets.length > 0 ? `${presets.length}` : undefined}
      >
        <Button size="sm" variant="outline" className="h-8" onClick={() => {
          setForm({ name: "", description: "", template: "blank" });
          setCreating(true);
        }}>
          <PlusIcon data-icon="inline-start" />
          {t("skills.presets.new")}
        </Button>
      </Toolbar>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-4">
          {/* 预设卡列表 */}
          {presetsQuery.isLoading ? (
            <div className="flex justify-center py-16"><Spinner className="size-5" /></div>
          ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {presets.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setSelected(p.id)}
                className={cn(
                  "flex flex-col gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors",
                  active === p.id ? "border-primary/60 bg-primary/5" : "hover:border-muted-foreground/40",
                )}
              >
                <div className="flex w-full items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</span>
                  {p.isActive && (
                    <span className="inline-flex h-4 items-center gap-0.5 rounded-full bg-emerald-100 px-1 text-[9px] font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                      <CheckIcon className="size-2.5" />
                      {t("skills.presets.active")}
                    </span>
                  )}
                </div>
                <p className="line-clamp-2 text-[11px] text-muted-foreground">
                  {p.description || `${p.skillCount} ${t("skills.presets.skillsUnit")}`}
                </p>
              </button>
            ))}
          </div>
        )}

        {/* 选中预设详情 */}
        {activePreset && (
          <div className="flex flex-col gap-3 rounded-lg border p-4">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">{activePreset.name}</span>
              <span className="text-[11px] text-muted-foreground">
                {activePreset.skillCount} {t("skills.presets.skillsUnit")}
              </span>
              <div className="ml-auto flex items-center gap-1">
                <Button
                  size="sm"
                  className="h-7"
                  disabled={applyMutation.isPending}
                  onClick={() => applyMutation.mutate(activePreset.id)}
                  title={t("skills.presets.applyHint")}
                >
                  {applyMutation.isPending ? (
                    <Loader2Icon data-icon="inline-start" className="animate-spin" />
                  ) : (
                    <PlayIcon data-icon="inline-start" />
                  )}
                  {t("skills.presets.apply")}
                </Button>
                {!activePreset.isActive && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7"
                    onClick={() => setActiveMutation.mutate(activePreset.id)}
                  >
                    {t("skills.presets.setActive")}
                  </Button>
                )}
                <button
                  type="button"
                  title={t("common.edit")}
                  className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  onClick={() => {
                    setForm({ name: activePreset.name, description: activePreset.description ?? "", template: "blank" });
                    setEditing(true);
                  }}
                >
                  <PencilIcon className="size-3.5" />
                </button>
                <button
                  type="button"
                  title={t("common.delete")}
                  className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => deleteMutation.mutate(activePreset.id)}
                >
                  <Trash2Icon className="size-3.5" />
                </button>
              </div>
            </div>

            {/* 成员技能：工具开关（活动预设时切换立即落盘） */}
            <div className="flex flex-col gap-1.5">
              {memberSkills.map((s) => (
                <div key={s.id} className="flex items-center gap-2 rounded-md border px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">{s.name}</span>
                  <div className="flex flex-wrap items-center gap-1">
                    {s.targets
                      .filter((x) => (toolsQuery.data?.tools ?? []).some((tt) => tt.key === x.tool))
                      .map((x) => (
                        <ToolBadge
                          key={x.tool}
                          tool={x.tool}
                          status={x.status}
                          onClick={x.status === "central" ? undefined : () => toggleTool.mutate({ skillId: s.id, tool: x.tool, enabled: false })}
                        />
                      ))}
                    <button
                      type="button"
                      onClick={() => setToolPickerFor(s.id)}
                      className="inline-flex h-5 items-center rounded-full border border-dashed px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                    >
                      <PlusIcon className="size-2.5" />
                    </button>
                  </div>
                  <button
                    type="button"
                    title={t("skills.presets.removeMember")}
                    className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => removeMember.mutate(s.id)}
                  >
                    <XIcon className="size-3.5" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setAddSkills(true)}
                className="flex items-center gap-1.5 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground transition-colors hover:border-muted-foreground/40 hover:text-foreground"
              >
                <PlusIcon className="size-3.5" />
                {t("skills.presets.addSkills")}
              </button>
            </div>
          </div>
        )}
      </div>
      </ScrollArea>

      {/* 新建 / 编辑预设 */}
      <Dialog open={creating || editing} onOpenChange={(open) => {
        if (!open) {
          setCreating(false);
          setEditing(false);
        }
      }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{editing ? t("skills.presets.edit") : t("skills.presets.new")}</DialogTitle>
          </DialogHeader>
          {creating && (
            <div className="flex flex-col gap-1.5">
              {PRESET_TEMPLATES.map((tpl) => (
                <button
                  key={tpl.key}
                  type="button"
                  onClick={() =>
                    setForm((f) => ({
                      ...f,
                      template: tpl.key,
                      description: tpl.key === "blank" ? f.description : tpl.descZh,
                    }))
                  }
                  className={cn(
                    "rounded-md border px-3 py-2 text-left text-xs transition-colors",
                    form.template === tpl.key ? "border-primary bg-primary/5" : "hover:border-muted-foreground/40",
                  )}
                >
                  <span className="font-medium">{t(tpl.nameKey)}</span>
                  {tpl.key !== "blank" && (
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{tpl.descZh}</p>
                  )}
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-col gap-2">
            <Input
              className="h-9 text-sm"
              placeholder={t("skills.presets.namePlaceholder")}
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
            <textarea
              className="min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-xs outline-none focus:ring-1 focus:ring-ring"
              placeholder={t("skills.presets.descPlaceholder")}
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => {
              setCreating(false);
              setEditing(false);
            }}>
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              disabled={!form.name.trim() || createMutation.isPending || updatePreset.isPending}
              onClick={() => (creating ? createMutation.mutate() : updatePreset.mutate())}
            >
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 添加成员技能 */}
      <Dialog open={addSkills} onOpenChange={setAddSkills}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("skills.presets.addSkills")}</DialogTitle>
            <DialogDescription>{t("skills.presets.addSkillsHint")}</DialogDescription>
          </DialogHeader>
          <div className="max-h-72 overflow-y-auto">
            {(skillsQuery.data?.skills ?? [])
              .filter((s) => !memberIds.includes(s.id))
              .map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => addMembers.mutate([s.id])}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/50"
                >
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">{s.name}</span>
                  <PlusIcon className="size-3.5 shrink-0 text-muted-foreground" />
                </button>
              ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* 预设内技能 → 添加工具开关 */}
      <ToolPickerDialog
        open={!!toolPickerFor}
        onOpenChange={(open) => !open && setToolPickerFor(null)}
        title={t("skills.my.syncTo")}
        tools={toolsQuery.data?.tools ?? []}
        onSelect={(tool) => {
          if (toolPickerFor) toggleTool.mutate({ skillId: toolPickerFor, tool, enabled: true });
          setToolPickerFor(null);
        }}
      />
    </div>
  );
}
