import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderPlusIcon, PlusIcon, ShieldCheckIcon, Trash2Icon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui/select";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import type { PermissionRule } from "../../../bun/permissions";

type Action = "allow" | "ask" | "deny";

const PERMISSION_NAMES = ["bash", "edit", "read", "external_directory", "webfetch", "mcp", "media", "task"];

const ACTION_STYLE: Record<Action, string> = {
  allow: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  ask: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  deny: "bg-destructive/10 text-destructive",
};

/**
 * 工具授权设置（对齐 OpenWork 的权限页）：
 * 审批模式 + 自定义规则 + 当前生效的权限（含来源归属）+ 记住的授权 + 已授权目录。
 */
export function PermissionsTab() {
  const t = useT();
  const queryClient = useQueryClient();
  const [newRule, setNewRule] = useState<PermissionRule>({ permission: "bash", pattern: "", action: "ask" });
  const [newFolder, setNewFolder] = useState("");

  const permissionsQuery = useQuery({
    queryKey: ["agent-permissions"],
    queryFn: () => rpcClient.getAgentPermissions(undefined),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["agent-permissions"] });

  const setMode = useMutation({
    mutationFn: (mode: "smart" | "manual" | "auto" | "strict") => rpcClient.setAgentApprovalMode({ mode }),
    onSuccess: invalidate,
  });
  const setRules = useMutation({
    mutationFn: (rules: PermissionRule[]) => rpcClient.setAgentPermissionRules({ rules }),
    onSuccess: invalidate,
  });
  const deleteRule = useMutation({
    mutationFn: (id: number) => rpcClient.deleteAgentPermissionRule({ id }),
    onSuccess: invalidate,
  });
  const clearGrants = useMutation({
    mutationFn: (scope: "session" | "workspace") =>
      rpcClient.clearAgentPermissionGrants({ scope }),
    onSuccess: invalidate,
  });
  const setFolders = useMutation({
    mutationFn: (folders: string[]) => rpcClient.setAgentAuthorizedFolders({ folders }),
    onSuccess: invalidate,
  });

  const data = permissionsQuery.data;
  const mode = data?.mode ?? "smart";
  const rules = data?.rules ?? [];
  const effective = data?.effective ?? [];
  const grants = data?.sessionGrants ?? [];
  const folders = data?.authorizedFolders ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <ShieldCheckIcon className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">{t("agent.approval.title")}</h3>
        </div>
        <p className="text-xs text-muted-foreground">{t("agent.approval.desc")}</p>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t("agent.approval.mode")}</span>
          <Select value={mode} onValueChange={(value) => setMode.mutate(value as typeof mode)}>
            <SelectTrigger className="h-8 w-52 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="smart">{t("agent.approval.mode.smart")}</SelectItem>
              <SelectItem value="manual">{t("agent.approval.mode.manual")}</SelectItem>
              <SelectItem value="auto">{t("agent.approval.mode.auto")}</SelectItem>
              <SelectItem value="strict">{t("agent.approval.mode.strict")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* 当前生效的权限：探针 + 命中规则来源（对齐 OpenWork 的 effective permissions） */}
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">{t("agent.approval.effective")}</h3>
        <div className="overflow-hidden rounded-xl border">
          <div className="grid grid-cols-[1fr_auto_auto] gap-2 border-b bg-muted/30 px-3 py-1.5 text-[10px] text-muted-foreground">
            <span>{t("agent.approval.rule.permission")}</span>
            <span>{t("agent.approval.rule.action")}</span>
            <span>{t("agent.approval.rule.pattern")}</span>
          </div>
          {effective.map((row) => (
            <div
              key={row.permission}
              className="grid grid-cols-[1fr_auto_auto] items-center gap-2 border-b px-3 py-1.5 text-xs last:border-b-0"
            >
              <span className="flex items-center gap-2">
                <span className="font-mono text-[11px]">{row.permission}</span>
                <span className="text-[10px] text-muted-foreground">{row.label}</span>
                {row.exceptions > 0 && (
                  <span className="rounded bg-muted px-1 text-[9px] text-muted-foreground">
                    {t("agent.approval.exceptions", { count: String(row.exceptions) })}
                  </span>
                )}
              </span>
              <span className={cn("rounded px-1.5 py-0.5 text-[10px]", ACTION_STYLE[row.action])}>
                {t(`agent.approval.action.${row.action}`)}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {row.pattern ?? "—"}
                <span className="ml-1.5 text-muted-foreground/60">
                  {t(`agent.approval.source.${row.source}`)}
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* 自定义规则 */}
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">{t("agent.approval.addRule")}</h3>
        {rules.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("agent.approval.noRules")}</p>
        ) : (
          <div className="flex flex-col gap-1">
            {rules.map((rule, index) => (
              <div
                key={`${rule.permission}-${rule.pattern}-${index}`}
                className="flex items-center gap-2 rounded-lg border px-2 py-1.5 text-xs"
              >
                <span className="font-mono text-[11px]">{rule.permission}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{rule.pattern}</span>
                <span className={cn("ml-auto rounded px-1.5 py-0.5 text-[10px]", ACTION_STYLE[rule.action])}>
                  {t(`agent.approval.action.${rule.action}`)}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-destructive"
                  onClick={() => setRules.mutate(rules.filter((_, i) => i !== index))}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={newRule.permission}
            onValueChange={(value) => setNewRule((prev) => ({ ...prev, permission: value }))}
          >
            <SelectTrigger className="h-8 w-40 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERMISSION_NAMES.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={newRule.pattern}
            onChange={(e) => setNewRule((prev) => ({ ...prev, pattern: e.target.value }))}
            placeholder="npm test*"
            className="h-8 w-48 font-mono text-xs"
          />
          <Select
            value={newRule.action}
            onValueChange={(value) => setNewRule((prev) => ({ ...prev, action: value as Action }))}
          >
            <SelectTrigger className="h-8 w-28 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="allow">{t("agent.approval.action.allow")}</SelectItem>
              <SelectItem value="ask">{t("agent.approval.action.ask")}</SelectItem>
              <SelectItem value="deny">{t("agent.approval.action.deny")}</SelectItem>
            </SelectContent>
          </Select>
          <Button
            size="sm"
            className="gap-1 text-xs"
            disabled={!newRule.pattern.trim() || setRules.isPending}
            onClick={() => {
              setRules.mutate([...rules, newRule]);
              setNewRule((prev) => ({ ...prev, pattern: "" }));
            }}
          >
            <PlusIcon className="size-3.5" />
            {t("common.add")}
          </Button>
        </div>
      </div>

      {/* 记住的授权（弹窗里选「本会话总是 / 始终允许」产生的） */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">{t("agent.approval.grants")}</h3>
          {grants.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-6 text-[11px]"
              onClick={() => clearGrants.mutate("session")}
            >
              {t("agent.approval.clearGrants")}
            </Button>
          )}
        </div>
        {grants.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("agent.approval.noGrants")}</p>
        ) : (
          <div className="flex flex-col gap-1">
            {grants.map((grant) => (
              <div
                key={grant.id}
                className="flex items-center gap-2 rounded-lg border px-2 py-1.5 text-xs"
              >
                <span className="font-mono text-[11px]">{grant.permission}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                  {grant.pattern}
                </span>
                <span className="text-[10px] text-muted-foreground/70">会话 {grant.scopeRef}</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-destructive"
                  onClick={() => deleteRule.mutate(grant.id)}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 已授权目录（工作区之外） */}
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">{t("agent.approval.folders")}</h3>
        <p className="text-xs text-muted-foreground">{t("agent.approval.foldersHint")}</p>
        {folders.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("agent.approval.noFolders")}</p>
        ) : (
          <div className="flex flex-col gap-1">
            {folders.map((folder) => (
              <div key={folder} className="flex items-center gap-2 rounded-lg border px-2 py-1.5 text-xs">
                <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{folder}</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-destructive"
                  onClick={() => setFolders.mutate(folders.filter((item) => item !== folder))}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <Input
            value={newFolder}
            onChange={(e) => setNewFolder(e.target.value)}
            placeholder="/Users/me/notes"
            className="h-8 flex-1 font-mono text-xs"
          />
          <Button
            variant="outline"
            size="sm"
            className="gap-1 text-xs"
            onClick={async () => {
              const { path } = await rpcClient.openDirectoryDialog(undefined);
              if (path) setFolders.mutate([...folders, path]);
            }}
          >
            <FolderPlusIcon className="size-3.5" />
            {t("agent.approval.addFolder")}
          </Button>
          <Button
            size="sm"
            className="text-xs"
            disabled={!newFolder.trim()}
            onClick={() => {
              setFolders.mutate([...folders, newFolder.trim()]);
              setNewFolder("");
            }}
          >
            {t("common.add")}
          </Button>
        </div>
      </div>
    </div>
  );
}
