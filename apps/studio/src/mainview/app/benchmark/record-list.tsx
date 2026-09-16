import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GaugeIcon, Trash2Icon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { modelNameFromRef } from "@/shared/modelscope";
import { Badge } from "@ui/badge";
import { Button } from "@ui/button";
import { ScrollArea } from "@ui/scroll-area";
import { Spinner } from "@ui/spinner";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@ui/sidebar";
import { useRouter } from "@stores/router";
import { useAppStore } from "@stores/app";
import { useBenchmarkStore } from "@stores/benchmark";
import { useT } from "@stores/ui-lang";
import { SingleToolEntry } from "@components/sidebar-parts";

/** 基准测试页左侧历史记录：每条 = 模型 + 平均 TPS + 时间，点击在结果区回放。 */
export function BenchmarkRecordList() {
  const t = useT();
  const queryClient = useQueryClient();
  const { setRoute } = useRouter();
  const { setActiveApp } = useAppStore();
  const selectedRecordId = useBenchmarkStore((s) => s.selectedRecordId);
  const setSelectedRecordId = useBenchmarkStore((s) => s.setSelectedRecordId);
  const [confirmClear, setConfirmClear] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["benchmark-records"],
    queryFn: () => rpcClient.listBenchmarkRecords(undefined),
  });
  const records = data?.records ?? [];

  const deleteMutation = useMutation({
    mutationFn: (id: number) => rpcClient.deleteBenchmarkRecord({ id }),
    onSuccess: (_, id) => {
      if (selectedRecordId === id) setSelectedRecordId(null);
      queryClient.invalidateQueries({ queryKey: ["benchmark-records"] });
    },
  });
  const clearMutation = useMutation({
    mutationFn: () => rpcClient.clearBenchmarkRecords(undefined),
    onSuccess: () => {
      setSelectedRecordId(null);
      setConfirmClear(false);
      queryClient.invalidateQueries({ queryKey: ["benchmark-records"] });
    },
  });

  // 清空是破坏性操作：按钮两段式确认，3 秒未确认自动复原。
  useEffect(() => {
    if (!confirmClear) return;
    const timer = setTimeout(() => setConfirmClear(false), 3000);
    return () => clearTimeout(timer);
  }, [confirmClear]);

  const fmtRecordTime = (ms: number) => {
    const d = new Date(ms);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    const md = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return sameYear ? `${md} ${hm}` : `${d.getFullYear()}-${md} ${hm}`;
  };

  return (
    <SidebarGroup className="min-h-0 flex-1 gap-1">
      <div className="px-1 pb-1">
        <SingleToolEntry icon={<GaugeIcon className="size-4" />} label={t("apps.benchmark")} />
      </div>
      <SidebarGroupLabel>
        <span className="flex items-center gap-1.5">
          {t("benchmark.history")}
          <Badge variant="secondary" className="h-5 px-1.5 text-[10px] tabular-nums">
            {records.length}
          </Badge>
        </span>
        {records.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6 shrink-0 px-2 text-[11px] hover:text-destructive"
            disabled={clearMutation.isPending}
            onClick={() => (confirmClear ? clearMutation.mutate() : setConfirmClear(true))}
          >
            {confirmClear ? t("benchmark.clearConfirm") : t("benchmark.clear")}
          </Button>
        )}
      </SidebarGroupLabel>

      <ScrollArea className="min-h-0 flex-1">
        <SidebarMenu className="gap-0.5">
          {isLoading ? (
            <div className="flex justify-center py-6">
              <Spinner className="size-3.5" />
            </div>
          ) : records.length === 0 ? (
            <div className="py-8 text-center text-xs text-muted-foreground">{t("benchmark.noRecords")}</div>
          ) : (
            records.map((r) => (
              <SidebarMenuItem key={r.id} className="group/bench-record">
                <SidebarMenuButton
                  isActive={selectedRecordId === r.id}
                  onClick={() => {
                    setSelectedRecordId(r.id);
                    setActiveApp("benchmark");
                    setRoute({ path: "index" });
                  }}
                  tooltip={modelNameFromRef(r.model)}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex min-w-0 items-center gap-1">
                      {r.kind === "eval" && <GaugeIcon className="size-3 shrink-0 text-muted-foreground" />}
                      {/* 老记录里可能存着 MLX 的路径型请求 id：展示前收敛成模型名 */}
                      <span className="min-w-0 truncate text-xs font-medium leading-none">
                        {modelNameFromRef(r.model)}
                      </span>
                    </span>
                    <span className="flex items-center gap-1 text-[10px] leading-none text-muted-foreground">
                      {r.kind === "eval" ? (
                        <>
                          <span className="max-w-24 truncate">{t(`benchmark.suite.${r.summary?.eval?.suite ?? "mmlu"}`)}</span>
                          {r.summary?.eval ? (
                            <span className="font-medium tabular-nums text-primary">{r.summary.eval.accuracy}%</span>
                          ) : (
                            <span>{t(`benchmark.status.${r.status}`)}</span>
                          )}
                        </>
                      ) : r.summary ? (
                        <span className="font-medium tabular-nums text-primary">{r.summary.avgTps} tok/s</span>
                      ) : (
                        <span>{t(`benchmark.status.${r.status}`)}</span>
                      )}
                      <span className="tabular-nums">{fmtRecordTime(r.createdAt)}</span>
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    tooltip={t("benchmark.deleteRecord")}
                    className="size-6 shrink-0 opacity-0 transition-opacity group-hover/bench-record:opacity-100"
                    disabled={deleteMutation.isPending}
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteMutation.mutate(r.id);
                    }}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))
          )}
        </SidebarMenu>
      </ScrollArea>
    </SidebarGroup>
  );
}
