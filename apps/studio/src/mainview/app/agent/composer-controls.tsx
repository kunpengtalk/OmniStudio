import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleIcon,
  ClipboardListIcon,
  CpuIcon,
  SparklesIcon,
  TargetIcon,
  ZapIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { useAgentStore } from "@stores/agent";
import { useChatStore } from "@stores/chat";
import { useT } from "@stores/ui-lang";
import { PiTip } from "./pi-tip";
import type { AgentMode } from "../../../bun/agent";
import type { ApprovalMode } from "../../../bun/permissions";
import type { ChatModelOption } from "../../../bun/chat-model";

/** 推理等级：与主进程 `AGENT_THINKING_LEVELS` 一一对应，顺序也一致。 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const MODE_ORDER: AgentMode[] = ["agent", "plan", "goal"];
const MODE_ICON: Record<AgentMode, typeof SparklesIcon> = {
  agent: ZapIcon,
  plan: ClipboardListIcon,
  goal: TargetIcon,
};

/** 授权模式在界面上的顺序：从严到宽再回到只读，常用的三档排前面。 */
const APPROVAL_ORDER: ApprovalMode[] = ["manual", "smart", "auto", "strict"];

const APPROVAL_ICON: Record<ApprovalMode, typeof CircleIcon> = {
  manual: CircleIcon,
  smart: CheckIcon,
  auto: ZapIcon,
  strict: CircleIcon,
};

/**
 * 点开菜单后：点外面 / 按 Esc 关掉。
 * 菜单是绝对定位在触发按钮旁边的普通节点（不走 portal），所以挂在面板根上监听即可。
 */
export function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const node = event.target as Node | null;
      if (node && ref.current?.contains(node)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);
  return ref;
}

/** 当前推理等级（设置项，主进程侧已校验）。 */
export function useThinkingLevel() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(undefined),
  });
  const raw = (data?.settings?.AGENT_THINKING_LEVEL ?? "off") as ThinkingLevel;
  const level = THINKING_LEVELS.includes(raw) ? raw : "off";

  const mutation = useMutation({
    mutationFn: (next: ThinkingLevel) => rpcClient.setAgentThinkingLevel({ level: next }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });

  return { level, setLevel: (next: ThinkingLevel) => mutation.mutate(next) };
}

/** 当前授权模式。 */
export function useApprovalMode() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["agent-permissions"],
    queryFn: () => rpcClient.getAgentPermissions(undefined),
  });
  const mode = data?.mode ?? "smart";
  const mutation = useMutation({
    mutationFn: (next: ApprovalMode) => rpcClient.setAgentApprovalMode({ mode: next }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["agent-permissions"] }),
  });
  return { mode, setMode: (next: ApprovalMode) => mutation.mutate(next) };
}

/** 目标模式胶囊：点一下切到下一个模式（与参考实现一致，不做下拉）。 */
export function ModeChip({ mode, disabled }: { mode: AgentMode; disabled?: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const running = useAgentStore((s) => s.running);
  const Icon = MODE_ICON[mode];

  const mutation = useMutation({
    mutationFn: async (next: AgentMode) => {
      await rpcClient.updateSettings({ settings: { AGENT_MODE: next } });
      return next;
    },
    onSuccess: (next) => {
      useAgentStore.getState().setMode(next);
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["agent-tools", next] });
    },
  });

  const next = MODE_ORDER[(MODE_ORDER.indexOf(mode) + 1) % MODE_ORDER.length]!;

  return (
    <PiTip
      label={`${t(`agent.mode.${mode}`)} · ${t(`agent.mode.${mode}.hint`)}`}
    >
      <button
        type="button"
        className="pi-icon-btn composer-mode-chip"
        data-planning={mode === "plan" && (running ? "true" : undefined)}
        disabled={disabled || mutation.isPending}
        aria-label={t(`agent.mode.${mode}`)}
        onClick={() => mutation.mutate(next)}
      >
        <span className="composer-mode-face" key={mode}>
          <Icon size={14} aria-hidden />
          <span className="composer-mode-label">{t(`agent.mode.${mode}`)}</span>
        </span>
      </button>
    </PiTip>
  );
}

