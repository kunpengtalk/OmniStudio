import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRightIcon, CloudIcon, SearchIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { useRouter } from "@stores/router";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import {
  modelTypeOf,
  providerColor,
  providerModelsOfType,
  providerConfigured,
  type CloudModelType,
  type CloudProviderInfo,
} from "@/shared/cloud-providers";
import { ModelCategoryIcon } from "@components/model-category-badge";

/**
 * 「云厂商 → 模型」两级选择器：所有需要云端模型的地方都用它。
 *
 * 规则（全应用统一）：
 * - 厂商列表只列**已启用**的（设置页「启动」时校验过密钥），且必须在该用途下有模型
 *   （生图只列有生图模型的厂商，TTS 只列有 TTS 模型的厂商，依此类推）；
 * - 模型列表只列该厂商下这一用途的模型 —— 用户不会再看到"这个模型是不是能用在这里"；
 * - 页面不提供地址 / 密钥输入：连接信息统一在「设置 → 模型云服务」里维护。
 *
 * 选厂商后该厂商只有一个可用模型时直接选中它，少一次点击。
 *
 * 布局是**上下两行**（先厂商、再模型），不给两行并排：并排时两个 Select 各分一半
 * 宽度，厂商名与模型 id（`Qwen/Qwen-Image-2512` 这类）都会被截成省略号，用户根本
 * 认不出选的是什么。
 */

export type CloudModelChoice = { providerId: string; model: string };

export function CloudModelSelect({
  kind,
  providerId,
  model,
  onChange,
  disabled,
  requireVideoApi,
  requireMusicApi,
  size = "default",
  className,
}: {
  /** 用途分类：只列这个用途的厂商与模型。 */
  kind: CloudModelType;
  providerId: string;
  model: string;
  onChange: (choice: CloudModelChoice) => void;
  disabled?: boolean;
  /** 生视频：只列配置了生视频接口（MiniMax / Seedance）的厂商。 */
  requireVideoApi?: boolean;
  /** 生音乐：只列配置了生音乐接口（StepFun / MiniMax）的厂商。 */
  requireMusicApi?: boolean;
  size?: "sm" | "default";
  className?: string;
}) {
  const t = useT();
  const setRoute = useRouter((s) => s.setRoute);
  const [modelSearch, setModelSearch] = useState("");
  const [modelOpen, setModelOpen] = useState(false);

  const providersQuery = useQuery({
    queryKey: ["cloud-providers"],
    queryFn: () => rpcClient.cloudProviderList(undefined),
  });
  const all = useMemo(() => providersQuery.data?.providers ?? [], [providersQuery.data]);

  // 可选厂商：已启用 + 该用途下有模型（生视频 / 生音乐还要有各自的接口协议 ——
  // 这两类 API 没有统一标准，协议缺失时选它也调不通）。
  const candidates = useMemo(
    () =>
      all.filter(
        (p) =>
          p.enabled &&
          (!requireVideoApi || Boolean(p.videoApi)) &&
          (!requireMusicApi || Boolean(p.musicApi)) &&
          providerModelsOfType(p, kind).length > 0,
      ),
    [all, kind, requireVideoApi, requireMusicApi],
  );

  // 当前选中的厂商不在候选里（已停用 / 模型被删）时也要显示出来，
  // 否则选择器看起来是空的、用户不知道自己选过什么。
  const selectedProvider = all.find((p) => p.id === providerId) ?? null;
  const providerOptions = useMemo(
    () =>
      selectedProvider && !candidates.some((p) => p.id === selectedProvider.id)
        ? [selectedProvider, ...candidates]
        : candidates,
    [candidates, selectedProvider],
  );

  const providerModelList = selectedProvider ? providerModelsOfType(selectedProvider, kind) : [];
  const keyword = modelSearch.trim().toLowerCase();
  const shownModels = keyword
    ? providerModelList.filter((m) => m.id.toLowerCase().includes(keyword))
    : providerModelList;
  // 选中的模型不在当前清单里（手改过 / 刚被删）也展示出来，避免显示成"没选"。
  const knownModel = providerModelList.some((m) => m.id === model);
  const modelValue = model || undefined;

  const pickProvider = (id: string) => {
    const provider = all.find((p) => p.id === id);
    if (!provider) return;
    const list = providerModelsOfType(provider, kind);
    // 该厂商这份清单里只有一个模型就直接用上，用户少点一次。
    const next = model && list.some((m) => m.id === model) ? model : (list[0]?.id ?? "");
    onChange({ providerId: id, model: next });
  };

  const closeModel = (open: boolean) => {
    setModelOpen(open);
    if (!open) setModelSearch("");
  };

  const goSettings = () => setRoute({ path: "settings", tab: "network" });
  const empty = candidates.length === 0;
  const height = size === "sm" ? "h-8 text-xs" : "";
  const modelCount = providerModelList.length;

  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <Select
        value={providerId || undefined}
        onValueChange={pickProvider}
        disabled={disabled || providersQuery.isLoading || providerOptions.length === 0}
      >
        <SelectTrigger size={size} className={cn("w-full min-w-0", height)}>
          <SelectValue placeholder={t("cloud.pick.vendor")} />
        </SelectTrigger>
        <SelectContent
          position="popper"
          sideOffset={6}
          className="w-[22rem] max-w-[min(22rem,90vw)]"
        >
          {providerOptions.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              <ProviderDot provider={p} />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
                {providerModelsOfType(p, kind).length}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={modelValue}
        open={modelOpen}
        onOpenChange={closeModel}
        onValueChange={(v) => {
          closeModel(false);
          onChange({ providerId, model: v });
        }}
        disabled={disabled || !selectedProvider}
      >
        <SelectTrigger size={size} className={cn("w-full min-w-0", height)}>
          <SelectValue placeholder={t("cloud.pick.model")} />
        </SelectTrigger>
        <SelectContent
          position="popper"
          sideOffset={6}
          className="w-[24rem] max-w-[min(24rem,90vw)]"
        >
          {modelCount > 6 && (
            <div
              className="sticky top-0 z-10 bg-popover p-1.5 pb-1"
              onKeyDown={(e) => e.stopPropagation()}
            >
              <div className="relative">
                <Input
                  value={modelSearch}
                  onChange={(e) => setModelSearch(e.target.value)}
                  placeholder={t("chat.modelSearch")}
                  autoFocus
                  className="h-7 pl-7 text-xs"
                />
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 opacity-50" />
              </div>
            </div>
          )}
          {modelValue && !knownModel && (
            <SelectItem value={modelValue}>
              <span className="min-w-0 flex-1 truncate">{modelValue}</span>
              <span className="text-[10px] text-muted-foreground/70">
                {t("settings.integrations.currentValue")}
              </span>
            </SelectItem>
          )}
          {shownModels.map((m) => (
            <SelectItem key={m.id} value={m.id}>
              <span className="min-w-0 flex-1 truncate">{m.name || m.id}</span>
              {m.name && m.name !== m.id && (
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
                  {m.id}
                </span>
              )}
            </SelectItem>
          ))}
          {shownModels.length === 0 && (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">
              {selectedProvider && selectedProvider.models.length === 0
                ? t("cloud.pick.vendorNoModels")
                : t("cloud.pick.noModels")}
            </div>
          )}
        </SelectContent>
      </Select>

      {empty && (
        <Button
          variant="outline"
          size="sm"
          className={cn("w-full", size === "sm" && "h-8 text-xs")}
          onClick={goSettings}
        >
          <CloudIcon data-icon="inline-start" className="size-3.5" />
          {t("cloud.pick.configure")}
          <ArrowUpRightIcon data-icon="inline-end" className="size-3" />
        </Button>
      )}
    </div>
  );
}

