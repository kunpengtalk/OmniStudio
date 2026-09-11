import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangleIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
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
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";

/**
 * 模型选择器：本地已安装模型 + OpenAI 兼容 API 模型。
 * 对话与 Agent 共用同一份可选模型列表（「模型跟对话一样，选它能选的即可」）。
 */
export function ModelPicker({ disabled = false }: { disabled?: boolean }) {
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
  const mode = settings?.SERVER_MODE ?? "local";
  const chatModel = settings?.CHAT_MODEL ?? "";
  const apiModel = settings?.VLLM_MODEL_NAME ?? "";
  const activePath = settings?.LOCAL_MODEL_PATH ?? "";

  const options = modelsQuery.data?.models ?? [];
  const current =
    mode === "remote" ? apiModel || chatModel || "" : activePath || chatModel || "";

  const selectMutation = useMutation({
    mutationFn: (opt: { type: "local" | "api"; value: string }) =>
      rpcClient.selectChatModel(opt),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["installed-models"] });
      queryClient.invalidateQueries({ queryKey: ["chat-models"] });
      queryClient.invalidateQueries({ queryKey: ["server-status"] });
    },
    onSettled: () => setPendingType(null),
  });

  const handleChange = (value: string) => {
    const option = options.find((o) => o.value === value);
    if (!option || option.value === current) return;
    setPendingType(option.type);
    selectMutation.mutate(option);
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

  const localOptions = options.filter((o) => o.type === "local" && matches(o));
  const apiOptions = options.filter((o) => o.type === "api" && matches(o));
  const firstMatch = localOptions[0] ?? apiOptions[0];
  const busy = selectMutation.isPending || modelsQuery.isLoading;
  const selectError =
    selectMutation.isError
      ? String(selectMutation.error)
      : !selectMutation.isPending && selectMutation.data && !selectMutation.data.ok
        ? (selectMutation.data.error ?? t("chat.modelSwitchFailed"))
        : null;

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
        <SelectTrigger size="sm" className="h-7 max-w-64 text-xs">
          <SelectValue placeholder={t("chat.modelEmpty")} />
        </SelectTrigger>
        <SelectContent className="max-w-80" position="popper" align="end" sideOffset={6}>
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
          {localOptions.length > 0 && (
            <SelectGroup>
              <SelectLabel>{t("chat.modelLocal")}</SelectLabel>
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
          {apiOptions.length > 0 && (
            <SelectGroup>
              <SelectLabel>{t("chat.modelApi")}</SelectLabel>
              {apiOptions.map((o) => (
                <SelectItem key={`api-${o.value}`} value={o.value}>
                  <span className="truncate">{o.label}</span>
                  {o.detail && (
                    <span className="truncate text-[10px] text-muted-foreground/70">
                      {o.detail}
                    </span>
                  )}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          {options.length === 0 && (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">
              {t("chat.modelEmpty")}
            </div>
          )}
          {options.length > 0 && !firstMatch && (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">
              {t("chat.modelNoMatch")}
            </div>
          )}
        </SelectContent>
      </Select>
      <Button
        variant="ghost"
        size="icon-sm"
        tooltip={t("chat.modelRefresh")}
        onClick={() => queryClient.invalidateQueries({ queryKey: ["chat-models"] })}
        disabled={modelsQuery.isFetching}
      >
        <RefreshCwIcon
          className={cn("size-3.5", modelsQuery.isFetching && "animate-spin")}
        />
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
            {pendingType === "local" ? t("chat.modelRestarting") : t("chat.modelSwitching")}
          </span>
        </span>
      )}
    </div>
  );
}
