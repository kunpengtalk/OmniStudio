import { ChevronLeftIcon } from "lucide-react";

import { useAgentStore } from "@stores/agent";
import { useT } from "@stores/ui-lang";
import { PiTip } from "./pi-tip";
import { McpTab } from "../main-layout/mcp-tab";
import { AutomationsScreen } from "../automations";

export type { AgentSubView } from "@stores/agent";

/**
 * 子视图外壳：标题 + 返回对话。子视图与对话共用同一个主区域（不是一级菜单）。
 *
 * 顶部要留出 46px：顶部工具条是绝对定位盖在主区域上的，不留就会把子视图自己的
 * 标题栏压在里面（两个标题叠在一起）。
 */
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
    <div className="pi-subview" style={{ paddingTop: "var(--pi-toolbar-h)" }}>
      <div className="pi-subview-head">
        <PiTip label={t("agent.view.back")}>
          <button
            type="button"
            className="ct-icon-btn"
            aria-label={t("agent.view.back")}
            onClick={() => useAgentStore.getState().setSubView("chat")}
          >
            <ChevronLeftIcon size={15} aria-hidden />
          </button>
        </PiTip>
        <span className="ct-title">{title}</span>
        {description ? <span className="ct-sub">{description}</span> : null}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>{actions}</div>
      </div>
      <div className="pi-subview-body">{children}</div>
    </div>
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
