import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangleIcon,
  ArrowUpRightIcon,
  Loader2Icon,
  RefreshCwIcon,
  SquareTerminalIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { ENGINE_SHORT_NAMES } from "@/shared/engines";
import { ModelCategoryIcon } from "@components/model-category-badge";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@ui/select";
import { useRouter } from "@stores/router";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";

/**
 * 模型选择器：**已启动**的本地模型 + 已配置云服务商的模型。
 *
 * 本地列表里只有正在跑（或正在加载）的实例 —— 没启动的模型列在这里没有意义
 * （选中要么等一次冷启动，要么报错）。启动 / 卸载在控制台做，这里只切换
 * 「请求发给谁」，所以是瞬时的，没有启动进度要等。对话与 Agent 共用这一份列表。
 */
export function ModelPicker({ disabled = false }: { disabled?: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const setRoute = useRouter((s) => s.setRoute);
  const [pendingValue, setPendingValue] = useState<string | null>(null);

  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  const modelsQuery = useQuery({
    queryKey: ["chat-models"],
    queryFn: () => rpcClient.listChatModels(),
  });

  const settings = settingsData?.settings;
  const mode = settings?.SERVER_MODE ?? "local";
  const chatModel = settings?.CHAT_MODEL ?? "";
  const apiModel = settings?.VLLM_MODEL_NAME ?? "";

  const options = modelsQuery.data?.models ?? [];
  // 对话框里只给能立刻用的本地模型：**已启动**（running / 正在加载）的实例。
  // 没启动的模型（state = stopped）留在接口里给控制台与「默认模型」面板用，不在这里列。
  const localOptions = options.filter(
    (o) =>
      o.type === "local" &&
      (o.state === "running" || o.state === "starting" || o.state === "downloading"),
  );
  const apiOptions = options.filter((o) => o.type === "api");

  // 当前值：本地取活动实例 id，云端取模型名。活动实例不在列表里（已卸载）时留空，
  // 让用户看到「没有可用的本地模型」，而不是显示一个跑不起来的名字。
  const activeLocal = localOptions.find((o) => o.isActive);
  const current = mode === "remote" ? apiModel || chatModel || "" : (activeLocal?.value ?? "");

  const selectMutation = useMutation({
    mutationFn: (opt: { type: "local" | "api"; value: string; providerId?: string }) =>
      rpcClient.selectChatModel(opt),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["installed-models"] });
      queryClient.invalidateQueries({ queryKey: ["chat-models"] });
      queryClient.invalidateQueries({ queryKey: ["served-models"] });
    },
    onSettled: () => setPendingValue(null),
  });

  const handleChange = (value: string) => {
    const option = [...localOptions, ...apiOptions].find((o) => o.value === value);
    if (!option || option.value === current) return;
    setPendingValue(option.value);
    selectMutation.mutate({
      type: option.type,
      value: option.value,
      providerId: option.providerId,
    });
  };

  // 下拉框内搜索：按名称 / 详情过滤本地与 API 模型。
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const keyword = query.trim().toLowerCase();
  const matches = (o: { label: string; value: string; detail?: string }) =>
    !keyword ||
    o.label.toLowerCase().includes(keyword) ||
    o.value.toLowerCase().includes(keyword) ||
    (o.detail ?? "").toLowerCase().includes(keyword);
  const closeAndReset = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };

  const shownLocal = localOptions.filter(matches);
  const visibleOptions = [...localOptions, ...apiOptions];
  const shownApi = apiOptions.filter(matches);
  const firstMatch = shownLocal[0] ?? shownApi[0];
  const busy = selectMutation.isPending || modelsQuery.isLoading;
  const selectError =
    selectMutation.isError
      ? String(selectMutation.error)
      : !selectMutation.isPending && selectMutation.data && !selectMutation.data.ok
        ? (selectMutation.data.error ?? t("chat.modelSwitchFailed"))
        : null;
  const pendingOption = pendingValue
    ? [...localOptions, ...apiOptions].find((o) => o.value === pendingValue)
    : undefined;

  /** 本地一个都没启动：给去控制台的入口（启动是控制台的事，这里只引导）。 */
  const showConsoleHint = localOptions.length === 0;

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Select
        value={current}
        open={open}
        onOpenChange={closeAndReset}
        onValueChange={(v) => {
          handleChange(v);
          closeAndReset(false);
        }}
        disabled={busy || disabled}
      >
        <SelectTrigger size="sm" className="h-8 min-w-36 max-w-72 text-xs">
          <SelectValue placeholder={t("chat.modelEmpty")} />
        </SelectTrigger>
        <SelectContent
          className="w-[30rem] max-w-[min(30rem,90vw)]"
          position="popper"
          align="end"
          sideOffset={6}
        >
          {/* 搜索框：拦截键盘事件，避免被 Select 的 typeahead 抢走焦点 */}
          <div
            className="sticky top-0 z-10 bg-popover p-1.5 pb-1"
            onKeyDown={(e) => e.stopPropagation()}
          >
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && firstMatch) {
                  e.preventDefault();
                  handleChange(firstMatch.value);
                  closeAndReset(false);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  closeAndReset(false);
                }
              }}
              placeholder={t("chat.modelSearch")}
              autoFocus
              className="h-7 text-xs"
            />
          </div>
          {shownLocal.length > 0 && (
            <SelectGroup>
              <SelectLabel>{t("chat.modelLocalRunning")}</SelectLabel>
              {shownLocal.map((o) => (
                <SelectItem key={`local-${o.value}`} value={o.value}>
                  <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span className="truncate">{o.label}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {o.state === "running" ? (
                      <span className="size-1.5 rounded-full bg-emerald-500" />
                    ) : (
                      <Loader2Icon className="size-3 animate-spin text-amber-500" />
                    )}
                    <ModelCategoryIcon category={o.category} label={t(`models.cat.${o.category}`)} />
                    {o.engine && (
                      <span className="rounded-sm bg-muted px-1 text-[9px] leading-4 text-muted-foreground">
                        {ENGINE_SHORT_NAMES[o.engine]}
                      </span>
                    )}
                    <span className="max-w-40 truncate font-mono text-[10px] text-muted-foreground/70">
                      {o.endpoint?.replace(/^https?:\/\//, "")}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          {shownApi.length > 0 && (
            <SelectGroup>
              <SelectLabel>{t("chat.modelApi")}</SelectLabel>
              {shownApi.map((o) => (
                <SelectItem key={`api-${o.providerId ?? "x"}-${o.value}`} value={o.value}>
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <ModelCategoryIcon category={o.category} label={t(`models.cat.${o.category}`)} />
                    {o.providerName && (
                      <span className="max-w-40 truncate text-[10px] text-muted-foreground/70">
                        {o.providerName}
                      </span>
                    )}
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          {visibleOptions.length === 0 && (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">
              {t("chat.modelEmpty")}
            </div>
          )}
          {visibleOptions.length > 0 && !firstMatch && (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">
              {t("chat.modelNoMatch")}
            </div>
          )}
        </SelectContent>
      </Select>
      {showConsoleHint && (
        <Button
          variant="outline"
          size="xs"
          className="h-8 shrink-0 text-[11px]"
          tooltip={t("chat.modelStartInConsoleHint")}
          onClick={() => setRoute({ path: "settings", tab: "logs" })}
        >
          <SquareTerminalIcon data-icon="inline-start" />
          {t("chat.modelStartInConsole")}
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        tooltip={t("chat.modelRefresh")}
        onClick={() => {
          queryClient.invalidateQueries({ queryKey: ["chat-models"] });
          queryClient.invalidateQueries({ queryKey: ["served-models"] });
        }}
        disabled={modelsQuery.isFetching}
      >
        <RefreshCwIcon className={cn("size-3.5", modelsQuery.isFetching && "animate-spin")} />
      </Button>
      {selectError && (
        <span className="flex min-w-0 items-center gap-1 text-[11px] text-destructive">
          <AlertTriangleIcon className="size-3 shrink-0" />
          <span className="truncate">{selectError}</span>
        </span>
      )}
      {selectMutation.isPending && (
        <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
          <Loader2Icon className="size-3 shrink-0 animate-spin" />
          <span className="truncate">
            {pendingOption?.type === "local"
              ? t("chat.modelSwitchingLocal")
              : t("chat.modelSwitching")}
          </span>
        </span>
      )}
      {/* 云端模式：换厂商 / 补 Key 的入口（列表只含已配置厂商） */}
      {mode === "remote" && (
        <Button
          variant="ghost"
          size="icon-sm"
          tooltip={t("chat.modelCloudSettings")}
          onClick={() => setRoute({ path: "settings", tab: "network" })}
        >
          <ArrowUpRightIcon className="size-3.5" />
        </Button>
      )}
    </div>
  );
}
