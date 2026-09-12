import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckIcon,
  ChevronDownIcon,
  CloudIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  PlusIcon,
  SearchIcon,
  StarIcon,
  Trash2Icon,
  XCircleIcon,
  ZapIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ui/dialog";
import { Spinner } from "@ui/spinner";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import {
  CLOUD_PRESETS,
  providerColor,
  type CloudProviderInfo,
} from "@/shared/cloud-providers";
import { PROVIDER_LOGOS, MONO_LOGO_PATHS } from "./provider-logos";

/**
 * 「模型云服务」面板：严格三栏布局（左设置导航由 SettingsScreen 提供）——
 * 中栏服务商源列表（搜索 + 启用开关 + 模型数 + 添加），右栏选中服务商的
 * 连接配置（API 密钥 / API 地址）与模型管理表格。
 * 所有操作即时落库（cloud_providers 表），激活行同步写回 VLLM_* 槽位。
 */

/**
 * 服务商品牌 Logo：位图 Logo（官网/GitHub 头像）→ 品牌色底单色图形
 * （Simple Icons）→ 品牌色字母徽章（OmniLabs / 自定义）三级回退。
 */
function ProviderLogo({
  provider,
  size = "md",
}: {
  provider: Pick<CloudProviderInfo, "id" | "name">;
  size?: "md" | "lg";
}) {
  const isCustom = provider.id.startsWith("custom-");
  const color = providerColor(provider.id, provider.name, isCustom);
  const img = PROVIDER_LOGOS[provider.id];
  const mono = MONO_LOGO_PATHS[provider.id];
  const box = size === "lg" ? "size-11 rounded-xl" : "size-8 rounded-lg";

  if (mono) {
    return (
      <span
        className={cn("flex shrink-0 items-center justify-center text-white", box)}
        style={{ backgroundColor: color }}
      >
        <svg viewBox="0 0 24 24" className="size-[62%] fill-current" aria-hidden>
          <path d={mono} />
        </svg>
      </span>
    );
  }
  if (img) {
    return (
      <span className={cn("flex shrink-0 items-center justify-center overflow-hidden bg-muted/60", box)}>
        <img src={img} alt="" draggable={false} className="size-full object-contain" />
      </span>
    );
  }
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center font-semibold text-white",
        size === "lg" ? "size-11 text-base rounded-xl" : "size-8 text-xs rounded-lg",
      )}
      style={{ backgroundColor: color }}
    >
      {provider.name.charAt(0).toUpperCase()}
    </span>
  );
}

/** 行内开关（启用该服务商）。无 radix 依赖的轻量实现。 */
function Toggle({
  checked,
  disabled,
  onChange,
  title,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50",
        checked ? "bg-emerald-500" : "bg-muted-foreground/30",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 size-4 rounded-full bg-white shadow transition-all",
          checked ? "left-[18px]" : "left-0.5",
        )}
      />
    </button>
  );
}

