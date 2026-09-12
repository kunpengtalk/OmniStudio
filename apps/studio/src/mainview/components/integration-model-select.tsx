import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { rpcClient } from "@lib/rpc";
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

type ModelLike = {
  type: "local" | "api";
  label: string;
  detail?: string;
};

/**
 * 集成页用的「模型名」选择器：本地已装模型（服务名 slug）+ 云端/API 模型 ID +
 * 设置里配置的云端模型（CLOUD_MODELS）。选中后把模型名写入 LAUNCHER_*_MODEL。
 * 与对话的 ModelPicker 不同：这里存的是发给服务器的模型名，不是文件路径。
 */
export function IntegrationModelSelect({
  value,
  onChange,
  placeholder,
  mode,
}: {
  value: string;
  onChange: (modelName: string) => void;
  placeholder?: string;
  /** 模式过滤：local 只给本地模型，cloud 只给云端/API 模型；缺省不过滤。 */
  mode?: "local" | "cloud";
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const chatModels = useQuery({
    queryKey: ["chat-models"],
    queryFn: () => rpcClient.listChatModels(undefined),
  });
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });

  // 本地：label 即服务名 slug；API：label 即模型 ID —— 都是工具要发的模型名。
  const options: ModelLike[] = (chatModels.data?.models ?? []).map((m) => ({
    type: m.type,
    label: m.label,
    detail: m.detail,
  }));

  // 设置里显式配置的云端模型（CLOUD_MODELS）也纳入可选项。
  try {
    const raw = settingsQuery.data?.settings?.CLOUD_MODELS ?? "";
    const parsed: { id?: unknown }[] = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      for (const m of parsed) {
        if (typeof m?.id === "string" && m.id && !options.some((o) => o.label === m.id)) {
          options.push({ type: "api", label: m.id, detail: t("settings.integrations.cloudModel") });
        }
      }
    }
  } catch {
    // 忽略解析失败，仅用 listChatModels 的选项
  }

  const keyword = query.trim().toLowerCase();
  const matches = (o: ModelLike) =>
    !keyword ||
    o.label.toLowerCase().includes(keyword) ||
    (o.detail ?? "").toLowerCase().includes(keyword);

  const localOptions = options.filter((o) => o.type === "local" && matches(o));
  const apiOptions = options.filter((o) => o.type === "api" && matches(o));
  // 按模式过滤：本地模式只展示本地模型，云端模式只展示云端/API 模型。
  const shownLocal = mode !== "cloud" ? localOptions : [];
  const shownApi = mode !== "local" ? apiOptions : [];
  const shownList = mode === "local" ? localOptions : mode === "cloud" ? apiOptions : options;
  const known = shownList.some((o) => o.label === value);
  // 当前值不在可选列表里（手填过的旧值）也展示出来，避免选择器看起来是空的。
  const valueToShow = value || undefined;
  const closeAndReset = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };

  return (
    <Select
      value={valueToShow}
      open={open}
      onOpenChange={closeAndReset}
      onValueChange={(v) => {
        onChange(v);
        closeAndReset(false);
      }}
    >
      <SelectTrigger size="sm" className="h-8 w-full text-xs">
        <SelectValue placeholder={placeholder ?? t("settings.integrations.selectModel")} />
      </SelectTrigger>
      <SelectContent position="popper" sideOffset={6} className="w-[28rem] max-w-[min(28rem,90vw)]">
        <div
          className="sticky top-0 z-10 bg-popover p-1.5 pb-1"
          onKeyDown={(e) => e.stopPropagation()}
        >
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                closeAndReset(false);
              }
            }}
            placeholder={t("chat.modelSearch")}
            autoFocus
            className="h-7 text-xs"
          />
        </div>
        {/* 当前值不在可选列表里（手填过的旧值）也展示出来，避免选择器看起来是空的 */}
        {value && !known && (
          <SelectGroup>
            <SelectItem value={value}>
              <span className="truncate">{value}</span>
              <span className="truncate text-[10px] text-muted-foreground/70">
                {t("settings.integrations.currentValue")}
              </span>
            </SelectItem>
          </SelectGroup>
        )}
        {shownLocal.length > 0 && (
          <SelectGroup>
            <SelectLabel>{t("chat.modelLocal")}</SelectLabel>
            {shownLocal.map((o) => (
              <SelectItem key={`local-${o.label}`} value={o.label}>
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.detail && (
                  <span className="max-w-40 shrink-0 truncate text-[10px] text-muted-foreground/70">
                    {o.detail}
                  </span>
                )}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
        {shownApi.length > 0 && (
          <SelectGroup>
            <SelectLabel>{t("chat.modelApi")}</SelectLabel>
            {shownApi.map((o) => (
              <SelectItem key={`api-${o.label}`} value={o.label}>
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.detail && (
                  <span className="max-w-40 shrink-0 truncate text-[10px] text-muted-foreground/70">
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
        {options.length > 0 && shownLocal.length === 0 && shownApi.length === 0 && (
          <div className="px-2 py-3 text-center text-xs text-muted-foreground">
            {t("chat.modelNoMatch")}
          </div>
        )}
      </SelectContent>
    </Select>
  );
}
