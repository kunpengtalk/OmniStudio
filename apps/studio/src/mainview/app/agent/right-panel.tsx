import { useEffect, useMemo } from "react";
import {
  FileCode2Icon,
  FileDiffIcon,
  FilesIcon,
  FolderIcon,
  GlobeIcon,
  ImageIcon,
  PlusIcon,
  SquareTerminalIcon,
  XIcon,
} from "lucide-react";

import {
  panelTabKey,
  useAgentStore,
  type AgentPanelTab,
  type AgentPreviewTarget,
} from "@stores/agent";
import { useT } from "@stores/ui-lang";
import { PiTip } from "./pi-tip";
import { ArtifactPreviewView } from "./artifact-preview";
import { ArtifactsTab, FilesTab } from "./artifacts-tab";
import { BrowserTab } from "./browser-tab";
import { PanelSplitter } from "./panel-splitter";
import { ReviewTab } from "./review-tab";
import { TerminalTab } from "./terminal-tab";
import { useDismiss } from "./composer-controls";
import type { ArtifactItem } from "../../../bun/agent-artifacts";

type TabMeta = { icon: typeof ImageIcon; titleKey: string };

function tabMeta(tab: AgentPanelTab, artifactTitle?: string, fallbackName?: string): TabMeta {
  switch (tab.kind) {
    case "artifacts":
      return { icon: ImageIcon, titleKey: "agent.panel.artifacts" };
    case "review":
      return { icon: FileDiffIcon, titleKey: "agent.panel.review" };
    case "files":
      return { icon: FolderIcon, titleKey: "agent.panel.files" };
    case "terminal":
      return { icon: SquareTerminalIcon, titleKey: "agent.panel.terminal" };
    case "browser":
      return { icon: GlobeIcon, titleKey: "agent.panel.browser" };
    case "artifact":
      return { icon: FileCode2Icon, titleKey: artifactTitle ?? "agent.panel.preview" };
    default:
      return { icon: FileCode2Icon, titleKey: fallbackName ?? "agent.panel.preview" };
  }
}

/** 可添加的常驻页签（"+" 菜单里列出这些）。 */
const ADDABLE_KINDS = ["artifacts", "review", "files", "terminal", "browser"] as const;

