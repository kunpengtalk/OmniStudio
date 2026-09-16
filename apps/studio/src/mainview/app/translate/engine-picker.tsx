import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Label } from "@ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@ui/select";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import { SegmentedControl } from "@components/segmented-control";

export function useTranslationEngine(): "model" | "google" {
  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  return settingsData?.settings?.TRANSLATION_ENGINE === "google" ? "google" : "model";
}

/** 翻译引擎选择（与生图页后端切换同款样式）：模型翻译 / Google 免费引擎 + 模型下拉。 */
export function TranslationEnginePicker({ disabled }: { disabled?: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [pendingType, setPendingType] = useState<"local" | "api" | null>(null);

  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  const modelsQuery = useQuery({
    queryKey: ["chat-models"],
    queryFn: () => rpcClient.listChatModels(),
  });

  const settings = settingsData?.settings;
  const isGoogle = settings?.TRANSLATION_ENGINE === "google";
  const mode = settings?.SERVER_MODE ?? "local";
  const chatModel = settings?.CHAT_MODEL ?? "";
  const apiModel = settings?.VLLM_MODEL_NAME ?? "";
  const engineKey = isGoogle ? "google" : "model";

  const allOptions = modelsQuery.data?.models ?? [];
  // 本地只给已启动的实例（与对话一致）：翻译要的是一个正在跑的本地服务，
  // 没启动的模型选进来只会报「没模型在跑」。
  const localOptions = allOptions.filter(
    (o) =>
      o.type === "local" &&
      (o.state === "running" || o.state === "starting" || o.state === "downloading"),
  );
  const apiOptions = allOptions.filter((o) => o.type === "api");
  // 云端模型按厂商分组：先认厂商名（可同时启用多个），再选它下面的模型。
  const apiGroups = (() => {
    const groups = new Map<string, { name: string; items: typeof apiOptions }>();
    for (const o of apiOptions) {
      const key = o.providerId ?? o.providerName ?? "";
      const group = groups.get(key);
      if (group) group.items.push(o);
      else groups.set(key, { name: o.providerName ?? t("chat.modelApi"), items: [o] });
    }
    return [...groups.entries()];
  })();
  const current =
    mode === "remote"
      ? apiOptions.find((o) => o.isActive)?.value ?? apiModel ?? chatModel ?? ""
      : localOptions.find((o) => o.isActive)?.value ?? "";

  const switchEngine = useMutation({
    mutationFn: (engine: "model" | "google") =>
      rpcClient.updateSettings({ settings: { TRANSLATION_ENGINE: engine } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  const selectMutation = useMutation({
    // providerId 要带上：选了别家厂商的模型时一并把默认厂商切过去（网关只认默认厂商）。
    mutationFn: async (opt: { type: "local" | "api"; value: string; providerId?: string }) => {
      const r = await rpcClient.selectChatModel({ type: opt.type, value: opt.value, providerId: opt.providerId });
      // 选了模型即回到模型翻译引擎。
      await rpcClient.updateSettings({ settings: { TRANSLATION_ENGINE: "model" } });
      return r;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["installed-models"] });
      queryClient.invalidateQueries({ queryKey: ["chat-models"] });
      queryClient.invalidateQueries({ queryKey: ["server-status"] });
    },
    onSettled: () => setPendingType(null),
  });

  const pickModel = (value: string) => {
    const option = [...localOptions, ...apiOptions].find((o) => o.value === value);
    if (!option || option.value === current) return;
    setPendingType(option.type);
    selectMutation.mutate({ type: option.type, value: option.value, providerId: option.providerId });
  };

  const busy = selectMutation.isPending || switchEngine.isPending || modelsQuery.isLoading || disabled;
  const selectError = selectMutation.isError
    ? String(selectMutation.error)
    : !selectMutation.isPending && selectMutation.data && !selectMutation.data.ok
      ? (selectMutation.data.error ?? t("translate.switchFailed"))
      : null;

  return (
    <div>
      <Label className="mb-1.5 block text-xs">{t("translate.engine.title")}</Label>
      <SegmentedControl
        variant="attached"
        disabled={busy}
        value={engineKey}
        onChange={(v) => switchEngine.mutate(v)}
        options={[
          { value: "model", label: t("translate.engine.model") },
          { value: "google", label: t("translate.engine.google") },
        ]}
      />
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
        {switchEngine.isPending
          ? t("translate.engine.switching")
          : isGoogle
            ? t("translate.engine.googleDesc")
            : t("translate.engine.modelDesc")}
      </p>

      {!isGoogle && (
        <div className="mt-2.5">
          <div className="mb-1 flex items-center justify-between">
            <Label className="text-xs">{t("translate.model")}</Label>
            <Button
              variant="ghost"
              size="icon-sm"
              tooltip={t("chat.modelRefresh")}
              onClick={() => queryClient.invalidateQueries({ queryKey: ["chat-models"] })}
              disabled={modelsQuery.isFetching || disabled}
            >
              <RefreshCwIcon
                className={cn("size-3.5", modelsQuery.isFetching && "animate-spin")}
              />
            </Button>
          </div>
          <Select value={current} onValueChange={pickModel} disabled={busy}>
            <SelectTrigger className="h-8 w-full text-xs">
              <SelectValue placeholder={t("chat.modelEmpty")} />
            </SelectTrigger>
            <SelectContent className="max-w-80">
              {localOptions.length > 0 && (
                <SelectGroup>
                  <SelectLabel>{t("chat.modelLocalRunning")}</SelectLabel>
                  {localOptions.map((o) => (
                      <SelectItem key={`local-${o.value}`} value={o.value}>
                        <span className="truncate">{o.label}</span>
                        <span className="flex min-w-0 items-center gap-1">
                          {o.engine && (
                            <span className="rounded-sm bg-muted px-1 text-[9px] leading-4 text-muted-foreground">
                              {t(`settings.engine.${o.engine}`)}
                            </span>
                          )}
                          {o.detail && (
                            <span className="truncate text-[10px] text-muted-foreground/70">
                              {o.detail}
                            </span>
                          )}
                        </span>
                      </SelectItem>
                    ))}
                </SelectGroup>
              )}
              {apiGroups.map(([key, group]) => (
                <SelectGroup key={`api-group-${key}`}>
                  <SelectLabel>{group.name}</SelectLabel>
                  {group.items.map((o) => (
                    <SelectItem key={`api-${o.providerId ?? "x"}-${o.value}`} value={o.value}>
                      <span className="truncate">{o.label}</span>
                      {o.detail && (
                        <span className="truncate text-[10px] text-muted-foreground/70">
                          {o.detail}
                        </span>
                      )}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
              {localOptions.length === 0 && apiOptions.length === 0 && (
                <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                  {t("chat.modelEmpty")}
                </div>
              )}
            </SelectContent>
          </Select>
          {selectError && (
            <p className="mt-1 flex items-center gap-1 text-[11px] text-destructive">
              <span className="truncate">{selectError}</span>
            </p>
          )}
          {selectMutation.isPending && (
            <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
              <Loader2Icon className="size-3 shrink-0 animate-spin" />
              <span className="truncate">
                {pendingType === "local" ? t("chat.modelRestarting") : t("chat.modelSwitching")}
              </span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

