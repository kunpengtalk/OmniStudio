// 工具管理 Tab：53 内置 + 自定义工具的启停 / 安装检测 / 路径覆盖 / 添加自定义工具。
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, Loader2Icon, PlusIcon, Settings2Icon, WrenchIcon, XIcon } from "lucide-react";

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
import type { ToolCategory } from "@/shared/skills";
import { cn } from "@/mainview/lib/utils";
import { Toolbar } from "./parts";

export function ToolsTab() {
  const t = useT();
  const queryClient = useQueryClient();
  const [overrideTool, setOverrideTool] = useState<{ key: string; name: string } | null>(null);
  const [overridePath, setOverridePath] = useState("");
  const [adding, setAdding] = useState(false);
  const [customForm, setCustomForm] = useState({ key: "", name: "", skillsDir: "" });

  const toolsQuery = useQuery({
    queryKey: ["skills-tools"],
    queryFn: () => rpcClient.skillsGetTools(undefined),
  });
  const tools = toolsQuery.data?.tools ?? [];

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["skills-tools"] });
  const setEnabled = useMutation({
    mutationFn: ({ tool, enabled }: { tool: string; enabled: boolean }) =>
      rpcClient.skillsSetToolEnabled({ tool, enabled }),
    onSuccess: invalidate,
  });
  const setAll = useMutation({
    mutationFn: (enabled: boolean) => rpcClient.skillsSetAllToolsEnabled({ enabled }),
    onSuccess: invalidate,
  });
  const setPath = useMutation({
    mutationFn: () => rpcClient.skillsSetCustomToolPath({ tool: overrideTool!.key, path: overridePath.trim() || null }),
    onSuccess: () => {
      setOverrideTool(null);
      invalidate();
    },
  });
  const addCustom = useMutation({
    mutationFn: () =>
      rpcClient.skillsAddCustomTool({
        key: customForm.key,
        name: customForm.name || customForm.key,
        skillsDir: customForm.skillsDir,
        category: "coding",
      }),
    onSuccess: (data) => {
      if (data.ok) {
        setAdding(false);
        setCustomForm({ key: "", name: "", skillsDir: "" });
        invalidate();
      }
    },
  });
  const removeCustom = useMutation({
    mutationFn: (key: string) => rpcClient.skillsRemoveCustomTool({ key }),
    onSuccess: invalidate,
  });

  const group = (category: ToolCategory) => tools.filter((x) => x.category === category);
  const renderGroup = (category: ToolCategory, labelKey: string) => {
    const items = group(category);
    if (items.length === 0) return null;
    return (
      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">{t(labelKey)}</h3>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {items.map((tool) => (
            <div
              key={tool.key}
              className={cn(
                "flex items-center gap-2.5 rounded-lg border px-3 py-2",
                !tool.enabled && "opacity-50",
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium">{tool.name}</span>
                  {tool.isCentral && (
                    <span className="inline-flex h-4 items-center rounded-full bg-purple-100 px-1 text-[9px] font-medium text-purple-700 dark:bg-purple-900/40 dark:text-purple-400">
                      {t("skills.tools.central")}
                    </span>
                  )}
                  {tool.isCustom && (
                    <span className="inline-flex h-4 items-center rounded-full bg-muted px-1 text-[9px] text-muted-foreground">
                      {t("skills.tools.custom")}
                    </span>
                  )}
                </div>
                <p className="truncate font-mono text-[10px] text-muted-foreground/70" title={tool.skillsDir}>
                  ~/{tool.skillsDir.replace(/^\/Users\/[^/]+\//, "")}
                </p>
              </div>
              {tool.installed ? (
                <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
              ) : (
                <XIcon className="size-3.5 shrink-0 text-muted-foreground/40" />
              )}
              <button
                type="button"
                title={t("skills.tools.override")}
                className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => {
                  setOverrideTool({ key: tool.key, name: tool.name });
                  setOverridePath("");
                }}
              >
                <Settings2Icon className="size-3.5" />
              </button>
              {tool.isCustom && (
                <button
                  type="button"
                  title={t("common.delete")}
                  className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => removeCustom.mutate(tool.key)}
                >
                  <XIcon className="size-3.5" />
                </button>
              )}
              <input
                type="checkbox"
                className="size-3.5 shrink-0 accent-primary"
                checked={tool.enabled}
                disabled={setEnabled.isPending}
                onChange={(e) => setEnabled.mutate({ tool: tool.key, enabled: e.target.checked })}
              />
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar
        icon={<WrenchIcon className="size-4 text-muted-foreground" />}
        title={t("skills.nav.tools")}
        stats={`${(toolsQuery.data?.tools ?? []).filter((x) => x.enabled && x.installed).length} / ${tools.length}`}
      >
        <Button size="sm" variant="outline" className="h-8" onClick={() => setAll.mutate(true)}>
          {t("skills.tools.enableAll")}
        </Button>
        <Button size="sm" variant="outline" className="h-8" onClick={() => setAll.mutate(false)}>
          {t("skills.tools.disableAll")}
        </Button>
        <Button size="sm" className="h-8" onClick={() => setAdding(true)}>
          <PlusIcon data-icon="inline-start" />
          {t("skills.tools.addCustom")}
        </Button>
      </Toolbar>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex w-full flex-col gap-4 p-4">
          {toolsQuery.isLoading ? (
            <div className="flex justify-center py-16"><Spinner className="size-5" /></div>
          ) : (
            <>
              {renderGroup("coding", "skills.tools.coding")}
              {renderGroup("lobster", "skills.tools.lobster")}
            </>
          )}
        </div>
      </ScrollArea>

      {/* 路径覆盖 */}
      <Dialog open={!!overrideTool} onOpenChange={(open) => !open && setOverrideTool(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{overrideTool?.name}</DialogTitle>
            <DialogDescription>{t("skills.tools.overrideHint")}</DialogDescription>
          </DialogHeader>
          <Input
            className="h-9 font-mono text-xs"
            placeholder="~/.my-tool/skills"
            value={overridePath}
            onChange={(e) => setOverridePath(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setOverrideTool(null)}>
              {t("common.cancel")}
            </Button>
            <Button size="sm" disabled={setPath.isPending} onClick={() => setPath.mutate()}>
              {setPath.isPending ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 添加自定义工具 */}
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("skills.tools.addCustom")}</DialogTitle>
            <DialogDescription>{t("skills.tools.addCustomHint")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Input
              className="h-9 text-sm"
              placeholder="my-agent"
              value={customForm.key}
              onChange={(e) => setCustomForm((f) => ({ ...f, key: e.target.value }))}
            />
            <Input
              className="h-9 text-sm"
              placeholder={t("skills.tools.namePlaceholder")}
              value={customForm.name}
              onChange={(e) => setCustomForm((f) => ({ ...f, name: e.target.value }))}
            />
            <Input
              className="h-9 font-mono text-xs"
              placeholder="~/.my-agent/skills"
              value={customForm.skillsDir}
              onChange={(e) => setCustomForm((f) => ({ ...f, skillsDir: e.target.value }))}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setAdding(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              disabled={!customForm.key.trim() || !customForm.skillsDir.trim() || addCustom.isPending}
              onClick={() => addCustom.mutate()}
            >
              {addCustom.isPending ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
