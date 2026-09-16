import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { rpcClient } from "@lib/rpc";

/** 在途视频任务的轮询间隔。 */
export const VIDEO_POLL_INTERVAL_MS = 5000;

/**
 * 在途视频任务的轮询。
 *
 * 挂在 `VideoScreen` 这一层，而不是生成页里 —— 生成页在切到「历史」时会被卸载，
 * 之前轮询是它的 `refetchInterval`，一切视图就停摆：在途任务冻结在「生成中」，
 * 连 30 分钟的超时兜底也不会推进（用户切回来才动一下）。历史页与侧栏看的是同一份
 * `["video-records"]`，所以轮询放在两者之外，一处轮询三处刷新。
 *
 * 结果写回 `["video-records"]`（`queryClient.invalidateQueries`），组件各自照常查询。
 */
export function useVideoRecordsPolling(): void {
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ["video-records"],
    queryFn: () => rpcClient.listVideoRecords(undefined),
  });

  const processingIds = (data?.records ?? [])
    .filter((r) => r.status === "processing")
    .map((r) => r.id)
    .join(",");

  const { data: pollData } = useQuery({
    queryKey: ["video-poll", processingIds],
    queryFn: () =>
      rpcClient.pollVideoRecords({
        ids: processingIds.split(",").filter(Boolean).map(Number),
      }),
    enabled: processingIds.length > 0,
    refetchInterval: VIDEO_POLL_INTERVAL_MS,
  });

  useEffect(() => {
    if (!pollData) return;
    queryClient.invalidateQueries({ queryKey: ["video-records"] });
  }, [pollData, queryClient]);
}