/** 授权模式胶囊：每次编辑 / 允许编辑 / 全自动 / 只读。 */
export function PermissionChip({
  mode,
  disabled,
}: {
  mode: ApprovalMode;
  disabled?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  const { setMode } = useApprovalMode();

  const label = t(`agent.permission.mode.${mode}`);

  return (
    <div ref={ref} className="pi-tip-host" style={{ position: "relative" }}>
      <PiTip label={t("agent.permission.title")}>
        <button
          type="button"
          className={`pi-icon-btn${open ? " active" : ""}`}
          disabled={disabled}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t("agent.permission.title")}
          onClick={() => setOpen((v) => !v)}
        >
          <span>{label}</span>
          <ChevronDownIcon size={12} aria-hidden />
        </button>
      </PiTip>

      {open && (
        <div className="pi-menu" style={{ left: 0, bottom: "calc(100% + 6px)", width: "min(260px, calc(100vw - 24px))" }} role="menu">
          {APPROVAL_ORDER.map((candidate) => {
            const Icon = APPROVAL_ICON[candidate];
            return (
              <button
                key={candidate}
                type="button"
                role="menuitemradio"
                aria-checked={mode === candidate}
                className={`pi-menu-item${mode === candidate ? " active" : ""}`}
                onClick={() => {
                  close();
                  setMode(candidate);
                }}
              >
                <Icon size={14} aria-hidden style={{ flex: "none", color: "var(--ds-text-secondary)" }} />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: "block" }}>{t(`agent.permission.mode.${candidate}`)}</span>
                  <span style={{ display: "block", fontSize: 11, color: "var(--ds-text-muted)" }}>
                    {t(`agent.permission.mode.${candidate}.hint`)}
                  </span>
                </span>
                {mode === candidate ? <CheckIcon size={13} className="pi-menu-check" /> : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * 模型 + 推理等级选择器。
 *
 * 做成「一个胶囊装两件事 → 点开是两级菜单」，和参考实现一致：模型和推理等级都是
 * 「这一轮发给谁、花多少算力」，属于同一类决定，拆成两个按钮会让工具条多一个入口
 * 却没有更多信息。
 */
export function ModelThinkingPicker({ disabled }: { disabled?: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"root" | "model" | "thinking">("root");
  const [query, setQuery] = useState("");
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  const searchRef = useRef<HTMLInputElement>(null);

  const { level, setLevel } = useThinkingLevel();

  const modelsQuery = useQuery({
    queryKey: ["chat-models"],
    queryFn: () => rpcClient.listChatModels(undefined),
    enabled: open,
  });
  const models = useMemo(() => modelsQuery.data?.models ?? [], [modelsQuery.data]);
  const active = models.find((m) => m.isActive);

  const switchMutation = useMutation({
    mutationFn: (option: { type: "local" | "api"; value: string; providerId?: string }) =>
      rpcClient.selectChatModel(option),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["chat-models"] });
      setOpen(false);
      if (data && !data.ok) useAgentStore.getState().setModelNotice(data.error ?? t("chat.modelSwitchFailed"));
    },
    onError: (error: unknown) => {
      setOpen(false);
      useAgentStore.getState().setModelNotice(String(error));
    },
  });

  // 按「本地 / 各云端厂商」分组：同名模型散在十几行里没法选。
  const groups = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const buckets = new Map<string, { label: string; items: ChatModelOption[] }>();
    for (const model of models) {
      if (keyword && !model.label.toLowerCase().includes(keyword) && !model.value.toLowerCase().includes(keyword)) {
        continue;
      }
      const key = model.type === "local" ? "__local" : (model.providerId ?? "__cloud");
      const label = model.type === "local" ? t("agent.model.localGroup") : (model.providerName ?? t("agent.model.cloudGroup"));
      const bucket = buckets.get(key) ?? { label, items: [] };
      bucket.items.push(model);
      buckets.set(key, bucket);
    }
    return [...buckets.values()];
  }, [models, query, t]);

  const modelLabel = active?.label ?? t("agent.model.none");
  const levelLabel = level === "off" ? t("agent.reasoning.off") : level;

  useEffect(() => {
    if (open && view === "model") {
      const frame = requestAnimationFrame(() => searchRef.current?.focus());
      return () => cancelAnimationFrame(frame);
    }
  }, [open, view]);

  return (
    <div ref={ref} className="pi-tip-host" style={{ position: "relative" }}>
      <PiTip label={`${modelLabel} · ${t("agent.reasoning.title")}: ${levelLabel}`}>
        <button
          type="button"
          className={`pi-icon-btn composer-model-chip${open ? " active" : ""}`}
          disabled={disabled}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t("agent.model.title")}
          onClick={() => {
            if (!open) {
              setView("root");
              setQuery("");
            }
            setOpen((v) => !v);
          }}
        >
          <CpuIcon size={14} aria-hidden />
          <span className="pi-model-name">{modelLabel}</span>
          {level !== "off" ? (
            <>
              <span className="pi-model-dot" aria-hidden>
                ·
              </span>
              <span className="pi-model-level">{levelLabel}</span>
            </>
          ) : null}
          <ChevronDownIcon size={12} aria-hidden />
        </button>
      </PiTip>

      {open && (
        <div
          className="pi-menu"
          role="menu"
          style={{ right: 0, bottom: "calc(100% + 6px)", width: "min(300px, calc(100vw - 24px))", transformOrigin: "bottom right" }}
        >
          {view === "root" ? (
            <>
              <button type="button" role="menuitem" className="pi-menu-entry" aria-haspopup="menu" onClick={() => setView("model")}>
                <CpuIcon size={14} aria-hidden />
                <span className="pi-menu-entry-label">{t("agent.model.title")}</span>
                <span className="pi-menu-entry-value" title={modelLabel}>
                  {modelLabel}
                </span>
                <ChevronRightIcon size={14} aria-hidden />
              </button>
              <button type="button" role="menuitem" className="pi-menu-entry" aria-haspopup="menu" onClick={() => setView("thinking")}>
                <BrainIcon size={14} aria-hidden />
                <span className="pi-menu-entry-label">{t("agent.reasoning.title")}</span>
                <span className="pi-menu-entry-value">{levelLabel}</span>
                <ChevronRightIcon size={14} aria-hidden />
              </button>
            </>
          ) : (
            <>
              <button type="button" role="menuitem" className="pi-menu-back" onClick={() => setView("root")}>
                <ChevronLeftIcon size={14} aria-hidden />
                <span>{view === "model" ? t("agent.model.title") : t("agent.reasoning.title")}</span>
              </button>
              <div className="pi-menu-sep" />

              {view === "model" ? (
                <>
                  <label className="pi-menu-search">
                    <SearchGlyph />
                    <input
                      ref={searchRef}
                      type="text"
                      value={query}
                      spellCheck={false}
                      autoCorrect="off"
                      autoCapitalize="off"
                      placeholder={t("agent.model.search")}
                      aria-label={t("agent.model.search")}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </label>
                  <div className="pi-menu-scroll">
                    {groups.map((group) => (
                      <div key={group.label} className="pi-menu-group" role="group" aria-label={group.label}>
                        <div className="pi-menu-group-label">{group.label}</div>
                        {group.items.map((model) => {
                          const isActive = model.isActive;
                          return (
                            <button
                              key={`${model.type}:${model.value}:${model.providerId ?? ""}`}
                              type="button"
                              role="menuitemradio"
                              aria-checked={isActive}
                              title={model.detail ?? model.label}
                              className={`pi-menu-item${isActive ? " active" : ""}`}
                              disabled={switchMutation.isPending}
                              onClick={() =>
                                switchMutation.mutate({
                                  type: model.type,
                                  value: model.value,
                                  providerId: model.providerId,
                                })
                              }
                            >
                              <span className="pi-menu-option-main">
                                <span className="pi-menu-option-name">{model.label}</span>
                                <span className="pi-menu-option-meta">
                                  {model.engine ? <span className="pi-menu-badge">{model.engine}</span> : null}
                                </span>
                              </span>
                              {isActive ? <CheckIcon size={14} className="pi-menu-check" aria-hidden /> : null}
                            </button>
                          );
                        })}
                      </div>
                    ))}
                    {groups.length === 0 ? (
                      <div className="pi-menu-empty">
                        {modelsQuery.isLoading ? t("agent.loading") : t("agent.model.empty")}
                      </div>
                    ) : null}
                  </div>
                </>
              ) : (
                <>
                  <div className="pi-menu-heading">{t("agent.reasoning.supportedBy", { model: modelLabel })}</div>
                  <div className="pi-menu-scroll">
                    {THINKING_LEVELS.map((candidate) => (
                      <button
                        key={candidate}
                        type="button"
                        role="menuitemradio"
                        aria-checked={level === candidate}
                        className={`pi-menu-item${level === candidate ? " active" : ""}`}
                        style={{ minHeight: 34, padding: "7px 10px" }}
                        onClick={() => {
                          close();
                          setLevel(candidate);
                        }}
                      >
                        <span style={{ flex: 1 }}>
                          {candidate === "off" ? t("agent.reasoning.off") : candidate}
                        </span>
                        {level === candidate ? <CheckIcon size={14} className="pi-menu-check" aria-hidden /> : null}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SearchGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

const RING_RADIUS = 9;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

/**
 * 上下文占用水位（Token 使用情况）。
 *
 * 环上是「已用 / 预算」的百分比，点开才是明细 —— 这条信息在工具条上需要的是
 * 「还能塞多少」，而不是一串数字。明细里的输入 / 输出 / 缓存 / 思考来自服务端
 * 实测用量（`chatStats`），没有实测值时整块不显示，而不是拿估算值冒充。
 */
export function ContextInspector({ conversationId }: { conversationId: number }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);

  const live = useChatStore((s) => s.contextUsage[conversationId]);
  const stats = useChatStore((s) => s.messageStats);

  const usageQuery = useQuery({
    queryKey: ["agent-context-usage", conversationId],
    queryFn: () => rpcClient.getAgentContextUsage({ conversationId }),
    staleTime: 60_000,
  });

  const usage = live ?? usageQuery.data ?? null;

  // 最近一条有实测用量的消息：输入 / 输出 / 缓存 / 思考只有它给得出。
  const lastStats = useMemo(() => {
    const all = Object.values(stats);
    return all.length > 0 ? all[all.length - 1] : null;
  }, [stats]);

  if (!usage) return null;

  const level = usage.percent >= 90 ? "critical" : usage.percent >= 70 ? "warning" : "comfortable";
  const usedRatio = Math.min(1, usage.percent / 100);
  const remaining = usage.remainingTokens;

  const throughput =
    lastStats && lastStats.outputTokens != null && lastStats.generationMs
      ? Math.round((lastStats.outputTokens / lastStats.generationMs) * 1000)
      : null;
  const cacheRate =
    lastStats?.inputTokens && lastStats.cachedTokens != null && lastStats.inputTokens > 0
      ? Math.round((lastStats.cachedTokens / lastStats.inputTokens) * 100)
      : null;
  const hasProviderUsage = Boolean(
    lastStats && (lastStats.inputTokens != null || lastStats.outputTokens != null),
  );

  return (
    <div ref={ref} className="ctx" data-level={level} data-open={open ? "true" : "false"}>
      <button
        type="button"
        className="ctx-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("agent.context.title")}
        onClick={() => setOpen((v) => !v)}
      >
        <svg className="ctx-ring" viewBox="0 0 24 24" aria-hidden>
          <circle className="ctx-ring-track" cx="12" cy="12" r={RING_RADIUS} />
          <circle
            className="ctx-ring-progress"
            cx="12"
            cy="12"
            r={RING_RADIUS}
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={RING_CIRCUMFERENCE * (1 - usedRatio)}
          />
        </svg>
        <span className="ctx-ring-value">{usage.percent}%</span>
      </button>

      {open ? (
        <div className="ctx-pop" role="dialog" aria-label={t("agent.context.title")}>
          <div className="ctx-row">
            <strong className="ctx-big">
              {t("agent.context.left", { count: formatTokens(remaining) })}
            </strong>
            <strong className="ctx-big-pct">{usage.percent}%</strong>
          </div>

          <div className="ctx-section ctx-row">
            <span className="ctx-label">{t("agent.context.window")}</span>
            <strong className="ctx-value">
              {formatTokens(usage.usedTokens)} / {formatTokens(usage.windowTokens)}
            </strong>
            <span className="ctx-weak">{usage.source === "usage" ? "" : t("agent.context.estimate")}</span>
          </div>

          <div className="ctx-section">
            <div className="ctx-kpi">
              <span className="ctx-label">{t("agent.context.budget")}</span>
              <strong className="ctx-value">{formatTokens(usage.budgetTokens)}</strong>
            </div>
            <div className="ctx-kpi">
              <span className="ctx-label">{t("agent.context.used")}</span>
              <strong className="ctx-value">{formatTokens(usage.usedTokens)}</strong>
            </div>
            {throughput != null ? (
              <div className="ctx-kpi">
                <span className="ctx-label">{t("agent.context.throughput")}</span>
                <strong className="ctx-value">{throughput} tok/s</strong>
              </div>
            ) : null}
          </div>

          {hasProviderUsage || lastStats?.toolCalls != null ? (
            <div className="ctx-section">
              <div className="ctx-summary-row">
                <strong className="ctx-label">{t("agent.context.provider")}</strong>
                <span className="ctx-values">
                  {lastStats?.inputTokens != null ? (
                    <span className="ctx-value">
                      {t("agent.context.input")} {formatTokens(lastStats.inputTokens)}
                    </span>
                  ) : null}
                  {lastStats?.outputTokens != null ? (
                    <span className="ctx-value">
                      {t("agent.context.output")} {formatTokens(lastStats.outputTokens)}
                    </span>
                  ) : null}
                  {lastStats?.cachedTokens != null ? (
                    <span className="ctx-value">
                      {t("agent.context.cacheRead")} {formatTokens(lastStats.cachedTokens)}
                    </span>
                  ) : null}
                  {cacheRate != null ? (
                    <span className="ctx-value">
                      {t("agent.context.cacheRate")} {cacheRate}%
                    </span>
                  ) : null}
                  {lastStats?.reasoningTokens != null ? (
                    <span className="ctx-value">
                      {t("agent.context.reasoning")} {formatTokens(lastStats.reasoningTokens)}
                    </span>
                  ) : null}
                </span>
              </div>
              <div className="ctx-summary-row">
                <strong className="ctx-label">{t("agent.context.tools")}</strong>
                <span className="ctx-values">
                  {lastStats?.toolCalls
                    ? t("agent.context.toolsSummary", {
                        calls: String(lastStats.toolCalls),
                        steps: String(lastStats.steps ?? 0),
                      })
                    : t("agent.context.noTools")}
                </span>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
