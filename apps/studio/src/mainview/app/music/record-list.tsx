import { useQuery } from "@tanstack/react-query";
import { MusicIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { MediaSourceBadge } from "@components/media-source-badge";
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
import { useMusicStore } from "@stores/music";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import { displayName, MusicThumb } from "./parts";

export function MusicRecordList() {
  const t = useT();
  const { focusRecordId, setFocusRecordId, setView } = useMusicStore();

  const { data, isLoading } = useQuery({
    queryKey: ["music-records"],
    queryFn: () => rpcClient.listMusicRecords(undefined),
  });
  const records = data?.records ?? [];

  return (
    <SidebarGroup className="min-h-0 flex-1">
      <SidebarGroupLabel>
        <MusicIcon className="size-3.5" />
        {t("music.history.title")}
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
              {t("music.history.empty")}
            </div>
          ) : (
            records.map((r) => (
              <SidebarMenuItem key={r.id} className="px-1">
                <button
                  type="button"
                  onClick={() => {
                    setView("generate");
                    setFocusRecordId(r.id);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md border p-1.5 text-left transition-colors",
                    focusRecordId === r.id ? "border-primary/60 bg-primary/5" : "hover:bg-muted/60",
                  )}
                >
                  <MusicThumb record={r} className="size-9 shrink-0" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="line-clamp-2 text-[11px] leading-snug text-foreground/80">
                      {displayName(r) || t("music.untitled")}
                    </span>
                    <span className="flex items-center gap-1 text-[10px] text-muted-foreground/70 tabular-nums">
                      {r.status === "processing" && (
                        <span className="text-primary">{t("music.status.processing")}</span>
                      )}
                      {r.status === "failed" && (
                        <span className="text-destructive/80">{t("music.status.failed")}</span>
                      )}
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
