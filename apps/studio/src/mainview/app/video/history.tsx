import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon, TrashIcon, ClapperboardIcon, ChevronLeftIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { ScrollArea } from "@ui/scroll-area";
import { Spinner } from "@ui/spinner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@ui/dialog";
import { Badge } from "@ui/badge";
import { useT } from "@stores/ui-lang";
import { MediaSourceFilter } from "@components/media-source-badge";
import { useVideoStore } from "@stores/video";
import type { VideoRecordRow } from "../../../bun/video-gen";
import type { MediaSource } from "../../../bun/db/schema";
import { HistoryCard } from "./parts";

export function HistoryScreen() {
  const t = useT();
  const { setView, setFocusRecordId } = useVideoStore();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["video-records"],
    queryFn: () => rpcClient.listVideoRecords(undefined),
  });
  const [toDelete, setToDelete] = useState<VideoRecordRow | null>(null);
  const [source, setSource] = useState<MediaSource | "all">("all");
  const [error, setError] = useState<string>();
  const del = useMutation({
    mutationFn: (id: number) => rpcClient.deleteVideoRecord({ id }),
    onSuccess: (r) => {
      // 记录不存在 / 删除失败此前是"点了没反应"（弹窗关闭、列表照旧）。
      if (r.ok === false) {
        setError(r.error ?? t("video.deleteFailed"));
        setToDelete(null);
        return;
      }
      setError(undefined);
      setToDelete(null);
      queryClient.invalidateQueries({ queryKey: ["video-records"] });
    },
    onError: (e) => {
      setError(String(e));
      setToDelete(null);
    },
  });
  const records = (data?.records ?? [])
    .filter((r) => r.status === "done" && r.videoUrl)
    .filter((r) => source === "all" || r.source === source);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2.5 border-b px-5 py-3">
        <Button
          variant="ghost"
          size="icon-sm"
          tooltip={t("common.back")}
          onClick={() => setView("generate")}
        >
          <ChevronLeftIcon className="size-4" />
        </Button>
        <h1 className="text-sm font-semibold">{t("video.history.title")}</h1>
        <Badge variant="secondary" className="h-5 text-[10px]">
          {records.length}
        </Badge>
        <MediaSourceFilter value={source} onChange={setSource} className="ml-auto" />
      </div>

      {(error ?? data?.error) && (
        <div className="shrink-0 border-b px-5 py-2">
          <p className="text-xs text-destructive">{error ?? data?.error}</p>
        </div>
      )}

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="size-4" />
        </div>
      ) : records.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <div className="flex size-20 items-center justify-center rounded-2xl bg-primary/15">
            <ClapperboardIcon className="size-9 text-primary" />
          </div>
          <p className="text-lg font-medium">{t("video.history.empty")}</p>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="grid grid-cols-2 gap-x-5 gap-y-6 p-5 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {records.map((r) => (
              <HistoryCard
                key={r.id}
                record={r}
                onOpen={() => {
                  setView("generate");
                  setFocusRecordId(r.id);
                }}
                onDelete={() => setToDelete(r)}
              />
            ))}
          </div>
        </ScrollArea>
      )}

      <Dialog open={!!toDelete} onOpenChange={(open) => !open && setToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("video.history.deleteTitle")}</DialogTitle>
            <DialogDescription>{t("video.history.deleteDesc")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setToDelete(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={del.isPending}
              onClick={() => toDelete && del.mutate(toDelete.id)}
            >
              {del.isPending ? (
                <Loader2Icon data-icon="inline-start" className="animate-spin" />
              ) : (
                <TrashIcon data-icon="inline-start" />
              )}
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 视频 Tab：左 340px 配置栏 + 右结果区
// ---------------------------------------------------------------------------