/** 只读一行：当前用哪个厂商的哪个模型（面板抬头 / 摘要用）。 */
export function CloudModelSummary({
  providerId,
  model,
  kind,
  className,
}: {
  providerId: string;
  model: string;
  kind: CloudModelType;
  className?: string;
}) {
  const t = useT();
  const providersQuery = useQuery({
    queryKey: ["cloud-providers"],
    queryFn: () => rpcClient.cloudProviderList(undefined),
  });
  const provider = (providersQuery.data?.providers ?? []).find((p) => p.id === providerId);
  if (!providerId && !model) {
    return (
      <span className={cn("text-xs text-muted-foreground", className)}>{t("cloud.pick.none")}</span>
    );
  }
  const usableModels = provider ? providerModelsOfType(provider, kind) : [];
  const mismatch = !!provider && !!model && !usableModels.some((m) => m.id === model);
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5 text-xs", className)}>
      <ModelCategoryIcon category={kind} label={t(`models.cat.${kind}`)} />
      <span className="truncate">{provider?.name ?? providerId}</span>
      <span className="truncate font-mono text-[10px] text-muted-foreground">{model}</span>
      {provider && !providerConfigured(provider) && (
        <span className="text-[10px] text-destructive">{t("cloud.pick.notReady")}</span>
      )}
      {mismatch && <span className="text-[10px] text-amber-600">{t("cloud.pick.mismatch")}</span>}
    </span>
  );
}

/** 厂商色点：与设置页的服务商徽章同一套配色。 */
function ProviderDot({ provider }: { provider: Pick<CloudProviderInfo, "id" | "name"> }) {
  const color = providerColor(provider.id, provider.name, provider.id.startsWith("custom-"));
  return (
    <span
      className="flex size-4 shrink-0 items-center justify-center rounded text-[9px] font-semibold text-white"
      style={{ backgroundColor: color }}
    >
      {provider.name.charAt(0).toUpperCase()}
    </span>
  );
}

/** 该用途下"这个模型能不能用"（设置页 / 提示语共用）。 */
export function cloudModelUsable(provider: CloudProviderInfo, model: string, kind: CloudModelType) {
  const entry = provider.models.find((m) => m.id === model);
  if (!entry) return false;
  return modelTypeOf(entry) === kind;
}
