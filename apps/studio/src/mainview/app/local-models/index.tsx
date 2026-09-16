import { useQuery } from "@tanstack/react-query";
import { CpuIcon, HardDriveIcon, StoreIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { useEngine } from "@lib/use-engine";
import { Button } from "@ui/button";
import { ScrollArea } from "@ui/scroll-area";
import { PageShell } from "@components/setting-ui";
import { useRouter } from "@stores/router";
import { useModelDetailStore, type ModelDetailSource } from "@stores/model-detail";
import { useT } from "@stores/ui-lang";
import { MODEL_PRESETS, type ChatPreset, type InferenceEngine } from "@/shared/modelscope";
import { EngineSelector } from "./engine-selector";
import { ServerParamsPanel } from "./params";
import { LaunchBar } from "./launch-bar";
import { InstalledModels } from "./installed";
import { DefaultModelConfig } from "./defaults";

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

/**
 * 在 ModelScope 精选模型里自动挑选一个与当前引擎匹配的默认模型。
 * 仅用于「还没有已安装模型」时的提示/跳转，不直接启动。
 */
function useFirstSuggestedPreset(engine: InferenceEngine): ChatPreset | null {
  const { data } = useQuery({
    queryKey: ["installed-models"],
    queryFn: () => rpcClient.listInstalledModels(),
  });
  const installed = data?.models ?? [];
  if (installed.length > 0) return null;
  return (
    MODEL_PRESETS.find((p) => !p.engine || p.engine === "all" || p.engine === engine) ?? null
  );
}

/** 本地模型：推理引擎 / 启动参数 / 启动按钮 / 已安装模型管理。 */
export function LocalModelsScreen({
  onOpenDetail,
}: {
  onOpenDetail?: (source: ModelDetailSource) => void;
} = {}) {
  const t = useT();
  const setRoute = useRouter((s) => s.setRoute);
  const { engine } = useEngine();
  const { data: installedData } = useQuery({
    queryKey: ["installed-models"],
    queryFn: () => rpcClient.listInstalledModels(),
  });
  const installedModels = installedData?.models ?? [];
  const suggested = useFirstSuggestedPreset(engine);

  return (
    <ScrollArea className="h-full">
      <PageShell>
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <CpuIcon className="size-5" />
            {t("local.title")}
          </h2>
          <p className="text-xs text-muted-foreground">{t("local.subtitle")}</p>
        </div>

        {suggested && installedModels.length === 0 && (
          <div className="flex flex-col gap-2 rounded-lg border border-dashed p-4">
            <p className="text-xs text-muted-foreground">
              {t("local.noModel")}：{suggested.label}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() => {
                const source = { kind: "preset", preset: suggested } as const;
                useModelDetailStore.getState().setSource(source);
                if (onOpenDetail) onOpenDetail(source);
                else setRoute({ path: "model-detail" });
              }}
            >
              <StoreIcon data-icon="inline-start" className="size-3.5" />
              {t("local.goMarket")}
            </Button>
          </div>
        )}

        <EngineSelector />
        <ServerParamsPanel engine={engine} />
        <LaunchBar installedModels={installedModels} engine={engine} />

        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              <HardDriveIcon className="size-4" />
              {t("models.installed")}
            </h3>
          </div>
          <InstalledModels engine={engine} />
        </div>

        <DefaultModelConfig />
      </PageShell>
    </ScrollArea>
  );
}
