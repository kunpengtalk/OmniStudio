import { useQuery } from "@tanstack/react-query";
import { CpuIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { useEngine } from "@lib/use-engine";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { useT } from "@stores/ui-lang";
import { engineOptions, type InferenceEngine } from "@/shared/engines";

// ---------------------------------------------------------------------------
// 引擎选择
// ---------------------------------------------------------------------------

export function EngineSelector() {
  const t = useT();
  const { engine, setEngine, isSaving } = useEngine();
  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  // MLX 只面向 macOS，非 mac 不展示该引擎选项。
  const isMac = data?.platform === "darwin";
  // 平台限制（MLX 仅 macOS）由 engines.ts 的 macOnly 声明，这里不再硬编码引擎名。
  const options = engineOptions(isMac);

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <CpuIcon className="size-3.5" />
        {t("settings.engine")}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Select value={engine} onValueChange={(v) => setEngine(v as InferenceEngine)} disabled={isSaving}>
          <SelectTrigger className="h-8 w-72 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value}>{t(o.labelKey)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">{t("models.engineHint")}</p>
      </div>
    </div>
  );
}
