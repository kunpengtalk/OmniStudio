import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LanguagesIcon, Loader2Icon, MicIcon, Trash2Icon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { formatRecordTime } from "@lib/format";
import { translationLangShort } from "@/shared/translate";
import type { TranslationRecordRow } from "@/bun/translate";
import { ToolSwitcher } from "@components/sidebar-parts";
import { Badge } from "@ui/badge";
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
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuItem,
} from "@ui/sidebar";
import { useTranslateStore } from "@stores/translate";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";

export function TranslateRecordList() {
  const t = useT();
  const queryClient = useQueryClient();
  const activeRecord = useTranslateStore((s) => s.activeRecord);
  const selectRecord = useTranslateStore((s) => s.selectRecord);
  const clearActive = useTranslateStore((s) => s.clearActive);
  const tool = useTranslateStore((s) => s.tool);
  const setTool = useTranslateStore((s) => s.setTool);
  const [confirmDelete, setConfirmDelete] = useState<TranslationRecordRow | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["translation-records"],
    queryFn: () => rpcClient.listTranslationRecords(undefined),
  });
  const records = data?.records ?? [];

  const deleteMutation = useMutation({
    mutationFn: (id: number) => rpcClient.deleteTranslationRecord({ id }),
    onSuccess: (_res, id) => {
      setConfirmDelete(null);
      if (activeRecord?.id === id) clearActive();
      queryClient.invalidateQueries({ queryKey: ["translation-records"] });
    },
  });

  return (
    <SidebarGroup className="min-h-0 flex-1">
      {/* 翻译工具菜单：文本翻译 / 同传翻译（与生图页侧栏入口同款） */}
      <ToolSwitcher
        columns={2}
        active={tool}
        onSelect={setTool}
        items={[
          { key: "text", icon: <LanguagesIcon className="size-4" />, labelKey: "translate.tool.text" },
          { key: "live", icon: <MicIcon className="size-4" />, labelKey: "translate.tool.live" },
        ]}
      />
      <SidebarGroupLabel>
        <span className="flex items-center gap-1.5">
          <LanguagesIcon className="size-3.5" />
          {t("translate.history.title")}
        </span>
        <SidebarMenuBadge>
          <Badge variant="secondary" className="h-5 text-[10px]">
            {records.length}
          </Badge>
        </SidebarMenuBadge>
      </SidebarGroupLabel>

      <ScrollArea className="min-h-0 flex-1">
        <SidebarMenu className="gap-1">
          {isLoading ? (
            <div className="flex justify-center py-6">
              <Spinner className="size-3.5" />
            </div>
          ) : records.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              {t("translate.history.empty")}
            </div>
          ) : (
            records.map((r) => (
              <SidebarMenuItem key={r.id} className="group/translate px-1">
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => selectRecord(r)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") selectRecord(r);
                  }}
                  className={cn(
                    "flex w-full cursor-pointer flex-col gap-1 rounded-md border p-1.5 text-left outline-none transition-colors",
                    activeRecord?.id === r.id
                      ? "border-primary/60 bg-primary/5"
                      : "hover:bg-muted/60 focus-visible:bg-muted/60",
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    <span className="shrink-0 text-[10px] font-semibold tracking-wide text-primary/70 tabular-nums">
                      {translationLangShort(r.sourceLang)} → {translationLangShort(r.targetLang)}
                    </span>
                    <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
                      {formatRecordTime(r.createdAt)}
                    </span>
                    <button
                      type="button"
                      disabled={deleteMutation.isPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDelete(r);
                      }}
                      title={t("common.delete")}
                      className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-destructive group-hover/translate:opacity-100"
                    >
                      <Trash2Icon className="size-3.5" />
                    </button>
                  </span>
                  <span
                    className="line-clamp-2 text-[11px] leading-snug text-foreground/80"
                    title={r.text}
                  >
                    {r.text}
                  </span>
                  {r.result && (
                    <span
                      className="line-clamp-1 text-[10px] leading-snug text-muted-foreground"
                      title={r.result}
                    >
                      {r.result}
                    </span>
                  )}
                </div>
              </SidebarMenuItem>
            ))
          )}
        </SidebarMenu>
      </ScrollArea>

      {confirmDelete && (
        <Dialog
          open={!!confirmDelete}
          onOpenChange={(open) => {
            if (!open) setConfirmDelete(null);
          }}
        >
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>{t("translate.history.deleteTitle")}</DialogTitle>
              <DialogDescription>{t("translate.history.deleteDesc")}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => setConfirmDelete(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={deleteMutation.isPending}
                onClick={() => deleteMutation.mutate(confirmDelete.id)}
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
    </SidebarGroup>
  );
}
