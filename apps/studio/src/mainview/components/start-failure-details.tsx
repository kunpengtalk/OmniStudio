import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TerminalSquareIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { useRouter } from "@stores/router";
import { useServedStore } from "@stores/served";
import { useT } from "@stores/ui-lang";
import { engineSpec, type InferenceEngine } from "@/shared/engines";
import { firstErrorLine } from "@/mainview/lib/server-error";
import { EngineInstaller } from "@/mainview/app/setup-screen/engine-install";
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
 * 第三种情况是「引擎不认识这个模型」（主进程分的 `model-format`）：这时唯一能保住用户
 * 所选模型的动作是**装一次最新构建**，所以把入口直接摆在这里 —— 设置里的「模型引擎」页
 * 一样能升级，但报告者的原话就是「界面有点复杂」，不该让他再去找一趟。
 *
 * 只在失败路径上渲染（调用方负责），所以这里的查询都只在真的出错、且真需要时才发生。
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
  const queryClient = useQueryClient();
  const setRoute = useRouter((s) => s.setRoute);
  // 实例日志优先用实例自己的那一份；主进程的推送可能还没到（刚 reload 的 webview），
  // 所以再向主进程要一次全量，谁有内容用谁。
  const pushedLogs = useServedStore((s) => (servedId ? s.logs[servedId] : undefined)) ?? "";
  // 失败类型由主进程算好（它见过完整日志）：这里只读，不重新分类。
  const errorKind = useServedStore((s) =>
    servedId ? s.models.find((m) => m.id === servedId)?.errorKind : undefined,
  );

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
  // 「引擎说它不认识这个模型」时把升级入口摆出来：引擎得先装着（没装是另一条路，
  // 启动条上已经有按钮了），且这一支真的用得着。
  const engineTooOld = errorKind === "model-format" && row != null && row.state !== "missing";
  const { data: env } = useQuery({
    queryKey: ["setup-env"],
    queryFn: () => rpcClient.getSetupEnvironment(),
    enabled: engineTooOld,
  });
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
      {/* 「引擎不认识这个模型」的补救：装一次最新构建（复用引导页那个组件，
          它自带阶段与实时日志，装的过程中这里不会变成"点了没反应"）。
          只是建议不是断论 —— 也可能这份模型新到最新构建也不认识，所以措辞是"常见原因"。 */}
      {engineTooOld && env && (
        <div className="space-y-1 border-t border-destructive/20 pt-1.5">
          <p className="text-[11px] text-muted-foreground">{t("server.diag.engineTooOld")}</p>
          <EngineInstaller
            engine={engine}
            support={env.installSupport[engine]}
            manualHint={engineSpec(engine).installHint}
            managedInstalling={env.installing === engine}
            onInstalled={() => {
              // 装完刷新引擎行（版本号要跟着变，否则用户会以为没升上去）。
              queryClient.invalidateQueries({ queryKey: ["local-engines"] });
              queryClient.invalidateQueries({ queryKey: ["setup-env"] });
            }}
          />
        </div>
      )}
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
