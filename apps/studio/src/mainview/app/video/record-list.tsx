import { useQuery } from "@tanstack/react-query";
import { FilmIcon, Loader2Icon } from "lucide-react";

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
import { useVideoStore } from "@stores/video";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";

export function VideoRecordList() {
  const t = useT();
  const { focusRecordId, setFocusRecordId, setView } = useVideoStore();

  const { data, isLoading } = useQuery({
    queryKey: ["video-records"],
    queryFn: () => rpcClient.listVideoRecords(undefined),
  });
  const records = data?.records ?? [];

  return (
    <SidebarGroup className="min-h-0 flex-1">
      <SidebarGroupLabel>
        <FilmIcon className="size-3.5" />
        {t("video.history.title")}
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
              {t("video.history.empty")}
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
                    focusRecordId === r.id
                      ? "border-primary/60 bg-primary/5"
                      : "hover:bg-muted/60",
                  )}
                >
                  {r.videoUrl ? (
                    <video
                      src={`${r.videoUrl}#t=0.1`}
                      muted
                      preload="metadata"
                      className="size-9 shrink-0 rounded bg-muted object-cover"
                    />
                  ) : (
                    <span
                      className={cn(
                        "flex size-9 shrink-0 items-center justify-center rounded bg-muted",
                        r.status === "failed" && "text-destructive/70",
                      )}
                    >
                      {r.status === "processing" ? (
                        <Loader2Icon className="size-3.5 animate-spin text-primary" />
                      ) : (
                        <FilmIcon className="size-3.5 text-muted-foreground" />
                      )}
                    </span>
                  )}
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="line-clamp-2 text-[11px] leading-snug text-foreground/80">
                      {r.prompt || t("video.error")}
                    </span>
                    <span className="flex items-center gap-1 text-[10px] text-muted-foreground/70 tabular-nums">
                      {r.status === "processing" && (
                        <span className="text-primary">{t("video.status.processing")}</span>
                      )}
                      {r.status === "failed" && (
                        <span className="text-destructive/80">{t("video.status.failed")}</span>
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
