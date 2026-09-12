import { TerminalSquareIcon } from "lucide-react";

import { ServedModelsPanel, ServedModelLogs, StopAllServedButton } from "@components/served-models-panel";
import { useServedStore } from "@stores/served";
import { useT } from "@stores/ui-lang";

/**
 * 控制台：**已启动模型**的总览与操作台。
 *
 * 一个本地模型 = 一个服务器进程，可以同时跑多个（各自端口）；这里启动、卸载、
 * 重启、设当前模型，并给每个实例挂一份实时日志。对话 / Agent 的模型选择器
 * 只列这里已经启动的实例 —— 启动是控制台的事，不在下拉框里等冷启动。
 */
export function ConsoleScreen() {
  const t = useT();
  const models = useServedStore((s) => s.models);
  const running = models.filter((m) => m.status === "running").length;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 px-6 pb-20">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
          <TerminalSquareIcon className="size-4" />
        </span>
        <h2 className="text-lg font-semibold tracking-tight">{t("console.title")}</h2>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground tabular-nums">
          {t("console.runningCount", { n: String(running) })}
        </span>
        <span className="text-[11px] text-muted-foreground/70">{t("console.subtitle")}</span>
        <div className="flex-1" />
        <StopAllServedButton />
      </div>

      {/* 模型列表可滚动（多开时不会把日志挤没），日志区吃剩余高度 */}
      <div className="max-h-[40%] min-h-0 shrink-0 overflow-y-auto pr-1">
        <ServedModelsPanel />
      </div>

      <ServedModelLogs />
    </div>
  );
}
