import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LibraryIcon, Loader2Icon, PlusIcon, Settings2Icon, Trash2Icon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ui/dialog";
import { ScrollArea } from "@ui/scroll-area";
import { Spinner } from "@ui/spinner";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuBadge,
  SidebarMenuButton,
} from "@ui/sidebar";
import { useKbStore } from "@stores/kb";
import { useT } from "@stores/ui-lang";
import { KbCreateDialog, useKbListQuery } from "./index";

/** 知识库应用侧栏：彩色头像式库列表 + 新建（弹窗与主页面共用）。 */
export function KbSidebar() {
  const t = useT();
  const queryClient = useQueryClient();
  const selectedKbId = useKbStore((s) => s.selectedKbId);
  const setSelectedKbId = useKbStore((s) => s.setSelectedKbId);
  const setTab = useKbStore((s) => s.setTab);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  const listQuery = useKbListQuery();
  const kbs = listQuery.data?.kbs ?? [];

  const deleteMutation = useMutation({
    mutationFn: (id: number) => rpcClient.kbDelete({ id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["kb-list"] });
      setConfirmDeleteId(null);
    },
  });

  const confirmDelete = confirmDeleteId != null ? kbs.find((k) => k.id === confirmDeleteId) : undefined;

  return (
    <SidebarGroup className="min-h-0 flex-1">
      <SidebarGroupLabel>
        <span className="flex items-center gap-1.5">
          {t("apps.kb")}
          <SidebarMenuBadge>
            <span className="text-[10px] tabular-nums">{kbs.length}</span>
          </SidebarMenuBadge>
        </span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto h-6 shrink-0 gap-1 px-2 text-[11px]"
          onClick={() => useKbStore.getState().setCreateOpen(true)}
        >
          <PlusIcon className="size-3.5" />
          {t("kb.new")}
        </Button>
      </SidebarGroupLabel>

      <ScrollArea className="min-h-0 flex-1">
        <SidebarMenu className="gap-1">
          {listQuery.isLoading ? (
            <div className="flex justify-center py-6">
              <Spinner className="size-3.5" />
            </div>
          ) : kbs.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">{t("kb.empty.short")}</div>
          ) : (
            kbs.map((kb) => {
              const isActive = kb.id === selectedKbId;
              return (
                <SidebarMenuItem key={kb.id} className="group/kb">
                  <SidebarMenuButton
                    isActive={isActive}
                    onClick={() => setSelectedKbId(kb.id)}
                    tooltip={`${kb.name} · ${t("kb.sidebar.docCount", { count: String(kb.docCount) })}`}
                    className="gap-2"
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      <LibraryIcon className="size-3.5" />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">{kb.name}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground/70 tabular-nums">
                      {kb.docCount}
                    </span>
                    <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/kb:opacity-100">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedKbId(kb.id);
                          setTab("settings");
                        }}
                        title={t("kb.tab.settings")}
                        className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-primary"
                      >
                        <Settings2Icon className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={deleteMutation.isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDeleteId(kb.id);
                        }}
                        title={t("common.delete")}
                        className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive"
                      >
                        <Trash2Icon className="size-3.5" />
                      </button>
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })
          )}
        </SidebarMenu>
      </ScrollArea>

      {confirmDelete && (
        <Dialog open={confirmDeleteId != null} onOpenChange={(open) => !open && setConfirmDeleteId(null)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>{t("kb.settings.deleteTitle")}</DialogTitle>
              <DialogDescription>
                {t("kb.settings.deleteBody")}{" "}
                <span className="font-medium text-foreground">「{confirmDelete.name}」</span>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => setConfirmDeleteId(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={deleteMutation.isPending}
                onClick={() => confirmDeleteId != null && deleteMutation.mutate(confirmDeleteId)}
              >
                {deleteMutation.isPending ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <Trash2Icon className="size-3.5" />
                )}
                {t("common.delete")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      <KbCreateDialog />
    </SidebarGroup>
  );
}
