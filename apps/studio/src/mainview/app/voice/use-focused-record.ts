import { useQuery } from "@tanstack/react-query";

import { rpcClient } from "@lib/rpc";
import { useVoiceStore } from "@stores/voice";
import type { VoiceRecordRow } from "../../../bun/voice";

/**
 * 左侧历史里选中的那条记录 —— 右侧三个页面据此把那次任务还原出来。
 *
 * 记录列表本身用的是同一个 query key，所以这里不会多发一次请求；查询结果一旦刷新
 * （新转写落库、删掉一条），右侧显示的也是最新状态。
 * `focusRecordId` 指向一条已经不存在的记录时返回 `undefined`，调用方自然退回"当前这份"。
 */
export function useFocusedVoiceRecord(): {
  record?: VoiceRecordRow;
  focusRecordId: number | null;
  setFocusRecordId: (id: number | null) => void;
} {
  const tab = useVoiceStore((s) => s.tab);
  const focusRecordId = useVoiceStore((s) => s.focusRecordId);
  const setFocusRecordId = useVoiceStore((s) => s.setFocusRecordId);

  const { data } = useQuery({
    queryKey: ["voice-records", tab],
    queryFn: () => rpcClient.listVoiceRecords({ kind: tab }),
  });

  const record =
    focusRecordId == null ? undefined : data?.records.find((r) => r.id === focusRecordId);

  return { record, focusRecordId, setFocusRecordId };
}
