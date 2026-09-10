import { useState, useEffect, useMemo, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ServerIcon,
  CpuIcon,
  GaugeIcon,
  BlocksIcon,
  ActivityIcon,
  InfoIcon,
  GlobeIcon,
  CheckIcon,
  XCircleIcon,
  ZapIcon,
  CopyIcon,
  Trash2Icon,
  HardDriveIcon,
  TerminalSquareIcon,
  PlusIcon,
  CloudIcon,
  XIcon,
  RefreshCwIcon,
  SearchIcon,
  BoxIcon,
  Link2Icon,
  WaypointsIcon,
  EyeIcon,
  EyeOffIcon,
  ChevronDownIcon,
  MinusIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Badge } from "@ui/badge";
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
import { ScrollArea } from "@ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { Spinner } from "@ui/spinner";
import { CLOUD_PROVIDERS } from "../setup-screen/constants";
import { useUILang } from "@stores/ui-lang";
import { useT } from "@stores/ui-lang";
import { LANGS, type UILang } from "@/shared/i18n";
import { cn } from "@/mainview/lib/utils";
import { ServerStatsScreen } from "../server-stats";
import { ServerLogsScreen } from "./server-logs";
import { ModelsScreen } from "../models-screen";
import { LocalModelsScreen } from "../local-models-screen";
import { MarketScreen } from "../market-screen";
import { GatewayScreen } from "../gateway-screen";

type SettingsFormState = Record<string, string>;

interface FieldDef {
  key: string;
  label: string;
  placeholder: string;
  description?: string;
  type?: "text" | "number" | "password";
}


const PERFORMANCE_FIELDS: FieldDef[] = [
  { key: "SERVER_CTX_SIZE", label: "Context Size", placeholder: "8192", type: "number" },
  {
    key: "SERVER_GPU_LAYERS",
    label: "GPU Layers",
    placeholder: "-1 (all)",
    description: "-1 = offload all layers to GPU",
    type: "number",
  },
  { key: "SERVER_PARALLEL", label: "Parallel Requests", placeholder: "1", type: "number" },
  { key: "SERVER_BATCH_SIZE", label: "Batch Size", placeholder: "256", type: "number" },
  { key: "SERVER_UBATCH_SIZE", label: "Micro Batch Size", placeholder: "64", type: "number" },
];

const GENERATION_FIELDS: FieldDef[] = [
  {
    key: "MAX_VLLM_RETRIES",
    label: "Max Retries",
    placeholder: "6",
    description: "Retry count for recoverable errors",
    type: "number",
  },
  {
    key: "MAX_VLLM_FAILURE_RETRIES",
    label: "Max Failure Retries",
    placeholder: "0",
    description: "Retry count for hard failures (0 = no retry)",
    type: "number",
  },
  {
    key: "PAGE_CONCURRENCY",
    label: "Page Concurrency",
    placeholder: "3",
    description: "Number of pages processed in parallel",
    type: "number",
  },
];

const CACHE_TYPES = ["q8_0", "q4_0", "q4_1", "f16"];

const LAUNCHER_TOOLS: { key: string; labelKey: string; tool: string }[] = [
  { key: "LAUNCHER_CODEX_MODEL", labelKey: "settings.integrations.codex", tool: "codex" },
  { key: "LAUNCHER_OPENCODE_MODEL", labelKey: "settings.integrations.opencode", tool: "opencode" },
  { key: "LAUNCHER_OPENCLAW_MODEL", labelKey: "settings.integrations.openclaw", tool: "openclaw" },
  { key: "LAUNCHER_HERMES_MODEL", labelKey: "settings.integrations.hermes", tool: "hermes" },
  { key: "LAUNCHER_PI_MODEL", labelKey: "settings.integrations.pi", tool: "pi" },
  { key: "LAUNCHER_COPILOT_MODEL", labelKey: "settings.integrations.copilot", tool: "copilot" },
];

const CLAUDE_TIERS = [
  { key: "LAUNCHER_CLAUDE_OPUS", labelKey: "settings.integrations.tier.opus" },
  { key: "LAUNCHER_CLAUDE_SONNET", labelKey: "settings.integrations.tier.sonnet" },
  { key: "LAUNCHER_CLAUDE_HAIKU", labelKey: "settings.integrations.tier.haiku" },
];

type SettingsTab =
  | "network"
  | "model"
  | "store"
  | "market"
  | "gateway"
  | "performance"
  | "integrations"
  | "benchmark"
  | "logs"
  | "stats"
  | "general"
  | "interface";

const TAB_DEFS: { key: SettingsTab; icon: ReactNode; labelKey: string }[] = [
  { key: "network", icon: <ServerIcon className="size-4" />, labelKey: "settings.server" },
  { key: "model", icon: <CpuIcon className="size-4" />, labelKey: "settings.model" },
  { key: "store", icon: <BoxIcon className="size-4" />, labelKey: "settings.store" },
  { key: "market", icon: <Link2Icon className="size-4" />, labelKey: "settings.market" },
  { key: "gateway", icon: <WaypointsIcon className="size-4" />, labelKey: "settings.gateway" },
  { key: "performance", icon: <GaugeIcon className="size-4" />, labelKey: "settings.performance" },
  { key: "integrations", icon: <BlocksIcon className="size-4" />, labelKey: "settings.integrations" },
  { key: "benchmark", icon: <ActivityIcon className="size-4" />, labelKey: "settings.benchmark" },
  { key: "logs", icon: <TerminalSquareIcon className="size-4" />, labelKey: "settings.logs" },
  { key: "stats", icon: <HardDriveIcon className="size-4" />, labelKey: "settings.stats" },
  { key: "general", icon: <InfoIcon className="size-4" />, labelKey: "settings.general" },
  { key: "interface", icon: <GlobeIcon className="size-4" />, labelKey: "settings.interface" },
];

function FieldGrid({
  fields,
  form,
  onUpdate,
}: {
  fields: FieldDef[];
  form: SettingsFormState;
  onUpdate: (key: string, value: string) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {fields.map((field) => (
        <div key={field.key}>
          <Label htmlFor={field.key} className="mb-1 text-xs">
            {field.label}
          </Label>
          <Input
            id={field.key}
            type={field.type === "password" ? "password" : "text"}
            inputMode={field.type === "number" ? "numeric" : undefined}
            placeholder={field.placeholder}
            value={form[field.key] ?? ""}
            onChange={(e) => onUpdate(field.key, e.target.value)}
            className="h-8 text-xs"
          />
          {field.description && (
            <p className="mt-1 text-[11px] text-muted-foreground">{field.description}</p>
          )}
        </div>
      ))}
    </div>
  );
}