function AddTabMenu({ onPick }: { onPick: (kind: (typeof ADDABLE_KINDS)[number]) => void }) {
  const t = useT();
  const panelTabs = useAgentStore((s) => s.panelTabs);
  const open = useAgentStore((s) => s.addMenuOpen);
  const close = () => useAgentStore.getState().setAddMenuOpen(false);
  const ref = useDismiss(open, close);
  if (!open) return null;
  return (
    <div ref={ref} style={{ position: "relative" }}>
      {/* 「+」在页签条最右端，菜单右对齐向左展开：面板 overflow-hidden，左对齐会被裁成一条图标 */}
      <div className="pi-menu" style={{ right: 0, top: "calc(100% + 4px)", width: "min(200px, calc(100vw - 16px))" }}>
        {ADDABLE_KINDS.map((kind) => {
          const meta = tabMeta({ kind } as AgentPanelTab);
          const Icon = meta.icon;
          const already = panelTabs.some((tab) => tab.kind === kind);
          return (
            <button
              key={kind}
              type="button"
              className="pi-menu-item"
              onClick={() => {
                onPick(kind);
                close();
              }}
            >
              <Icon size={14} aria-hidden style={{ flex: "none", color: "var(--ds-text-secondary)" }} />
              <span style={{ minWidth: 0, flex: 1 }}>{t(meta.titleKey)}</span>
              {already ? <span className="tool-group-count">{t("agent.panel.opened")}</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 右侧工作面板（多页签）。
 *
 * 产出物 / 审查 / 文件 / 终端 / 浏览器 是常驻功能页，用「+」添加；产出物与工作区
 * 文件各占一个预览页签，HTML 直接当网页加载。页签用 28px 高的轻量胶囊 —— 面板里
 * 内容才是主体，头部只该提供"换一页"的能力。
 */
export function AgentRightPanel({ conversationId }: { conversationId: number }) {
  const t = useT();
  const artifacts = useAgentStore((s) => s.artifacts);
  const panelOpen = useAgentStore((s) => s.panelOpen);
  const panelWidth = useAgentStore((s) => s.panelWidth);
  const panelTabs = useAgentStore((s) => s.panelTabs);
  const activeTabIndex = useAgentStore((s) => s.activeTabIndex);

  // 会话切换时收起预览页签，避免展示上一个会话的产物。
  useEffect(() => {
    useAgentStore.getState().closePreviewTabs();
  }, [conversationId]);

  const activeTab = panelTabs[Math.min(activeTabIndex, panelTabs.length - 1)];

  const artifactTitles = useMemo(() => {
    const map = new Map<number, ArtifactItem>();
    for (const artifact of artifacts) map.set(artifact.id, artifact);
    return map;
  }, [artifacts]);

  if (!panelOpen) return null;

  const previewTarget: AgentPreviewTarget | null =
    activeTab?.kind === "artifact"
      ? { source: "artifact", artifactId: activeTab.artifactId }
      : activeTab?.kind === "workspace-file"
        ? { source: "workspace", path: activeTab.path, name: activeTab.name, rootId: activeTab.rootId }
        : null;

  return (
    <aside
      className="wp"
      style={{ "--pi-workpanel-w": `${panelWidth}px` } as React.CSSProperties}
      aria-label={t("agent.panel.toggle")}
    >
      <PanelSplitter width={panelWidth} onWidth={(next) => useAgentStore.getState().setPanelWidth(next)} />
      <div className="wp-header">
        <div className="wp-tabs">
          {panelTabs.map((tab, index) => {
            const artifactTitle = tab.kind === "artifact" ? artifactTitles.get(tab.artifactId)?.title : undefined;
            const meta = tabMeta(tab, artifactTitle, tab.kind === "workspace-file" ? tab.name : undefined);
            const Icon = meta.icon;
            const active = index === Math.min(activeTabIndex, panelTabs.length - 1);
            return (
              <div key={`${panelTabKey(tab)}-${index}`} className={`wp-tab${active ? " active" : ""}`}>
                <button
                  type="button"
                  className="wp-tab-btn"
                  title={t(meta.titleKey)}
                  onClick={() => useAgentStore.getState().setActiveTabIndex(index)}
                >
                  <Icon size={13} aria-hidden style={{ flex: "none" }} />
                  <span className="wp-tab-label">{t(meta.titleKey)}</span>
                </button>
                <button
                  type="button"
                  className="wp-tab-close"
                  aria-label={t("agent.panel.closePreview")}
                  onClick={() => useAgentStore.getState().closePanelTab(index)}
                >
                  <XIcon size={12} aria-hidden />
                </button>
              </div>
            );
          })}
        </div>

        <div className="wp-actions" style={{ position: "relative" }}>
          <PiTip label={t("agent.panel.addTab")}>
            <button
              type="button"
              className="wp-action-btn"
              aria-label={t("agent.panel.addTab")}
              onClick={() => useAgentStore.getState().setAddMenuOpen(!useAgentStore.getState().addMenuOpen)}
            >
              <PlusIcon size={14} aria-hidden />
            </button>
          </PiTip>
          <AddTabMenu
            onPick={(kind) =>
              useAgentStore
                .getState()
                .openPanelTab(kind === "browser" ? { kind, url: "" } : ({ kind } as AgentPanelTab))
            }
          />
        </div>
      </div>

      <div className="wp-body">
        {panelTabs.length === 0 ? (
          <div className="wp-empty">
            <span className="wp-empty-mark">
              <FilesIcon size={18} aria-hidden />
            </span>
            <p className="wp-empty-title">{t("agent.panel.noTabs")}</p>
            <button
              type="button"
              className="composer-panel-btn"
              onClick={() => useAgentStore.getState().setAddMenuOpen(true)}
            >
              <PlusIcon size={12} aria-hidden />
              {t("agent.panel.addTab")}
            </button>
          </div>
        ) : activeTab?.kind === "artifacts" ? (
          <ArtifactsTab />
        ) : activeTab?.kind === "review" ? (
          <ReviewTab />
        ) : activeTab?.kind === "files" ? (
          <FilesTab />
        ) : activeTab?.kind === "terminal" ? (
          <TerminalTab />
        ) : activeTab?.kind === "browser" ? (
          <BrowserTab
            url={activeTab.url}
            onChange={(url) => useAgentStore.getState().openPanelTab({ kind: "browser", url })}
          />
        ) : previewTarget ? (
          <ArtifactPreviewView
            target={previewTarget}
            onClose={() => useAgentStore.getState().closePanelTab(activeTabIndex)}
          />
        ) : (
          <div className="wp-empty">
            <span className="wp-empty-mark">
              <FilesIcon size={18} aria-hidden />
            </span>
            <p className="wp-empty-title">{t("agent.panel.noPreview")}</p>
          </div>
        )}
      </div>
    </aside>
  );
}
