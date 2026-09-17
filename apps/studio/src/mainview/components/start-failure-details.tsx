import { useQuery } from "@tanstack/react-query";
import { TerminalSquareIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { useRouter } from "@stores/router";
import { useServedStore } from "@stores/served";
import { useT } from "@stores/ui-lang";
import type { InferenceEngine } from "@/shared/modelscope";
import { firstErrorLine } from "@/mainview/lib/server-error";
import { formatBytes } from "@lib/format";

/**
 * 启动失败卡片上的「诊断信息」。
 *
 * 两件事决定了本地模型加载失败能不能被远程定位：**引擎构建的版本**（太旧会认不出
 * 新模型的元数据）和**日志里第一条 error**（最后那句 `exiting due to model loading
 * error` 只是结论）。原先两样都散在设置页深处，issue #16 的报告者因此卡住 ——
 * 「模型大小没有问题，我暂时 API 调用吧，日志在哪我也不知道，界面有点复杂」。
 * 把这两样连同「打开控制台」一起摆在报错下面，用户截一张图就够了。
 *
 * 只在失败路径上渲染（调用方负责），所以这里的两次查询都只在真的出错时才发生。
 */
export function StartFailureDetails({
  engine,
  model,
  servedId,
}: {
  engine: InferenceEngine;
  /** 失败的模型（文件名 + 字节数：和官方字节数对一下就知道下载有没有缺一段）。 */
  model?: { fileName: string; size: number };
  /** 失败实例的 id —— 它的日志尾巴里有那条要贴的 error。 */
  servedId?: string;
}) {
  const t = useT();
  const setRoute = useRouter((s) => s.setRoute);
  // 实例日志优先用实例自己的那一份；主进程的推送可能还没到（刚 reload 的 webview），
  // 所以再向主进程要一次全量，谁有内容用谁。
  const pushedLogs = useServedStore((s) => (servedId ? s.logs[servedId] : undefined)) ?? "";

  const { data: engineData } = useQuery({
    queryKey: ["local-engines"],
    queryFn: () => rpcClient.listLocalEngines(undefined),
  });
  const { data: logData } = useQuery({
    queryKey: ["served-model-logs", servedId ?? ""],
    queryFn: () => rpcClient.getServedModelLogs({ id: servedId! }),
    enabled: Boolean(servedId),
  });

  const row = engineData?.engines.find((e) => e.id === engine);
  // 系统里那份（brew / PATH）不猜版本 —— 与「模型引擎」页同一口径，别在这里编一个。
  const engineValue = row?.version
    ? `${engine} · ${row.version}`
    : `${engine} · ${t(row?.state === "system" ? "server.diag.engineSystem" : "server.diag.engineNoVersion")}`;
  const errorLine = firstErrorLine(logData?.logs || pushedLogs);

  return (
    <div className="mt-1 space-y-1 rounded-md border border-destructive/30 bg-destructive/5 p-2">
      <p className="text-[11px] font-medium">{t("server.diag.title")}</p>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[11px]">
        <span className="text-muted-foreground">{t("server.diag.engine")}</span>
        <span className="min-w-0 break-all font-mono">{engineValue}</span>
        {model && (
          <>
            <span className="text-muted-foreground">{t("server.diag.model")}</span>
            <span className="min-w-0 break-all font-mono">
              {model.fileName} · {formatBytes(model.size)}（
              {t("server.diag.bytes", { n: model.size.toLocaleString("en-US") })}）
            </span>
          </>
        )}
        <span className="text-muted-foreground">{t("server.diag.logFirstError")}</span>
        <span className="min-w-0 break-all font-mono">
          {errorLine ?? t("server.diag.noErrorLine")}
        </span>
      </div>
      {/* 启动日志不止这一行：要完整输出（或贴给别人）时得有个入口。
          以前这个入口只在「服务在跑/在启动」时才出现在启动条上，失败了反而消失。 */}
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-xs"
        onClick={() => setRoute({ path: "settings", tab: "logs" })}
      >
        <TerminalSquareIcon data-icon="inline-start" />
        {t("console.open")}
      </Button>
    </div>
  );
}
