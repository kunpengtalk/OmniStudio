import { useState, useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ServerIcon,
  CpuIcon,
  BlocksIcon,
  GlobeIcon,
  TerminalSquareIcon,
  TerminalIcon,
  LayoutDashboardIcon,
  StarIcon,
  BoxIcon,
  Link2Icon,
  WaypointsIcon,
  CloudIcon,
  GithubIcon,
  PlugIcon,
  ShieldIcon,
  PaletteIcon,
  ArchiveIcon,
  SparklesIcon,
  SlidersHorizontalIcon,
  ChartColumnIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { ScrollArea } from "@ui/scroll-area";
import { PageShell } from "@components/setting-ui";
import { CloudProviderPanel } from "./cloud-provider-panel";
import { IntegrationsSettings } from "./integrations-tab";
import { DefaultModelsPanel } from "./default-models-panel";
import { AboutTab } from "./about-tab";
import { WebSearchTab } from "./web-search-tab";
import { McpTab } from "./mcp-tab";
import { AppearanceTab } from "./prefs-tabs";
import { GeneralTab } from "./general-tab";
import { CliTab } from "./cli-tab";
import { BackupTab } from "./backup-tab";
import { PermissionsTab } from "./permissions-tab";
import { AgentCapsTab } from "./agent-caps-tab";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import { DashboardScreen } from "../dashboard-screen";
import { UsageScreen } from "../usage-screen";
import { ConsoleScreen } from "./console-screen";
import { ModelDetailScreen } from "../model-detail";
import { TunnelScreen } from "../tunnel-screen";
import { ModelsScreen } from "../models-screen";
import { LocalModelsScreen } from "../local-models";
import { MarketScreen } from "../market-screen";
import { GatewayScreen } from "../gateway-screen";
import { useModelDetailStore, type ModelDetailSource } from "@stores/model-detail";
import { useRouter } from "@stores/router";

type SettingsFormState = Record<string, string>;

type SettingsTab =
  | "network"
  | "defaults"
  | "model"
  | "store"
  | "market"
  | "gateway"
  | "tunnel"
  | "integrations"
  | "logs"
  | "usage"
  | "stats"
  | "websearch"
  | "mcp"
  | "permissions"
  | "agentcaps"
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
  tunnel: { icon: <CloudIcon className="size-4" />, labelKey: "settings.tunnel" },
  integrations: { icon: <BlocksIcon className="size-4" />, labelKey: "settings.integrations" },
  logs: { icon: <TerminalSquareIcon className="size-4" />, labelKey: "console.title" },
  usage: { icon: <ChartColumnIcon className="size-4" />, labelKey: "settings.usage.title" },
  stats: { icon: <LayoutDashboardIcon className="size-4" />, labelKey: "settings.dashboard" },
  websearch: { icon: <GlobeIcon className="size-4" />, labelKey: "settings.webSearch.title" },
  mcp: { icon: <PlugIcon className="size-4" />, labelKey: "settings.mcp.title" },
  permissions: { icon: <ShieldIcon className="size-4" />, labelKey: "settings.permissions.title" },
  agentcaps: { icon: <SparklesIcon className="size-4" />, labelKey: "settings.agentCaps.title" },
  cli: { icon: <TerminalIcon className="size-4" />, labelKey: "settings.cli.title" },
  backup: { icon: <ArchiveIcon className="size-4" />, labelKey: "settings.backup.title" },
  general: { icon: <SlidersHorizontalIcon className="size-4" />, labelKey: "settings.general.title" },
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
    tabs: ["gateway", "tunnel", "integrations"],
  },
  { labelKey: "settings.group.tools", tabs: ["websearch", "mcp", "permissions", "agentcaps", "cli"] },
  { labelKey: "settings.group.prefs", tabs: ["general", "appearance", "about"] },
  { labelKey: "settings.group.data", tabs: ["usage", "logs", "backup"] },
];

/** 自带头部（PageHeader / 宽版面板）的页面不再重复显示通用标题。 */
const SELF_HEADED_TABS: SettingsTab[] = [
  "network",
  "defaults",
  "about",
  "websearch",
  "mcp",
  "permissions",
  "agentcaps",
  "cli",
  "backup",
  "general",
  "appearance",
  "tunnel",
];

/** 设置页：一级页面，每个标签页的内容宽度统一由 `PageShell` 决定。 */
export function SettingsScreen() {
  const t = useT();
  const [activeTab, setActiveTab] = useState<SettingsTab>("stats");
  const [form, setForm] = useState<SettingsFormState>({});
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

  const updateField = (key: string, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="flex min-h-0 flex-1">
      {/* Left category nav：分组标题 + 条目 */}
      <nav
        aria-label={t("settings.title")}
        className="flex w-44 shrink-0 flex-col gap-1 overflow-y-auto border-r p-3"
      >
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
      </nav>

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
      ) : activeTab === "tunnel" ? (
        <div className="min-w-0 flex-1">
          <TunnelScreen />
        </div>
      ) : activeTab === "stats" ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <DashboardScreen />
        </div>
      ) : activeTab === "usage" ? (
        // 使用统计是宽版仪表盘（热力图 + 三张图），与「概览」一样绕开通用窄栏。
        <ScrollArea className="min-h-0 min-w-0 flex-1">
          <UsageScreen />
        </ScrollArea>
      ) : activeTab === "logs" ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ConsoleScreen />
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <PageShell>
            {/* 自带头部（PageHeader / 宽版面板）的页面不再重复显示通用标题 */}
            {!SELF_HEADED_TABS.includes(activeTab) && (
              <div className="mb-6">
                <h2 className="text-lg font-semibold tracking-tight">{t("settings.title")}</h2>
                <p className="text-xs text-muted-foreground">{t("settings.subtitle")}</p>
              </div>
            )}

            {activeTab === "network" && <CloudProviderPanel />}

            {activeTab === "defaults" && <DefaultModelsPanel />}

            {activeTab === "integrations" && (
              <IntegrationsSettings form={form} updateField={updateField} />
            )}

            {activeTab === "websearch" && (
              <WebSearchTab form={form} updateField={updateField} />
            )}

            {activeTab === "mcp" && <McpTab />}
            {activeTab === "permissions" && <PermissionsTab />}
            {activeTab === "agentcaps" && <AgentCapsTab />}

            {activeTab === "cli" && <CliTab />}

            {activeTab === "backup" && <BackupTab />}

            {activeTab === "general" && (
              <GeneralTab form={form} updateField={updateField} />
            )}

            {activeTab === "appearance" && (
              <AppearanceTab form={form} updateField={updateField} />
            )}

            {activeTab === "about" && <AboutTab />}
          </PageShell>
        </ScrollArea>
      )}
    </div>
  );
}

