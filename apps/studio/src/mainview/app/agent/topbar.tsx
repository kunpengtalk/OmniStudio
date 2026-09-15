import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquarePlusIcon, PanelRightIcon, PanelRightOpenIcon, SearchIcon, SidebarIcon } from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { useAgentStore } from "@stores/agent";
import { useChatStore } from "@stores/chat";
import { useT } from "@stores/ui-lang";
import { PiTip } from "./pi-tip";
import type { AgentSessionSearchHit } from "../../../bun/agent";

/** 顶部标题只留前 10 个字：再长就会把右边的动作挤走。 */
const TITLE_MAX = 10;

function truncateTitle(title: string): string {
  const chars = Array.from(title);
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX).join("")}…` : title;
}

function isDefaultTitle(title?: string | null): boolean {
  const trimmed = (title ?? "").trim().toLowerCase();
  if (!trimmed) return true;
  return ["new task", "new chat", "新建任务", "新对话", "未命名任务"].includes(trimmed);
}

function projectName(path: string): string | null {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path ?? null;
}

/**
 * 顶部工具条（对齐参考实现的 conversation topbar）。
 *
 * 左边是「侧栏唤回 + 会话标题 + 项目名」，右边是「新建 / 搜索」一组动作。
 * 标题与动作分居两端，是为了让拖拽区（`-webkit-app-region: drag`）集中在标题
 * 那一带 —— 动作按钮全部标记 no-drag，否则点不动。
 */
export function AgentTopbar({
  sidebarCollapsed,
  onToggleSidebar,
  onNewTask,
  onOpenSearch,
}: {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onNewTask: () => void;
  onOpenSearch: () => void;
}) {
  const t = useT();
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const conversations = useChatStore((s) => s.conversations);
  const workspace = useAgentStore((s) => s.workspace);

  const session = conversations.find((c) => c.id === activeConversationId);
  const fullTitle = isDefaultTitle(session?.title) ? t("agent.untitledTask") : (session?.title ?? t("agent.untitledTask"));
  const project = workspace ? projectName(workspace) : null;

  return (
    <div className="pi-topbar" role="toolbar" aria-label={t("agent.title")}>
      <div className="ct-left">
        {/* 侧栏收起时把唤回按钮补回标题左边；展开时它被 CSS 藏掉，不占焦点顺序。 */}
        <div className="ct-lead" aria-hidden={!sidebarCollapsed}>
          <PiTip label={t("agent.sidebar.toggle")}>
            <button
              type="button"
              className="ct-icon-btn"
              tabIndex={sidebarCollapsed ? undefined : -1}
              aria-label={t("agent.sidebar.toggle")}
              onClick={onToggleSidebar}
            >
              <SidebarIcon size={15} aria-hidden />
            </button>
          </PiTip>
        </div>
        <div className="ct-title-wrap" title={project ? `${project} · ${fullTitle}` : fullTitle}>
          <span className="ct-title">{truncateTitle(fullTitle)}</span>
          {project ? <span className="ct-sub">{project}</span> : null}
        </div>
      </div>

      <div className="ct-right">
        <div className="ct-actions">
          <PiTip label={t("agent.session.new")}>
            <button type="button" className="ct-icon-btn" aria-label={t("agent.session.new")} onClick={onNewTask}>
              <MessageSquarePlusIcon size={15} aria-hidden />
            </button>
          </PiTip>
          <PiTip label={t("agent.search.title")}>
            <button type="button" className="ct-icon-btn" aria-label={t("agent.search.title")} onClick={onOpenSearch}>
              <SearchIcon size={15} aria-hidden />
            </button>
          </PiTip>
        </div>
      </div>
    </div>
  );
}

/** 会话内容搜索（⌘K）。标题命中 + 正文命中都列出来，点一条直接跳过去。 */
export function AgentSearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data, isFetching } = useQuery({
    queryKey: ["agent-search", query],
    queryFn: () => rpcClient.searchAgentSessions({ query, limit: 20 }),
    enabled: open && query.trim().length > 0,
  });
  const hits = useMemo(() => data?.hits ?? [], [data]);

  useEffect(() => {
    if (open) {
      const frame = requestAnimationFrame(() => inputRef.current?.focus());
      setActive(0);
      return () => cancelAnimationFrame(frame);
    }
    setQuery("");
    return undefined;
  }, [open]);

  const openSession = useMutation({
    mutationFn: async (hit: AgentSessionSearchHit) => hit,
    onSuccess: (hit) => {
      useAgentStore.getState().setSubView("chat");
      useAgentStore.getState().clearUnread(hit.id);
      useChatStore.getState().setActiveConversation(hit.id);
      useChatStore.getState().setActiveMessages([]);
      useChatStore.getState().setStreaming(false);
      useAgentStore.getState().clear();
      queryClient.invalidateQueries({ queryKey: ["conversation", hit.id] });
      onClose();
    },
  });

  if (!open) return null;

  return (
    <div
      className="pi-search-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={t("agent.search.title")}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="pi-search-dialog">
        <div className="pi-search-head">
          <SearchIcon size={17} aria-hidden />
          <input
            ref={inputRef}
            value={query}
            spellCheck={false}
            placeholder={t("agent.search.placeholder")}
            aria-label={t("agent.search.title")}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((prev) => Math.min(prev + 1, Math.max(0, hits.length - 1)));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((prev) => Math.max(prev - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                const hit = hits[active];
                if (hit) openSession.mutate(hit);
              }
            }}
          />
          {isFetching ? <span className="tool-spinner" aria-hidden /> : null}
        </div>

        <div className="pi-search-results">
          {query.trim().length === 0 ? (
            <p className="pi-menu-empty">{t("agent.search.hint")}</p>
          ) : hits.length === 0 && !isFetching ? (
            <p className="pi-menu-empty">{t("agent.search.noResult")}</p>
          ) : (
            hits.map((hit, index) => (
              <button
                key={hit.id}
                type="button"
                className={`pi-search-item${index === active ? " active" : ""}`}
                onMouseEnter={() => setActive(index)}
                onClick={() => openSession.mutate(hit)}
              >
                <span className="pi-search-title">{hit.title || t("agent.untitledTask")}</span>
                {hit.matches[0] ? <span className="pi-search-sub">{hit.matches[0].snippet}</span> : null}
              </button>
            ))
          )}
        </div>

        <div className="pi-search-foot">
          <span className="pi-kbd">↑↓</span>
          <span>{t("agent.search.navigate")}</span>
          <span className="pi-kbd">↵</span>
          <span>{t("agent.search.open")}</span>
          <span className="pi-kbd">esc</span>
          <span>{t("agent.search.close")}</span>
        </div>
      </div>
    </div>
  );
}

/** 右侧面板开关：位置固定，两个图标做交叉淡出而不是换节点。 */
export function WorkPanelToggle() {
  const t = useT();
  const panelOpen = useAgentStore((s) => s.panelOpen);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  return (
    <PiTip label={panelOpen ? t("agent.panel.hide") : t("agent.panel.toggle")}>
      <button
        type="button"
        className="pi-panel-toggle"
        aria-pressed={panelOpen}
        aria-label={panelOpen ? t("agent.panel.hide") : t("agent.panel.toggle")}
        disabled={activeConversationId == null}
        onClick={() => useAgentStore.getState().setPanelOpen(!panelOpen)}
      >
        <span className="pi-panel-toggle-icon" aria-hidden>
          <PanelRightIcon size={15} />
          <PanelRightOpenIcon size={15} />
        </span>
      </button>
    </PiTip>
  );
}
