// 音乐工作台：生成 / 历史两个视图。在途任务轮询挂在入口这一层，
// 两个视图都受它覆盖，切视图不中断。
import { useMusicStore } from "@stores/music";
import { useMusicRecordsPolling } from "@hooks/use-music-polling";
import { HistoryScreen } from "./history";
import { GenerateTab } from "./generate-tab";

export function MusicScreen() {
  useMusicRecordsPolling();
  const view = useMusicStore((s) => s.view);
  if (view === "history") return <HistoryScreen />;
  return <GenerateTab />;
}
