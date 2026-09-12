import { useEffect, useMemo, useState } from "react";
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

import { Button } from "@ui/button";
import {
  panelTabKey,
  useAgentStore,
  type AgentPanelTab,
  type AgentPreviewTarget,
} from "@stores/agent";
import { useT } from "@stores/ui-lang";
import { cn } from "@/mainview/lib/utils";
import { ArtifactPreviewView } from "./artifact-preview";
import { ArtifactsTab, FilesTab } from "./artifacts-tab";
import { BrowserTab } from "./browser-tab";
import { PanelSplitter } from "./panel-splitter";
import { ReviewTab } from "./review-tab";
import { TerminalTab } from "./terminal-tab";
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
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={() => useAgentStore.getState().setAddMenuOpen(false)} />
      {/* 「+」在页签条最右端，菜单右对齐向左展开：面板 overflow-hidden，左对齐会被裁成一条图标 */}
      <div className="absolute top-full right-0 z-50 mt-1 w-44 overflow-hidden rounded-xl border bg-popover p-1 shadow-lg">
        {ADDABLE_KINDS.map((kind) => {
          const meta = tabMeta({ kind } as AgentPanelTab);
          const Icon = meta.icon;
          const already = panelTabs.some((tab) => tab.kind === kind);
          return (
            <button
              key={kind}
              type="button"
              onClick={() => {
                onPick(kind);
                useAgentStore.getState().setAddMenuOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-muted"
            >
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{t(meta.titleKey)}</span>
              {already && <span className="shrink-0 text-[10px] text-muted-foreground/60">{t("agent.panel.opened")}</span>}
            </button>
          );
        })}
      </div>
    </>
  );
}

/**
 * 右侧面板（对齐参考实现的多页签侧栏）：
 * 产出物 / 审查 / 文件 / 终端 / 浏览器 是常驻功能页，"+" 里添加；
 * 产出物与工作区文件另开预览页签，HTML 直接当网页加载。
 * 左边框是分隔条，可以拖动改宽度。
 */
export function AgentRightPanel({ conversationId }: { conversationId: number }) {
  const t = useT();
  const artifacts = useAgentStore((s) => s.artifacts);
  const panelOpen = useAgentStore((s) => s.panelOpen);
  const panelWidth = useAgentStore((s) => s.panelWidth);
  const panelTabs = useAgentStore((s) => s.panelTabs);
  const activeTabIndex = useAgentStore((s) => s.activeTabIndex);
  const [browserUrl, setBrowserUrl] = useState("");

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
    <>
      <PanelSplitter width={panelWidth} onWidth={(next) => useAgentStore.getState().setPanelWidth(next)} />
      <aside
        className="flex min-h-0 shrink-0 flex-col overflow-hidden border-l bg-muted/10"
        style={{ width: panelWidth }}
      >
        {/* 页签条：图标 + 标题 + 关闭，末尾是「+」 */}
        <div className="flex items-center gap-0.5 border-b px-1 py-1">
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
            {panelTabs.map((tab, index) => {
              const artifactTitle =
                tab.kind === "artifact" ? artifactTitles.get(tab.artifactId)?.title : undefined;
              const meta = tabMeta(tab, artifactTitle, tab.kind === "workspace-file" ? tab.name : undefined);
              const Icon = meta.icon;
              const active = index === Math.min(activeTabIndex, panelTabs.length - 1);
              return (
                <button
                  key={`${panelTabKey(tab)}-${index}`}
                  type="button"
                  onClick={() => useAgentStore.getState().setActiveTabIndex(index)}
                  title={t(meta.titleKey)}
                  className={cn(
                    "group flex max-w-40 shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] transition-colors",
                    active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50",
                  )}
                >
                  <Icon className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{t(meta.titleKey)}</span>
                  <span
                    role="button"
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation();
                      useAgentStore.getState().closePanelTab(index);
                    }}
                    className="shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-background/60"
                  >
                    <XIcon className="size-3" />
                  </span>
                </button>
              );
            })}
          </div>

          <div className="relative shrink-0">
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-6 text-muted-foreground"
              tooltip={t("agent.panel.addTab")}
              onClick={() => useAgentStore.getState().setAddMenuOpen(!useAgentStore.getState().addMenuOpen)}
            >
              <PlusIcon className="size-3.5" />
            </Button>
            <AddTabMenu
              onPick={(kind) =>
                useAgentStore
                  .getState()
                  .openPanelTab(kind === "browser" ? { kind, url: browserUrl } : ({ kind } as AgentPanelTab))
              }
            />
          </div>
        </div>

        {panelTabs.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
            <p className="text-[11px] text-muted-foreground">{t("agent.panel.noTabs")}</p>
            <Button
              variant="secondary"
              size="sm"
              className="h-7 gap-1 px-2 text-[11px]"
              onClick={() => useAgentStore.getState().setAddMenuOpen(true)}
            >
              <PlusIcon className="size-3" />
              {t("agent.panel.addTab")}
            </Button>
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
            onChange={(url) => {
              setBrowserUrl(url);
              useAgentStore.getState().openPanelTab({ kind: "browser", url });
            }}
          />
        ) : previewTarget ? (
          <ArtifactPreviewView
            target={previewTarget}
            onClose={() => useAgentStore.getState().closePanelTab(activeTabIndex)}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-1.5 p-4 text-center">
            <FilesIcon className="size-5 text-muted-foreground/50" />
            <p className="text-[11px] text-muted-foreground">{t("agent.panel.noPreview")}</p>
          </div>
        )}
      </aside>
    </>
  );
}
