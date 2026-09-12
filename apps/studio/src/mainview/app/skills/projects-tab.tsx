// 项目级管理 Tab：项目列表 + 项目技能（启停 / 五态 / 与中央库双向同步）。
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownToLineIcon,
  ArrowUpToLineIcon,
  FolderPlusIcon,
  FolderTreeIcon,
  ImportIcon,
  Loader2Icon,
  RadarIcon,
  Trash2Icon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { ScrollArea } from "@ui/scroll-area";
import { Spinner } from "@ui/spinner";
import { useT } from "@stores/ui-lang";
import type { ProjectSyncState } from "@/shared/skills";
import { cn } from "@/mainview/lib/utils";
import { SkillDocDialog, Toolbar } from "./parts";

const SYNC_STATE_META: Record<ProjectSyncState, { key: string; cls: string }> = {
  in_sync: { key: "skills.proj.inSync", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400" },
  project_newer: { key: "skills.proj.projectNewer", cls: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400" },
  center_newer: { key: "skills.proj.centerNewer", cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400" },
  diverged: { key: "skills.proj.diverged", cls: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400" },
  project_only: { key: "skills.proj.projectOnly", cls: "bg-muted text-muted-foreground" },
};

function SyncStateBadge({ state }: { state: ProjectSyncState }) {
  const t = useT();
  const meta = SYNC_STATE_META[state];
  return (
    <span className={cn("inline-flex h-5 shrink-0 items-center rounded-full px-1.5 text-[10px] font-medium", meta.cls)}>
      {t(meta.key)}
    </span>
  );
}

export function ProjectsTab() {
  const t = useT();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [scanRoot, setScanRoot] = useState("");
  const [scanResult, setScanResult] = useState<{ path: string; agentDirs: string[] }[] | null>(null);
  const [docRel, setDocRel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const projectsQuery = useQuery({
    queryKey: ["skills-projects"],
    queryFn: () => rpcClient.skillsListProjects(undefined),
  });
  const projects = projectsQuery.data?.projects ?? [];
  const activeId = selected ?? projects[0]?.id ?? null;
  const activeProject = projects.find((p) => p.id === activeId);

  const skillsQuery = useQuery({
    queryKey: ["skills-project-skills", activeId],
    queryFn: () => rpcClient.skillsGetProjectSkills({ projectId: activeId! }),
    enabled: !!activeId,
  });

  const addProject = useMutation({
    mutationFn: () => rpcClient.skillsAddProject({ path: pathInput }),
    onSuccess: (data) => {
      if (data.ok) {
        setError(null);
        setPathInput("");
        queryClient.invalidateQueries({ queryKey: ["skills-projects"] });
      } else {
        setError(data.error ?? "add failed");
      }
    },
  });
  const scanProjects = useMutation({
    mutationFn: () => rpcClient.skillsScanProjects({ root: scanRoot }),
    onSuccess: (data) => setScanResult(data.projects),
  });
  const removeProject = useMutation({
    mutationFn: (id: string) => rpcClient.skillsRemoveProject({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["skills-projects"] }),
  });
  const importToCenter = useMutation({
    mutationFn: (relDir: string) => rpcClient.skillsProjectImportToCenter({ projectId: activeId!, relDir }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills-project-skills", activeId] });
      queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  });
  const exportFromCenter = useMutation({
    mutationFn: (skillId: string) => rpcClient.skillsProjectExportFromCenter({ projectId: activeId!, skillId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["skills-project-skills", activeId] }),
  });
  const updateToCenter = useMutation({
    mutationFn: (relDir: string) => rpcClient.skillsProjectUpdateToCenter({ projectId: activeId!, relDir }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills-project-skills", activeId] });
      queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  });
  const toggleSkill = useMutation({
    mutationFn: ({ relDir, enabled }: { relDir: string; enabled: boolean }) =>
      rpcClient.skillsProjectToggleSkill({ projectId: activeId!, relDir, enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["skills-project-skills", activeId] }),
  });
  const deleteSkill = useMutation({
    mutationFn: (relDir: string) => rpcClient.skillsProjectDeleteSkill({ projectId: activeId!, relDir }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["skills-project-skills", activeId] }),
  });

  const projectSkills = skillsQuery.data?.skills ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar
        icon={<FolderTreeIcon className="size-4 text-muted-foreground" />}
        title={t("skills.nav.projects")}
        stats={projects.length > 0 ? `${projects.length}` : undefined}
      />

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex w-full flex-col gap-4 p-4">
          {/* 添加项目 + 扫描 */}
          <div className="flex flex-col gap-2">
            <div className="flex gap-2">
              <Input
                placeholder={t("skills.proj.pathPlaceholder")}
                className="h-9 flex-1 font-mono text-xs"
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && pathInput.trim() && addProject.mutate()}
              />
              <Button size="sm" className="h-9" disabled={!pathInput.trim() || addProject.isPending} onClick={() => addProject.mutate()}>
                {addProject.isPending ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <FolderPlusIcon data-icon="inline-start" />}
                {t("skills.proj.add")}
              </Button>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex gap-2">
              <Input
                placeholder={t("skills.proj.scanPlaceholder")}
                className="h-8 flex-1 font-mono text-xs"
                value={scanRoot}
                onChange={(e) => setScanRoot(e.target.value)}
              />
              <Button size="sm" variant="outline" className="h-8" disabled={!scanRoot.trim() || scanProjects.isPending} onClick={() => scanProjects.mutate()}>
                {scanProjects.isPending ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <RadarIcon data-icon="inline-start" />}
                {t("skills.proj.scan")}
              </Button>
            </div>
          {scanResult && (
            <div className="flex flex-col gap-1 rounded-lg border p-2">
              {scanResult.length === 0 && (
                <p className="px-2 py-1 text-xs text-muted-foreground">{t("skills.proj.scanEmpty")}</p>
              )}
              {scanResult.map((p) => (
                <button
                  key={p.path}
                  type="button"
                  onClick={() => {
                    setPathInput(p.path);
                    setScanResult(null);
                  }}
                  className="flex items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-muted/50"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{p.path}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{p.agentDirs.join(" · ")}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 项目列表 */}
        {projectsQuery.isLoading ? (
          <div className="flex justify-center py-10"><Spinner className="size-5" /></div>
        ) : projects.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">{t("skills.proj.empty")}</p>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setSelected(p.id)}
                className={cn(
                  "flex flex-col gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors",
                  activeId === p.id ? "border-primary/60 bg-primary/5" : "hover:border-muted-foreground/40",
                )}
              >
                <span className="flex w-full items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</span>
                  <span
                    role="button"
                    tabIndex={0}
                    title={t("skills.proj.remove")}
                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeProject.mutate(p.id);
                    }}
                  >
                    <Trash2Icon className="size-3" />
                  </span>
                </span>
                <span className="truncate font-mono text-[10px] text-muted-foreground/70">{p.path}</span>
                <span className="text-[10px] text-muted-foreground">
                  {p.skillCount} {t("skills.presets.skillsUnit")}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* 项目技能 */}
        {activeProject && (
          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">
              {activeProject.name}
              {(skillsQuery.data?.agentDirs ?? []).length > 0 && (
                <span className="ml-2 font-mono text-[10px] text-muted-foreground/60">
                  {(skillsQuery.data?.agentDirs ?? []).join(" · ")}
                </span>
              )}
            </h3>
            {skillsQuery.isLoading ? (
              <div className="flex justify-center py-6"><Spinner className="size-5" /></div>
            ) : projectSkills.length === 0 ? (
              <p className="rounded-lg border border-dashed py-6 text-center text-xs text-muted-foreground">
                {t("skills.proj.noSkills")}
              </p>
            ) : (
              projectSkills.map((s) => (
                <div key={s.relDir} className="flex items-center gap-2.5 rounded-lg border px-4 py-2.5">
                  <input
                    type="checkbox"
                    className="size-3.5 shrink-0 accent-primary"
                    checked={s.enabled}
                    disabled={toggleSkill.isPending}
                    onChange={(e) => toggleSkill.mutate({ relDir: s.relDir, enabled: e.target.checked })}
                    title={t("skills.proj.toggleHint")}
                  />
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setDocRel(s.relDir)}>
                    <span className={cn("block truncate text-sm font-medium", !s.enabled && "text-muted-foreground line-through")}>
                      {s.name}
                    </span>
                    <span className="block truncate font-mono text-[10px] text-muted-foreground/60">{s.relDir}</span>
                  </button>
                  <SyncStateBadge state={s.syncState} />
                  <div className="flex shrink-0 items-center gap-0.5">
                    {!s.centralId ? (
                      <button
                        type="button"
                        title={t("skills.proj.import")}
                        disabled={importToCenter.isPending}
                        onClick={() => importToCenter.mutate(s.relDir)}
                        className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <ImportIcon className="size-3.5" />
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          title={t("skills.proj.pullToCenter")}
                          disabled={updateToCenter.isPending}
                          onClick={() => updateToCenter.mutate(s.relDir)}
                          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          <ArrowUpToLineIcon className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          title={t("skills.proj.pushToProject")}
                          disabled={exportFromCenter.isPending}
                          onClick={() => s.centralId && exportFromCenter.mutate(s.centralId)}
                          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          <ArrowDownToLineIcon className="size-3.5" />
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      title={t("common.delete")}
                      disabled={deleteSkill.isPending}
                      onClick={() => deleteSkill.mutate(s.relDir)}
                      className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2Icon className="size-3.5" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
      </ScrollArea>

      {/* 项目技能文档 */}
      <SkillDocDialog
        open={!!docRel}
        onOpenChange={(open) => !open && setDocRel(null)}
        title={docRel?.split("/").pop() ?? ""}
        fetchDoc={() => rpcClient.skillsGetProjectSkillDoc({ projectId: activeId!, relDir: docRel! })}
      />
    </div>
  );
}
