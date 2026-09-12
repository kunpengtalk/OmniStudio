import { useState, useEffect, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ServerIcon,
  CpuIcon,
  GaugeIcon,
  BlocksIcon,
  GlobeIcon,
  CheckIcon,
  XCircleIcon,
  CopyIcon,
  HardDriveIcon,
  TerminalSquareIcon,
  TerminalIcon,
  LayoutDashboardIcon,
  StarIcon,
  BoxIcon,
  Link2Icon,
  WaypointsIcon,
  GithubIcon,
  PlugIcon,
  SlidersHorizontalIcon,
  PaletteIcon,
  BrainIcon,
  ArchiveIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import { IntegrationModelSelect } from "@/mainview/components/integration-model-select";
import { ScrollArea } from "@ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { Spinner } from "@ui/spinner";
import { CloudProviderPanel } from "./cloud-provider-panel";
import { DefaultModelsPanel } from "./default-models-panel";
import { AboutTab } from "./about-tab";
import { WebSearchTab } from "./web-search-tab";
import { McpTab } from "./mcp-tab";
import { MemoryTab } from "./memory-tab";
import { GeneralPrefsTab, AppearanceTab } from "./prefs-tabs";
import { CliTab } from "./cli-tab";
import { BackupTab } from "./backup-tab";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import { DashboardScreen } from "../dashboard-screen";
import { ServerLogsScreen } from "./server-logs";
import { ModelDetailScreen } from "../model-detail";
import { ModelsScreen } from "../models-screen";
import { LocalModelsScreen } from "../local-models-screen";
import { MarketScreen } from "../market-screen";
import { GatewayScreen } from "../gateway-screen";
import { useModelDetailStore, type ModelDetailSource } from "@stores/model-detail";
import { useRouter } from "@stores/router";

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
  { key: "LAUNCHER_CHATGPT_MODEL", labelKey: "settings.integrations.chatgpt", tool: "chatgpt" },
];

const CLAUDE_TIERS = [
  { key: "LAUNCHER_CLAUDE_OPUS", labelKey: "settings.integrations.tier.opus", omiFlag: "opus" },
  { key: "LAUNCHER_CLAUDE_SONNET", labelKey: "settings.integrations.tier.sonnet" },
  { key: "LAUNCHER_CLAUDE_HAIKU", labelKey: "settings.integrations.tier.haiku", omiFlag: "haiku" },
];

type SettingsTab =
  | "network"
  | "defaults"
  | "model"
  | "store"
  | "market"
  | "gateway"
  | "performance"
  | "integrations"
  | "logs"
  | "stats"
  | "websearch"
  | "memory"
  | "mcp"
  | "cli"
  | "backup"
  | "general"
  | "appearance"
  | "about";

const TAB_DEFS: Record<SettingsTab, { icon: ReactNode; labelKey: string }> = {
  network: { icon: <ServerIcon className="size-4" />, labelKey: "settings.server" },
  defaults: { icon: <StarIcon className="size-4" />, labelKey: "settings.defaults" },
  model: { icon: <CpuIcon className="size-4" />, labelKey: "settings.model" },
  store: { icon: <BoxIcon className="size-4" />, labelKey: "settings.store" },
  market: { icon: <Link2Icon className="size-4" />, labelKey: "settings.market" },
  gateway: { icon: <WaypointsIcon className="size-4" />, labelKey: "settings.gateway" },
  performance: { icon: <GaugeIcon className="size-4" />, labelKey: "settings.performance" },
  integrations: { icon: <BlocksIcon className="size-4" />, labelKey: "settings.integrations" },
  logs: { icon: <TerminalSquareIcon className="size-4" />, labelKey: "settings.logs" },
  stats: { icon: <LayoutDashboardIcon className="size-4" />, labelKey: "settings.dashboard" },
  websearch: { icon: <GlobeIcon className="size-4" />, labelKey: "settings.webSearch.title" },
  memory: { icon: <BrainIcon className="size-4" />, labelKey: "settings.memory.title" },
  mcp: { icon: <PlugIcon className="size-4" />, labelKey: "settings.mcp.title" },
  cli: { icon: <TerminalIcon className="size-4" />, labelKey: "settings.cli.title" },
  backup: { icon: <ArchiveIcon className="size-4" />, labelKey: "settings.backup.title" },
  general: { icon: <SlidersHorizontalIcon className="size-4" />, labelKey: "settings.prefs.general" },
  appearance: { icon: <PaletteIcon className="size-4" />, labelKey: "settings.appearance" },
  about: { icon: <GithubIcon className="size-4" />, labelKey: "settings.aboutTab.title" },
};

