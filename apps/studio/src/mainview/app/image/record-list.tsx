import { useQuery } from "@tanstack/react-query";
import { ImageIcon, LayersIcon, SparklesIcon, Wand2Icon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { MediaSourceBadge } from "@components/media-source-badge";
import { ToolSwitcher } from "@components/sidebar-parts";
import { Badge } from "@ui/badge";
import { ScrollArea } from "@ui/scroll-area";
import { Spinner } from "@ui/spinner";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuItem,
} from "@ui/sidebar";
import { useImageStore } from "@stores/image";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";

export function ImageRecordList() {
  const t = useT();
  const { tool, setTool, focusRecordId, setFocusRecordId } = useImageStore();

  const { data, isLoading } = useQuery({
    queryKey: ["image-records"],
    queryFn: () => rpcClient.listImageRecords(undefined),
  });
  const records = data?.records ?? [];

  const pick = (id: number) => {
    setFocusRecordId(id);
  };

  return (
    <SidebarGroup className="min-h-0 flex-1">
      {/* 生图工具菜单：可切换（放大/批量暂未开放） */}
      <ToolSwitcher
        columns={3}
        active={tool}
        onSelect={(key) => {
          setTool(key);
          setFocusRecordId(null);
        }}
        items={[
          {
            key: "generate",
            icon: <SparklesIcon className="size-4" />,
            labelKey: "image.tab.generate",
          },
          { key: "edit", icon: <Wand2Icon className="size-4" />, labelKey: "image.tab.edit" },
          {
            key: "batch",
            icon: <LayersIcon className="size-4" />,
            labelKey: "image.tab.batch",
            soon: true,
            soonTitle: t("image.comingSoon"),
          },
        ]}
      />
      <SidebarGroupLabel>
        <ImageIcon className="size-3.5" />
        {t("image.history.title")}
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
            <div className="py-6 text-center text-xs text-muted-foreground">
              {t("image.history.empty")}
            </div>
          ) : (
            records.map((r) => (
              <SidebarMenuItem key={r.id} className="px-1">
                <button
                  type="button"
                  onClick={() => pick(r.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md border p-1.5 text-left transition-colors",
                    focusRecordId === r.id
                      ? "border-primary/60 bg-primary/5"
                      : "hover:bg-muted/60",
                  )}
                >
                  {r.imageUrl ? (
                    <img
                      src={r.imageUrl}
                      alt=""
                      loading="lazy"
                      className="size-9 shrink-0 rounded object-cover"
                    />
                  ) : (
                    <span className="flex size-9 shrink-0 items-center justify-center rounded bg-muted">
                      <ImageIcon className="size-3.5 text-muted-foreground" />
                    </span>
                  )}
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="line-clamp-2 text-[11px] leading-snug text-foreground/80">
                      {r.prompt || t("image.error")}
                    </span>
                    <span className="flex items-center gap-1 text-[10px] text-muted-foreground/70 tabular-nums">
                      <span>
                        {new Date(r.createdAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      <MediaSourceBadge source={r.source} />
                    </span>
                  </span>
                </button>
              </SidebarMenuItem>
            ))
          )}
        </SidebarMenu>
      </ScrollArea>
    </SidebarGroup>
  );
}
