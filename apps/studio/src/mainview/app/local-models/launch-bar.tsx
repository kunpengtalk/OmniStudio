import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon, PlayIcon, AlertTriangleIcon, TerminalSquareIcon, FolderIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { useRouter } from "@stores/router";
import { useServedStore } from "@stores/served";
import { useT } from "@stores/ui-lang";
import { fileKind, engineSupports, type InstalledModel, type InferenceEngine } from "@/shared/modelscope";
import { engineSpec } from "@/shared/engines";
import { isEngineMissingError, serverErrorHint } from "@/mainview/lib/server-error";
import { EngineInstaller } from "@/mainview/app/setup-screen/engine-install";
import { cn } from "@/mainview/lib/utils";

// ---------------------------------------------------------------------------
// 启动条
// ---------------------------------------------------------------------------

/** 启动条：选择已下载的模型 + 启动/重启服务器（使用上方所选引擎与启动参数）。
 * 只列出当前引擎能加载的模型，避免在 MLX 下选到 GGUF 等不兼容文件。 */
export function LaunchBar({ installedModels, engine }: { installedModels: InstalledModel[]; engine: InferenceEngine }) {
  // 目录条目（HF 缓存里的整仓库）按它自己的格式判断兼容性，文件名没有扩展名。
  // 启动条是聊天模型的启动器：嵌入 / 重排模型不能设为当前聊天模型（后端直接拒），
  // 别把它们列进下拉框 —— 选了也设不上，还挤占聊天模型的列表。
  const compatibleModels = installedModels.filter(
    (m) =>
      engineSupports(engine, m.kind) &&
      m.category !== "embedding" &&
      m.category !== "rerank",
  );
  const t = useT();
  const queryClient = useQueryClient();
  const setRoute = useRouter((s) => s.setRoute);
  const servedModels = useServedStore((s) => s.models);
  const [startError, setStartError] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  const activePath = data?.settings.LOCAL_MODEL_PATH ?? "";
  // 状态按**这个模型自己的实例**看：多实例下"当前活动实例在跑"不代表所选模型在跑。
  const servedForModel = servedModels.find((m) => m.modelRef === activePath);
  const serverStatus = servedForModel?.status ?? "stopped";

  const selectMutation = useMutation({
    mutationFn: (path: string) => rpcClient.setActiveModel({ path }),
    onSuccess: () => {
      setStartError(null);
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["installed-models"] });
    },
  });
  const startMutation = useMutation({
    mutationFn: async () => {
      // 已启动过就重启那个实例（换端口 / 重载设置），没启动过就按路径启动一个。
      const res = servedForModel
        ? await rpcClient.restartServedModel({ id: servedForModel.id })
        : await rpcClient.startServedModel({ path: activePath });
      if (!res.ok) throw new Error(res.error || "Failed to start server");
      return res;
    },
    onSuccess: () => {
      setStartError(null);
      queryClient.invalidateQueries({ queryKey: ["installed-models"] });
      queryClient.invalidateQueries({ queryKey: ["served-models"] });
      queryClient.invalidateQueries({ queryKey: ["chat-models"] });
    },
    onError: (err: unknown) =>
      setStartError(err instanceof Error ? err.message.replace(/^Error:\s*/i, "") : String(err)),
  });

  const busy = serverStatus === "starting" || serverStatus === "downloading";
  const startErrorHint = startError ? serverErrorHint(t, startError) : null;
  const engineMissing = isEngineMissingError(startError);
  // 引擎能不能一键装、是不是正在装：和引导页用同一个后端来源。webview 里没有
  // process.platform，界面侧算不出 engineInstallSupport，只能问主进程；安装完成后
  // lib/rpc.ts 会失效这个 query，这里不用自己刷。只在真的报引擎缺失时才拉。
  const { data: env } = useQuery({
    queryKey: ["setup-env"],
    queryFn: () => rpcClient.getSetupEnvironment(),
    enabled: engineMissing,
  });

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-64 flex-1 flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">{t("models.chooseModel")}</span>
          <Select
            value={activePath}
            onValueChange={(v) => selectMutation.mutate(v)}
            disabled={selectMutation.isPending || busy}
          >
            <SelectTrigger className="h-9 text-xs">
              <SelectValue placeholder={t("models.chooseModelEmpty")} />
            </SelectTrigger>
            <SelectContent className="w-[30rem] max-w-[min(30rem,90vw)]">
              {compatibleModels.map((m) => {
                const kind = m.kind ?? fileKind(m.fileName);
                return (
                  <SelectItem key={m.path} value={m.path}>
                    <span className="flex min-w-0 flex-1 items-center gap-1.5">
                      {m.isDir && (
                        <FolderIcon className="size-3 shrink-0 text-muted-foreground/60" />
                      )}
                      <span className="truncate">{m.fileName}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground/70">
                      {m.isActive && <span className="text-primary">{t("models.inUse")}</span>}
                      <span className="rounded-sm bg-muted px-1 text-[9px] leading-4 text-muted-foreground">
                        {kind === "gguf"
                          ? "GGUF"
                          : kind === "safetensors"
                            ? "safetensors"
                            : t("models.format.other")}
                      </span>
                      <span className="max-w-44 truncate">{m.repo}</span>
                    </span>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>
        <span
          className={cn(
            "pb-2 text-[11px]",
            serverStatus === "running" && "text-emerald-600 dark:text-emerald-400",
            (serverStatus === "starting" || serverStatus === "downloading") && "text-amber-600 dark:text-amber-400",
            serverStatus === "error" && "text-destructive",
            serverStatus === "stopped" && "text-muted-foreground",
          )}
        >
          {t(`server.status.${serverStatus}`)}
        </span>
        <Button
          variant="default"
          size="sm"
          className="h-8 text-xs"
          disabled={!activePath || busy || startMutation.isPending}
          tooltip={!activePath ? t("models.needModel") : undefined}
          onClick={() => startMutation.mutate()}
        >
          {startMutation.isPending ? (
            <Loader2Icon data-icon="inline-start" className="animate-spin" />
          ) : (
            <PlayIcon data-icon="inline-start" />
          )}
          {serverStatus === "running" ? t("models.restartServer") : t("models.launch")}
        </Button>
        {/* 启动是后台进行的：进度 / 日志在控制台看，这里给个直达入口。 */}
        {serverStatus !== "stopped" && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            tooltip={t("console.open")}
            onClick={() => setRoute({ path: "settings", tab: "logs" })}
          >
            <TerminalSquareIcon data-icon="inline-start" />
            {t("console.title")}
          </Button>
        )}
      </div>
      {startError && (
        <div className="space-y-0.5">
          {startErrorHint && (
            <p className="flex items-start gap-1 text-[11px] text-destructive">
              <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
              <span className="min-w-0 break-words">{startErrorHint}</span>
            </p>
          )}
          {/* 引擎没装时，报错下面直接给「一键安装」（复用引导页那个组件）。
              这类机器通常已经有本地模型、不会再走引导页，只留一句 brew install 的话
              用户根本找不到界面上的路 —— issue #8 就是这么来的。 */}
          {engineMissing && env && (
            <EngineInstaller
              engine={engine}
              support={env.installSupport[engine]}
              manualHint={engineSpec(engine).installHint}
              managedInstalling={env.installing === engine}
              onInstalled={() => {
                // 装好了先把报错清掉：用户再点一次「启动服务器」就能起来。
                setStartError(null);
                queryClient.invalidateQueries({ queryKey: ["served-models"] });
              }}
            />
          )}
          <p className="flex items-start gap-1 text-[11px] text-destructive/70">
            <span className="mt-1.5 size-0.5 shrink-0 rounded-full bg-destructive/50" />
            <span className="min-w-0 break-words">{startError}</span>
          </p>
        </div>
      )}
    </div>
  );
}
