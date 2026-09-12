import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeftIcon, FolderIcon, MessageSquareIcon, SearchIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { useAgentStore } from "@stores/agent";
import { useChatStore } from "@stores/chat";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import { McpTab } from "../main-layout/mcp-tab";
import { AutomationsScreen } from "../automations-screen";
import { MarketTab } from "../skills/market-tab";
import { MySkillsTab } from "../skills/my-skills-tab";
import { PresetsTab } from "../skills/presets-tab";
import { ToolsTab } from "../skills/tools-tab";

export type AgentSubView = "chat" | "search" | "automations" | "plugins" | "skills";

/** 子视图外壳：标题 + 返回对话。子视图与对话共用同一个主区域（不是一级菜单）。 */
function SubViewShell({
  title,
  description,
  children,
  actions,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const t = useT();
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          tooltip={t("agent.view.back")}
          onClick={() => useAgentStore.getState().setSubView("chat")}
        >
          <ChevronLeftIcon className="size-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{title}</p>
          {description && <p className="truncate text-[10px] text-muted-foreground">{description}</p>}
        </div>
        {actions}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(ts).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

/**
 * 会话搜索（侧栏「搜索」入口）：标题 + **正文**命中，结果带片段，
 * 点一条直接跳进那条会话继续对话。
 */
export function AgentSearchView() {
  const t = useT();
  const [query, setQuery] = useState("");
  const searchQuery = useQuery({
    queryKey: ["agent-search", query],
    queryFn: () => rpcClient.searchAgentSessions({ query }),
    enabled: query.trim().length > 0,
  });
  const hits = searchQuery.data?.hits ?? [];

  return (
    <SubViewShell title={t("agent.nav.search")} description={t("agent.search.hint")}>
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 p-4">
        <div className="relative">
          <SearchIcon className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("agent.search.placeholder")}
            className="h-9 pl-8 text-xs"
          />
        </div>

        {query.trim().length === 0 ? (
          <p className="py-10 text-center text-[11px] text-muted-foreground">{t("agent.search.empty")}</p>
        ) : searchQuery.isLoading ? (
          <p className="py-10 text-center text-[11px] text-muted-foreground">{t("common.loading")}</p>
        ) : hits.length === 0 ? (
          <p className="py-10 text-center text-[11px] text-muted-foreground">{t("agent.search.noResult")}</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {hits.map((hit) => (
              <button
                key={hit.id}
                type="button"
                onClick={() => {
                  useAgentStore.getState().clearUnread(hit.id);
                  useChatStore.getState().setActiveConversation(hit.id);
                  useChatStore.getState().setActiveMessages([]);
                  useChatStore.getState().setStreaming(false);
                  useAgentStore.getState().clear();
                  useAgentStore.getState().setSubView("chat");
                }}
                className="rounded-xl border px-3 py-2 text-left transition-colors hover:bg-muted/50"
              >
                <div className="flex items-center gap-2">
                  <MessageSquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">{hit.title}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {relativeTime(hit.updatedAt)}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground/70">
                  <FolderIcon className="size-2.5" />
                  <span className="max-w-56 truncate">{hit.workspace}</span>
                </div>
                {hit.matches.length > 0 && (
                  <div className="mt-1.5 flex flex-col gap-1">
                    {hit.matches.map((match, index) => (
                      <p
                        key={index}
                        className={cn(
                          "line-clamp-2 text-[11px] text-muted-foreground",
                          match.role === "user" ? "" : "",
                        )}
                      >
                        <span className="mr-1 rounded bg-muted px-1 text-[9px]">
                          {match.role === "user" ? "我" : "Agent"}
                        </span>
                        {match.snippet}
                      </p>
                    ))}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </SubViewShell>
  );
}

/** 自动化：直接复用自动化页，只是嵌在 Agent 主区域里。 */
export function AgentAutomationsView() {
  const t = useT();
  return (
    <SubViewShell title={t("agent.nav.automations")} description={t("automations.subtitle")}>
      <AutomationsScreen />
    </SubViewShell>
  );
}

/** 插件（MCP / 外部工具）：复用设置里的 MCP 面板。 */
export function AgentPluginsView() {
  const t = useT();
  return (
    <SubViewShell title={t("agent.nav.plugins")} description={t("agent.plugins.hint")}>
      <div className="mx-auto w-full max-w-3xl p-4">
        <McpTab />
      </div>
    </SubViewShell>
  );
}

const SKILL_SECTIONS = ["my", "market", "presets", "tools"] as const;
type SkillSection = (typeof SKILL_SECTIONS)[number];

/** Skills：嵌在 Agent 里，带一列自己的分区切换（不依赖全局侧栏）。 */
export function AgentSkillsView() {
  const t = useT();
  const [section, setSection] = useState<SkillSection>("my");
  const labels: Record<SkillSection, string> = {
    my: t("skills.nav.my"),
    market: t("skills.nav.market"),
    presets: t("skills.nav.presets"),
    tools: t("skills.nav.tools"),
  };
  return (
    <SubViewShell
      title={t("agent.nav.skills")}
      description={t("agent.skills.hint")}
      actions={
        <div className="flex items-center gap-0.5 rounded-full border bg-muted/40 p-0.5">
          {SKILL_SECTIONS.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setSection(item)}
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] transition-colors",
                section === item ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {labels[item]}
            </button>
          ))}
        </div>
      }
    >
      <div className="mx-auto w-full max-w-3xl p-4">
        {section === "my" && <MySkillsTab />}
        {section === "market" && <MarketTab />}
        {section === "presets" && <PresetsTab />}
        {section === "tools" && <ToolsTab />}
      </div>
    </SubViewShell>
  );
}