function SaveRow({ mutation, hint }: { mutation: { mutate: () => void; isPending: boolean; isSuccess: boolean }; hint?: string }) {
  const t = useT();
  return (
    <div className="flex items-center gap-3 border-t pt-3">
      <Button size="sm" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
        {mutation.isPending ? (
          <Spinner data-icon="inline-start" />
        ) : mutation.isSuccess ? (
          <CheckIcon data-icon="inline-start" />
        ) : null}
        {mutation.isSuccess ? t("common.saved") : t("common.save")}
      </Button>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

interface SaveMutationLike {
  mutate: () => void;
  mutateAsync: () => Promise<unknown>;
  isPending: boolean;
  isSuccess: boolean;
  reset: () => void;
}

function inferBaseUrl(form: SettingsFormState): string {
  const isLocal = (form.SERVER_MODE ?? "local") === "local";
  if (isLocal) {
    return `http://${form.SERVER_HOST || "127.0.0.1"}:${form.SERVER_PORT || "8080"}`;
  }
  return (form.VLLM_API_BASE ?? "").replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** 云服务商的模型条目：id 必填，name/group/remark 可选（兼容旧版纯 id 列表）。 */
type CloudModelEntry = { id: string; name?: string; group?: string; remark?: string };

/** 用户通过「添加服务商」加入的自定义服务商（持久化在 CUSTOM_PROVIDERS）。 */
type CustomProvider = {
  id: string;
  label: string;
  vendor: string;
  baseUrl: string;
  models: string[];
  /** 简短备注（免费额度 / 需要额外操作等），兼容 REMOTE_PROVIDERS。 */
  note?: string;
};

function parseCloudModels(raw: string | undefined): CloudModelEntry[] {
  try {
    const arr: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x): CloudModelEntry | null => {
        if (typeof x === "string") return { id: x };
        if (x && typeof x === "object" && typeof (x as Record<string, unknown>).id === "string") {
          const o = x as Record<string, unknown>;
          return {
            id: o.id as string,
            name: typeof o.name === "string" ? o.name : undefined,
            group: typeof o.group === "string" ? o.group : undefined,
          };
        }
        return null;
      })
      .filter((x): x is CloudModelEntry => x !== null);
  } catch {
    return [];
  }
}

/** 「模型云服务」页的云服务商区块：左侧原厂厂商列表，右侧选中厂商的配置表单。 */
function CloudProviderPanel({
  form,
  updateField,
  testMutation,
  saveMutation,
}: {
  form: SettingsFormState;
  updateField: (key: string, value: string) => void;
  testMutation: {
    mutate: () => void;
    isPending: boolean;
    isSuccess: boolean;
    isError: boolean;
    data?: { connected: boolean };
  };
  saveMutation: SaveMutationLike;
}) {
  const isLocal = (form.SERVER_MODE ?? "local") === "local";
  const t = useT();
  const baseUrl = (form.VLLM_API_BASE ?? "").trim();
  const apiKey = form.VLLM_API_KEY ?? "";
  const modelName = (form.VLLM_MODEL_NAME ?? "").trim();

  // 自定义服务商（「添加服务商」加入，持久化在 CUSTOM_PROVIDERS）
  const customProviders = useMemo<CustomProvider[]>(() => {
    try {
      const arr: unknown = JSON.parse(form.CUSTOM_PROVIDERS ?? "[]");
      return Array.isArray(arr)
        ? arr.filter(
            (x): x is CustomProvider =>
              !!x &&
              typeof x === "object" &&
              typeof (x as Record<string, unknown>).id === "string" &&
              typeof (x as Record<string, unknown>).label === "string",
          )
        : [];
    } catch {
      return [];
    }
  }, [form.CUSTOM_PROVIDERS]);
  const setCustomProviders = (list: CustomProvider[]) =>
    updateField("CUSTOM_PROVIDERS", JSON.stringify(list));

  // 完整服务商列表 = 原厂厂商 + 自定义（旧版内置「自定义」占位项不展示）
  const allProviders = useMemo<CustomProvider[]>(
    () => [
      ...CLOUD_PROVIDERS.filter((p) => p.id !== "custom").map((p) => ({
        ...p,
        vendor: p.vendor,
      })),
      ...customProviders,
    ],
    [customProviders],
  );

  // 优先用保存的 CLOUD_PROVIDER；没有则按 Base URL 反查，避免换窗口后选中态丢失。
  const savedId = form.CLOUD_PROVIDER;
  const byUrl = allProviders.find((p) => p.baseUrl && p.baseUrl === baseUrl);
  const selected = allProviders.find((p) => p.id === savedId) ?? byUrl ?? null;
  const isCustom = !selected;

  const pickProvider = (id: string) => {
    const p = allProviders.find((x) => x.id === id);
    if (!p) return;
    updateField("CLOUD_PROVIDER", p.id);
    if (p.baseUrl) updateField("VLLM_API_BASE", p.baseUrl);
    if (p.models[0] && !modelName) updateField("VLLM_MODEL_NAME", p.models[0]);
    // 选中正式厂商即视为启用云服务
    if (p.baseUrl) updateField("SERVER_MODE", "remote");
  };

  // 添加服务商
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [npLabel, setNpLabel] = useState("");
  const [npBase, setNpBase] = useState("");
  const addProvider = () => {
    const label = npLabel.trim();
    if (!label) return;
    const entry: CustomProvider = {
      id: `custom-${Date.now()}`,
      label,
      vendor: "自定义",
      baseUrl: npBase.trim(),
      models: [],
    };
    setCustomProviders([...customProviders, entry]);
    updateField("CLOUD_PROVIDER", entry.id);
    if (entry.baseUrl) {
      updateField("VLLM_API_BASE", entry.baseUrl);
      updateField("SERVER_MODE", "remote");
    }
    setNpLabel("");
    setNpBase("");
    setShowAddProvider(false);
  };

  // 附加端点（「添加端点」加入，持久化在 CLOUD_ENDPOINTS）
  const extraEndpoints = useMemo<string[]>(() => {
    try {
      const arr: unknown = JSON.parse(form.CLOUD_ENDPOINTS ?? "[]");
      return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }, [form.CLOUD_ENDPOINTS]);
  const setExtraEndpoints = (list: string[]) =>
    updateField("CLOUD_ENDPOINTS", JSON.stringify(list));

  // 「获取密钥」入口：跳转服务商站点（取 API 地址的域名）
  const consoleUrl = (() => {
    try {
      return baseUrl ? new URL(baseUrl).origin : "";
    } catch {
      return "";
    }
  })();

  // 云服务商的模型列表（支持 id/name/group）
  const cloudModels = useMemo(() => parseCloudModels(form.CLOUD_MODELS), [form.CLOUD_MODELS]);
  const setCloudModels = (list: CloudModelEntry[]) =>
    updateField("CLOUD_MODELS", JSON.stringify(list));

  const syncMutation = useMutation({
    mutationFn: () => rpcClient.listRemoteModels({ baseUrl, apiKey: apiKey || undefined }),
    onSuccess: (data) => {
      if (!data.ok) return;
      const merged = new Map(cloudModels.map((m) => [m.id, m]));
      for (const id of data.models) if (!merged.has(id)) merged.set(id, { id });
      setCloudModels(Array.from(merged.values()));
    },
  });

  const queryClient = useQueryClient();
  const cloudEnabled = (form.SERVER_MODE ?? "local") === "remote";
  const toggleEnabledMutation = useMutation({
    mutationFn: async (on: boolean) => {
      updateField("SERVER_MODE", on ? "remote" : "local");
      await rpcClient.updateSettings({ settings: { SERVER_MODE: on ? "remote" : "local" } });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["connection-status"] });
    },
  });

  const [showKey, setShowKey] = useState(false);
  const [showAddModel, setShowAddModel] = useState(false);
  const [dlgId, setDlgId] = useState("");
  const [dlgName, setDlgName] = useState("");
  const [dlgGroup, setDlgGroup] = useState("");
  const [dlgRemark, setDlgRemark] = useState("");
  const [dlgMore, setDlgMore] = useState(false);
  const addModel = () => {
    const id = dlgId.trim();
    if (!id || cloudModels.some((m) => m.id === id)) return;
    setCloudModels([
      ...cloudModels,
      {
        id,
        name: dlgName.trim() || undefined,
        group: dlgGroup.trim() || undefined,
        remark: dlgRemark.trim() || undefined,
      },
    ]);
    setDlgId("");
    setDlgName("");
    setDlgGroup("");
    setDlgRemark("");
    setDlgMore(false);
  };
  const removeModel = (id: string) => setCloudModels(cloudModels.filter((m) => m.id !== id));

  // 左栏厂商搜索
  const [vendorSearch, setVendorSearch] = useState("");
  const vendorNeedle = vendorSearch.trim().toLowerCase();
  const filteredProviders = vendorNeedle
    ? allProviders.filter((p) =>
        `${p.label} ${p.vendor}`.toLowerCase().includes(vendorNeedle),
      )
    : allProviders;

  // 模型列表 = 已保存的云端模型 ∪ 厂商预设模型（点击行即设为当前模型，勾选标记当前项）
  const displayModels = useMemo(() => {
    const merged = new Map<string, CloudModelEntry>(cloudModels.map((m) => [m.id, m]));
    for (const id of selected?.models ?? []) if (!merged.has(id)) merged.set(id, { id });
    return Array.from(merged.values());
  }, [cloudModels, selected]);
  const removableIds = new Set(cloudModels.map((m) => m.id));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <CloudIcon className="size-5" />
            模型云服务
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            选择原厂厂商、填入 API Key 并保存后即可使用云端模型。仅提供官方接口，不含聚合/中介服务。
          </p>
        </div>
        {!isLocal && (
          <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            <CheckIcon className="size-3.5" /> 云服务已启用
          </span>
        )}
      </div>

      {/* 两栏：厂商源列表 / 配置详情 */}
      <div className="flex items-stretch gap-6">
        {/* 左栏：厂商列表（macOS 源列表风格，带搜索） */}
        <div className="flex w-64 shrink-0 flex-col gap-2.5">
          <div className="relative">
            <Label htmlFor="cloud-provider-search" className="sr-only">
              搜索厂商
            </Label>
            <Input
              id="cloud-provider-search"
              placeholder="搜索厂商"
              value={vendorSearch}
              onChange={(e) => setVendorSearch(e.target.value)}
              className="h-8 rounded-lg pl-8 text-xs"
            />
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 opacity-50" />
          </div>
          <div className="flex max-h-[560px] flex-col gap-0.5 overflow-y-auto rounded-xl bg-muted/40 p-1.5">
            {filteredProviders.map((p) => {
              const isCustomOpt = p.id === "custom";
              const active = isCustom ? isCustomOpt : selected?.id === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => pickProvider(p.id)}
                  className={cn(
                    "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                    active
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded-lg text-xs font-semibold",
                      active ? "bg-primary/15" : "bg-muted",
                    )}
                  >
                    {isCustomOpt ? <PlusIcon className="size-4" /> : p.label.charAt(0)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{p.label}</span>
                    {p.vendor && (
                      <span className="block truncate text-[11px] opacity-60">{p.vendor}</span>
                    )}
                  </span>
                  {p.id === savedId && (
                    <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
                  )}
                </button>
              );
            })}
            {filteredProviders.length === 0 && (
              <p className="py-6 text-center text-xs text-muted-foreground">无匹配厂商</p>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="w-full border-dashed"
            onClick={() => setShowAddProvider(true)}
          >
            <PlusIcon data-icon="inline-start" className="size-3.5" />
            添加服务商
          </Button>
        </div>

        {/* 右栏：选中服务商的详情（头部 + 连接配置分组卡片 / 模型列表卡片） */}
        <div className="flex min-w-0 flex-1 flex-col gap-5">
          {/* 头部：大图标 + 名称 + 厂商信息 + 启用开关 */}
          <div className="flex items-center gap-3.5">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted text-base font-semibold">
              {isCustom ? <PlusIcon className="size-5" /> : selected?.label.charAt(0)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-base font-semibold">
                {isCustom ? "自定义服务商" : selected?.label}
              </p>
              {(selected?.vendor || selected?.note) && (
                <p
                  className="truncate text-xs text-muted-foreground"
                  title={[selected?.vendor, selected?.note].filter(Boolean).join(" · ")}
                >
                  {[selected?.vendor, selected?.note].filter(Boolean).join(" · ")}
                </p>
              )}
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={cloudEnabled}
              disabled={toggleEnabledMutation.isPending}
              onClick={() => toggleEnabledMutation.mutate(!cloudEnabled)}
              className={cn(
                "ml-auto relative h-5 w-9 shrink-0 rounded-full transition-colors",
                cloudEnabled ? "bg-emerald-500" : "bg-muted-foreground/30",
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 size-4 rounded-full bg-white shadow transition-all",
                  cloudEnabled ? "left-[18px]" : "left-0.5",
                )}
              />
            </button>
          </div>

          {/* 连接配置：分组卡片（API 密钥 / API 地址 / 当前模型） */}
          <div className="divide-y rounded-xl border bg-card shadow-sm">
            {/* API 密钥 + 检测 */}
            <div className="px-4 py-3.5">
          <div className="flex items-end gap-3">
            <div className="min-w-0 flex-1">
              <Label className="mb-1 block text-xs">
                API 密钥
                {consoleUrl && (
                  <button
                    type="button"
                    className="ml-1.5 font-normal text-primary hover:underline"
                    onClick={() => void rpcClient.openGatewayDocs({ url: consoleUrl })}
                  >
                    获取密钥
                  </button>
                )}
              </Label>
              <div className="relative">
                <Input
                  type={showKey ? "text" : "password"}
                  placeholder="在服务商控制台获取"
                  value={apiKey}
                  onChange={(e) => updateField("VLLM_API_KEY", e.target.value)}
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
                    onClick={() => navigator.clipboard?.writeText(apiKey).catch(() => {})}
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
              onClick={() => testMutation.mutate()}
              disabled={testMutation.isPending || !baseUrl}
            >
              {testMutation.isPending ? <Spinner data-icon="inline-start" /> : null}
              检测
            </Button>
          </div>
          {(testMutation.isSuccess || testMutation.isError) && (
            <p
              className={cn(
                "mt-2 flex items-center gap-1.5 text-xs",
                testMutation.data?.connected
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-destructive",
              )}
            >
              {testMutation.data?.connected ? (
                <>
                  <CheckIcon className="size-3.5" /> 连接成功
                </>
              ) : (
                <>
                  <XCircleIcon className="size-3.5" /> 连接失败，请检查 API 地址 / 密钥
                </>
              )}
            </p>
          )}

            </div>

            {/* API 地址 + 添加端点 */}
            <div className="px-4 py-3.5">
            <div className="mb-1 flex items-center gap-1.5">
              <Label className="text-xs">
                API 地址
                {!isCustom && (
                  <span className="ml-1 font-normal text-muted-foreground">（自动带出）</span>
                )}
              </Label>
              <button
                type="button"
                className="text-xs text-primary hover:underline"
                onClick={() => setExtraEndpoints([...extraEndpoints, ""])}
              >
                添加端点
              </button>
            </div>
            {isCustom ? (
              <Input
                placeholder="https://api.example.com/v1"
                value={baseUrl}
                onChange={(e) => updateField("VLLM_API_BASE", e.target.value)}
                className="h-8 font-mono text-xs"
              />
            ) : (
              <div
                className="flex h-8 items-center rounded-md border bg-muted/40 px-3 font-mono text-xs text-muted-foreground"
                title={baseUrl || selected?.baseUrl}
              >
                <span className="truncate">{baseUrl || selected?.baseUrl}</span>
              </div>
            )}
            {extraEndpoints.map((ep, i) => (
              <div key={i} className="mt-1.5 flex items-center gap-2">
                <Input
                  value={ep}
                  placeholder="https://api.example.com/v1"
                  onChange={(e) => {
                    const next = [...extraEndpoints];
                    next[i] = e.target.value;
                    setExtraEndpoints(next);
                  }}
                  className="h-8 min-w-0 flex-1 font-mono text-xs"
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-muted-foreground"
                  onClick={() => setExtraEndpoints(extraEndpoints.filter((_, j) => j !== i))}
                >
                  <MinusIcon className="size-3" />
                </Button>
              </div>
            ))}
          </div>
          </div>

          {!isCustom && selected?.note && (
            <p className="rounded-lg bg-muted/60 px-3 py-2 text-[11px] text-muted-foreground">
              {selected.note}
            </p>
          )}

          {/* 模型列表：获取模型列表 + 新增 */}
          <div className="rounded-xl border bg-card shadow-sm">
            <div className="flex items-center gap-2 border-b px-4 py-2.5">
              <p className="text-[13px] font-medium">模型</p>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => syncMutation.mutate()}
                  disabled={syncMutation.isPending || !baseUrl}
                >
                  {syncMutation.isPending ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <ZapIcon data-icon="inline-start" />
                  )}
                  获取模型列表
                </Button>
                <Button
                  variant="outline"
                  size="icon-sm"
                  onClick={() => setShowAddModel(true)}
                  tooltip="添加模型"
                >
                  <PlusIcon className="size-3.5" />
                </Button>
              </div>
            </div>

            <div className="flex flex-col gap-2 p-3">
            {syncMutation.isSuccess && !syncMutation.data?.ok && (
              <p className="flex items-start gap-1 text-[11px] text-destructive">
                <XCircleIcon className="mt-0.5 size-3 shrink-0" />
                <span className="min-w-0 break-words">
                  获取失败：{syncMutation.data?.error}
                </span>
              </p>
            )}
            {syncMutation.isSuccess && syncMutation.data?.ok && (
              <p className="flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                <CheckIcon className="size-3" />
                已获取 {syncMutation.data.models.length} 个模型
              </p>
            )}

            {displayModels.length === 0 ? (
              <p className="rounded-md border border-dashed px-3 py-4 text-center text-[11px] text-muted-foreground">
                暂无模型，点「获取模型列表」拉取，或点「+」手动添加
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                {displayModels.map((entry) => {
                  return (
                    <div
                      key={entry.id}
                      title={entry.remark || entry.id}
                      className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 transition-colors hover:bg-muted/60"
                      onClick={() => updateField("VLLM_MODEL_NAME", entry.id)}
                    >
                      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground">
                        {entry.id.charAt(0).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs">
                        {entry.name || entry.id}
                      </span>
                      {entry.name && entry.name !== entry.id && (
                        <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
                          {entry.id}
                        </span>
                      )}
                      {entry.group && (
                        <span
                          title={entry.group}
                          className="flex size-4 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[8px] font-semibold text-primary"
                        >
                          {entry.group.charAt(0)}
                        </span>
                      )}
                      {modelName === entry.id && (
                        <CheckIcon className="size-3.5 shrink-0 text-primary" />
                      )}
                      {removableIds.has(entry.id) && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="h-5 w-5 shrink-0 text-muted-foreground"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeModel(entry.id);
                          }}
                        >
                          <MinusIcon className="size-3" />
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            </div>
          </div>
        </div>
      </div>

      {/* 操作行：保存靠右 */}
      <div className="flex items-center gap-3 border-t pt-3">
        {isLocal && (
          <p className="mr-auto text-[11px] text-muted-foreground">保存后将自动切换为云服务模式</p>
        )}
        <Button
          size="sm"
          className={cn(!isLocal && "ml-auto")}
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending}
        >
          {saveMutation.isPending ? (
            <Spinner data-icon="inline-start" />
          ) : saveMutation.isSuccess ? (
            <CheckIcon data-icon="inline-start" />
          ) : null}
          {saveMutation.isSuccess ? "已保存" : "保存"}
        </Button>
      </div>

      {/* 添加模型弹框 */}
      <Dialog open={showAddModel} onOpenChange={setShowAddModel}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>添加模型</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <Label htmlFor="dlg-model-id" className="w-20 shrink-0 text-xs">
                模型 ID <span className="text-destructive">*</span>
              </Label>
              <Input
                id="dlg-model-id"
                placeholder="例如 gpt-5.5"
                value={dlgId}
                onChange={(e) => setDlgId(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && dlgId.trim()) addModel();
                }}
                className="h-8 min-w-0 flex-1 text-xs"
              />
            </div>
            <div className="flex items-center gap-3">
              <Label htmlFor="dlg-model-name" className="w-20 shrink-0 text-xs">
                模型名称
              </Label>
              <Input
                id="dlg-model-name"
                placeholder="例如 GPT-5.5"
                value={dlgName}
                onChange={(e) => setDlgName(e.target.value)}
                className="h-8 min-w-0 flex-1 text-xs"
              />
            </div>
            <div className="flex items-center gap-3">
              <Label htmlFor="dlg-model-group" className="w-20 shrink-0 text-xs">
                分组名称
              </Label>
              <Input
                id="dlg-model-group"
                placeholder="例如 ChatGPT"
                value={dlgGroup}
                onChange={(e) => setDlgGroup(e.target.value)}
                className="h-8 min-w-0 flex-1 text-xs"
              />
            </div>
            {dlgMore && (
              <div className="flex items-center gap-3">
                <Label htmlFor="dlg-model-remark" className="w-20 shrink-0 text-xs">
                  备注
                </Label>
                <Input
                  id="dlg-model-remark"
                  placeholder="备注说明"
                  value={dlgRemark}
                  onChange={(e) => setDlgRemark(e.target.value)}
                  className="h-8 min-w-0 flex-1 text-xs"
                />
              </div>
            )}
            <button
              type="button"
              onClick={() => setDlgMore((v) => !v)}
              className="flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              更多设置
              <ChevronDownIcon className={cn("size-3.5 transition-transform", dlgMore && "rotate-180")} />
            </button>
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowAddModel(false)}>
              取消
            </Button>
            <Button size="sm" onClick={addModel} disabled={!dlgId.trim()}>
              添加模型
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 添加服务商弹框 */}
      <Dialog open={showAddProvider} onOpenChange={setShowAddProvider}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>添加服务商</DialogTitle>
            <DialogDescription>
              填写服务商名称与 OpenAI 兼容 API 地址，保存后出现在左侧列表。
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <Label htmlFor="np-label" className="w-20 shrink-0 text-xs">
                名称 <span className="text-destructive">*</span>
              </Label>
              <Input
                id="np-label"
                placeholder="例如 我的代理商"
                value={npLabel}
                onChange={(e) => setNpLabel(e.target.value)}
                className="h-8 min-w-0 flex-1 text-xs"
              />
            </div>
            <div className="flex items-center gap-3">
              <Label htmlFor="np-base" className="w-20 shrink-0 text-xs">
                API 地址
              </Label>
              <Input
                id="np-base"
                placeholder="https://api.example.com/v1"
                value={npBase}
                onChange={(e) => setNpBase(e.target.value)}
                className="h-8 min-w-0 flex-1 font-mono text-xs"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowAddProvider(false)}>
              取消
            </Button>
            <Button size="sm" onClick={addProvider} disabled={!npLabel.trim()}>
              添加服务商
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PerformanceSettings({
  form,
  updateField,
  saveMutation,
}: {
  form: SettingsFormState;
  updateField: (key: string, value: string) => void;
  saveMutation: SaveMutationLike;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <GaugeIcon className="size-4" />
          {t("settings.scheduler.title")}
        </h3>
        <p className="mb-2 text-[11px] text-muted-foreground">{t("settings.scheduler.desc")}</p>
        <FieldGrid fields={PERFORMANCE_FIELDS} form={form} onUpdate={updateField} />
      </div>

      <div>
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <HardDriveIcon className="size-4" />
          {t("settings.cache.title")}
        </h3>
        <p className="mb-2 text-[11px] text-muted-foreground">{t("settings.cache.desc")}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {(["SERVER_CACHE_TYPE_K", "SERVER_CACHE_TYPE_V"] as const).map((key) => (
            <div key={key}>
              <Label htmlFor={key} className="mb-1 text-xs">{key === "SERVER_CACHE_TYPE_K" ? "Cache Type K" : "Cache Type V"}</Label>
              <Select value={form[key] ?? "q8_0"} onValueChange={(v) => updateField(key, v)}>
                <SelectTrigger id={key} className="h-8 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CACHE_TYPES.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-medium">{t("settings.generation")}</h3>
        <p className="mb-2 text-[11px] text-muted-foreground">{t("settings.generation.desc")}</p>
        <FieldGrid fields={GENERATION_FIELDS} form={form} onUpdate={updateField} />
      </div>

      <SaveRow mutation={saveMutation} hint={t("settings.restartHint")} />
    </div>
  );
}

function launcherCommand(tool: string, baseUrl: string, model: string): string {
  if (!model) return "";
  if (tool === "claude") {
    return `ANTHROPIC_BASE_URL=${baseUrl} ANTHROPIC_MODEL=${model} ANTHROPIC_API_KEY=EMPTY claude`;
  }
  if (tool === "codex" || tool === "opencode" || tool === "openclaw" || tool === "copilot") {
    return `OPENAI_BASE_URL=${baseUrl}/v1 OPENAI_API_KEY=EMPTY OPENAI_MODEL=${model} ${tool}`;
  }
  return `${tool} --model ${model} --base-url ${baseUrl}/v1`;
}

function IntegrationsSettings({
  form,
  updateField,
  saveMutation,
}: {
  form: SettingsFormState;
  updateField: (key: string, value: string) => void;
  saveMutation: SaveMutationLike;
}) {
  const t = useT();
  const baseUrl = inferBaseUrl(form);
  const mode = form.LAUNCHER_CLAUDE_MODE ?? "local";
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(launcherCommand("claude", baseUrl, form.LAUNCHER_CLAUDE_SONNET || ""));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="mb-3 text-xs text-muted-foreground">{t("settings.integrations.desc")}</p>
        <h3 className="mb-2 text-sm font-medium">{t("settings.integrations.claude")}</h3>
        <div className="mb-2 flex gap-2">
          <Label className="mb-1 block text-xs">{t("settings.integrations.mode")}</Label>
          <div className="flex gap-2">
            {(["local", "cloud"] as const).map((m) => (
              <Button
                key={m}
                type="button"
                variant={mode === m ? "default" : "outline"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => updateField("LAUNCHER_CLAUDE_MODE", m)}
              >
                {m === "local" ? t("settings.integrations.mode.local") : t("settings.integrations.mode.cloud")}
              </Button>
            ))}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {CLAUDE_TIERS.map((tier) => (
            <div key={tier.key}>
              <Label htmlFor={tier.key} className="mb-1 text-xs">{t(tier.labelKey)}</Label>
              <Input
                id={tier.key}
                placeholder={mode === "local" ? "local model name" : "e.g. claude-sonnet-4-20250514"}
                value={form[tier.key] ?? ""}
                onChange={(e) => updateField(tier.key, e.target.value)}
                className="h-8 text-xs"
              />
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2 rounded-lg border px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] text-muted-foreground">{t("settings.integrations.command")}</p>
            <p className="truncate font-mono text-xs tabular-nums">
              {launcherCommand("claude", baseUrl, form.LAUNCHER_CLAUDE_SONNET || "") || "—"}
            </p>
          </div>
          <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 text-xs" onClick={copy} disabled={!form.LAUNCHER_CLAUDE_SONNET}>
            {copied ? <CheckIcon className="size-3.5 text-primary" /> : <CopyIcon className="size-3.5" />}
            {copied ? t("settings.endpoints.copied") : t("settings.endpoints.copy")}
          </Button>
        </div>
      </div>

      {LAUNCHER_TOOLS.map((tool) => (
        <div key={tool.key}>
          <div className="mb-2 flex items-baseline justify-between">
            <h3 className="text-sm font-medium">{t(tool.labelKey)}</h3>
            <Label htmlFor={tool.key} className="text-[11px] text-muted-foreground">{t("settings.integrations.model")}</Label>
          </div>
          <Input
            id={tool.key}
            placeholder={mode === "local" ? "local model name" : "e.g. gpt-4o"}
            value={form[tool.key] ?? ""}
            onChange={(e) => updateField(tool.key, e.target.value)}
            className="mb-2 h-8 text-xs"
          />
          <p className="truncate rounded-lg bg-muted px-3 py-2 font-mono text-[11px] text-muted-foreground">
            {launcherCommand(tool.tool, baseUrl, form[tool.key] || "") || "—"}
          </p>
        </div>
      ))}

      <SaveRow mutation={saveMutation} />
    </div>
  );
}

const BENCHMARK_PRESET_CONTEXTS = [1024, 4096, 8192, 16384, 32768];

function BenchmarkSettings({ form }: { form: SettingsFormState }) {
  const t = useT();
  const [model, setModel] = useState("");
  const [genLength, setGenLength] = useState(128);
  const [batchSize, setBatchSize] = useState(1);
  const [contexts, setContexts] = useState<number[]>(BENCHMARK_PRESET_CONTEXTS);

  const { data: installed } = useQuery({
    queryKey: ["installed-models"],
    queryFn: () => rpcClient.listInstalledModels(),
  });

  const runMutation = useMutation({
    mutationFn: () =>
      rpcClient.runBenchmark({
        model: model || (form.CHAT_MODEL ?? "") || "local",
        genLength,
        batchSize,
        contexts,
      }),
  });

  const toggleContext = (c: number) => {
    setContexts((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c].sort((a, b) => a - b)));
  };

  const models = installed?.models ?? [];
  const modelOptions = Array.from(new Set(models.map((m) => m.fileName.replace(/\.gguf$/i, "")))).filter(Boolean);
  const effectiveModel = model || (form.CHAT_MODEL ?? "") || modelOptions[0] || "";

  const rows = runMutation.data?.rows ?? [];
  const maxTps = Math.max(...rows.map((r) => r.tps), 0.0001);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="mb-3 text-xs text-muted-foreground">{t("settings.benchmark.desc")}</p>
        <div className="flex flex-col gap-3">
          <div>
            <Label htmlFor="benchModel" className="mb-1 text-xs">{t("settings.benchmark.model")}</Label>
            <Input
              id="benchModel"
              placeholder={modelOptions[0] ?? "model name"}
              value={effectiveModel}
              onChange={(e) => setModel(e.target.value)}
              className="h-8 text-xs"
            />
            {modelOptions.length > 0 && (
              <p className="mt-1 flex flex-wrap gap-1">
                {modelOptions.slice(0, 8).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setModel(m)}
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[10px] transition-colors",
                      effectiveModel === m
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {m}
                  </button>
                ))}
              </p>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="benchGen" className="mb-1 text-xs">{t("settings.benchmark.genLength")}</Label>
              <Input
                id="benchGen"
                type="text"
                inputMode="numeric"
                value={String(genLength)}
                onChange={(e) => setGenLength(parseInt(e.target.value || "0", 10) || 16)}
                className="h-8 text-xs"
              />
            </div>
            <div>
              <Label htmlFor="benchBatch" className="mb-1 text-xs">{t("settings.benchmark.batchSize")}</Label>
              <Input
                id="benchBatch"
                type="text"
                inputMode="numeric"
                value={String(batchSize)}
                onChange={(e) => setBatchSize(parseInt(e.target.value || "0", 10) || 1)}
                className="h-8 text-xs"
              />
            </div>
          </div>
          <div>
            <Label className="mb-1 block text-xs">{t("settings.benchmark.contexts")}</Label>
            <div className="flex flex-wrap gap-1.5">
              {BENCHMARK_PRESET_CONTEXTS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => toggleContext(c)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs transition-colors",
                    contexts.includes(c)
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
                  )}
                >
                  {c >= 1000 ? `${(c / 1000).toFixed(c % 1000 === 0 ? 0 : 1)}k` : c}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={() => runMutation.mutate()} disabled={runMutation.isPending || contexts.length === 0}>
              {runMutation.isPending ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <ActivityIcon data-icon="inline-start" />
              )}
              {runMutation.isPending
                ? t("settings.benchmark.running")
                : runMutation.isSuccess
                  ? t("settings.benchmark.runDone")
                  : t("settings.benchmark.run")}
            </Button>
            {runMutation.isError && (
              <span className="flex items-center gap-1.5 text-xs text-destructive">
                <XCircleIcon className="size-3.5" /> {String(runMutation.error)}
              </span>
            )}
          </div>
        </div>
      </div>

      {runMutation.data?.error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
          {runMutation.data.error}
        </div>
      )}

      <div>
        <h3 className="mb-2 text-sm font-medium">{t("settings.benchmark.results")}</h3>
        {rows.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">
            {t("settings.benchmark.noResults")}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-2 py-1.5 font-medium">{t("settings.benchmark.col.context")}</th>
                  <th className="px-2 py-1.5 font-medium">{t("settings.benchmark.col.batch")}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t("settings.benchmark.col.ttft")}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t("settings.benchmark.col.tpot")}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t("settings.benchmark.col.tps")}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t("settings.benchmark.col.tokens")}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t("settings.benchmark.col.total")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.contextLength} className="border-b border-muted/50">
                    <td className="px-2 py-1.5 tabular-nums">
                      {r.contextLength >= 1000 ? `${(r.contextLength / 1000).toFixed(0)}k` : r.contextLength}
                    </td>
                    <td className="px-2 py-1.5 tabular-nums">{r.batchSize}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{r.ttftMs}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{r.tpotMs}</td>
                    <td className="px-2 py-1.5 text-right font-semibold tabular-nums text-primary">{r.tps}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{r.tokens}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{r.totalMs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-3 flex flex-col gap-1.5">
              {rows.map((r) => (
                <div key={r.contextLength} className="flex items-center gap-2">
                  <span className="w-10 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
                    {r.contextLength >= 1000 ? `${(r.contextLength / 1000).toFixed(0)}k` : r.contextLength}
                  </span>
                  <div className="h-2.5 flex-1 rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary/70"
                      style={{ width: `${(r.tps / maxTps) * 100}%` }}
                    />
                  </div>
                  <span className="w-14 shrink-0 font-mono text-[10px] tabular-nums">{r.tps} tps</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function GeneralSettings({ form, updateField, saveMutation }: { form: SettingsFormState; updateField: (key: string, value: string) => void; saveMutation: SaveMutationLike }) {
  const t = useT();
  const queryClient = useQueryClient();

  const { data: about } = useQuery({
    queryKey: ["about-info"],
    queryFn: () => rpcClient.getAboutInfo(),
  });

  const clearLogsMutation = useMutation({
    mutationFn: () => rpcClient.clearServerLogs(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["server-status"] }),
  });

  const uptimeSeconds = about?.sessionStartedAt ? Math.floor(Date.now() / 1000 - about.sessionStartedAt / 1000) : 0;
  const uptime = (() => {
    const h = Math.floor(uptimeSeconds / 3600);
    const m = Math.floor((uptimeSeconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  })();

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="mb-2 text-sm font-medium">{t("settings.updateChannel.title")}</h3>
        <p className="mb-2 text-[11px] text-muted-foreground">{t("settings.updateChannel.desc")}</p>
        <Select
          value={form.UPDATE_CHANNEL ?? "stable"}
          onValueChange={(v) => updateField("UPDATE_CHANNEL", v)}
        >
          <SelectTrigger className="h-8 w-full text-xs sm:w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="stable">{t("settings.updateChannel.stable")}</SelectItem>
            <SelectItem value="beta">{t("settings.updateChannel.beta")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div>
        <h3 className="mb-1 text-sm font-medium">{t("settings.webSearch.title")}</h3>
        <p className="mb-2 text-[11px] text-muted-foreground">{t("settings.webSearch.desc")}</p>

        <label className="mb-3 flex cursor-pointer items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={form.WEB_SEARCH_ENABLED === "1"}
            onChange={(e) => updateField("WEB_SEARCH_ENABLED", e.target.checked ? "1" : "0")}
            className="size-3.5 accent-[var(--primary)]"
          />
          {t("settings.webSearch.defaultEnabled")}
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label className="mb-1 text-xs">{t("settings.webSearch.provider")}</Label>
            <Select
              value={form.WEB_SEARCH_PROVIDER ?? "bing"}
              onValueChange={(v) => updateField("WEB_SEARCH_PROVIDER", v)}
            >
              <SelectTrigger className="h-8 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="bing">{t("settings.webSearch.bing")}</SelectItem>
                <SelectItem value="duckduckgo">{t("settings.webSearch.duckduckgo")}</SelectItem>
                <SelectItem value="tavily">{t("settings.webSearch.tavily")}</SelectItem>
                <SelectItem value="brave">{t("settings.webSearch.brave")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="WEB_SEARCH_MAX_RESULTS" className="mb-1 text-xs">
              {t("settings.webSearch.maxResults")}
            </Label>
            <Input
              id="WEB_SEARCH_MAX_RESULTS"
              type="text"
              inputMode="numeric"
              placeholder="5"
              value={form.WEB_SEARCH_MAX_RESULTS ?? ""}
              onChange={(e) => updateField("WEB_SEARCH_MAX_RESULTS", e.target.value)}
              className="h-8 text-xs"
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="WEB_SEARCH_API_KEY" className="mb-1 text-xs">
              {t("settings.webSearch.apiKey")}
            </Label>
            <Input
              id="WEB_SEARCH_API_KEY"
              type="password"
              placeholder="tvly-…"
              value={form.WEB_SEARCH_API_KEY ?? ""}
              onChange={(e) => updateField("WEB_SEARCH_API_KEY", e.target.value)}
              className="h-8 text-xs"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t("settings.webSearch.apiKeyHint")}
            </p>
          </div>
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-medium">{t("settings.about.title")}</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border px-3 py-2">
            <p className="text-[11px] text-muted-foreground">{t("settings.about.version")}</p>
            <p className="font-mono text-xs">{about?.version ?? "—"}</p>
          </div>
          <div className="rounded-lg border px-3 py-2">
            <p className="text-[11px] text-muted-foreground">{t("settings.updateChannel.title")}</p>
            <p className="text-xs">{about?.channel === "beta" ? t("settings.updateChannel.beta") : t("settings.updateChannel.stable")}</p>
          </div>
          <div className="rounded-lg border px-3 py-2">
            <p className="text-[11px] text-muted-foreground">{t("settings.about.uptime")}</p>
            <p className="font-mono text-xs tabular-nums">{uptime}</p>
          </div>
          <div className="rounded-lg border px-3 py-2">
            <p className="text-[11px] text-muted-foreground">{t("settings.about.basePath")}</p>
            <p className="truncate font-mono text-xs">{about?.basePath ?? "—"}</p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => clearLogsMutation.mutate()}
          disabled={clearLogsMutation.isPending}
        >
          <Trash2Icon data-icon="inline-start" />
          {t("settings.about.clearLogs")}
        </Button>
      </div>

      <SaveRow mutation={saveMutation} />
    </div>
  );
}

function InterfaceSettings() {
  const t = useT();
  const lang = useUILang((s) => s.lang);
  const setLang = useUILang((s) => s.setLang);
  const queryClient = useQueryClient();

  const saveMutation = useMutation({
    mutationFn: (newLang: UILang) => rpcClient.updateSettings({ settings: { UI_LANG: newLang } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="mb-1 text-sm font-medium">{t("settings.interface")}</h3>
        <p className="text-xs text-muted-foreground">{t("settings.interface.languageDesc")}</p>
      </div>
      <div>
        <Label className="mb-1 text-xs">{t("settings.interface.language")}</Label>
        <div className="flex gap-2">
          {LANGS.map((l: { value: UILang; label: string }) => (
            <Button
              key={l.value}
              variant={lang === l.value ? "default" : "outline"}
              size="sm"
              className="h-8 min-w-[72px]"
              onClick={() => {
                setLang(l.value);
                saveMutation.mutate(l.value);
              }}
              disabled={saveMutation.isPending && lang !== l.value}
            >
              {l.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function SettingsScreen() {
  const t = useT();
  const [activeTab, setActiveTab] = useState<SettingsTab>("network");
  const [form, setForm] = useState<SettingsFormState>({});
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });

  useEffect(() => {
    if (data?.settings) {
      const s = { ...data.settings };
      if (s.VLLM_API_KEY === "EMPTY") s.VLLM_API_KEY = "";
      setForm(s);
    }
  }, [data]);

  const NETWORK_KEYS = [
    "SERVER_MODE",
    "CLOUD_PROVIDER",
    "VLLM_API_BASE",
    "VLLM_API_KEY",
    "VLLM_MODEL_NAME",
    "CLOUD_MODELS",
    "CUSTOM_PROVIDERS",
    "CLOUD_ENDPOINTS",
  ];
  const PERFORMANCE_KEYS = [
    ...PERFORMANCE_FIELDS.map((f) => f.key),
    "SERVER_CACHE_TYPE_K",
    "SERVER_CACHE_TYPE_V",
    ...GENERATION_FIELDS.map((f) => f.key),
  ];
  const INTEGRATION_KEYS = [
    "LAUNCHER_CLAUDE_MODE",
    ...CLAUDE_TIERS.map((c) => c.key),
    ...LAUNCHER_TOOLS.map((x) => x.key),
  ];
  const GENERAL_KEYS = [
    "UPDATE_CHANNEL",
    "WEB_SEARCH_ENABLED",
    "WEB_SEARCH_PROVIDER",
    "WEB_SEARCH_API_KEY",
    "WEB_SEARCH_MAX_RESULTS",
  ];

  const pickKeys = (keys: string[]) => {
    const out: Record<string, string> = {};
    for (const k of keys) if (form[k] !== undefined) out[k] = form[k];
    return out;
  };

  const useTabSave = (keys: string[], opts?: { invalidateConnection?: boolean }) =>
    useMutation({
      mutationFn: () => {
        const settings = pickKeys(keys);
        if (!settings.VLLM_API_KEY) settings.VLLM_API_KEY = "EMPTY";
        return rpcClient.updateSettings({ settings });
      },
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["settings"] });
        queryClient.invalidateQueries({ queryKey: ["model-dirs"] });
        if (opts?.invalidateConnection) {
          queryClient.invalidateQueries({ queryKey: ["connection-status"] });
        }
      },
    });

  // 模型云服务页：保存即切换为云服务（remote）模式
  const saveCloud = useMutation({
    mutationFn: () => {
      const settings = pickKeys(NETWORK_KEYS);
      if (!settings.VLLM_API_KEY) settings.VLLM_API_KEY = "EMPTY";
      settings.SERVER_MODE = "remote";
      return rpcClient.updateSettings({ settings });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["connection-status"] });
    },
  });
  const savePerformance = useTabSave(PERFORMANCE_KEYS, { invalidateConnection: true });
  const saveIntegrations = useTabSave(INTEGRATION_KEYS);
  const saveGeneral = useTabSave(GENERAL_KEYS);

  const testMutation = useMutation({
    mutationFn: () =>
      rpcClient.checkConnection({
        baseUrl: form.VLLM_API_BASE ?? "",
        apiKey: form.VLLM_API_KEY || "EMPTY",
      }),
  });

  const updateField = (key: string, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="flex min-h-0 flex-1">
      {/* Left category nav */}
      <div className="flex w-44 shrink-0 flex-col gap-1 overflow-y-auto border-r p-3">
        <span className="mb-1 px-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          {t("settings.category.title")}
        </span>
        {TAB_DEFS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              "flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs transition-colors",
              activeTab === tab.key
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {tab.icon}
            <span className="truncate">{t(tab.labelKey)}</span>
          </button>
        ))}
      </div>

      {/* Right content */}
      {activeTab === "model" ? (
        <div className="min-w-0 flex-1">
          <LocalModelsScreen />
        </div>
      ) : activeTab === "store" ? (
        <div className="min-w-0 flex-1">
          <ModelsScreen />
        </div>
      ) : activeTab === "market" ? (
        <div className="min-w-0 flex-1">
          <MarketScreen />
        </div>
      ) : activeTab === "gateway" ? (
        <div className="min-w-0 flex-1">
          <GatewayScreen />
        </div>
      ) : activeTab === "stats" ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ServerStatsScreen />
        </div>
      ) : activeTab === "logs" ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ServerLogsScreen />
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          {/* 模型云服务是三栏布局，放宽内容宽度 */}
          <div
            className={cn(
              "mx-auto w-full px-6 py-6",
              activeTab === "network" ? "max-w-5xl" : "max-w-2xl",
            )}
          >
            {activeTab !== "network" && (
              <div className="mb-6">
                <h2 className="text-lg font-semibold tracking-tight">{t("settings.title")}</h2>
                <p className="text-xs text-muted-foreground">{t("settings.subtitle")}</p>
              </div>
            )}

            {activeTab === "network" && (
              <CloudProviderPanel
                form={form}
                updateField={updateField}
                testMutation={testMutation}
                saveMutation={saveCloud}
              />
            )}

            {activeTab === "performance" && (
              <PerformanceSettings form={form} updateField={updateField} saveMutation={savePerformance} />
            )}

            {activeTab === "integrations" && (
              <IntegrationsSettings form={form} updateField={updateField} saveMutation={saveIntegrations} />
            )}

            {activeTab === "benchmark" && <BenchmarkSettings form={form} />}

            {activeTab === "general" && (
              <GeneralSettings form={form} updateField={updateField} saveMutation={saveGeneral} />
            )}

            {activeTab === "interface" && <InterfaceSettings />}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}