export function CloudProviderPanel() {
  const t = useT();
  const queryClient = useQueryClient();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [vendorSearch, setVendorSearch] = useState("");
  const [showAddProvider, setShowAddProvider] = useState(false);

  const providersQuery = useQuery({
    queryKey: ["cloud-providers"],
    queryFn: () => rpcClient.cloudProviderList(undefined),
  });
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });

  const providers = providersQuery.data?.providers ?? [];
  const activeId = providersQuery.data?.activeId ?? null;
  const remoteMode = (settingsQuery.data?.settings.SERVER_MODE ?? "local") === "remote";
  const cloudActive = !!activeId && remoteMode;
  const currentModel = (settingsQuery.data?.settings.VLLM_MODEL_NAME ?? "").trim();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["cloud-providers"] });
    queryClient.invalidateQueries({ queryKey: ["settings"] });
    queryClient.invalidateQueries({ queryKey: ["connection-status"] });
    queryClient.invalidateQueries({ queryKey: ["chat-models"] });
  };

  // 默认选中激活行（或第一行）
  useEffect(() => {
    if (providers.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !providers.some((p) => p.id === selectedId)) {
      setSelectedId(activeId ?? providers[0]!.id);
    }
  }, [providers, activeId, selectedId]);

  const selected = providers.find((p) => p.id === selectedId) ?? null;
  const isSelectedActive = !!selected && selected.id === activeId && remoteMode;

  // ------------------------------------------------------------------
  // 中栏：服务商列表
  // ------------------------------------------------------------------
  const vendorNeedle = vendorSearch.trim().toLowerCase();
  const filteredProviders = vendorNeedle
    ? providers.filter((p) => `${p.name} ${p.vendor}`.toLowerCase().includes(vendorNeedle))
    : providers;

  const activateMutation = useMutation({
    mutationFn: (on: boolean) =>
      on && selectedId
        ? rpcClient.cloudProviderActivate({ id: selectedId })
        : rpcClient.cloudProviderDeactivate(undefined),
    onSuccess: invalidate,
  });

  // ------------------------------------------------------------------
  // 右栏：连接配置（草稿态，失焦保存）
  // ------------------------------------------------------------------
  const [draftBase, setDraftBase] = useState("");
  const [draftKey, setDraftKey] = useState("");
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    setDraftBase(selected?.baseUrl ?? "");
    setDraftKey(selected?.apiKey ?? "");
    setShowKey(false);
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveMutation = useMutation({
    mutationFn: (patch: { baseUrl?: string; apiKey?: string }) => {
      if (!selected) return Promise.resolve({ ok: false });
      return rpcClient.cloudProviderUpdate({ id: selected.id, ...patch });
    },
    onSuccess: invalidate,
  });

  const commitBase = () => {
    if (!selected) return;
    if (draftBase.trim() !== selected.baseUrl) saveMutation.mutate({ baseUrl: draftBase });
  };
  const commitKey = () => {
    if (!selected) return;
    if (draftKey.trim() !== selected.apiKey) saveMutation.mutate({ apiKey: draftKey });
  };

  const checkMutation = useMutation({
    mutationFn: () =>
      rpcClient.checkConnection({
        baseUrl: draftBase.trim(),
        apiKey: draftKey.trim() || "EMPTY",
      }),
  });

  const consoleUrl = (() => {
    try {
      return draftBase.trim() ? new URL(draftBase.trim()).origin : "";
    } catch {
      return "";
    }
  })();

  // ------------------------------------------------------------------
  // 模型管理：获取 / 添加 / 删除 / 设为默认
  // ------------------------------------------------------------------
  const [modelSearch, setModelSearch] = useState("");
  const models = selected?.models ?? [];
  const modelNeedle = modelSearch.trim().toLowerCase();
  const filteredModels = useMemo(
    () =>
      modelNeedle
        ? models.filter((m) =>
            `${m.id} ${m.name ?? ""} ${m.group ?? ""}`.toLowerCase().includes(modelNeedle),
          )
        : models,
    [models, modelNeedle],
  );

  const fetchModelsMutation = useMutation({
    mutationFn: async () => {
      if (!selected) return { ok: false, models: [] as string[] };
      const res = await rpcClient.listRemoteModels({
        baseUrl: draftBase.trim(),
        apiKey: draftKey.trim() || "EMPTY",
      });
      if (!res.ok) return res;
      // 合并：保留已有条目的 name/group/remark，新增的只带 id
      const merged = new Map(models.map((m) => [m.id, m]));
      for (const id of res.models) if (!merged.has(id)) merged.set(id, { id });
      await rpcClient.cloudProviderUpdate({
        id: selected.id,
        models: Array.from(merged.values()),
      });
      return res;
    },
    onSuccess: invalidate,
  });

  const [showAddModel, setShowAddModel] = useState(false);
  const [dlgId, setDlgId] = useState("");
  const [dlgName, setDlgName] = useState("");
  const [dlgGroup, setDlgGroup] = useState("");
  const [dlgRemark, setDlgRemark] = useState("");
  const [dlgMore, setDlgMore] = useState(false);

  const addModelMutation = useMutation({
    mutationFn: async () => {
      if (!selected) return { ok: false };
      const id = dlgId.trim();
      if (!id || models.some((m) => m.id === id)) return { ok: false };
      await rpcClient.cloudProviderUpdate({
        id: selected.id,
        models: [
          ...models,
          {
            id,
            name: dlgName.trim() || undefined,
            group: dlgGroup.trim() || undefined,
            remark: dlgRemark.trim() || undefined,
          },
        ],
      });
    },
    onSuccess: () => {
      setDlgId("");
      setDlgName("");
      setDlgGroup("");
      setDlgRemark("");
      setDlgMore(false);
      setShowAddModel(false);
      invalidate();
    },
  });

  const removeModelMutation = useMutation({
    mutationFn: async (modelId: string) => {
      if (!selected) return;
      await rpcClient.cloudProviderUpdate({
        id: selected.id,
        models: models.filter((m) => m.id !== modelId),
      });
    },
    onSuccess: invalidate,
  });

  // 设为默认模型：selectChatModel("api", id) 同步 VLLM_MODEL_NAME + CHAT_MODEL + remote
  const setDefaultMutation = useMutation({
    mutationFn: (modelId: string) => rpcClient.selectChatModel({ type: "api", value: modelId }),
    onSuccess: invalidate,
  });

  // ------------------------------------------------------------------
  // 删除服务商（二次确认）
  // ------------------------------------------------------------------
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteMutation = useMutation({
    mutationFn: (id: string) => rpcClient.cloudProviderDelete({ id }),
    onSuccess: () => {
      setConfirmDelete(false);
      setSelectedId(null);
      invalidate();
    },
  });

  return (
    <div className="flex flex-col gap-5">
      {/* 页头 */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <CloudIcon className="size-5" />
            {t("cloud.title")}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">{t("cloud.desc")}</p>
        </div>
        {cloudActive && (
          <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            <CheckIcon className="size-3.5" /> {t("cloud.using")}
          </span>
        )}
      </div>

      {/* 两栏：服务商列表 / 详情 */}
      <div className="flex items-stretch gap-6">
        {/* 中栏：服务商列表（搜索 + 开关 + 模型数 + 添加） */}
        <div className="flex w-72 shrink-0 flex-col gap-2.5">
          <div className="relative">
            <Label htmlFor="cloud-provider-search" className="sr-only">
              {t("common.search")}
            </Label>
            <Input
              id="cloud-provider-search"
              placeholder={t("cloud.search")}
              value={vendorSearch}
              onChange={(e) => setVendorSearch(e.target.value)}
              className="h-8 rounded-lg pl-8 text-xs"
            />
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 opacity-50" />
          </div>
          <div className="flex max-h-[560px] flex-col gap-0.5 overflow-y-auto rounded-xl bg-muted/40 p-1.5">
            {filteredProviders.map((p) => {
              const isActive = p.id === activeId && remoteMode;
              const isSelected = p.id === selectedId;
              return (
                <div
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedId(p.id)}
                  onKeyDown={(e) => e.key === "Enter" && setSelectedId(p.id)}
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                    isSelected
                      ? "bg-primary/10 text-primary"
                      : "text-foreground hover:bg-muted",
                  )}
                >
                  <ProviderLogo provider={p} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{p.name}</span>
                    {p.vendor && (
                      <span className="block truncate text-[11px] opacity-60">{p.vendor}</span>
                    )}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                    {p.models.length}
                  </span>
                  <Toggle
                    checked={isActive}
                    disabled={activateMutation.isPending}
                    title={t("cloud.toggleTitle")}
                    onChange={() => {
                      setSelectedId(p.id);
                      activateMutation.mutate(!isActive);
                    }}
                  />
                </div>
              );
            })}
            {filteredProviders.length === 0 && (
              <p className="py-6 text-center text-xs text-muted-foreground">{t("cloud.noProviders")}</p>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="w-full border-dashed"
            onClick={() => setShowAddProvider(true)}
          >
            <PlusIcon data-icon="inline-start" className="size-3.5" />
            {t("cloud.add")}
          </Button>
        </div>

        {/* 右栏：选中服务商详情 */}
        <div className="flex min-w-0 flex-1 flex-col gap-5">
          {!selected ? (
            <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed">
              <div className="text-center">
                <CloudIcon className="mx-auto mb-2 size-8 text-muted-foreground/40" />
                <p className="text-sm font-medium">{t("cloud.noProvider")}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t("cloud.noProviderDesc")}</p>
              </div>
            </div>
          ) : (
            <>
              {/* 详情头部：徽章 + 名称 + 厂商/备注 + 删除 */}
              <div className="flex items-center gap-3.5">
                <ProviderLogo provider={selected} size="lg" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base font-semibold">{selected.name}</p>
                  {selected.vendor && (
                    <p className="truncate text-xs text-muted-foreground" title={selected.vendor}>
                      {selected.vendor}
                    </p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  tooltip={t("cloud.delete")}
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2Icon className="size-4" />
                </Button>
              </div>

              {/* 连接配置卡片：API 密钥 / API 地址 */}
              <div className="divide-y rounded-xl border bg-card shadow-sm">
                <div className="px-4 py-3.5">
                  <div className="flex items-end gap-3">
                    <div className="min-w-0 flex-1">
                      <Label className="mb-1 block text-xs">
                        {t("cloud.apiKey")}
                        {consoleUrl && (
                          <button
                            type="button"
                            className="ml-1.5 font-normal text-primary hover:underline"
                            onClick={() => void rpcClient.openGatewayDocs({ url: consoleUrl })}
                          >
                            {t("cloud.getKey")}
                          </button>
                        )}
                      </Label>
                      <div className="relative">
                        <Input
                          type={showKey ? "text" : "password"}
                          placeholder={t("cloud.apiKeyPh")}
                          value={draftKey}
                          onChange={(e) => setDraftKey(e.target.value)}
                          onBlur={commitKey}
                          className="h-8 pr-14 font-mono text-xs"
                        />
                        <div className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setShowKey((v) => !v)}
                            className="text-muted-foreground transition-colors hover:text-foreground"
                          >
                            {showKey ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
                          </button>
                          <button
                            type="button"
                            onClick={() => navigator.clipboard?.writeText(draftKey).catch(() => {})}
                            className="text-muted-foreground transition-colors hover:text-foreground"
                          >
                            <CopyIcon className="size-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 shrink-0"
                      onClick={() => checkMutation.mutate()}
                      disabled={checkMutation.isPending || !draftBase.trim()}
                    >
                      {checkMutation.isPending ? <Spinner data-icon="inline-start" /> : null}
                      {t("cloud.check")}
                    </Button>
                  </div>
                  {(checkMutation.isSuccess || checkMutation.isError) && (
                    <p
                      className={cn(
                        "mt-2 flex items-center gap-1.5 text-xs",
                        checkMutation.data?.connected
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-destructive",
                      )}
                    >
                      {checkMutation.data?.connected ? (
                        <>
                          <CheckIcon className="size-3.5" /> {t("cloud.checkOk")}
                        </>
                      ) : (
                        <>
                          <XCircleIcon className="size-3.5" /> {t("cloud.checkFail")}
                        </>
                      )}
                    </p>
                  )}
                </div>

                <div className="px-4 py-3.5">
                  <Label className="mb-1 block text-xs">{t("cloud.apiBase")}</Label>
                  <Input
                    placeholder={t("cloud.apiBasePh")}
                    value={draftBase}
                    onChange={(e) => setDraftBase(e.target.value)}
                    onBlur={commitBase}
                    className="h-8 font-mono text-xs"
                  />
                  {isSelectedActive && (
                    <p className="mt-1.5 text-[11px] text-muted-foreground">{t("cloud.activeHint")}</p>
                  )}
                </div>
              </div>

              {/* 模型管理卡片：工具栏 + 表格 */}
              <div className="rounded-xl border bg-card shadow-sm">
                <div className="flex items-center gap-2 border-b px-4 py-2.5">
                  <p className="text-[13px] font-medium">{t("cloud.models")}</p>
                  <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                    {models.length}
                  </span>
                  <div className="ml-auto flex items-center gap-2">
                    <div className="relative">
                      <Input
                        placeholder={t("cloud.modelSearch")}
                        value={modelSearch}
                        onChange={(e) => setModelSearch(e.target.value)}
                        className="h-7 w-36 rounded-lg pl-7 text-xs"
                      />
                      <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 opacity-50" />
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => fetchModelsMutation.mutate()}
                      disabled={fetchModelsMutation.isPending || !draftBase.trim()}
                    >
                      {fetchModelsMutation.isPending ? (
                        <Spinner data-icon="inline-start" />
                      ) : (
                        <ZapIcon data-icon="inline-start" />
                      )}
                      {t("cloud.fetchModels")}
                    </Button>
                    <Button
                      variant="outline"
                      size="icon-sm"
                      onClick={() => setShowAddModel(true)}
                      tooltip={t("cloud.addModel")}
                    >
                      <PlusIcon className="size-3.5" />
                    </Button>
                  </div>
                </div>

                <div className="flex flex-col gap-2 p-3">
                  {fetchModelsMutation.isSuccess && !fetchModelsMutation.data?.ok && (
                    <p className="flex items-start gap-1 text-[11px] text-destructive">
                      <XCircleIcon className="mt-0.5 size-3 shrink-0" />
                      <span className="min-w-0 break-words">
                        {t("cloud.fetchFailed")}：{fetchModelsMutation.data?.error}
                      </span>
                    </p>
                  )}
                  {fetchModelsMutation.isSuccess && fetchModelsMutation.data?.ok && (
                    <p className="flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                      <CheckIcon className="size-3" />
                      {t("cloud.fetchedPrefix")} {fetchModelsMutation.data.models.length}{" "}
                      {t("cloud.modelsUnit")}
                    </p>
                  )}

                  {models.length === 0 ? (
                    <p className="rounded-md border border-dashed px-3 py-4 text-center text-[11px] text-muted-foreground">
                      {t("cloud.noModels")}
                    </p>
                  ) : (
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b text-left text-muted-foreground">
                          <th className="px-2 py-1.5 font-medium">{t("cloud.colModel")}</th>
                          <th className="px-2 py-1.5 font-medium">{t("cloud.colGroup")}</th>
                          <th className="px-2 py-1.5 font-medium">{t("cloud.colStatus")}</th>
                          <th className="px-2 py-1.5 text-right font-medium">{t("cloud.colActions")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredModels.map((entry) => {
                          const isDefault = cloudActive && entry.id === currentModel;
                          return (
                            <tr key={entry.id} className="border-b border-muted/50 last:border-0">
                              <td className="max-w-0 px-2 py-1.5" title={entry.remark || entry.id}>
                                <span className="block truncate">
                                  {entry.name || entry.id}
                                  {entry.name && entry.name !== entry.id && (
                                    <span className="ml-1.5 font-mono text-[10px] text-muted-foreground/60">
                                      {entry.id}
                                    </span>
                                  )}
                                </span>
                              </td>
                              <td className="px-2 py-1.5">
                                {entry.group ? (
                                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                                    {entry.group}
                                  </span>
                                ) : (
                                  <span className="text-muted-foreground/50">—</span>
                                )}
                              </td>
                              <td className="px-2 py-1.5">
                                {isDefault ? (
                                  <span className="flex w-fit items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                                    <StarIcon className="size-3" /> {t("cloud.default")}
                                  </span>
                                ) : (
                                  <span className="text-muted-foreground/50">—</span>
                                )}
                              </td>
                              <td className="px-2 py-1.5">
                                <div className="flex items-center justify-end gap-0.5">
                                  {!isDefault && (
                                    <Button
                                      variant="ghost"
                                      size="icon-sm"
                                      className="h-6 w-6 text-muted-foreground"
                                      tooltip={t("cloud.setDefault")}
                                      disabled={setDefaultMutation.isPending}
                                      onClick={() => setDefaultMutation.mutate(entry.id)}
                                    >
                                      <StarIcon className="size-3.5" />
                                    </Button>
                                  )}
                                  <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    className="h-6 w-6 text-muted-foreground hover:text-destructive"
                                    tooltip={t("cloud.removeModel")}
                                    disabled={removeModelMutation.isPending}
                                    onClick={() => removeModelMutation.mutate(entry.id)}
                                  >
                                    <Trash2Icon className="size-3.5" />
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                        {filteredModels.length === 0 && (
                          <tr>
                            <td colSpan={4} className="px-2 py-4 text-center text-muted-foreground">
                              {t("cloud.noModelMatch")}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 添加模型弹框 */}
      <Dialog open={showAddModel} onOpenChange={setShowAddModel}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("cloud.addModel")}</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            {(
              [
                ["dlg-model-id", t("cloud.modelId"), "例如 gpt-5.5", dlgId, setDlgId, true],
                ["dlg-model-name", t("cloud.modelName"), "例如 GPT-5.5", dlgName, setDlgName],
                ["dlg-model-group", t("cloud.modelGroup"), "例如 ChatGPT", dlgGroup, setDlgGroup],
                ["dlg-model-remark", t("cloud.modelRemark"), t("cloud.modelRemarkPh"), dlgRemark, setDlgRemark],
              ] as const
            ).map(([id, label, ph, value, setValue, required], idx) => (
              <div key={id} className={cn("flex items-center gap-3", idx === 3 && !dlgMore && "hidden")}>
                <Label htmlFor={id} className="w-20 shrink-0 text-xs">
                  {label}
                  {required && <span className="text-destructive"> *</span>}
                </Label>
                <Input
                  id={id}
                  placeholder={ph}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && dlgId.trim()) addModelMutation.mutate();
                  }}
                  className="h-8 min-w-0 flex-1 text-xs"
                />
              </div>
            ))}
            <button
              type="button"
              onClick={() => setDlgMore((v) => !v)}
              className="flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              {t("cloud.moreSettings")}
              <ChevronDownIcon className={cn("size-3.5 transition-transform", dlgMore && "rotate-180")} />
            </button>
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowAddModel(false)}>
              {t("common.cancel")}
            </Button>
            <Button size="sm" onClick={() => addModelMutation.mutate()} disabled={!dlgId.trim() || addModelMutation.isPending}>
              {addModelMutation.isPending ? <Spinner data-icon="inline-start" /> : null}
              {t("cloud.addModel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除服务商确认 */}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("cloud.deleteTitle")}</DialogTitle>
            <DialogDescription>
              {t("cloud.deleteDesc")}
              {selected?.id === activeId ? ` ${t("cloud.deleteActiveHint")}` : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmDelete(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={deleteMutation.isPending}
              onClick={() => selected && deleteMutation.mutate(selected.id)}
            >
              {deleteMutation.isPending ? <Spinner data-icon="inline-start" /> : null}
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 添加服务商弹窗 */}
      <AddProviderDialog
        open={showAddProvider}
        onOpenChange={setShowAddProvider}
        existingIds={new Set(providers.map((p) => p.id))}
        onAdded={(id) => {
          setSelectedId(id);
          invalidate();
        }}
      />
    </div>
  );
}

/**
 * 添加服务商弹窗：预设厂商网格（搜索 + 品牌徽章，已添加的置灰），
 * 「自定义」卡片进入第二步表单（名称 + API 地址）。
 */
function AddProviderDialog({
  open,
  onOpenChange,
  existingIds,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  existingIds: Set<string>;
  onAdded: (id: string) => void;
}) {
  const t = useT();
  const [search, setSearch] = useState("");
  const [customStep, setCustomStep] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customBase, setCustomBase] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setSearch("");
      setCustomStep(false);
      setCustomName("");
      setCustomBase("");
      setError("");
    }
  }, [open]);

  const createMutation = useMutation({
    mutationFn: (params: { presetId?: string; name?: string; baseUrl?: string }) =>
      rpcClient.cloudProviderCreate(params),
    onSuccess: (res) => {
      if (!res.ok || !res.id) {
        setError(res.error ?? "");
        return;
      }
      onOpenChange(false);
      onAdded(res.id);
    },
    onError: (e) => setError(String(e)),
  });

  const needle = search.trim().toLowerCase();
  const presets = needle
    ? CLOUD_PRESETS.filter((p) => `${p.name} ${p.vendor}`.toLowerCase().includes(needle))
    : CLOUD_PRESETS;

  const submitCustom = () => {
    const name = customName.trim();
    if (!name) return;
    createMutation.mutate({ name, baseUrl: customBase.trim() });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {customStep ? t("cloud.custom") : t("cloud.add")}
          </DialogTitle>
          {!customStep && <DialogDescription>{t("cloud.addDesc")}</DialogDescription>}
        </DialogHeader>

        {customStep ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <Label htmlFor="np-label" className="w-20 shrink-0 text-xs">
                {t("cloud.name")} <span className="text-destructive">*</span>
              </Label>
              <Input
                id="np-label"
                placeholder={t("cloud.namePh")}
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && customName.trim()) submitCustom();
                }}
                autoFocus
                className="h-8 min-w-0 flex-1 text-xs"
              />
            </div>
            <div className="flex items-center gap-3">
              <Label htmlFor="np-base" className="w-20 shrink-0 text-xs">
                {t("cloud.apiBase")}
              </Label>
              <Input
                id="np-base"
                placeholder={t("cloud.apiBasePh")}
                value={customBase}
                onChange={(e) => setCustomBase(e.target.value)}
                className="h-8 min-w-0 flex-1 font-mono text-xs"
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="relative">
              <Input
                placeholder={t("cloud.search")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 rounded-lg pl-8 text-xs"
              />
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 opacity-50" />
            </div>
            <div className="grid max-h-[440px] grid-cols-2 gap-2 overflow-y-auto">
              {presets.map((p) => {
                const added = existingIds.has(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    disabled={added}
                    title={[p.name, p.vendor, p.note].filter(Boolean).join(" · ")}
                    onClick={() => createMutation.mutate({ presetId: p.id })}
                    className={cn(
                      "flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors",
                      added
                        ? "cursor-not-allowed opacity-50"
                        : "hover:border-primary/40 hover:bg-muted/60",
                    )}
                  >
                    <ProviderLogo provider={{ id: p.id, name: p.name }} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">{p.name}</span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {added ? t("cloud.added") : p.vendor}
                      </span>
                    </span>
                  </button>
                );
              })}
              {/* 自定义入口：进入第二步表单 */}
              <button
                type="button"
                onClick={() => setCustomStep(true)}
                className="flex items-center gap-2.5 rounded-xl border border-dashed px-3 py-2.5 text-left transition-colors hover:border-primary/40 hover:bg-muted/60"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <PlusIcon className="size-4 text-muted-foreground" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{t("cloud.custom")}</span>
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {t("cloud.customHint")}
                  </span>
                </span>
              </button>
              {presets.length === 0 && (
                <p className="col-span-2 py-6 text-center text-xs text-muted-foreground">
                  {t("cloud.noProviders")}
                </p>
              )}
            </div>
          </div>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          {customStep && (
            <Button variant="ghost" size="sm" onClick={() => setCustomStep(false)}>
              {t("common.back")}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          {customStep && (
            <Button
              size="sm"
              onClick={submitCustom}
              disabled={!customName.trim() || createMutation.isPending}
            >
              {createMutation.isPending ? <Spinner data-icon="inline-start" /> : null}
              {t("cloud.add")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