/** 设置导航分组（参照主流客户端的设置页：分组标题 + 条目）。概览置顶且无分组标题。 */
const TAB_GROUPS: { labelKey?: string; tabs: SettingsTab[] }[] = [
  { tabs: ["stats"] },
  {
    labelKey: "settings.group.models",
    tabs: ["network", "defaults", "model", "store", "market"],
  },
  {
    labelKey: "settings.group.services",
    tabs: ["gateway", "integrations", "performance"],
  },
  { labelKey: "settings.group.tools", tabs: ["websearch", "memory", "mcp", "cli"] },
  { labelKey: "settings.group.prefs", tabs: ["general", "appearance", "about"] },
  { labelKey: "settings.group.data", tabs: ["logs", "backup"] },
];

/** 自带头部（PageHeader / 宽版面板）的页面不再重复显示通用标题。 */
const SELF_HEADED_TABS: SettingsTab[] = [
  "network",
  "defaults",
  "about",
  "websearch",
  "memory",
  "mcp",
  "cli",
  "backup",
  "general",
  "appearance",
];

/** 命令 / 代码片段较宽，命令行页与云服务、默认模型一样放宽内容宽度。 */
const WIDE_TABS: SettingsTab[] = ["network", "defaults", "cli"];

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

/**
 * 与 `omi` CLI 对应的启动命令：URL / API Key 都存在设置里，点保存后命令保持最短。
 * Claude Code 的三个档位合成一条命令：默认模型走 --model，Opus / Haiku 走 --opus / --haiku。
 */
function buildOmiCommand(
  tool: string,
  slots: { key: string; value: string; omiFlag?: string }[],
): string {
  const main = slots.find((s) => s.value && !s.omiFlag) ?? slots.find((s) => s.value);
  if (!main?.value) return "";
  let cmd = `omi launch ${tool} --model ${main.value}`;
  for (const s of slots) {
    if (s.omiFlag && s.value && s.value !== main.value) cmd += ` --${s.omiFlag} ${s.value}`;
  }
  return cmd;
}

/** 集成 Agent 卡片：Agent 名 + 模型档位（Claude 三档 / 其他单档）+ 一条 omi 启动命令 + 复制。 */
function IntegrationAgentCard({
  label,
  tool,
  mode,
  modelSlots,
  onModelChange,
}: {
  label: string;
  tool: string;
  mode?: "local" | "cloud";
  modelSlots: { key: string; label: string; value: string; omiFlag?: string }[];
  onModelChange: (key: string, value: string) => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  const omiCmd = buildOmiCommand(tool, modelSlots);

  return (
    <div className="rounded-lg border p-3">
      <h3 className="mb-2 text-sm font-medium">{label}</h3>
      <div className="mb-2 flex flex-wrap items-end gap-2">
        {modelSlots.map((slot) => (
          <div key={slot.key} className="w-52">
            {modelSlots.length > 1 && (
              <Label className="mb-1 block text-[10px] text-muted-foreground">{slot.label}</Label>
            )}
            <IntegrationModelSelect
              value={slot.value}
              onChange={(v) => onModelChange(slot.key, v)}
              placeholder={`${t("settings.integrations.model")}…`}
              mode={mode}
            />
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 rounded-md bg-muted px-3 py-1.5">
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {t("settings.integrations.command")}
        </span>
        <code className="min-w-0 flex-1 truncate font-mono text-[11px] tabular-nums">
          {omiCmd || "—"}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="h-6 w-6 shrink-0"
          disabled={!omiCmd}
          onClick={() => copy(omiCmd)}
        >
          {copied ? <CheckIcon className="size-3.5 text-primary" /> : <CopyIcon className="size-3.5" />}
        </Button>
      </div>
    </div>
  );
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
  const mode: "local" | "cloud" =
    (form.LAUNCHER_CLAUDE_MODE as "local" | "cloud" | undefined) ?? "local";

  // MODEL_KEYS 是全部 Agent 的模型档位字段；切换本地/云端时清空已选模型，
  // 避免旧模式的模型名串到新模式导致启动报错。
  const MODEL_KEYS = [
    ...CLAUDE_TIERS.map((c) => c.key),
    ...LAUNCHER_TOOLS.map((x) => x.key),
  ];
  const setMode = (m: "local" | "cloud") => {
    if (m === mode) return;
    updateField("LAUNCHER_CLAUDE_MODE", m);
    for (const key of MODEL_KEYS) if (form[key]) updateField(key, "");
  };

  return (
    <div className="flex flex-col gap-4">
      {/* 页面级模式：本地只给本地模型，云端只给云端/API 模型。 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{t("settings.integrations.desc")}</p>
        <div className="flex items-center gap-2">
          <Label className="text-xs">{t("settings.integrations.mode")}</Label>
          <div className="flex gap-2">
            {(["local", "cloud"] as const).map((m) => (
              <Button
                key={m}
                type="button"
                variant={mode === m ? "default" : "outline"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => setMode(m)}
              >
                {m === "local" ? t("settings.integrations.mode.local") : t("settings.integrations.mode.cloud")}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {/* Claude Code：一个 Agent，卡片里带三档模型。 */}
      <IntegrationAgentCard
        label={t("settings.integrations.claude")}
        tool="claude"
        mode={mode}
        modelSlots={CLAUDE_TIERS.map((tier) => ({
          key: tier.key,
          label: t(tier.labelKey),
          value: form[tier.key] ?? "",
          omiFlag: tier.omiFlag,
        }))}
        onModelChange={updateField}
      />

      {LAUNCHER_TOOLS.map((tool) => (
        <IntegrationAgentCard
          key={tool.key}
          label={t(tool.labelKey)}
          tool={tool.tool}
          mode={mode}
          modelSlots={[
            { key: tool.key, label: t("settings.integrations.model"), value: form[tool.key] ?? "" },
          ]}
          onModelChange={updateField}
        />
      ))}

      <SaveRow mutation={saveMutation} hint={t("settings.restartHint")} />
    </div>
  );
}

export function SettingsScreen() {
  const t = useT();
  const [activeTab, setActiveTab] = useState<SettingsTab>("stats");
  const [form, setForm] = useState<SettingsFormState>({});
  const queryClient = useQueryClient();
  // 设置页内原地打开的模型详情：不切换全局路由，左侧分类菜单保持可见。
  const [detail, setDetail] = useState<ModelDetailSource | null>(null);
  const openDetail = (source: ModelDetailSource) => {
    useModelDetailStore.getState().setSource(source);
    setDetail(source);
  };
  const pickTab = (tab: SettingsTab) => {
    setActiveTab(tab);
    setDetail(null);
  };

  // 外部跳转（CLI / OCR / 错误回退）带 tab 参数时切到对应标签。
  const routeTab = useRouter((s) => (s.route.path === "settings" ? s.route.tab : undefined));
  useEffect(() => {
    if (!routeTab || !(routeTab in TAB_DEFS)) return;
    setActiveTab((current) => (current === routeTab ? current : (routeTab as SettingsTab)));
    setDetail(null);
  }, [routeTab]);

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

  const pickKeys = (keys: string[]) => {
    const out: Record<string, string> = {};
    for (const k of keys) if (form[k] !== undefined) out[k] = form[k];
    return out;
  };

  const useTabSave = (keys: string[], opts?: { invalidateConnection?: boolean }) =>
    useMutation({
      mutationFn: () => {
        const settings = pickKeys(keys);
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

  const savePerformance = useTabSave(PERFORMANCE_KEYS, { invalidateConnection: true });
  const saveIntegrations = useTabSave(INTEGRATION_KEYS);

  const updateField = (key: string, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="flex min-h-0 flex-1">
      {/* Left category nav：分组标题 + 条目 */}
      <div className="flex w-44 shrink-0 flex-col gap-1 overflow-y-auto border-r p-3">
        {TAB_GROUPS.map((group) => (
          <div key={group.labelKey ?? group.tabs[0]} className="mb-1 flex flex-col gap-0.5">
            {group.labelKey && (
              <span className="mt-1 mb-0.5 px-2 text-[10px] font-medium tracking-wide text-muted-foreground/70 uppercase">
                {t(group.labelKey)}
              </span>
            )}
            {group.tabs.map((key) => {
              const tab = TAB_DEFS[key];
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => pickTab(key)}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs transition-colors",
                    activeTab === key
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {tab.icon}
                  <span className="truncate">{t(tab.labelKey)}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* Right content: detail (opened in place) takes precedence over tab content */}
      {detail ? (
        <div className="min-w-0 flex-1">
          <ModelDetailScreen onBack={() => setDetail(null)} />
        </div>
      ) : activeTab === "model" ? (
        <div className="min-w-0 flex-1">
          <LocalModelsScreen onOpenDetail={openDetail} />
        </div>
      ) : activeTab === "store" ? (
        <div className="min-w-0 flex-1">
          <ModelsScreen onOpenDetail={openDetail} />
        </div>
      ) : activeTab === "market" ? (
        <div className="min-w-0 flex-1">
          <MarketScreen onOpenDetail={openDetail} />
        </div>
      ) : activeTab === "gateway" ? (
        <div className="min-w-0 flex-1">
          <GatewayScreen />
        </div>
      ) : activeTab === "stats" ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <DashboardScreen />
        </div>
      ) : activeTab === "logs" ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ServerLogsScreen />
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          {/* 模型云服务 / 默认模型是宽版式（三栏 / 双列卡片），放宽内容宽度 */}
          <div
            className={cn(
              "mx-auto w-full px-6 py-6",
              WIDE_TABS.includes(activeTab) ? "max-w-5xl" : "max-w-2xl",
            )}
          >
            {/* 自带头部（PageHeader / 宽版面板）的页面不再重复显示通用标题 */}
            {!SELF_HEADED_TABS.includes(activeTab) && (
              <div className="mb-6">
                <h2 className="text-lg font-semibold tracking-tight">{t("settings.title")}</h2>
                <p className="text-xs text-muted-foreground">{t("settings.subtitle")}</p>
              </div>
            )}

            {activeTab === "network" && <CloudProviderPanel />}

            {activeTab === "defaults" && <DefaultModelsPanel />}

            {activeTab === "performance" && (
              <PerformanceSettings form={form} updateField={updateField} saveMutation={savePerformance} />
            )}

            {activeTab === "integrations" && (
              <IntegrationsSettings form={form} updateField={updateField} saveMutation={saveIntegrations} />
            )}

            {activeTab === "websearch" && (
              <WebSearchTab form={form} updateField={updateField} />
            )}

            {activeTab === "memory" && <MemoryTab />}

            {activeTab === "mcp" && <McpTab />}

            {activeTab === "cli" && <CliTab />}

            {activeTab === "backup" && <BackupTab />}

            {activeTab === "general" && (
              <GeneralPrefsTab form={form} updateField={updateField} />
            )}

            {activeTab === "appearance" && (
              <AppearanceTab form={form} updateField={updateField} />
            )}

            {activeTab === "about" && <AboutTab />}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
